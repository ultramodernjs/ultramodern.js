import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeHydrationReporter } from './hydration-reporter.mjs';
import { qualifyAllHydration } from './qualify-all-hydration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const runtimePatchOrder = Object.freeze([
  'runtime-source.patch',
  'typescript-compat/typescript-source.patch',
  'typescript-compat/native-signals-source.patch',
  'typescript-compat/volar-core-source.patch',
  'runtime-tests.patch',
  'rspack-source.patch',
  'rspack-tests.patch',
  'css-properties-source.patch',
]);
export function octane20RuntimeInputs() {
  const directory = path.join(here, 'octane-0.20.0');
  const { upstream } = JSON.parse(
    fs.readFileSync(path.join(directory, 'provenance.json'), 'utf8'),
  );
  const names = ['octane', '@octanejs/rspack-plugin'];
  const inputs = names.map(name => ({ name, ...upstream.packages[name] }));
  for (const { name, version } of inputs)
    assert.equal(upstream.tags[`${name}@${version}`], upstream.commit);
  const localPatches = new Set([
    'runtime-source.patch',
    'rspack-source.patch',
    'rspack-tests.patch',
    'css-properties-source.patch',
  ]);
  return {
    source: { ...upstream.sourceArchive, commit: upstream.commit },
    sourceIntegrity: upstream.sourceArchive.integrity,
    packages: inputs,
    runtimePair: Object.fromEntries(
      inputs.map(({ name, version, licenseSha256 }) => [
        name,
        {
          patchPath:
            name === 'octane'
              ? 'patches/octane@0.20.0.css-properties.patch'
              : `patches/${name.replace('/', '__')}@${version}.patch`,
          licenseSha256,
        },
      ]),
    ),
    dependencyDirectory: directory,
    patches: runtimePatchOrder.map(name =>
      path.join(localPatches.has(name) ? directory : here, name),
    ),
  };
}

export const hydrationParitySlices = Object.freeze([
  'automatic-signal-stream',
  'early-control-handoff',
  'independent-island-signal-identity',
  'pending-snapshot-seed',
  'returned-jsx-query-resume',
  'signal-declaration-owner',
  'stream-delivery',
  'streamed-query-hydrate',
  'initial-suspense-hydrate',
  'range-boundary',
  'unclosed-range',
]);
export function buildEnvironment(env = process.env) {
  const allowed = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'CI',
    'LANG',
    'LC_ALL',
    'TZ',
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key)),
  );
}
const run = (command, args, cwd, extra = {}) =>
  execFileSync(command, args, {
    cwd,
    env: buildEnvironment(),
    stdio: 'inherit',
    ...extra,
  });
const digest = (algorithm, bytes) =>
  createHash(algorithm).update(bytes).digest('hex');
const integrity = bytes =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/**
 * Exact byte equality with a bounded report. assert.deepEqual renders a diff
 * whose cost grows superlinearly with Buffer size, so a mismatch in a
 * multi-MiB patch or emitted file exhausts the runner instead of failing.
 */
export function assertSameBytes(actual, expected, label) {
  if (actual.equals(expected)) return;
  let offset = 0;
  while (actual[offset] === expected[offset]) offset++;
  assert.fail(
    `${label}: bytes differ from offset ${offset}; actual ${actual.length} bytes ` +
      `sha256 ${digest('sha256', actual)}, expected ${expected.length} bytes ` +
      `sha256 ${digest('sha256', expected)}`,
  );
}

function disk(directory) {
  const { bavail, bsize } = fs.statfsSync(directory);
  assert(bavail * bsize >= 20 * 1024 ** 3, 'Below 20 GiB: stop allocation');
}

