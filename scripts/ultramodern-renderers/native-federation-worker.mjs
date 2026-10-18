import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOctaneWorkerFederationFixtures } from '../../tests/ultramodern-renderers/octane-federation-workers/fixtures.mjs';
import {
  readWorkerFixturePlan,
  runWorkerFixtureProof,
} from '../../tests/ultramodern-renderers/octane-federation-workers/proof.mjs';
import { confinedPath } from '../lib/file-evidence.mjs';
import { reservePort } from '../ultramodern-production-readiness/renderer-mf-lifecycle-proof/runtime.mjs';
import {
  installedBin,
  preparePackedNativeFederationWorkspace,
  readPackedNativeFederationContext,
  runPackedNativeFederationCommand,
  runPackedNativeFederationProof,
  verifyPackedNativeFederationDependencies,
  verifyPackedNativeFederationInputs,
} from './native-federation-packed.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const digest = filename =>
  createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

const requiredFaults = [
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

/** Only complete results from the original workerd/browser proof admit a receipt. */
export function verifyPackedWorkerProofResult(result) {
  assert.equal(result.mode, 'packed');
  assert.equal(result.positive.length, 2);
  assert.equal(result.concurrent.length, 4);
  assert(result.routes.length >= 3 && result.hops.length >= 1);
  assert.equal(result.counterCompilations.length, 3);
  const modes = result.faults.map(fault => fault.mode).toSorted();
  assert.deepEqual(modes, requiredFaults.toSorted());
  const consumers = [...result.positive, ...result.concurrent];
  const checks = {
    requestIsolation:
      result.requestDigests?.length >= 4 &&
      result.requestDigests.every(value => /^[a-f0-9]{64}$/u.test(value)) &&
      new Set(result.requestDigests).size === result.requestDigests.length,
    ssrBeforeHydration: consumers.every(
      proof => proof.ssrBeforeHydration === true,
    ),
    cancellation: result.faults
      .filter(fault => fault.mode.endsWith('-hang'))
      .every(fault => {
        const method = fault.mode.startsWith('manifest-') ? 'GET' : 'POST';
        const pending = fault.requests.filter(
          request => request.mode === fault.mode && request.method === method,
        );
        return (
          pending.length > 0 &&
          fault.cancellations === pending.length &&
          fault.activeRequests === 0
        );
      }),
    boundedRecovery: result.faults.every(
      fault =>
        fault.proof.browserRecovery === true &&
        fault.proof.ssrElapsedMs < 5000 &&
        fault.activeRequests === 0,
    ),
    retainedHydration: consumers.every(
      proof => proof.exactNodeAdoption === true,
    ),
    nestedNativeContext:
      result.routes.some(route => route.nestedDisposed === true) &&
      result.routes.every(
        route =>
          route.adopted === true &&
          route.observed.length > 0 &&
          route.observed.every(
            observation =>
              observation.appId === observation.host.appId &&
              observation.pathname === observation.host.pathname &&
              observation.language === observation.host.language &&
              observation.greeting === observation.host.greeting &&
              JSON.stringify(observation.match) ===
                JSON.stringify(observation.host.match),
          ),
      ) &&
      result.hops.every(
        hop =>
          hop.routes.length > 0 &&
          hop.requests.filter(
            request => request.method === 'POST' && request.status === 200,
          ).length >= hop.routes.length,
      ),
    foreignAuthorityRejection: result.faults
      .filter(fault => fault.mode.startsWith('foreign-'))
      .every(
        fault =>
          fault.proof.browserRecovery === true &&
          fault.requests.some(request => request.mutation),
      ),
  };
  for (const [check, passed] of Object.entries(checks))
    assert.equal(passed, true, `Worker proof did not establish ${check}.`);
  return checks;
}

/** Reject receipts from any other run or authenticated publication. */
export function verifyPackedWorkerProofEnvelope(envelope, { binding, nonce }) {
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(envelope.binding, binding);
  assert.equal(envelope.nonce, nonce);
  assert.match(nonce, /^[a-f0-9-]{36}$/u);
  assert(
    envelope.evidence.length >= 10,
    'Worker evidence must include the plan, process witnesses and installed locks.',
  );
  return verifyPackedWorkerProofResult(envelope.result);
}

/** Inspect genuine preset output, rejecting duplicate or missing service owners. */
export function verifyPrebuiltWorkerServices(applications, remoteNames) {
  const host = applications.find(application => application.role === 'host');
  const remotes = applications.filter(
    application => application.role === 'remote',
  );
  assert.equal(remotes.length, 2);
  const expectedTargets = [remoteNames, remoteNames.slice(1), []];
  const evidence = [host, ...remotes].map((application, index) => {
    const services = application.wrangler.services ?? [];
    assert.equal(services.length, expectedTargets[index].length);
    assert.equal(
      new Set(services.map(service => service.binding)).size,
      services.length,
    );
    assert.deepEqual(
      services.map(service => service.service).toSorted(),
      expectedTargets[index].toSorted(),
    );
    return { role: application.role, remote: application.remote, services };
  });
  return evidence;
}

/** Serve the compiler's genuine client publication while dependent apps build. */
async function serveCompiledAssets(application) {
  const root =
    application.clientRoot ??
    application.buildRoot ??
    path.join(application.appRoot, 'dist-cloudflare');
  const origin = new URL(application.origin);
  assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(origin.protocol, 'http:');
  const server = http.createServer((request, response) => {
    try {
      assert(['GET', 'HEAD'].includes(request.method));
      const url = new URL(request.url, application.origin);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const filename = confinedPath(root, relative);
      assert(fs.statSync(filename).isFile());
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader(
        'content-type',
        {
          '.json': 'application/json',
          '.js': 'text/javascript',
          '.mjs': 'text/javascript',
          '.css': 'text/css',
          '.wasm': 'application/wasm',
        }[path.extname(filename)] ?? 'application/octet-stream',
      );
      if (request.method === 'HEAD') response.end();
      else {
        const body = fs.createReadStream(filename);
        body.on('error', () => response.destroy());
        response.once('close', () => body.destroy());
        body.pipe(response);
      }
    } catch {
      response.writeHead(404);
      response.end('No emitted Worker asset');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(origin.port), origin.hostname, resolve);
  });
  return async () => {
    const closed = new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  };
}

/** Compile actual installed apps; no fixture may substitute a fabricated output plan. */
export async function buildCompiledWorkerApplications({
  applications,
  context,
  signal,
}) {
  assert.equal(applications.filter(app => app.role === 'host').length, 1);
  assert.equal(applications.filter(app => app.role === 'remote').length, 2);
  const ordered = [
    ...applications.filter(app => app.role === 'remote').toReversed(),
    applications.find(app => app.role === 'host'),
  ];
  const closeServers = [];
  let failure;
  const cleanupErrors = [];
  try {
    for (const [index, application] of ordered.entries()) {
      signal?.throwIfAborted();
      verifyPackedNativeFederationDependencies({
        appRoot: application.appRoot,
        cohort: context.cohort,
        dependencyNames: application.dependencyNames,
        packageIdentities: context.packageIdentities,
      });
      for (const [label, args] of [
        ['build', ['build']],
        ['deploy', ['deploy', '--skip-build']],
      ])
        await runPackedNativeFederationCommand(
          process.execPath,
          [installedBin(application.appRoot), ...args],
          {
            witness: path.join(
              context.workRoot,
              `worker-${index}-${label}-process.json`,
            ),
            cwd: application.appRoot,
            env: {
              ...process.env,
              NODE_PATH: '',
              NODE_ENV: 'production',
              PORT: new URL(application.origin).port,
            },
            log: path.join(context.workRoot, `worker-${index}-${label}.log`),
            signal,
          },
        );
      if (application.role === 'remote')
        closeServers.push(await serveCompiledAssets(application));
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const close of closeServers.reverse())
      try {
        await close();
      } catch (error) {
        cleanupErrors.push(error);
      }
  }
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Installed Worker compilation failed.',
    );
  return applications.map(application => {
    const buildRoot =
      application.buildRoot ??
      path.join(application.appRoot, 'dist-cloudflare');
    const outputRoot =
      application.outputRoot ?? path.join(application.appRoot, '.output');
    return {
      ...application,
      buildRoot,
      clientRoot: application.clientRoot ?? buildRoot,
      outputRoot,
      manifestPath:
        application.manifestPath ?? path.join(buildRoot, 'mf-manifest.json'),
      wranglerPath:
        application.wranglerPath ?? path.join(outputRoot, 'wrangler.json'),
    };
  });
}

