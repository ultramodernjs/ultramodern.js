const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sidecarRecipes = require('../../../ultramodern-supply/sidecars.json');
const manifestProducerRecipe = sidecarRecipes.find(
  recipe => recipe.id === 'mf-rspack',
);
const runtimeRecipe = sidecarRecipes.find(recipe => recipe.id === 'mf-runtime');
const generatorRequire = createRequire(
  path.resolve(
    __dirname,
    '../../../../packages/toolkit/ultramodern-create/package.json',
  ),
);
const {
  createUltramodernBuildArtifact,
  DELIVERY_UNIT_DEPLOY_PROFILE,
  DELIVERY_UNIT_KIND,
  DELIVERY_UNIT_SCHEMA_VERSION,
  deliveryUnitContractBlock,
  stampUltramodernBuildArtifactIdentity,
} = generatorRequire('@modern-js/backend-federation-contracts');

async function loadSmoke() {
  return import('../../run-browser-smoke.mjs');
}

async function loadAcceptanceAssertions() {
  return import('../../published-create-proof/acceptance-assertions.mjs');
}

function tempRoot() {
  return fs.realpathSync(
    fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        'ultramodern-browser-smoke-',
      ),
    ),
  );
}

function deliveryRecord(appId, version, buildMarker) {
  return {
    appId,
    deployProfile: DELIVERY_UNIT_DEPLOY_PROFILE,
    kind: DELIVERY_UNIT_KIND,
    schemaVersion: DELIVERY_UNIT_SCHEMA_VERSION,
    packageName: `@fixture/${appId}`,
    unitId: `@fixture/root/${appId}`,
    sourceRevision: 'workspace',
    version,
    buildMarker,
  };
}

function stampedBlock(appId, version, buildMarker) {
  return deliveryUnitContractBlock(deliveryRecord(appId, version, buildMarker));
}

function writeJson(root, relative, value) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value));
}

function writeBuiltApp(root, app, sourceRevision, buildMarker) {
  const appRoot = path.join(root, app.path);
  const sdkDirectory = path.resolve(
    __dirname,
    '../../../../packages/solutions/ultramodern-app-tools',
  );
  const dependency = path.join(
    appRoot,
    'node_modules/@modern-js/ultramodern-app-tools',
  );
  fs.mkdirSync(path.dirname(dependency), { recursive: true });
  if (!fs.existsSync(dependency))
    fs.symlinkSync(sdkDirectory, dependency, 'dir');
  const sdkEntry = createRequire(path.join(appRoot, 'package.json')).resolve(
    '@modern-js/ultramodern-app-tools',
  );
  const ownerRequire = createRequire(sdkEntry);
  const sdk = ownerRequire(sdkEntry);
  const record = deliveryRecord(
    app.id,
    app.deliveryUnit.version,
    app.deliveryUnit.buildMarker,
  );
  if (app.surfaceProfile === 'api-only') {
    const source = createUltramodernBuildArtifact(record);
    const { createUltramodernReleaseBuildMarker } = ownerRequire(
      '@modern-js/app-tools-extensions/release-identity',
    );
    const finalized = stampUltramodernBuildArtifactIdentity(source, {
      buildMarker: createUltramodernReleaseBuildMarker({
        generationBuildMarker: record.buildMarker,
        sourceRevision,
        unitId: record.unitId,
      }),
      sourceRevision,
    });
    writeJson(appRoot, 'shared/ultramodern-build.json', source);
    writeJson(appRoot, '.output/ultramodern-build.json', finalized);
    return { appRoot, source, finalized, ownerRequire };
  }
  const profile = sdk.resolveRendererProfile(app.renderer);
  const { renderer, protocolVersion, compiler, hydration, router } = profile;
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
  const source = createUltramodernBuildArtifact(record, {
    ui: {
      identity: { ...rendererIdentity, buildId: record.buildMarker },
      profile: rendererProfile,
      routerBindings,
    },
  });
  // Finalized manifest fixture, not a claim that this unit test ran a compiler.
  const manifest = sdk.validateRendererBuildManifest(
    {
      schema: 'ultramodern-renderer-build',
      version: 2,
      renderer,
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
  const finalized = stampFinalizedRendererBuildArtifact(
    source,
    {
      buildMarker,
      sourceRevision,
      ui: { rendererIdentity, rendererProfile, routerBindings },
    },
    {
      appDirectory: appRoot,
      distDirectory: path.join(appRoot, '.output'),
      entrypoints: [{ entryName: 'main', isMainEntry: true }],
    },
  );
  writeJson(appRoot, 'shared/ultramodern-build.json', source);
  writeJson(appRoot, '.output/renderer-build.json', manifest);
  if (app.kind !== 'shell')
    writeJson(appRoot, '.output/ultramodern-build.json', finalized);
  return { appRoot, source, finalized, manifest, ownerRequire };
}

function writeStampedShell(root, renderer, version, buildMarker) {
  const topology = {
    shell: {
      id: 'shell',
      kind: 'shell',
      path: 'apps/shell',
      package: '@fixture/shell',
      renderer,
      deliveryUnit: stampedBlock('shell', version, buildMarker),
    },
    verticals: [],
  };
  for (const [relative, value] of [
    ['package.json', { name: '@fixture/root' }],
    [
      'apps/shell/package.json',
      {
        name: '@fixture/shell',
        version,
        devDependencies: { '@modern-js/ultramodern-app-tools': 'workspace:*' },
      },
    ],
    ['topology/reference-topology.json', topology],
    ['topology/local-overlays/development.json', { ports: { shell: 4100 } }],
  ]) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(value));
  }
  return topology;
}

for (const [renderer, stamps] of [
  ['react', ['d4fd0d4b2cf41285', '3147bf6cfd2d1e34']],
  ['solid', ['0aafabca82637866', '81cf44c0986972c5']],
  ['octane', ['e100cf585da1e1ac', 'fbc7c05363280d9e']],
]) {
  test(`browser smoke retains stamped ${renderer} identity across source and release versions`, async t => {
    const { readSmokeContract } = await import(
      '../../browser-smoke/contract.mjs'
    );
    const { bindContractToExpectedReleaseIdentities } = await import(
      '../../browser-smoke/runtime-evidence.mjs'
    );
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [index, version] of ['0.2.0', '1.4.0'].entries()) {
      const sourceRevision = (index === 0 ? 'a' : 'b').repeat(40);
      // This adapter consumes stamps; renderer/version hashing belongs to the
      // generator and must not be reconstructed by the smoke tool.
      const stamp = stamps[index];
      const topology = writeStampedShell(root, renderer, version, stamp);
      const compiledMarker = (index === 0 ? 'f' : '1').repeat(64);
      const { finalized } = writeBuiltApp(
        root,
        topology.shell,
        sourceRevision,
        compiledMarker,
      );
      const { contract } = readSmokeContract(root);
      assert.equal(
        Object.hasOwn(contract.apps[0].deliveryUnit, 'appId'),
        false,
      );
      assert.equal(contract.apps[0].marker.appId, 'shell');
      assert.equal(contract.apps[0].marker.build, stamp);
      assert.equal(contract.apps[0].deliveryUnit.buildMarker, stamp);
      assert.equal(contract.apps[0].deliveryUnit.version, version);
      const released = bindContractToExpectedReleaseIdentities({
        contract,
        expectedSourceRevisions: { shell: sourceRevision },
        platform: 'node',
        projectDir: root,
      });
      assert.equal(released.apps[0].deliveryUnit.buildMarker, stamp);
      assert.equal(released.apps[0].marker.releaseVersion, version);
      assert.equal(released.apps[0].marker.sourceRevision, sourceRevision);
      assert.equal(
        released.apps[0].marker.build,
        finalized.deliveryUnit.buildMarker,
      );
      assert.equal(released.apps[0].marker.build, compiledMarker);
      assert.notEqual(released.apps[0].marker.build, stamp);
      assert.equal(contract.apps[0].marker.build, stamp);
      assert.throws(
        () =>
          bindContractToExpectedReleaseIdentities({
            contract: {
              ...contract,
              apps: [
                { ...contract.apps[0], marker: { build: 'stale-marker' } },
              ],
            },
            expectedSourceRevisions: { shell: sourceRevision },
            platform: 'node',
            projectDir: root,
          }),
        /generated smoke marker differs from its delivery-unit build marker/u,
      );
    }
  });
}

for (const [label, change, expected] of [
  [
    'foreign source revision',
    built => {
      built.manifest.sourceRevision = 'b'.repeat(40);
    },
    /finalized renderer provenance conflicts/u,
  ],
  [
    'foreign installed profile',
    built => {
      built.manifest.profile.compiler.version = '999.0.0';
    },
    /different react renderer profile/u,
  ],
  [
    'foreign router ownership',
    built => {
      built.manifest.routerBindings.main.owner = '@foreign/router-owner';
    },
    /captured application profile or router bindings/u,
  ],
  [
    'foreign primary entry',
    built => {
      built.manifest.entries = {
        other: { ...built.manifest.entries.main, entryName: 'other' },
      };
      built.manifest.routerBindings = {
        other: built.manifest.routerBindings.main,
      };
    },
    /no configured primary entry/u,
  ],
  [
    'foreign app identity',
    built => {
      built.manifest.entries.main.appId = 'another-app';
    },
    /finalized renderer provenance conflicts/u,
  ],
  [
    'extra entry',
    built => {
      built.manifest.entries.other = {
        ...built.manifest.entries.main,
        entryName: 'other',
      };
      built.manifest.routerBindings.other = structuredClone(
        built.manifest.routerBindings.main,
      );
    },
    /captured application profile or router bindings/u,
  ],
]) {
  test(`browser smoke rejects finalized shell ${label}`, async t => {
    const { readSmokeContract } = await import(
      '../../browser-smoke/contract.mjs'
    );
    const { bindContractToExpectedReleaseIdentities } = await import(
      '../../browser-smoke/runtime-evidence.mjs'
    );
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const topology = writeStampedShell(
      root,
      'react',
      '0.2.0',
      'shell-generation',
    );
    const built = writeBuiltApp(
      root,
      topology.shell,
      'a'.repeat(40),
      'f'.repeat(64),
    );
    built.manifest = structuredClone(built.manifest);
    change(built);
    writeJson(built.appRoot, '.output/renderer-build.json', built.manifest);
    assert.throws(
      () =>
        bindContractToExpectedReleaseIdentities({
          contract: readSmokeContract(root).contract,
          expectedSourceRevisions: { shell: 'a'.repeat(40) },
          platform: 'node',
          projectDir: root,
        }),
      expected,
    );
  });
}

