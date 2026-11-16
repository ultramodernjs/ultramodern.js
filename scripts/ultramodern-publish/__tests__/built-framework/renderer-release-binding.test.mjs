import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseIdentity } from '../../../ultramodern-production-readiness/browser-smoke/runtime-evidence.mjs';
import { digestCanonical } from '../../../ultramodern-production-readiness/canonical-digest.mjs';
import {
  assertReleaseEnvelopeRendererBinding,
  assertRendererReleaseArtifactBinding,
  releaseEnvelopePayload,
} from '../../lib/renderer-release-binding.mjs';

// The fixture installs the Module Federation Rspack producer, so its version
// must be the exact recipe the release gate verifies against.
const mfRspackRecipe = JSON.parse(
  fs.readFileSync(
    new URL('../../../ultramodern-supply/sidecars.json', import.meta.url),
    'utf8',
  ),
).find(recipe => recipe.id === 'mf-rspack');

function rendererUi(renderer = 'react', buildId = 'release-build') {
  return {
    rendererIdentity: {
      renderer,
      appId: 'inventory',
      entryName: 'main',
      protocolVersion: 1,
      buildId,
    },
    rendererProfile: {
      renderer,
      protocolVersion: 1,
      compiler: { name: `${renderer}-compiler`, version: '1.2.3' },
      hydration: { name: `${renderer}-hydration`, version: '1' },
      router: {
        name: `${renderer}-router`,
        version: '1.2.3',
        coreName: `${renderer}-router-core`,
        coreVersion: '1.2.3',
      },
    },
    routerBindings: {
      main: {
        owner: `${renderer}-router-owner`,
        evidence: 'file-routes',
        defaultProvider: {
          framework: renderer === 'react' ? 'tanstack' : renderer,
          name: `${renderer}-router`,
          version: '1.2.3',
          coreName: `${renderer}-router-core`,
          coreVersion: '1.2.3',
        },
        providers: [
          {
            framework: renderer === 'react' ? 'tanstack' : renderer,
            name: `${renderer}-router`,
            version: '1.2.3',
            coreName: `${renderer}-router-core`,
            coreVersion: '1.2.3',
          },
        ],
      },
    },
  };
}

function envelope({
  renderer = 'react',
  headless = false,
  buildMarker = 'release-build',
} = {}) {
  const value = {
    schemaVersion: 5,
    kind: 'ultramodern-target-microvertical-release-envelope',
    target: 'node',
    identity: {
      unitId: '@test/inventory',
      buildMarker,
      sourceRevision: 'a'.repeat(40),
      releaseVersion: '1.0.0',
    },
    ...(headless ? {} : { ui: rendererUi(renderer, buildMarker) }),
    artifacts: [],
    surfaces: {
      uiClient: headless ? [] : ['mf-manifest.json', 'static/main.js'],
      ssr: headless ? [] : ['index.js'],
      apiBackend: ['api/index.js'],
      backendFederation: {
        manifest: 'backend-mf-manifest.json',
        container: 'backendRemoteEntry.cjs',
      },
    },
  };
  value.envelopeDigest = digestCanonical(releaseEnvelopePayload(value));
  return value;
}

function buildArtifact(value) {
  const deliveryUnit = {
    schemaVersion: 1,
    appId: 'inventory',
    kind: 'microvertical-delivery-unit',
    packageName: '@test/inventory',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    unitId: value.identity.unitId,
    build: value.identity.buildMarker,
    buildMarker: value.identity.buildMarker,
    sourceRevision: value.identity.sourceRevision,
    version: value.identity.releaseVersion,
  };
  return {
    schemaVersion: 2,
    kind: 'ultramodern-build-artifact',
    deliveryUnit,
    surfaces: {
      api: { ...deliveryUnit, surface: 'api' },
      ...(value.ui
        ? {
            ui: {
              ...deliveryUnit,
              surface: 'ui',
              ...structuredClone(value.ui),
            },
          }
        : {}),
    },
  };
}

