import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRendererRouterBindings } from '@modern-js/backend-federation-contracts';
import { shellApp } from '../src/ultramodern-workspace/descriptors';
import {
  assertOverlayPreservedBaseline,
  captureOverlayBaselineSnapshot,
  OverlayBaselineRelaxationError,
} from '../src/ultramodern-workspace/overlay-baseline-guard';
import {
  createCloudflareDeployContract,
  ULTRAMODERN_WORKSPACE_POLICY,
} from '../src/ultramodern-workspace/policy';
import { getRendererGenerationProfile } from '../src/ultramodern-workspace/renderer-profile';
import {
  assertAuthoredRendererDependencyPins,
  assertNativeRendererSourceSurface,
  assertRendererDependencies,
  assertRendererProjection,
  isForeignRendererPackage,
  readReactFrameworkCompatibleRanges,
} from '../src/ultramodern-workspace/validation/renderer';
import { readRendererFrameworkPackageEvidence } from '../src/ultramodern-workspace/validation/renderer-framework-evidence';
import { validateWorkspace } from '../src/ultramodern-workspace/validation/workspace';
import {
  MODULE_FEDERATION_NODE_VERSION,
  MODULE_FEDERATION_VERSION,
  ULTRAMODERN_PACKAGE_PINS,
} from '../src/ultramodern-workspace/versions';
import { createWorkspaceValidationContract } from '../src/ultramodern-workspace/workspace-validation-contract';
import { linkInstalledCompiler } from './helpers/workspace-kit';

function nativeProjection(
  renderer: 'solid' | 'octane',
  appId = 'shell-super-app',
  appPath = `apps/${appId}`,
) {
  const generation = getRendererGenerationProfile(renderer);
  const identity = {
    renderer,
    appId,
    entryName: 'main',
    protocolVersion: 1,
    buildId: 'build-native-fixture',
  };
  const provider = { ...generation.profile.router, framework: renderer };
  return {
    id: identity.appId,
    path: appPath,
    renderer,
    rendererProfile: generation.profile,
    rendererIdentity: identity,
    rendererIdentities: { main: identity },
    routerBindings: {
      main: {
        owner: `@modern-js/renderer-${renderer}-infrastructure`,
        evidence: 'owned-default',
        defaultProvider: provider,
        providers: [provider],
      },
    },
    rendererCapabilities: generation.capabilities,
    deliveryUnit: { buildMarker: identity.buildId },
  };
}

function overlayFixture(renderer: 'solid' | 'octane') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-renderer-overlay-'));
  const app = nativeProjection(renderer);
  const generation = getRendererGenerationProfile(renderer);
  const manifest = {
    name: '@fixture/shell-super-app',
    dependencies: {
      ...generation.dependencies,
      ...Object.fromEntries(
        generation.frameworkDependencies.map(name => [name, 'workspace:*']),
      ),
    },
    devDependencies: { ...generation.devDependencies },
    scripts: { build: 'ultramodern build' },
  };
  const write = (relative: string, value: unknown) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  write('package.json', { name: '@fixture/workspace' });
  write('topology/reference-topology.json', {
    shell: app,
    shells: [],
    verticals: [],
  });
  write(`${app.path}/package.json`, manifest);
  write(`${app.path}/tsconfig.json`, {
    compilerOptions: {
      jsx: 'preserve',
      jsxImportSource: generation.jsxImportSource,
    },
  });
  for (const relative of ['layout.tsx', 'page.tsx', 'about/page.tsx']) {
    write(
      `${app.path}/src/routes/${relative}`,
      'export default function Page() { return null; }',
    );
  }
  write(`${app.path}/shared/ultramodern-build.json`, {
    surfaces: {
      ui: {
        rendererProfile: app.rendererProfile,
        rendererIdentity: app.rendererIdentity,
        routerBindings: app.routerBindings,
      },
    },
  });
  return { root, app, manifest, write };
}

test('React topology authored before renderer selection needs no persisted projection', () => {
  const app = { id: 'shell-super-app', path: 'apps/shell-super-app' };
  const expected = {
    id: app.id,
    kind: 'shell',
    path: app.path,
    renderer: 'react',
    emitsUi: true,
  } as unknown as Parameters<typeof assertRendererProjection>[1];
  assert.equal(assertRendererProjection(app, expected)?.renderer, 'react');
  // A native selection, or any partial projection, still has to be persisted.
  assert.throws(
    () =>
      assertRendererProjection(app, {
        ...expected!,
        renderer: 'solid',
      } as typeof expected),
    /renderer disagrees with modern.config/,
  );
  assert.throws(
    () => assertRendererProjection({ ...app, renderer: 'react' }, expected),
    /renderer profile disagrees/,
  );
});

