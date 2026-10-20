import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveUltramodernSourceRevision } from '../../packages/solutions/app-tools-extensions/src/release-identity.ts';
import { createOctaneWorkerFederationFixtures } from '../../tests/ultramodern-renderers/octane-federation-workers/fixtures.mjs';
import {
  assertPackedWorkerSource,
  generatePackedWorkerWorkspace,
  packedWorkerDependencies,
  packedWorkerProofContext,
  preparePackedWorkerSource,
  runPackedNativeFederationWorkerProof,
  runWorkerCompilationCommand,
  verifyPackedWorkerProofEnvelope,
  verifyPackedWorkerProofResult,
  verifyPrebuiltWorkerServices,
} from './native-federation-worker.mjs';

test('Worker manifests preserve complete direct Start archives and reject partial selection', () => {
  const packageRequests = Object.fromEntries(
    [
      '@modern-js/ultramodern-app-tools',
      '@modern-js/renderer-core',
      '@modern-js/renderer-octane',
      '@modern-js/i18n-runtime-extensions',
      '@module-federation/enhanced',
      '@module-federation/node',
      'octane',
      '@octanejs/tanstack-router',
      '@octanejs/rspack-plugin',
      '@tsrx/oxc',
      'i18next',
    ].map(name => [name, '1.0.0']),
  );
  const core =
    'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-bbbbbbbbbbbb/tanstack-router-core-1.0.0.tgz';
  packageRequests['@tanstack/router-core'] = core;
  assert.equal(
    packedWorkerDependencies({ cohort: { artifacts: [] }, packageRequests })[
      '@tanstack/router-core'
    ],
    core,
  );
  delete packageRequests.i18next;
  assert.equal(
    packedWorkerDependencies({
      cohort: { artifacts: [] },
      packageRequests,
      release: {
        packages: [
          {
            sourceName: '@modern-js/i18n-runtime-extensions',
            packageJson: { devDependencies: { i18next: '26.1.3' } },
          },
        ],
      },
    }).i18next,
    '26.1.3',
  );
  packageRequests.i18next = '1.0.0';
  const start = Object.fromEntries(
    Object.entries({
      '@tanstack/start-storage-context': 'storage',
      '@tanstack/start-client-core': 'client',
      '@tanstack/start-server-core': 'server',
    }).map(([name, profile]) => [
      name,
      `https://github.com/BleedingDev/router/releases/download/ultramodern-start-${profile}-cccccccccccc/tanstack-${name.slice('@tanstack/'.length)}-1.0.0.tgz`,
    ]),
  );
  Object.assign(packageRequests, start);
  const dependencies = packedWorkerDependencies({
    cohort: { artifacts: [] },
    packageRequests,
  });
  for (const [name, request] of Object.entries(start))
    assert.equal(dependencies[name], request);
  delete packageRequests['@tanstack/start-client-core'];
  assert.throws(
    () =>
      packedWorkerDependencies({ cohort: { artifacts: [] }, packageRequests }),
    /Incomplete native Start closure/u,
  );
});