test('full router maps bind nonprimary entries and reject malformed or foreign provider evidence', () => {
  const value = envelope({ renderer: 'solid' });
  value.ui.routerBindings.csr = structuredClone(value.ui.routerBindings.main);
  value.ui.routerBindings.csr.owner = 'actual-csr-owner';
  const artifact = buildArtifact(value);
  assert.deepEqual(
    assertRendererReleaseArtifactBinding(value, artifact).routerBindings,
    value.ui.routerBindings,
  );
  const changed = structuredClone(artifact);
  changed.surfaces.ui.routerBindings.csr.owner = 'different-csr-owner';
  assert.throws(
    () => assertRendererReleaseArtifactBinding(value, changed),
    /must match/u,
  );
  for (const change of [
    ui => {
      delete ui.routerBindings;
    },
    ui => {
      ui.routerBindings = {};
    },
    ui => {
      ui.routerBindings.main.evidence = 'plugin-presence';
    },
    ui => {
      ui.routerBindings.main.defaultProvider.coreName = '';
    },
    ui => {
      ui.routerBindings.main.providers[0].framework = 'tanstack';
    },
    ui => {
      ui.routerBindings.main.providers.push(
        structuredClone(ui.routerBindings.main.providers[0]),
      );
    },
  ]) {
    const malformed = structuredClone(value);
    change(malformed.ui);
    assert.throws(
      () => assertReleaseEnvelopeRendererBinding(malformed),
      /routerBindings|exactly/u,
    );
  }
});

test('headless delivery and API surface cannot carry router binding evidence', () => {
  const value = envelope({ headless: true });
  const artifact = buildArtifact(value);
  for (const target of [artifact.deliveryUnit, artifact.surfaces.api]) {
    target.routerBindings = rendererUi().routerBindings;
    assert.throws(
      () => assertRendererReleaseArtifactBinding(value, artifact),
      /only allowed on the UI/u,
    );
    delete target.routerBindings;
  }
});

function seal(value) {
  value.envelopeDigest = digestCanonical(releaseEnvelopePayload(value));
  return value;
}

for (const renderer of ['react', 'solid', 'octane']) {
  test(`${renderer} release renderer identity and exact profile bind to immutable schema 2 evidence`, () => {
    const value = envelope({ renderer });
    assert.deepEqual(
      assertReleaseEnvelopeRendererBinding(value, {
        expectedAppId: 'inventory',
      }),
      value.ui,
    );
    assert.deepEqual(
      assertRendererReleaseArtifactBinding(value, buildArtifact(value)),
      value.ui,
    );
  });
}

test('the canonical release payload retains renderer evidence in its digest', () => {
  const value = envelope();
  const before = value.envelopeDigest;
  value.ui.rendererProfile.compiler.version = '2.0.0';
  assert.deepEqual(releaseEnvelopePayload(value).ui, value.ui);
  assert.notEqual(seal(value).envelopeDigest, before);
});

test('schema 3 has no compatibility reader or default renderer', () => {
  const value = envelope();
  value.schemaVersion = 3;
  delete value.ui;
  assert.throws(
    () => assertReleaseEnvelopeRendererBinding(seal(value)),
    /unsupported.*schema/u,
  );
});

test('release identity requires exact lowercase Git object IDs', () => {
  for (const sourceRevision of [
    'workspace',
    'revision-name',
    'A'.repeat(40),
    'a'.repeat(39),
    'a'.repeat(41),
  ]) {
    const value = envelope();
    value.identity.sourceRevision = sourceRevision;
    seal(value);
    assert.throws(
      () => assertReleaseEnvelopeRendererBinding(value),
      /exact lowercase Git object ID/u,
    );
  }
  const value = envelope();
  value.identity.sourceRevision = 'b'.repeat(64);
  assert.deepEqual(assertReleaseEnvelopeRendererBinding(seal(value)), value.ui);
});

