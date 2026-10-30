import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UltramodernBridgeConfig } from '../src/ultramodern-workspace/bridge-config';
import {
  createVerticalDescriptor,
  shellApp,
} from '../src/ultramodern-workspace/descriptors';
import {
  appDependencies,
  createAppPackage,
  createRootPackageJson,
} from '../src/ultramodern-workspace/package-json';
import { resolveWorkspacePackageLinkingPolicy } from '../src/ultramodern-workspace/package-source';
import type {
  JsonValue,
  ResolvedPackageSource,
  WorkspaceApp,
} from '../src/ultramodern-workspace/types';
import { createWorkspaceAppPackageScripts } from '../src/ultramodern-workspace/workspace-script-plan';

const scope = 'tractor-store';
const packageVersion = '3.5.0-ultramodern.9';

const installPackageSource = {
  strategy: 'install',
  modernPackageVersion: packageVersion,
} satisfies ResolvedPackageSource;

const workspacePackageSource = {
  strategy: 'workspace',
  modernPackageVersion: '0.0.0',
} satisfies ResolvedPackageSource;

const bridgeConfig = {
  enabled: true,
  parentRoot: '../tractor-store',
  workspacePackages: [{ pattern: '../tractor-store/packages/*' }],
  dependencies: ['@tractor-store/bridge-kit'],
  lockfilePolicy: 'parent',
  gates: [{ name: 'contracts', command: 'pnpm test' }],
  reactSingletons: [],
} satisfies UltramodernBridgeConfig;

function createCatalogVertical() {
  return createVerticalDescriptor('catalog', 4101);
}

function createCheckoutVertical() {
  return createVerticalDescriptor('checkout', 4102);
}

function packageRecord(value: JsonValue) {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, JsonValue>;
}

test('bridge dependencies are added after generated app deps and collisions fail closed', () => {
  const catalog = createCatalogVertical();

  const result = appDependencies(
    scope,
    installPackageSource,
    catalog,
    [],
    bridgeConfig,
  );
  assert.equal(result['@tractor-store/bridge-kit'], 'workspace:*');
  assert.throws(
    () =>
      appDependencies(scope, installPackageSource, catalog, [], {
        ...bridgeConfig,
        dependencies: ['react'],
      }),
    {
      message:
        'Bridge mode dependency "react" conflicts with generated app dependency.',
    },
  );
});

test('workspace package source uses workspace versions for generated framework deps', () => {
  const packageJson = packageRecord(
    createAppPackage(
      scope,
      createCatalogVertical(),
      workspacePackageSource,
      false,
    ),
  );

  for (const name of [
    '@modern-js/app-tools',
    '@modern-js/app-tools-extensions',
    '@modern-js/ultramodern-app-tools',
    '@modern-js/plugin-bff-build-extensions',
  ]) {
    assert.equal(packageJson.devDependencies[name], 'workspace:*');
  }
  const scripts = packageRecord(packageJson.scripts);
  assert.match(
    scripts.build as string,
    /(?:^| && )ultramodern build --deploy-target node && .* && ultramodern deploy --skip-build --deploy-target node$/u,
  );
  assert.match(
    scripts['cloudflare:build'] as string,
    /(?:^| && )ultramodern build --deploy-target cloudflare && .* && ultramodern deploy --skip-build --deploy-target cloudflare && .* cloudflare-output-verify --app catalog$/u,
  );
  assert.match(
    scripts['cloudflare:deploy'] as string,
    /--require-public-origin && ultramodern deploy --skip-build --deploy-target cloudflare && .* cloudflare-output-verify --app catalog --require-public-urls && wrangler deploy --config \.output\/wrangler\.json$/u,
  );
  // Env assignments need a wrapper such as cross-env, which reports a build
  // that died from a signal as a plain exit 1.
  for (const command of Object.values(scripts)) {
    assert.doesNotMatch(command as string, /(?:^|\s)[A-Z][A-Z0-9_]*=/u);
  }
  assert.equal(packageJson.devDependencies['cross-env'], undefined);
});

test('workspace package source isolates linked framework dependencies without changing install-backed workspaces', () => {
  assert.deepEqual(
    resolveWorkspacePackageLinkingPolicy({ strategy: 'workspace' }),
    {
      injectWorkspacePackages: true,
      linkWorkspacePackages: true,
    },
  );
  assert.deepEqual(
    resolveWorkspacePackageLinkingPolicy({ strategy: 'install' }),
    {},
  );
});

