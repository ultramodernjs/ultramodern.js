import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { registerOwnedRoot } from '../ultramodern-production-readiness/react-rsc-worker-proof/lifecycle.mjs';
import { runCommand } from '../ultramodern-production-readiness/react-rsc-worker-proof/main.mjs';
import {
  inspectOwnedProcessGroup,
  retireOwnedProcessGroup,
} from '../ultramodern-production-readiness/react-rsc-worker-proof/runtime.mjs';
import { readReleaseManifest } from '../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import {
  checkInstalledCohort,
  readCohort,
  verifyInstalledPackage,
} from './installed-cohort.mjs';
import {
  assertReleaseAgeExclusionsUnchanged,
  captureReleaseAgeExclusions,
} from './release-age-policy.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const nativeDependency = name =>
  /^(?:@module-federation\/|@octanejs\/|@solidjs\/|octane$|solid-js$|i18next$|typescript$|@types\/node$)/u.test(
    name,
  );
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

function installedStore(appRoot) {
  for (let directory = appRoot; ; directory = path.dirname(directory)) {
    const store = path.join(directory, 'node_modules/.pnpm');
    if (fs.existsSync(store)) {
      assert.equal(
        fs.realpathSync(store),
        store,
        'The pnpm virtual store must be physical',
      );
      return store;
    }
    assert.notEqual(
      directory,
      path.dirname(directory),
      `No pnpm install above ${appRoot}`,
    );
  }
}

/** Resolve the CLI from the app's authenticated install, including npm aliases. */
export function installedBin(appRoot) {
  const packageRoot = fs.realpathSync(
    path.join(appRoot, 'node_modules/@modern-js/ultramodern-app-tools'),
  );
  const { bin } = readJson(path.join(packageRoot, 'package.json'));
  return path.join(packageRoot, bin.ultramodern);
}

const processStartTime = pid =>
  execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 5000,
  }).trim();

export function recordPackedNativeFederationProcess(filename, pid) {
  fs.writeFileSync(
    filename,
    JSON.stringify({
      pid,
      uid: process.geteuid(),
      startTime: processStartTime(pid),
    }),
    { flag: 'wx' },
  );
}

/** Keep a private command group recoverable if its proof is killed. */
export function runPackedNativeFederationCommand(
  command,
  args,
  { witness, witnessDirectory, ...options },
) {
  assert(
    Boolean(witness) !== Boolean(witnessDirectory),
    'Select one packed command witness path or directory',
  );
  if (witnessDirectory) {
    assert(path.isAbsolute(witnessDirectory));
    assert.equal(fs.realpathSync(witnessDirectory), witnessDirectory);
    const stat = fs.statSync(witnessDirectory);
    assert(
      stat.isDirectory() && stat.uid === process.getuid(),
      'Packed command witnesses require an owned physical directory',
    );
  }
  return runCommand(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const startTime = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
const witness = ${witnessDirectory ? "path.join(process.argv[1], String(process.pid) + '.json')" : 'process.argv[1]'};
fs.writeFileSync(witness, JSON.stringify({ pid: process.pid, uid: process.geteuid(), startTime }), { flag: 'wx' });
const result = spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
      witnessDirectory ?? witness,
      command,
      ...args,
    ],
    options,
  );
}