test('packed Worker builds derive their identity from the actual clean fixture commit', async t => {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run filesystem tests through owned-temp-dir',
  );
  const workRoot = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'worker-source-'),
  );
  t.after(() => fs.rmSync(workRoot, { recursive: true, force: true }));
  const directory = path.join(workRoot, 'workspace');
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, '.gitignore'),
    'node_modules/\ndist-cloudflare/\n',
  );
  fs.writeFileSync(
    path.join(directory, 'Widget.tsx'),
    'export const title = "actual authored source";\n',
  );
  fs.writeFileSync(
    path.join(directory, 'pnpm-lock.yaml'),
    'lockfileVersion: 9.0\n',
  );
  assert.equal(
    resolveUltramodernSourceRevision(directory, 'workspace', {}),
    'workspace',
  );

  // Hooks may pass another checkout's Git environment. Only the child command
  // environments are isolated; neither the caller nor its Git config changes.
  const inheritedRevision = 'a'.repeat(40);
  const sourceRevision = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { preparePackedWorkerSource } from ${JSON.stringify(new URL('./native-federation-worker.mjs', import.meta.url).href)};
      const revision = await preparePackedWorkerSource({
        directory: ${JSON.stringify(directory)},
        context: { workRoot: ${JSON.stringify(workRoot)} },
        signal: new AbortController().signal,
      });
      assert.equal(process.env.GIT_DIR, ${JSON.stringify(path.join(workRoot, 'foreign-git'))});
      assert.equal(process.env.ULTRAMODERN_SOURCE_REVISION, ${JSON.stringify(inheritedRevision)});
      process.stdout.write(revision);
    `,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_DIR: path.join(workRoot, 'foreign-git'),
        GIT_INDEX_FILE: path.join(workRoot, 'foreign-index'),
        ULTRAMODERN_SOURCE_REVISION: inheritedRevision,
      },
    },
  ).trim();
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  assert.equal(
    resolveUltramodernSourceRevision(directory, 'workspace', {}),
    sourceRevision,
  );
  assert.throws(
    () => resolveUltramodernSourceRevision(directory, inheritedRevision, {}),
    /does not match clean Git HEAD/u,
  );
  const options = {
    directory,
    context: { workRoot },
    sourceRevision,
    label: 'fixture',
    signal: new AbortController().signal,
  };
  fs.mkdirSync(path.join(directory, 'dist-cloudflare'));
  fs.writeFileSync(
    path.join(directory, 'dist-cloudflare', 'worker.js'),
    'built output',
  );
  assert.equal(await assertPackedWorkerSource(options), sourceRevision);
  fs.appendFileSync(
    path.join(directory, 'Widget.tsx'),
    'export const changed = true;\n',
  );
  assert.equal(
    resolveUltramodernSourceRevision(directory, 'workspace', {}),
    'workspace',
  );
  await assert.rejects(
    assertPackedWorkerSource({ ...options, label: 'changed-fixture' }),
    /Authored Worker sources changed/u,
  );
});

test('packed Worker source preparation rejects a linked foreign Git directory', async t => {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run filesystem tests through owned-temp-dir',
  );
  const workRoot = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'worker-foreign-source-'),
  );
  t.after(() => fs.rmSync(workRoot, { recursive: true, force: true }));
  const directory = path.join(workRoot, 'workspace');
  const foreign = path.join(workRoot, 'foreign');
  fs.mkdirSync(directory);
  fs.mkdirSync(foreign);
  for (const linked of [false, true]) {
    const gitDirectory = path.join(directory, '.git');
    if (linked) fs.symlinkSync(foreign, gitDirectory);
    else fs.writeFileSync(gitDirectory, `gitdir: ${foreign}\n`);
    await assert.rejects(
      preparePackedWorkerSource({
        directory,
        context: { workRoot },
        signal: new AbortController().signal,
      }),
      /The Worker fixture must own its Git directory/u,
    );
    fs.unlinkSync(gitDirectory);
  }
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('failed Worker commands preserve bounded compiler output after log cleanup', async t => {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run filesystem tests through owned-temp-dir',
  );
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'worker-command-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'deploy.log');
  let failure;
  await assert.rejects(
    runWorkerCompilationCommand(
      process.execPath,
      [
        '-e',
        'process.stderr.write("discarded-prefix\\n" + "x".repeat(32 * 1024) + "\\nactual-deploy-diagnostic\\n"); process.exit(7)',
      ],
      {
        cwd: directory,
        env: process.env,
        log,
        witness: path.join(directory, 'process.json'),
        signal: new AbortController().signal,
      },
    ),
    error => {
      failure = error;
      return error.cause?.code === 'ERR_ASSERTION' && error.cause.actual === 7;
    },
  );
  fs.rmSync(log);
  const evidence = failure.message.slice(
    failure.message.indexOf('[earlier output omitted]'),
  );
  assert.match(evidence, /actual-deploy-diagnostic/u);
  assert.match(evidence, /earlier output omitted/u);
  assert(!evidence.includes('discarded-prefix'));
  assert(failure.message.length < 18 * 1024);
});

test('real SDK Octane Worker contracts preserve authored and topology service bindings', async t => {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run filesystem tests through owned-temp-dir',
  );
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const workspaceRoot = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'worker-sdk-'),
  );
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  // The built SDK source checkout intentionally supports workspace mode only.
  // Installed execution separately exercises its exact packed install mode.
  const sdkRequire = createRequire(
    path.join(root, 'packages/toolkit/ultramodern-create/package.json'),
  );
  const sdk = sdkRequire('@modern-js/ultramodern-create/ultramodern-workspace');
  const plan = await generatePackedWorkerWorkspace({
    sdk,
    workspaceRoot: path.join(workspaceRoot, 'workspace'),
    options: {
      modernVersion: '3.9.3-ultramodern.9',
      enableTailwind: false,
      packageSource: { strategy: 'workspace' },
    },
  });
  const originals = [plan.topology.shell, ...plan.topology.verticals];
  for (const app of originals) {
    assert.equal(app.renderer, 'octane');
    assert.equal(app.rendererCapabilities.workers, true);
    assert.equal(app.cloudflare.target, 'cloudflare');
    assert.equal(app.cloudflare.assetsBinding, 'ASSETS');
    assert.match(app.cloudflare.workerName, /^[a-z0-9][a-z0-9-]{0,62}$/u);
  }
  const fixtureOptions = {
    ...plan,
    deploymentSource: 'authored',
    remoteOrigins: ['http://127.0.0.1:41001', 'http://127.0.0.1:41002'],
    dependencies: packedWorkerDependencies({
      cohort: { artifacts: [] },
      packageRequests: Object.fromEntries(
        [
          '@modern-js/ultramodern-app-tools',
          '@modern-js/renderer-octane',
          '@modern-js/renderer-core',
          '@modern-js/i18n-runtime-extensions',
          '@module-federation/enhanced',
          '@module-federation/node',
          '@octanejs/tanstack-router',
          '@octanejs/rspack-plugin',
          '@tsrx/oxc',
          'octane',
          'i18next',
        ].map(name => [name, name === '@tsrx/oxc' ? '0.20.0' : '1.0.0']),
      ),
    }),
  };
  assert.throws(
    () =>
      packedWorkerDependencies({
        cohort: { artifacts: [] },
        packageRequests: {},
      }),
    /consumer's declared/u,
  );
  const missingParser = { ...fixtureOptions.dependencies };
  delete missingParser['@tsrx/oxc'];
  assert.throws(
    () =>
      packedWorkerDependencies({
        cohort: { artifacts: [] },
        packageRequests: missingParser,
      }),
    /consumer's declared @tsrx\/oxc pin/u,
  );
  assert.throws(
    () =>
      createOctaneWorkerFederationFixtures({
        ...fixtureOptions,
        dependencies: missingParser,
      }),
    /Missing native fixture dependency @tsrx\/oxc/u,
  );
  fixtureOptions.sharedCounterPackage = '@authored-worker/shared-counter';
  fixtureOptions.dependencies[fixtureOptions.sharedCounterPackage] =
    'workspace:*';
  const fixture = createOctaneWorkerFederationFixtures(fixtureOptions);
  // Load the emitted config using the actual public preset, without installing
  // anything into the generated apps or mocking the public API.
  const publicApiOwner = pathToFileURL(
    path.join(root, 'packages/solutions/ultramodern-app-tools/package.json'),
  ).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(
        specifier,
        specifier === '@modern-js/ultramodern-app-tools'
          ? { ...context, parentURL: publicApiOwner }
          : context,
      );
    },
  });
  try {
    for (const [index, { app, files }] of fixture.applications.entries()) {
      assert.deepEqual(app.deliveryUnit, originals[index].deliveryUnit);
      assert.equal(
        JSON.parse(files['package.json']).dependencies[
          fixtureOptions.sharedCounterPackage
        ],
        'workspace:*',
      );
      assert(
        !JSON.parse(files['tsconfig.json']).include.includes(
          '../../shared/Counter.tsx',
        ),
      );
      assert(
        Object.values(files).some(value =>
          /from ['"]@authored-worker\/shared-counter['"]/u.test(value),
        ),
      );

      const generatedManifest = JSON.parse(
        fs.readFileSync(
          path.join(workspaceRoot, 'workspace', app.directory, 'package.json'),
          'utf8',
        ),
      );
      assert.equal(generatedManifest.dependencies['@tsrx/oxc'], '0.20.0');
      assert.deepEqual(
        JSON.parse(files['package.json']).modernjs,
        app.manifest.modernjs,
      );
      assert.equal(
        JSON.parse(files['package.json']).dependencies['@tsrx/oxc'],
        '0.20.0',
      );
      const filename = path.join(
        workspaceRoot,
        'workspace',
        app.directory,
        'worker-proof.config.ts',
      );
      fs.writeFileSync(filename, files['modern.config.ts']);
      const { default: config } = await import(pathToFileURL(filename).href);
      assert.equal(config.renderer, 'octane');
      assert.equal(config.deploy.target, 'cloudflare');
      assert.equal(config.deploy.worker.name, app.deployment.workerName);
      assert.equal(config.deploy.worker.ssr, true);
      assert.equal(config.output.distPath.root, 'dist-cloudflare');
      assert.deepEqual(config.server.publicDir, ['./locales', './assets']);
      assert.equal(config.html.outputStructure, 'flat');
      assert.equal(config.output.polyfill, 'off');
      assert.equal(config.output.splitRouteChunks, true);
      assert.equal(
        config.source.globalVars.ULTRAMODERN_SOURCE_REVISION,
        'workspace',
      );
      assert.equal(
        config.source.globalVars.ULTRAMODERN_BUILD_MARKER,
        app.deliveryUnit.buildMarker,
      );
      const output = {};
      const chainOutput = {
        uniqueName(value) {
          output.uniqueName = value;
          return this;
        },
        chunkLoadingGlobal(value) {
          output.chunkLoadingGlobal = value;
          return this;
        },
      };
      const bundlerHooks = Array.isArray(config.tools.bundlerChain)
        ? config.tools.bundlerChain
        : [config.tools.bundlerChain];
      for (const hook of bundlerHooks) hook({ output: chainOutput }, {});
      assert.equal(output.uniqueName, app.moduleFederationName);
      assert.match(
        output.chunkLoadingGlobal,
        /^__ULTRAMODERN_.*_LOADED_CHUNKS__$/u,
      );
      assert.equal(
        config.output.assetPrefix,
        index ? `http://127.0.0.1:${41000 + index}/` : '/',
      );
      assert.deepEqual(
        config.deploy.worker.services,
        index === 0 ? plan.services : (plan.remoteServices[app.id] ?? []),
      );
      assert.deepEqual(app.deployment, { workerName: app.id });
      assert.equal(originals[index].cloudflare.target, 'cloudflare');
    }
    const topologyFixture = createOctaneWorkerFederationFixtures({
      ...fixtureOptions,
      deploymentSource: 'topology',
      hostServiceSource: 'authored',
    });
    const topologyServices = plan.services.map((service, index) => ({
      ...service,
      binding:
        index === 0 ? 'VERTICAL_WORKER_A_WORKER' : 'VERTICAL_WORKER_B_WORKER',
      service: originals[index + 1].cloudflare.workerName,
    }));
    for (const [
      index,
      { app, files },
    ] of topologyFixture.applications.entries()) {
      const filename = path.join(
        workspaceRoot,
        'workspace',
        app.directory,
        'topology-worker-proof.config.ts',
      );
      fs.writeFileSync(filename, files['modern.config.ts']);
      const { default: config } = await import(pathToFileURL(filename).href);
      assert.equal(config.deploy.target, 'cloudflare');
      assert.equal(
        config.deploy.worker.name,
        originals[index].cloudflare.workerName,
      );
      assert.deepEqual(
        config.deploy.worker.services,
        index === 0
          ? [...topologyServices, ...plan.services]
          : (plan.remoteServices[app.id] ?? []),
      );
    }
  } finally {
    hooks.deregister();
  }
  const invalid = structuredClone(plan);
  delete invalid.host.deliveryUnit;
  assert.throws(
    () =>
      createOctaneWorkerFederationFixtures({ ...fixtureOptions, ...invalid }),
    /Authored Worker requires its original deliveryUnit package identity/u,
  );
});