test('root package json pins workspace package versions and bridge workspace globs', () => {
  const catalog = createCatalogVertical();
  const checkout = createCheckoutVertical();
  const rootPackageJson = packageRecord(
    createRootPackageJson(
      scope,
      installPackageSource,
      [catalog, checkout],
      bridgeConfig,
    ),
  );

  assert.deepEqual(rootPackageJson.workspaces, [
    'apps/*',
    'verticals/*',
    'packages/*',
    '../tractor-store/packages/*',
  ]);
  const rootScripts = packageRecord(rootPackageJson.scripts);
  assert.equal(rootScripts.format, 'oxfmt .');
  assert.equal(rootScripts['format:check'], 'oxfmt --check .');
  assert.equal(
    rootScripts.postinstall,
    'ultramodern-create ultramodern compiler-prepare && ultramodern-create ultramodern skills install --postinstall',
  );
  assert.equal(
    packageRecord(rootPackageJson.devDependencies)['cross-env'],
    undefined,
  );
});

test.skipIf(process.platform === 'win32')(
  'a generated build script surfaces a crashing build under pnpm',
  () => {
    const modernBuild = createWorkspaceAppPackageScripts(
      createCatalogVertical(),
    )
      ['cloudflare:build'].split(' && ')
      .find(step => step.startsWith('ultramodern build'));
    assert.equal(modernBuild, 'ultramodern build --deploy-target cloudflare');
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-crash-signal-'));
    try {
      fs.writeFileSync(
        path.join(appDir, 'package.json'),
        JSON.stringify({ name: 'crash', scripts: { build: modernBuild } }),
      );
      const bin = path.join(appDir, 'node_modules/.bin/ultramodern');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      // Stands in for a build that overflows the native stack.
      fs.writeFileSync(bin, '#!/bin/sh\nkill -SEGV $$\n', { mode: 0o755 });
      const result = spawnSync('pnpm', ['run', 'build'], {
        cwd: appDir,
        encoding: 'utf8',
        env: { ...process.env, CI: '' },
      });
      // pnpm re-raises the signal or exits 128 + SIGSEGV; cross-env reported
      // the same crash as a plain exit 1.
      assert.ok(
        result.signal === 'SIGSEGV' || result.status === 139,
        `status ${result.status}, signal ${result.signal}`,
      );
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  },
);

test('generated React roots provide canonical framework peers and their pinned runtime providers', () => {
  const buildPlugin = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../cli/plugin-bff-build-extensions/package.json',
      ),
      'utf8',
    ),
  );
  assert.ok(buildPlugin.peerDependencies['@modern-js/app-tools']);
  assert.notEqual(
    buildPlugin.peerDependenciesMeta?.['@modern-js/app-tools']?.optional,
    true,
  );
  const runtime = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../runtime/plugin-runtime/package.json'),
      'utf8',
    ),
  );
  const integration = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../runtime/i18n-integration/package.json'),
      'utf8',
    ),
  );
  assert.ok(integration.peerDependencies['@modern-js/runtime']);
  assert.notEqual(
    integration.peerDependenciesMeta?.['@modern-js/runtime']?.optional,
    true,
  );
  const tools = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../solutions/ultramodern-app-tools/package.json',
      ),
      'utf8',
    ),
  );
  assert.equal(
    tools.dependencies['@tanstack/redact'],
    'npm:@bleedingdev/tanstack-redact@0.2.2',
  );
  assert.equal(tools.dependencies['rsbuild-redact-plugin'], '0.1.0');
  assert.equal(tools.peerDependencies.typescript, '7.0.2');
  assert.notEqual(tools.peerDependenciesMeta?.typescript?.optional, true);
  for (const name of ['react', 'react-dom']) {
    assert.ok(runtime.peerDependencies[name]);
    assert.notEqual(runtime.peerDependenciesMeta?.[name]?.optional, true);
  }
  for (const [packageSource, expected] of [
    [workspacePackageSource, 'workspace:*'],
    [installPackageSource, 'catalog:ultramodern'],
    [
      {
        ...installPackageSource,
        aliasScope: 'bleedingdev',
        aliasPackageNamePrefix: 'modern-js-',
      },
      'catalog:ultramodern',
    ],
  ] as const) {
    const root = packageRecord(
      createRootPackageJson(scope, packageSource, [createCatalogVertical()]),
    );
    const dependencies = packageRecord(root.devDependencies);
    const app = packageRecord(
      createAppPackage(scope, shellApp, packageSource, false),
    );
    const appDependencies = packageRecord(app.dependencies);
    const appDevDependencies = packageRecord(app.devDependencies);
    for (const manifest of [root, app]) {
      for (const group of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        const declarations = manifest[group]
          ? packageRecord(manifest[group])
          : {};
        for (const name of ['@tanstack/redact', 'rsbuild-redact-plugin']) {
          assert.equal(
            declarations[name],
            undefined,
            `${group}.${name} belongs to the framework`,
          );
        }
      }
    }
    assert.ok(dependencies['@modern-js/plugin-bff-build-extensions']);
    assert.equal(dependencies['@modern-js/app-tools'], expected);
    assert.equal(dependencies['@modern-js/runtime'], expected);
    assert.equal(
      dependencies['@modern-js/runtime'],
      appDependencies['@modern-js/runtime'],
    );
    assert.equal(dependencies.react, appDependencies.react);
    assert.equal(dependencies['react-dom'], appDependencies['react-dom']);
    assert.equal(dependencies.typescript, tools.peerDependencies.typescript);
    assert.equal(dependencies.typescript, appDevDependencies.typescript);
    assert.equal(root.pnpm, undefined);
    for (const renderer of ['solid', 'octane'] as const) {
      const nativeRoot = packageRecord(
        createRootPackageJson(scope, packageSource, [], undefined, [], {
          ...shellApp,
          renderer,
        }),
      );
      const nativeDependencies = packageRecord(nativeRoot.devDependencies);
      assert.equal(
        nativeDependencies.typescript,
        tools.peerDependencies.typescript,
      );
      assert.equal(nativeDependencies['@modern-js/runtime'], undefined);
      assert.equal(nativeDependencies.react, undefined);
      assert.equal(nativeDependencies['react-dom'], undefined);
    }
  }
});

