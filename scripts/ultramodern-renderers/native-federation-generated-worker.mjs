import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOctaneWorkerFederationFixtures } from '../../tests/ultramodern-renderers/octane-federation-workers/fixtures.mjs';
import {
  generatedWorkerCoordinates,
  generatedWorkerDeploymentInput,
} from '../../tests/ultramodern-renderers/octane-federation-workers/generated.mjs';
import {
  readWorkerFixturePlan,
  runWorkerFixtureProof,
} from '../../tests/ultramodern-renderers/octane-federation-workers/proof.mjs';
import { reservePort } from '../ultramodern-production-readiness/renderer-mf-lifecycle-proof/runtime.mjs';
import {
  nativeFederationPackageRequests,
  nativeStartArchiveRequests,
} from './native-federation-inputs.mjs';
import {
  installPackedNativeFederationDependencies,
  readPackedNativeFederationContext,
  runPackedNativeFederationCommand,
  runPackedNativeFederationProof,
  verifyPackedNativeFederationDependencies,
  verifyPackedNativeFederationInputs,
} from './native-federation-packed.mjs';
import {
  buildCompiledWorkerApplications,
  verifyPackedWorkerProofEnvelope,
  verifyPackedWorkerProofResult,
} from './native-federation-worker.mjs';
import { verifyWorkerFederationModule } from './native-federation-workers.mjs';
import {
  assertReleaseAgeExclusionsUnchanged,
  captureReleaseAgeExclusions,
} from './release-age-policy.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const digest = filename =>
  createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const generatedScript = fileURLToPath(
  new URL(
    '../../tests/ultramodern-renderers/octane-federation-workers/generated.mjs',
    import.meta.url,
  ),
);

/** Validate the exact public operations and captured native build identities. */
export function verifyGeneratedWorkerGeneration(generation) {
  const coordinates = [
    generatedWorkerCoordinates.host,
    ...generatedWorkerCoordinates.remotes,
  ];
  assert.equal(generation.origins.length, coordinates.length);
  assert.equal(new Set(generation.origins).size, coordinates.length);
  for (const value of generation.origins) {
    const origin = new URL(value);
    assert.equal(origin.origin, value);
    assert.equal(origin.hostname, '127.0.0.1');
    assert.equal(origin.protocol, 'http:');
  }
  assert.equal(generation.applications.length, coordinates.length);
  assert.equal(generation.operations.length, coordinates.length);
  for (const [index, coordinate] of coordinates.entries()) {
    const app = generation.applications[index];
    const operation = generation.operations[index];
    assert.equal(operation.operation, index ? 'vertical' : 'workspace');
    assert.deepEqual(operation.warnings, []);
    assert.equal(operation.createdApps.length, 1);
    for (const descriptor of [app, operation.createdApps[0]]) {
      for (const key of ['id', 'directory', 'moduleFederationName'])
        assert.equal(
          descriptor[key],
          coordinate[key],
          `Unexpected generated ${key}.`,
        );
      assert.equal(descriptor.renderer, 'octane');
    }
    assert.equal(app.buildIdentity.renderer, 'octane');
  }
  return true;
}

/** Check the compiler's remote publications against their actual public topology. */
export function verifyGeneratedWorkerPublications(publications, origins) {
  assert.equal(origins.length, 3);
  assert.equal(publications.length, generatedWorkerCoordinates.remotes.length);
  for (const [
    index,
    coordinate,
  ] of generatedWorkerCoordinates.remotes.entries()) {
    const publication = publications[index];
    assert.equal(publication.id, coordinate.id);
    assert.equal(publication.origin, origins[index + 1]);
    const origin = new URL(publication.origin);
    assert.equal(origin.hostname, '127.0.0.1');
    assert.equal(origin.protocol, 'http:');
    assert.equal(new URL(publication.publicPath).origin, origin.origin);
    assert.equal(new URL(publication.remoteEntry).origin, origin.origin);
    assert(
      publication.assets.length > 0,
      'A compiled remote must publish client assets.',
    );
    for (const asset of publication.assets)
      assert.equal(new URL(asset).origin, origin.origin);
  }
  return true;
}