/** Retire an installer even if its proof was interrupted before cleanup. */
export async function retirePackedNativeFederationInstaller(
  { pid, uid, startTime },
  {
    inspectGroup = inspectOwnedProcessGroup,
    readStartTime = processStartTime,
    kill = process.kill,
    retireClosedGroup = retireOwnedProcessGroup,
  } = {},
) {
  assert.equal(uid, process.geteuid());
  assert(typeof startTime === 'string' && startTime.length > 0);
  const inspectLeader = () => {
    const group = inspectGroup(pid);
    const leader = group.members.find(
      member => member.pid === pid && member.live,
    );
    if (leader) {
      assert.equal(leader.uid, uid);
      let observedStartTime;
      try {
        observedStartTime = readStartTime(pid);
      } catch (error) {
        if (
          error.status === 1 &&
          !error.signal &&
          !String(error.stdout ?? '').trim() &&
          !String(error.stderr ?? '').trim() &&
          !inspectGroup(pid).members.some(
            member => member.pid === pid && member.live,
          )
        )
          return undefined;
        throw error;
      }
      assert.equal(
        observedStartTime,
        startTime,
        'Packed MF installer PID now belongs to another process',
      );
    }
    return leader;
  };
  const signal = name => {
    if (!inspectLeader()) return;
    try {
      kill(-pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  if (inspectLeader()) {
    signal('SIGTERM');
    const termDeadline = Date.now() + 1000;
    while (inspectLeader() && Date.now() < termDeadline) await delay(25);
    if (inspectLeader()) signal('SIGKILL');
    const killDeadline = Date.now() + 2000;
    while (inspectLeader() && Date.now() < killDeadline) await delay(25);
    assert(!inspectLeader(), 'Packed MF installer still has a live leader');
  }
  return retireClosedGroup(pid);
}

/** Ordinary pnpm package links must resolve into this consumer's own store. */
export function verifyPackedNativeFederationDependencies({
  appRoot,
  cohort,
  storeRoot = installedStore(appRoot),
  dependencyNames,
  packageIdentities = {},
}) {
  const byName = new Map(
    cohort.artifacts.flatMap(artifact => [
      [artifact.sourceName, artifact],
      [artifact.targetName, artifact],
    ]),
  );
  const manifest = readJson(path.join(appRoot, 'package.json'));
  const roots = {};
  for (const name of dependencyNames ??
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const directory = fs.realpathSync(path.join(appRoot, 'node_modules', name));
    assert(
      inside(storeRoot, directory),
      `${name} resolves outside the packed consumer's pnpm store: ${directory}`,
    );
    const installed = readJson(path.join(directory, 'package.json'));
    const artifact = byName.get(name);
    if (artifact) {
      assert.equal(
        installed.name,
        artifact.targetName,
        `${name} has the wrong installed package identity`,
      );
      assert.equal(
        installed.version,
        artifact.version,
        `${name} has the wrong installed cohort version`,
      );
      verifyInstalledPackage(directory, artifact);
    } else {
      const request =
        manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
      const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/u.exec(request ?? '');
      const expected = packageIdentities[name] ?? {
        name: alias?.[1] ?? name,
        version: alias?.[2] ?? request,
      };
      assert.equal(
        installed.name,
        expected.name,
        `${name} has the wrong installed package identity`,
      );
      assert.equal(
        typeof installed.version,
        'string',
        `${name} has no installed version`,
      );
      if (
        packageIdentities[name] ||
        /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/iu.test(
          expected.version ?? '',
        )
      )
        assert.equal(
          installed.version,
          expected.version,
          `${name} differs from the packed consumer's installed version`,
        );
    }
    roots[name] = directory;
  }
  return roots;
}

/** Read candidate metadata before any source-lane linking can run. */
export async function readPackedNativeFederationContext(filename, renderer) {
  assert(['solid', 'octane'].includes(renderer));
  const input = readJson(filename);
  assert.equal(input.schemaVersion, 1, 'Unsupported packed native MF context');
  assert.equal(
    input.renderer,
    renderer,
    'Packed native MF context selects another renderer',
  );
  assert(
    process.env.OWNED_TEMP_DIR,
    'Packed native MF must run through owned-temp-dir',
  );
  const workRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  const consumerRoot = fs.realpathSync(input.consumerRoot);
  const release = readReleaseManifest({ manifestPath: input.manifestPath });
  const cohort = readCohort(release.manifestPath);
  const manifest = readJson(path.join(consumerRoot, 'package.json'));
  const packageRequests = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  const cohortNames = new Set(
    cohort.artifacts.flatMap(artifact => [
      artifact.sourceName,
      artifact.targetName,
    ]),
  );
  // The generated shell also owns local app contracts and design tokens.
  // Only the framework and tooling roots supply dependencies to this proof.
  const dependencyNames = Object.keys(packageRequests).filter(
    name => cohortNames.has(name) || nativeDependency(name),
  );
  const roots = verifyPackedNativeFederationDependencies({
    appRoot: consumerRoot,
    cohort,
    dependencyNames,
  });
  const required = [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/renderer-core',
    `@modern-js/renderer-${renderer}`,
  ];
  for (const name of required) {
    assert(
      cohort.artifacts.some(artifact => artifact.sourceName === name),
      `Packed cohort is missing ${name}`,
    );
    assert(roots[name], `Packed consumer is missing ${name}`);
  }
  return {
    renderer,
    consumerRoot,
    manifestPath: release.manifestPath,
    workRoot,
    pnpmExecutable: input.pnpmExecutable,
    cohort,
    release,
    packageRequests,
    packageRoots: roots,
    packageIdentities: Object.fromEntries(
      Object.entries(roots).map(([name, directory]) => {
        const installed = readJson(path.join(directory, 'package.json'));
        return [name, { name: installed.name, version: installed.version }];
      }),
    ),
    appToolsRoot: roots['@modern-js/ultramodern-app-tools'],
    allowBuilds: input.allowBuilds,
    generatorConsumerRoot: input.generatorConsumerRoot,
    browserDependencyRoot: input.browserDependencyRoot,
    browserExecutable: input.browserExecutable,
  };
}

/** Translate fixture declarations to the same aliases and native pins users install. */
export function packedNativeFederationManifest(manifest, context) {
  const artifacts = new Map(
    context.cohort.artifacts.map(artifact => [artifact.sourceName, artifact]),
  );
  const request = (name, supplied) => {
    const artifact = artifacts.get(name);
    if (artifact) return `npm:${artifact.targetName}@${artifact.version}`;
    assert(!name.startsWith('@modern-js/'), `Packed cohort is missing ${name}`);
    if (nativeDependency(name))
      assert(
        context.packageRequests[name],
        `Packed consumer is missing the ${name} dependency pin`,
      );
    const selected = context.packageRequests[name] ?? supplied;
    assert(
      typeof selected === 'string',
      `Packed native MF is missing the ${name} dependency pin`,
    );
    assert(
      !/^(?:workspace:|link:|file:)/u.test(selected),
      `${name} cannot use a source dependency in packed MF`,
    );
    if (!selected.startsWith('catalog:')) return selected;
    const directory = context.packageRoots[name];
    assert(directory, `Packed consumer did not install ${name}`);
    const installed = readJson(path.join(directory, 'package.json'));
    return installed.name === name
      ? installed.version
      : `npm:${installed.name}@${installed.version}`;
  };
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, version]) => [
      name,
      request(name, version),
    ]),
  );
  for (const name of [
    '@modern-js/federation-runtime',
    '@module-federation/runtime',
  ])
    if (context.packageRequests[name]) dependencies[name] = request(name);
  const devDependencies = Object.fromEntries(
    Object.entries(manifest.devDependencies ?? {}).map(([name, version]) => [
      name,
      request(name, version),
    ]),
  );
  for (const name of ['typescript', '@types/node']) {
    const directory = context.packageRoots[name];
    assert(directory, `Packed consumer did not install ${name}`);
    devDependencies[name] = request(
      name,
      readJson(path.join(directory, 'package.json')).version,
    );
  }
  return { ...manifest, dependencies, devDependencies };
}