function writeFiles(directory, files) {
  for (const [relative, content] of Object.entries(files)) {
    const filename = confinedPath(directory, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  }
}

/** Generate identities through the SDK; author deployment coordinates separately. */
export async function generatePackedWorkerWorkspace({
  sdk,
  workspaceRoot,
  options,
}) {
  await sdk.generateUltramodernWorkspace({
    ...options,
    targetDir: workspaceRoot,
    packageName: 'packed-worker-federation',
    renderer: 'octane',
    generateAgentFiles: false,
  });
  for (const name of ['worker-a', 'worker-b'])
    await sdk.addUltramodernVertical({
      ...options,
      workspaceRoot,
      name,
      preset: 'ui-only',
      renderer: 'octane',
    });
  const topology = readJson(
    path.join(workspaceRoot, 'topology/reference-topology.json'),
  );
  assert.equal(topology.verticals.length, 2);
  const descriptor = app => {
    const manifest = readJson(
      path.join(workspaceRoot, app.path, 'package.json'),
    );
    assert.equal(app.renderer, 'octane');
    assert.equal(manifest.modernjs?.appId, app.id);
    assert.equal(manifest.name, app.package);
    assert.equal(app.rendererIdentity?.appId, app.id);
    assert.equal(app.deliveryUnit?.packageName, manifest.name);
    return {
      id: app.id,
      directory: app.path,
      renderer: app.renderer,
      deliveryUnit: app.deliveryUnit,
      deployment: { workerName: app.id },
      moduleFederationName: app.moduleFederation.name,
      packageName: manifest.name,
      exposes: { './Widget': './src/components/Widget.tsx' },
      manifest: {
        name: manifest.name,
        version: manifest.version,
        modernjs: manifest.modernjs,
      },
    };
  };
  const host = descriptor(topology.shell);
  const remotes = topology.verticals.map(descriptor);
  const service = app => ({
    binding: `REMOTE_${app.id.replace(/\W/gu, '_').toUpperCase()}`,
    service: app.deployment.workerName,
    fragments: [
      {
        remote: app.id,
        expose: './Widget',
        boundaryId: app.moduleFederationName,
        path: '/{locale}/_mf/fragment/widget',
      },
    ],
  });
  return {
    topology,
    host,
    remotes,
    services: remotes.map(service),
    remoteServices: { [remotes[0].id]: [service(remotes[1])] },
  };
}

/** Preserve the seed's exact native compiler peers in every authored app. */
export function packedWorkerDependencies({ cohort, packageRequests }) {
  const dependencies = {};
  for (const name of [
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
  ]) {
    const artifact = cohort.artifacts.find(value => value.sourceName === name);
    if (artifact)
      dependencies[name] = `npm:${artifact.targetName}@${artifact.version}`;
    else {
      const request = packageRequests[name];
      assert(
        typeof request === 'string',
        `Installed Worker acceptance requires the consumer's declared ${name} pin.`,
      );
      dependencies[name] = request;
    }
  }
  return dependencies;
}

async function provePackedWorkers(context, input, signal) {
  const actualBinding = {
    sourceRevision: context.cohort.sourceRevision,
    releaseVersion: context.release.release.version,
    manifestSha256: context.cohort.manifestSha256,
    frameworkCohortDigest: context.cohort.cohortDigest,
  };
  assert.deepEqual(input.proofBinding, actualBinding);
  assert.match(input.proofNonce, /^[a-f0-9-]{36}$/u);
  const generatorRequire = createRequire(
    path.join(context.generatorConsumerRoot, 'package.json'),
  );
  verifyPackedNativeFederationDependencies({
    appRoot: context.generatorConsumerRoot,
    cohort: context.cohort,
  });
  const target = context.release.createPackage.targetName;
  const sdk = generatorRequire(`${target}/ultramodern-workspace`);
  const workspaceRoot = path.join(context.workRoot, 'workspace');
  const options = {
    modernVersion: context.release.release.version,
    enableTailwind: false,
    packageSource: {
      strategy: 'install',
      modernPackageVersion: context.release.release.version,
      registry: process.env.npm_config_registry,
      aliasScope: context.release.targetScope,
      aliasPackageNamePrefix: 'modern-js-',
    },
  };
  const { host, remotes, services, remoteServices } =
    await generatePackedWorkerWorkspace({ sdk, workspaceRoot, options });
  const origins = await Promise.all(
    [host, ...remotes].map(
      async () => `http://127.0.0.1:${await reservePort()}`,
    ),
  );
  const dependencies = packedWorkerDependencies(context);
  const sharedPackageName = '@authored-worker/shared-counter';
  const fixture = createOctaneWorkerFederationFixtures({
    host,
    remotes,
    remoteOrigins: origins.slice(1),
    dependencies: { ...dependencies, [sharedPackageName]: 'workspace:*' },
    sharedCounterPackage: sharedPackageName,
    services,
    remoteServices,
    deploymentSource: 'authored',
  });
  const sharedPackage = {
    name: sharedPackageName,
    directory: path.join(workspaceRoot, 'shared'),
    files: fixture.shared,
  };
  for (const { app, files } of fixture.applications) {
    const appRoot = path.join(workspaceRoot, app.directory);
    // This row proves ordinary authored workspace apps. Public generation is separate.
    fs.rmSync(path.join(appRoot, 'src'), { recursive: true });
    writeFiles(appRoot, files);
  }
  const installedRoots = await preparePackedNativeFederationWorkspace({
    directory: workspaceRoot,
    applications: fixture.applications.map(({ app }) =>
      path.join(workspaceRoot, app.directory),
    ),
    sharedPackage,
    context,
    signal,
    installerWitnessPath: path.join(
      context.workRoot,
      'process-witnesses',
      '0.json',
    ),
  });
  const applications = [];
  for (const [index, { app }] of fixture.applications.entries()) {
    const appRoot = path.join(workspaceRoot, app.directory);
    // Load the renderer's real native compiler, including its optional parser peer,
    // from this freshly installed app before starting any Worker compilation.
    const rendererRequire = createRequire(
      fs.realpathSync(
        path.join(
          appRoot,
          'node_modules/@modern-js/renderer-octane/package.json',
        ),
      ),
    );
    assert.equal(
      typeof rendererRequire('@octanejs/rspack-plugin')
        .getOctaneRspackBuildInfo,
      'function',
    );
    applications.push({
      role: index === 0 ? 'host' : 'remote',
      ...(index ? { remote: app.id } : {}),
      dependencyNames: Object.keys(installedRoots[index]),
      appRoot,
      origin: origins[index],
    });
  }
  const compiled = await buildCompiledWorkerApplications({
    applications,
    context,
    signal,
  });
  const planPath = path.join(context.workRoot, 'compiled-worker-plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: 'packed',
      applications: compiled,
      routes: fixture.routes,
      hops: fixture.hops,
      sharedCounterPath: path.join(workspaceRoot, 'shared/Counter.tsx'),
      generatorPackageRoot: fs.realpathSync(
        path.join(context.generatorConsumerRoot, 'node_modules', target),
      ),
      generatorConsumerRoot: context.generatorConsumerRoot,
      browserDependencyRoot: context.browserDependencyRoot,
      browserExecutable: context.browserExecutable,
    }),
  );
  const plan = readWorkerFixturePlan(planPath);
  const workerServices = verifyPrebuiltWorkerServices(
    plan.applications,
    remotes.map(remote => remote.deployment.workerName),
  );
  const result = await runWorkerFixtureProof(plan, { signal });
  result.workerServices = workerServices;
  const files = [
    planPath,
    ...[0, 1, 2].flatMap(index =>
      ['build', 'deploy'].map(label =>
        path.join(context.workRoot, `worker-${index}-${label}-process.json`),
      ),
    ),
    path.join(workspaceRoot, 'pnpm-lock.yaml'),
    path.join(workspaceRoot, 'pnpm-workspace.yaml'),
    path.join(workspaceRoot, 'shared/package.json'),
    path.join(workspaceRoot, 'shared/Counter.tsx'),
    path.join(context.workRoot, 'process-witnesses', '0.json'),
  ];
  const evidence = files.map((filename, index) => {
    const copied = path.join(
      input.proofEvidenceDirectory,
      `${index}-${path.basename(filename)}`,
    );
    fs.copyFileSync(filename, copied, fs.constants.COPYFILE_EXCL);
    return {
      path: copied,
      sha256: digest(copied),
      sourcePath: path.relative(context.workRoot, filename),
    };
  });
  fs.writeFileSync(
    input.proofEvidencePath,
    `${JSON.stringify({ schemaVersion: 1, binding: actualBinding, nonce: input.proofNonce, result, evidence }, null, 2)}\n`,
    { flag: 'wx' },
  );
}