test('app package generation throws for unknown remote refs', () => {
  const missingRemoteShell = {
    ...shellApp,
    verticalRefs: ['missing'],
  } satisfies WorkspaceApp;

  assert.throws(
    () =>
      createAppPackage(scope, missingRemoteShell, installPackageSource, false, [
        createCatalogVertical(),
      ]),
    {
      message:
        'Unknown remote vertical reference missing for shell-super-app. Available remotes: catalog.',
    },
  );
});

test('generated apps resolve their public renderer entry with isolated direct dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-renderer-direct-'));
  try {
    const app = path.join(root, 'apps/shell');
    const modernScope = path.join(app, 'node_modules/@modern-js');
    fs.mkdirSync(modernScope, { recursive: true });
    const manifest = packageRecord(
      createAppPackage(scope, shellApp, workspacePackageSource, false),
    );
    const dependencies = {
      ...packageRecord(manifest.dependencies),
      ...packageRecord(manifest.devDependencies),
    };
    const packages = {
      '@modern-js/ultramodern-app-tools':
        '../../solutions/ultramodern-app-tools',
      '@modern-js/runtime-renderer-extensions':
        '../../runtime/renderer-extensions',
    };
    // Link only declared app dependencies, without a hoisted root node_modules.
    for (const [name, directory] of Object.entries(packages)) {
      if (!Object.hasOwn(dependencies, name)) continue;
      fs.symlinkSync(
        path.resolve(__dirname, '..', directory),
        path.join(modernScope, name.split('/')[1]),
        'dir',
      );
    }
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=commonjs',
        '-e',
        `const { createRequire } = require('node:module');
const appRequire = createRequire(process.argv[1]);
appRequire.resolve('@modern-js/ultramodern-app-tools');
process.stdout.write(appRequire.resolve('@modern-js/runtime-renderer-extensions'));`,
        path.join(app, '.modern-js/main/runtime.js'),
      ],
      { cwd: app, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /renderer-extensions/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BFF build dependencies follow app capabilities and retain runtime packages', () => {
  for (const preset of ['full-stack', 'api-only', 'ui-only'] as const) {
    const app = createVerticalDescriptor('catalog', 4101, { preset });
    const manifest = packageRecord(
      createAppPackage(scope, app, installPackageSource, false),
    );
    const expected = preset === 'ui-only' ? undefined : 'catalog:ultramodern';
    assert.equal(
      manifest.devDependencies['@modern-js/plugin-bff-build-extensions'],
      expected,
    );
    assert.equal(manifest.dependencies['@modern-js/plugin-bff'], expected);
    assert.equal(
      manifest.dependencies['@modern-js/plugin-bff-extensions'],
      expected,
    );
  }
});

test('generated UI profiles directly declare i18n providers and headless apps omit them', () => {
  const apps = [
    shellApp,
    ...(['full-stack', 'api-only', 'ui-only'] as const).map(preset =>
      createVerticalDescriptor('catalog', 4101, { preset }),
    ),
    createVerticalDescriptor('navigation', 4102, { horizontalRemote: true }),
  ];
  const packageSource = {
    ...installPackageSource,
    aliasScope: 'bleedingdev',
    aliasPackageNamePrefix: 'modern-js-',
  };
  for (const app of apps) {
    const manifest = packageRecord(
      createAppPackage(scope, app, packageSource, false),
    );
    const expected =
      app.surfaceProfile === 'api-only' ? undefined : 'catalog:ultramodern';
    assert.equal(
      manifest.dependencies['@modern-js/i18n-integration'],
      expected,
    );
    assert.equal(manifest.dependencies['@modern-js/plugin-i18n'], expected);
    assert.equal(
      manifest.dependencies['@modern-js/i18n-runtime-extensions'],
      undefined,
    );
  }
});
