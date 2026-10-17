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
  const requests = input.packageRequests;
  assert(requests && typeof requests === 'object');
  for (const name of [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/renderer-octane',
    '@modern-js/renderer-core',
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
    renderer: 'octane',
    path: `${index ? 'verticals' : 'apps'}/${id}`,
    package: `@authored-worker/${id}`,
    ...(index ? { domain: id } : { verticalRefs: ['remote-a', 'remote-b'] }),
    moduleFederation: {
      name: ['sourceWorkerHost', 'sourceWorkerA', 'sourceWorkerB'][index],
      exposes: index ? ['./Widget'] : [],
    },
    deliveryUnit: {
      unitId: `authored-worker/${id}`,
      buildMarker: generationBuildMarker,
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
    dependencies: requests,
  });
  writeJson(path.join(workspaceRoot, 'package.json'), {
    name: 'authored-source-workers',
    version: '0.0.0',
    private: true,
  });
  const policyPath = path.join(workspaceRoot, 'pnpm-workspace.yaml');
  writeJson(policyPath, {
    packages: ['apps/*', 'verticals/*'],
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
  for (const { app, files } of fixture.applications)
    writeFiles(path.join(workspaceRoot, app.directory), files);
  const environment = {
    ...process.env,
    NODE_PATH: '',
    NODE_OPTIONS: '',
    NODE_ENV: 'production',
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
      // App roots and all later compiler outputs belong to this operation.
      await artifact(
        path.join(workspaceRoot, app.path, 'dist-cloudflare'),
        'build',
      );
      await artifact(path.join(workspaceRoot, app.path, '.output'), 'build');
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
      ])
        await run(
          process.execPath,
          [installedBin(application.appRoot), ...args],
          application.appRoot,
          `${label}-${operation}`,
          env,
        );
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
  assert.equal(process.argv.length, 3, 'Usage: source.mjs <source-input.json>');
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