test('headless releases omit renderer metadata and UI releases require it', () => {
  const headless = envelope({ headless: true });
  assert.equal(assertReleaseEnvelopeRendererBinding(headless), undefined);
  assert.equal(
    assertRendererReleaseArtifactBinding(headless, buildArtifact(headless)),
    undefined,
  );
  headless.ui = rendererUi();
  assert.throws(
    () => assertReleaseEnvelopeRendererBinding(seal(headless)),
    /forbidden/u,
  );
  const ui = envelope();
  delete ui.ui;
  assert.throws(
    () => assertReleaseEnvelopeRendererBinding(seal(ui)),
    /must be an object/u,
  );
});

test('renderer binding accepts current UI-only envelopes and rejects schema 4', () => {
  const value = envelope();
  value.surfaces.apiBackend = [];
  delete value.surfaces.backendFederation;
  seal(value);
  assert.deepEqual(assertReleaseEnvelopeRendererBinding(value), value.ui);
  assert.deepEqual(
    assertRendererReleaseArtifactBinding(value, buildArtifact(value)),
    value.ui,
  );
  const legacy = structuredClone(value);
  legacy.schemaVersion = 4;
  assert.throws(
    () => assertReleaseEnvelopeRendererBinding(seal(legacy)),
    /unsupported release envelope schema/u,
  );
});

test('renderer binding accepts native Shell envelopes and rejects invalid Shell producers and schemas', () => {
  for (const target of ['node', 'cloudflare']) {
    const value = envelope();
    value.kind = 'ultramodern-target-shell-release-envelope';
    value.target = target;
    delete value.surfaces.backendFederation;
    seal(value);
    assert.deepEqual(assertReleaseEnvelopeRendererBinding(value), value.ui);
    assert.deepEqual(
      assertRendererReleaseArtifactBinding(value, buildArtifact(value)),
      value.ui,
    );
    const producer = structuredClone(value);
    producer.surfaces.backendFederation = {
      manifest: 'backend-mf-manifest.json',
      container: 'backendRemoteEntry.cjs',
    };
    assert.throws(
      () => assertReleaseEnvelopeRendererBinding(seal(producer)),
      /Shell cannot declare a backend federation producer/u,
    );
    const headless = structuredClone(value);
    headless.surfaces.uiClient = [];
    headless.surfaces.ssr = [];
    delete headless.ui;
    assert.throws(
      () => assertReleaseEnvelopeRendererBinding(seal(headless)),
      /Shell must declare UI\/client and SSR surfaces/u,
    );
    for (const unsupported of [
      { schemaVersion: 4 },
      { kind: 'unknown-release-envelope' },
    ]) {
      assert.throws(
        () =>
          assertReleaseEnvelopeRendererBinding(
            seal({ ...value, ...unsupported }),
          ),
        /unsupported release envelope schema/u,
      );
    }
    value.surfaces.apiBackend = [];
    assert.deepEqual(
      assertReleaseEnvelopeRendererBinding(seal(value)),
      value.ui,
    );
  }
});

test('renderer release evidence rejects malformed fields before accepting a valid digest', () => {
  const cases = [
    [
      value => {
        value.ui.extra = true;
      },
      /exactly/u,
    ],
    [
      value => {
        value.ui.rendererIdentity.extra = true;
      },
      /exactly/u,
    ],
    [
      value => {
        value.ui.rendererProfile.compiler.extra = true;
      },
      /exactly/u,
    ],
    [
      value => {
        value.ui.rendererIdentity.renderer = 'legacy';
      },
      /react, solid, or octane/u,
    ],
    [
      value => {
        value.ui.rendererIdentity.protocolVersion = 2;
      },
      /protocolVersion/u,
    ],
    [
      value => {
        value.ui.rendererIdentity.buildId = 'other-build';
      },
      /buildId/u,
    ],
    [
      value => {
        value.ui.rendererIdentity.appId = ' inventory';
      },
      /trimmed/u,
    ],
    [
      value => {
        value.ui.rendererProfile.renderer = 'solid';
      },
      /match rendererIdentity/u,
    ],
    [
      value => {
        value.ui.rendererProfile.router.version = '^1.2.3';
      },
      /exact version/u,
    ],
    [
      value => {
        value.ui.rendererProfile.router.coreVersion = 'workspace:*';
      },
      /exact version/u,
    ],
    [
      value => {
        value.ui.rendererProfile.hydration.version = '0';
      },
      /exact version/u,
    ],
  ];
  for (const [mutate, message] of cases) {
    const value = envelope();
    mutate(value);
    seal(value);
    assert.throws(() => assertReleaseEnvelopeRendererBinding(value), message);
  }
});