/** Install a fresh owned app or workspace under the same candidate policy. */
export async function installPackedNativeFederationDependencies({
  directory,
  context,
  registerArtifact,
  signal,
  installerWitnessPath,
}) {
  const appRoot = fs.realpathSync(directory);
  assert(
    inside(context.workRoot, appRoot),
    'Packed MF fixture must belong to its owned temporary run',
  );
  for (const key of [
    'pnpm_config_minimum_release_age',
    'pnpm_config_minimum_release_age_strict',
    'pnpm_config_minimum_release_age_ignore_missing_time',
  ])
    assert(process.env[key], `Packed MF requires the inherited ${key} policy`);
  assert(
    Number(process.env.pnpm_config_minimum_release_age) >= 1440,
    'Packed MF requires the release-age policy',
  );
  assert.equal(process.env.pnpm_config_minimum_release_age_strict, 'true');
  assert.equal(
    process.env.pnpm_config_minimum_release_age_ignore_missing_time,
    'false',
  );
  assert(
    process.env.npm_config_store_dir || process.env.pnpm_config_store_dir,
    'Packed MF requires the external shared pnpm store',
  );
  const dependencies = path.join(appRoot, 'node_modules');
  fs.mkdirSync(dependencies);
  await registerArtifact?.(dependencies, 'dependencies');
  assert.equal(
    execFileSync(context.pnpmExecutable, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim(),
    context.release.tools.pnpm,
  );
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error('Packed native MF installation interrupted'));
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.once(event, interrupt);
  try {
    // The wrapper records its private group before pnpm starts. The parent
    // acceptance command can still retire it if the proof is interrupted.
    const witness = installerWitnessPath
      ? path.resolve(installerWitnessPath)
      : path.join(appRoot, 'packed-mf-install-process.json');
    assert(
      inside(context.workRoot, witness),
      'Packed installer witness must belong to its proof',
    );
    const releaseAgeBaseline = captureReleaseAgeExclusions(appRoot, {
      release: context.release,
    });
    await runPackedNativeFederationCommand(
      context.pnpmExecutable,
      ['install'],
      {
        witness,
        cwd: appRoot,
        env: {
          ...process.env,
          NODE_PATH: '',
          CI: 'true',
          npm_config_package_import_method: 'clone-or-copy',
          pnpm_config_package_import_method: 'clone-or-copy',
        },
        log: path.join(appRoot, 'packed-mf-install.log'),
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
      },
    );
    assertReleaseAgeExclusionsUnchanged(releaseAgeBaseline);
  } finally {
    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.removeListener(event, interrupt);
  }
  assert.equal(
    installedStore(appRoot),
    path.join(appRoot, 'node_modules/.pnpm'),
    'Packed MF fixtures require independent installs',
  );
  checkInstalledCohort({ appRoot, cohort: context.cohort });
}

