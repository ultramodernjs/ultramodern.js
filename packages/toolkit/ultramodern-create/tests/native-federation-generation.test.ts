import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { loadUltramodernConfigFile } from '@modern-js/ultramodern-app-tools';
import { transformSync } from 'esbuild';
import { WORKSPACE_PACKAGE_VERSION } from '../src/ultramodern-package-source';
import {
  addUltramodernVertical,
  generateUltramodernWorkspace,
} from '../src/ultramodern-workspace';
import { rewriteShellAppFiles } from '../src/ultramodern-workspace/add-vertical/shell-files';
import {
  createVerticalDescriptor,
  shellApp,
} from '../src/ultramodern-workspace/descriptors';
import { initializeGeneratedRendererIdentity } from '../src/ultramodern-workspace/renderer-initial-identity';
import { getRendererGenerationProfile } from '../src/ultramodern-workspace/renderer-profile';
import {
  EFFECT_VERSION,
  MODULE_FEDERATION_NODE_VERSION,
  MODULE_FEDERATION_RUNTIME_FORK_VERSION,
  MODULE_FEDERATION_VERSION,
  ULTRAMODERN_PACKAGE_PINS,
} from '../src/ultramodern-workspace/versions';
import { writeApp } from '../src/ultramodern-workspace/write-app';
import {
  linkInstalledCompilerPolicy,
  snapshotWorkspace,
} from './helpers/workspace-kit';

const packageSource = {
  strategy: 'workspace',
  modernPackageVersion: '3.8.3',
} as const;
const scope = 'native-mf-workspace';