test('a renderer profile cannot drift from the consuming profile', () => {
  const value = envelope();
  const expectedRendererProfile = structuredClone(value.ui.rendererProfile);
  value.ui.rendererProfile.router.coreVersion = '2.0.0';
  seal(value);
  assert.throws(
    () =>
      assertReleaseEnvelopeRendererBinding(value, { expectedRendererProfile }),
    /must match the release envelope/u,
  );
});

test('public renderer package identities retain exact SemVer metadata and mapped names', () => {
  const value = envelope({ renderer: 'octane' });
  value.ui.rendererProfile = {
    renderer: 'octane',
    protocolVersion: 1,
    compiler: { name: '@octanejs/rspack-plugin', version: '0.1.55' },
    hydration: { name: 'octane', version: '0.7.1+ultramodern.aab0f1410f79' },
    router: {
      name: '@octanejs/tanstack-router',
      version: '0.1.60+ultramodern.681ca11f6bff',
      coreName: '@tanstack/router-core',
      coreVersion: '1.171.15',
    },
  };
  const { router } = value.ui.rendererProfile;
  const provider = { framework: 'octane', ...router };
  value.ui.routerBindings.main = {
    owner: '@bleedingdev/modern-js-renderer-octane',
    evidence: 'file-routes',
    defaultProvider: provider,
    providers: [provider],
  };
  seal(value);
  const expectedRendererProfile = structuredClone(value.ui.rendererProfile);
  const artifact = buildArtifact(value);
  assert.deepEqual(
    assertRendererReleaseArtifactBinding(value, artifact).rendererProfile,
    expectedRendererProfile,
  );
  assert.deepEqual(
    assertReleaseEnvelopeRendererBinding(value, { expectedRendererProfile })
      .routerBindings,
    value.ui.routerBindings,
  );
  const changed = structuredClone(value);
  changed.ui.rendererProfile.hydration.version = '0.7.1+ultramodern.different';
  seal(changed);
  assert.notEqual(changed.envelopeDigest, value.envelopeDigest);
  assert.throws(
    () =>
      assertReleaseEnvelopeRendererBinding(changed, {
        expectedRendererProfile,
      }),
    /must match the release envelope/u,
  );
  const solid = envelope({ renderer: 'solid' });
  // Profile identities use the canonical source specifier; the published
  // package name is an install-transport fact and never a router identity.
  solid.ui.rendererProfile.router.name = '@modern-js/renderer-solid';
  const canonicalProfile = structuredClone(solid.ui.rendererProfile);
  assert.deepEqual(
    assertReleaseEnvelopeRendererBinding(solid, {
      expectedRendererProfile: canonicalProfile,
    }).rendererProfile,
    canonicalProfile,
  );
  solid.ui.rendererProfile.router.name =
    '@bleedingdev/modern-js-renderer-solid';
  assert.throws(
    () =>
      assertReleaseEnvelopeRendererBinding(solid, {
        expectedRendererProfile: canonicalProfile,
      }),
    /must match the release envelope/u,
  );
});

