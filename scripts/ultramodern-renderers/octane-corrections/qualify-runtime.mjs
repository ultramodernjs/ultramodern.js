import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeHydrationReporter } from './hydration-reporter.mjs';
import { packages, source } from './inputs.mjs';
import { qualifyAllHydration } from './qualify-all-hydration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
export const sourceIntegrity =
  'sha512-LyipVNIG/Wz8BOF2B8yxHf4xyeyh4IKyXFcg+XZnYdBEaXa57jwdqM1lI9UdX16jVC2fCNImvwj9EGw71jDn+A==';
export const runtimePatchPath = 'patches/octane@0.18.0.patch';
export const rspackPatchPath = 'patches/@octanejs__rspack-plugin@0.2.10.patch';
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
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--no-color',
        '--abbrev=7',
        '--',
        fs.existsSync(a) ? a : '/dev/null',
        fs.existsSync(b) ? b : '/dev/null',
      ],
      { env: buildEnvironment(), encoding: 'utf8', maxBuffer: 128 * 1024 ** 2 },
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

export function assemblePackage(upstream, sourcePackage, destination) {
  fs.cpSync(upstream, destination, { recursive: true });
  fs.rmSync(path.join(destination, 'dist'), { recursive: true, force: true });
  fs.cpSync(path.join(sourcePackage, 'dist'), path.join(destination, 'dist'), {
    recursive: true,
  });
  const file = path.join(destination, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  assert.equal(manifest.name, 'octane');
  assert.equal(manifest.version, '0.18.0');
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
    legacyAliases = false,
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
 resolve:{alias:${
   legacyAliases
     ? `[{find:/^octane$/,replacement:${JSON.stringify(path.join(pkg, 'src/index.ts'))}},{find:/^octane\\/(.*)$/,replacement:${JSON.stringify(path.join(pkg, 'src') + '/')}+'$1'}]`
     : JSON.stringify(aliases)
 }},
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
 * Native-producer hook. The caller supplies an operation-owned empty directory.
 * Returns authenticated input and actual built patch/license bytes only after
 * source tests, the owning build, packed tests, and exact reconstruction pass.
 */
export async function qualifyRuntime({
  work,
  expectedPatch,
  writePatch = false,
  runner = {},
  pnpm = process.env.PNPM_BINARY ?? 'pnpm',
  storeDirectory = path.join(process.env.HOME, '.local/share/pnpm/store'),
  packageName = 'octane',
}) {
  assert(
    ['octane', '@octanejs/rspack-plugin'].includes(packageName),
    'Unknown owning package',
  );
  assert(
    path.isAbsolute(work),
    'An absolute operation-owned directory is required',
  );
  fs.mkdirSync(work, { recursive: true });
  assert.equal(
    fs.readdirSync(work).length,
    0,
    'Qualification directory must be empty',
  );
  const owner = `octane-runtime-${process.pid}`;
  const registered = [];
  const execute = runner.run ?? run;
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
    for (const name of [
      'runtime-source.patch',
      'typescript-compat/typescript-source.patch',
      'typescript-compat/native-signals-source.patch',
      'typescript-compat/volar-core-source.patch',
      'runtime-tests.patch',
      'rspack-source.patch',
      'rspack-tests.patch',
    ])
      applyExact(root, path.join(here, name), execute);
    const deps = path.join(work, 'deps');
    fs.mkdirSync(deps);
    for (const name of ['package.json', 'pnpm-lock.yaml'])
      fs.copyFileSync(
        path.join(here, `runtime-build-${name}`),
        path.join(deps, name),
      );
    fs.writeFileSync(path.join(deps, 'pnpm-workspace.yaml'), 'packages: []\n');
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
    const fullSourceEvidence = qualifyAllHydration({
      baselineRoot: baseline,
      composedRoot: root,
      modules,
      work: path.join(work, 'full-source-hydration'),
      execute,
      qualifyTree: qualifyRuntimeTree,
    });
    qualifyRspackTree(root, modules, execute);
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
    checkDisk();
    register(path.join(pkg, 'dist'), 'build');
    execute(process.execPath, ['packages/octane/scripts/build.mjs'], root);
    register(path.join(pkg, 'dist'), 'build');
    const built = path.join(work, 'built');
    assemblePackage(upstream, pkg, built);
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
      assert.deepEqual(
        fs.readFileSync(path.join(reconstructed, name)),
        fs.readFileSync(path.join(built, name)),
        name,
      );
    fs.symlinkSync(modules, path.join(reconstructed, 'node_modules'));
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
    const rspackReconstructed = path.join(work, 'rspack-reconstructed');
    fs.cpSync(rspackUpstream, rspackReconstructed, { recursive: true });
    const rspackPatchFile = path.join(work, 'rspack.patch');
    fs.writeFileSync(rspackPatchFile, rspackPatchBytes);
    applyExact(rspackReconstructed, rspackPatchFile, execute);
    assert.deepEqual(files(rspackReconstructed), files(rspackBuilt));
    for (const name of files(rspackBuilt))
      assert.deepEqual(
        fs.readFileSync(path.join(rspackReconstructed, name)),
        fs.readFileSync(path.join(rspackBuilt, name)),
        name,
      );
    qualifyPackedRspack(
      root,
      modules,
      reconstructed,
      rspackReconstructed,
      execute,
    );
    qualifyPackedApi(root, modules, reconstructed, execute);
    const selectedPatch =
      packageName === 'octane' ? builtPatchBytes : rspackPatchBytes;
    if (expectedPatch) assert.deepEqual(selectedPatch, expectedPatch);
    // Canonical artifacts and producer bytes remain unavailable until every
    // source and packed gate for both halves of this owning build has passed.
    for (const [filename, bytes] of [
      [runtimePatchPath, builtPatchBytes],
      [rspackPatchPath, rspackPatchBytes],
    ]) {
      const canonical = path.join(repository, filename);
      if (writePatch) fs.writeFileSync(canonical, bytes);
      else
        assert.deepEqual(
          bytes,
          fs.readFileSync(canonical),
          `Canonical patch drift: ${filename}`,
        );
    }
    const licenseBytes = fs.readFileSync(
      path.join(
        packageName === 'octane'
          ? pkg
          : path.join(root, 'packages/rspack-plugin-octane'),
        'LICENSE',
      ),
    );
    assert.equal(
      digest('sha256', licenseBytes),
      packageName === 'octane'
        ? 'fe9a7b24f2d1540df1a4d273ba9b4b081844ecd1142839def5b7f242a13203b8'
        : '4b83c082bc5305628aceda4130f495f30a6b992389b8d19229d508d38bc09a36',
    );
    return { sourceArchiveBytes, builtPatchBytes: selectedPatch, licenseBytes };
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

export const qualifyRspack = options =>
  qualifyRuntime({
    ...options,
    packageName: '@octanejs/rspack-plugin',
  });

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run via owned-temp-dir --need-gib 20 --run octane-runtime -- node <this-file>',
  );
  const receipt = await qualifyRuntime({
    work: path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR),
      'qualification',
    ),
    writePatch: process.argv.includes('--write-patch'),
  });
  console.log({
    sourceIntegrity,
    patchSha256: digest('sha256', receipt.builtPatchBytes),
    licenseSha256: digest('sha256', receipt.licenseBytes),
  });
}
