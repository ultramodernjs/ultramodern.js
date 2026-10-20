import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
import { inspectNpmTarball } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { readReleaseManifest } from '../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import {
  checkInstalledCohort,
  readCohort,
  verifyInstalledPackage,
} from './installed-cohort.mjs';
import {
  assertNativeStartPeers,
  nativeFederationPackageRequests,
  nativeStartArchiveRequests,
  nativeStartSharedPeers,
} from './native-federation-inputs.mjs';
import {
  assertReleaseAgeExclusionsUnchanged,
  captureReleaseAgeExclusions,
} from './release-age-policy.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const nativeDependency = name =>
  /^(?:@module-federation\/|@octanejs\/|@solidjs\/|@tanstack\/(?:router-core|start-storage-context|start-client-core|start-server-core)$|@tsrx\/oxc$|octane$|solid-js$|i18next$|typescript$|@types\/node$)/u.test(
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

/** Authored i18n proofs use the consumer's pin or the authenticated cohort's pin. */
export function packedI18nextRequest({ packageRequests, release }) {
  const request =
    packageRequests.i18next ??
    release?.packages.find(
      item => item.sourceName === '@modern-js/i18n-runtime-extensions',
    )?.packageJson.devDependencies?.i18next;
  assert(
    typeof request === 'string' && /^\d+\.\d+\.\d+$/u.test(request),
    'The consumer or authenticated i18n cohort must pin i18next exactly',
  );
  return request;
}

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
  const requests = nativeFederationPackageRequests(manifest);
  for (const name of dependencyNames ?? Object.keys(requests)) {
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
      const request = requests[name];
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

/** Verify supplied native packs before any dev server can execute their files. */
export function verifyPackedNativeFederationInputs(appRoot, inputs) {
  const manifest = readJson(path.join(appRoot, 'package.json'));
  const requests = nativeFederationPackageRequests(manifest);
  const startRequests = nativeStartArchiveRequests(requests);
  if (!inputs) {
    assert.equal(
      Object.keys(startRequests).length,
      0,
      'Declared Start requests require authenticated native inputs',
    );
    return;
  }
  const startInputs = nativeStartArchiveRequests(
    Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => [name, input.request]),
    ),
  );
  if (Object.keys(startRequests).length)
    assert.deepEqual(
      startRequests,
      startInputs,
      'Declared Start requests must retain their authenticated inputs',
    );
  const packedPackages = new Map();
  for (const name of [
    'octane',
    '@octanejs/tanstack-router',
    '@octanejs/rspack-plugin',
    '@tanstack/router-core',
    ...Object.keys(startRequests).filter(
      name => name !== '@tanstack/router-core',
    ),
  ]) {
    const input = inputs[name];
    assert(input, `Missing exact native input: ${name}`);
    assert.equal(
      requests[name],
      input.request,
      `${name} must retain its supplied native archive request`,
    );
    assert(path.isAbsolute(input.archivePath));
    assert.equal(fs.realpathSync(input.archivePath), input.archivePath);
    const bytes = fs.readFileSync(input.archivePath);
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      input.integrity,
      `${name} differs from its supplied archive integrity`,
    );
    const packed = inspectNpmTarball(bytes);
    assert.equal(packed.packageJson.name, name);
    if (startRequests[name])
      assert(
        input.request.endsWith(
          `/tanstack-${name.slice('@tanstack/'.length)}-${packed.packageJson.version}.tgz`,
        ),
        `${name} differs from its declared archive version`,
      );
    packedPackages.set(name, packed.packageJson);
    verifyInstalledPackage(
      fs.realpathSync(path.join(appRoot, 'node_modules', name)),
      {
        targetName: name,
        files: packed.files.map(file => ({
          ...file,
          sha256: createHash('sha256')
            .update(packed.fileContents.get(file.path))
            .digest('hex'),
        })),
      },
    );
  }
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const versions = Object.fromEntries(
    [...packedPackages].map(([name, value]) => [name, value.version]),
  );
  for (const [name, peers] of Object.entries(nativeStartSharedPeers)) {
    if (!startRequests[name]) continue;
    assertNativeStartPeers(packedPackages.get(name), versions);
    const owner = createRequire(
      fs.realpathSync(appRequire.resolve(`${name}/package.json`)),
    );
    for (const peer of peers)
      assert.equal(
        fs.realpathSync(owner.resolve(`${peer}/package.json`)),
        fs.realpathSync(appRequire.resolve(`${peer}/package.json`)),
        `${name} must resolve the application's physical ${peer}`,
      );
  }
  for (const name of [
    '@octanejs/tanstack-start',
    '@octanejs/tanstack-router-ssr-query',
  ]) {
    if (!Object.hasOwn(requests, name)) continue;
    const owner = createRequire(
      fs.realpathSync(path.join(appRoot, 'node_modules', name, 'package.json')),
    );
    for (const peer of [
      '@tanstack/router-core',
      ...(name === '@octanejs/tanstack-start'
        ? Object.keys(startRequests).filter(
            name => name !== '@tanstack/router-core',
          )
        : []),
    ])
      assert.equal(
        fs.realpathSync(owner.resolve(`${peer}/package.json`)),
        fs.realpathSync(appRequire.resolve(`${peer}/package.json`)),
        `${name} must resolve the application's physical ${peer}`,
      );
  }
  const adapterRequire = createRequire(
    fs.realpathSync(
      path.join(appRoot, 'node_modules/@octanejs/tanstack-router/package.json'),
    ),
  );
  assert.equal(
    fs.realpathSync(
      adapterRequire.resolve('@tanstack/router-core/package.json'),
    ),
    fs.realpathSync(appRequire.resolve('@tanstack/router-core/package.json')),
    'Application and native adapter must resolve one physical router core',
  );
  const rendererRequire = createRequire(
    fs.realpathSync(
      path.join(
        appRoot,
        'node_modules/@modern-js/renderer-octane/package.json',
      ),
    ),
  );
  for (const name of ['@octanejs/tanstack-router', '@tanstack/router-core'])
    assert.equal(
      fs.realpathSync(rendererRequire.resolve(`${name}/package.json`)),
      fs.realpathSync(appRequire.resolve(`${name}/package.json`)),
      `Octane renderer must resolve the application's physical ${name}`,
    );
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
  const packageRequests = nativeFederationPackageRequests(manifest);
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
  verifyPackedNativeFederationInputs(consumerRoot, input.nativeInputs);
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
    nativeInputs: input.nativeInputs,
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
  const startRequests = nativeStartArchiveRequests(context.packageRequests);
  const artifacts = new Map(
    context.cohort.artifacts.map(artifact => [artifact.sourceName, artifact]),
  );
  const request = (name, supplied) => {
    const artifact = artifacts.get(name);
    if (artifact) return `npm:${artifact.targetName}@${artifact.version}`;
    assert(!name.startsWith('@modern-js/'), `Packed cohort is missing ${name}`);
    if (name === 'i18next') {
      const selected = packedI18nextRequest(context);
      assert.equal(
        supplied,
        selected,
        'Authored i18next must match the consumer or authenticated i18n cohort pin',
      );
      return selected;
    }
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
    '@tanstack/router-core',
    ...Object.keys(startRequests),
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
  verifyPackedNativeFederationInputs(appRoot, context.nativeInputs);
  return roots;
}