test('renderer package tuples reject partial, ranged, URL, and malformed SemVer versions', () => {
  for (const version of [
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3+',
    '1.2.3+build..id',
    '^1.2.3',
    'npm:octane@0.7.1',
    'https://example.test/octane.tgz',
  ]) {
    const value = envelope();
    value.ui.rendererProfile.compiler.version = version;
    seal(value);
    assert.throws(
      () => assertReleaseEnvelopeRendererBinding(value),
      /exact version/u,
    );
  }
  for (const version of ['0.0.0', '2.0.0-rc.15', '1.2.3-alpha.0+build.001']) {
    const value = envelope();
    value.ui.rendererProfile.compiler.version = version;
    assert.equal(
      assertReleaseEnvelopeRendererBinding(value).rendererProfile.compiler
        .version,
      version,
    );
  }
});

test('immutable renderer evidence cannot substitute another app, entry, build, or profile', () => {
  const value = envelope();
  for (const mutate of [
    artifact => {
      artifact.surfaces.ui.rendererIdentity.appId = 'checkout';
    },
    artifact => {
      artifact.surfaces.ui.rendererIdentity.entryName = 'checkout';
    },
    artifact => {
      artifact.surfaces.ui.rendererIdentity.buildId = 'other-build';
    },
    artifact => {
      artifact.surfaces.ui.rendererProfile.compiler.version = '2.0.0';
    },
    artifact => {
      artifact.surfaces.ui.rendererProfile.hydration.version = '2';
    },
    artifact => {
      artifact.surfaces.ui.rendererProfile.router.coreVersion = '2.0.0';
    },
  ]) {
    const artifact = buildArtifact(value);
    mutate(artifact);
    assert.throws(
      () => assertRendererReleaseArtifactBinding(value, artifact),
      /must match|primary/u,
    );
  }
});

test('headless artifacts and API markers cannot advertise a renderer', () => {
  const value = envelope({ headless: true });
  const artifact = buildArtifact(value);
  artifact.surfaces.api.rendererIdentity = rendererUi().rendererIdentity;
  assert.throws(
    () => assertRendererReleaseArtifactBinding(value, artifact),
    /only allowed on the UI surface/u,
  );
  delete artifact.surfaces.api.rendererIdentity;
  artifact.surfaces.ui = buildArtifact(envelope()).surfaces.ui;
  assert.throws(
    () => assertRendererReleaseArtifactBinding(value, artifact),
    /exactly api/u,
  );
});

test('immutable delivery records use the supported schema and matching surface metadata', () => {
  const value = envelope();
  for (const [mutate, message] of [
    [
      artifact => {
        artifact.deliveryUnit.schemaVersion = 0;
      },
      /schemaVersion/u,
    ],
    [
      artifact => {
        artifact.deliveryUnit.kind = 'vertical';
      },
      /kind/u,
    ],
    [
      artifact => {
        artifact.deliveryUnit.deployProfile = 'node';
      },
      /deployProfile/u,
    ],
    [
      artifact => {
        artifact.deliveryUnit.appId = '';
      },
      /appId/u,
    ],
    [
      artifact => {
        artifact.deliveryUnit.packageName = '';
      },
      /packageName/u,
    ],
    [
      artifact => {
        artifact.surfaces.api.packageName = '@test/other';
      },
      /packageName/u,
    ],
    [
      artifact => {
        artifact.surfaces.api.schemaVersion = 0;
      },
      /schemaVersion/u,
    ],
    [
      artifact => {
        artifact.surfaces.ui.kind = 'vertical';
      },
      /kind/u,
    ],
    [
      artifact => {
        artifact.surfaces.ui.deployProfile = 'node';
      },
      /deployProfile/u,
    ],
    [
      artifact => {
        artifact.surfaces.api.appId = 'checkout';
      },
      /appId/u,
    ],
  ]) {
    const artifact = buildArtifact(value);
    mutate(artifact);
    assert.throws(
      () => assertRendererReleaseArtifactBinding(value, artifact),
      message,
    );
  }
  const artifact = buildArtifact(value);
  artifact.deliveryUnit.business = { domain: 'inventory' };
  artifact.surfaces.ui.business = { domain: 'inventory' };
  assert.deepEqual(
    assertRendererReleaseArtifactBinding(value, artifact),
    value.ui,
  );
});