export function applyExact(root, patch, execute = run) {
  const checked = spawnSync('git', ['apply', '--check', '--verbose', patch], {
    cwd: root,
    env: buildEnvironment(),
    encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert(!/offset|fuzz/i.test(checked.stderr), checked.stderr);
  execute('git', ['apply', patch], root);
}

async function download(url, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert(response.ok, `${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(integrity(bytes), expected, `Unauthenticated archive: ${url}`);
  return bytes;
}

function extract(bytes, directory, execute = run) {
  fs.mkdirSync(directory, { recursive: true });
  const archive = `${directory}.tgz`;
  fs.writeFileSync(archive, bytes);
  execute(
    'tar',
    ['-xzf', archive, '--strip-components=1', '-C', directory],
    path.dirname(directory),
  );
}

function files(directory) {
  return fs
    .readdirSync(directory, { recursive: true })
    .filter(name => fs.lstatSync(path.join(directory, name)).isFile())
    .sort();
}

/** A deterministic npm-layout diff, containing owning build output, never a dist rewrite. */
export function packagePatch(pristine, built) {
  let patch = '';
  for (const name of [
    ...new Set([...files(pristine), ...files(built)]),
  ].sort()) {
    const a = path.join(pristine, name),
      b = path.join(built, name);
    if (
      fs.existsSync(a) &&
      fs.existsSync(b) &&
      fs.readFileSync(a).equals(fs.readFileSync(b))
    )
      continue;
    const diff = spawnSync(
      'git',
      [
        'diff',
        '--no-index',
        '--diff-algorithm=histogram',
        '--unified=3',
        '--indent-heuristic',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--no-color',
        '--abbrev=7',
        '--',
        fs.existsSync(a) ? a : '/dev/null',
        fs.existsSync(b) ? b : '/dev/null',
      ],
      {
        cwd: pristine,
        env: {
          ...buildEnvironment(),
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: '1',
        },
        encoding: 'utf8',
        maxBuffer: 128 * 1024 ** 2,
      },
    );
    assert(diff.status === 0 || diff.status === 1, diff.stderr);
    patch += diff.stdout
      .replaceAll(`a${pristine}/`, 'a/')
      .replaceAll(`b${built}/`, 'b/')
      .replaceAll(`a${built}/`, 'a/')
      .replaceAll(`b${pristine}/`, 'b/');
  }
  return Buffer.from(patch);
}

export function assemblePackage(
  upstream,
  sourcePackage,
  destination,
  expectedVersion,
) {
  fs.cpSync(upstream, destination, { recursive: true });
  fs.rmSync(path.join(destination, 'dist'), { recursive: true, force: true });
  fs.cpSync(path.join(sourcePackage, 'dist'), path.join(destination, 'dist'), {
    recursive: true,
  });
  const file = path.join(destination, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  assert.equal(manifest.name, 'octane');
  assert.equal(manifest.version, expectedVersion);
  manifest.dependencies['@tsrx/core'] = '^0.6.1';
  manifest.dependencies.esrap = '^2.4.0';
  manifest.peerDependencies['@tsrx/oxc'] = '^0.24.0';
  manifest.peerDependencies.typescript =
    '^5.9.3 || ^6.0.0 || ^7.0.2 || >=7.1.0-0';
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Run the same authored behavioral suites against source or emitted npm modules. */
export function qualifyRuntimeTree(
  root,
  modules,
  packed,
  execute = run,
  {
    upstream = false,
    parityOnly = false,
    jsonReport,
    suites,
    authoritativeIds = false,
  } = {},
) {
  const pkg = path.join(root, 'packages/octane');
  const target = packed ? path.join(packed, 'dist') : path.join(pkg, 'src');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packed ?? pkg, 'package.json')),
  );
  const aliases = Object.entries(manifest.exports)
    .filter(
      ([, entry]) =>
        typeof entry === 'string' || typeof entry.default === 'string',
    )
    .sort(([a], [b]) => b.length - a.length)
    .map(([subpath, entry]) => ({
      find: subpath === '.' ? 'octane' : `octane${subpath.slice(1)}`,
      replacement: path.resolve(
        packed ?? pkg,
        typeof entry === 'string' ? entry : entry.default,
      ),
    }));
  const focused = [
    'packages/octane/tests/hydration/*publisher*.test.ts',
    'packages/octane/tests/hydration/*external-snapshot*.test.ts',
    'packages/octane/tests/hydration/prepared-external-snapshot.test.ts',
    'packages/octane/tests/hydration/native-streamed-authority.test.ts',
  ];
  if (suites !== undefined) {
    assert(
      Array.isArray(suites) && suites.length > 0,
      'Explicit suites required',
    );
    assert.equal(new Set(suites).size, suites.length, 'Duplicate suite');
    for (const suite of suites) {
      assert(
        /^packages\/octane\/tests\/hydration\/[a-z0-9-]+\.test\.ts$/.test(
          suite,
        ),
        `Whole hydration suite required, not a filter: ${suite}`,
      );
      assert(
        fs.statSync(path.join(root, suite)).isFile(),
        `Missing suite: ${suite}`,
      );
    }
  }
  const include = suites ?? [
    ...(parityOnly ? [] : focused),
    ...(upstream || parityOnly
      ? hydrationParitySlices.map(
          name => `packages/octane/tests/hydration/${name}.test.ts`,
        )
      : []),
  ];
  const config = path.join(
    root,
    packed ? 'packed-runtime.config.mjs' : 'source-runtime.config.mjs',
  );
  // Relative private ABI imports in the historical regressions also go to the
  // emitted tree. No runtime source module is allowed into the packed graph.
  fs.writeFileSync(
    config,
    `
import {defineConfig} from 'vitest/config';
import {octane} from ${JSON.stringify(path.join(target, 'compiler/vite.js'))};
import path from 'node:path';
const src=${JSON.stringify(path.join(pkg, 'src') + path.sep)}, target=${JSON.stringify(target)};
export default defineConfig({
 plugins:[${
   packed
     ? `{name:'emitted-runtime-only',enforce:'pre',resolveId(id,importer){
 if(!importer||!id.startsWith('.'))return;
 const absolute=path.resolve(path.dirname(importer.split('?')[0]),id);
 if(absolute.startsWith(src))return path.join(target,absolute.slice(src.length)).replace(/\\.ts$/,'.js');
 }},`
     : ''
 }octane()],
 resolve:{alias:${JSON.stringify(aliases)}},
 test:{environment:'jsdom',include:${JSON.stringify(include)},maxWorkers:1,testTimeout:20000}
});`,
  );
  const reporter = path.join(root, 'hydration-reporter.mjs');
  if (authoritativeIds) {
    assert(jsonReport, 'Authoritative reporter requires structured output');
    writeHydrationReporter(reporter, jsonReport);
  }
  execute(
    process.execPath,
    [
      path.join(modules, 'vitest/vitest.mjs'),
      'run',
      '--config',
      config,
      ...(jsonReport
        ? [
            `--reporter=${authoritativeIds ? reporter : 'json'}`,
            `--outputFile=${jsonReport}`,
          ]
        : []),
    ],
    root,
  );
}

/** Run unchanged native compilation, factory-transfer and HMR assertions. */
export function qualifyRspackTree(root, modules, execute = run) {
  const runtimePackage = fs.realpathSync(path.join(root, 'packages/octane'));
  const sourceRuntime = fs.existsSync(path.join(runtimePackage, 'src'));
  const runtime = path.join(runtimePackage, sourceRuntime ? 'src' : 'dist');
  const installed = path.join(modules, 'octane');
  assert(
    fs.lstatSync(installed).isSymbolicLink(),
    'Operation-owned Octane dependency link required',
  );
  fs.unlinkSync(installed);
  fs.symlinkSync(runtimePackage, installed);
  const config = path.join(root, 'rspack-runtime.config.mjs');
  fs.writeFileSync(
    config,
    `
import{defineConfig}from'vitest/config';
const src=${JSON.stringify(runtime)};
export default defineConfig({
 resolve:{alias:[{find:/^octane\\/compiler(.*)$/,replacement:src+'/compiler$1'},
 {find:/^octane$/,replacement:src+${JSON.stringify(sourceRuntime ? '/index.ts' : '/index.js')}},
 {find:/^octane\\/(.*)$/,replacement:src+'/$1'}]},
 test:{environment:'node',include:[
 'packages/rspack-plugin-octane/tests/loader.test.ts',
 'packages/rspack-plugin-octane/tests/streamed-signals-hmr.test.ts',
 'packages/rspack-plugin-octane/tests/publisher-replacement.test.ts'
 ],maxWorkers:1,testTimeout:30000}
});`,
  );
  execute(
    process.execPath,
    [path.join(modules, 'vitest/vitest.mjs'), 'run', '--config', config],
    root,
  );
}

export function qualifyPackedRspack(
  root,
  modules,
  runtimePackage,
  rspackPackage,
  execute = run,
) {
  const staged = path.join(root, 'packed-rspack-tests');
  const octane = path.join(staged, 'packages/octane');
  const plugin = path.join(staged, 'packages/rspack-plugin-octane');
  fs.mkdirSync(path.join(staged, 'packages'), { recursive: true });
  // Keep the reconstructed npm layout untouched: add test inputs to a separate
  // stage, and never give packed tests access to a runtime src directory.
  fs.cpSync(runtimePackage, octane, {
    recursive: true,
    filter: file => path.basename(file) !== 'node_modules',
  });
  fs.cpSync(rspackPackage, plugin, { recursive: true });
  fs.cpSync(
    path.join(root, 'packages/rspack-plugin-octane/tests'),
    path.join(plugin, 'tests'),
    { recursive: true },
  );
  const fixtures = path.join(octane, 'tests/_fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  fs.writeFileSync(
    path.join(fixtures, 'signals-async-controls.ts'),
    fs
      .readFileSync(
        path.join(
          root,
          'packages/octane/tests/_fixtures/signals-async-controls.ts',
        ),
        'utf8',
      )
      .replace('../../src/host-task.js', '../../dist/node/host-task.js'),
  );
  // This test exercises private owning HMR APIs as well as the public package.
  // Its private paths follow the same Node ESM graph the plugin resolver selects.
  const hmr = path.join(plugin, 'tests/streamed-signals-hmr.test.ts');
  fs.writeFileSync(
    hmr,
    fs
      .readFileSync(hmr, 'utf8')
      .replaceAll(
        '../../octane/src/signals/',
        '../../octane/dist/node/signals/',
      ),
  );
  fs.symlinkSync(modules, path.join(staged, 'node_modules'));
  qualifyRspackTree(staged, modules, execute);
}

export function qualifyPackedApi(root, modules, runtimePackage, execute = run) {
  const consumer = path.join(root, 'packed-api-consumer');
  fs.mkdirSync(path.join(consumer, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    '{"private":true,"type":"module"}\n',
  );
  for (const name of fs.readdirSync(modules)) {
    if (name.startsWith('.') || name === 'octane' || name === 'typescript')
      continue;
    fs.symlinkSync(
      path.join(modules, name),
      path.join(consumer, 'node_modules', name),
    );
  }
  fs.symlinkSync(runtimePackage, path.join(consumer, 'node_modules/octane'));
  fs.symlinkSync(
    path.join(modules, 'typescript-stable'),
    path.join(consumer, 'node_modules/typescript'),
  );
  execute(
    process.execPath,
    [path.join(here, 'qualify-required-apis.mjs'), consumer],
    root,
    {
      env: { ...buildEnvironment(), OWNED_TEMP_DIR: root },
    },
  );
}

/**
 * Names the current phase and the last started command, so an actual failure
 * (including a signal-terminated child) reports where it happened. Never
 * changes the thrown error or retries.
 */
export function phaseTracker(write = line => process.stderr.write(line)) {
  let current;
  let started;
  let command;
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
  return {
    enter(name) {
      if (current)
        write(`[octane-runtime] ${current}: passed in ${seconds()}s\n`);
      current = name;
      started = Date.now();
      command = undefined;
      write(`[octane-runtime] ${name}: started\n`);
    },
    trace(execute) {
      return (file, args, cwd, ...rest) => {
        command = `${[file, ...args].join(' ')} (cwd ${cwd})`;
        return execute(file, args, cwd, ...rest);
      };
    },
    finish() {
      write(`[octane-runtime] ${current}: passed in ${seconds()}s\n`);
    },
    fail(error) {
      write(
        `[octane-runtime] ${current}: FAILED after ${seconds()}s; ` +
          `last command: ${command ?? 'none'}; exit ${error?.status ?? 'none'}; ` +
          `signal ${error?.signal ?? 'none'}; ${String(error?.message).split('\n')[0]}\n`,
      );
    },
  };
}

/**
 * Native-producer hook. The caller supplies an operation-owned empty directory.
 * One owning build qualifies both halves of the runtime pair. Returns one
 * receipt per package (authenticated source archive, actual built patch and
 * license bytes) only after source tests, the owning build, packed tests, and
 * exact reconstruction of both packages pass. An optional empty, absolute
 * patchOutputDirectory stages both patches without changing accepted artifacts.
 */
export async function qualifyRuntimePair({
  work,
  expectedPatches,
  inputs = octane20RuntimeInputs(),
  writePatch = false,
  patchOutputDirectory,
  runner = {},
  pnpm = process.env.PNPM_BINARY ?? 'pnpm',
  storeDirectory = path.join(process.env.HOME, '.local/share/pnpm/store'),
  phases = phaseTracker(),
}) {
  const {
    packages,
    runtimePair,
    source,
    sourceIntegrity,
    dependencyDirectory,
    patches,
  } = inputs;
  if (expectedPatches !== undefined)
    assert.deepEqual(
      Object.keys(expectedPatches).sort(),
      Object.keys(runtimePair).sort(),
      'Expected patches must name exactly the owning runtime pair',
    );
  assert(
    path.isAbsolute(work),
    'An absolute operation-owned directory is required',
  );
  const patchRoot = patchOutputDirectory ?? repository;
  const patchPaths = Object.fromEntries(
    Object.entries(runtimePair).map(([name, { patchPath }]) => {
      const output = path.resolve(patchRoot, patchPath);
      const relative = path.relative(patchRoot, output);
      assert(
        relative &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative) &&
          !path.isAbsolute(patchPath),
        'Runtime patch output must stay inside its output directory',
      );
      return [name, output];
    }),
  );
  if (patchOutputDirectory !== undefined) {
    assert.equal(writePatch, true, 'Patch output requires writePatch: true');
    assert(
      path.isAbsolute(patchOutputDirectory),
      'An absolute patch output directory is required',
    );
    const relative = path.relative(work, patchOutputDirectory);
    assert(
      relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative),
      'Patch output must be outside the cleaned qualification directory',
    );
    fs.mkdirSync(patchOutputDirectory, { recursive: true });
    assert.equal(
      fs.readdirSync(patchOutputDirectory).length,
      0,
      'Patch output directory must be empty',
    );
  }
  fs.mkdirSync(work, { recursive: true });
  assert.equal(
    fs.readdirSync(work).length,
    0,
    'Qualification directory must be empty',
  );
  const owner = `octane-runtime-${process.pid}`;
  const registered = [];
  const execute = phases.trace(runner.run ?? run);
  const checkDisk = runner.disk ?? (() => disk(work));
  const register = (directory, kind) => {
    fs.mkdirSync(directory, { recursive: true });
    if (runner.register) return runner.register(directory, kind);
    if (process.platform !== 'darwin') return;
    execute(
      '/Users/satan/bin/disk-guardian-artifacts',
      [
        'register',
        directory,
        '--owner',
        owner,
        '--owner-pid',
        String(process.pid),
        '--kind',
        kind,
        '--grace-hours',
        '24',
      ],
      work,
    );
    registered.push(directory);
  };
  try {
    phases.enter('authenticate inputs');
    checkDisk();
    const sourceArchiveBytes = await download(source.url, sourceIntegrity);
    assert.equal(digest('sha256', sourceArchiveBytes), source.sha256);
    const root = path.join(work, 'source');
    extract(sourceArchiveBytes, root, execute);
    const npmInput = packages.find(input => input.name === 'octane');
    const npmBytes = await download(npmInput.url, npmInput.integrity);
    const upstream = path.join(work, 'npm');
    extract(npmBytes, upstream, execute);
    const rspackInput = packages.find(
      input => input.name === '@octanejs/rspack-plugin',
    );
    const rspackUpstream = path.join(work, 'rspack-npm');
    extract(
      await download(rspackInput.url, rspackInput.integrity),
      rspackUpstream,
      execute,
    );
    phases.enter('apply source corrections');
    for (const patch of patches) applyExact(root, patch, execute);
    const deps = path.join(work, 'deps');
    fs.mkdirSync(deps);
    for (const name of ['package.json', 'pnpm-lock.yaml'])
      fs.copyFileSync(
        path.join(dependencyDirectory, `runtime-build-${name}`),
        path.join(deps, name),
      );
    fs.writeFileSync(path.join(deps, 'pnpm-workspace.yaml'), 'packages: []\n');
    phases.enter('install owning dependencies');
    checkDisk();
    register(path.join(deps, 'node_modules'), 'dependencies');
    assert.equal(
      process.versions.node,
      '26.13.1',
      'Owning runtime build Node version',
    );
    const pnpmVersion = execute(pnpm, ['--version'], deps, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    assert.equal(
      pnpmVersion,
      '12.21.0',
      'Runtime lock requires independently qualified pnpm 12.21.0',
    );
    execute(
      pnpm,
      [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--config.manage-package-manager-versions=false',
        '--store-dir',
        storeDirectory,
        '--config.package-import-method=clone-or-copy',
      ],
      deps,
    );
    register(path.join(deps, 'node_modules'), 'dependencies');
    const modules = path.join(deps, 'node_modules');
    fs.symlinkSync(modules, path.join(root, 'node_modules'));
    const pkg = path.join(root, 'packages/octane');
    const baseline = path.join(work, 'baseline');
    extract(sourceArchiveBytes, baseline, execute);
    fs.symlinkSync(modules, path.join(baseline, 'node_modules'));
    phases.enter('source hydration suites');
    const fullSourceEvidence = qualifyAllHydration({
      baselineRoot: baseline,
      composedRoot: root,
      modules,
      work: path.join(work, 'full-source-hydration'),
      execute,
      qualifyTree: qualifyRuntimeTree,
    });
    phases.enter('source Rspack suites');
    qualifyRspackTree(root, modules, execute);
    phases.enter('source checks and typecheck');
    execute(
      process.execPath,
      ['scripts/error-codes/generate.mjs', '--check'],
      root,
    );
    execute(process.execPath, ['scripts/split-runtime.mjs', 'check'], root);
    execute(
      process.execPath,
      [
        path.join(modules, 'typescript/bin/tsc'),
        '-p',
        'packages/octane/tsconfig.json',
        '--pretty',
        'false',
      ],
      root,
    );
    phases.enter('owning build and reconstruction');
    checkDisk();
    register(path.join(pkg, 'dist'), 'build');
    execute(process.execPath, ['packages/octane/scripts/build.mjs'], root);
    register(path.join(pkg, 'dist'), 'build');
    const built = path.join(work, 'built');
    assemblePackage(upstream, pkg, built, npmInput.version);
    const builtPatchBytes = packagePatch(upstream, built);
    const rspackBuilt = path.join(work, 'rspack-built');
    fs.cpSync(rspackUpstream, rspackBuilt, { recursive: true });
    for (const directory of ['src', 'types'])
      fs.cpSync(
        path.join(root, 'packages/rspack-plugin-octane', directory),
        path.join(rspackBuilt, directory),
        { recursive: true },
      );
    const rspackPatchBytes = packagePatch(rspackUpstream, rspackBuilt);
    const reconstructed = path.join(work, 'reconstructed');
    fs.cpSync(upstream, reconstructed, { recursive: true });
    const patchFile = path.join(work, 'built.patch');
    fs.writeFileSync(patchFile, builtPatchBytes);
    applyExact(reconstructed, patchFile, execute);
    assert.deepEqual(files(reconstructed), files(built));
    for (const name of files(built))
      assertSameBytes(
        fs.readFileSync(path.join(reconstructed, name)),
        fs.readFileSync(path.join(built, name)),
        `octane reconstruction: ${name}`,
      );
    fs.symlinkSync(modules, path.join(reconstructed, 'node_modules'));
    phases.enter('packed hydration suites');
    qualifyAllHydration({
      baselineRoot: baseline,
      composedRoot: root,
      modules,
      packed: reconstructed,
      work: path.join(work, 'full-packed-hydration'),
      execute,
      qualifyTree: qualifyRuntimeTree,
      sourceEvidence: fullSourceEvidence,
    });
    phases.enter('packed Rspack and API suites');
    const rspackReconstructed = path.join(work, 'rspack-reconstructed');
    fs.cpSync(rspackUpstream, rspackReconstructed, { recursive: true });
    const rspackPatchFile = path.join(work, 'rspack.patch');
    fs.writeFileSync(rspackPatchFile, rspackPatchBytes);
    applyExact(rspackReconstructed, rspackPatchFile, execute);
    assert.deepEqual(files(rspackReconstructed), files(rspackBuilt));
    for (const name of files(rspackBuilt))
      assertSameBytes(
        fs.readFileSync(path.join(rspackReconstructed, name)),
        fs.readFileSync(path.join(rspackBuilt, name)),
        `Rspack reconstruction: ${name}`,
      );
    qualifyPackedRspack(
      root,
      modules,
      reconstructed,
      rspackReconstructed,
      execute,
    );
    qualifyPackedApi(root, modules, reconstructed, execute);
    phases.enter('pair receipt');
    const receipts = {
      octane: {
        sourceArchiveBytes,
        builtPatchBytes,
        licenseBytes: fs.readFileSync(path.join(pkg, 'LICENSE')),
      },
      '@octanejs/rspack-plugin': {
        sourceArchiveBytes,
        builtPatchBytes: rspackPatchBytes,
        licenseBytes: fs.readFileSync(
          path.join(root, 'packages/rspack-plugin-octane/LICENSE'),
        ),
      },
    };
    for (const [name, receipt] of Object.entries(receipts)) {
      if (expectedPatches)
        assertSameBytes(
          receipt.builtPatchBytes,
          expectedPatches[name],
          `${name}: owning build differs from expected patch`,
        );
      assert.equal(
        digest('sha256', receipt.licenseBytes),
        runtimePair[name].licenseSha256,
        `${name}: owning license differs`,
      );
    }
    // Canonical artifacts and producer bytes remain unavailable until every
    // source and packed gate for both halves of this owning build has passed.
    for (const [name, receipt] of Object.entries(receipts)) {
      const output = patchPaths[name];
      if (writePatch) {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, receipt.builtPatchBytes);
      } else
        assertSameBytes(
          receipt.builtPatchBytes,
          fs.readFileSync(output),
          `Canonical patch drift: ${runtimePair[name].patchPath}`,
        );
    }
    phases.finish();
    return receipts;
  } catch (error) {
    phases.fail(error);
    throw error;
  } finally {
    for (const directory of registered.reverse())
      execute(
        '/Users/satan/bin/disk-guardian-artifacts',
        ['release', directory, '--owner', owner],
        work,
      );
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run via owned-temp-dir --need-gib 20 --run octane-runtime -- node <this-file>',
  );
  const inputs = octane20RuntimeInputs();
  const receipts = await qualifyRuntimePair({
    inputs,
    work: path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR),
      'qualification',
    ),
    writePatch: process.argv.includes('--write-patch'),
  });
  console.log({
    sourceIntegrity: inputs.sourceIntegrity,
    ...Object.fromEntries(
      Object.entries(receipts).map(([name, receipt]) => [
        name,
        {
          patchSha256: digest('sha256', receipt.builtPatchBytes),
          licenseSha256: digest('sha256', receipt.licenseBytes),
        },
      ]),
    ),
  });
}
