const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('source and published ERP-10 require the same complete runtime acceptance', async () => {
  const { requiredAcceptanceResultIdsForMode } = await import(
    '../published-create-proof/acceptance-contract.mjs'
  );
  const required = [
    'registry-cohort-integrity',
    'native-create',
    'vertical-additions',
    'generate-lockfile',
    'dependency-closure-audit',
    'install',
    'pnpm-check',
    'build',
    'cloudflare-build',
    'topology',
    'module-federation',
    'api',
    'backend',
    ...['node', 'workerd'].flatMap(platform =>
      [
        'ssr',
        'browser-mf',
        'api',
        'backend',
        'backend-driven-ui',
        'failure-isolation',
        'release-identity',
      ].map(dimension => `${platform}-${dimension}`),
    ),
    'operational-independence',
  ];
  for (const mode of ['source', 'published']) {
    assert.deepEqual(requiredAcceptanceResultIdsForMode(mode), required);
  }
});

test('pinned YAML file parsing keeps lockfile document merging by default', async () => {
  const { parseYamlFile, YAML_SPECIFIER } = await import(
    '../published-create-proof/dependency-closure-audit.mjs'
  );
  const packageManager = {
    importers: { '.': { packageManagerDependencies: { pnpm: '12.11.2' } } },
    lockfileVersion: '9.0',
    packages: { 'pnpm@12.11.2': {} },
    snapshots: { 'pnpm@12.11.2': {} },
  };
  const workspace = {
    importers: { '.': { dependencies: { effect: '3.19.0' } } },
    lockfileVersion: '9.0',
    packages: { 'effect@3.19.0': {} },
    snapshots: { 'effect@3.19.0': {} },
  };
  const documents = [packageManager, workspace];
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'pnpm');
    assert.deepEqual(args, ['dlx', YAML_SPECIFIER, 'pnpm-lock.yaml']);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    return { status: 0, stdout: JSON.stringify(documents) };
  };
  assert.deepEqual(parseYamlFile('pnpm-lock.yaml', spawnImpl), {
    importers: {
      '.': {
        ...packageManager.importers['.'],
        ...workspace.importers['.'],
      },
    },
    lockfileVersion: '9.0',
    packages: { ...packageManager.packages, ...workspace.packages },
    snapshots: { ...packageManager.snapshots, ...workspace.snapshots },
  });
  assert.throws(
    () => parseYamlFile('pnpm-lock.yaml', spawnImpl, { singleDocument: true }),
    /Expected one YAML document/u,
  );
});

test('single-document YAML file parsing preserves mappings and parser errors', async () => {
  const { parseYamlFile } = await import(
    '../published-create-proof/dependency-closure-audit.mjs'
  );
  const workspace = {
    catalog: {
      '@modern-js/runtime': 'npm:@bleedingdev/modern-js-runtime@1.0.0',
    },
  };
  const parseOutput = stdout =>
    parseYamlFile('pnpm-workspace.yaml', () => ({ status: 0, stdout }), {
      singleDocument: true,
    });
  assert.deepEqual(parseOutput(JSON.stringify(workspace)), workspace);
  assert.equal(parseOutput('null'), null);
  assert.throws(() => parseOutput('[]'), /Expected one YAML document/u);
  assert.throws(
    () => parseOutput('invalid-json'),
    /Pinned YAML parser returned invalid JSON/u,
  );
});