function writeFinalizedRuntimeAuthority(projectDir, app, renderer) {
  const appRoot = path.join(projectDir, app.path);
  const dependency = path.join(
    appRoot,
    'node_modules/@modern-js/ultramodern-app-tools',
  );
  fs.mkdirSync(path.dirname(dependency), { recursive: true });
  fs.symlinkSync(
    fileURLToPath(
      new URL(
        '../../../../packages/solutions/ultramodern-app-tools/',
        import.meta.url,
      ),
    ),
    dependency,
    'dir',
  );
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const sdkEntry = appRequire.resolve('@modern-js/ultramodern-app-tools');
  const ownerRequire = createRequire(sdkEntry);
  const sdk = ownerRequire(sdkEntry);
  const contracts = ownerRequire('@modern-js/backend-federation-contracts');
  const record = {
    appId: app.id,
    deployProfile: contracts.DELIVERY_UNIT_DEPLOY_PROFILE,
    kind: contracts.DELIVERY_UNIT_KIND,
    schemaVersion: contracts.DELIVERY_UNIT_SCHEMA_VERSION,
    packageName: '@test/inventory',
    unitId: app.deliveryUnit.unitId,
    sourceRevision: 'workspace',
    version: app.deliveryUnit.version,
    buildMarker: app.deliveryUnit.buildMarker,
  };
  const sourceRevision = 'a'.repeat(40);
  let source;
  let finalized;
  let manifest;
  let ui;
  if (app.surfaceProfile === 'api-only') {
    source = contracts.createUltramodernBuildArtifact(record);
    const { createUltramodernReleaseBuildMarker } = ownerRequire(
      '@modern-js/app-tools-extensions/release-identity',
    );
    finalized = contracts.stampUltramodernBuildArtifactIdentity(source, {
      buildMarker: createUltramodernReleaseBuildMarker({
        generationBuildMarker: record.buildMarker,
        sourceRevision,
        unitId: record.unitId,
      }),
      sourceRevision,
    });
  } else {
    const profile = sdk.resolveRendererProfile(renderer);
    const { protocolVersion, compiler, hydration, router } = profile;
    const buildMarker = 'f'.repeat(64);
    const provider = {
      framework: renderer === 'react' ? 'react-router' : renderer,
      ...router,
    };
    const routerBindings = {
      main: {
        owner: `@fixture/${renderer}-router-owner`,
        evidence: 'owned-default',
        defaultProvider: provider,
        providers: [provider],
      },
    };
    const rendererIdentity = {
      renderer,
      protocolVersion,
      appId: app.id,
      entryName: 'main',
      buildId: buildMarker,
    };
    const rendererProfile = {
      renderer,
      protocolVersion,
      compiler,
      hydration,
      router,
    };
    ui = { rendererIdentity, rendererProfile, routerBindings };
    source = contracts.createUltramodernBuildArtifact(record, {
      ui: {
        identity: { ...rendererIdentity, buildId: record.buildMarker },
        profile: rendererProfile,
        routerBindings,
      },
    });
    // A public-validator fixture; this unit test does not run a compiler.
    manifest = sdk.validateRendererBuildManifest(
      {
        schema: 'ultramodern-renderer-build',
        version: 2,
        renderer: profile.renderer,
        profile,
        routerBindings,
        buildId: buildMarker,
        sourceRevision,
        entries: { main: rendererIdentity },
      },
      profile,
    );
    const { stampFinalizedRendererBuildArtifact } = ownerRequire(
      '@modern-js/app-tools-extensions/release-envelope/renderer-output-stamp',
    );
    finalized = stampFinalizedRendererBuildArtifact(
      source,
      { buildMarker, sourceRevision, ui },
      {
        appDirectory: appRoot,
        distDirectory: path.join(appRoot, '.output'),
        entrypoints: [{ entryName: 'main', isMainEntry: true }],
      },
    );
  }
  fs.mkdirSync(path.join(appRoot, 'shared'), { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, 'shared/ultramodern-build.json'),
    JSON.stringify(source),
  );
  if (manifest)
    fs.writeFileSync(
      path.join(appRoot, '.output/renderer-build.json'),
      JSON.stringify(manifest),
    );
  return { finalized, ui };
}