// Preset-capable app configs execute through the actual loader and generated
// topology. Backend-only config units retain their isolated dependency fixture.
async function createOctaneConfigWorkspace(
  root: string,
  apiProtocol?: 'rest' | 'rpc',
) {
  await generateUltramodernWorkspace({
    targetDir: root,
    packageName: scope,
    modernVersion: packageSource.modernPackageVersion,
    renderer: 'octane',
    enableTailwind: false,
    generateAgentFiles: false,
    packageSource: { strategy: 'workspace' },
  });
  linkInstalledCompilerPolicy(root);
  const result = await addUltramodernVertical({
    workspaceRoot: root,
    name: 'catalog',
    modernVersion: packageSource.modernPackageVersion,
    renderer: 'octane',
    preset: apiProtocol ? 'full-stack' : 'ui-only',
    apiProtocol,
    enableTailwind: false,
  });
  for (const name of [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/app-tools-extensions',
    '@modern-js/plugin-bff-build-extensions',
  ]) {
    const destination = path.join(root, 'node_modules', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(
      fs.realpathSync(path.resolve(__dirname, '../node_modules', name)),
      destination,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  return result.createdApps[0]!;
}

async function loadAppConfig(
  appDirectory: string,
  env: Record<string, string>,
) {
  const names = new Set([
    ...Object.keys(env),
    'NODE_ENV',
    'MODERNJS_DEPLOY',
    'ULTRAMODERN_PUBLIC_URL_CATALOG',
    'VERTICAL_CATALOG_MF_MANIFEST',
    'ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN',
    'MODERN_ASSET_PREFIX',
    'ULTRAMODERN_ASSET_PREFIX',
  ]);
  const previous = new Map([...names].map(name => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    return (
      await loadUltramodernConfigFile({
        appDirectory,
        env: 'production',
        command: 'build',
      })
    ).config;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Execute config with real address policy and declared consumer package versions. */
function evaluateConfig(
  source: string,
  env: Record<string, string>,
  manifest?: unknown,
) {
  const require = createRequire(__filename);
  const config = require('@modern-js/app-tools-extensions/config');
  const names = new Set([
    ...Object.keys(env),
    'NODE_ENV',
    'MODERNJS_DEPLOY',
    'VERTICAL_CATALOG_MF_MANIFEST',
    'ULTRAMODERN_PUBLIC_URL_CATALOG',
  ]);
  const previous = new Map([...names].map(name => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    const module = { exports: {} };
    vm.runInNewContext(
      transformSync(source, { format: 'cjs', loader: 'ts' }).code,
      {
        module,
        exports: module.exports,
        URL,
        require(specifier: string) {
          if (specifier === 'node:module')
            return {
              createRequire: () => (name: string) => {
                const versions = {
                  '@modern-js/plugin-bff/package.json':
                    packageSource.modernPackageVersion,
                  'effect/package.json': EFFECT_VERSION,
                  '@module-federation/runtime/package.json':
                    MODULE_FEDERATION_RUNTIME_FORK_VERSION,
                };
                assert.ok(Object.hasOwn(versions, name));
                return { version: versions[name as keyof typeof versions] };
              },
            };
          if (specifier === './package.json') return manifest;
          if (specifier === '@modern-js/plugin-bff-build-extensions')
            return { bffPlugin: () => ({ name: 'native-bff' }) };
          if (specifier === '@modern-js/ultramodern-app-tools')
            return { defineConfig: (input: unknown) => input };
          assert.equal(specifier, '@modern-js/app-tools-extensions/config');
          return config;
        },
      },
    );
    return JSON.parse(JSON.stringify(module.exports)).default;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

for (const renderer of ['solid', 'octane'] as const) {
  const createRemote = (name: string, port: number) =>
    initializeGeneratedRendererIdentity(
      scope,
      createVerticalDescriptor(name, port, { renderer, preset: 'ui-only' }),
    );

  test(`${renderer} writes executable native MF host and remote contracts`, () => {
    const temporary = fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        `um-native-mf-${renderer}-`,
      ),
    );
    try {
      const catalog = createRemote('catalog', 4101);
      const unreferenced = createRemote('orders', 4102);
      const shell = initializeGeneratedRendererIdentity(scope, {
        ...shellApp,
        renderer,
        verticalRefs: [catalog.id],
      });
      writeApp(temporary, scope, catalog, packageSource, false);
      writeApp(temporary, scope, shell, packageSource, false, [
        catalog,
        unreferenced,
      ]);
      const files = snapshotWorkspace(temporary);
      const hostConfig = evaluateConfig(
        files[`${shell.directory}/module-federation.config.ts`]!,
        { NODE_ENV: 'development' },
      );
      const remoteConfig = evaluateConfig(
        files[`${catalog.directory}/module-federation.config.ts`]!,
        { NODE_ENV: 'development' },
      );
      assert.deepEqual(hostConfig.remotes, {
        catalog: 'verticalCatalog@http://localhost:4101/mf-manifest.json',
      });
      assert.deepEqual(hostConfig.exposes, {});
      assert.deepEqual(remoteConfig.exposes, catalog.exposes);
      const manifest = JSON.parse(files[`${shell.directory}/package.json`]!);
      assert.equal(
        manifest.dependencies['@module-federation/enhanced'],
        MODULE_FEDERATION_VERSION,
      );
      assert.equal(
        manifest.dependencies['@module-federation/node'],
        MODULE_FEDERATION_NODE_VERSION,
      );
      assert.equal(
        manifest.dependencies['@module-federation/runtime'],
        ULTRAMODERN_PACKAGE_PINS.appDependencies['@module-federation/runtime'],
      );
      assert.equal(
        manifest.dependencies['@modern-js/federation-runtime'],
        'workspace:*',
      );
      assert.equal(manifest.dependencies[`@${scope}/catalog`], 'workspace:*');
      assert.equal(manifest.dependencies[`@${scope}/orders`], undefined);
      for (const source of Object.values(catalog.exposes!))
        assert.ok(files[`${catalog.directory}/${source.slice(2)}`], source);
      assert.ok(
        files[`${shell.directory}/src/routes/remotes/catalog/page.tsx`],
      );
      assert.equal(
        files[`${shell.directory}/src/routes/remotes/orders/page.tsx`],
        undefined,
      );
      for (const [filename, source] of Object.entries(files)) {
        if (!filename.endsWith('.tsx')) continue;
        const imports = parse(source, {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
        })
          .program.body.filter(node => node.type === 'ImportDeclaration')
          .map(node => node.source.value);
        for (const specifier of imports)
          assert.doesNotMatch(
            specifier,
            /^(?:react(?:-dom)?(?:\/|$)|@module-federation\/(?:modern-js-v3|bridge-react))/u,
          );
      }
      assert.equal(
        getRendererGenerationProfile(renderer).capabilities.federation,
        true,
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  for (const apiProtocol of ['rest', 'rpc'] as const) {
    test(`${renderer} full-stack ${apiProtocol} vertical emits its advertised API and backend contracts`, async () => {
      const temporary = fs.mkdtempSync(
        path.join(
          process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
          `um-native-mf-api-${renderer}-`,
        ),
      );
      try {
        const remote = initializeGeneratedRendererIdentity(
          scope,
          createVerticalDescriptor('catalog', 4101, { renderer, apiProtocol }),
        );
        const shell = initializeGeneratedRendererIdentity(scope, {
          ...shellApp,
          renderer,
          verticalRefs: [remote.id],
        });
        const workspaceRoot = path.join(temporary, 'workspace');
        if (renderer === 'octane') {
          await createOctaneConfigWorkspace(workspaceRoot, apiProtocol);
        } else {
          writeApp(workspaceRoot, scope, remote, packageSource, false);
          writeApp(workspaceRoot, scope, shell, packageSource, false, [remote]);
        }
        const files = snapshotWorkspace(workspaceRoot);
        const manifest = JSON.parse(files[`${remote.directory}/package.json`]!);
        const shellManifest = JSON.parse(
          files[`${shell.directory}/package.json`]!,
        );
        // The Shell imports owner clients directly and republishes none.
        assert.equal(shellManifest.exports?.['./api/clients'], undefined);
        for (const target of Object.values(manifest.exports).concat(
          Object.values(shellManifest.exports ?? {}),
        )) {
          if (
            typeof target !== 'string' ||
            !target.startsWith('./') ||
            !/api|rpc/u.test(target)
          )
            continue;
          const directory = Object.values(manifest.exports).includes(target)
            ? remote.directory
            : shell.directory;
          assert.ok(
            files[`${directory}/${target.slice(2)}`],
            `Missing advertised ${target}`,
          );
        }
        for (const relative of [
          'api/index.ts',
          'api/backend-federation.ts',
          'api/effect-api.ts',
        ])
          assert.ok(files[`${remote.directory}/${relative}`]);
        const modern =
          renderer === 'octane'
            ? await loadAppConfig(path.join(workspaceRoot, remote.directory), {
                NODE_ENV: 'development',
                MODERNJS_DEPLOY: 'node',
              })
            : evaluateConfig(files[`${remote.directory}/modern.config.ts`]!, {
                NODE_ENV: 'development',
              });
        assert.equal(modern.server.bff.effect.entry, './api/index');
        assert.equal(modern.server.bff.effect.strictEffectApproach, true);
        assert.equal(modern.server.bff.runtimeFramework, 'effect');
        assert.equal(modern.server.bff.prefix, '/catalog-api');
        const backend = evaluateConfig(
          files[`${remote.directory}/backend-federation.config.ts`]!,
          { NODE_ENV: 'development' },
          manifest,
        );
        assert.equal(backend.name, 'verticalCatalogBackend');
        assert.deepEqual(backend.exposes, {
          './effect-api': './api/effect-api.ts',
        });
        assert.equal(backend.library.type, 'commonjs-module');
        assert.equal(
          backend.shared['@module-federation/runtime'].requiredVersion,
          MODULE_FEDERATION_RUNTIME_FORK_VERSION,
        );
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    });
  }

  test(`${renderer} remote assets use ${renderer === 'octane' ? 'the generated deployment preset' : 'the authenticated discovery address'}`, async () => {
    const temporary = fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        `um-native-mf-assets-${renderer}-`,
      ),
    );
    try {
      if (renderer === 'octane') {
        const workspaceRoot = path.join(temporary, 'workspace');
        const catalog = await createOctaneConfigWorkspace(workspaceRoot);
        const appDirectory = path.join(workspaceRoot, catalog.directory);
        const node = await loadAppConfig(appDirectory, {
          NODE_ENV: 'development',
          MODERNJS_DEPLOY: 'node',
        });
        assert.equal(
          node.output?.assetPrefix,
          `http://localhost:${catalog.port}/`,
        );
        assert.equal(node.deploy?.worker, undefined);
        const cloudflare = await loadAppConfig(appDirectory, {
          NODE_ENV: 'production',
          MODERNJS_DEPLOY: 'cloudflare',
          ULTRAMODERN_PUBLIC_URL_CATALOG: 'https://remote.example/assets',
        });
        assert.equal(
          cloudflare.output?.assetPrefix,
          'https://remote.example/assets/',
        );
        assert.equal(cloudflare.output?.distPath?.root, 'dist-cloudflare');
        assert.equal(cloudflare.deploy?.worker?.ssr, true);
        const workersDev = await loadAppConfig(appDirectory, {
          NODE_ENV: 'production',
          MODERNJS_DEPLOY: 'cloudflare',
          ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN: 'native-account',
        });
        assert.equal(
          workersDev.output?.assetPrefix,
          `https://${cloudflare.deploy?.worker?.name}.native-account.workers.dev/`,
        );
        for (const target of ['node', 'cloudflare']) {
          const manifestOnly = await loadAppConfig(appDirectory, {
            NODE_ENV: 'production',
            MODERNJS_DEPLOY: target,
            VERTICAL_CATALOG_MF_MANIFEST:
              'verticalCatalog@https://cdn.example/releases/mf-manifest.json',
          });
          assert.equal(
            manifestOnly.output?.assetPrefix,
            'https://cdn.example/releases/',
          );
          await assert.rejects(
            () =>
              loadAppConfig(appDirectory, {
                NODE_ENV: 'production',
                MODERNJS_DEPLOY: target,
              }),
            /localhost fallback is disabled/u,
          );
        }
        return;
      }
      const catalog = createRemote('catalog', 4101);
      writeApp(temporary, scope, catalog, packageSource, false);
      const source = fs.readFileSync(
        path.join(temporary, catalog.directory, 'modern.config.ts'),
        'utf8',
      );
      assert.equal(
        evaluateConfig(source, { NODE_ENV: 'development' }).output.assetPrefix,
        'http://localhost:4101/',
      );
      assert.equal(
        evaluateConfig(source, {
          NODE_ENV: 'production',
          ULTRAMODERN_PUBLIC_URL_CATALOG: 'https://remote.example/assets',
        }).output.assetPrefix,
        'https://remote.example/assets/',
      );
      assert.equal(
        evaluateConfig(source, {
          NODE_ENV: 'production',
          VERTICAL_CATALOG_MF_MANIFEST:
            'verticalCatalog@https://cdn.example/releases/mf-manifest.json',
        }).output.assetPrefix,
        'https://cdn.example/releases/',
      );
      assert.throws(
        () => evaluateConfig(source, { NODE_ENV: 'production' }),
        /localhost fallback is disabled/u,
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test(`${renderer} add-vertical refreshes native composition and preserves authored pages`, () => {
    const temporary = fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        `um-native-mf-add-${renderer}-`,
      ),
    );
    try {
      const catalog = createRemote('catalog', 4101);
      const orders = createRemote('orders', 4102);
      const before = initializeGeneratedRendererIdentity(scope, {
        ...shellApp,
        renderer,
        verticalRefs: [catalog.id],
      });
      const next = { ...before, verticalRefs: [catalog.id, orders.id] };
      writeApp(temporary, scope, before, packageSource, false, [catalog]);
      const page = path.join(
        temporary,
        before.directory,
        'src/routes/remotes/page.tsx',
      );
      const authored =
        'export default function ConsumerPage() { return <main>My federation page</main>; }\n';
      fs.writeFileSync(page, authored);
      const futureRoute = path.join(
        temporary,
        before.directory,
        'src/routes/remotes/orders/page.tsx',
      );
      fs.mkdirSync(path.dirname(futureRoute), { recursive: true });
      fs.writeFileSync(futureRoute, authored);
      rewriteShellAppFiles(
        temporary,
        scope,
        packageSource,
        false,
        [catalog, orders],
        undefined,
        next,
        { shell: before, remotes: [catalog] },
      );
      assert.equal(fs.readFileSync(page, 'utf8'), authored);
      assert.equal(fs.readFileSync(futureRoute, 'utf8'), authored);
      const config = evaluateConfig(
        fs.readFileSync(
          path.join(temporary, before.directory, 'module-federation.config.ts'),
          'utf8',
        ),
        { NODE_ENV: 'development' },
      );
      assert.deepEqual(Object.keys(config.remotes), ['catalog', 'orders']);
      assert.ok(
        fs.existsSync(
          path.join(
            temporary,
            before.directory,
            'src/routes/remotes/orders/page.tsx',
          ),
        ),
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test('native MF configuration admits digit-leading vertical aliases as data', () => {
  const temporary = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'um-native-mf-alias-'),
  );
  try {
    const remote = createVerticalDescriptor('123-catalog', 4101, {
      renderer: 'octane',
      preset: 'ui-only',
    });
    const shell = {
      ...shellApp,
      renderer: 'octane' as const,
      verticalRefs: [remote.id],
    };
    writeApp(temporary, scope, shell, packageSource, false, [remote]);
    const config = evaluateConfig(
      fs.readFileSync(
        path.join(temporary, shell.directory, 'module-federation.config.ts'),
        'utf8',
      ),
      { NODE_ENV: 'development' },
    );
    assert.deepEqual(config.remotes, {
      '123Catalog': 'vertical123Catalog@http://localhost:4101/mf-manifest.json',
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('native MF rejects foreign-renderer composition before writing output', () => {
  const temporary = fs.mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'um-native-mf-reject-',
    ),
  );
  try {
    const remote = createVerticalDescriptor('catalog', 4101, {
      renderer: 'solid',
      preset: 'ui-only',
    });
    const shell = {
      ...shellApp,
      renderer: 'octane' as const,
      verticalRefs: [remote.id],
    };
    assert.throws(
      () => writeApp(temporary, scope, shell, packageSource, false, [remote]),
      /cannot compose the solid renderer/u,
    );
    assert.deepEqual(fs.readdirSync(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('native shells depend on headless API units without declaring a UI remote', () => {
  const temporary = fs.mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'um-native-mf-headless-',
    ),
  );
  try {
    const remote = createVerticalDescriptor('catalog', 4101, {
      preset: 'api-only',
    });
    const shell = { ...shellApp, renderer: 'octane' as const };
    writeApp(temporary, scope, remote, packageSource, false);
    writeApp(temporary, scope, shell, packageSource, false, [remote]);
    const files = snapshotWorkspace(temporary);
    const manifest = JSON.parse(files[`${remote.directory}/package.json`]!);
    const backend = evaluateConfig(
      files[`${remote.directory}/backend-federation.config.ts`]!,
      { NODE_ENV: 'development' },
      manifest,
    );
    assert.equal(backend.name, 'verticalCatalogBackend');
    assert.equal(
      backend.shared['@module-federation/runtime'].requiredVersion,
      MODULE_FEDERATION_RUNTIME_FORK_VERSION,
    );
    assert.equal(
      manifest.dependencies['@module-federation/runtime'],
      ULTRAMODERN_PACKAGE_PINS.appDependencies['@module-federation/runtime'],
    );
    assert.equal(
      manifest.dependencies['@module-federation/enhanced'],
      undefined,
    );
    assert.equal(manifest.dependencies['@module-federation/node'], undefined);
    assert.equal(
      manifest.dependencies['@module-federation/modern-js-v3'],
      undefined,
    );
    // A Shell may import each owner's client directly, but never republishes
    // them through a client registry.
    const shellManifest = JSON.parse(files[`${shell.directory}/package.json`]!);
    assert.equal(
      shellManifest.dependencies[manifest.name],
      WORKSPACE_PACKAGE_VERSION,
    );
    assert.equal(shellManifest.exports?.['./api/clients'], undefined);
    assert.equal(
      files[`${shell.directory}/src/api/vertical-clients.ts`],
      undefined,
    );
    const config = evaluateConfig(
      fs.readFileSync(
        path.join(temporary, shell.directory, 'module-federation.config.ts'),
        'utf8',
      ),
      { NODE_ENV: 'development' },
    );
    assert.equal(config.remotes, undefined);
    const rejected = path.join(temporary, 'rejected');
    assert.throws(
      () =>
        writeApp(
          rejected,
          scope,
          { ...shell, verticalRefs: [remote.id] },
          packageSource,
          false,
          [remote],
        ),
      /Headless unit catalog cannot join native UI federation/u,
    );
    assert.equal(fs.existsSync(rejected), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