/** The real preset must produce one topology-owned binding per host remote. */
export function verifyGeneratedWorkerServices(applications) {
  const coordinates = [
    generatedWorkerCoordinates.host,
    ...generatedWorkerCoordinates.remotes,
  ];
  assert.equal(applications.length, 3);
  for (const [index, app] of applications.entries()) {
    assert.equal(app.id, coordinates[index].id);
    assert.equal(
      new Set(app.services.map(service => service.binding)).size,
      app.services.length,
      'Worker binding names must remain unique.',
    );
    const expected =
      index === 0
        ? generatedWorkerCoordinates.remotes
        : index === 1
          ? [generatedWorkerCoordinates.remotes[1]]
          : [];
    assert.equal(app.services.length, expected.length);
    for (const remote of expected) {
      const service = app.services.find(
        item => item.service === `proof-${remote.id}`,
      );
      assert(service, `Missing real Worker service for ${remote.id}.`);
      assert.equal(
        service.binding,
        `VERTICAL_${remote.id.replaceAll('-', '_').toUpperCase()}_WORKER`,
      );
      const exposed = service.fragments
        .map(fragment => fragment.expose)
        .toSorted();
      assert.deepEqual(
        exposed,
        index === 0 ? ['./Route', './Widget'] : ['./Widget'],
      );
      for (const fragment of service.fragments) {
        assert.equal(fragment.remote, remote.id);
        assert.equal(fragment.boundaryId, remote.moduleFederationName);
        assert.equal(
          fragment.path,
          `/{locale}/_mf/fragment/${fragment.expose.slice(2).toLowerCase()}`,
        );
      }
    }
  }
  return true;
}

/** Every receipt check is derived from actual generation or transport observations. */
export function assertGeneratedWorkerResult(result) {
  const checks = verifyPackedWorkerProofResult(result);
  return {
    generatedPublicWorkspace:
      verifyGeneratedWorkerGeneration(result.generation) &&
      verifyGeneratedWorkerServices(result.generation.workerServices) &&
      verifyGeneratedWorkerPublications(
        result.publications,
        result.generation.origins,
      ),
    requestIsolation: checks.requestIsolation,
    ssrBeforeHydration: checks.ssrBeforeHydration,
    cancellation: checks.cancellation,
    boundedRecovery: checks.boundedRecovery,
    retainedHydration: checks.retainedHydration,
    nestedNativeContext: checks.nestedNativeContext,
    foreignAuthorityRejection: checks.foreignAuthorityRejection,
  };
}

export async function runPackedNativeFederationGeneratedWorkerProof(context) {
  const requests = nativeFederationPackageRequests(
    readJson(path.join(context.consumerRoot, 'package.json')),
  );
  nativeStartArchiveRequests(requests);
  verifyPackedNativeFederationInputs(
    context.consumerRoot,
    context.nativeInputs,
  );
  assert(context.receiptPath && context.binding);
  assert(path.isAbsolute(context.receiptPath));
  assert(!fs.existsSync(context.receiptPath));
  const proofNonce = randomUUID();
  const evidenceDirectory = `${context.receiptPath}.proof-${proofNonce}`;
  const leaseRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  const relative = path.relative(leaseRoot, evidenceDirectory);
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Generated Worker evidence must belong to the active release lease.',
  );
  const proofResultPath = path.join(evidenceDirectory, 'proof.json');
  const receiptRelative = path.relative(context.workDir, proofResultPath);
  assert(
    receiptRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(receiptRelative),
    'Persist generated Worker evidence outside the retired proof tree.',
  );
  fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
  await runPackedNativeFederationProof({
    ...context,
    renderer: 'octane',
    proofScript: fileURLToPath(import.meta.url),
    contextExtras: {
      generatorConsumerRoot: context.generatorConsumerRoot,
      browserDependencyRoot: context.browserDependencyRoot,
      browserExecutable: context.browserExecutable,
      nativeInputs: context.nativeInputs,
      generatedWorkerResultPath: proofResultPath,
      proofEvidenceDirectory: evidenceDirectory,
      proofBinding: context.binding,
      proofNonce,
    },
    processWitnessPaths: [
      'generated-install-process.json',
      ...[0, 1, 2].flatMap(index =>
        ['build', 'deploy'].map(
          label => `worker-${index}-${label}-process.json`,
        ),
      ),
    ],
  });
  const envelope = readJson(proofResultPath);
  verifyPackedWorkerProofEnvelope(envelope, {
    binding: context.binding,
    nonce: proofNonce,
  });
  const checks = assertGeneratedWorkerResult(envelope.result);
  for (const evidence of envelope.evidence) {
    assert.equal(path.dirname(evidence.path), evidenceDirectory);
    assert.equal(digest(evidence.path), evidence.sha256);
  }
  const receipt = {
    status: 'passed',
    binding: context.binding,
    checks,
    evidence: [
      ...envelope.evidence,
      ...[proofResultPath, context.log].map(filename => ({
        path: filename,
        sha256: digest(filename),
      })),
    ],
  };
  fs.writeFileSync(
    context.receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: 'wx' },
  );
  return receipt;
}