function runtimeFixture(
  t,
  {
    headless = false,
    renderer = 'react',
    publicCarrier = false,
    finalized = false,
  } = {},
) {
  const projectDir = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'renderer-release-'),
  );
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const app = {
    id: 'inventory',
    kind: 'vertical',
    path: 'apps/inventory',
    ...(headless ? { surfaceProfile: 'api-only' } : {}),
    deliveryUnit: {
      unitId: '@test/inventory',
      buildMarker: 'generation-build',
      version: '1.0.0',
    },
  };
  const buildMarker = crypto
    .createHash('sha256')
    .update(
      `ultramodern-delivery-unit-release-build-marker:v1:${app.deliveryUnit.unitId}:generation-build:${'a'.repeat(40)}`,
    )
    .digest('hex')
    .slice(0, 16);
  let value = envelope({ headless, renderer, buildMarker });
  const outputRoot = path.join(projectDir, app.path, '.output');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, app.path, 'package.json'),
    JSON.stringify({
      ...(finalized ? { name: '@test/inventory' } : {}),
      version: '1.0.0',
      dependencies: { '@module-federation/runtime': '2.4.0' },
    }),
  );
  if (!headless) {
    const pluginRoot = path.join(
      projectDir,
      app.path,
      'node_modules/@module-federation/modern-js-v3',
    );
    const producerRoot = path.join(
      pluginRoot,
      'node_modules/@module-federation/enhanced',
    );
    fs.mkdirSync(producerRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: '@module-federation/modern-js-v3',
        main: './index.js',
      }),
    );
    fs.writeFileSync(path.join(pluginRoot, 'index.js'), '');
    fs.writeFileSync(
      path.join(producerRoot, 'package.json'),
      JSON.stringify({
        name: '@module-federation/enhanced',
        version: '2.4.0',
        exports: { './rspack': './rspack.js' },
      }),
    );
    fs.writeFileSync(path.join(producerRoot, 'rspack.js'), '');
    const rspackRoot = path.join(
      producerRoot,
      'node_modules/@module-federation/rspack',
    );
    fs.mkdirSync(rspackRoot, { recursive: true });
    fs.writeFileSync(
      path.join(rspackRoot, 'package.json'),
      JSON.stringify({
        name: '@module-federation/rspack',
        version: mfRspackRecipe.upstream.version,
        exports: { './plugin': './plugin.js' },
      }),
    );
    fs.writeFileSync(path.join(rspackRoot, 'plugin.js'), '');
  }
  const authority = finalized
    ? writeFinalizedRuntimeAuthority(projectDir, app, renderer)
    : undefined;
  if (authority) {
    value = envelope({
      headless,
      renderer,
      buildMarker: authority.finalized.deliveryUnit.buildMarker,
    });
    if (authority.ui) value.ui = authority.ui;
  }
  const carrier = publicCarrier
    ? 'public/ultramodern-build.json'
    : 'ultramodern-build.json';
  const files = {
    'api/index.js': ['nodejs', 'export const api = true;'],
    'backend-mf-manifest.json': ['module-federation-manifest', '{}'],
    'backendRemoteEntry.cjs': ['nodejs', 'exports.backend = true;'],
    [carrier]: [
      'release-identity-metadata',
      JSON.stringify(authority?.finalized ?? buildArtifact(value)),
    ],
    ...(headless
      ? {}
      : {
          'index.js': ['nodejs', 'export const ssr = true;'],
          'mf-manifest.json': [
            'browser',
            JSON.stringify({ pluginVersion: mfRspackRecipe.upstream.version }),
          ],
          'static/main.js': ['browser', 'export const client = true;'],
        }),
  };
  for (const [logicalPath, [, bytes]] of Object.entries(files)) {
    const absolute = path.join(outputRoot, logicalPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }
  function reseal() {
    value.artifacts = Object.entries(files)
      .map(([logicalPath, [runtime]]) => {
        const bytes = fs.readFileSync(path.join(outputRoot, logicalPath));
        return {
          kind: 'file',
          logicalPath,
          runtime,
          byteLength: bytes.byteLength,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        };
      })
      .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
    seal(value);
    fs.mkdirSync(path.join(outputRoot, 'release'), { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'release/microvertical-release-envelope.json'),
      JSON.stringify(value),
    );
  }
  reseal();
  return { app, carrier, outputRoot, projectDir, reseal, value };
}