const browserProof = () => ({
  ssrBeforeHydration: true,
  exactNodeAdoption: true,
  browserRecovery: true,
  ssrElapsedMs: 120,
});
const modes = [
  'unavailable',
  'headers-hang',
  'body-hang',
  'manifest-unavailable',
  'manifest-headers-hang',
  'manifest-body-hang',
  'foreign-manifest',
  'foreign-renderer',
  'foreign-request-authority',
  'foreign-response-authority',
  'foreign-native-publisher',
  'foreign-native-abi',
  'foreign-native-document',
  'foreign-native-boundary',
  'foreign-native-echo',
];
const completeProof = () => ({
  mode: 'packed',
  positive: Array.from({ length: 2 }, browserProof),
  concurrent: Array.from({ length: 4 }, browserProof),
  requestDigests: Array.from({ length: 4 }, (_, index) =>
    String(index).repeat(64),
  ),
  routes: Array.from({ length: 3 }, () => ({
    adopted: true,
    nestedDisposed: true,
    observed: [
      {
        appId: 'host',
        pathname: '/',
        language: 'en',
        greeting: 'hello',
        match: { id: 'root' },
        host: {
          appId: 'host',
          pathname: '/',
          language: 'en',
          greeting: 'hello',
          match: { id: 'root' },
        },
      },
    ],
  })),
  hops: [
    {
      routes: ['/en/', '/cs/'],
      requests: [
        { method: 'POST', status: 200 },
        { method: 'POST', status: 200 },
      ],
    },
  ],
  counterCompilations: [{}, {}, {}],
  faults: modes.map(mode => ({
    mode,
    proof: browserProof(),
    activeRequests: 0,
    cancellations: 1,
    requests: [
      {
        mode,
        method: mode.startsWith('manifest-') ? 'GET' : 'POST',
        mutation: mode,
      },
    ],
  })),
});

