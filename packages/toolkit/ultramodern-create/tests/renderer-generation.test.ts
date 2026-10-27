import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  validateRendererRouterBindings,
  validateUltramodernBuildArtifact,
} from '@modern-js/backend-federation-contracts';
import { loadUltramodernConfigFile } from '@modern-js/ultramodern-app-tools';
import { localizedNavigationSharedCheckCommand } from '../../../../scripts/ultramodern-renderers/native-localized-navigation.mjs';
import {
  addUltramodernVertical,
  generateUltramodernWorkspace,
} from '../src/ultramodern-workspace';
import { createBuildMarker } from '../src/ultramodern-workspace/delivery-unit';
import {
  createVerticalDescriptor,
  shellApp,
} from '../src/ultramodern-workspace/descriptors';
import { initializeGeneratedRendererIdentity } from '../src/ultramodern-workspace/renderer-initial-identity';
import { getRendererGenerationProfile } from '../src/ultramodern-workspace/renderer-profile';
import type {
  ApplicationRenderer,
  UltramodernWorkspaceOptions,
} from '../src/ultramodern-workspace/types';
import {
  linkInstalledCompilerPolicy,
  snapshotWorkspace,
} from './helpers/workspace-kit';

const renderers: ApplicationRenderer[] = ['react', 'solid', 'octane'];
const appDirectory = 'apps/shell-super-app';
const unsupportedNativeArtifact =
  /(?:worker|workerd|cloudflare|mf-types|i18n|locales)/iu;