/** Author the existing shared-source workspace topology using exact packed requests. */
export function writePackedNativeFederationWorkspace({
  directory,
  applications,
  sharedPackage,
  context,
}) {
  const workspaceRoot = fs.realpathSync(directory);
  assert(
    inside(context.workRoot, workspaceRoot),
    'Packed workspace must belong to its owned temporary run',
  );
  const sharedRoot = path.join(workspaceRoot, 'shared');
  assert.equal(sharedPackage.directory, sharedRoot);
  assert.equal(sharedPackage.name, '@authored-worker/shared-counter');
  assert.equal(typeof context.packageRequests.octane, 'string');
  assert(
    !fs.existsSync(sharedRoot),
    'Shared Counter package must be newly owned',
  );
  fs.mkdirSync(sharedRoot);
  for (const [filename, content] of Object.entries(sharedPackage.files)) {
    const destination = path.resolve(sharedRoot, filename);
    assert(
      inside(sharedRoot, destination),
      'Shared source must belong to its authored package',
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  const sharedManifest = {
    name: sharedPackage.name,
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: { '.': { types: './Counter.tsx', default: './Counter.tsx' } },
    dependencies: { octane: context.packageRequests.octane },
  };
  fs.writeFileSync(
    path.join(sharedRoot, 'package.json'),
    JSON.stringify(sharedManifest, null, 2),
  );
  for (const appRoot of applications) {
    assert(
      inside(workspaceRoot, fs.realpathSync(appRoot)),
      'Packed app must belong to its workspace',
    );
    const filename = path.join(appRoot, 'package.json');
    const manifest = readJson(filename);
    assert.equal(manifest.dependencies[sharedPackage.name], 'workspace:*');
    const { [sharedPackage.name]: shared, ...dependencies } =
      manifest.dependencies;
    const packed = packedNativeFederationManifest(
      { ...manifest, dependencies },
      context,
    );
    packed.dependencies[sharedPackage.name] = shared;
    fs.writeFileSync(filename, JSON.stringify(packed, null, 2));
  }
  fs.writeFileSync(
    path.join(workspaceRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'authored-packed-workers',
        version: '0.0.0',
        private: true,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'pnpm-workspace.yaml'),
    stringifyYaml({
      packages: [
        ...applications.map(appRoot => path.relative(workspaceRoot, appRoot)),
        'shared',
      ],
      packageImportMethod: 'clone-or-copy',
      minimumReleaseAge: 1440,
      minimumReleaseAgeStrict: true,
      minimumReleaseAgeIgnoreMissingTime: false,
      minimumReleaseAgeExclude: [],
      allowBuilds: context.allowBuilds,
    }),
  );
}

/** A workspace source link is allowed only for the one owned authored Counter. */
export function verifyPackedNativeFederationWorkspace({
  directory,
  applications,
  sharedPackage,
  context,
}) {
  const workspaceRoot = fs.realpathSync(directory);
  assert(
    inside(context.workRoot, workspaceRoot),
    'Packed workspace must belong to its owned temporary run',
  );
  const storeRoot = path.join(workspaceRoot, 'node_modules/.pnpm');
  assert.equal(
    installedStore(workspaceRoot),
    storeRoot,
    'Packed workspace requires its own physical pnpm store',
  );
  const sharedRoot = fs.realpathSync(sharedPackage.directory);
  assert.equal(
    sharedRoot,
    path.join(workspaceRoot, 'shared'),
    'Shared Counter must be the owned workspace package',
  );
  const sharedManifest = readJson(path.join(sharedRoot, 'package.json'));
  assert.equal(sharedManifest.name, sharedPackage.name);
  assert.deepEqual(sharedManifest.dependencies, {
    octane: context.packageRequests.octane,
  });
  assert.deepEqual(sharedManifest.exports, {
    '.': { types: './Counter.tsx', default: './Counter.tsx' },
  });
  for (const [filename, content] of Object.entries(sharedPackage.files)) {
    const source = path.resolve(sharedRoot, filename);
    assert(inside(sharedRoot, source));
    assert.equal(
      fs.realpathSync(source),
      source,
      'Shared Counter source must be physical',
    );
    assert.equal(
      fs.readFileSync(source, 'utf8'),
      content,
      'Shared Counter differs from its authored source',
    );
  }
  const sharedRuntime = verifyPackedNativeFederationDependencies({
    appRoot: sharedRoot,
    storeRoot,
    cohort: context.cohort,
    packageIdentities: context.packageIdentities,
  }).octane;
  return applications.map(appRoot => {
    assert(
      inside(workspaceRoot, fs.realpathSync(appRoot)),
      'Packed app must belong to its workspace',
    );
    assert.equal(
      installedStore(appRoot),
      storeRoot,
      'Packed app must use its workspace pnpm store',
    );
    const manifest = readJson(path.join(appRoot, 'package.json'));
    assert.equal(manifest.dependencies[sharedPackage.name], 'workspace:*');
    assert.equal(
      fs.realpathSync(path.join(appRoot, 'node_modules', sharedPackage.name)),
      sharedRoot,
      'Shared Counter link must resolve to the owned workspace package',
    );
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).filter(name => name !== sharedPackage.name);
    const roots = verifyPackedNativeFederationDependencies({
      appRoot,
      storeRoot,
      dependencyNames,
      cohort: context.cohort,
      packageIdentities: context.packageIdentities,
    });
    assert.equal(
      roots.octane,
      sharedRuntime,
      'Shared Counter and app must resolve one physical Octane runtime',
    );
    checkInstalledCohort({ appRoot, cohort: context.cohort });
    verifyPackedNativeFederationInputs(appRoot, context.nativeInputs);
    return roots;
  });
}

/** Install one explicit owned workspace, retaining standalone app isolation elsewhere. */
export async function preparePackedNativeFederationWorkspace(options) {
  assert(
    options.context.nativeInputs,
    'Packed workspace requires authenticated native archives',
  );
  writePackedNativeFederationWorkspace(options);
  await installPackedNativeFederationDependencies(options);
  return verifyPackedNativeFederationWorkspace(options);
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
  registerRoot = registerOwnedRoot,
  releaseRoot = (directory, owner) =>
    execFileSync(
      'disk-guardian-artifacts',
      ['release', directory, '--owner', owner],
      { stdio: 'pipe' },
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
  verifyPackedNativeFederationInputs(consumerRoot, contextExtras.nativeInputs);
  const owner = `renderer-mf-packed-${renderer}-${process.pid}`;
  const registration = registerRoot({
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
        if (registration.status === 'registered') releaseRoot(workDir, owner);
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