test('native renderer projections reject a mismatched tuple, identity and capability claim', () => {
  for (const renderer of ['solid', 'octane'] as const) {
    const app = nativeProjection(renderer);
    assert.equal(assertRendererProjection(app)?.renderer, renderer);
    assert.throws(
      () =>
        assertRendererProjection({
          ...app,
          rendererProfile: {
            ...app.rendererProfile,
            compiler: { ...app.rendererProfile.compiler, version: '0.0.0' },
          },
        }),
      /compiler\/runtime\/router tuple/,
    );
    assert.throws(
      () =>
        assertRendererProjection({
          ...app,
          rendererIdentity: {
            ...app.rendererIdentity,
            buildId: 'different-build',
          },
        }),
      /delivery build/,
    );
    assert.throws(
      () =>
        assertRendererProjection({
          ...app,
          rendererIdentities: { secondary: app.rendererIdentity },
        }),
      /entry identity is missing/,
    );
    assert.throws(
      () =>
        assertRendererProjection({
          ...app,
          rendererCapabilities: {
            ...app.rendererCapabilities,
            federation: !app.rendererCapabilities.federation,
          },
        }),
      /admitted profile/,
    );
    assert.equal(app.rendererCapabilities.federation, true);
    assert.doesNotThrow(() =>
      assertRendererProjection({ ...app, moduleFederation: {} }),
    );
  }
});

test('native renderer projections require a full router binding map for every entry', () => {
  for (const renderer of ['solid', 'octane'] as const) {
    const app = nativeProjection(renderer);
    for (const routerBindings of [undefined, {}]) {
      assert.throws(
        () => assertRendererProjection({ ...app, routerBindings }),
        routerBindings === undefined
          ? /requires router bindings captured from modern.config/
          : /router bindings disagree with its configured entries/,
      );
    }
    const secondaryIdentity = {
      ...app.rendererIdentity,
      entryName: 'secondary',
    };
    assert.throws(
      () =>
        assertRendererProjection({
          ...app,
          rendererIdentities: {
            ...app.rendererIdentities,
            secondary: secondaryIdentity,
          },
        }),
      /router bindings disagree with its configured entries/,
    );
    assert.doesNotThrow(() =>
      assertRendererProjection({
        ...app,
        rendererIdentities: {
          ...app.rendererIdentities,
          secondary: secondaryIdentity,
        },
        routerBindings: {
          ...app.routerBindings,
          secondary: app.routerBindings.main,
        },
      }),
    );
  }
});

test('native renderer projections reject structurally valid cross-renderer router providers', () => {
  const provider = {
    ...getRendererGenerationProfile('react').profile.router,
    framework: 'react-router',
  };
  for (const renderer of ['solid', 'octane'] as const) {
    const app = nativeProjection(renderer);
    const routerBindings = {
      main: {
        ...app.routerBindings.main,
        defaultProvider: provider,
        providers: [provider],
      },
    };
    assert.equal(
      validateRendererRouterBindings(routerBindings, ['main']).ok,
      true,
    );
    assert.equal(
      validateRendererRouterBindings(
        routerBindings,
        ['main'],
        'routerBindings',
        getRendererGenerationProfile(renderer).routerFrameworks,
      ).ok,
      false,
    );
    assert.throws(
      () => assertRendererProjection({ ...app, routerBindings }),
      /router bindings disagree with its configured entries/,
    );
  }
});

test('headless units cannot carry UI identity or renderer dependencies', () => {
  assert.equal(
    assertRendererProjection({ id: 'headless', renderer: 'none' }),
    undefined,
  );
  assert.throws(
    () =>
      assertRendererProjection({
        id: 'headless',
        renderer: 'none',
        rendererProfile: {},
      }),
    /headless unit must omit rendererProfile/,
  );
  assert.throws(
    () =>
      assertRendererProjection({
        id: 'headless',
        renderer: 'none',
        routerBindings: {},
      }),
    /headless unit must omit routerBindings/,
  );
  assert.throws(
    () =>
      assertRendererDependencies(
        { name: 'headless', dependencies: { react: '19.3.0' } },
        'none',
      ),
    /foreign renderer package react/,
  );
  assert.throws(
    () => assertRendererProjection({ id: 'react-app', renderer: 'react' }),
    /compiler\/runtime\/router tuple/,
  );
  assert.throws(
    () =>
      assertRendererDependencies(
        {
          name: 'native-app',
          dependencies: { 'aliased-view': 'npm:react@19.3.0' },
        },
        'solid',
      ),
    /foreign renderer package aliased-view/,
  );
  assert.equal(
    isForeignRendererPackage('@modern-js/renderer-react/browser', 'solid'),
    true,
  );
  assert.equal(
    isForeignRendererPackage('react-refresh/runtime', 'solid'),
    true,
  );
  assert.doesNotThrow(() =>
    assertRendererDependencies(
      { name: 'octane-app', devDependencies: { '@types/react': '19.3.0' } },
      'octane',
    ),
  );
  assert.throws(
    () =>
      assertRendererDependencies(
        {
          name: 'native-app',
          dependencies: { 'react-server-dom-webpack': '19.3.0' },
        },
        'solid',
      ),
    /foreign renderer package react-server-dom-webpack/,
  );
  assert.throws(
    () =>
      assertRendererDependencies(
        { name: 'native-catalog', dependencies: { legacy: 'catalog:compat' } },
        'solid',
        undefined,
        { catalogs: { compat: { legacy: 'npm:react@19.3.0' } } },
      ),
    /foreign renderer package legacy/,
  );
});