test('the executed artifact reader accepts each renderer and exposes schema 5 renderer evidence', t => {
  for (const renderer of ['react', 'solid', 'octane']) {
    const fixture = runtimeFixture(t, {
      renderer,
      publicCarrier: renderer === 'solid',
      finalized: true,
    });
    const evidence = releaseIdentity(fixture.projectDir, fixture.app, 'node');
    assert.equal(evidence.schemaVersion, 5);
    assert.deepEqual(evidence.ui, fixture.value.ui);
  }
});

test('the executed artifact reader accepts a native full-stack Shell without a federation producer', t => {
  const fixture = runtimeFixture(t, { finalized: true });
  fixture.app.kind = 'shell';
  fixture.value.kind = 'ultramodern-target-shell-release-envelope';
  delete fixture.value.surfaces.backendFederation;
  fixture.reseal();
  const evidence = releaseIdentity(fixture.projectDir, fixture.app, 'node');
  assert.equal(evidence.schemaVersion, 5);
  assert.deepEqual(evidence.ui, fixture.value.ui);
  assert.ok(evidence.surfaces.api);
});

test('the executed artifact reader accepts a headless schema 5 release without renderer evidence', t => {
  const fixture = runtimeFixture(t, { headless: true, finalized: true });
  const evidence = releaseIdentity(fixture.projectDir, fixture.app, 'node');
  assert.equal(evidence.schemaVersion, 5);
  assert.equal(Object.hasOwn(evidence, 'ui'), false);
});

test('valid envelope and artifact digests cannot hide a different immutable renderer profile', t => {
  const fixture = runtimeFixture(t, { publicCarrier: true });
  const artifactPath = path.join(fixture.outputRoot, fixture.carrier);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  artifact.surfaces.ui.rendererProfile.router.coreVersion = '2.0.0';
  fs.writeFileSync(artifactPath, JSON.stringify(artifact));
  fixture.reseal();
  assert.throws(
    () => releaseIdentity(fixture.projectDir, fixture.app, 'node'),
    /renderer evidence must match/u,
  );
});

test('the executed artifact reader rejects a schema 3 envelope even after resealing its digest', t => {
  const fixture = runtimeFixture(t);
  fixture.value.schemaVersion = 3;
  delete fixture.value.ui;
  fixture.reseal();
  assert.throws(
    () => releaseIdentity(fixture.projectDir, fixture.app, 'node'),
    /unsupported.*schema/u,
  );
});

test('the executed artifact reader requires an immutable renderer carrier', t => {
  const fixture = runtimeFixture(t);
  fixture.value.artifacts = fixture.value.artifacts.filter(
    artifact => artifact.logicalPath !== fixture.carrier,
  );
  seal(fixture.value);
  fs.writeFileSync(
    path.join(
      fixture.outputRoot,
      'release/microvertical-release-envelope.json',
    ),
    JSON.stringify(fixture.value),
  );
  assert.throws(
    () => releaseIdentity(fixture.projectDir, fixture.app, 'node'),
    /must bind an immutable build artifact/u,
  );
});

test('the executed artifact reader rejects a malformed source revision with a valid envelope digest', t => {
  const fixture = runtimeFixture(t);
  fixture.value.identity.sourceRevision = 'non-promotable-revision';
  fixture.reseal();
  assert.throws(
    () => releaseIdentity(fixture.projectDir, fixture.app, 'node'),
    /exact lowercase Git object ID/u,
  );
});