/** Install an independently owned fixture, never linking a source package. */
export async function preparePackedNativeFederationApp({
  directory,
  renderer,
  context,
  registerArtifact,
  signal,
  installerWitnessPath,
}) {
  assert(
    context.release.packages.some(
      item => item.sourceName === `@modern-js/renderer-${renderer}`,
    ),
  );
  const appRoot = fs.realpathSync(directory);
  assert(
    inside(context.workRoot, appRoot),
    'Packed MF fixture must belong to its owned temporary run',
  );
  const manifestPath = path.join(appRoot, 'package.json');
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(packedNativeFederationManifest(readJson(manifestPath), context), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(appRoot, 'pnpm-workspace.yaml'),
    stringifyYaml({
      packages: ['.'],
      packageImportMethod: 'clone-or-copy',
      minimumReleaseAge: 1440,
      minimumReleaseAgeStrict: true,
      minimumReleaseAgeIgnoreMissingTime: false,
      allowBuilds: context.allowBuilds,
    }),
  );
  await installPackedNativeFederationDependencies({
    directory: appRoot,
    context,
    registerArtifact,
    signal,
    installerWitnessPath,
  });
  const roots = verifyPackedNativeFederationDependencies({
    appRoot,
    cohort: context.cohort,
    packageIdentities: context.packageIdentities,
  });
  for (const name of [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/renderer-core',
    `@modern-js/renderer-${renderer}`,
    '@module-federation/enhanced',
    '@module-federation/node',
  ])
    assert(roots[name], `Packed MF fixture did not install ${name}`);
  return roots;
}