test('authored renderer ABI pins resolve explicit catalogs and reject mismatches before projection', () => {
  const generation = getRendererGenerationProfile('solid');
  const version = generation.profile.hydration.version;
  const manifest = {
    name: '@fixture/authored',
    dependencies: {
      'solid-js': 'catalog:ui',
      '@solidjs/web': 'catalog:',
      '@tanstack/router-core': generation.dependencies['@tanstack/router-core'],
    },
    devDependencies: {
      '@solidjs/compiler': `npm:@solidjs/compiler@${generation.profile.compiler.version}`,
    },
  };
  const catalogs = {
    catalog: { '@solidjs/web': version },
    catalogs: { ui: { 'solid-js': version } },
  };
  assert.doesNotThrow(() =>
    assertAuthoredRendererDependencyPins(manifest, generation, catalogs),
  );
  assert.throws(
    () => assertAuthoredRendererDependencyPins(manifest, generation),
    /declared renderer ABI catalog:ui disagrees/,
  );
  assert.throws(
    () =>
      assertAuthoredRendererDependencyPins(
        {
          ...manifest,
          devDependencies: { '@solidjs/compiler': '^2.0.0-rc.15' },
        },
        generation,
        catalogs,
      ),
    /declared renderer ABI \^2.0.0-rc.15 disagrees/,
  );
  assert.throws(
    () =>
      assertAuthoredRendererDependencyPins(
        { ...manifest, dependencies: { react: '19.3.0' } },
        generation,
        catalogs,
      ),
    /conflicts with the selected solid renderer/,
  );
});

test('native federation dependencies use exact producer pins through catalogs and same-name aliases', () => {
  for (const renderer of ['solid', 'octane'] as const) {
    const generation = getRendererGenerationProfile(renderer);
    const dependencies = {
      ...generation.dependencies,
      ...Object.fromEntries(
        generation.frameworkDependencies.map(name => [name, 'workspace:*']),
      ),
      '@module-federation/enhanced': 'catalog:federation',
      '@module-federation/node': `npm:@module-federation/node@${MODULE_FEDERATION_NODE_VERSION}`,
    };
    const manifest = {
      name: `@fixture/${renderer}-federation`,
      dependencies,
      devDependencies: { ...generation.devDependencies },
    };
    const catalogs = {
      catalogs: {
        federation: {
          '@module-federation/enhanced': MODULE_FEDERATION_VERSION,
        },
      },
    };
    assert.doesNotThrow(() =>
      assertRendererDependencies(manifest, renderer, generation, catalogs),
    );
    assert.doesNotThrow(() =>
      assertAuthoredRendererDependencyPins(manifest, generation, catalogs),
    );
    assert.doesNotThrow(() =>
      assertRendererDependencies(manifest, renderer, undefined, catalogs),
    );
    assert.doesNotThrow(() =>
      assertRendererDependencies({ name: 'standalone' }, renderer),
    );
    assert.throws(
      () => assertRendererDependencies(manifest, renderer),
      /declared federation ABI catalog:federation disagrees/u,
    );
    const missing: Record<string, string> = { ...dependencies };
    delete missing['@module-federation/node'];
    assert.throws(
      () =>
        assertRendererDependencies(
          { ...manifest, dependencies: missing },
          renderer,
          generation,
          catalogs,
        ),
      /must use the selected renderer pin/u,
    );
  }
});

test('native federation admission stays closed across every dependency group and alias target', () => {
  for (const renderer of ['solid', 'octane'] as const) {
    const generation = getRendererGenerationProfile(renderer);
    for (const group of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const admitted = {
        name: `@fixture/${renderer}`,
        [group]: {
          '@module-federation/enhanced': MODULE_FEDERATION_VERSION,
          '@module-federation/node': MODULE_FEDERATION_NODE_VERSION,
          '@module-federation/runtime':
            ULTRAMODERN_PACKAGE_PINS.appDependencies[
              '@module-federation/runtime'
            ],
        },
      };
      assert.doesNotThrow(() =>
        assertAuthoredRendererDependencyPins(admitted, generation),
      );
      assert.doesNotThrow(() => assertRendererDependencies(admitted, renderer));
      for (const [name, request, message] of [
        ['@module-federation/enhanced', '^2.9.2', /declared federation ABI/u],
        ['@module-federation/node', 'latest', /declared federation ABI/u],
        ['@module-federation/node', '2.7.51', /declared federation ABI/u],
        [
          '@module-federation/enhanced',
          `npm:@module-federation/node@${MODULE_FEDERATION_NODE_VERSION}`,
          /declared federation ABI/u,
        ],
        [
          'alternate-federation',
          `npm:@module-federation/enhanced@${MODULE_FEDERATION_VERSION}`,
          /declared federation ABI/u,
        ],
        [
          '@module-federation/bridge-react',
          MODULE_FEDERATION_VERSION,
          /unsupported .* capability/u,
        ],
        [
          'legacy-federation',
          `npm:@module-federation/modern-js-v3@${MODULE_FEDERATION_VERSION}`,
          /unsupported .* capability/u,
        ],
        [
          'legacy-federation',
          `npm:@bleedingdev/mf-bridge-react@${MODULE_FEDERATION_VERSION}`,
          /unsupported .* capability/u,
        ],
        [
          '@module-federation/runtime',
          MODULE_FEDERATION_VERSION,
          /declared federation ABI/u,
        ],
        [
          '@module-federation/runtime',
          `npm:@module-federation/runtime@${MODULE_FEDERATION_VERSION}`,
          /declared federation ABI/u,
        ],
        [
          '@module-federation/runtime',
          `npm:@module-federation/runtime@${ULTRAMODERN_PACKAGE_PINS.appDependencies['@module-federation/runtime']}`,
          /declared federation ABI/u,
        ],
      ] as const) {
        const manifest = {
          name: `@fixture/${renderer}`,
          [group]: { [name]: request },
        };
        assert.throws(
          () => assertAuthoredRendererDependencyPins(manifest, generation),
          message,
        );
        assert.throws(
          () => assertRendererDependencies(manifest, renderer),
          message,
        );
      }
      for (const [name, request] of [
        ['wrangler', '4.151.0'],
        ['worker-tools', 'npm:wrangler@4.151.0'],
      ]) {
        const manifest = {
          name: `@fixture/${renderer}`,
          [group]: { [name]: request },
        };
        const check = () =>
          assertAuthoredRendererDependencyPins(manifest, generation);
        const projectionCheck = () =>
          assertRendererDependencies(manifest, renderer);
        if (renderer === 'octane') {
          assert.doesNotThrow(check);
          assert.doesNotThrow(projectionCheck);
          const workerDisabled = {
            ...generation,
            capabilities: { ...generation.capabilities, workers: false },
          };
          assert.throws(
            () =>
              assertAuthoredRendererDependencyPins(manifest, workerDisabled),
            /unsupported octane capability/u,
          );
          assert.throws(
            () =>
              assertRendererDependencies(manifest, renderer, workerDisabled),
            /unsupported octane capability/u,
          );
        } else {
          assert.throws(check, /unsupported solid capability/u);
          assert.throws(projectionCheck, /unsupported solid capability/u);
        }
      }
      const gated = {
        ...generation,
        capabilities: { ...generation.capabilities, federation: false },
      };
      for (const [name, request] of [
        ['@module-federation/enhanced', MODULE_FEDERATION_VERSION],
        ['@module-federation/node', MODULE_FEDERATION_NODE_VERSION],
        [
          '@module-federation/runtime',
          ULTRAMODERN_PACKAGE_PINS.appDependencies[
            '@module-federation/runtime'
          ],
        ],
        ['@modern-js/federation-runtime', 'workspace:*'],
      ]) {
        const manifest = {
          name: 'unadmitted-federation',
          [group]: { [name]: request },
        };
        assert.throws(
          () => assertAuthoredRendererDependencyPins(manifest, gated),
          /unsupported .* capability/u,
        );
        assert.throws(
          () => assertRendererDependencies(manifest, renderer, gated),
          /unsupported .* capability/u,
        );
      }
    }
  }
});