/** Preserve the exact authenticated native archive inputs across the child boundary. */
export function packedWorkerProofContext(context) {
  assert(
    context.nativeInputs,
    'Packed Worker proof requires authenticated native archives',
  );
  for (const name of [
    'octane',
    '@octanejs/tanstack-router',
    '@octanejs/rspack-plugin',
    '@tanstack/router-core',
  ])
    assert(
      context.nativeInputs[name],
      `Packed Worker proof is missing native archive ${name}`,
    );
  return { ...context };
}

/** The original proof and all process cleanup must pass before an acceptance receipt exists. */
export async function runPackedNativeFederationWorkerProof({
  receiptPath,
  binding,
  generatorConsumerRoot,
  browserDependencyRoot,
  browserExecutable,
  nativeInputs,
  ...options
}) {
  assert.equal(options.renderer, 'octane');
  const nativeContext = packedWorkerProofContext({ nativeInputs });
  verifyPackedNativeFederationInputs(options.consumerRoot, nativeInputs);
  assert(
    receiptPath && binding,
    'Worker acceptance needs its release receipt binding.',
  );
  const proofNonce = randomUUID();
  const proofEvidenceDirectory = `${receiptPath}.proof-${proofNonce}`;
  assert(
    !fs.existsSync(receiptPath),
    'Worker acceptance receipt already exists.',
  );
  const leaseRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  const relativeEvidence = path.relative(leaseRoot, proofEvidenceDirectory);
  assert(
    relativeEvidence &&
      !relativeEvidence.startsWith('..') &&
      !path.isAbsolute(relativeEvidence),
    'Worker evidence must belong to the active release lease.',
  );
  const proofEvidencePath = path.join(proofEvidenceDirectory, 'proof.json');
  assert(
    !path
      .resolve(proofEvidencePath)
      .startsWith(`${path.resolve(options.workDir)}${path.sep}`),
  );
  fs.mkdirSync(proofEvidenceDirectory, { mode: 0o700 });
  await runPackedNativeFederationProof({
    ...options,
    proofScript: fileURLToPath(import.meta.url),
    contextExtras: {
      ...nativeContext,
      generatorConsumerRoot,
      browserDependencyRoot,
      browserExecutable,
      proofEvidencePath,
      proofEvidenceDirectory,
      proofBinding: binding,
      proofNonce,
    },
    processWitnessPaths: [
      ...[0, 1, 2].flatMap(index =>
        ['build', 'deploy'].map(
          label => `worker-${index}-${label}-process.json`,
        ),
      ),
    ],
  });
  const envelope = readJson(proofEvidencePath);
  const checks = verifyPackedWorkerProofEnvelope(envelope, {
    binding,
    nonce: proofNonce,
  });
  for (const evidence of envelope.evidence) {
    assert.equal(path.dirname(evidence.path), proofEvidenceDirectory);
    assert.equal(digest(evidence.path), evidence.sha256);
  }
  const receipt = {
    status: 'passed',
    binding,
    checks,
    evidence: [
      ...envelope.evidence,
      ...[proofEvidencePath, options.log].map(filename => ({
        path: filename,
        sha256: digest(filename),
      })),
    ],
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return receipt;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const filename = process.env.ULTRAMODERN_MF_PACKED_CONTEXT;
  assert(
    filename,
    'Worker acceptance requires an authenticated installed cohort.',
  );
  const input = readJson(filename);
  const context = await readPackedNativeFederationContext(filename, 'octane');
  const controller = new AbortController();
  const interrupts = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(event => [
    event,
    () =>
      controller.abort(new Error(`Worker acceptance interrupted by ${event}`)),
  ]);
  for (const [event, handler] of interrupts) process.once(event, handler);
  try {
    await provePackedWorkers(context, input, controller.signal);
  } finally {
    for (const [event, handler] of interrupts)
      process.removeListener(event, handler);
  }
}