test('browser smoke compares executed shell SSR with its coherent finalized compiler marker', async t => {
  const { readSmokeContract } = await import(
    '../../browser-smoke/contract.mjs'
  );
  const { bindContractToExpectedReleaseIdentities } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const { validateHttpTarget } = await import(
    '../../browser-smoke/http-validate.mjs'
  );
  const { createSmokeTargets } = await loadSmoke();
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const topology = writeStampedShell(
    root,
    'react',
    '0.2.0',
    'shell-generation',
  );
  const built = writeBuiltApp(
    root,
    topology.shell,
    'a'.repeat(40),
    'f'.repeat(64),
  );
  assert.equal(
    fs.existsSync(path.join(built.appRoot, '.output/ultramodern-build.json')),
    false,
  );
  const manifest = structuredClone(built.manifest);
  manifest.buildId = '0'.repeat(64);
  manifest.entries.main.buildId = manifest.buildId;
  writeJson(built.appRoot, '.output/renderer-build.json', manifest);
  const contract = bindContractToExpectedReleaseIdentities({
    contract: readSmokeContract(root).contract,
    expectedSourceRevisions: { shell: 'a'.repeat(40) },
    platform: 'node',
    projectDir: root,
  });
  assert.equal(contract.apps[0].marker.build, manifest.buildId);
  const [target] = createSmokeTargets(contract).targets;
  await assert.rejects(
    () =>
      validateHttpTarget(target, {
        fetchImpl: async () =>
          response(200, html({ marker: built.manifest.buildId })),
      }),
    /shell SSR UI marker mismatch/u,
  );
});

