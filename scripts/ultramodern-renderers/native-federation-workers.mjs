import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileEvidence } from '../lib/file-evidence.mjs';
import { workerOptions } from '../ultramodern-production-readiness/react-rsc-worker-proof/contract.mjs';
import { startBridge } from '../ultramodern-production-readiness/react-rsc-worker-proof/runtime.mjs';
import {
  readInstalledPackageFiles,
  verifyInstalledPackage,
} from './installed-cohort.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const within = (root, filename) => {
  const relative = path.relative(root, filename);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

async function awaitOwnedStartup(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function installedOwner(entry, consumerRoot) {
  let directory = path.dirname(fs.realpathSync(entry));
  while (within(consumerRoot, directory)) {
    const filename = path.join(directory, 'package.json');
    if (fs.existsSync(filename)) {
      const manifest = readJson(filename);
      if (manifest.name && manifest.version)
        return { directory, manifest, filename };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Installed Worker provider escapes its consumer: ${entry}`);
}

/** Authenticate the actual public subpath owner, including transitive tooling. */
export function verifyWorkerFederationModule({
  request,
  specifier,
  sourceName,
  cohort,
  consumerRoot,
}) {
  const artifact = cohort.artifacts.find(
    item => item.sourceName === sourceName,
  );
  assert(artifact, `Packed Workers are missing ${sourceName}.`);
  const owner = installedOwner(
    request.resolve(specifier),
    fs.realpathSync(consumerRoot),
  );
  assert.equal(owner.manifest.name, artifact.targetName);
  assert.equal(owner.manifest.version, artifact.version);
  verifyInstalledPackage(owner.directory, artifact);
  return { directory: owner.directory, artifact };
}

/** Resolve workerd through its real installed generator and Miniflare owners. */
export async function readWorkerFederationProvider({
  mode,
  generatorPackageRoot,
  consumerRoot,
  cohort,
}) {
  assert(['source', 'packed'].includes(mode), 'Declare the proof lane.');
  assert(
    !process.env.MINIFLARE_WORKERD_PATH,
    'Ambient workerd overrides are forbidden.',
  );
  assert(
    !process.env.VSCODE_INSPECTOR_OPTIONS,
    'An inspector has no proof owner.',
  );
  const root = fs.realpathSync(consumerRoot);
  const generatorRoot = fs.realpathSync(generatorPackageRoot);
  assert(within(root, generatorRoot), 'The generator escapes its consumer.');
  const generator = readJson(path.join(generatorRoot, 'package.json'));
  const artifact = cohort?.artifacts.find(
    item => item.sourceName === '@modern-js/ultramodern-create',
  );
  if (mode === 'packed') {
    assert(
      artifact,
      'Packed Workers require the authenticated public generator.',
    );
    assert.equal(generator.name, artifact.targetName);
    assert.equal(generator.version, artifact.version);
    verifyInstalledPackage(generatorRoot, artifact);
  } else assert.equal(generator.name, '@modern-js/ultramodern-create');
  const generatorRequire = createRequire(
    path.join(generatorRoot, 'package.json'),
  );
  if (mode === 'packed')
    assert.equal(
      installedOwner(generatorRequire.resolve(generator.name), root).directory,
      generatorRoot,
      'The public generator resolves to a different package owner.',
    );
  const miniflareEntry = generatorRequire.resolve('miniflare');
  const miniflare = installedOwner(miniflareEntry, root);
  assert.equal(miniflare.manifest.name, 'miniflare');
  assert.equal(miniflare.manifest.version, generator.dependencies.miniflare);
  const miniflareRequire = createRequire(miniflare.filename);
  const workerdEntry = miniflareRequire.resolve('workerd');
  const workerd = installedOwner(workerdEntry, root);
  assert.equal(workerd.manifest.name, 'workerd');
  assert.equal(
    workerd.manifest.version,
    miniflare.manifest.dependencies.workerd,
  );
  const workerdPublic = miniflareRequire('workerd');
  assert.equal(workerdPublic.version, workerd.manifest.version);
  assert.equal(typeof workerdPublic.default, 'string');
  const binary = fs.realpathSync(workerdPublic.default);
  assert(within(root, binary), 'The workerd binary escapes its consumer.');
  const binaryFile = fileEvidence(binary, root);
  const owners = [generatorRoot, miniflare.directory, workerd.directory];
  const files = owners.map(directory => ({
    directory,
    files: readInstalledPackageFiles(directory),
  }));
  const provider = await import(pathToFileURL(miniflareEntry).href);
  for (const name of ['Miniflare', 'convertV4MiniflareOptions', 'Log'])
    assert.equal(
      typeof provider[name],
      'function',
      `Missing installed ${name}.`,
    );
  assert(provider.LogLevel, 'Missing installed Miniflare log levels.');
  return {
    ...provider,
    evidence: { mode, miniflareEntry, workerdEntry, binary, binaryFile, files },
    verify() {
      for (const owner of files)
        assert.deepEqual(
          readInstalledPackageFiles(owner.directory),
          owner.files,
          `Worker provider changed during acceptance: ${owner.directory}`,
        );
      if (mode === 'packed') verifyInstalledPackage(generatorRoot, artifact);
      assert.deepEqual(
        fileEvidence(binary, root),
        binaryFile,
        'The executed workerd binary changed during acceptance.',
      );
    },
  };
}

/** Keep service calls inside workerd, using the emitted deployment coordinates. */
export function workerFederationOptions(applications, { faults = [] } = {}) {
  assert(
    applications.length >= 3,
    'Workers MF requires a host and two remotes.',
  );
  const names = new Set(applications.map(({ wrangler }) => wrangler.name));
  const genuineNames = new Set(names);
  assert.equal(names.size, applications.length, 'Worker names must be unique.');
  const workers = applications.map(({ outputRoot, wrangler }) => {
    const services = [];
    const bindings = new Set();
    for (const service of wrangler.services ?? []) {
      assert(typeof service.binding === 'string' && service.binding.length > 0);
      assert(!bindings.has(service.binding), 'Duplicate Worker binding.');
      assert(
        names.has(service.service),
        `Missing deployed Worker ${service.service}.`,
      );
      assert(
        !service.environment,
        'Worker acceptance requires an exact deployed service.',
      );
      bindings.add(service.binding);
      services.push([
        service.binding,
        service.entrypoint
          ? { name: service.service, entrypoint: service.entrypoint }
          : service.service,
      ]);
    }
    return {
      ...workerOptions(outputRoot, wrangler),
      bindings: wrangler.vars ?? {},
      serviceBindings: Object.fromEntries(services),
    };
  });
  for (const fault of faults) {
    assert(typeof fault.name === 'string' && fault.name.length > 0);
    assert(!names.has(fault.name), 'A fault Worker must have its own name.');
    assert(
      genuineNames.has(fault.target) && fault.target !== fault.host,
      'A fault Worker has no genuine remote.',
    );
    const host = workers.find(worker => worker.name === fault.host);
    assert(host, 'A fault Worker has no genuine host.');
    assert.equal(
      host.serviceBindings[fault.binding],
      fault.target,
      'The fault binding differs from the emitted remote service.',
    );
    const scriptPath = fs.realpathSync(fault.scriptPath);
    assert(
      fs.lstatSync(fault.scriptPath).isFile(),
      'Use an ordinary authored fault Worker.',
    );
    names.add(fault.name);
    host.serviceBindings[fault.binding] = fault.name;
    workers.push({
      name: fault.name,
      modules: [{ type: 'ESModule', path: scriptPath }],
      modulesRoot: path.dirname(scriptPath),
      compatibilityDate: host.compatibilityDate,
      compatibilityFlags: host.compatibilityFlags,
      serviceBindings: { TARGET: fault.target },
    });
  }
  return workers;
}

/** Own real Worker isolates and unmodified HTTP bridges as one runtime. */
export async function startWorkerFederationRuntime({
  applications,
  provider,
  bridgeNames,
  bridgePorts = {},
  faults = [],
  signal,
}) {
  const options = workerFederationOptions(applications, { faults });
  const names = new Set(options.map(worker => worker.name));
  assert(
    bridgeNames.every(name => names.has(name)),
    'A bridge has no deployed Worker.',
  );
  assert.equal(
    new Set(bridgeNames).size,
    bridgeNames.length,
    'Duplicate Worker bridge.',
  );
  for (const [name, port] of Object.entries(bridgePorts)) {
    assert(
      bridgeNames.includes(name),
      'A compiled origin has no Worker bridge.',
    );
    assert(
      Number.isSafeInteger(port) && port > 0 && port <= 65535,
      'Supply a reserved compiled origin port.',
    );
  }
  assert.equal(
    new Set(Object.values(bridgePorts)).size,
    Object.keys(bridgePorts).length,
    'Compiled Worker origins must be unique.',
  );
  const bridges = new Map();
  let runtime;
  let cleanup;
  const dispose = () => {
    cleanup ??= (async () => {
      const failures = [];
      for (const bridge of [...bridges.values()].reverse()) {
        try {
          await bridge.close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await runtime?.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, 'Worker proof cleanup failed.');
    })();
    return cleanup;
  };
  try {
    signal?.throwIfAborted();
    runtime = new provider.Miniflare(
      provider.convertV4MiniflareOptions({
        log: new provider.Log(provider.LogLevel.ERROR),
        workers: options,
      }),
    );
    await awaitOwnedStartup(runtime.ready, signal);
    for (const name of bridgeNames) {
      const worker = await awaitOwnedStartup(runtime.getWorker(name), signal);
      const bridge = await startBridge(
        {
          dispatchFetch: (input, init) => worker.fetch(input, init),
        },
        name,
        { port: bridgePorts[name] ?? 0 },
      );
      bridges.set(name, bridge);
      signal?.throwIfAborted();
    }
    return { runtime, bridges, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Worker startup and cleanup failed.',
      );
    }
    throw error;
  }
}