/** Run the existing native behavior proof using only installed candidate packages. */
export async function runPackedNativeFederationProof({
  renderer,
  consumerRoot,
  manifestPath,
  pnpmExecutable,
  workDir,
  log,
  env,
  signal,
  allowBuilds,
  proofScript,
  contextExtras = {},
  processWitnessPaths = ['remote', 'host', 'host-csr'].map(directory =>
    path.join(directory, 'packed-mf-install-process.json'),
  ),
}) {
  assert(['solid', 'octane'].includes(renderer));
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run packed native MF through owned-temp-dir',
  );
  const leaseRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  assert(
    inside(leaseRoot, workDir),
    'Packed MF work must belong to the release run',
  );
  assert(
    !fs.existsSync(workDir),
    `Packed MF work directory already exists: ${workDir}`,
  );
  const owner = `renderer-mf-packed-${renderer}-${process.pid}`;
  const registration = registerOwnedRoot({
    workDir,
    owner,
    ownerPid: process.pid,
  });
  const contextPath = path.join(workDir, 'context.json');
  const witnessDirectory = path.join(workDir, 'process-witnesses');
  const cleanupErrors = [];
  let failure;
  try {
    fs.mkdirSync(witnessDirectory);
    fs.writeFileSync(
      contextPath,
      `${JSON.stringify({ ...contextExtras, schemaVersion: 1, renderer, consumerRoot, manifestPath, pnpmExecutable, allowBuilds }, null, 2)}\n`,
      { flag: 'wx' },
    );
    await runCommand(
      process.execPath,
      [
        proofScript ??
          fileURLToPath(
            new URL(
              `../../tests/ultramodern-renderers/${renderer}-federation/proof.mjs`,
              import.meta.url,
            ),
          ),
      ],
      {
        cwd: workDir,
        env: {
          ...env,
          NODE_PATH: '',
          OWNED_TEMP_DIR: workDir,
          TMPDIR: `${workDir}/`,
          ULTRAMODERN_MF_PACKED_CONTEXT: contextPath,
        },
        log,
        signal: signal ?? new AbortController().signal,
        cleanupErrors,
      },
    );
  } catch (error) {
    failure = error;
  } finally {
    const witnessPaths = [...processWitnessPaths];
    if (fs.existsSync(witnessDirectory)) {
      try {
        for (const entry of fs.readdirSync(witnessDirectory, {
          withFileTypes: true,
        })) {
          if (!entry.isFile() || !/^\d+\.json$/u.test(entry.name)) {
            cleanupErrors.push({
              path: path.join(witnessDirectory, entry.name),
              message: 'Invalid packed MF process witness',
            });
            continue;
          }
          witnessPaths.push(path.join('process-witnesses', entry.name));
        }
      } catch (error) {
        cleanupErrors.push({ path: witnessDirectory, message: error.message });
      }
    }
    for (const relativePath of witnessPaths) {
      const witness = path.resolve(workDir, relativePath);
      assert(
        inside(workDir, witness),
        'Packed MF process witness must belong to its proof',
      );
      if (!fs.existsSync(witness) || process.platform === 'win32') continue;
      try {
        await retirePackedNativeFederationInstaller(readJson(witness));
      } catch (error) {
        cleanupErrors.push({ path: witness, message: error.message });
      }
    }
    if (cleanupErrors.length) {
      const error = new Error(
        `Packed native MF process cleanup failed; retained ${workDir}`,
      );
      error.cause = failure;
      error.cleanupErrors = cleanupErrors;
      failure = error;
    } else {
      // The caller's lease owns only the new proof tree. Installed starter
      // packages and the shared pnpm store remain outside this cleanup.
      try {
        if (registration.status === 'registered')
          execFileSync(
            'disk-guardian-artifacts',
            ['release', workDir, '--owner', owner],
            { stdio: 'pipe' },
          );
        fs.rmSync(workDir, { recursive: true });
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              'Packed native MF proof and cleanup failed',
            )
          : error;
      }
    }
  }
  if (failure) throw failure;
}