test('the installed Worker receipt requires actual isolation, browser, hop and cancellation observations', () => {
  assert(
    Object.values(verifyPackedWorkerProofResult(completeProof())).every(
      Boolean,
    ),
  );
  for (const field of [
    'positive',
    'concurrent',
    'routes',
    'hops',
    'counterCompilations',
    'faults',
  ]) {
    const incomplete = completeProof();
    incomplete[field] = [];
    assert.throws(() => verifyPackedWorkerProofResult(incomplete));
  }
  for (const mutate of [
    result => {
      result.mode = 'source';
    },
    result => {
      result.requestDigests[0] = result.requestDigests[1];
    },
    result => {
      result.positive[0].ssrBeforeHydration = false;
    },
    result => {
      result.positive[0].exactNodeAdoption = false;
    },
    result => {
      result.routes[0].observed[0].host.language = 'cs';
    },
    result => {
      result.hops[0].requests = [];
    },
    result => {
      result.faults[1].cancellations = 0;
    },
    result => {
      result.faults[0].activeRequests = 1;
    },
    result => {
      result.faults[0] = result.faults[1];
    },
  ]) {
    const result = completeProof();
    mutate(result);
    assert.throws(() => verifyPackedWorkerProofResult(result));
  }
});

test('a stale proof from another run or release cannot admit a Worker receipt', () => {
  const binding = {
    sourceRevision: 'a'.repeat(40),
    releaseVersion: '3.9.3-ultramodern.8',
    manifestSha256: 'b'.repeat(64),
    frameworkCohortDigest: 'c'.repeat(64),
  };
  const nonce = '11111111-1111-4111-8111-111111111111';
  const envelope = {
    schemaVersion: 1,
    binding,
    nonce,
    result: completeProof(),
    evidence: Array.from({ length: 10 }, () => ({})),
  };
  assert(
    Object.values(
      verifyPackedWorkerProofEnvelope(envelope, { binding, nonce }),
    ).every(Boolean),
  );
  assert.throws(() =>
    verifyPackedWorkerProofEnvelope(envelope, {
      binding,
      nonce: '22222222-2222-4222-8222-222222222222',
    }),
  );
  assert.throws(() =>
    verifyPackedWorkerProofEnvelope(envelope, {
      binding: { ...binding, sourceRevision: 'd'.repeat(40) },
      nonce,
    }),
  );
  assert.throws(() =>
    verifyPackedWorkerProofEnvelope(
      { ...envelope, evidence: [] },
      { binding, nonce },
    ),
  );
});