test('native federation runtime requests authenticate the actual framework producer', () => {
  const name = '@modern-js/federation-runtime';
  const evidence = readRendererFrameworkPackageEvidence(name);
  assert.equal(evidence.kind, 'source-checkout');
  assert.ok(fs.existsSync(evidence.evidencePath));
  assert.throws(
    () => readRendererFrameworkPackageEvidence('@modern-js/renderer-core'),
    /Unsupported renderer framework ABI package/u,
  );
  for (const renderer of ['solid', 'octane'] as const) {
    const generation = getRendererGenerationProfile(renderer);
    for (const group of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const request of [
        'workspace:*',
        evidence.version,
        `npm:${evidence.targetName}@${evidence.version}`,
        'catalog:federation-runtime',
      ]) {
        const manifest = {
          name: '@fixture/authenticated-federation',
          [group]: { [name]: request },
        };
        const catalogs = {
          catalogs: { 'federation-runtime': { [name]: evidence.version } },
        };
        assert.doesNotThrow(() =>
          assertAuthoredRendererDependencyPins(manifest, generation, catalogs),
        );
        assert.doesNotThrow(() =>
          assertRendererDependencies(manifest, renderer, undefined, catalogs),
        );
      }
      for (const request of [
        `npm:@unverified/federation-runtime@${evidence.version}`,
        `^${evidence.version}`,
        generation.profile.hydration.version,
        'catalog:missing',
      ]) {
        const manifest = {
          name: '@fixture/unverified-federation',
          [group]: { [name]: request },
        };
        assert.throws(
          () => assertAuthoredRendererDependencyPins(manifest, generation),
          /authenticated producer package/u,
        );
        assert.throws(
          () => assertRendererDependencies(manifest, renderer),
          /authenticated producer package/u,
        );
      }
    }
  }
});