test('acceptance topology binds app manifests and overlay without compact metadata', async t => {
  const {
    readWorkspaceAcceptanceArtifacts,
    assertTopologyAcceptance,
    assertModuleFederationAcceptance,
    assertApiAcceptance,
  } = await import('../published-create-proof/acceptance-assertions.mjs');
  const root = tempRoot('acceptance-canonical-topology-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write('apps/shell/package.json', { name: '@fixture/shell' });
  write('verticals/inventory/package.json', { name: '@fixture/inventory' });
  write('topology/reference-topology.json', {
    shell: {
      id: 'shell',
      kind: 'shell',
      path: 'apps/shell',
      package: '@fixture/shell',
      verticalRefs: ['inventory'],
      moduleFederation: { sharedContractVersion: 'mf-v1' },
    },
    verticals: [
      {
        id: 'inventory',
        kind: 'vertical',
        path: 'verticals/inventory',
        package: '@fixture/inventory',
        moduleFederation: {
          name: 'inventoryRemote',
          manifestUrl: 'http://localhost:4101/mf-manifest.json',
          exposes: ['./Route'],
          sharedContractVersion: 'mf-v1',
        },
        api: {
          bff: { prefix: '/inventory-api' },
          readiness: { endpoint: '/inventory/readiness' },
        },
        backendFederation: {
          versionBoundary: {
            api: { readiness: '/inventory-api/inventory/readiness' },
          },
        },
      },
    ],
  });
  write('topology/local-overlays/development.json', {
    ports: { shell: 4100, inventory: 4101 },
  });
  const artifacts = readWorkspaceAcceptanceArtifacts(root);
  assert.equal(artifacts.apps[1].package, '@fixture/inventory');
  assert.equal(
    assertTopologyAcceptance(artifacts, ['inventory']).appVerticalCount,
    1,
  );
  assert.equal(
    assertModuleFederationAcceptance(artifacts, ['inventory']).remoteCount,
    1,
  );
  assert.deepEqual(
    assertApiAcceptance(artifacts, ['inventory']).readinessRoutes,
    [{ appId: 'inventory', route: '/inventory-api/inventory/readiness' }],
  );
  assert.equal(
    fs.existsSync(path.join(root, '.modernjs/ultramodern.json')),
    false,
  );
  write('verticals/inventory/package.json', { name: '@foreign/inventory' });
  assert.throws(
    () => readWorkspaceAcceptanceArtifacts(root),
    /package identity/u,
  );
});

test('workspace check requires the installed backend proof command', async t => {
  const { assertWorkspaceCheckContract } = await import(
    '../published-create-proof/acceptance-assertions.mjs'
  );
  const root = tempRoot('acceptance-installed-proof-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    scripts: {
      check:
        'pnpm format:check && pnpm lint && pnpm typecheck && pnpm api:check:files && pnpm contract:check',
      'node:proof': 'ultramodern-create ultramodern backend-federation-proof',
    },
  };
  const file = path.join(root, 'package.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(assertWorkspaceCheckContract(root).requiredCommands.length, 5);
  manifest.scripts['node:proof'] =
    'node scripts/proof-node-backend-federation.mjs';
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(
    () => assertWorkspaceCheckContract(root),
    /already-built live outputs/u,
  );
});

function operationalEvidence(options) {
  const baselineIdentity = {
    buildMarker: 'baseline-marker',
    releaseVersion: '0.1.0',
    sourceRevision: options.baselineRef,
    unitId: 'acceptance/inventory',
  };
  const changedIdentity = {
    ...baselineIdentity,
    buildMarker: 'changed-marker',
    sourceRevision: options.changedRef,
  };
  const changedIdentities = {
    node: { ...changedIdentity, buildMarker: '3'.repeat(64) },
    cloudflare: { ...changedIdentity, buildMarker: '6'.repeat(64) },
  };
  const renderer = {
    rendererIdentity: {
      renderer: 'react',
      appId: options.changedId,
      entryName: 'main',
      protocolVersion: 1,
    },
    rendererProfile: {
      renderer: 'react',
      protocolVersion: 1,
      compiler: { name: '@rsbuild/plugin-react', version: '2.1.1' },
      hydration: { name: 'react-dom', version: '19.3.0' },
      router: {
        name: '@tanstack/react-router',
        version: '1.170.44',
        coreName: '@tanstack/router-core',
        coreVersion: '1.171.37',
      },
    },
    routerBindings: {
      main: {
        owner: '@fixture/router-owner',
        evidence: 'file-routes',
        defaultProvider: {
          framework: 'tanstack',
          name: '@tanstack/react-router',
          version: '1.170.44',
          coreName: '@tanstack/router-core',
          coreVersion: '1.171.37',
        },
        providers: [
          {
            framework: 'tanstack',
            name: '@tanstack/react-router',
            version: '1.170.44',
            coreName: '@tanstack/router-core',
            coreVersion: '1.171.37',
          },
        ],
      },
    },
  };
  const unchanged = digest => ({
    byteIdentical: true,
    envelopeIdentical: true,
    treeDigest: digest,
  });
  const comparison = target => ({
    target,
    changed: {
      changed: true,
      afterIdentity: changedIdentities[target],
      afterUi: {
        ...structuredClone(renderer),
        rendererIdentity: {
          ...renderer.rendererIdentity,
          buildId: changedIdentities[target].buildMarker,
        },
      },
      afterTreeDigest: `${target}-changed-tree`,
      beforeIdentity: baselineIdentity,
      beforeTreeDigest: `${target}-baseline-tree`,
      surfaces: Object.fromEntries(
        ['uiClient', 'ssr', 'apiBackend', 'backendFederation'].map(s => [
          s,
          {
            afterDigest: `${target}-${s}-changed`,
            beforeDigest: `${target}-${s}-baseline`,
            changed: true,
          },
        ]),
      ),
    },
    shell: unchanged(`${target}-shell-tree`),
    sibling: unchanged(`${target}-finance-tree`),
  });
  const servedBehavior = platform => {
    const identity =
      changedIdentities[platform === 'workerd' ? 'cloudflare' : 'node'];
    return {
      appId: options.changedId,
      baseUrls: {
        app: `http://127.0.0.1/${platform}/inventory`,
        shell: `http://127.0.0.1/${platform}/shell`,
      },
      identity: {
        build: identity.buildMarker,
        buildMarker: identity.buildMarker,
        sourceRevision: identity.sourceRevision,
        unitId: identity.unitId,
        version: identity.releaseVersion,
      },
      platform,
      result: 'pass',
      routes: { api: '/inventory-api/inventory', ssr: '/en', ui: '/en' },
      responses: {
        api: {
          bodySha256: '1'.repeat(64),
          contentType: 'application/json',
          status: 200,
          value: options.expectedApiValue,
        },
        ssr: {
          bodySha256: '2'.repeat(64),
          buildMarker: identity.buildMarker,
          contentType: 'text/html',
          status: 200,
        },
        // A hardcoded `value` here must not pass as observed UI output.
        ui: {
          bodySha256: '3'.repeat(64),
          boundaryId: 'verticalInventory',
          contentType: 'text/html',
          expose: './Widget',
          status: 200,
          value: options.expectedUiValue,
          visiblyRendered: true,
        },
      },
    };
  };
  return {
    schemaVersion: 1,
    kind: 'ultramodern-operational-independence-proof',
    result: 'pass',
    commits: {
      baseline: options.baselineRef,
      changed: options.changedRef,
      changedPaths: [
        'verticals/inventory/api/index.ts',
        'verticals/inventory/locales/en/inventory.json',
      ],
      ownerPath: 'verticals/inventory',
    },
    apps: {
      shell: { id: options.shellId },
      changed: { id: options.changedId },
      sibling: { id: options.siblingId },
    },
    targets: {
      node: {
        comparison: comparison('node'),
        servedBehavior: servedBehavior('node'),
      },
      cloudflare: {
        comparison: comparison('cloudflare'),
        servedBehavior: servedBehavior('workerd'),
      },
    },
    crossTarget: {
      equal: true,
      identity: {
        unitId: changedIdentity.unitId,
        sourceRevision: changedIdentity.sourceRevision,
        releaseVersion: changedIdentity.releaseVersion,
      },
      renderer,
      nodeIdentity: structuredClone(changedIdentities.node),
      cloudflareIdentity: structuredClone(changedIdentities.cloudflare),
    },
  };
}

// Guards a release published on fabricated runtime proof: acceptance must
// reject evidence whose served responses are absent, whose identity does not
// match the commit under test, or whose body was hardcoded instead of observed
// from the changed MicroVertical.
test('operational acceptance rejects missing, forged, and hardcoded served behavior', async () => {
  const { createOperationalIndependenceResultDetails } = await import(
    '../published-create-proof/acceptance-contract.mjs'
  );
  const baselineRevision = 'a'.repeat(40);
  const changedRevision = 'b'.repeat(40);
  const options = {
    baselineRef: baselineRevision,
    changedId: 'inventory',
    changedRef: changedRevision,
    expectedApiValue: 'Inventory C1 operational proof response',
    expectedUiValue:
      'C1 operational independence: inventory UI and localization moved together.',
    shellId: 'shell-super-app',
    siblingId: 'finance',
  };
  const create = evidence =>
    createOperationalIndependenceResultDetails({
      applicationSourceRevision: baselineRevision,
      changedRevision,
      evidence,
      evidencePath: path.resolve('/tmp/operational-evidence.json'),
      expectedApiValue: options.expectedApiValue,
      expectedChangedPaths: [
        'verticals/inventory/api/index.ts',
        'verticals/inventory/locales/en/inventory.json',
      ],
      expectedUiValue: options.expectedUiValue,
      mode: 'source',
    });

  assert.equal(
    create(operationalEvidence(options)).changedRevision,
    changedRevision,
  );
  const distinct = operationalEvidence(options);
  assert.notEqual(
    distinct.targets.node.comparison.changed.afterIdentity.buildMarker,
    distinct.targets.cloudflare.comparison.changed.afterIdentity.buildMarker,
  );
  assert.equal(create(distinct).changedRevision, changedRevision);

  for (const field of ['sourceRevision', 'unitId', 'releaseVersion']) {
    const foreign = operationalEvidence(options);
    const changed = foreign.targets.cloudflare.comparison.changed.afterIdentity;
    changed[field] = `foreign-${field}`;
    foreign.crossTarget.cloudflareIdentity[field] = changed[field];
    const servedField = field === 'releaseVersion' ? 'version' : field;
    foreign.targets.cloudflare.servedBehavior.identity[servedField] =
      changed[field];
    assert.throws(
      () => create(foreign),
      /comparison is incomplete|changed identities differ/u,
      field,
    );
  }
  for (const mutate of [
    ui => {
      ui.rendererProfile.compiler.version = '99.0.0';
    },
    ui => {
      ui.rendererProfile.router.coreVersion = '99.0.0';
    },
    ui => {
      ui.routerBindings.main.owner = '@foreign/router';
    },
  ]) {
    const foreign = operationalEvidence(options);
    mutate(foreign.targets.cloudflare.comparison.changed.afterUi);
    assert.throws(() => create(foreign), /changed identities differ/u);
  }
  const wrongOwnRenderer = operationalEvidence(options);
  wrongOwnRenderer.targets.cloudflare.comparison.changed.afterUi.rendererIdentity.buildId =
    wrongOwnRenderer.targets.node.comparison.changed.afterIdentity.buildMarker;
  assert.throws(
    () => create(wrongOwnRenderer),
    /cloudflare renderer identity does not match its own changed C1 identity/u,
  );
  const wrongOwnSsr = operationalEvidence(options);
  wrongOwnSsr.targets.cloudflare.servedBehavior.responses.ssr.buildMarker =
    wrongOwnSsr.targets.node.comparison.changed.afterIdentity.buildMarker;
  assert.throws(
    () => create(wrongOwnSsr),
    /cloudflare served behavior response probes are invalid/u,
  );
  const wrongOwnApi = operationalEvidence(options);
  wrongOwnApi.targets.cloudflare.servedBehavior.identity.build =
    wrongOwnApi.targets.node.comparison.changed.afterIdentity.buildMarker;
  assert.throws(
    () => create(wrongOwnApi),
    /cloudflare served behavior identity does not match/u,
  );

  const missing = operationalEvidence(options);
  delete missing.targets.node.servedBehavior;
  assert.throws(
    () => create(missing),
    /node served behavior is missing, degraded, skipped, or non-passing/u,
  );

  const forged = operationalEvidence(options);
  forged.targets.cloudflare.servedBehavior.identity.buildMarker = 'forged';
  assert.throws(
    () => create(forged),
    /cloudflare served behavior identity does not match the changed C1 identity/u,
  );

  const hardcoded = operationalEvidence(options);
  hardcoded.targets.node.servedBehavior.responses.ui.value =
    'hardcoded UI value';
  assert.throws(
    () => create(hardcoded),
    /node served behavior did not observe the exact C1 API and UI mutations/u,
  );
});

test('runtime cross-target coherence preserves separate native markers and exact release and MF declarations', async () => {
  const { runtimeIdentityBinding, releaseIdentityCoherence } = await import(
    '../published-create-proof/acceptance-contract.mjs'
  );
  const node = {
    apps: [
      {
        appId: 'inventory',
        unitId: 'acceptance/inventory',
        sourceRevision: 'a'.repeat(40),
        releaseVersion: '0.1.0',
        moduleFederation: { runtime: '2.9.1', enhanced: '2.9.1' },
        buildMarker: '3'.repeat(64),
      },
    ],
  };
  const workerd = structuredClone(node);
  workerd.apps[0].buildMarker = '6'.repeat(64);
  const binding = runtimeIdentityBinding(node, workerd);
  assert.equal(binding.node[0].buildMarker, '3'.repeat(64));
  assert.equal(binding.workerd[0].buildMarker, '6'.repeat(64));
  assert.deepEqual(releaseIdentityCoherence(node.apps[0]), {
    appId: 'inventory',
    unitId: 'acceptance/inventory',
    sourceRevision: 'a'.repeat(40),
    releaseVersion: '0.1.0',
    moduleFederation: { runtime: '2.9.1', enhanced: '2.9.1' },
  });
  for (const field of ['unitId', 'sourceRevision', 'releaseVersion']) {
    const foreign = structuredClone(workerd);
    foreign.apps[0][field] = `foreign-${field}`;
    assert.throws(
      () => runtimeIdentityBinding(node, foreign),
      /release identities differ/u,
      field,
    );
  }
  const foreignMf = structuredClone(workerd);
  foreignMf.apps[0].moduleFederation.runtime = '2.9.2';
  assert.throws(
    () => runtimeIdentityBinding(node, foreignMf),
    /release identities differ/u,
  );
  const absentUnit = structuredClone(workerd);
  delete absentUnit.apps[0].unitId;
  assert.throws(
    () => runtimeIdentityBinding(node, absentUnit),
    /release identities differ/u,
  );
  for (const marker of ['', undefined, ' padded ']) {
    const malformed = structuredClone(workerd);
    malformed.apps[0].buildMarker = marker;
    assert.throws(
      () => runtimeIdentityBinding(node, malformed),
      /build markers must each be present/u,
    );
  }
});

// Guards consumers installing a framework build whose Module Federation
// runtime can float: a range specifier must fail the release binding instead
// of shipping a host and remotes that resolve different runtimes.
test('artifact binding rejects non-exact Module Federation provenance', async () => {
  const { createReleaseArtifactBinding } = await import(
    '../published-create-proof/acceptance-contract.mjs'
  );
  const release = {
    source: { commit: 'a'.repeat(40), repository: 'BleedingDev/modern.js' },
    release: { tag: 'latest', version: '3.5.0-ultramodern.50' },
    packages: [
      {
        targetName: '@bleedingdev/modern-js-plugin-bff',
        version: '3.5.0-ultramodern.50',
        integrity: 'sha512-YWNjZXB0YW5jZQ==',
        packageJson: {
          dependencies: { '@module-federation/runtime': '^2.8.0' },
        },
      },
    ],
  };
  assert.throws(
    () => createReleaseArtifactBinding(release),
    /must use one exact Module Federation version/,
  );
});

// Guards publishing a cohort whose registry bytes are not the bytes that were
// verified: consumers would install a tarball nobody proved.
test('registry cohort verification fails closed when downloaded bytes differ', async () => {
  const { verifyRegistryCohort } = await import(
    '../published-create-proof/registry-cohort.mjs'
  );
  const root = tempRoot('acceptance-registry-cohort-');
  const pkg = {
    integrity: 'sha512-Y2FuZGlkYXRl',
    sha256: 'b'.repeat(64),
    shasum: 'c'.repeat(40),
    sourceName: '@modern-js/runtime',
    targetName: '@bleedingdev/modern-js-runtime',
    version: '3.5.0-ultramodern.50',
  };
  try {
    await assert.rejects(
      verifyRegistryCohort({
        release: { packages: [pkg] },
        registryUrl: 'https://registry.npmjs.org/',
        workDir: root,
        async runImpl(_command, args) {
          const destination = args[args.indexOf('--pack-destination') + 1];
          fs.writeFileSync(path.join(destination, 'stale.tgz'), 'stale');
          return JSON.stringify([{ filename: 'stale.tgz' }]);
        },
      }),
      /Registry tarball byte mismatch/,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

// Guards a published release whose lockfile resolves the framework cohort from
// a stale revision or a third-party registry: the consumer install would pull
// packages this release never produced.
test('cohort resolution provenance rejects stale revisions and foreign tarball origins', async () => {
  const { assertCohortResolutionProvenance } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const root = tempRoot('acceptance-cohort-provenance-');
  const release = {
    packages: [
      {
        targetName: '@bleedingdev/modern-js-runtime',
        version: '3.5.0-ultramodern.50',
        integrity: 'sha512-Y2FuZGlkYXRl',
      },
    ],
    release: { version: '3.5.0-ultramodern.50' },
    sidecars: {
      packages: [
        {
          name: '@bleedingdev/mf-bridge-react',
          version: '1.0.0',
          integrity: 'sha512-c2lkZWNhcg==',
        },
      ],
    },
    targetScope: 'bleedingdev',
  };
  const registryUrl = 'http://127.0.0.1:4879/';
  const writeLock = packages =>
    fs.writeFileSync(
      path.join(root, 'pnpm-lock.yaml'),
      JSON.stringify({ lockfileVersion: '9.0', packages }),
    );
  const parseJsonLock = filePath =>
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const provenance = () =>
    assertCohortResolutionProvenance(
      root,
      release,
      registryUrl,
      'source',
      parseJsonLock,
    );
  try {
    writeLock({
      '@bleedingdev/modern-js-runtime@3.5.0-ultramodern.49': {
        resolution: { integrity: 'sha512-Y2FuZGlkYXRl' },
      },
    });
    assert.throws(provenance, /is not the release revision/);

    writeLock({
      '@bleedingdev/modern-js-runtime@3.5.0-ultramodern.50': {
        resolution: {
          integrity: 'sha512-Y2FuZGlkYXRl',
          tarball: 'https://registry.evil.test/runtime.tgz',
        },
      },
    });
    assert.throws(provenance, /is not the release registry/);

    writeLock({
      '@bleedingdev/modern-js-runtime@3.5.0-ultramodern.50': {
        resolution: { integrity: 'sha512-Y2FuZGlkYXRl' },
      },
      '@bleedingdev/mf-bridge-react@1.0.0': {
        resolution: { integrity: 'sha512-c2lkZWNhcg==' },
      },
    });
    assert.equal(provenance().cohortPackageCount, 1);
    writeLock({
      '@bleedingdev/modern-js-runtime@3.5.0-ultramodern.50': {
        resolution: { integrity: 'sha512-Y2FuZGlkYXRl' },
      },
      '@bleedingdev/mf-bridge-react@1.0.1': {
        resolution: { integrity: 'sha512-c2lkZWNhcg==' },
      },
    });
    assert.throws(
      provenance,
      /Sidecar package .* is not the release revision/u,
    );
    writeLock({
      '@bleedingdev/modern-js-runtime@3.5.0-ultramodern.50': {
        resolution: { integrity: 'sha512-Y2FuZGlkYXRl' },
      },
      '@bleedingdev/unknown@1.0.0': {
        resolution: { integrity: 'sha512-c2lkZWNhcg==' },
      },
    });
    assert.throws(provenance, /outside the authenticated cohort and sidecars/u);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('published consumer provenance permits third-party tarballs from npm without relaxing cohort integrity', async t => {
  const { assertCohortResolutionProvenance } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const root = tempRoot('published-cohort-provenance-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = {
    targetScope: 'bleedingdev',
    release: { version: '3.11.3-ultramodern.10' },
    packages: [
      {
        targetName: '@bleedingdev/modern-js-runtime',
        integrity: 'sha512-Y2FuZGlkYXRl',
      },
    ],
  };
  const cohortKey = '@bleedingdev/modern-js-runtime@3.11.3-ultramodern.10';
  const lock = {
    packages: {
      [cohortKey]: { resolution: { integrity: release.packages[0].integrity } },
      'external@1.0.0': {
        resolution: {
          integrity: 'sha512-ZXh0ZXJuYWw=',
          tarball: 'https://registry.npmjs.org/external/-/external-1.0.0.tgz',
        },
      },
    },
  };
  const check = mode =>
    assertCohortResolutionProvenance(
      root,
      release,
      'https://registry.npmjs.org/',
      mode,
      () => lock,
    );
  assert.equal(check('published').cohortPackageCount, 1);
  assert.throws(() => check('source'), /Non-cohort package/u);
  lock.packages[cohortKey].resolution.integrity = 'sha512-Zm9yZ2Vk';
  assert.throws(() => check('published'), /authenticated manifest/u);
});

// Guards shipping a dependency younger than the release-age gate with no live
// human approval: an expired exception must block the publish.