export function verifyGeneratedWorkerNativeRequests(manifest, packageRequests) {
  assert.deepEqual(
    nativeStartArchiveRequests(nativeFederationPackageRequests(manifest)),
    nativeStartArchiveRequests(packageRequests),
    'Public generator must emit the selected complete Native Start closure',
  );
}

export function generatedWorkerDependencies(context) {
  nativeStartArchiveRequests(context.packageRequests);
  const dependencies = {};
  for (const name of [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/renderer-octane',
    '@modern-js/renderer-core',
    '@modern-js/i18n-runtime-extensions',
    'octane',
    'i18next',
  ]) {
    const artifact = context.cohort.artifacts.find(
      item => item.sourceName === name,
    );
    dependencies[name] = artifact
      ? `npm:${artifact.targetName}@${artifact.version}`
      : context.packageRequests[name];
    assert(
      dependencies[name],
      `The installed source cohort must declare ${name}.`,
    );
    assert(!/^(?:workspace:|link:|file:)/u.test(dependencies[name]));
  }
  return dependencies;
}

/** A public generator invocation and ordinary install, followed by real workerd. */
export async function runGeneratedWorkerConsumer(context, { signal } = {}) {
  assert(
    context.generatorConsumerRoot,
    'Generated Workers need the installed public generator consumer.',
  );
  assert(
    context.browserDependencyRoot,
    'Generated Workers need the owned browser provider.',
  );
  const generatorArtifact = context.cohort.artifacts.find(
    item => item.sourceName === '@modern-js/ultramodern-create',
  );
  assert(generatorArtifact);
  const generatorConsumerRoot = fs.realpathSync(context.generatorConsumerRoot);
  const request = createRequire(
    path.join(generatorConsumerRoot, 'package.json'),
  );
  const generator = verifyWorkerFederationModule({
    request,
    specifier: `${generatorArtifact.targetName}/ultramodern-workspace`,
    sourceName: generatorArtifact.sourceName,
    cohort: context.cohort,
    consumerRoot: generatorConsumerRoot,
  });
  const dependencies = generatedWorkerDependencies(context);
  const ports = [];
  while (ports.length < 3) {
    const port = await reservePort();
    if (!ports.includes(port)) ports.push(port);
  }
  const origins = ports.map(port => `http://127.0.0.1:${port}`);
  const binding = (remote, index) => ({
    binding: `VERTICAL_REMOTE_${index ? 'B' : 'A'}_WORKER`,
    service: `proof-${remote.id}`,
    fragments: [
      {
        remote: remote.id,
        boundaryId: remote.moduleFederationName,
        expose: './Widget',
        path: '/{locale}/_mf/fragment/widget',
      },
    ],
  });
  const services = {
    host: generatedWorkerCoordinates.remotes.map(binding),
    remoteA: [binding(generatedWorkerCoordinates.remotes[1], 1)],
  };
  const workspaceRoot = path.join(context.workRoot, 'generated-workspace');
  const overlayRoot = path.join(context.workRoot, 'authored-worker-overlay');
  fs.mkdirSync(overlayRoot);
  fs.writeFileSync(
    path.join(overlayRoot, 'package.json'),
    JSON.stringify({
      name: 'authored-native-worker-consumer',
      version: '1.0.0',
      main: 'index.cjs',
    }),
  );
  // This is a normal public CodeSmith source-authoring overlay. It runs before
  // native config capture; it cannot mint identities or modify captured output.
  fs.writeFileSync(
    path.join(overlayRoot, 'index.cjs'),
    `module.exports = async context => { const { authorGeneratedWorkerApplication } = await import(${JSON.stringify(new URL('../../tests/ultramodern-renderers/octane-federation-workers/generated.mjs', import.meta.url).href)}); authorGeneratedWorkerApplication(context.config); };\n`,
  );
  const inputPath = path.join(context.workRoot, 'generation-input.json');
  const resultPath = path.join(context.workRoot, 'generation-result.json');
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      generatorConsumerRoot,
      generatorName: generatorArtifact.targetName,
      workspaceRoot,
      overlayRoot,
      origins,
      services,
      dependencies,
      resultPath,
      version: context.release.release.version,
      targetScope: context.release.targetScope,
    }),
  );
  await runPackedNativeFederationCommand(
    process.execPath,
    [generatedScript, inputPath],
    {
      witnessDirectory: path.join(context.workRoot, 'process-witnesses'),
      cwd: generatorConsumerRoot,
      env: { ...process.env, NODE_PATH: '' },
      log: path.join(context.workRoot, 'public-generation.log'),
      signal,
    },
  );
  const generation = readJson(resultPath);
  verifyGeneratedWorkerGeneration(generation);
  for (const app of generation.applications)
    verifyGeneratedWorkerNativeRequests(
      readJson(path.join(workspaceRoot, app.directory, 'package.json')),
      context.packageRequests,
    );
  const topology = readJson(
    path.join(workspaceRoot, 'topology/reference-topology.json'),
  );
  const topologyApps = [topology.shell, ...topology.verticals];
  for (const [index, app] of generation.applications.entries()) {
    const actual = topologyApps.find(item => item.id === app.id);
    assert(actual?.cloudflare?.publicUrlEnv);
    process.env[actual.cloudflare.publicUrlEnv] = origins[index];
    if (index)
      process.env[`VERTICAL_REMOTE_${index === 1 ? 'A' : 'B'}_WORKER_NAME`] =
        `proof-${app.id}`;
  }
  const releaseAgePolicy = captureReleaseAgeExclusions(workspaceRoot, {
    release: context.release,
  });
  await installPackedNativeFederationDependencies({
    directory: workspaceRoot,
    installerWitnessPath: path.join(
      context.workRoot,
      'generated-install-process.json',
    ),
    context,
    signal,
  });
  assertReleaseAgeExclusionsUnchanged(releaseAgePolicy);
  const cohortNames = new Set(
    context.cohort.artifacts.flatMap(item => [
      item.sourceName,
      item.targetName,
    ]),
  );
  const applications = generation.applications.map((app, index) => {
    const appRoot = path.join(workspaceRoot, app.directory);
    const manifest = readJson(path.join(appRoot, 'package.json'));
    const requests = nativeFederationPackageRequests(manifest);
    const dependencyNames = Object.keys(requests).filter(
      name =>
        cohortNames.has(name) ||
        /^(?:@module-federation\/|@octanejs\/|@tanstack\/(?:router-core|start-storage-context|start-client-core|start-server-core)$|octane$|i18next$|typescript$|@types\/node$)/u.test(
          name,
        ),
    );
    verifyPackedNativeFederationDependencies({
      appRoot,
      cohort: context.cohort,
      dependencyNames,
    });
    if (Object.keys(nativeStartArchiveRequests(requests)).length)
      verifyPackedNativeFederationInputs(appRoot, context.nativeInputs);
    return {
      role: index ? 'remote' : 'host',
      ...(index ? { remote: app.id } : {}),
      appRoot,
      origin: origins[index],
      dependencyNames,
      buildRoot: path.join(appRoot, 'dist-cloudflare'),
      clientRoot: path.join(appRoot, 'dist-cloudflare'),
    };
  });
  generation.workerServices = applications.map((application, index) => {
    const app = generation.applications[index];
    const appRequest = createRequire(
      path.join(application.appRoot, 'package.json'),
    );
    verifyWorkerFederationModule({
      request: appRequest,
      specifier: '@modern-js/ultramodern-app-tools',
      sourceName: '@modern-js/ultramodern-app-tools',
      cohort: context.cohort,
      consumerRoot: workspaceRoot,
    });
    const { presetUltramodernWorkspace } = appRequest(
      '@modern-js/ultramodern-app-tools',
    );
    const config = presetUltramodernWorkspace(
      {
        renderer: 'octane',
        server: { ssr: true },
        source: { mainEntryName: 'main' },
        deploy: generatedWorkerDeploymentInput(app, services),
      },
      {
        appId: app.id,
        from: pathToFileURL(path.join(application.appRoot, 'modern.config.ts')),
        deployTarget: 'cloudflare',
        environment: { ...process.env },
      },
    );
    return { id: app.id, services: config.deploy?.worker?.services ?? [] };
  });
  verifyGeneratedWorkerServices(generation.workerServices);
  const compiled = await buildCompiledWorkerApplications({
    applications,
    context,
    signal,
  });
  const publications = compiled
    .filter(app => app.role === 'remote')
    .map(app => {
      const manifest = readJson(app.manifestPath);
      const publicPath = manifest.metaData.publicPath;
      const remoteEntry = manifest.metaData.remoteEntry;
      const assets = [
        ...new Set(
          [...(manifest.exposes ?? []), ...(manifest.shared ?? [])].flatMap(
            item =>
              ['js', 'css'].flatMap(kind =>
                ['sync', 'async'].flatMap(
                  mode => item.assets?.[kind]?.[mode] ?? [],
                ),
              ),
          ),
        ),
      ];
      return {
        id: app.remote,
        origin: app.origin,
        publicPath,
        remoteEntry: new URL(
          `${remoteEntry.path}${remoteEntry.name}`,
          publicPath,
        ).href,
        assets: assets.map(asset => new URL(asset, publicPath).href),
      };
    });
  verifyGeneratedWorkerPublications(publications, generation.origins);
  const fixtures = createOctaneWorkerFederationFixtures({
    host: generation.applications[0],
    remotes: generation.applications.slice(1),
    dependencies,
    remoteOrigins: origins.slice(1),
    services: services.host,
    remoteServices: { 'remote-a': services.remoteA },
  });
  const planPath = path.join(context.workRoot, 'generated-worker-plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: 'packed',
      applications: compiled,
      routes: fixtures.routes,
      hops: fixtures.hops,
      sharedCounterPath: path.join(workspaceRoot, 'shared/Counter.tsx'),
      generatorPackageRoot: generator.directory,
      generatorConsumerRoot,
      browserDependencyRoot: context.browserDependencyRoot,
      browserExecutable: context.browserExecutable,
    }),
  );
  const proof = await runWorkerFixtureProof(readWorkerFixturePlan(planPath), {
    signal,
  });
  const evidencePaths = [
    planPath,
    inputPath,
    resultPath,
    path.join(context.workRoot, 'public-generation.log'),
    path.join(context.workRoot, 'generated-install-process.json'),
    path.join(workspaceRoot, 'pnpm-lock.yaml'),
    path.join(workspaceRoot, 'pnpm-workspace.yaml'),
    ...[0, 1, 2].flatMap(index =>
      ['build', 'deploy'].map(label =>
        path.join(context.workRoot, `worker-${index}-${label}-process.json`),
      ),
    ),
    ...compiled.map(app => app.manifestPath),
    ...generation.applications.map(app =>
      path.join(workspaceRoot, app.directory, 'shared/ultramodern-build.json'),
    ),
    ...fs
      .readdirSync(path.join(context.workRoot, 'process-witnesses'))
      .map(name => path.join(context.workRoot, 'process-witnesses', name)),
  ];
  return { result: { ...proof, generation, publications }, evidencePaths };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const filename = process.env.ULTRAMODERN_MF_PACKED_CONTEXT;
  assert(
    filename,
    'Run the generated consumer through the authenticated packed harness.',
  );
  const input = readJson(filename);
  const context = await readPackedNativeFederationContext(filename, 'octane');
  const actualBinding = {
    sourceRevision: context.cohort.sourceRevision,
    releaseVersion: context.release.release.version,
    manifestSha256: context.cohort.manifestSha256,
    frameworkCohortDigest: context.cohort.cohortDigest,
  };
  assert.deepEqual(input.proofBinding, actualBinding);
  assert.match(input.proofNonce, /^[a-f0-9-]{36}$/u);
  const cancellation = new AbortController();
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [
    signal,
    () =>
      cancellation.abort(
        new Error(`Generated Worker acceptance received ${signal}`),
      ),
  ]);
  for (const [signal, handler] of handlers) process.once(signal, handler);
  try {
    const { result, evidencePaths } = await runGeneratedWorkerConsumer(
      context,
      {
        signal: AbortSignal.any([
          cancellation.signal,
          AbortSignal.timeout(30 * 60_000),
        ]),
      },
    );
    assertGeneratedWorkerResult(result);
    const evidence = evidencePaths.map((filename, index) => {
      const source = fs.realpathSync(filename);
      const relative = path.relative(fs.realpathSync(context.workRoot), source);
      assert(
        relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      );
      const copied = path.join(
        input.proofEvidenceDirectory,
        `${index}-${path.basename(filename)}`,
      );
      fs.copyFileSync(source, copied, fs.constants.COPYFILE_EXCL);
      return { path: copied, sha256: digest(copied), sourcePath: relative };
    });
    fs.writeFileSync(
      input.generatedWorkerResultPath,
      `${JSON.stringify({ schemaVersion: 1, binding: actualBinding, nonce: input.proofNonce, result, evidence }, null, 2)}\n`,
      { flag: 'wx' },
    );
    process.stdout.write(
      `${JSON.stringify({ generatedWorker: 'passed', operations: result.generation.operations.length })}\n`,
    );
  } finally {
    for (const [signal, handler] of handlers)
      process.removeListener(signal, handler);
  }
}
