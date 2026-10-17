#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { confinedPath } from '../../../scripts/lib/file-evidence.mjs';
import { reservePort } from '../../../scripts/ultramodern-production-readiness/renderer-mf-lifecycle-proof/runtime.mjs';
import {
  installedBin,
  runPackedNativeFederationCommand as runWitnessedCommand,
} from '../../../scripts/ultramodern-renderers/native-federation-packed.mjs';
import { readWorkerFederationProvider } from '../../../scripts/ultramodern-renderers/native-federation-workers.mjs';
import { createOctaneWorkerFederationFixtures } from './fixtures.mjs';
import { readWorkerFixturePlan, runWorkerFixtureProof } from './proof.mjs';

export const sourceWorkerGitignore =
  'node_modules/\ndist-cloudflare/\n.output/\n.modern/\n**/.modern-js/tsgo/\n';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  });
};
const writeFiles = (root, files) => {
  for (const [relative, contents] of Object.entries(files)) {
    const filename = confinedPath(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents, { flag: 'wx' });
  }
};

function printCommandFailure(label, filename, error) {
  let tail;
  try {
    const descriptor = fs.openSync(filename, 'r');
    try {
      const size = fs.fstatSync(descriptor).size;
      const buffer = Buffer.alloc(Math.min(size, 32 * 1024));
      fs.readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
      tail = buffer.toString('utf8').split('\n').slice(-120).join('\n');
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (readError) {
    tail = `Could not read command log: ${readError.message}`;
  }
  process.stderr.write(
    `\nSource Worker command failed (${label}): ${error.message}\nLog: ${filename}\n${tail}\n`,
  );
}

const installedOwner = (request, name) => {
  let directory = path.dirname(fs.realpathSync(request.resolve(name)));
  while (true) {
    const filename = path.join(directory, 'package.json');
    if (fs.existsSync(filename) && readJson(filename).name === name)
      return fs.realpathSync(directory);
    const parent = path.dirname(directory);
    assert.notEqual(
      parent,
      directory,
      `No genuine installed owner for ${name}`,
    );
    directory = parent;
  }
};

/** Read-only, bounded diagnostics from the actual completed install and build. */
async function printSourceWorkerDispatchDiagnostics({
  applications,
  apps,
  run,
  workRoot,
}) {
  const host = applications.find(application => application.role === 'host');
  const hostApp = apps[applications.indexOf(host)];
  const request = createRequire(path.join(host.appRoot, 'package.json'));
  const toolingRequest = createRequire(
    request.resolve('@modern-js/ultramodern-app-tools'),
  );
  const { NATIVE_RENDERER_WORKER_RESOURCES_FILE } = toolingRequest(
    '@modern-js/app-tools-extensions/cloudflare/native-renderer',
  );
  const print = (label, value) =>
    process.stdout.write(
      `Source Worker diagnostic (${label}): ${JSON.stringify(value)}\n`,
    );
  const selectedLines = filename => {
    const source = fs.readFileSync(filename, 'utf8');
    const lines = source.split('\n');
    return {
      path: fs.realpathSync(filename),
      sha256: createHash('sha256').update(source).digest('hex'),
      lines: lines
        .flatMap((line, index) =>
          /workerFederation|WorkerFederation|dispatchNativeWorkerRequest|createNativeWorkerFederationRuntime|runtime\.transport|entry-server|handlers\.worker|federation\.worker|from ['"]octane|worker-federation-context/u.test(
            line,
          )
            ? [{ line: index + 1, source: line.slice(0, 1000) }]
            : [],
        )
        .slice(0, 16),
    };
  };
  for (const application of applications) {
    const filename = path.join(
      application.buildRoot,
      NATIVE_RENDERER_WORKER_RESOURCES_FILE,
    );
    const resource = readJson(filename);
    print('native-resources', {
      path: fs.realpathSync(filename),
      application: application.remote ?? 'host',
      renderer: resource.renderer,
      publication: resource.workerFederation && {
        renderer: resource.workerFederation.renderer,
        remote: resource.workerFederation.worker?.remote,
        exposes: resource.workerFederation.worker?.exposes,
      },
      manifestUrl: resource.workerFederationManifestUrl,
      services: resource.workerFederationServices?.slice(0, 8).map(service => ({
        remote: service.remote,
        alias: service.alias,
        binding: service.binding,
        manifestUrl: service.manifestUrl,
        fragments: service.fragments?.slice(0, 8),
      })),
      entries: Object.entries(resource.entries).map(([entryName, entry]) => ({
        entryName,
        hydrationBuildId: entry.hydrationBuildId,
        serverConfig: entry.serverConfig,
      })),
    });
    if (application !== host) continue;
    // The real authored public Cloudflare preset owns this exact tempDir; the
    // entry names come from its actual emitted native-resource manifest.
    for (const entryName of Object.keys(resource.entries)) {
      const directory = confinedPath(
        host.appRoot,
        `node_modules/.modern-js-${hostApp.id}-cloudflare/octane/${entryName}`,
      );
      for (const name of [
        'index.worker.ts',
        'handlers.worker.ts',
        'federation.worker.ts',
      ]) {
        const generated = path.join(directory, name);
        print(
          'generated-entry',
          fs.existsSync(generated)
            ? selectedLines(generated)
            : { path: generated, missing: true },
        );
      }
    }
  }
  // Resolve both Node conditions from the actual host, without importing any
  // renderer runtime or writing into the clean authored workspace. These are
  // resolution facts, not a claim about the bundler's selected condition.
  const resolutionScript = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const request=createRequire(import.meta.url);
const rows=[];
for(const specifier of ['@modern-js/renderer-octane/entry-server','@modern-js/renderer-octane/federation','octane','octane/server']) {
 const esm=fs.realpathSync(fileURLToPath(import.meta.resolve(specifier)));
 const cjs=fs.realpathSync(request.resolve(specifier));
 const row={specifier,esm,cjs};
 if(specifier.startsWith('@modern-js/renderer-octane/')) row.entryImports=[esm,cjs].map(entry=>({entry,imports:fs.readFileSync(entry,'utf8').split('\n').filter(line=>/octane|from |require\(/.test(line)).slice(0,18).map(line=>line.slice(0,600))}));
 if(specifier.startsWith('@modern-js/renderer-octane/')) {
  row.contexts=[esm,cjs].map(entry=>{
   const context=path.join(path.dirname(entry),'worker-federation-context'+path.extname(entry));
   const source=fs.readFileSync(context,'utf8');
   const local=createRequire(context);
   return {entry,context:fs.realpathSync(context),octane:fs.realpathSync(local.resolve('octane')),octaneServer:fs.realpathSync(local.resolve('octane/server')),imports:source.split('\n').filter(line=>/worker-federation-context|octane|createContext|WorkerFederationContext/.test(line)).slice(0,12).map(line=>line.slice(0,600))};
  });
 }
 rows.push(row);
}
process.stdout.write(JSON.stringify(rows)+'\n');
`;
  const label = 'worker-conditional-resolution-diagnostic';
  await run(
    process.execPath,
    ['--input-type=module', '--eval', resolutionScript],
    host.appRoot,
    label,
  );
  print(
    'node-import-require-resolution',
    readJson(path.join(workRoot, `${label}.log`)),
  );
}

/** Resolve authored topology projections through the installed config owners. */
async function finalizeAuthoredSourceTopology(workspaceRoot) {
  const filename = path.join(workspaceRoot, 'topology/reference-topology.json');
  const topology = readJson(filename);
  const apps = [topology.shell, ...topology.verticals];
  for (const app of apps) {
    const appRoot = path.join(workspaceRoot, app.path);
    const request = createRequire(path.join(appRoot, 'package.json'));
    const tools = request('@modern-js/ultramodern-app-tools');
    const toolingRequest = createRequire(
      request.resolve('@modern-js/ultramodern-app-tools'),
    );
    const contracts = toolingRequest('@modern-js/backend-federation-contracts');
    const { loadUltramodernConfigMetadata } = request(
      '@modern-js/ultramodern-app-tools/config-metadata',
    );
    // No fallback package roots: every config import belongs to this actual install.
    const metadata = await loadUltramodernConfigMetadata({
      appDirectory: appRoot,
      env: 'production',
      command: 'build',
      sourceRoot: workspaceRoot,
    });
    assert.equal(metadata.renderer, 'octane');
    assert(
      metadata.entries.some(
        entry => entry.entryName === metadata.primaryEntryName,
      ),
    );
    const selected = tools.resolveRendererProfile(metadata.renderer);
    const rendererProfile = {
      renderer: selected.renderer,
      protocolVersion: selected.protocolVersion,
      compiler: selected.compiler,
      hydration: selected.hydration,
      router: selected.router,
    };
    assert.equal(contracts.validateRendererProfile(rendererProfile).ok, true);
    assert.equal(
      contracts.validateRendererRouterBindings(
        metadata.routerBindings,
        metadata.entries.map(entry => entry.entryName),
        'routerBindings',
        tools.resolveRendererRouterFrameworks(metadata.renderer),
      ).ok,
      true,
    );
    // These are source-authoring generation coordinates. The normal production
    // build derives its release marker from the real clean fixture Git revision.
    const buildMarker = createHash('sha256')
      .update(
        JSON.stringify({
          namespace: 'authored-source-worker-delivery:v1',
          appId: app.id,
          packageName: app.package,
          version: app.deliveryUnit.version,
          rendererProfile,
          routerBindings: metadata.routerBindings,
        }),
      )
      .digest('hex')
      .slice(0, 16);
    const record = {
      ...app.deliveryUnit,
      appId: app.id,
      buildMarker,
      sourceRevision: 'workspace',
      schemaVersion: contracts.DELIVERY_UNIT_SCHEMA_VERSION,
      kind: contracts.DELIVERY_UNIT_KIND,
      deployProfile: contracts.DELIVERY_UNIT_DEPLOY_PROFILE,
    };
    assert.equal(contracts.validateDeliveryUnitRecord(record).ok, true);
    const rendererIdentities = Object.fromEntries(
      metadata.entries.map(({ entryName }) => [
        entryName,
        {
          renderer: metadata.renderer,
          appId: app.id,
          entryName,
          protocolVersion: rendererProfile.protocolVersion,
          buildId: buildMarker,
        },
      ]),
    );
    for (const identity of Object.values(rendererIdentities))
      assert.equal(contracts.validateRendererIdentity(identity).ok, true);
    Object.assign(app, {
      renderer: metadata.renderer,
      rendererProfile,
      routerBindings: metadata.routerBindings,
      rendererIdentity: rendererIdentities[metadata.primaryEntryName],
      rendererIdentities,
      deliveryUnit: contracts.deliveryUnitContractBlock(record),
    });
    // Author the same input carrier used by the normal workspace generator.
    // emitRendererBuildArtifact owns its later compiled/stamped counterpart.
    const carrier = contracts.createUltramodernBuildArtifact(record, {
      ui: {
        identity: app.rendererIdentity,
        profile: rendererProfile,
        routerBindings: metadata.routerBindings,
      },
    });
    writeJson(
      path.join(appRoot, contracts.ULTRAMODERN_BUILD_ARTIFACT_PATH),
      carrier,
    );
  }
  // This is the authored source topology, never a generated or compiler output.
  fs.writeFileSync(filename, `${JSON.stringify(topology, null, 2)}\n`);
}

/** Serve only the genuine emitted publication while the next consumer builds. */
async function serveAssets(root, origin) {
  const server = http.createServer((request, response) => {
    try {
      assert(['GET', 'HEAD'].includes(request.method));
      const url = new URL(request.url, origin);
      const filename = confinedPath(
        root,
        decodeURIComponent(url.pathname).replace(/^\/+/, ''),
      );
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
        const stream = fs.createReadStream(filename);
        stream.on('error', () => response.destroy());
        response.once('close', () => stream.destroy());
        stream.pipe(response);
      }
    } catch {
      response.writeHead(404);
      response.end('No emitted Worker asset');
    }
  });
  const url = new URL(origin);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(url.port), url.hostname, resolve);
  });
  return async () => {
    const closed = new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  };
}

/** Ordinary authored source consumers; this entry never creates a release receipt. */
export async function runSourceWorkerConsumer(input, { signal } = {}) {
  assert.equal(input.schemaVersion, 1);
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run source Workers through owned-temp-dir.',
  );
  assert(
    !process.env.ULTRAMODERN_MF_PACKED_CONTEXT,
    'Source validation cannot claim a packed cohort.',
  );
  const ownerRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  const workRoot = fs.mkdtempSync(
    path.join(ownerRoot, 'authored-source-workers-'),
  );
  const workspaceRoot = path.join(workRoot, 'workspace');
  fs.mkdirSync(workspaceRoot);
  const requests = {
    ...input.packageRequests,
    '@modern-js/federation-runtime':
      input.packageRequests?.['@modern-js/federation-runtime'] ??
      input.frameworkOverrides?.['@modern-js/federation-runtime'],
  };
  assert(requests && typeof requests === 'object');
  for (const name of [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/renderer-octane',
    '@modern-js/renderer-core',
    '@modern-js/federation-runtime',
    '@modern-js/i18n-runtime-extensions',
    '@modern-js/ultramodern-create',
    'octane',
    '@octanejs/tanstack-router',
    '@octanejs/rspack-plugin',
    'i18next',
  ]) {
    assert.equal(
      typeof requests[name],
      'string',
      `Missing normal installed request: ${name}`,
    );
    assert(
      !/^(?:workspace:|link:)/u.test(requests[name]),
      'Source consumers use normal archives/registry requests, not source links.',
    );
  }
  const virtualStoreDir =
    input.virtualStoreDir ?? path.join(workspaceRoot, 'node_modules/.pnpm');
  assert(
    path.isAbsolute(virtualStoreDir),
    'The virtual store must be an absolute owned path.',
  );
  assert.equal(path.basename(virtualStoreDir), '.pnpm');
  const dependencyRoot = path.dirname(virtualStoreDir);
  assert.equal(path.basename(dependencyRoot), 'node_modules');
  assert(
    !fs.existsSync(dependencyRoot),
    "Never reuse another operation's dependency tree.",
  );
  const ports = [];
  while (ports.length < 3) {
    const port = await reservePort();
    if (!ports.includes(port)) ports.push(port);
  }
  const origins = ports.map(port => `http://127.0.0.1:${port}`);
  const generationBuildMarker = createHash('sha256')
    .update(JSON.stringify(requests))
    .digest('hex')
    .slice(0, 16);
  const topologyApp = (id, index) => ({
    id,
    kind: index ? 'vertical' : 'shell',
    surfaceProfile: 'ui-only',
    path: `${index ? 'verticals' : 'apps'}/${id}`,
    package: `@authored-worker/${id}`,
    ...(index ? { domain: id } : { verticalRefs: ['remote-a', 'remote-b'] }),
    moduleFederation: {
      name: ['sourceWorkerHost', 'sourceWorkerA', 'sourceWorkerB'][index],
      exposes: index ? ['./Widget'] : [],
    },
    deliveryUnit: {
      schemaVersion: 1,
      kind: 'microvertical-delivery-unit',
      unitId: `authored-worker/${id}`,
      buildMarker: generationBuildMarker,
      sourceRevision: 'workspace',
      packageName: `@authored-worker/${id}`,
      version: '0.0.0',
    },
    cloudflare: {
      workerName: `source-proof-${id}`,
      publicUrlEnv: `SOURCE_WORKER_${index}_PUBLIC_URL`,
      compatibilityDate: '2026-10-01',
    },
  });
  const apps = ['host', 'remote-a', 'remote-b'].map(topologyApp);
  const descriptor = app => ({
    id: app.id,
    directory: app.path,
    renderer: 'octane',
    moduleFederationName: app.moduleFederation.name,
    packageName: app.package,
    exposes: { './Widget': './src/components/Widget.tsx' },
    manifest: {
      name: app.package,
      version: '0.0.0',
      private: true,
      modernjs: { appId: app.id },
    },
  });
  const descriptors = apps.map(descriptor);
  const service = app => ({
    binding: `VERTICAL_${app.id.replaceAll('-', '_').toUpperCase()}_WORKER`,
    service: app.cloudflare.workerName,
    fragments: [
      {
        remote: app.id,
        expose: './Widget',
        boundaryId: app.moduleFederation.name,
        path: '/{locale}/_mf/fragment/widget',
      },
    ],
  });
  const fixture = createOctaneWorkerFederationFixtures({
    host: descriptors[0],
    remotes: descriptors.slice(1),
    remoteOrigins: origins.slice(1),
    services: apps.slice(1).map(service),
    remoteServices: { 'remote-a': [service(apps[2])] },
    hostServiceSource: 'topology',
    sharedCounterPackage: '@authored-worker/shared-counter',
    dependencies: {
      ...requests,
      '@authored-worker/shared-counter': 'workspace:*',
    },
  });
  writeJson(path.join(workspaceRoot, 'package.json'), {
    name: 'authored-source-workers',
    version: '0.0.0',
    private: true,
  });
  writeFiles(workspaceRoot, {
    '.gitignore': sourceWorkerGitignore,
  });
  const policyPath = path.join(workspaceRoot, 'pnpm-workspace.yaml');
  writeJson(policyPath, {
    packages: ['apps/*', 'verticals/*', 'shared'],
    minimumReleaseAge: 1440,
    minimumReleaseAgeStrict: true,
    minimumReleaseAgeIgnoreMissingTime: false,
    minimumReleaseAgeExclude: [],
    packageImportMethod: 'clone-or-copy',
    virtualStoreDir,
    ...(input.allowBuilds ? { allowBuilds: input.allowBuilds } : {}),
    overrides: { ...input.frameworkOverrides, ...requests },
  });
  writeJson(path.join(workspaceRoot, 'topology/reference-topology.json'), {
    schemaVersion: 1,
    shell: apps[0],
    verticals: apps.slice(1),
  });
  writeJson(
    path.join(workspaceRoot, 'topology/local-overlays/development.json'),
    {
      schemaVersion: 1,
      ports: Object.fromEntries(
        apps.map((app, index) => [app.id, ports[index]]),
      ),
    },
  );
  writeFiles(path.join(workspaceRoot, 'shared'), fixture.shared);
  writeJson(path.join(workspaceRoot, 'shared/package.json'), {
    name: '@authored-worker/shared-counter',
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: { '.': { types: './Counter.tsx', default: './Counter.tsx' } },
    dependencies: { octane: requests.octane },
  });
  for (const { app, files } of fixture.applications)
    writeFiles(path.join(workspaceRoot, app.directory), files);
  const environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.toUpperCase().startsWith('GIT_'),
      ),
    ),
    NODE_PATH: '',
    NODE_OPTIONS: '',
    NODE_ENV: 'production',
    ULTRAMODERN_SOURCE_REVISION: '',
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    ...Object.fromEntries(
      apps.map((app, index) => [app.cloudflare.publicUrlEnv, origins[index]]),
    ),
  };
  const run = async (
    command,
    args,
    cwd,
    label,
    env = environment,
    commandSignal = cancellation.signal,
  ) => {
    const log = path.join(workRoot, `${label}.log`);
    try {
      commandSignal.throwIfAborted();
      return await runWitnessedCommand(command, args, {
        cwd,
        env,
        signal: commandSignal,
        cleanupErrors,
        witness: path.join(workRoot, `${label}-process.json`),
        log,
      });
    } catch (error) {
      printCommandFailure(label, log, error);
      throw error;
    }
  };
  const assertCleanSource = async label => {
    const statusLabel = `${label}-source-status`;
    await run(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      workspaceRoot,
      statusLabel,
    );
    const status = fs.readFileSync(
      path.join(workRoot, `${statusLabel}.log`),
      'utf8',
    );
    assert.equal(
      status,
      '',
      `Authored Worker sources changed after ${label}:\n${status}`,
    );
  };
  const registrations = [];
  const artifactOwner = `source-worker-${process.pid}`;
  const artifact = async (directory, kind) => {
    fs.mkdirSync(directory, { recursive: true });
    // Registration can succeed before its command wrapper fails or is aborted.
    // Retire every attempted lease under this operation's exact owner.
    const index = registrations.push(directory) - 1;
    await run(
      '/Users/satan/bin/disk-guardian-artifacts',
      [
        'register',
        directory,
        '--owner',
        artifactOwner,
        '--owner-pid',
        String(process.pid),
        '--grace-hours',
        '24',
        '--kind',
        kind,
      ],
      workRoot,
      `register-${index}`,
    );
  };
  const closeServers = [];
  let result;
  let failure;
  const cleanupErrors = [];
  const cancellation = new AbortController();
  const forwardAbort = () => cancellation.abort(signal.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  try {
    await artifact(path.join(workspaceRoot, 'node_modules'), 'dependencies');
    if (dependencyRoot !== path.join(workspaceRoot, 'node_modules'))
      await artifact(dependencyRoot, 'dependencies');
    assert.equal(typeof input.pnpmExecutable, 'string');
    assert(
      path.isAbsolute(input.storeDir),
      'Use the external shared pnpm store.',
    );
    await run(
      input.pnpmExecutable,
      [
        'install',
        '--store-dir',
        input.storeDir,
        '--virtual-store-dir',
        virtualStoreDir,
        '--config.package-import-method=clone-or-copy',
        '--config.minimum-release-age=1440',
        '--config.minimum-release-age-strict=true',
      ],
      workspaceRoot,
      'install',
    );
    const policy = parseYaml(fs.readFileSync(policyPath, 'utf8'));
    assert.equal(policy.minimumReleaseAge, 1440);
    assert.equal(policy.minimumReleaseAgeStrict, true);
    assert.equal(policy.minimumReleaseAgeIgnoreMissingTime, false);
    assert.deepEqual(
      policy.minimumReleaseAgeExclude ?? [],
      [],
      'Installer-added age exemptions cannot qualify source validation.',
    );
    const generatorConsumerRoot = fs.realpathSync(dependencyRoot);
    const hostRequest = createRequire(
      path.join(workspaceRoot, apps[0].path, 'package.json'),
    );
    const generatorPackageRoot = installedOwner(
      hostRequest,
      '@modern-js/ultramodern-create',
    );
    if (input.generatorPackageRoot)
      assert.equal(
        fs.realpathSync(input.generatorPackageRoot),
        generatorPackageRoot,
        'The supplied generator must be the actual installed owner.',
      );
    if (input.generatorConsumerRoot)
      assert.equal(
        fs.realpathSync(input.generatorConsumerRoot),
        generatorConsumerRoot,
        "The supplied provider root must equal this operation's physical dependency tree.",
      );
    const provider = await readWorkerFederationProvider({
      mode: 'source',
      consumerRoot: generatorConsumerRoot,
      generatorPackageRoot,
    });
    provider.verify();
    // Before this step topology declares only membership and a complete source
    // delivery unit; final build projections come from actual installed config.
    await run(
      process.execPath,
      [fileURLToPath(import.meta.url), '--finalize-topology', workspaceRoot],
      workspaceRoot,
      'finalize-authored-topology',
    );
    await run('git', ['init', '--quiet'], workspaceRoot, 'source-git-init');
    await run('git', ['add', '--all'], workspaceRoot, 'source-git-add');
    await run(
      'git',
      [
        '-c',
        'user.name=UltraModern source fixture',
        '-c',
        'user.email=source-fixture@invalid',
        'commit',
        '--quiet',
        '-m',
        'Record actual authored Worker consumer sources and installed lockfile',
      ],
      workspaceRoot,
      'source-git-commit',
    );
    await assertCleanSource('source-git-commit');
    for (const [index, app] of apps.entries()) {
      const request = createRequire(
        path.join(workspaceRoot, app.path, 'package.json'),
      );
      const expected = {
        octane: '0.13.8',
        '@octanejs/tanstack-router': '0.2.10',
        '@octanejs/rspack-plugin': '0.2.4',
      };
      for (const [name, version] of Object.entries(expected)) {
        const directory = installedOwner(request, name);
        const actual = readJson(path.join(directory, 'package.json'));
        assert.equal(actual.name, name);
        assert.equal(actual.version, version);
      }
      // The enclosing owned-temp-dir lease owns both dist-cloudflare and
      // .output. Deploy replaces .output, so a nested inode lease is invalid.
      assert.equal(ports[index], Number(new URL(origins[index]).port));
    }
    const applications = apps.map((app, index) => ({
      role: index ? 'remote' : 'host',
      ...(index ? { remote: app.id } : {}),
      appRoot: path.join(workspaceRoot, app.path),
      origin: origins[index],
      buildRoot: path.join(workspaceRoot, app.path, 'dist-cloudflare'),
      clientRoot: path.join(workspaceRoot, app.path, 'dist-cloudflare'),
      outputRoot: path.join(workspaceRoot, app.path, '.output'),
      manifestPath: path.join(
        workspaceRoot,
        app.path,
        'dist-cloudflare/mf-manifest.json',
      ),
      wranglerPath: path.join(workspaceRoot, app.path, '.output/wrangler.json'),
    }));
    for (const application of applications.toReversed()) {
      const label = application.remote ?? 'host';
      const env = { ...environment, PORT: new URL(application.origin).port };
      for (const [operation, args] of [
        ['build', ['build']],
        ['deploy', ['deploy', '--skip-build']],
      ]) {
        await run(
          process.execPath,
          [installedBin(application.appRoot), ...args],
          application.appRoot,
          `${label}-${operation}`,
          env,
        );
        await assertCleanSource(`${label}-${operation}`);
      }
      if (application.role === 'remote')
        closeServers.push(
          await serveAssets(application.clientRoot, application.origin),
        );
    }
    while (closeServers.length) {
      await closeServers.at(-1)();
      closeServers.pop();
    }
    const planPath = path.join(workRoot, 'compiled-worker-plan.json');
    writeJson(planPath, {
      schemaVersion: 1,
      mode: 'source',
      applications,
      routes: fixture.routes,
      hops: fixture.hops,
      sharedCounterPath: path.join(workspaceRoot, 'shared/Counter.tsx'),
      generatorPackageRoot,
      generatorConsumerRoot,
      browserDependencyRoot: fs.realpathSync(input.browserDependencyRoot),
      ...(input.browserExecutable
        ? { browserExecutable: input.browserExecutable }
        : {}),
    });
    await printSourceWorkerDispatchDiagnostics({
      applications,
      apps,
      run,
      workRoot,
    });
    result = await runWorkerFixtureProof(readWorkerFixturePlan(planPath), {
      signal: cancellation.signal,
    });
    assert.equal(result.mode, 'source');
    provider.verify();
  } catch (error) {
    failure = error;
  } finally {
    for (const close of closeServers.reverse()) {
      try {
        await close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const [index, directory] of registrations.entries()) {
      try {
        // owned-temp-dir owns final deletion of this operation's entire tree.
        await run(
          '/Users/satan/bin/disk-guardian-artifacts',
          ['release', directory, '--owner', artifactOwner],
          workRoot,
          `release-${index}`,
          environment,
          AbortSignal.timeout(30_000),
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    // The external tree did not exist before this invocation and was registered
    // here. owned-temp-dir removes the ordinary in-owner workspace itself.
    if (
      registrations.includes(dependencyRoot) &&
      dependencyRoot !== path.join(workspaceRoot, 'node_modules')
    ) {
      try {
        fs.rmSync(dependencyRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    signal?.removeEventListener('abort', forwardAbort);
  }
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      `Authored source Worker validation failed; logs: ${workRoot}`,
    );
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === '--finalize-topology') {
    assert.equal(process.argv.length, 4);
    assert(
      process.env.OWNED_TEMP_DIR,
      'Topology preparation requires the source proof owner.',
    );
    const root = fs.realpathSync(process.env.OWNED_TEMP_DIR);
    const workspaceRoot = fs.realpathSync(process.argv[3]);
    assert(workspaceRoot.startsWith(`${root}${path.sep}`));
    await finalizeAuthoredSourceTopology(workspaceRoot);
  } else {
    assert.equal(
      process.argv.length,
      3,
      'Usage: source.mjs <source-input.json>',
    );
    const abort = new AbortController();
    const stop = () =>
      abort.abort(new Error('Source Worker consumer interrupted.'));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    try {
      const result = await runSourceWorkerConsumer(readJson(process.argv[2]), {
        signal: abort.signal,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGHUP', stop);
    }
  }
}
