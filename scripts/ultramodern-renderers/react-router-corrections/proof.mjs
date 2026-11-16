import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packArchive,
  readArchive,
} from '../../ultramodern-dependencies/test-peer-corrections/archive.mjs';
import { authenticateArchive } from '../../ultramodern-dependencies/test-peer-corrections/authenticate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const inputs = JSON.parse(fs.readFileSync(path.join(here, 'inputs.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function isolatedEnvironment(work) {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']
      .filter(key => process.env[key])
      .map(key => [key, process.env[key]]),
  );
  env.CI = 'true';
  for (const key of ['userconfig', 'globalconfig']) {
    const file = path.join(work, `${key}.npmrc`);
    fs.writeFileSync(file, '');
    env[`npm_config_${key}`] = file;
  }
  return env;
}

export function assertInstalled(directory, archiveBytes) {
  const expected = readArchive(archiveBytes);
  const actual = fs.readdirSync(directory, { recursive: true }).filter(file => {
    if (file === 'node_modules' || file.startsWith(`node_modules${path.sep}`))
      return false;
    return fs.statSync(path.join(directory, file)).isFile();
  });
  assert.deepEqual(actual.sort(), [...expected.keys()].sort());
  for (const [file, bytes] of expected) {
    assert(
      fs.readFileSync(path.join(directory, file)).equals(bytes),
      `Installed bytes differ: ${file}`,
    );
    assert.equal(
      fs.statSync(path.join(directory, file)).mode & 0o777,
      expected.modes.get(file),
      `Installed mode differs: ${file}`,
    );
  }
  return expected.size;
}

export function graph(directory, rootCoreBytes, reactBytes) {
  const app = createRequire(path.join(directory, 'package.json'));
  const reactManifest = app.resolve('@tanstack/react-router/package.json');
  const react = createRequire(reactManifest);
  const rootCore = fs.realpathSync(
    app.resolve('@tanstack/router-core/package.json'),
  );
  const reactCore = fs.realpathSync(
    react.resolve('@tanstack/router-core/package.json'),
  );
  const files = {
    rootCore: assertInstalled(path.dirname(rootCore), rootCoreBytes),
    react: assertInstalled(path.dirname(reactManifest), reactBytes),
  };
  const physicalCores = fs
    .readdirSync(path.join(directory, 'node_modules/.pnpm'))
    .filter(name => name.startsWith('@tanstack+router-core@'));
  return {
    singleton: rootCore === reactCore,
    rootCore: path.relative(directory, rootCore),
    reactCore: path.relative(directory, reactCore),
    physicalCores,
    files,
  };
}

export async function prepare({ work, run }) {
  const authenticated = [];
  for (const identity of inputs.identities) {
    const response = await fetch(identity.tarball, {
      signal: AbortSignal.timeout(60000),
    });
    assert(response.ok, `Fetch failed: ${identity.tarball}`);
    authenticated.push(
      authenticateArchive(identity, Buffer.from(await response.arrayBuffer())),
    );
  }
  const [react, core] = authenticated;
  const original = path.join(work, 'core');
  fs.mkdirSync(original);
  for (const [file, bytes] of readArchive(core.archiveBytes)) {
    const target = path.join(original, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const patch = fs.readFileSync(
    path.join(repo, 'patches/@tanstack__router-core@1.171.39.patch'),
  );
  assert.equal(hash(patch), inputs.corePatchSha256);
  run('patch', ['-p1', '--fuzz=0', '--batch'], original, { input: patch });
  const files = new Map();
  files.modes = new Map();
  for (const file of fs.readdirSync(original, { recursive: true })) {
    const target = path.join(original, file);
    if (!fs.statSync(target).isFile()) continue;
    files.set(file, fs.readFileSync(target));
    files.modes.set(file, fs.statSync(target).mode & 0o777);
  }
  return { react, core, coreBytes: packArchive(files), corePatch: patch };
}

export function writeConsumer({ directory, reactBytes, coreBytes, store }) {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'react.tgz'), reactBytes);
  fs.writeFileSync(path.join(directory, 'core.tgz'), coreBytes);
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'pnpm@12.21.0',
      dependencies: {
        '@tanstack/react-router': 'file:./react.tgz',
        '@tanstack/router-core': 'file:./core.tgz',
        react: '19.3.1',
        'react-dom': '19.3.1',
      },
      devDependencies: {
        typescript: '7.0.2',
        '@types/react': '19.2.17',
        '@types/react-dom': '19.2.3',
      },
    }),
  );
  fs.writeFileSync(
    path.join(directory, 'pnpm-workspace.yaml'),
    `packages: []\nregistry: https://registry.npmjs.org/\nstoreDir: ${JSON.stringify(store)}\npackageImportMethod: clone-or-copy\nblockExoticSubdeps: true\ntrustPolicy: no-downgrade\nstrictPeerDependencies: true\n`,
  );
}

export async function main() {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir --run');
  assert(process.env.REACT_ROUTER_STORE, 'External shared store required');
  const work = process.env.OWNED_TEMP_DIR;
  const env = isolatedEnvironment(work);
  const run = (cmd, args, cwd, options = {}) =>
    execFileSync(
      cmd === 'pnpm' ? (process.env.REACT_ROUTER_PNPM ?? cmd) : cmd,
      args,
      { cwd, env, stdio: 'pipe', ...options },
    );
  assert.equal(run('pnpm', ['--version'], work).toString().trim(), '12.21.0');
  const prepared = await prepare({ work, run });
  const directory = path.join(work, 'ordinary');
  writeConsumer({
    directory,
    reactBytes: prepared.react.archiveBytes,
    coreBytes: prepared.coreBytes,
    store: process.env.REACT_ROUTER_STORE,
  });
  const deps = path.join(directory, 'node_modules');
  fs.mkdirSync(deps);
  const owner = `react-router-proof-${process.pid}`;
  const guardian = '/Users/satan/bin/disk-guardian-artifacts';
  run(
    guardian,
    [
      'register',
      deps,
      '--owner',
      owner,
      '--owner-pid',
      String(process.pid),
      '--kind',
      'dependencies',
    ],
    work,
  );
  try {
    run('pnpm', ['install'], directory);
    const result = graph(
      directory,
      prepared.coreBytes,
      prepared.react.archiveBytes,
    );
    if (!result.singleton) {
      const app = createRequire(path.join(directory, 'package.json'));
      const react = createRequire(
        app.resolve('@tanstack/react-router/package.json'),
      );
      const registryCore = path.dirname(
        react.resolve('@tanstack/router-core/package.json'),
      );
      result.files.registryCore = assertInstalled(
        registryCore,
        prepared.core.archiveBytes,
      );
    }
    console.log('ORDINARY_GRAPH', JSON.stringify(result, null, 2));
  } finally {
    run(guardian, ['release', deps, '--owner', owner], work);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