test('the prebuilt host uses only genuine preset bindings and preserves the remote hop', () => {
  const services = [
    {
      role: 'host',
      wrangler: {
        services: [
          { binding: 'VERTICAL_A_WORKER', service: 'worker-a' },
          { binding: 'VERTICAL_B_WORKER', service: 'worker-b' },
        ],
      },
    },
    {
      role: 'remote',
      remote: 'a',
      wrangler: { services: [{ binding: 'REMOTE_B', service: 'worker-b' }] },
    },
    { role: 'remote', remote: 'b', wrangler: { services: [] } },
  ];
  assert.equal(
    verifyPrebuiltWorkerServices(services, ['worker-a', 'worker-b']).length,
    3,
  );
  const duplicate = structuredClone(services);
  duplicate[0].wrangler.services.push({
    binding: 'AUTHORED_A',
    service: 'worker-a',
  });
  assert.throws(() =>
    verifyPrebuiltWorkerServices(duplicate, ['worker-a', 'worker-b']),
  );
  const missingHop = structuredClone(services);
  missingHop[1].wrangler.services = [];
  assert.throws(() =>
    verifyPrebuiltWorkerServices(missingHop, ['worker-a', 'worker-b']),
  );
});

test('packed Worker API requires native archives before creating proof resources', async () => {
  await assert.rejects(
    runPackedNativeFederationWorkerProof({ renderer: 'octane' }),
    /requires authenticated native archives/u,
  );
});

test('packed Worker child context preserves each exact native archive request and integrity', () => {
  const nativeInputs = Object.fromEntries(
    [
      'octane',
      '@octanejs/tanstack-router',
      '@octanejs/rspack-plugin',
      '@tanstack/router-core',
    ].map((name, index) => [
      name,
      {
        request: `https://example.test/accepted-${index}.tgz`,
        archivePath: `/owned/native-${index}.tgz`,
        integrity: `sha512-accepted-${index}`,
      },
    ]),
  );
  const context = packedWorkerProofContext({
    nativeInputs,
    proofNonce: 'owned-proof',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context)), {
    nativeInputs,
    proofNonce: 'owned-proof',
  });
  const missing = { ...nativeInputs };
  delete missing['@tanstack/router-core'];
  assert.throws(
    () => packedWorkerProofContext({ nativeInputs: missing }),
    /missing native archive @tanstack\/router-core/u,
  );
});