test('native source validation admits Worker commands by capability and rejects authored Worker and React artifacts', () => {
  for (const renderer of ['solid', 'octane'] as const) {
    const { root, app, manifest, write } = overlayFixture(renderer);
    const generation = getRendererGenerationProfile(renderer);
    const gated = {
      ...generation,
      capabilities: { ...generation.capabilities, federation: false },
    };
    try {
      // Authored native applications can keep their ordinary route files
      // without adding federation declarations.
      assert.doesNotThrow(() =>
        assertNativeRendererSourceSurface(root, app, generation, manifest),
      );
      for (const artifact of [
        'module-federation.config.ts',
        'module-federation.config.tsx',
        'module-federation.config.js',
        'module-federation.config.mjs',
        'module-federation.config.cjs',
        'module-federation.config.mts',
        'module-federation.config.cts',
        'src/federation-entry.ts',
        'src/federation-entry.tsx',
        'src/federation-entry.tsrx',
        'src/federation-entry.gtsx',
      ]) {
        write(`${app.path}/${artifact}`, 'export default {};');
        assert.doesNotThrow(() =>
          assertNativeRendererSourceSurface(root, app, generation, manifest),
        );
        assert.throws(
          () => assertNativeRendererSourceSurface(root, app, gated, manifest),
          /unsupported artifact/u,
        );
        fs.rmSync(path.join(root, app.path, artifact));
      }
      const federationScript = {
        ...manifest,
        scripts: { build: 'ultramodern build --module-federation' },
      };
      assert.doesNotThrow(() =>
        assertNativeRendererSourceSurface(
          root,
          app,
          generation,
          federationScript,
        ),
      );
      assert.throws(
        () =>
          assertNativeRendererSourceSurface(root, app, gated, federationScript),
        /scripts claim an unsupported capability/u,
      );
      for (const artifact of ['wrangler.toml', 'src/modern.runtime.ts']) {
        write(`${app.path}/${artifact}`, 'export default {};');
        assert.throws(
          () =>
            assertNativeRendererSourceSurface(root, app, generation, manifest),
          /unsupported artifact/u,
        );
        fs.rmSync(path.join(root, app.path, artifact));
      }
      const workerScripts = {
        ...manifest,
        scripts: { build: 'wrangler deploy' },
      };
      if (generation.capabilities.workers) {
        assertNativeRendererSourceSurface(root, app, generation, workerScripts);
      }
      assert.throws(
        () =>
          assertNativeRendererSourceSurface(
            root,
            app,
            {
              ...generation,
              capabilities: { ...generation.capabilities, workers: false },
            },
            workerScripts,
          ),
        /scripts claim an unsupported capability/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('authored native workspace federation validates discovery, exposes and renderer metadata without the React bridge', () => {
  for (const renderer of ['solid', 'octane'] as const) {
    const { root, app, manifest, write } = overlayFixture(renderer);
    const generation = getRendererGenerationProfile(renderer);
    const scope = 'native-validation';
    const remote = nativeProjection(renderer, 'catalog', 'verticals/catalog');
    const expose = './src/components/catalog-widget.tsx';
    const remoteExposes: Record<string, string> = { './Widget': expose };
    const projections = [app, remote];
    const apps = projections.map((projection, index) => {
      const kind: 'shell' | 'vertical' = index === 0 ? 'shell' : 'vertical';
      const packageName = `@fixture/${projection.id}`;
      const deliveryUnit = {
        ...projection.deliveryUnit,
        unitId: `${scope}/${projection.id}`,
        packageName,
      };
      return {
        ...projection,
        kind,
        package: packageName,
        deliveryUnit,
        moduleFederation: {
          role: index === 0 ? 'host' : 'remote',
          name: index === 0 ? 'shell' : 'verticalCatalog',
        },
        verticalRefs: index === 0 ? [remote.id] : [],
        ...(generation.capabilities.workers
          ? {
              cloudflare: createCloudflareDeployContract(scope, {
                ...shellApp,
                id: projection.id,
                kind,
                directory: projection.path,
              }),
            }
          : {}),
      };
    });
    const overlay = {
      schemaVersion: 1,
      ports: { [app.id]: 3020, [remote.id]: 4101 },
      manifests: { [remote.id]: 'http://localhost:4101/mf-manifest.json' },
    };
    const contract = {
      ...createWorkspaceValidationContract(scope, false, []),
      apps: apps.map((candidate, index) => ({
        id: candidate.id,
        kind: candidate.kind,
        path: candidate.path,
        packageName: candidate.package,
        emitsApi: false,
        emitsUi: true,
        renderer,
        rendererIdentity: candidate.rendererIdentity,
        rendererIdentities: candidate.rendererIdentities,
        rendererProfile: candidate.rendererProfile,
        routerBindings: candidate.routerBindings,
        validatesRendererProjection: true,
        rendererCapabilities: generation.capabilities,
        exposes: index === 0 ? {} : remoteExposes,
        verticalRefs: candidate.verticalRefs,
      })),
    };
    try {
      write('package.json', { name: scope });
      write(
        'pnpm-workspace.yaml',
        JSON.stringify({
          packages: ['apps/*', 'verticals/*'],
          overrides: ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides,
        }),
      );
      write('topology/reference-topology.json', {
        schemaVersion: 1,
        shell: apps[0],
        verticals: [apps[1]],
        sharedPackages: [],
      });
      write('topology/ownership.json', {
        schemaVersion: 1,
        owners: apps.map(candidate => ({
          id: candidate.id,
          path: candidate.path,
          package: candidate.package,
        })),
      });
      write('topology/local-overlays/development.json', overlay);
      for (const candidate of apps) {
        write(`${candidate.path}/package.json`, {
          ...manifest,
          name: candidate.package,
          modernjs: { appId: candidate.id },
        });
        write(`${candidate.path}/modern.config.ts`, 'export default {};');
        write(
          `${candidate.path}/module-federation.config.ts`,
          `export default ${JSON.stringify({
            name: candidate.moduleFederation.name,
            exposes: candidate.kind === 'vertical' ? remoteExposes : {},
            ...(candidate.kind === 'shell'
              ? {
                  remotes: {
                    catalog:
                      'verticalCatalog@http://localhost:4101/mf-manifest.json',
                  },
                }
              : {}),
          })};`,
        );
        write(`${candidate.path}/tsconfig.json`, {
          compilerOptions: {
            jsx: 'preserve',
            jsxImportSource: generation.jsxImportSource,
          },
        });
        for (const relative of ['layout.tsx', 'page.tsx', 'about/page.tsx'])
          write(
            `${candidate.path}/src/routes/${relative}`,
            'export default function Page() { return null; }',
          );
        // This fixture checks authored relationships only. Real MF emission,
        // Node containers and hydration are covered by the federation proofs.
        write(`${candidate.path}/shared/ultramodern-build.json`, {
          deliveryUnit: candidate.deliveryUnit,
          surfaces: {
            ui: {
              rendererProfile: candidate.rendererProfile,
              rendererIdentity: candidate.rendererIdentity,
              routerBindings: candidate.routerBindings,
            },
          },
        });
      }
      write(
        `${remote.path}/${expose.slice(2)}`,
        'export default function Widget() { return null; }',
      );
      linkInstalledCompiler(root);
      validateWorkspace(root, contract);
      if (renderer === 'octane') {
        for (const [index, candidate] of apps.entries()) {
          for (const [field, message] of [
            ['cloudflare', /cloudflare must be an object/u],
            ['workerName', /cloudflare.workerName is required/u],
            ['publicUrlEnv', /cloudflare.publicUrlEnv is required/u],
            ['routes', /cloudflare.routes must be an object/u],
            ['security', /cloudflare.security must be an object/u],
            ['qualityGates', /cloudflare.qualityGates must be an object/u],
            ...(index === 0
              ? [['ssr', /cloudflare SSR route is required/u] as const]
              : []),
          ] as const) {
            const malformed = JSON.parse(JSON.stringify(apps));
            if (field === 'cloudflare') delete malformed[index].cloudflare;
            else if (field === 'ssr')
              delete malformed[index].cloudflare.routes.ssr;
            else delete malformed[index].cloudflare[field];
            write('topology/reference-topology.json', {
              schemaVersion: 1,
              shell: malformed[0],
              verticals: [malformed[1]],
              sharedPackages: [],
            });
            assert.throws(
              () => validateWorkspace(root, contract),
              message,
              `${candidate.id} must reject missing ${field}`,
            );
          }
        }
        write('topology/reference-topology.json', {
          schemaVersion: 1,
          shell: apps[0],
          verticals: [apps[1]],
          sharedPackages: [],
        });
      } else {
        assert.ok(
          apps.every(candidate => !Object.hasOwn(candidate, 'cloudflare')),
        );
      }

      const configs = new Map(
        apps.map(candidate => [
          candidate.path,
          fs.readFileSync(
            path.join(root, candidate.path, 'module-federation.config.ts'),
            'utf8',
          ),
        ]),
      );
      fs.rmSync(path.join(root, app.path, 'module-federation.config.ts'));
      assert.throws(
        () => validateWorkspace(root, contract),
        /shell-super-app Module Federation config is missing/u,
      );
      write(`${app.path}/module-federation.config.ts`, configs.get(app.path)!);

      // Admission also leaves authored standalone native hosts and verticals
      // valid when neither declares federation endpoints or exposes.
      const standalone = apps.map(candidate => ({
        ...candidate,
        moduleFederation: undefined,
        verticalRefs: [],
      }));
      write('topology/reference-topology.json', {
        schemaVersion: 1,
        shell: standalone[0],
        verticals: [standalone[1]],
        sharedPackages: [],
      });
      write('topology/local-overlays/development.json', {
        ...overlay,
        manifests: {},
      });
      for (const candidate of apps)
        fs.rmSync(
          path.join(root, candidate.path, 'module-federation.config.ts'),
        );
      validateWorkspace(root, {
        ...contract,
        apps: contract.apps.map(candidate => ({
          ...candidate,
          exposes: {},
          verticalRefs: [],
        })),
      });
      write('topology/reference-topology.json', {
        schemaVersion: 1,
        shell: apps[0],
        verticals: [apps[1]],
        sharedPackages: [],
      });
      for (const candidate of apps)
        write(
          `${candidate.path}/module-federation.config.ts`,
          configs.get(candidate.path)!,
        );

      write('topology/local-overlays/development.json', {
        ...overlay,
        manifests: {},
      });
      assert.throws(
        () => validateWorkspace(root, contract),
        /has no development MF manifest URL/u,
      );
      write('topology/local-overlays/development.json', {
        ...overlay,
        manifests: { [remote.id]: 'http://localhost:4999/mf-manifest.json' },
      });
      assert.throws(
        () => validateWorkspace(root, contract),
        /must use the app development port/u,
      );
      write('topology/local-overlays/development.json', overlay);
      fs.rmSync(path.join(root, remote.path, expose));
      assert.throws(
        () => validateWorkspace(root, contract),
        /Module Federation expose source .* is missing/u,
      );
      write(
        `${remote.path}/${expose.slice(2)}`,
        'export default function Widget() { return null; }',
      );
      write(
        `${app.path}/module-federation.config.ts`,
        'export default { name: "native", bridge: { enableBridgeRouter: false } };',
      );
      assert.throws(
        () => validateWorkspace(root, contract),
        /forbidden option enableBridgeRouter/u,
      );
      write(
        `${app.path}/module-federation.config.ts`,
        'const enableBridgeRouter = false; export default { name: "native", bridge: { enableBridgeRouter } };',
      );
      assert.throws(
        () => validateWorkspace(root, contract),
        /forbidden option enableBridgeRouter/u,
      );
      write(`${app.path}/module-federation.config.ts`, configs.get(app.path)!);
      write(`${app.path}/shared/ultramodern-build.json`, {
        deliveryUnit: apps[0]!.deliveryUnit,
        surfaces: {
          ui: {
            rendererProfile: app.rendererProfile,
            rendererIdentity: {
              ...app.rendererIdentity,
              buildId: 'wrong-build',
            },
            routerBindings: app.routerBindings,
          },
        },
      });
      assert.throws(
        () => validateWorkspace(root, contract),
        /build renderer profile\/identity contradicts topology/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('React apps declare router and runtime installs within the framework compatible ranges', () => {
  const generation = getRendererGenerationProfile('react');
  const router = generation.dependencies['@tanstack/react-router'];
  const ranges = readReactFrameworkCompatibleRanges();
  // @modern-js/plugin-tanstack depends on one exact router; the app shares
  // that singleton anywhere on its patch line.
  assert.ok(ranges.get('@tanstack/react-router')?.includes('~1.170.0'));
  assert.ok(ranges.get('react')?.length);
  const generated = {
    name: '@fixture/react-generated',
    dependencies: { ...generation.dependencies },
    devDependencies: { ...generation.devDependencies },
  };
  assert.doesNotThrow(() =>
    assertAuthoredRendererDependencyPins(generated, generation),
  );
  // A downstream app that pins an earlier patch of the same router line and
  // a React patch within the framework peer range keeps validating.
  const downstream = {
    name: '@fixture/react-downstream',
    dependencies: {
      ...generation.dependencies,
      '@tanstack/react-router': '1.170.39',
      react: '19.3.1',
      'react-dom': 'catalog:react',
    },
    devDependencies: {
      '@types/react': '^19.3.0',
      '@types/react-dom': '^19.3.0',
    },
  };
  assert.notEqual(router, '1.170.39');
  assert.doesNotThrow(() =>
    assertAuthoredRendererDependencyPins(downstream, generation, {
      catalogs: { react: { 'react-dom': '19.3.1' } },
    }),
  );
  for (const [name, request, message] of [
    [
      '@tanstack/react-router',
      '1.171.0',
      /outside the React framework's compatible range ~1\.170\.0/u,
    ],
    ['@tanstack/react-router', '^1.170.39', /outside the React framework/u],
    ['react', '18.3.1', /outside the React framework's compatible range/u],
    ['react-dom', 'latest', /must be a version range of react-dom/u],
    ['react', 'npm:@fixture/react@19.3.0', /must be a version range of react/u],
  ] as const) {
    assert.throws(
      () =>
        assertAuthoredRendererDependencyPins(
          {
            ...downstream,
            dependencies: { ...downstream.dependencies, [name]: request },
          },
          generation,
          { catalogs: { react: { 'react-dom': '19.3.1' } } },
        ),
      message,
    );
  }
  assert.throws(
    () =>
      assertAuthoredRendererDependencyPins(
        { name: '@fixture/react', dependencies: { 'solid-js': '2.0.0' } },
        generation,
      ),
    /conflicts with the selected react renderer/u,
  );
});

test('maintained Octane distribution pins match the generated requests exactly', () => {
  const generation = getRendererGenerationProfile('octane');
  const manifest = {
    name: '@fixture/maintained-octane',
    dependencies: { ...generation.dependencies },
    devDependencies: { ...generation.devDependencies },
  };
  assert.doesNotThrow(() =>
    assertAuthoredRendererDependencyPins(manifest, generation),
  );
  for (const profile of [
    generation.profile.compiler,
    generation.profile.hydration,
    generation.profile.router,
    {
      name: generation.profile.router.coreName,
      version: generation.profile.router.coreVersion,
    },
  ]) {
    const request = generation.dependencies[profile.name];
    assert.equal(typeof request, 'string');
    assert.notEqual(request, profile.version);
    assert.doesNotThrow(() =>
      assertAuthoredRendererDependencyPins(
        {
          ...manifest,
          dependencies: {
            ...manifest.dependencies,
            [profile.name]: 'catalog:maintained-octane',
          },
        },
        generation,
        { catalogs: { 'maintained-octane': { [profile.name]: request } } },
      ),
    );
    for (const mismatch of [
      profile.version,
      `${request}?unreviewed=1`,
      `npm:${profile.name}@${request}`,
    ]) {
      assert.throws(
        () =>
          assertAuthoredRendererDependencyPins(
            {
              ...manifest,
              dependencies: {
                ...manifest.dependencies,
                [profile.name]: mismatch,
              },
            },
            generation,
          ),
        /declared renderer ABI .* disagrees with the selected pin/,
      );
    }
  }
  assert.equal(generation.profile.router.coreVersion, '1.171.38');
  assert.equal(
    generation.dependencies[generation.profile.router.coreName],
    'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz',
  );
});

test('framework router workspace requests require actual producer version evidence', () => {
  const generation = getRendererGenerationProfile('solid');
  const name = generation.profile.router.name;
  assert.equal(name, '@modern-js/renderer-solid');
  const evidence = readRendererFrameworkPackageEvidence(name);
  assert.equal(evidence.kind, 'source-checkout');
  assert.equal(evidence.version, generation.profile.router.version);
  assert.ok(fs.existsSync(evidence.evidencePath));
  const manifest = {
    name: '@fixture/framework-router',
    dependencies: { [name]: 'workspace:*' },
  };
  assert.doesNotThrow(() =>
    assertAuthoredRendererDependencyPins(manifest, generation),
  );
  assert.doesNotThrow(() =>
    assertAuthoredRendererDependencyPins(
      { ...manifest, dependencies: { [name]: 'catalog:ultramodern' } },
      generation,
      { catalogs: { ultramodern: { [name]: evidence.version } } },
    ),
  );
  assert.throws(
    () =>
      assertAuthoredRendererDependencyPins(manifest, {
        ...generation,
        profile: {
          ...generation.profile,
          router: { ...generation.profile.router, version: '0.0.0' },
        },
      }),
    /disagrees with producer cohort evidence/,
  );
  assert.throws(
    () =>
      assertAuthoredRendererDependencyPins(
        {
          ...manifest,
          dependencies: {
            [name]: `npm:@unverified/renderer-solid@${evidence.version}`,
          },
        },
        generation,
      ),
    /authenticated producer package/,
  );
  assert.throws(
    () =>
      assertAuthoredRendererDependencyPins(
        {
          ...manifest,
          devDependencies: {
            [generation.profile.compiler.name]: 'workspace:*',
          },
        },
        generation,
      ),
    /declared renderer ABI workspace:\* disagrees/,
  );
});

test('selected native overlay pins stay unchanged and neutral extensions pass', () => {
  for (const renderer of ['solid', 'octane'] as const) {
    const { root, app, manifest, write } = overlayFixture(renderer);
    try {
      const snapshot = captureOverlayBaselineSnapshot(root, [app.path]);
      manifest.dependencies['fixture-extension'] = '1.0.0';
      write(`${app.path}/package.json`, manifest);
      assert.doesNotThrow(() =>
        assertOverlayPreservedBaseline({
          workspaceRoot: root,
          generator: 'neutral',
          snapshot,
        }),
      );
      const runtimeName =
        getRendererGenerationProfile(renderer).profile.hydration.name;
      manifest.dependencies[runtimeName] = '0.0.0';
      write(`${app.path}/package.json`, manifest);
      assert.throws(
        () =>
          assertOverlayPreservedBaseline({
            workspaceRoot: root,
            generator: 'runtime-pin',
            snapshot,
          }),
        (error: unknown) =>
          error instanceof OverlayBaselineRelaxationError &&
          error.violations.some(
            violation =>
              violation.kind === 'baseline-version-relaxation' &&
              violation.detail.includes(runtimeName),
          ),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('native overlays reject foreign aliases, metadata drift and unsupported artifacts', () => {
  for (const mutation of [
    'alias',
    'metadata',
    'artifact',
    'workspace-policy',
    'root-alias',
  ] as const) {
    const { root, app, manifest, write } = overlayFixture('solid');
    try {
      const snapshot = captureOverlayBaselineSnapshot(root, [app.path]);
      if (mutation === 'alias') {
        manifest.dependencies['alternate-view'] = 'npm:react@19.3.0';
        write(`${app.path}/package.json`, manifest);
      } else if (mutation === 'metadata') {
        write('topology/reference-topology.json', {
          shell: {
            ...app,
            rendererCapabilities: {
              ...app.rendererCapabilities,
              workers: true,
            },
          },
          verticals: [],
        });
      } else if (mutation === 'artifact') {
        write(`${app.path}/wrangler.toml`, 'name = "unsupported-worker"');
      } else if (mutation === 'workspace-policy') {
        write('pnpm-workspace.yaml', 'overrides:\n  react: 19.3.0\n');
      } else {
        write('package.json', {
          name: '@fixture/workspace',
          dependencies: { legacy: 'npm:react@19.3.0' },
        });
      }
      assert.throws(
        () =>
          assertOverlayPreservedBaseline({
            workspaceRoot: root,
            generator: mutation,
            snapshot,
          }),
        (error: unknown) =>
          error instanceof OverlayBaselineRelaxationError &&
          error.violations.some(
            violation => violation.kind === 'renderer-profile-relaxation',
          ),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('headless overlays cannot introduce a native page source surface', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-headless-overlay-'));
  const appPath = 'verticals/headless';
  const write = (relative: string, value: unknown) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  try {
    write('package.json', { name: '@fixture/workspace' });
    write('topology/reference-topology.json', {
      verticals: [{ id: 'headless', path: appPath, renderer: 'none' }],
    });
    write(`${appPath}/package.json`, { name: '@fixture/headless' });
    write(`${appPath}/shared/ultramodern-build.json`, { surfaces: {} });
    const snapshot = captureOverlayBaselineSnapshot(root, []);
    assert.doesNotThrow(() =>
      assertOverlayPreservedBaseline({
        workspaceRoot: root,
        generator: 'neutral-headless',
        snapshot,
      }),
    );
    write(
      `${appPath}/src/routes/page.tsx`,
      'export default function Page() { return null; }',
    );
    assert.throws(
      () =>
        assertOverlayPreservedBaseline({
          workspaceRoot: root,
          generator: 'headless-page',
          snapshot,
        }),
      (error: unknown) =>
        error instanceof OverlayBaselineRelaxationError &&
        error.violations.some(
          violation =>
            violation.kind === 'renderer-profile-relaxation' &&
            violation.detail.includes('src/routes'),
        ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