const unsupportedNativeSource =
  /(?:['"](?:react(?:-dom)?(?:\/[^'"]*)?|@types\/react(?:-dom)?|@tanstack\/react-router|@modern-js\/(?:runtime(?:\/[^'"]*)?|runtime-renderer-extensions|runtime-extensions\/build-identity|plugin-(?:i18n|tanstack)(?:\/[^'"]*)?)|@module-federation\/(?:modern-js-v3|bridge-react))['"]|moduleFederationPlugin|i18nPlugin|MODERNJS_DEPLOY|reactI18next)/u;

for (const renderer of renderers) {
  test(`fresh ${renderer} generation projects its selected native profile`, async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `um-renderer-generation-${renderer}-`),
    );
    const targetDir = path.join(tempRoot, 'renderer-workspace');
    try {
      const result = await generateUltramodernWorkspace({
        targetDir,
        packageName: 'renderer-workspace',
        modernVersion: '3.8.3',
        renderer,
        enableTailwind: false,
        generateAgentFiles: false,
        packageSource: { strategy: 'workspace' },
      });
      const files = snapshotWorkspace(targetDir);
      const manifest = JSON.parse(files[`${appDirectory}/package.json`]!);
      const rootManifest = JSON.parse(files['package.json']!);
      if (renderer !== 'react') {
        const [filter, packages, operation, script] =
          localizedNavigationSharedCheckCommand;
        assert.equal(filter, '--filter');
        assert.equal(packages, './packages/*');
        assert.equal(operation, 'run');
        assert.match(
          rootManifest.scripts.typecheck,
          /^pnpm -r --filter "\.\/packages\/\*" run typecheck && /u,
        );
        for (const name of ['shared-contracts', 'shared-design-tokens']) {
          const shared = JSON.parse(files[`packages/${name}/package.json`]!);
          assert.equal(shared.exports['.'], './src/index.ts');
          assert.equal(shared.scripts.build, undefined);
          assert.equal(typeof shared.scripts[script], 'string');
          assert.match(
            shared.scripts[script],
            / typecheck --project tsconfig\.json$/u,
          );
        }
      }
      const baseTsconfig = JSON.parse(files['tsconfig.base.json']!);
      assert.deepEqual(baseTsconfig, {
        extends: '@modern-js/ultramodern-create/tsconfig',
      });
      linkInstalledCompilerPolicy(targetDir);
      const inheritedTsconfig = JSON.parse(
        fs.readFileSync(
          createRequire(path.join(targetDir, 'package.json')).resolve(
            baseTsconfig.extends,
          ),
          'utf8',
        ),
      );
      const tsconfig = JSON.parse(files[`${appDirectory}/tsconfig.json`]!);
      const topology = JSON.parse(files['topology/reference-topology.json']!);
      const profile = getRendererGenerationProfile(renderer);
      const app = result.createdApps[0]!;
      const entryName = renderer === 'react' ? 'index' : 'main';
      const config = files[`${appDirectory}/modern.config.ts`]!;

      assert.equal(result.createdApps.length, 1);
      assert.equal(app.directory, appDirectory);
      assert.equal(app.renderer, renderer);
      assert.equal(app.rendererIdentity?.renderer, renderer);
      assert.equal(app.rendererIdentity?.appId, app.id);
      assert.equal(app.rendererIdentity?.entryName, entryName);
      assert.equal(app.rendererIdentity?.protocolVersion, 1);
      assert.ok(app.rendererIdentity?.buildId);
      assert.deepEqual(app.rendererIdentities, {
        [entryName]: app.rendererIdentity,
      });
      assert.deepEqual(app.rendererProfile, profile.profile);
      assert.equal(topology.shell.renderer, renderer);
      assert.equal(topology.shell.surfaceProfile, 'ui-only');
      assert.equal(app.apiPrefix, undefined);
      assert.ok(
        !Object.keys(files).some(relativePath =>
          relativePath.startsWith(`${appDirectory}/api/`),
        ),
      );
      assert.deepEqual(topology.shell.rendererIdentity, app.rendererIdentity);
      assert.deepEqual(
        topology.shell.rendererIdentities,
        app.rendererIdentities,
      );
      assert.deepEqual(topology.shell.rendererProfile, profile.profile);
      assert.deepEqual(
        topology.shell.rendererCapabilities,
        profile.capabilities,
      );
      assert.deepEqual(topology.verticals, []);
      assert.equal(tsconfig.compilerOptions.jsx, 'preserve');
      assert.equal(
        tsconfig.compilerOptions.jsxImportSource,
        profile.jsxImportSource,
      );
      assert.deepEqual(
        tsconfig.compilerOptions.types ??
          inheritedTsconfig.compilerOptions.types,
        renderer === 'react' ? ['node'] : [],
      );
      assert.match(config, /from ['"]@modern-js\/ultramodern-app-tools['"]/u);
      assert.match(config, new RegExp(`renderer:\\s*['"]${renderer}['"]`, 'u'));
      assert.equal(config.match(/\bdefineConfig\s*\(/gu)?.length, 1);
      assert.doesNotMatch(config, /\bultramodernAppTools\b/u);

      for (const [name, version] of Object.entries(profile.dependencies)) {
        assert.equal(
          manifest.dependencies[name],
          version,
          `${renderer}: ${name}`,
        );
      }
      for (const [name, version] of Object.entries(profile.devDependencies)) {
        assert.equal(
          manifest.devDependencies[name],
          version,
          `${renderer}: ${name}`,
        );
      }

      if (renderer === 'react') {
        assert.equal(
          files[`${appDirectory}/src/modern-app-env.d.ts`],
          `/// <reference types="@modern-js/ultramodern-app-tools/react-types" />

declare const ULTRAMODERN_SITE_URL: string;
`,
        );
        assert.equal(manifest.dependencies.react, profile.dependencies.react);
        assert.equal(
          manifest.dependencies['react-dom'],
          profile.dependencies['react-dom'],
        );
        assert.equal(
          manifest.dependencies['@tanstack/react-router'],
          profile.dependencies['@tanstack/react-router'],
        );
        assert.ok(files[`${appDirectory}/module-federation.config.ts`]);
        assert.ok(files[`${appDirectory}/src/modern.runtime.ts`]);
        assert.ok(files[`${appDirectory}/src/routes/[lang]/page.tsx`]);
        assert.ok(app.moduleFederationName);
        assert.equal(topology.shell.moduleFederation.role, 'host');
        assert.equal(topology.shell.moduleFederation.ssr, true);
        assert.equal(profile.capabilities.workers, true);
        assert.equal(profile.capabilities.federation, true);
        assert.ok(rootManifest.scripts['cloudflare:build']);
        return;
      }

      assert.equal(
        files[`${appDirectory}/src/modern-app-env.d.ts`],
        `/// <reference types="@modern-js/ultramodern-app-tools/types" />
/// <reference types="${renderer === 'solid' ? '@solidjs/web' : 'octane'}" />
`,
      );
      assert.deepEqual(profile.capabilities, {
        ssr: true,
        streaming: true,
        workers: renderer === 'octane',
        federation: true,
        rsc: false,
      });
      assert.match(config, /server:\s*\{\s*port:\s*\d+,\s*ssr:\s*true\s*\}/u);
      assert.doesNotMatch(config, /output:\s*\{\s*ssr:/u);
      assert.equal(
        app.moduleFederationName,
        topology.shell.moduleFederation.name,
      );
      assert.equal(app.moduleFederationName, shellApp.mfName);
      assert.equal(Object.hasOwn(app, 'exposes'), false);
      assert.equal(topology.shell.moduleFederation.role, 'host');
      assert.equal(topology.shell.moduleFederation.ssr, true);
      assert.ok(files[`${appDirectory}/module-federation.config.ts`]);
      assert.ok(files[`${appDirectory}/src/routes/remotes/page.tsx`]);
      if (renderer === 'octane') {
        assert.equal(topology.shell.cloudflare.target, 'cloudflare');
        assert.equal(typeof topology.shell.cloudflare.workerName, 'string');
        assert.ok(topology.shell.cloudflare.workerName.length > 0);
        assert.equal(topology.shell.cloudflare.assetsBinding, 'ASSETS');
        assert.ok(
          topology.shell.cloudflare.compatibilityFlags.includes(
            'enable_request_signal',
          ),
        );
        assert.equal(topology.shell.rendererCapabilities.workers, true);
      } else {
        assert.equal(Object.hasOwn(topology.shell, 'cloudflare'), false);
        for (const generatedManifest of [manifest, rootManifest]) {
          assert.equal(generatedManifest.devDependencies.wrangler, undefined);
          for (const command of [
            'cloudflare:build',
            'cloudflare:deploy',
            'cloudflare:preview',
          ]) {
            assert.equal(generatedManifest.scripts[command], undefined);
          }
        }
        assert.doesNotMatch(config, /presetUltramodernWorkspace/u);
      }
      assert.equal(Object.hasOwn(manifest, 'zephyr:dependencies'), false);
      assert.equal(
        manifest.dependencies[`@modern-js/renderer-${renderer}`],
        'workspace:*',
      );
      assert.equal(
        manifest.dependencies['@modern-js/renderer-core'],
        'workspace:*',
      );
      assert.equal(
        manifest.dependencies[profile.profile.router.name],
        profile.profile.router.name.startsWith('@modern-js/')
          ? 'workspace:*'
          : profile.dependencies[profile.profile.router.name],
      );
      assert.equal(
        manifest.dependencies['@tanstack/router-core'],
        profile.dependencies['@tanstack/router-core'],
      );

      for (const [relativePath, source] of Object.entries(files)) {
        if (/^(?:apps|packages|scripts|topology)\//u.test(relativePath)) {
          assert.doesNotMatch(
            relativePath,
            unsupportedNativeArtifact,
            relativePath,
          );
        }
        if (
          /^(?:apps|packages)\//u.test(relativePath) &&
          /\.(?:[cm]?tsx?|[cm]?jsx?)$/u.test(relativePath)
        ) {
          assert.doesNotMatch(source, unsupportedNativeSource, relativePath);
          assert.doesNotMatch(
            source,
            renderer === 'solid'
              ? /['"](?:octane(?:\/[^'"]*)?|@octanejs\/[^'"]*|@modern-js\/renderer-octane(?:\/[^'"]*)?)['"]/u
              : /['"](?:solid-js(?:\/[^'"]*)?|@solidjs\/[^'"]*|@tanstack\/solid-router|@modern-js\/renderer-solid(?:\/[^'"]*)?)['"]/u,
            relativePath,
          );
        }
        if (
          relativePath.endsWith('/package.json') ||
          relativePath === 'package.json'
        ) {
          const packageManifest = JSON.parse(source);
          if (renderer === 'solid')
            assert.equal(packageManifest.devDependencies?.wrangler, undefined);
          for (const name of [
            ...Object.keys(packageManifest.dependencies ?? {}),
            ...Object.keys(packageManifest.devDependencies ?? {}),
          ]) {
            assert.doesNotMatch(
              name,
              /^(?:react(?:-dom)?|@types\/react(?:-dom)?|@tanstack\/react-router|@module-federation\/(?!(?:enhanced|node|runtime)$)|@modern-js\/(?:runtime$|runtime-renderer-extensions$|plugin-(?:i18n|tanstack)$)|miniflare$|zephyr)/u,
              `${relativePath}: ${name}`,
            );
            assert.doesNotMatch(
              name,
              renderer === 'solid'
                ? /^(?:octane|@octanejs\/|@modern-js\/renderer-octane$)/u
                : /^(?:solid-js$|@solidjs\/|@tanstack\/solid-router$|@modern-js\/renderer-solid$)/u,
              `${relativePath}: ${name}`,
            );
          }
          assert.doesNotMatch(
            JSON.stringify(packageManifest.scripts ?? {}),
            renderer === 'octane'
              ? /(?:mf-types|i18n|locales)/iu
              : unsupportedNativeArtifact,
            `${relativePath}: scripts`,
          );
        }
      }
      assert.ok(files[`${appDirectory}/src/routes/layout.tsx`]);
      assert.ok(files[`${appDirectory}/src/routes/page.tsx`]);
      assert.ok(files[`${appDirectory}/src/routes/page.head.ts`]);
      assert.ok(files[`${appDirectory}/src/routes/about/page.tsx`]);
      assert.ok(files[`${appDirectory}/src/routes/about/page.head.ts`]);
      assert.ok(files[`${appDirectory}/src/routes/page.data.ts`]);
      assert.ok(files[`${appDirectory}/src/routes/error.tsx`]);
      assert.ok(files[`${appDirectory}/src/routes/not-found.tsx`]);
      assert.ok(
        files[
          `${appDirectory}/src/components/${renderer === 'octane' ? 'counter' : 'Counter'}.tsx`
        ],
      );
      assert.ok(
        files[
          `${appDirectory}/src/components/${renderer === 'octane' ? 'stable' : 'Stable'}.tsx`
        ],
      );
      assert.match(
        files[`${appDirectory}/src/routes/page.data.ts`]!,
        /export (?:async )?function loader\(/u,
      );
      const dataSource = stripTypeScriptTypes(
        files[`${appDirectory}/src/routes/page.data.ts`]!,
      );
      const dataModule = await import(
        `data:text/javascript;base64,${Buffer.from(dataSource).toString('base64')}`
      );
      const actionResult = dataModule.action({
        request: new Request('http://localhost/', {
          method: 'POST',
          body: new URLSearchParams({ name: 'Ada' }),
          headers: { 'x-conformance-private': 'private-action' },
        }),
      });
      assert.ok(actionResult instanceof Promise);
      assert.deepEqual(await actionResult, {
        saved: 'Ada',
        privateValue: 'private-action',
      });
      assert.match(
        files[`${appDirectory}/src/routes/layout.tsx`]!,
        renderer === 'solid'
          ? /from ['"]@modern-js\/renderer-solid\/router['"]/u
          : /from ['"]@modern-js\/renderer-octane\/router['"]/u,
      );
      assert.match(
        files[`${appDirectory}/src/routes/about/page.tsx`]!,
        /<Link\s+to=['"]\/['"]/u,
      );
      assert.match(
        files[`${appDirectory}/src/routes/page.head.ts`]!,
        /export const head: NonNullable<FileSystemRouteModule\['head'\]>/u,
      );
      assert.match(
        files[`${appDirectory}/src/routes/about/page.head.ts`]!,
        /export const head: NonNullable<FileSystemRouteModule\['head'\]>/u,
      );
      assert.match(
        files[`${appDirectory}/src/routes/error.tsx`]!,
        /ErrorRouteComponent/u,
      );
      assert.match(
        files[`${appDirectory}/src/routes/not-found.tsx`]!,
        /NotFoundRouteComponent/u,
      );
      assert.doesNotMatch(config, unsupportedNativeSource);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('ordinary Octane generation admits Worker contracts for the shell and added remote', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-octane-worker-generation-'),
  );
  const targetDir = path.join(tempRoot, 'worker-workspace');
  try {
    const shell = await generateUltramodernWorkspace({
      targetDir,
      packageName: 'worker-workspace',
      modernVersion: '3.8.3',
      renderer: 'octane',
      enableTailwind: false,
      generateAgentFiles: false,
      packageSource: { strategy: 'workspace' },
    });
    linkInstalledCompilerPolicy(targetDir);
    const remote = await addUltramodernVertical({
      workspaceRoot: targetDir,
      name: 'catalog',
      renderer: 'octane',
      horizontalRemote: true,
      enableTailwind: false,
      modernVersion: '3.8.3',
    });
    const rootManifest = JSON.parse(
      fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'),
    );
    assert.ok(rootManifest.devDependencies.wrangler);
    assert.ok(rootManifest.scripts['cloudflare:build']);
    assert.ok(rootManifest.scripts['cloudflare:deploy']);
    assert.ok(rootManifest.scripts['cloudflare:preview']);
    for (const command of [
      'cloudflare:build',
      'cloudflare:deploy',
      'cloudflare:preview',
    ]) {
      assert.match(
        rootManifest.scripts[command],
        /--filter @worker-workspace\/shell-super-app/u,
      );
      assert.match(
        rootManifest.scripts[command],
        /--filter @worker-workspace\/catalog/u,
      );
    }
    assert.equal(
      rootManifest.scripts.build,
      'pnpm -r --filter "./apps/*" --filter "./verticals/*" run build',
    );
    for (const name of [
      '@modern-js/ultramodern-app-tools',
      '@modern-js/app-tools-extensions',
    ]) {
      const destination = path.join(targetDir, 'node_modules', name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(
        fs.realpathSync(path.resolve(__dirname, '../node_modules', name)),
        destination,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    assert.deepEqual(shell.warnings, []);
    assert.deepEqual(remote.warnings, []);
    const topology = JSON.parse(
      fs.readFileSync(
        path.join(targetDir, 'topology/reference-topology.json'),
        'utf8',
      ),
    );
    assert.equal(topology.verticals.length, 1);
    const previewPorts = new Set<number>();
    for (const app of [topology.shell, topology.verticals[0]]) {
      const generatedApp = [...shell.createdApps, ...remote.createdApps].find(
        candidate => candidate.id === app.id,
      )!;
      previewPorts.add(generatedApp.port);
      assert.equal(app.renderer, 'octane');
      assert.equal(app.rendererCapabilities.workers, true);
      assert.equal(app.cloudflare.target, 'cloudflare');
      assert.equal(app.cloudflare.assetsBinding, 'ASSETS');
      assert.ok(
        app.cloudflare.compatibilityFlags.includes('enable_request_signal'),
      );
      assert.equal(app.rendererIdentity.renderer, 'octane');
      const directory = path.join(targetDir, app.path);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
      );
      assert.ok(manifest.devDependencies.wrangler);
      assert.equal(manifest.scripts.build, 'ultramodern build');
      assert.equal(
        manifest.scripts['cloudflare:build'],
        'ultramodern build --deploy-target cloudflare && ultramodern deploy --skip-build --deploy-target cloudflare',
      );
      assert.equal(
        manifest.scripts['cloudflare:deploy'],
        'pnpm run cloudflare:build && wrangler deploy --config .output/wrangler.json',
      );
      assert.equal(
        manifest.scripts['cloudflare:preview'],
        `pnpm run cloudflare:build && wrangler dev --port ${generatedApp.port} --config .output/wrangler.json`,
      );
      const environmentNames = [
        'MODERNJS_DEPLOY',
        'NODE_ENV',
        'ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN',
        'MODERN_ASSET_PREFIX',
        'ULTRAMODERN_ASSET_PREFIX',
        ...[topology.shell, ...topology.verticals].map(
          candidate => candidate.cloudflare.publicUrlEnv,
        ),
      ];
      const priorEnvironment = new Map(
        environmentNames.map(name => [name, process.env[name]]),
      );
      try {
        for (const name of environmentNames) delete process.env[name];
        process.env[app.cloudflare.publicUrlEnv] =
          `https://${app.cloudflare.workerName}.example.com`;
        for (const target of ['node', 'cloudflare']) {
          process.env.MODERNJS_DEPLOY = target;
          process.env.NODE_ENV =
            target === 'node' ? 'development' : 'production';
          const loaded = await loadUltramodernConfigFile({
            appDirectory: directory,
            env: 'production',
            command: 'build',
          });
          assert.equal(loaded.config.renderer, 'octane');
          assert.equal(loaded.config.server?.port, generatedApp.port);
          assert.equal(
            loaded.config.output?.distPath?.root,
            target === 'cloudflare' ? 'dist-cloudflare' : 'dist',
          );
          if (target === 'cloudflare') {
            assert.equal(loaded.config.deploy?.target, 'cloudflare');
            assert.equal(
              loaded.config.deploy?.worker?.name,
              app.cloudflare.workerName,
            );
            assert.equal(loaded.config.deploy?.worker?.ssr, true);
            assert.deepEqual(
              loaded.config.deploy?.worker?.security,
              app.cloudflare.security,
            );
            const services = loaded.config.deploy?.worker?.services ?? [];
            assert.equal(services.length, app.kind === 'shell' ? 1 : 0);
            if (app.kind === 'shell')
              assert.equal(
                services[0].service,
                topology.verticals[0].cloudflare.workerName,
              );
          } else assert.equal(loaded.config.deploy?.worker, undefined);
        }
        delete process.env[app.cloudflare.publicUrlEnv];
        process.env.ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN =
          'worker-account';
        for (const target of ['cloudflare', 'node']) {
          process.env.MODERNJS_DEPLOY = target;
          process.env.NODE_ENV =
            target === 'node' ? 'development' : 'production';
          const loaded = await loadUltramodernConfigFile({
            appDirectory: directory,
            env: 'production',
            command: 'build',
          });
          assert.equal(
            loaded.config.output?.assetPrefix,
            app.kind === 'shell'
              ? '/'
              : target === 'cloudflare'
                ? `https://${app.cloudflare.workerName}.worker-account.workers.dev/`
                : `http://localhost:${generatedApp.port}/`,
          );
        }
        process.env.MODERNJS_DEPLOY = 'cloudflare';
        process.env.NODE_ENV = 'production';
        process.env.ULTRAMODERN_ASSET_PREFIX =
          'https://ultramodern-assets.example.com/';
        process.env.MODERN_ASSET_PREFIX = 'https://modern-assets.example.com/';
        const modernOverride = await loadUltramodernConfigFile({
          appDirectory: directory,
          env: 'production',
          command: 'build',
        });
        assert.equal(
          modernOverride.config.output?.assetPrefix,
          process.env.MODERN_ASSET_PREFIX,
        );
        delete process.env.MODERN_ASSET_PREFIX;
        const ultramodernOverride = await loadUltramodernConfigFile({
          appDirectory: directory,
          env: 'production',
          command: 'build',
        });
        assert.equal(
          ultramodernOverride.config.output?.assetPrefix,
          process.env.ULTRAMODERN_ASSET_PREFIX,
        );
      } finally {
        for (const [name, value] of priorEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
    assert.equal(previewPorts.size, 2);
    assert.notEqual(
      topology.shell.cloudflare.workerName,
      topology.verticals[0].cloudflare.workerName,
    );
    assert.deepEqual(topology.shell.verticalRefs, ['catalog']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const renderer of ['solid', 'octane'] as const) {
  test(`CodeSmith cannot create ${renderer} UI identity before config capture`, async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `um-renderer-premature-artifact-${renderer}-`),
    );
    const targetDir = path.join(tempRoot, 'rejected-workspace');
    const overlayDirectory = path.join(tempRoot, 'premature-artifact-overlay');
    const tracePath = path.join(tempRoot, 'ordering.jsonl');
    try {
      fs.mkdirSync(overlayDirectory);
      fs.writeFileSync(
        path.join(overlayDirectory, 'package.json'),
        JSON.stringify({
          name: 'test-native-premature-artifact-overlay',
          version: '0.0.0',
          main: './index.cjs',
        }),
      );
      fs.writeFileSync(
        path.join(overlayDirectory, 'index.cjs'),
        `const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async context => {
  const { outputWorkspaceRoot, generatedApp, tracePath, authoredConfig } = context.config;
  const appDirectory = path.join(outputWorkspaceRoot, generatedApp.directory);
  const artifactPath = path.join(appDirectory, 'shared/ultramodern-build.json');
  assert.equal(fs.existsSync(artifactPath), false);
  fs.appendFileSync(tracePath, JSON.stringify({ phase: 'overlay', renderer: generatedApp.renderer }) + '\\n');
  fs.writeFileSync(path.join(appDirectory, 'modern.config.ts'), authoredConfig);
  fs.writeFileSync(artifactPath, '{}\\n');
};
`,
      );
      const authoredConfig = `import fs from 'node:fs';
import { defineConfig } from '@modern-js/ultramodern-app-tools';

export default defineConfig(async () => {
  fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ phase: 'callback', renderer: '${renderer}' }) + '\\n');
  return { renderer: '${renderer}', source: { mainEntryName: 'main' } };
});
`;
      await assert.rejects(
        () =>
          generateUltramodernWorkspace({
            targetDir,
            packageName: 'rejected-workspace',
            modernVersion: '3.8.3',
            renderer,
            enableTailwind: false,
            generateAgentFiles: false,
            packageSource: { strategy: 'workspace' },
            overlays: [
              {
                generator: overlayDirectory,
                config: { tracePath, authoredConfig },
              },
            ],
          }),
        /New UI artifact must remain absent until modern\.config supplies its actual router bindings/u,
      );
      assert.equal(fs.existsSync(targetDir), false);
      assert.deepEqual(
        fs
          .readFileSync(tracePath, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line)),
        [{ phase: 'overlay', renderer }],
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

for (const renderer of ['solid', 'octane'] as const) {
  test(`CodeSmith authors ${renderer} entries before the sole config capture and UI artifact`, async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `um-renderer-overlay-${renderer}-`),
    );
    const targetDir = path.join(tempRoot, 'entry-workspace');
    const overlayDirectory = path.join(tempRoot, 'entry-authoring-overlay');
    const tracePath = path.join(tempRoot, 'ordering.jsonl');
    try {
      fs.mkdirSync(overlayDirectory);
      fs.writeFileSync(
        path.join(overlayDirectory, 'package.json'),
        JSON.stringify({
          name: 'test-native-entry-authoring-overlay',
          version: '0.0.0',
          main: './index.cjs',
        }),
      );
      fs.writeFileSync(
        path.join(overlayDirectory, 'index.cjs'),
        `const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async context => {
  const { outputWorkspaceRoot, generatedApp, authoredConfig, tracePath } = context.config;
  const appDirectory = path.join(outputWorkspaceRoot, generatedApp.directory);
  assert.equal(Object.hasOwn(generatedApp, 'routerBindings'), false);
  assert.equal(fs.existsSync(path.join(appDirectory, 'shared/ultramodern-build.json')), false);
  fs.appendFileSync(tracePath, JSON.stringify({ phase: 'overlay', renderer: generatedApp.renderer, artifactAbsent: true }) + '\\n');
  fs.writeFileSync(path.join(appDirectory, 'modern.config.ts'), authoredConfig);
  for (const entryName of ['ssr', 'csr']) {
    const routesDirectory = path.join(appDirectory, 'src', entryName, 'routes');
    fs.mkdirSync(routesDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(routesDirectory, 'page.tsx'),
      'export default function Page() { return <main data-entry="' + entryName + '">Native entry</main>; }\\n',
    );
    fs.writeFileSync(
      path.join(routesDirectory, 'page.data.ts'),
      'export async function loader() { return { entry: "' + entryName + '" }; }\\n',
    );
  }
};
`,
      );
      const authoredConfig = `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@modern-js/ultramodern-app-tools';

export default defineConfig(async ({ env, command }) => {
  const appDirectory = process.cwd();
  for (const entryName of ['ssr', 'csr']) {
    assert.match(fs.readFileSync(path.join(appDirectory, 'src', entryName, 'routes', 'page.tsx'), 'utf8'), new RegExp('data-entry="' + entryName + '"'));
    assert.match(fs.readFileSync(path.join(appDirectory, 'src', entryName, 'routes', 'page.data.ts'), 'utf8'), /export async function loader\\(/u);
  }
  fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ phase: 'callback', renderer: '${renderer}', env, command }) + '\\n');
  await Promise.resolve();
  return {
    renderer: '${renderer}',
    source: {
      disableDefaultEntries: true,
      mainEntryName: 'ssr',
      entries: {
        ssr: './src/ssr/routes',
        csr: './src/csr/routes',
      },
    },
    server: {
      ssrByEntries: { ssr: true, csr: false },
      routes: {
        ssr: { route: '/server' },
        csr: { route: '/client' },
      },
    },
  };
});
`;
      const result = await generateUltramodernWorkspace({
        targetDir,
        packageName: 'entry-workspace',
        modernVersion: '3.8.3',
        renderer,
        enableTailwind: false,
        generateAgentFiles: false,
        packageSource: { strategy: 'workspace' },
        overlays: [
          {
            generator: overlayDirectory,
            config: { authoredConfig, tracePath },
          },
        ],
      });
      const files = snapshotWorkspace(targetDir);
      const app = result.createdApps[0]!;
      const topology = JSON.parse(files['topology/reference-topology.json']!);
      const artifact = JSON.parse(
        files[`${appDirectory}/shared/ultramodern-build.json`]!,
      );
      const config = files[`${appDirectory}/modern.config.ts`]!;
      assert.deepEqual(
        fs
          .readFileSync(tracePath, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line)),
        [
          { phase: 'overlay', renderer, artifactAbsent: true },
          {
            phase: 'callback',
            renderer,
            env: 'development',
            command: 'generate',
          },
        ],
      );
      const artifactValidation = validateUltramodernBuildArtifact(artifact);
      assert.equal(
        artifactValidation.ok,
        true,
        JSON.stringify(artifactValidation.errors),
      );
      assert.equal(result.createdApps.length, 1);
      assert.equal(app.renderer, renderer);
      assert.equal(app.rendererIdentity?.entryName, 'ssr');
      assert.deepEqual(Object.keys(app.rendererIdentities!).sort(), [
        'csr',
        'ssr',
      ]);
      assert.equal(Object.hasOwn(app.rendererIdentities!, 'main'), false);
      assert.deepEqual(app.rendererIdentity, app.rendererIdentities!.ssr);
      assert.notEqual(
        app.rendererIdentities!.ssr.buildId,
        app.rendererIdentities!.csr.buildId,
      );
      for (const entryName of ['ssr', 'csr']) {
        const identity = app.rendererIdentities![entryName]!;
        assert.equal(identity.renderer, renderer);
        assert.equal(identity.appId, app.id);
        assert.equal(identity.entryName, entryName);
        assert.equal(identity.protocolVersion, 1);
        assert.ok(identity.buildId);
        assert.ok(files[`${appDirectory}/src/${entryName}/routes/page.tsx`]);
        assert.ok(
          files[`${appDirectory}/src/${entryName}/routes/page.data.ts`],
        );
      }
      const entryNames = Object.keys(app.rendererIdentities!).sort();
      assert.deepEqual(Object.keys(app.routerBindings!).sort(), entryNames);
      assert.deepEqual(
        Object.keys(topology.shell.routerBindings).sort(),
        entryNames,
      );
      assert.deepEqual(
        Object.keys(artifact.surfaces.ui.routerBindings).sort(),
        entryNames,
      );
      assert.deepEqual(topology.shell.routerBindings, app.routerBindings);
      assert.deepEqual(artifact.surfaces.ui.routerBindings, app.routerBindings);
      const provider = {
        ...getRendererGenerationProfile(renderer).profile.router,
        framework: renderer,
      };
      for (const entryName of entryNames) {
        assert.deepEqual(app.routerBindings![entryName], {
          owner: `@modern-js/renderer-${renderer}-infrastructure`,
          evidence: 'owned-default',
          defaultProvider: provider,
          providers: [provider],
        });
      }
      const bindingValidation = validateRendererRouterBindings(
        app.routerBindings,
        entryNames,
        'routerBindings',
        getRendererGenerationProfile(renderer).routerFrameworks,
      );
      assert.equal(
        bindingValidation.ok,
        true,
        JSON.stringify(bindingValidation.errors),
      );
      assert.deepEqual(
        topology.shell.rendererIdentities,
        app.rendererIdentities,
      );
      assert.deepEqual(
        topology.shell.rendererIdentity,
        app.rendererIdentities!.ssr,
      );
      assert.deepEqual(
        artifact.surfaces.ui.rendererIdentity,
        app.rendererIdentities!.ssr,
      );
      assert.equal(artifact.surfaces.ui.rendererIdentity.entryName, 'ssr');
      assert.equal(
        Object.hasOwn(artifact.surfaces.ui, 'rendererIdentities'),
        false,
      );
      assert.deepEqual(
        artifact.surfaces.ui.rendererProfile,
        getRendererGenerationProfile(renderer).profile,
      );
      assert.equal(config.match(/\bdefineConfig\s*\(/gu)?.length, 1);
      assert.doesNotMatch(config, /\bultramodernAppTools\b/u);
      assert.match(config, /disableDefaultEntries:\s*true/u);
      assert.match(config, /mainEntryName:\s*['"]ssr['"]/u);
      assert.match(config, /ssrByEntries:\s*\{\s*ssr:\s*true,\s*csr:\s*false/u);
      assert.match(config, /ssr:\s*\{\s*route:\s*['"]\/server['"]/u);
      assert.match(config, /csr:\s*\{\s*route:\s*['"]\/client['"]/u);
      assert.doesNotMatch(config, unsupportedNativeSource);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('invalid renderer and unsupported native bridge leave no target output', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-renderer-rejection-'),
  );
  try {
    for (const renderer of ['invalid', 'solid', 'octane']) {
      const targetDir = path.join(tempRoot, renderer);
      const options: UltramodernWorkspaceOptions = {
        targetDir,
        packageName: 'rejected-renderer',
        modernVersion: '3.8.3',
        packageSource: { strategy: 'workspace' },
      };
      Reflect.set(options, 'renderer', renderer);
      if (renderer !== 'invalid') {
        options.bridge = {
          parentRoot: '..',
          workspacePackages: [
            {
              pattern: '../domain-core',
              packageNames: ['@example/domain-core'],
            },
          ],
          dependencies: ['@example/domain-core'],
          gates: [{ name: 'domain-test', command: 'pnpm test', cwd: '..' }],
        };
      }
      await assert.rejects(
        async () => generateUltramodernWorkspace(options),
        renderer === 'invalid'
          ? /Unsupported renderer invalid/u
          : new RegExp(
              `Renderer ${renderer} does not support React bridge configuration`,
              'u',
            ),
      );
      assert.equal(fs.existsSync(targetDir), false, renderer);
    }
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('initial identities are deterministic and separate React index from native main', () => {
  const identities = renderers.map(renderer => {
    const source = {
      ...shellApp,
      renderer,
      deliveryUnit: { version: '0.0.0', sourceRevision: 'initial-source' },
    };
    const initialized = initializeGeneratedRendererIdentity(
      'identity-workspace',
      source,
    );
    const entryName = renderer === 'react' ? 'index' : 'main';
    const identity = initialized.rendererIdentity!;
    assert.deepEqual(identity, {
      renderer,
      appId: source.id,
      entryName,
      protocolVersion: 1,
      buildId: createBuildMarker('identity-workspace', initialized),
    });
    assert.equal(initialized.rendererIdentities![entryName], identity);
    assert.deepEqual(initialized.deliveryUnit, {
      ...source.deliveryUnit,
      version: '0.1.0',
      buildMarker: identity.buildId,
    });
    assert.deepEqual(
      initialized,
      initializeGeneratedRendererIdentity('identity-workspace', source),
    );
    assert.equal(source.rendererIdentity, undefined);
    assert.equal(
      initialized.rendererIdentity?.entryName,
      renderer === 'react' ? 'index' : 'main',
    );
    assert.deepEqual(initialized.rendererIdentities, {
      [renderer === 'react' ? 'index' : 'main']: initialized.rendererIdentity,
    });
    assert.notEqual(
      initialized.rendererIdentity?.buildId,
      initializeGeneratedRendererIdentity('identity-workspace', source, '0.2.0')
        .rendererIdentity?.buildId,
    );
    assert.notEqual(
      initialized.rendererIdentity?.buildId,
      initializeGeneratedRendererIdentity('another-workspace', source)
        .rendererIdentity?.buildId,
    );
    return initialized.rendererIdentity!.buildId;
  });
  assert.equal(new Set(identities).size, renderers.length);
});

test('headless generation has no UI identity and rejects UI metadata', () => {
  const source = createVerticalDescriptor('headless', 3101, {
    preset: 'api-only',
  });
  const initialized = initializeGeneratedRendererIdentity(
    'identity-workspace',
    source,
  );
  assert.equal(initialized.renderer, 'none');
  for (const field of [
    'rendererIdentity',
    'rendererIdentities',
    'rendererProfile',
    'routerBindings',
    'rendererCapabilities',
    'rendererGenerationProfile',
  ]) {
    assert.equal(Object.hasOwn(initialized, field), false, field);
  }
  const ui = initializeGeneratedRendererIdentity(
    'identity-workspace',
    shellApp,
  );
  for (const field of [
    'rendererIdentity',
    'rendererIdentities',
    'rendererProfile',
    'routerBindings',
    'rendererCapabilities',
    'rendererGenerationProfile',
  ]) {
    const invalid = { ...source };
    Reflect.set(
      invalid,
      field,
      field === 'routerBindings' ? {} : Reflect.get(ui, field),
    );
    assert.throws(
      () => initializeGeneratedRendererIdentity('identity-workspace', invalid),
      /Headless unit headless cannot carry a UI renderer identity/u,
      field,
    );
  }
});