async function writeVerticalRelease(
  root,
  {
    apiOnly = false,
    uiOnly = false,
    marker,
    sourceRevision = 'a'.repeat(40),
    platform = 'node',
    pluginVersion = manifestProducerRecipe.upstream.version,
    runtimeVersion = runtimeRecipe.fork.version,
  } = {},
) {
  const app = {
    id: 'inventory',
    kind: uiOnly ? 'shell' : 'vertical',
    path: 'verticals/inventory',
    renderer: 'react',
    ...(apiOnly ? { surfaceProfile: 'api-only' } : {}),
    ...(uiOnly ? { surfaceProfile: 'ui-only' } : {}),
    deliveryUnit: stampedBlock('inventory', '0.3.0', 'inventory-generation'),
    marker: { appId: 'inventory', build: 'inventory-generation' },
  };
  writeJson(root, 'package.json', { name: '@fixture/root' });
  writeJson(root, `${app.path}/package.json`, {
    name: '@fixture/inventory',
    version: '0.3.0',
    dependencies: {
      '@module-federation/runtime': `npm:@bleedingdev/mf-runtime@${runtimeVersion}`,
    },
    devDependencies: { '@modern-js/ultramodern-app-tools': 'workspace:*' },
  });
  const producerRoot = `${app.path}/node_modules/@module-federation/modern-js-v3`;
  writeJson(root, `${producerRoot}/package.json`, {
    name: '@module-federation/modern-js-v3',
    version: sidecarRecipes.find(recipe => recipe.id === 'mf-modern-js-v3')
      .upstream.version,
    main: 'index.js',
  });
  fs.writeFileSync(path.join(root, producerRoot, 'index.js'), '');
  const enhancedRoot = `${producerRoot}/node_modules/@module-federation/enhanced`;
  writeJson(root, `${enhancedRoot}/package.json`, {
    name: '@module-federation/enhanced',
    version: sidecarRecipes.find(recipe => recipe.id === 'mf-enhanced').upstream
      .version,
    exports: { './rspack': './rspack.js' },
  });
  fs.writeFileSync(path.join(root, enhancedRoot, 'rspack.js'), '');
  const rspackRoot = `${enhancedRoot}/node_modules/@module-federation/rspack`;
  writeJson(root, `${rspackRoot}/package.json`, {
    name: '@module-federation/rspack',
    version: manifestProducerRecipe.upstream.version,
    exports: { './plugin': './plugin.js' },
  });
  fs.writeFileSync(path.join(root, rspackRoot, 'plugin.js'), '');
  const built = writeBuiltApp(root, app, sourceRevision, 'f'.repeat(64));
  const finalized = marker
    ? stampUltramodernBuildArtifactIdentity(built.finalized, {
        buildMarker: marker,
        sourceRevision,
      })
    : built.finalized;
  const outputRoot = path.join(built.appRoot, '.output');
  const workerd = platform === 'workerd';
  const paths = workerd
    ? {
        carrier: 'public/ultramodern-build.json',
        backendManifest: 'public/backend-mf-manifest.json',
        backendContainer: 'public/backendRemoteEntry.cjs',
        api: 'worker/__modern_bff_effect.js',
        client: 'public/client.js',
        mfManifest: 'public/mf-manifest.json',
        server: 'worker/index.js',
      }
    : {
        carrier: 'ultramodern-build.json',
        backendManifest: 'backend/mf-manifest.json',
        backendContainer: 'backend/remoteEntry.js',
        api: 'api.js',
        client: 'client.js',
        mfManifest: 'mf-manifest.json',
        server: 'server.js',
      };
  if (workerd && !apiOnly) {
    writeJson(outputRoot, 'public/renderer-build.json', built.manifest);
    fs.unlinkSync(path.join(outputRoot, 'renderer-build.json'));
  }
  writeJson(outputRoot, paths.carrier, finalized);
  if (!uiOnly)
    writeJson(outputRoot, paths.backendManifest, {
      pluginVersion: '2.9.1',
    });
  for (const filename of [
    ...(uiOnly ? [] : [paths.api, paths.backendContainer]),
    ...(apiOnly ? [] : [paths.client, paths.server]),
  ]) {
    fs.mkdirSync(path.dirname(path.join(outputRoot, filename)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(outputRoot, filename), 'module.exports = {};');
  }
  if (!apiOnly) writeJson(outputRoot, paths.mfManifest, { pluginVersion });
  let workerManifest;
  if (workerd && !apiOnly) {
    writeJson(outputRoot, 'server/route.json', {
      routes: [
        { entryName: 'main', urlPath: '/', isSSR: true, worker: paths.server },
      ],
    });
    const modernConfig = uiOnly
      ? {}
      : { bff: { prefix: '/api', runtimeFramework: 'effect' } };
    const { createWorkerManifest } = built.ownerRequire(
      '@modern-js/app-tools-extensions/cloudflare/worker-manifest',
    );
    workerManifest = await createWorkerManifest(
      outputRoot,
      modernConfig,
      {
        apiOnly: false,
        appDirectory: built.appRoot,
        distDirectory: outputRoot,
        serverPlugins: [],
      },
      {
        ...finalized.deliveryUnit,
        surfaces: {
          ui: finalized.surfaces.ui,
          ...(uiOnly ? {} : { api: finalized.surfaces.api }),
        },
      },
    );
    writeJson(outputRoot, 'server/modern-worker-manifest.json', workerManifest);
    // Unit fixture for exact runtime-manifest comparison; no compiler or
    // Cloudflare execution credit is claimed by these controls.
    fs.writeFileSync(
      path.join(outputRoot, 'server/index.mjs'),
      `export const modernWorkerManifest = ${JSON.stringify(workerManifest)};`,
    );
    writeJson(outputRoot, 'wrangler.json', { main: 'server/index.mjs' });
  }
  const { createMicroVerticalReleaseEnvelope } = built.ownerRequire(
    '@modern-js/app-tools-extensions/release-envelope',
  );
  const ui = finalized.surfaces.ui;
  const envelope = await createMicroVerticalReleaseEnvelope({
    artifactRoot: outputRoot,
    target: workerd ? 'cloudflare' : 'node',
    identity: {
      unitId: finalized.deliveryUnit.unitId,
      buildMarker: finalized.deliveryUnit.buildMarker,
      releaseVersion: finalized.deliveryUnit.version,
      sourceRevision,
    },
    ...(ui
      ? {
          ui: {
            rendererIdentity: ui.rendererIdentity,
            rendererProfile: ui.rendererProfile,
            routerBindings: ui.routerBindings,
          },
        }
      : {}),
    artifacts: [
      {
        logicalPath: paths.carrier,
        runtime: 'release-identity-metadata',
      },
      ...(uiOnly
        ? []
        : [
            {
              logicalPath: paths.backendManifest,
              runtime: 'module-federation-manifest',
            },
            {
              logicalPath: paths.backendContainer,
              runtime: workerd ? 'commonjs-module' : 'nodejs',
            },
            {
              logicalPath: paths.api,
              runtime: workerd ? 'workerd-effect' : 'nodejs',
            },
          ]),
      ...(apiOnly
        ? []
        : [
            { logicalPath: paths.mfManifest, runtime: 'browser' },
            { logicalPath: paths.client, runtime: 'browser' },
            {
              logicalPath: paths.server,
              runtime: workerd ? 'workerd' : 'nodejs',
            },
            ...(workerd
              ? [
                  {
                    logicalPath: 'public/renderer-build.json',
                    runtime: 'browser',
                  },
                ]
              : []),
          ]),
      ...(workerd && !apiOnly
        ? [
            { logicalPath: 'server/index.mjs', runtime: 'workerd' },
            {
              logicalPath: 'server/modern-worker-manifest.json',
              runtime: 'cloudflare-deployment',
            },
            {
              logicalPath: 'server/route.json',
              runtime: 'cloudflare-deployment',
            },
            { logicalPath: 'wrangler.json', runtime: 'cloudflare-deployment' },
          ]
        : []),
    ],
    surfaces: {
      uiClient: apiOnly
        ? []
        : [
            paths.client,
            paths.mfManifest,
            ...(workerd ? ['public/renderer-build.json'] : []),
          ],
      ssr: apiOnly
        ? []
        : [paths.server, ...(workerd ? ['server/index.mjs'] : [])].sort(),
      apiBackend: uiOnly ? [] : [paths.api],
      ...(uiOnly
        ? {}
        : {
            backendFederation: {
              manifest: paths.backendManifest,
              container: paths.backendContainer,
            },
          }),
    },
  });
  writeJson(
    outputRoot,
    'release/microvertical-release-envelope.json',
    envelope,
  );
  return {
    ...built,
    app,
    envelope,
    outputRoot,
    workerManifest,
    contract: { workspace: { packageScope: '@fixture/root' }, apps: [app] },
  };
}

test('browser smoke preserves and validates the topology declared UI-only surface profile', async t => {
  const { readSmokeContract } = await import(
    '../../browser-smoke/contract.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const topology = writeStampedShell(
    root,
    'react',
    '0.2.0',
    'shell-generation',
  );
  topology.shell.surfaceProfile = 'ui-only';
  writeJson(root, 'topology/reference-topology.json', topology);
  assert.equal(
    readSmokeContract(root).contract.apps[0].surfaceProfile,
    'ui-only',
  );
  topology.shell.surfaceProfile = 'foreign-profile';
  writeJson(root, 'topology/reference-topology.json', topology);
  assert.throws(
    () => readSmokeContract(root),
    /invalid declared surface profile/u,
  );
});

test('browser smoke reads the canonical public Cloudflare compiler manifest with strict release binding', async t => {
  const { releaseIdentity } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await writeVerticalRelease(root, { platform: 'workerd' });
  assert.equal(
    fs.existsSync(path.join(built.outputRoot, 'renderer-build.json')),
    false,
  );
  const identity = releaseIdentity(root, built.app, 'workerd', {
    verifyRuntime: false,
  });
  assert.equal(identity.surfaces.frontend.buildMarker, built.manifest.buildId);
  assert.equal(identity.surfaces.api.buildMarker, built.manifest.buildId);
  const original = fs.readFileSync(
    path.join(built.outputRoot, 'public/renderer-build.json'),
  );
  fs.appendFileSync(
    path.join(built.outputRoot, 'public/renderer-build.json'),
    ' ',
  );
  assert.throws(
    () => releaseIdentity(root, built.app, 'workerd', { verifyRuntime: false }),
    /artifact mismatch for public\/renderer-build\.json/u,
  );
  fs.writeFileSync(
    path.join(built.outputRoot, 'public/renderer-build.json'),
    original,
  );
});

test('browser smoke rejects wrong-path or symbolic-link Cloudflare compiler manifests without a Node fallback', async t => {
  const { releaseIdentity } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await writeVerticalRelease(root, { platform: 'workerd' });
  const publicManifest = path.join(
    built.outputRoot,
    'public/renderer-build.json',
  );
  const wrongManifest = path.join(built.outputRoot, 'renderer-build.json');
  fs.renameSync(publicManifest, wrongManifest);
  assert.throws(
    () => releaseIdentity(root, built.app, 'workerd', { verifyRuntime: false }),
    /release artifact is missing: public\/renderer-build\.json/u,
  );
  fs.symlinkSync('../renderer-build.json', publicManifest);
  assert.throws(
    () => releaseIdentity(root, built.app, 'workerd', { verifyRuntime: false }),
    /non-symlink regular file/u,
  );
});

for (const { uiOnly, surfaceProfile } of [
  { uiOnly: true, surfaceProfile: 'ui-only' },
  { uiOnly: true, surfaceProfile: 'full-stack' },
  { uiOnly: false, surfaceProfile: 'full-stack' },
]) {
  test(`browser smoke binds ${surfaceProfile} Cloudflare Shell surfaces with ${uiOnly ? 'no' : 'an'} owned API`, async t => {
    const { bindContractToExpectedReleaseIdentities } = await import(
      '../../browser-smoke/runtime-evidence.mjs'
    );
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const built = await writeVerticalRelease(root, {
      uiOnly,
      platform: 'workerd',
    });
    built.app.kind = 'shell';
    built.app.surfaceProfile = surfaceProfile;
    if (surfaceProfile === 'full-stack' && uiOnly) {
      built.workerManifest.deliveryUnit.surfaces.api =
        built.finalized.surfaces.api;
      writeJson(
        built.outputRoot,
        'server/modern-worker-manifest.json',
        built.workerManifest,
      );
      fs.writeFileSync(
        path.join(built.outputRoot, 'server/index.mjs'),
        `export const modernWorkerManifest = ${JSON.stringify(built.workerManifest)};`,
      );
    }
    const { createMicroVerticalReleaseEnvelope, SHELL_RELEASE_ENVELOPE_KIND } =
      built.ownerRequire('@modern-js/app-tools-extensions/release-envelope');
    const { backendFederation: _producer, ...shellSurfaces } =
      built.envelope.surfaces;
    const shellEnvelopeInput = {
      artifactRoot: built.outputRoot,
      kind: SHELL_RELEASE_ENVELOPE_KIND,
      target: 'cloudflare',
      identity: built.envelope.identity,
      ui: built.envelope.ui,
      artifacts: built.envelope.artifacts.map(({ logicalPath, runtime }) => ({
        logicalPath,
        runtime,
      })),
      surfaces: shellSurfaces,
    };
    built.envelope =
      await createMicroVerticalReleaseEnvelope(shellEnvelopeInput);
    writeJson(
      built.outputRoot,
      'release/microvertical-release-envelope.json',
      built.envelope,
    );
    const bind = () =>
      bindContractToExpectedReleaseIdentities({
        contract: built.contract,
        expectedSourceRevisions: { inventory: 'a'.repeat(40) },
        platform: 'workerd',
        projectDir: root,
      });
    assert.equal(bind().apps[0].marker.buildMarker, built.manifest.buildId);
    if (surfaceProfile === 'full-stack' && uiOnly) {
      built.app.api = { prefix: '/api', stem: 'inventory' };
      assert.throws(
        bind,
        /shell envelope surfaces differ from its declared application surface profile/u,
      );
      delete built.app.api;
    }
    assert.deepEqual(
      Object.keys(built.workerManifest.deliveryUnit.surfaces).sort(),
      surfaceProfile === 'ui-only' ? ['ui'] : ['api', 'ui'],
    );
    if (surfaceProfile === 'ui-only')
      built.workerManifest.deliveryUnit.surfaces.api =
        built.finalized.surfaces.api;
    else delete built.workerManifest.deliveryUnit.surfaces.api;
    writeJson(
      built.outputRoot,
      'server/modern-worker-manifest.json',
      built.workerManifest,
    );
    // Bind the deliberate unit-fixture mutation with the genuine public factory
    // so the rejection must come from declared surfaces, not an obsolete SHA.
    const envelope =
      await createMicroVerticalReleaseEnvelope(shellEnvelopeInput);
    writeJson(
      built.outputRoot,
      'release/microvertical-release-envelope.json',
      envelope,
    );
    assert.throws(
      bind,
      /worker manifest surfaces differ from its declared application surface profile/u,
    );
  });
}

test('browser smoke requires the ordinary finalized renderer manifest instead of deriving a UI marker', async t => {
  const { readSmokeContract } = await import(
    '../../browser-smoke/contract.mjs'
  );
  const { bindContractToExpectedReleaseIdentities } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const topology = writeStampedShell(
    root,
    'react',
    '0.2.0',
    'shell-generation',
  );
  const built = writeBuiltApp(
    root,
    topology.shell,
    'a'.repeat(40),
    'f'.repeat(64),
  );
  const manifest = path.join(built.appRoot, '.output/renderer-build.json');
  const backup = path.join(built.appRoot, '.output/foreign.json');
  fs.renameSync(manifest, backup);
  const bind = () =>
    bindContractToExpectedReleaseIdentities({
      contract: readSmokeContract(root).contract,
      expectedSourceRevisions: { shell: 'a'.repeat(40) },
      platform: 'node',
      projectDir: root,
    });
  assert.throws(bind, { code: 'ENOENT' });
  fs.symlinkSync('foreign.json', manifest);
  assert.throws(bind, /ordinary file and directory path/u);
});

for (const apiOnly of [false, true]) {
  test(`browser smoke validates public ${apiOnly ? 'API-only' : 'renderer-bound'} release envelopes and their finalized marker`, async t => {
    const { bindContractToExpectedReleaseIdentities } = await import(
      '../../browser-smoke/runtime-evidence.mjs'
    );
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const built = await writeVerticalRelease(root, { apiOnly });
    const bind = () =>
      bindContractToExpectedReleaseIdentities({
        contract: built.contract,
        expectedSourceRevisions: { inventory: 'a'.repeat(40) },
        platform: 'node',
        projectDir: root,
      });
    assert.equal(
      bind().apps[0].marker.build,
      built.finalized.deliveryUnit.buildMarker,
    );
    assert.equal(built.finalized.deliveryUnit.buildMarker.length, 64);
    // Public envelope factory recalculates digest and actual file SHA; the
    // marker must still match the original source's finalized producer contract.
    await writeVerticalRelease(root, { apiOnly, marker: '0'.repeat(64) });
    assert.throws(
      bind,
      /release envelope build marker differs from its finalized build identity/u,
    );
  });
}

test('browser smoke verifies a public v5 UI-only shell envelope without API/backend evidence', async t => {
  const { releaseIdentity } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await writeVerticalRelease(root, { uiOnly: true });
  const {
    MICROVERTICAL_RELEASE_ENVELOPE_SCHEMA_VERSION,
    verifyMicroVerticalReleaseEnvelope,
  } = built.ownerRequire('@modern-js/app-tools-extensions/release-envelope');
  await verifyMicroVerticalReleaseEnvelope(built.envelope, {
    artifactRoot: built.outputRoot,
    expectedTarget: 'node',
  });
  const identity = releaseIdentity(root, built.app, 'node');
  assert.equal(
    identity.schemaVersion,
    MICROVERTICAL_RELEASE_ENVELOPE_SCHEMA_VERSION,
  );
  assert.equal(identity.schemaVersion, 5);
  assert.deepEqual(Object.keys(identity.surfaces).sort(), ['frontend', 'ssr']);
  assert.deepEqual(built.envelope.surfaces.apiBackend, []);
  assert.equal(
    Object.hasOwn(built.envelope.surfaces, 'backendFederation'),
    false,
  );
});

test('browser smoke rejects schema 4 and incomplete API/backend declarations', async t => {
  const { releaseIdentity } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await writeVerticalRelease(root, { uiOnly: true });
  const { releaseEnvelopePayload, digestMicroVerticalReleaseEnvelopePayload } =
    built.ownerRequire(
      '@modern-js/app-tools-extensions/release-envelope/canonical',
    );
  for (const [change, diagnostic] of [
    [
      value => {
        value.schemaVersion = 4;
      },
      /unsupported release envelope schema/u,
    ],
    [
      value => {
        value.surfaces.apiBackend = ['api.js'];
      },
      /must be declared together/u,
    ],
    [
      value => {
        value.surfaces.backendFederation = {
          manifest: 'backend/mf-manifest.json',
          container: 'backend/remoteEntry.js',
        };
      },
      /must be declared together/u,
    ],
  ]) {
    const value = structuredClone(built.envelope);
    change(value);
    value.envelopeDigest = digestMicroVerticalReleaseEnvelopePayload(
      releaseEnvelopePayload(value),
    );
    writeJson(
      built.outputRoot,
      'release/microvertical-release-envelope.json',
      value,
    );
    assert.throws(() => releaseIdentity(root, built.app, 'node'), diagnostic);
  }
});

test('browser smoke binds the native manifest producer separately from the runtime fork', async t => {
  const { releaseIdentity } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await writeVerticalRelease(root, {
    pluginVersion: manifestProducerRecipe.upstream.version,
    runtimeVersion: runtimeRecipe.fork.version,
  });
  assert.notEqual(
    manifestProducerRecipe.upstream.version,
    runtimeRecipe.fork.version,
    'The fixture must distinguish the native producer from the runtime fork',
  );
  const producerRoot = path.join(
    root,
    built.app.path,
    'node_modules/@module-federation/modern-js-v3',
  );
  const enhancedRoot = path.join(
    producerRoot,
    'node_modules/@module-federation/enhanced',
  );
  const rspackRoot = path.join(
    enhancedRoot,
    'node_modules/@module-federation/rspack',
  );
  // A direct app dependency must not replace the native plugin's actual producer.
  writeJson(
    root,
    `${built.app.path}/node_modules/@module-federation/enhanced/package.json`,
    {
      name: '@module-federation/enhanced',
      version: '99.0.0',
      exports: { './rspack': './rspack.js' },
    },
  );
  fs.writeFileSync(
    path.join(
      root,
      built.app.path,
      'node_modules/@module-federation/enhanced/rspack.js',
    ),
    '',
  );
  assert.deepEqual(
    releaseIdentity(root, built.app, 'node').surfaces.frontend.moduleFederation,
    [
      {
        packageName: '@module-federation/runtime',
        version: runtimeRecipe.fork.version,
      },
    ],
  );
  const recipes = sidecarRecipes;
  const recipe = recipes.find(item => item.id === 'mf-rspack');
  writeJson(producerRoot, 'package.json', {
    ...recipes.find(item => item.id === 'mf-modern-js-v3').fork,
    main: 'index.js',
  });
  writeJson(enhancedRoot, 'package.json', {
    ...recipes.find(item => item.id === 'mf-enhanced').fork,
    exports: { './rspack': './rspack.js' },
  });
  writeJson(rspackRoot, 'package.json', {
    ...recipe.fork,
    exports: { './plugin': './plugin.js' },
  });
  assert.deepEqual(
    releaseIdentity(root, built.app, 'node').surfaces.frontend.moduleFederation,
    [
      {
        packageName: '@module-federation/runtime',
        version: runtimeRecipe.fork.version,
      },
    ],
  );
  for (const replacement of [
    { name: '@bleedingdev/unknown-rspack', version: recipe.fork.version },
    { name: recipe.fork.name, version: '2.9.1' },
    { name: recipe.fork.name, version: '99.0.0' },
  ]) {
    writeJson(rspackRoot, 'package.json', {
      ...replacement,
      exports: { './plugin': './plugin.js' },
    });
    assert.throws(
      () => releaseIdentity(root, built.app, 'node'),
      /differs from its exact sidecar recipe/u,
    );
  }
  for (const version of ['2.9.2', '^2.9.2', undefined]) {
    writeJson(rspackRoot, 'package.json', {
      name: '@module-federation/rspack',
      version,
      exports: { './plugin': './plugin.js' },
    });
    assert.throws(
      () => releaseIdentity(root, built.app, 'node'),
      version === '2.9.2'
        ? /differs from its exact sidecar recipe/u
        : /producer version is invalid/u,
    );
  }
  const wrongManifestRoot = tempRoot();
  t.after(() => fs.rmSync(wrongManifestRoot, { recursive: true, force: true }));
  const wrongManifest = await writeVerticalRelease(wrongManifestRoot, {
    pluginVersion: `${manifestProducerRecipe.upstream.version}-foreign`,
    runtimeVersion: runtimeRecipe.fork.version,
  });
  assert.throws(
    () => releaseIdentity(wrongManifestRoot, wrongManifest.app, 'node'),
    /differs from installed producer/u,
  );
  const missingRoot = tempRoot();
  t.after(() => fs.rmSync(missingRoot, { recursive: true, force: true }));
  const missing = await writeVerticalRelease(missingRoot);
  fs.rmSync(
    path.join(
      missingRoot,
      missing.app.path,
      'node_modules/@module-federation/modern-js-v3',
    ),
    { recursive: true, force: true },
  );
  assert.throws(() => releaseIdentity(missingRoot, missing.app, 'node'), {
    code: 'MODULE_NOT_FOUND',
  });
});

test('browser smoke still rejects deployed artifact bytes changed after envelope stamping', async t => {
  const { bindContractToExpectedReleaseIdentities } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await writeVerticalRelease(root);
  fs.appendFileSync(
    path.join(built.outputRoot, 'ultramodern-build.json'),
    '\n',
  );
  assert.throws(
    () =>
      bindContractToExpectedReleaseIdentities({
        contract: built.contract,
        expectedSourceRevisions: { inventory: 'a'.repeat(40) },
        platform: 'node',
        projectDir: root,
      }),
    /release envelope artifact mismatch for ultramodern-build\.json/u,
  );
});

test('browser smoke rejects absent stamps and inconsistent stamped app identities', async t => {
  const { readSmokeContract } = await import(
    '../../browser-smoke/contract.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const topology = writeStampedShell(
    root,
    'react',
    '0.2.0',
    'd4fd0d4b2cf41285',
  );
  const stamp = topology.shell.deliveryUnit;
  assert.equal(Object.hasOwn(stamp, 'appId'), false);
  const save = deliveryUnit => {
    topology.shell.deliveryUnit = deliveryUnit;
    fs.writeFileSync(
      path.join(root, 'topology/reference-topology.json'),
      JSON.stringify(topology),
    );
  };
  for (const invalid of [undefined, [], {}, { ...stamp, buildMarker: ' \t' }]) {
    save(invalid);
    assert.throws(
      () => readSmokeContract(root),
      /stamped deliveryUnit.buildMarker/u,
    );
  }
  for (const replacement of [
    { appId: 'another-app' },
    { packageName: '@fixture/another' },
    { unitId: '@another/root/shell' },
    { version: '0.1.0' },
  ]) {
    save({ ...stamp, ...replacement });
    assert.throws(
      () => readSmokeContract(root),
      /stamped delivery-unit identity must match/u,
    );
  }
  save({ ...stamp, appId: 'shell' });
  assert.equal(readSmokeContract(root).contract.apps[0].marker.appId, 'shell');
});

test('browser smoke reads canonical topology, overlay and app security choices', async t => {
  const { readSmokeContract } = await import(
    '../../browser-smoke/contract.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write('package.json', { name: '@fixture/root' });
  write('apps/shell/package.json', {
    name: '@fixture/shell',
    version: '0.2.0',
  });
  write('verticals/inventory/package.json', {
    name: '@fixture/inventory',
    version: '0.3.0',
  });
  write('topology/reference-topology.json', {
    shell: {
      id: 'shell',
      kind: 'shell',
      path: 'apps/shell',
      package: '@fixture/shell',
      deliveryUnit: stampedBlock('shell', '0.2.0', 'ad122266dd999c17'),
      verticalRefs: ['inventory'],
      moduleFederation: { role: 'host' },
      cloudflare: {
        workerName: 'custom-shell-worker',
        distributedSsrProofRoutes: ['/cs', '/cs/inventory/example'],
        security: { enabled: true, contentSecurityPolicy: { mode: 'enforce' } },
        routes: { ssr: '/cs' },
      },
    },
    verticals: [
      {
        id: 'inventory',
        kind: 'vertical',
        path: 'verticals/inventory',
        package: '@fixture/inventory',
        deliveryUnit: stampedBlock('inventory', '0.3.0', 'ee874228738fecc2'),
        api: {
          runtime: 'effect',
          basePath: '/inventory-api/inventory',
          bff: { prefix: '/inventory-api' },
        },
        cloudflare: {
          routes: { apiReadiness: '/inventory-api/inventory/readiness' },
          jsonSmokeChecks: [
            {
              id: 'inventory-ready',
              route: '/inventory-api/inventory/readiness',
            },
          ],
        },
      },
    ],
  });
  write('topology/local-overlays/development.json', {
    ports: { shell: 4100, inventory: 4101 },
  });
  const { contract, contractPath } = readSmokeContract(root);
  assert.equal(
    contractPath,
    path.join(root, 'topology/reference-topology.json'),
  );
  assert.deepEqual(
    contract.apps.map(app => [
      app.id,
      app.config.source.siteUrl.defaultLocalhostPort,
    ]),
    [
      ['shell', 4100],
      ['inventory', 4101],
    ],
  );
  assert.equal(
    contract.apps[0].deploy.cloudflare.workerName,
    'custom-shell-worker',
  );
  assert.equal(
    contract.apps[0].deploy.cloudflare.security.contentSecurityPolicy.mode,
    'enforce',
  );
  assert.equal(contract.apps[0].deploy.cloudflare.routes.ssr, '/cs');
  assert.deepEqual(contract.apps[0].moduleFederation.verticalRefs, [
    'inventory',
  ]);
  assert.deepEqual(
    contract.apps[0].deploy.cloudflare.distributedSsrProofRoutes,
    ['/cs', '/cs/inventory/example'],
  );
  assert.equal(
    contract.apps[1].deploy.cloudflare.jsonSmokeChecks[0].id,
    'inventory-ready',
  );
  assert.equal(
    contract.apps[1].deploy.cloudflare.routes.apiReadiness,
    '/inventory-api/inventory/readiness',
  );
  assert.equal(contract.apps[1].api.protocol, 'rest');
  assert.deepEqual(
    contract.apps.map(app => [
      app.marker.build,
      app.deliveryUnit.buildMarker,
      app.deliveryUnit.version,
    ]),
    [
      ['ad122266dd999c17', 'ad122266dd999c17', '0.2.0'],
      ['ee874228738fecc2', 'ee874228738fecc2', '0.3.0'],
    ],
  );
  const rpcTopology = JSON.parse(
    fs.readFileSync(path.join(root, 'topology/reference-topology.json')),
  );
  rpcTopology.verticals[0].api.protocol = 'rpc';
  rpcTopology.verticals[0].cloudflare.routes = {
    rpc: '/inventory-api/rpc',
  };
  write('topology/reference-topology.json', rpcTopology);
  const rpcContract = readSmokeContract(root).contract;
  assert.equal(rpcContract.apps[1].api.protocol, 'rpc');
  assert.equal(
    rpcContract.apps[1].deploy.cloudflare.routes.rpc,
    '/inventory-api/rpc',
  );
  assert.equal(
    fs.existsSync(path.join(root, '.modernjs/ultramodern.json')),
    false,
  );
  write('topology/local-overlays/development.json', {
    ports: { shell: 4100, inventory: 4100 },
  });
  assert.throws(
    () => readSmokeContract(root),
    /unique development overlay port/u,
  );
});

function createNodeBackendProofResult() {
  const manifestUrl = 'http://localhost:3021/backend-mf-manifest.json';
  const containerEntry = 'http://localhost:3021/backendRemoteEntry.cjs';
  const envelopeDigest = 'a'.repeat(64);

  return {
    appId: 'inventory',
    containerEntry,
    manifestUrl,
    remoteName: 'verticalInventoryBackend',
    runtimeEntry: containerEntry,
    releaseEnvelope: {
      path: 'verticals/inventory/.output/release/microvertical-release-envelope.json',
      envelopeDigest,
      target: 'node',
    },
    liveArtifacts: {
      manifest: {
        url: manifestUrl,
        transportUrl: 'http://127.0.0.1:3021/backend-mf-manifest.json',
        logicalPath: 'backend-mf-manifest.json',
        statusCode: 200,
        byteLength: 1024,
        sha256: 'b'.repeat(64),
        status: 'pass',
      },
      container: {
        url: containerEntry,
        transportUrl: 'http://127.0.0.1:3021/backendRemoteEntry.cjs',
        logicalPath: 'backendRemoteEntry.cjs',
        statusCode: 200,
        byteLength: 2048,
        sha256: 'c'.repeat(64),
        status: 'pass',
      },
    },
    liveApi: {
      method: 'GET',
      route: '/inventory-api/inventory/readiness',
      url: 'http://127.0.0.1:3021/inventory-api/inventory/readiness',
      statusCode: 200,
      marker: {
        unitId: 'inventory',
        buildMarker: 'build-inventory',
        sourceRevision: 'd'.repeat(40),
        releaseVersion: '1.0.0',
      },
      envelopeDigest,
      apiBackendArtifacts: [
        {
          logicalPath: 'api/index.js',
          runtime: 'node',
          byteLength: 4096,
          sha256: 'd'.repeat(64),
        },
        {
          logicalPath: 'shared/runtime.js',
          runtime: 'node',
          byteLength: 2048,
          sha256: 'e'.repeat(64),
        },
      ],
      status: 'pass',
    },
    versionBoundary: {
      packageName: '@acme/inventory',
      version: '1.0.0',
      buildVersion: 'build-inventory',
      unitId: 'inventory',
      sourceRevision: 'd'.repeat(40),
    },
    smokeChecks: [
      {
        method: 'GET',
        route: '/inventory-api/inventory/readiness',
        statusCode: 200,
        assertions: [{ status: 'pass' }],
        status: 'pass',
      },
    ],
    status: 'pass',
  };
}

test('release acceptance requires the browser shell to run in workerd', async () => {
  const { assertBrowserRuntimeAcceptance } = await loadAcceptanceAssertions();

  assert.throws(
    () =>
      assertBrowserRuntimeAcceptance(
        {
          results: [],
          shellRuntime: 'node',
          skipped: [],
          status: 'pass',
        },
        [],
      ),
    /browser shell runtime must be workerd/i,
  );
});

function response(status, body, headers = {}) {
  return {
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function createFetch(routes) {
  return async url => {
    const pathname = new URL(url).pathname;
    const route = routes[pathname];
    if (!route) {
      return response(404, 'not found');
    }
    return response(route.status ?? 200, route.body);
  };
}

function createContract() {
  return {
    apps: [
      {
        id: 'shell-super-app',
        kind: 'shell',
        package: '@demo/shell-super-app',
        config: {
          source: {
            siteUrl: {
              defaultLocalhostPort: 3020,
              envFallbackOrder: [
                'MODERN_PUBLIC_SITE_URL',
                'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
                'SHELL_SUPER_APP_PORT',
              ],
            },
          },
          output: {
            assetPrefix: {
              envFallbackOrder: ['MODERN_ASSET_PREFIX'],
              default: '/',
            },
          },
        },
        deploy: {
          cloudflare: {
            publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
            routes: {
              locale: '/locales/en/shell.json',
              mfManifest: '/mf-manifest.json',
              ssr: '/en',
            },
          },
        },
        i18n: {
          namespace: 'shell',
        },
        marker: {
          build: 'build-shell',
        },
        moduleFederation: {
          remotes: [],
          verticalRefs: [],
        },
        styling: {
          federation: {
            rootSelector: '[data-app-id="shell-super-app"]',
          },
        },
      },
    ],
  };
}

function html({ appId = 'shell-super-app', marker = 'build-shell' } = {}) {
  return `<html><body><div data-app-id="${appId}"><p data-testid="ultramodern-ui-marker" data-build-marker="${marker}">marker</p></div></body></html>`;
}

function successRoutes() {
  return {
    '/en': {
      body: html(),
    },
    '/locales/en/shell.json': {
      body: JSON.stringify({ shell: { title: 'Shell' } }),
    },
    '/mf-manifest.json': {
      body: JSON.stringify({ metaData: { name: 'shellSuperApp' } }),
    },
  };
}

test('parses browser smoke CLI options with stable validation behavior', async () => {
  const { parseArgs, runUltramodernBrowserSmoke } = await loadSmoke();
  const parsed = parseArgs([
    '--project-dir',
    '.',
    '--artifact-dir',
    '.modern/browser-artifacts',
    '--out',
    '.modern/browser-summary.json',
    '--mode',
    'public',
    '--artifact-mode',
    'published',
    '--platform',
    'workerd',
    '--shell-runtime',
    'workerd',
    '--public-url',
    'shell-super-app=https://shell.example.test/',
    '--require-public-urls',
    '--timeout-ms',
    '30000',
  ]);

  assert.equal(path.isAbsolute(parsed.projectDir), true);
  assert.equal(path.isAbsolute(parsed.artifactDir), true);
  assert.equal(path.isAbsolute(parsed.out), true);
  assert.equal(
    parsed.publicUrls['shell-super-app'],
    'https://shell.example.test/',
  );

  assert.throws(
    () => parseArgs(['--project-dir=.']),
    /^Error: Unknown argument: --project-dir=.$/,
  );
  assert.throws(
    () => parseArgs(['--project-dir', '.', '--artifact-mode', 'source']),
    /--artifact-mode and --platform must be provided together/,
  );
  assert.throws(
    () => parseArgs(['--project-dir', '.', '--platform', 'node']),
    /--artifact-mode and --platform must be provided together/,
  );
  await assert.rejects(
    () =>
      runUltramodernBrowserSmoke({
        artifactMode: 'source',
        projectDir: '.',
      }),
    /artifactMode and platform must be provided together/,
  );
});

test('Node browser continuation CLI is limited to the source/node cursor', async () => {
  const { parseArgs } = await loadSmoke();
  const args = [
    '--project-dir',
    '.',
    '--mode',
    'local',
    '--artifact-mode',
    'source',
    '--platform',
    'node',
    '--continue-from',
    'prior.json',
    '--backend-report',
    'proof.json',
  ];
  const parsed = parseArgs(args);
  assert.equal(parsed.continueFrom, path.resolve('prior.json'));
  assert.equal(parsed.backendReport, path.resolve('proof.json'));
  assert.throws(
    () => parseArgs(['--project-dir', '.', '--backend-report', 'proof.json']),
    /requires --continue-from/,
  );
  assert.throws(
    () => parseArgs([...args, '--shell-runtime', 'workerd']),
    /requires local source\/node/,
  );
});

test('Node browser continuation uses strict native policy without requiring trust exclusions', async t => {
  const { createAcceptedNodeProofEnvironment } = await loadSmoke();
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = {
    minimumReleaseAge: 0,
    trustPolicy: 'no-downgrade',
    enableGlobalVirtualStore: false,
  };
  writeJson(root, 'node_modules/.pnpm-workspace-state-v1.json', { settings });
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    Object.entries({ ...settings, trustPolicyIgnoreAfter: 1440 })
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n') + '\n',
  );
  const env = createAcceptedNodeProofEnvironment(root, {
    CI: 'false',
    PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: 'foreign',
    pnpm_config_verify_deps_before_run: 'error',
  });
  assert.equal(env.CI, 'true');
  assert.equal(env.PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE, undefined);
  assert.equal(env.pnpm_config_minimum_release_age_exclude, undefined);
  assert.equal(env.pnpm_config_trust_policy_exclude, undefined);
  assert.equal(env.pnpm_config_enable_global_virtual_store, 'false');
  assert.equal(env.pnpm_config_verify_deps_before_run, 'error');
  settings.trustPolicy = 'off';
  writeJson(root, 'node_modules/.pnpm-workspace-state-v1.json', { settings });
  assert.throws(
    () => createAcceptedNodeProofEnvironment(root),
    /original strict pnpm install settings/,
  );
});

test('Node browser continuation pins prior observations and rejects stale identity or changed output bytes', async t => {
  const { readNodeBrowserContinuation } = await loadSmoke();
  const { bindContractToExpectedReleaseIdentities } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await writeVerticalRelease(root);
  const contract = bindContractToExpectedReleaseIdentities({
    contract: built.contract,
    expectedSourceRevisions: { inventory: 'a'.repeat(40) },
    platform: 'node',
    projectDir: root,
  });
  const app = contract.apps[0];
  const target = { app, baseUrl: 'http://localhost:3021' };
  const assertions = [
    ...[
      'ssr-route',
      'css-root-marker',
      'mf-manifest',
      'mf-manifest-json',
      'locale-json',
      'browser-css-root-marker',
      'stylesheet-evidence',
      'stylesheet-href-dedupe',
      'browser-diagnostics',
      'no-js-ssr-css-root-marker',
      'no-js-stylesheet-href-dedupe',
      'no-js-ssr-failed-responses',
      'effect-readiness',
      'backend-json-smoke',
      'localized-router-navigation',
    ].map(type => ({ type, status: 'pass' })),
    ...['ui-marker-html', 'browser-ui-marker', 'no-js-ssr-ui-marker'].map(
      type => ({
        type,
        status: 'pass',
        actual: app.marker.build,
        expected: app.marker.build,
      }),
    ),
    {
      type: 'backend-driven-ui',
      status: 'pass',
      apiResponse: {
        body: { items: [{ marker: built.finalized.surfaces.api }] },
      },
    },
  ];
  const prior = {
    schemaVersion: 1,
    status: 'fail',
    error: 'Node backend federation proof failed',
    errorDetails: { exitCode: 1, signal: null },
    mode: 'local',
    artifactMode: 'source',
    platform: 'node',
    shellRuntime: 'node',
    projectDir: root,
    contractPath: path.join(root, 'topology/reference-topology.json'),
    artifactDir: path.join(root, 'prior-artifacts'),
    skipped: [],
    targetRuntimes: { inventory: 'node' },
    results: [
      {
        appId: 'inventory',
        status: 'pass',
        baseUrl: target.baseUrl,
        assertions,
      },
    ],
  };
  const options = {
    projectDir: root,
    continueFrom: path.join(root, 'prior.json'),
    out: path.join(root, 'new.json'),
    artifactDir: path.join(root, 'new-artifacts'),
  };
  const read = () =>
    readNodeBrowserContinuation({
      options,
      contract,
      contractPath: prior.contractPath,
      targets: [target],
    });
  writeJson(root, 'prior.json', prior);
  const accepted = read();
  assert.equal(
    accepted.priorReport.sha256,
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(options.continueFrom))
      .digest('hex'),
  );
  assert.deepEqual(accepted.results, prior.results);
  for (const mutate of [
    value => {
      value.skipped = [{ appId: 'inventory' }];
    },
    value => {
      value.results.push(value.results[0]);
    },
    value => {
      value.results[0].assertions.find(
        item => item.type === 'browser-ui-marker',
      ).actual = '0'.repeat(64);
    },
    value => {
      value.results[0].assertions = value.results[0].assertions.filter(
        item => item.type !== 'localized-router-navigation',
      );
    },
  ]) {
    const rejected = structuredClone(prior);
    mutate(rejected);
    writeJson(root, 'prior.json', rejected);
    assert.throws(read, /unchanged passed Node browser stage/);
  }
  writeJson(root, 'prior.json', prior);
  fs.writeFileSync(
    path.join(built.outputRoot, 'client.js'),
    'changed after browser observation',
  );
  assert.throws(read, /unchanged passed Node browser stage/);
});

test('Node browser continuation reuses only a backend proof bound to the current artifact set', async t => {
  const { readNodeBackendFederationProof } = await import(
    '../../browser-smoke/backend-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const item = createNodeBackendProofResult();
  const expectedArtifacts = [
    {
      appId: item.appId,
      envelopePath: item.releaseEnvelope.path,
      envelopeDigest: item.releaseEnvelope.envelopeDigest,
      identity: {
        buildMarker: item.versionBoundary.buildVersion,
        releaseVersion: item.versionBoundary.version,
        sourceRevision: item.versionBoundary.sourceRevision,
      },
    },
  ];
  const relative = '.codex/reports/node-backend-federation-proof/proof.json';
  const report = {
    schemaVersion: 1,
    status: 'pass',
    target: '.output',
    results: [item],
  };
  writeJson(root, relative, report);
  const read = () =>
    readNodeBackendFederationProof({ projectDir: root, expectedArtifacts });
  assert.equal(read()[0].status, 'pass');
  const stale = structuredClone(report);
  stale.results[0].versionBoundary.sourceRevision = 'e'.repeat(40);
  stale.results[0].liveApi.marker.sourceRevision = 'e'.repeat(40);
  writeJson(root, relative, stale);
  assert.throws(read, /does not match current artifact identity/);
  writeJson(root, relative, { ...report, results: [item, item] });
  assert.throws(read, /exactly cover current artifacts/);
});

test('orders remote consumers after their remote producers are ready', async () => {
  const { createSmokeTargets, orderTargetsForLocalStartup } = await loadSmoke();
  const contract = createContract();
  contract.apps.push(
    {
      ...contract.apps[0],
      id: 'decide',
      kind: 'vertical',
      package: '@demo/decide',
      moduleFederation: {
        remotes: [{ id: 'explore' }, { id: 'checkout' }],
      },
    },
    {
      ...contract.apps[0],
      id: 'explore',
      kind: 'vertical',
      package: '@demo/explore',
    },
    {
      ...contract.apps[0],
      id: 'checkout',
      kind: 'vertical',
      package: '@demo/checkout',
    },
  );

  const { targets } = createSmokeTargets(contract);
  const ordered = orderTargetsForLocalStartup(targets);

  assert.deepEqual(
    ordered.remoteLayers.map(layer => layer.map(target => target.app.id)),
    [['explore', 'checkout'], ['decide']],
  );
  assert.deepEqual(
    ordered.validation.map(target => target.app.id),
    ['explore', 'checkout', 'decide', 'shell-super-app'],
  );
});

test('shell federation proof matches each remote against its deployed target URL', async () => {
  const { remoteFederationNetworkEvidence } = await import(
    '../../browser-smoke/browser-validate.mjs'
  );
  const remotes = [
    { id: 'inventory', manifestUrl: 'http://localhost:4101/mf-manifest.json' },
    { id: 'finance', manifestUrl: 'http://localhost:4102/mf-manifest.json' },
  ];
  const targets = [
    {
      app: { id: 'inventory' },
      baseUrl: 'http://localhost:62924',
      routes: { mfManifest: '/mf-manifest.json' },
    },
    {
      app: { id: 'finance' },
      baseUrl: 'http://localhost:62925',
      routes: { mfManifest: '/mf-manifest.json' },
    },
  ];
  const responses = targets.flatMap(target =>
    [
      ['manifest', '/mf-manifest.json'],
      ['remote-entry', '/remoteEntry.js'],
      ['exposed-chunk', '/static/js/async/__federation_expose_Widget.js'],
    ].map(([kind, route]) => ({
      kind,
      status: 200,
      url: `${target.baseUrl}${route}`,
    })),
  );

  assert.deepEqual(
    remoteFederationNetworkEvidence(remotes, targets, responses).map(remote => [
      remote.manifestUrl,
      remote.status,
    ]),
    [
      ['http://localhost:62924/mf-manifest.json', 'pass'],
      ['http://localhost:62925/mf-manifest.json', 'pass'],
    ],
  );
  assert.equal(
    remoteFederationNetworkEvidence(remotes, targets, responses.slice(0, -1))[1]
      .status,
    'fail',
  );
  assert.equal(
    remoteFederationNetworkEvidence(remotes, targets, [
      ...responses.filter(response => response.kind !== 'manifest'),
      {
        kind: 'manifest',
        status: 200,
        url: 'http://localhost:62924/wrong-mf-manifest.json',
      },
    ])[0].status,
    'fail',
  );
  assert.equal(
    remoteFederationNetworkEvidence(
      [{ id: 'inventory', manifestUrl: 'not-a-url' }],
      targets,
      responses,
    )[0].status,
    'fail',
  );
  assert.equal(
    remoteFederationNetworkEvidence(
      [
        {
          id: 'missing',
          manifestUrl: 'http://localhost:4103/mf-manifest.json',
        },
      ],
      targets,
      responses,
    )[0].status,
    'fail',
  );

  const workerdTargets = targets.map(target => ({
    ...target,
    baseUrl: target.baseUrl.replace('localhost', '127.0.0.1'),
  }));
  assert.deepEqual(
    remoteFederationNetworkEvidence(
      remotes,
      workerdTargets,
      responses,
      'workerd',
    ).map(remote => remote.status),
    ['pass', 'pass'],
  );
  assert.equal(
    remoteFederationNetworkEvidence(remotes, workerdTargets, responses)[0]
      .status,
    'fail',
  );
  const replaceInventoryHost = host =>
    responses.map(response => ({
      ...response,
      url: response.url.replace('localhost:62924', host),
    }));
  assert.equal(
    remoteFederationNetworkEvidence(
      remotes,
      workerdTargets,
      replaceInventoryHost('localhost:62926'),
      'workerd',
    )[0].status,
    'fail',
  );
  assert.equal(
    remoteFederationNetworkEvidence(
      remotes,
      workerdTargets,
      replaceInventoryHost('example.com:62924'),
      'workerd',
    )[0].status,
    'fail',
  );
  assert.equal(
    remoteFederationNetworkEvidence(
      remotes,
      workerdTargets,
      responses.filter(
        response => response.url !== 'http://localhost:62924/mf-manifest.json',
      ),
      'workerd',
    )[0].status,
    'fail',
  );
});

test('does not accept SSR readiness from a foreign build marker', async () => {
  const { createSmokeTargets, waitForTarget } = await loadSmoke();
  const [target] = createSmokeTargets(createContract()).targets;
  let attempts = 0;

  await waitForTarget(target, {
    fetchImpl: async () => {
      attempts += 1;
      return response(
        200,
        html({
          marker: attempts === 1 ? 'foreign-build' : 'build-shell',
        }),
      );
    },
    retryDelayMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(attempts, 2);
});

test('fails readiness when required MF manifest never becomes valid JSON', async () => {
  const { createSmokeTargets, waitForTarget } = await loadSmoke();
  const [target] = createSmokeTargets(createContract()).targets;

  await assert.rejects(
    () =>
      waitForTarget(target, {
        fetchImpl: async url => {
          const pathname = new URL(url).pathname;
          return response(
            200,
            pathname === '/mf-manifest.json'
              ? '<html>not ready</html>'
              : html(),
          );
        },
        requireManifest: true,
        retryDelayMs: 1,
        timeoutMs: 5,
      }),
    /did not publish a ready MF manifest/,
  );
});

test('fails readiness immediately when the owned serve process exits', async () => {
  const { createSmokeTargets, waitForTarget } = await loadSmoke();
  const [target] = createSmokeTargets(createContract()).targets;
  const root = tempRoot();
  const logPath = path.join(root, 'shell-serve.log');
  fs.writeFileSync(
    logPath,
    `${'discard-me\n'.repeat(2_000)}NPM_TOKEN=do-not-copy-me\nError: Cannot find module '@modern-js/prod-server'\n`,
  );

  try {
    await assert.rejects(
      () =>
        waitForTarget(target, {
          fetchImpl: async () => new Promise(() => {}),
          retryDelayMs: 1,
          serverExit: Promise.resolve({ exitCode: 1, signal: null }),
          serverLogPath: logPath,
          timeoutMs: 1_000,
        }),
      error => {
        assert.match(error.message, /serve process exited before readiness/);
        assert.match(
          error.message,
          /Cannot find module '@modern-js\/prod-server'/,
        );
        assert.match(error.message, new RegExp(logPath.replaceAll('/', '\\/')));
        assert.doesNotMatch(error.message, /do-not-copy-me/);
        assert.match(error.message, /NPM_TOKEN=\[REDACTED\]/);
        assert.equal(error.details.exitCode, 1);
        assert.equal(error.details.logPath, logPath);
        assert.ok(error.details.logTail.length <= 8_192);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects occupied local smoke ports before startup', async () => {
  const { assertLocalPortsAvailable } = await loadSmoke();
  const server = net.createServer();
  await new Promise(resolve =>
    server.listen({ host: '127.0.0.1', port: 0 }, resolve),
  );
  const { port } = server.address();

  try {
    await assert.rejects(
      () =>
        assertLocalPortsAvailable([
          {
            app: { id: 'shell-super-app' },
            baseUrl: `http://localhost:${port}`,
            port,
          },
        ]),
      /local smoke port .* is already in use/,
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('passes route, marker, manifest, and locale HTTP assertions', async () => {
  const { createSmokeTargets, validateHttpTarget } = await loadSmoke();
  const [target] = createSmokeTargets(createContract()).targets;

  const assertions = await validateHttpTarget(target, {
    fetchImpl: createFetch(successRoutes()),
  });

  assert.equal(
    assertions.every(item => item.status === 'pass'),
    true,
  );
  assert.equal(
    assertions.some(item => item.type === 'mf-manifest'),
    true,
  );
});

test('executes configured backend JSON smoke checks against the selected runtime target', async () => {
  const { createSmokeTargets, validateHttpTarget } = await loadSmoke();
  const contract = createContract();
  contract.apps[0].deploy.cloudflare.jsonSmokeChecks = [
    {
      body: { sku: 'TRACTOR-1' },
      expect: { 'item.sku': 'TRACTOR-1' },
      id: 'backend-domain-command',
      method: 'POST',
      route: '/shell-api/command',
    },
  ];
  const [target] = createSmokeTargets(contract).targets;
  let observed;
  const assertions = await validateHttpTarget(target, {
    async fetchImpl(url, init = {}) {
      const pathname = new URL(url).pathname;
      if (pathname === '/shell-api/command') {
        observed = {
          body: init.body,
          contentType: init.headers['content-type'],
          method: init.method,
        };
        return response(200, JSON.stringify({ item: { sku: 'TRACTOR-1' } }));
      }
      return createFetch(successRoutes())(url);
    },
  });

  assert.deepEqual(observed, {
    body: '{"sku":"TRACTOR-1"}',
    contentType: 'application/json',
    method: 'POST',
  });
  assert.equal(
    assertions.find(assertion => assertion.type === 'backend-json-smoke')
      ?.status,
    'pass',
  );
});

test('extracts the rendered title from REST and RPC API response JSON', async () => {
  const { extractBackendDrivenTitle } = await import(
    '../../browser-smoke/browser-validate.mjs'
  );

  assert.equal(
    extractBackendDrivenTitle({
      items: [{ title: 'REST backend value' }],
    }),
    'REST backend value',
  );
  assert.equal(
    extractBackendDrivenTitle([
      17,
      {
        _tag: 'Success',
        value: {
          items: [{ title: 'RPC backend value' }],
        },
      },
    ]),
    'RPC backend value',
  );
  assert.equal(extractBackendDrivenTitle({ items: [] }), undefined);
});

test('strict runtime evidence fails closed when executed results omit required dimensions', async () => {
  const { assertStrictRuntimeEvidence } = await loadSmoke();
  const { createRuntimeEvidence } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      dependencies: {
        '@module-federation/bridge-react': '2.8.0',
        '@module-federation/modern-js-v3': '2.8.0',
        '@module-federation/runtime': '2.8.0',
      },
    }),
  );
  const contract = createContract();
  contract.apps.push({
    ...contract.apps[0],
    id: 'inventory',
    kind: 'vertical',
    path: 'verticals/inventory',
  });
  const pass = type => ({ status: 'pass', type });
  const results = [
    {
      appId: 'shell-super-app',
      assertions: [
        pass('ssr-route'),
        pass('mf-manifest'),
        pass('shell-mf-network-evidence'),
      ],
    },
    {
      appId: 'inventory',
      assertions: [
        pass('ssr-route'),
        pass('mf-manifest'),
        pass('effect-readiness'),
        pass('backend-json-smoke'),
        pass('backend-federation-network'),
      ],
    },
  ];

  try {
    const evidence = createRuntimeEvidence({
      artifactMode: 'source',
      contract,
      platform: 'node',
      projectDir: root,
      results,
    });

    assert.equal(evidence.ssr.status, 'pass');
    assert.equal(evidence['browser-mf'].status, 'pass');
    assert.equal(evidence.api.status, 'pass');
    assert.equal(evidence.backend.status, 'pass');
    assert.equal(evidence['backend-driven-ui'].status, 'fail');
    assert.equal(evidence['failure-isolation'].status, 'fail');
    assert.equal(evidence['release-identity'].status, 'fail');
    assert.deepEqual(evidence.ssr.verticalIds, ['inventory']);
    assert.equal(evidence.ssr.artifactMode, 'source');
    assert.equal(evidence.ssr.platform, 'node');
    assert.throws(
      () => assertStrictRuntimeEvidence(evidence),
      /Strict runtime evidence failed: backend-driven-ui, failure-isolation, release-identity/,
      'the standalone strict runner must not report pass when embedded evidence failed',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Node backend evidence accepts only network-loaded federation with executed smoke checks', async () => {
  const { runNodeBackendFederationProof } = await import(
    '../../browser-smoke/backend-evidence.mjs'
  );
  const root = tempRoot();
  const reportPath = path.join(
    root,
    '.codex/reports/node-backend-federation-proof/proof.json',
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    schemaVersion: 1,
    status: 'pass',
    target: 'dist',
    results: [createNodeBackendProofResult()],
  };
  fs.writeFileSync(reportPath, JSON.stringify(report));

  try {
    let proofEnvironment;
    const [assertion] = runNodeBackendFederationProof({
      artifactDir: path.join(root, 'artifacts'),
      projectDir: root,
      spawnSyncImpl(_command, _args, options) {
        proofEnvironment = options.env;
        return { status: 0, stderr: '', stdout: 'proof passed' };
      },
    });
    assert.equal(assertion.status, 'pass');
    assert.equal(assertion.type, 'backend-federation-network');
    assert.equal(
      proofEnvironment.ULTRAMODERN_NODE_PROOF_SERVER_MODE,
      'existing',
      'the integrated browser harness must remain the only owner of its live Node server processes',
    );

    report.results[0].runtimeEntry =
      'file:///tmp/inventory/backendRemoteEntry.cjs';
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const [fileAssertion] = runNodeBackendFederationProof({
      artifactDir: path.join(root, 'artifacts'),
      projectDir: root,
      spawnSyncImpl() {
        return { status: 0, stderr: '', stdout: 'proof passed' };
      },
    });
    assert.equal(fileAssertion.status, 'fail');

    report.results[0] = {
      appId: 'inventory',
      containerEntry: 'http://localhost:3021/backendRemoteEntry.cjs',
      manifestUrl: 'http://localhost:3021/backend-mf-manifest.json',
      remoteName: 'verticalInventoryBackend',
      runtimeEntry: 'http://localhost:3021/backendRemoteEntry.cjs',
      smokeChecks: [{ status: 'pass' }],
      status: 'pass',
    };
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const [forgedAssertion] = runNodeBackendFederationProof({
      artifactDir: path.join(root, 'artifacts'),
      projectDir: root,
      spawnSyncImpl() {
        return { status: 0, stderr: '', stdout: 'proof passed' };
      },
    });
    assert.equal(forgedAssertion.status, 'fail');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical backend proof shape contract rejects missing live correlation while executed-envelope verification owns digest recomputation', async () => {
  const { validateNodeBackendFederationProofResult } = await import(
    '../../browser-smoke/backend-proof-contract.mjs'
  );
  const valid = createNodeBackendProofResult();
  assert.equal(validateNodeBackendFederationProofResult(valid).ok, true);

  const forged = structuredClone(valid);
  delete forged.releaseEnvelope;
  delete forged.liveArtifacts;
  delete forged.liveApi;
  const validation = validateNodeBackendFederationProofResult(forged);
  assert.equal(validation.ok, false);
  assert.match(
    validation.failures.join('\n'),
    /release envelope|live artifact|live API/i,
  );

  const wrongOrigin = createNodeBackendProofResult();
  wrongOrigin.liveApi.url =
    'https://forged.example/inventory-api/inventory/readiness';
  assert.equal(validateNodeBackendFederationProofResult(wrongOrigin).ok, false);

  const traversingEnvelope = createNodeBackendProofResult();
  traversingEnvelope.releaseEnvelope.path =
    '../release/microvertical-release-envelope.json';
  assert.equal(
    validateNodeBackendFederationProofResult(traversingEnvelope).ok,
    false,
  );

  const crossOrigin = createNodeBackendProofResult();
  crossOrigin.runtimeEntry = 'https://forged.example/backendRemoteEntry.cjs';
  assert.equal(
    validateNodeBackendFederationProofResult(crossOrigin).ok,
    false,
    'the runtime entry must match the declared container identity',
  );

  for (const logicalPath of ['/api/index.js', 'api/nested/../../outside.js']) {
    const unsafeArtifactPath = createNodeBackendProofResult();
    unsafeArtifactPath.liveApi.apiBackendArtifacts[0].logicalPath = logicalPath;
    assert.equal(
      validateNodeBackendFederationProofResult(unsafeArtifactPath).ok,
      false,
      `unsafe API artifact path must fail: ${JSON.stringify(logicalPath)}`,
    );
  }

  const malformedDigest = createNodeBackendProofResult();
  malformedDigest.releaseEnvelope.envelopeDigest = 'not-a-sha256';
  malformedDigest.liveApi.envelopeDigest = 'not-a-sha256';
  assert.equal(
    validateNodeBackendFederationProofResult(malformedDigest).ok,
    false,
    'the shape contract must require a SHA-256 reference even though runtime-evidence recomputes it from executed bytes',
  );
});

test('Node backend proof correlates loopback transport separately from exact public artifact identities', async () => {
  const { validateNodeBackendFederationProofResult } = await import(
    '../../browser-smoke/backend-proof-contract.mjs'
  );
  const valid = createNodeBackendProofResult();
  valid.manifestUrl =
    'https://stage.example.test//edge/inventory/backend-mf-manifest.json?revision=1#manifest';
  valid.containerEntry =
    'https://stage.example.test//edge/inventory/backendRemoteEntry.cjs?revision=1#entry';
  valid.runtimeEntry = valid.containerEntry;
  valid.liveArtifacts.manifest.url = valid.manifestUrl;
  valid.liveArtifacts.container.url = valid.containerEntry;
  assert.deepEqual(validateNodeBackendFederationProofResult(valid), {
    appId: 'inventory',
    failures: [],
    ok: true,
  });
  for (const mutate of [
    proof => {
      delete proof.liveArtifacts.manifest.transportUrl;
    },
    proof => {
      proof.liveArtifacts.container.transportUrl = proof.containerEntry;
    },
    proof => {
      proof.liveArtifacts.container.transportUrl =
        'http://127.0.0.1:3022/backendRemoteEntry.cjs';
    },
    proof => {
      proof.liveArtifacts.manifest.transportUrl =
        'http://127.0.0.1:3021/other/backend-mf-manifest.json';
    },
    proof => {
      proof.liveArtifacts.container.transportUrl += '?revision=1';
    },
    proof => {
      proof.liveArtifacts.container.transportUrl += '#entry';
    },
    proof => {
      proof.liveArtifacts.container.transportUrl =
        'http://user:secret@127.0.0.1:3021/backendRemoteEntry.cjs';
    },
    proof => {
      proof.liveArtifacts.manifest.url = proof.manifestUrl.replace(
        'revision=1',
        'revision=2',
      );
    },
    proof => {
      proof.liveApi.url =
        'https://stage.example.test/inventory-api/inventory/readiness';
    },
    proof => {
      proof.liveApi.url =
        'http://127.0.0.1:3022/inventory-api/inventory/readiness';
    },
    proof => {
      proof.liveApi.url += '?redirect=stage';
    },
    proof => {
      proof.liveApi.url += '#readiness';
    },
  ]) {
    const forged = structuredClone(valid);
    mutate(forged);
    assert.equal(validateNodeBackendFederationProofResult(forged).ok, false);
  }
});

test('Node backend proof accepts native RPC operations only when live URL, envelope, and backend artifacts remain bound', async () => {
  const { validateNodeBackendFederationProofResult } = await import(
    '../../browser-smoke/backend-proof-contract.mjs'
  );
  const valid = createNodeBackendProofResult();
  valid.liveApi = {
    method: 'RPC',
    protocol: 'rpc',
    serialization: 'json',
    group: 'inventory',
    route: '/inventory-api/rpc',
    url: 'http://127.0.0.1:3021/inventory-api/rpc',
    operations: [
      { method: 'list', itemId: 'starter-inventory', status: 'pass' },
      { method: 'get', itemId: 'starter-inventory', status: 'pass' },
      {
        method: 'get',
        errorTag: 'InventoryNotFoundRpc',
        missingId: '__missing__',
        status: 'pass',
      },
    ],
    envelopeDigest: valid.releaseEnvelope.envelopeDigest,
    apiBackendArtifacts: valid.liveApi.apiBackendArtifacts,
    status: 'pass',
  };
  valid.smokeChecks[0].method = 'POST';
  valid.smokeChecks[0].route = '/inventory-api/rpc';
  assert.equal(validateNodeBackendFederationProofResult(valid).ok, true);
  for (const mutate of [
    proof => {
      proof.liveApi.operations[2].errorTag = 'OtherNotFoundRpc';
    },
    proof => {
      proof.liveApi.url = 'http://localhost:3022/inventory-api/rpc';
    },
    proof => {
      proof.liveApi.envelopeDigest = 'f'.repeat(64);
    },
    proof => {
      proof.liveApi.apiBackendArtifacts = [];
    },
  ]) {
    const forged = structuredClone(valid);
    mutate(forged);
    assert.equal(validateNodeBackendFederationProofResult(forged).ok, false);
  }
});

test('workerd RPC response evidence requires the declared POST result without inventing a release marker', async () => {
  const { verifyWorkerdResponse } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const app = {
    id: 'inventory',
    api: { protocol: 'rpc' },
    deploy: { cloudflare: { routes: { rpc: '/inventory-api/rpc' } } },
  };
  const check = {
    method: 'POST',
    route: '/inventory-api/rpc',
    body: {
      jsonrpc: '2.0',
      id: 'inventory-cloudflare-proof',
      method: 'list',
      params: { limit: 1 },
    },
    expect: {
      id: 'inventory-cloudflare-proof',
      'result.items.0.id': 'starter-inventory',
    },
  };
  const evidence = body => {
    const bytes = Buffer.from(JSON.stringify(body));
    return {
      bodyBase64: bytes.toString('base64'),
      byteLength: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      status: 200,
    };
  };
  const response = evidence({
    jsonrpc: '2.0',
    id: check.body.id,
    result: { items: [{ id: 'starter-inventory', title: 'Real RPC item' }] },
  });
  assert.doesNotThrow(() =>
    verifyWorkerdResponse(response, app, {}, 'direct', check),
  );
  assert.throws(
    () =>
      verifyWorkerdResponse(
        evidence({
          jsonrpc: '2.0',
          id: check.body.id,
          result: { items: [{ id: 'other-app' }] },
        }),
        app,
        {},
        'direct',
        check,
      ),
    /declared POST smoke check/u,
  );
  assert.throws(
    () =>
      verifyWorkerdResponse(
        { ...response, releaseMarker: { appId: 'inventory' } },
        app,
        {},
        'direct',
        check,
      ),
    /declared POST smoke check/u,
  );
});

test('workerd API proof requires the actual service binding or an unbound headless worker', async () => {
  const { assertWorkerdApiProofTarget } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const app = { id: 'inventory', surfaceProfile: 'api-only' };
  const worker = 'fixture-inventory';
  const envelopeDigest = 'a'.repeat(64);
  const target = { appId: app.id, envelopeDigest, worker };
  const direct = { directTarget: target };
  assert.equal(
    assertWorkerdApiProofTarget(direct, app, worker, envelopeDigest),
    'direct',
  );
  assert.throws(
    () => assertWorkerdApiProofTarget(direct, app, worker, 'b'.repeat(64)),
    /not tied to its Miniflare worker identity/u,
  );
  assert.throws(
    () =>
      assertWorkerdApiProofTarget(
        direct,
        { ...app, surfaceProfile: 'full-stack' },
        worker,
        envelopeDigest,
      ),
    /omitted a required service binding/u,
  );
  const binding = { binding: 'VERTICAL_INVENTORY_WORKER', service: worker };
  assert.throws(
    () =>
      assertWorkerdApiProofTarget(direct, app, worker, envelopeDigest, binding),
    /not tied to its Miniflare worker identity/u,
  );
  const bound = {
    binding: binding.binding,
    bindingTarget: target,
    throughShell: { status: 200 },
  };
  assert.equal(
    assertWorkerdApiProofTarget(bound, app, worker, envelopeDigest, binding),
    'service-binding',
  );
  assert.throws(
    () =>
      assertWorkerdApiProofTarget(
        { ...bound, binding: 'OTHER_WORKER' },
        app,
        worker,
        envelopeDigest,
        binding,
      ),
    /does not match its deployed worker configuration/u,
  );
});

test('workerd correlation accepts reordered exact identity and binds each mixed-topology shell', async t => {
  const { verifyWorkerdRuntimeCorrelation } = await import(
    '../../browser-smoke/runtime-evidence.mjs'
  );
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const worker = 'fixture-inventory';
  const digest = 'a'.repeat(64);
  const identity = {
    buildMarker: '4'.repeat(64),
    releaseVersion: '1',
    sourceRevision: '5'.repeat(40),
    unitId: 'fixture/inventory',
  };
  const check = {
    id: 'rpc-readiness',
    method: 'POST',
    route: '/rpc',
    body: { jsonrpc: '2.0', id: 'proof', method: 'list', params: {} },
    expect: { id: 'proof', 'result.items.0.id': 'item' },
  };
  const app = {
    id: 'inventory',
    path: 'verticals/inventory',
    surfaceProfile: 'api-only',
    api: { protocol: 'rpc' },
    deploy: {
      cloudflare: { routes: { rpc: '/rpc' }, jsonSmokeChecks: [check] },
    },
  };
  const shells = [
    { id: 'shell-ui', path: 'apps/shell-ui', verticalRefs: ['catalog'] },
    { id: 'shell-api', path: 'apps/shell-api', verticalRefs: [] },
  ];
  write('topology/reference-topology.json', {
    shell: shells[0],
    shells: [shells[1]],
  });
  write('apps/shell-ui/.output/wrangler.json', { services: [] });
  const binding = { binding: 'INVENTORY_WORKER', service: worker };
  write('apps/shell-api/.output/wrangler.json', { services: [binding] });
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'proof',
      result: { items: [{ id: 'item' }] },
    }),
  );
  const response = {
    bodyBase64: body.toString('base64'),
    byteLength: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    status: 200,
  };
  const target = { appId: app.id, envelopeDigest: digest, worker };
  const modules = [
    {
      logicalPath: 'server/index.mjs',
      byteLength: 1,
      sha256: 'b'.repeat(64),
      type: 'ESModule',
    },
    {
      logicalPath: 'worker/__modern_bff_effect.js',
      byteLength: 1,
      sha256: 'c'.repeat(64),
      type: 'ESModule',
    },
  ];
  const report = {
    schemaVersion: 3,
    runtime: 'workerd',
    executions: [
      {
        appId: app.id,
        modulesRoot: 'verticals/inventory/.output',
        envelopeDigest: digest,
        identity: {
          unitId: identity.unitId,
          buildMarker: identity.buildMarker,
          sourceRevision: identity.sourceRevision,
          releaseVersion: identity.releaseVersion,
        },
        worker,
        main: 'server/index.mjs',
        modules,
      },
    ],
    apiProofs: [
      {
        ...check,
        appId: app.id,
        shellId: 'shell-ui',
        directTarget: target,
        direct: response,
      },
      {
        ...check,
        appId: app.id,
        shellId: 'shell-api',
        binding: binding.binding,
        bindingTarget: target,
        direct: response,
        throughShell: response,
      },
    ],
  };
  const reportPath =
    '.codex/reports/cloudflare-workerd-ssr/composition-proof.json';
  const location = {
    envelope: {
      envelopeDigest: digest,
      identity,
      artifacts: modules.map(({ logicalPath, byteLength, sha256 }) => ({
        logicalPath,
        byteLength,
        sha256,
        kind: 'file',
      })),
      surfaces: {
        uiClient: [],
        ssr: [],
        apiBackend: ['worker/__modern_bff_effect.js'],
      },
    },
  };
  write(reportPath, report);
  assert.notEqual(
    JSON.stringify(report.executions[0].identity),
    JSON.stringify(location.envelope.identity),
  );
  assert.deepEqual(report.executions[0].identity, location.envelope.identity);
  assert.equal(
    verifyWorkerdRuntimeCorrelation(root, app, location).apiProofCount,
    2,
  );
  for (const invalidIdentity of [
    ...Object.keys(identity).map(field => ({
      ...identity,
      [field]: `${identity[field]}-changed`,
    })),
    { ...identity, extra: 'unbound' },
    Object.fromEntries(
      Object.entries(identity).filter(([field]) => field !== 'unitId'),
    ),
    { ...identity, releaseVersion: 1 },
    [identity],
  ]) {
    const changed = structuredClone(report);
    changed.executions[0].identity = invalidIdentity;
    write(reportPath, changed);
    assert.throws(
      () => verifyWorkerdRuntimeCorrelation(root, app, location),
      /workerd execution identity is invalid/u,
    );
  }
  write(reportPath, report);
  write('apps/shell-api/.output/wrangler.json', { services: [] });
  assert.throws(
    () => verifyWorkerdRuntimeCorrelation(root, app, location),
    /not tied to its Miniflare worker identity/u,
  );
  write('apps/shell-api/.output/wrangler.json', { services: [binding] });
  write(reportPath, {
    ...report,
    apiProofs: [
      report.apiProofs[0],
      { ...report.apiProofs[1], shellId: 'shell-ui' },
    ],
  });
  assert.throws(
    () => verifyWorkerdRuntimeCorrelation(root, app, location),
    /do not exactly match configured shell JSON smoke checks/u,
  );
});

test('fails when the SSR route is not healthy', async () => {
  const { createSmokeTargets, validateHttpTarget } = await loadSmoke();
  const [target] = createSmokeTargets(createContract()).targets;
  const routes = successRoutes();
  routes['/en'] = {
    body: 'broken',
    status: 500,
  };

  await assert.rejects(
    () => validateHttpTarget(target, { fetchImpl: createFetch(routes) }),
    /SSR route returned HTTP 500/,
  );
});

test('finds duplicate stylesheet hrefs in browser validation', async () => {
  const { findDuplicateStylesheetHrefs } = await loadSmoke();
  const duplicateHref = 'https://shell.example/static/app.css';

  assert.deepEqual(
    findDuplicateStylesheetHrefs([
      duplicateHref,
      'https://remote.example/static/remote.css',
      duplicateHref,
    ]),
    [{ count: 2, href: duplicateHref }],
  );
});
