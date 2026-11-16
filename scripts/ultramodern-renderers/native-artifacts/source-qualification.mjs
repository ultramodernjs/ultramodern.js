import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectNpmTarball } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import {
  packages as octaneInputs,
  source as octaneSource,
} from '../octane-corrections/inputs.mjs';
import { qualify as qualifyAdapter } from '../octane-corrections/qualify.mjs';
import { qualify as qualifyRouter } from '../router-corrections/qualify.mjs';
import { portableExports } from '../router-corrections/reconstruct.mjs';
import { assetFilename, exactKeys, integrity, sha256 } from './protocol.mjs';
import { applyExactPatch } from './reconstruct.mjs';
import { readBytes } from './transport.mjs';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
export const runtimeSourceIntegrity =
  'sha512-LyipVNIG/Wz8BOF2B8yxHf4xyeyh4IKyXFcg+XZnYdBEaXa57jwdqM1lI9UdX16jVC2fCNImvwj9EGw71jDn+A==';
export const qualificationToolchains = Object.freeze({
  router: Object.freeze({
    node: '26.13.1',
    pnpm: '11.21.0',
    binaryVariable: 'NATIVE_ROUTER_PNPM',
  }),
  adapter: Object.freeze({
    node: '26.13.1',
    pnpm: '11.21.0',
    binaryVariable: 'NATIVE_ROUTER_PNPM',
  }),
  runtime: Object.freeze({
    node: '26.13.1',
    pnpm: '12.21.0',
    binaryVariable: 'NATIVE_RUNTIME_PNPM',
  }),
});
export const owningLicenses = Object.freeze({
  '@tanstack/router-core':
    'a405ee70c632bb938acb7ac5f210e814409b3760ea9d2329d8ed8ffcfd11a0e7',
  '@octanejs/tanstack-router':
    '4b83c082bc5305628aceda4130f495f30a6b992389b8d19229d508d38bc09a36',
  '@octanejs/rspack-plugin':
    '4b83c082bc5305628aceda4130f495f30a6b992389b8d19229d508d38bc09a36',
  octane: 'fe9a7b24f2d1540df1a4d273ba9b4b081844ecd1142839def5b7f242a13203b8',
});
export function assertOwningLicense(name, licenseSha256) {
  assert(
    Object.hasOwn(owningLicenses, name),
    'Unknown native package license authority',
  );
  assert.equal(
    licenseSha256,
    owningLicenses[name],
    `${name}: recipe differs from its owning package license`,
  );
}
function toolchainFor(owner) {
  assert(
    Object.hasOwn(qualificationToolchains, owner),
    'Unknown native owning toolchain',
  );
  return qualificationToolchains[owner];
}

/** Build commands never inherit a workflow token or package-manager policy overrides. */
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
export function assertRouterBuildLock(bytes) {
  assert.equal(
    sha256(bytes),
    '54c9ac0c4e2a41b77a82ecd19d0066070df917d56dfa3dbf4d6102b58637cf3d',
    'Router source qualification build lock differs from the owning build',
  );
}
export function assertToolchain(
  { node = process.versions.node, pnpm } = {},
  owner = 'router',
) {
  const expected = toolchainFor(owner);
  assert.equal(
    node,
    expected.node,
    `${owner}: Native owning build Node toolchain differs from qualification`,
  );
  assert.equal(
    pnpm,
    expected.pnpm,
    `${owner}: Native owning build needs pnpm ${expected.pnpm}`,
  );
}
export async function ownedQualification(
  workDirectory,
  label,
  operation,
  {
    execute = execFileSync,
    owner = 'router',
    pnpmBinary = process.env[toolchainFor(owner).binaryVariable] ?? 'pnpm',
  } = {},
) {
  toolchainFor(owner);
  assert.equal(typeof pnpmBinary, 'string');
  assert(
    pnpmBinary === 'pnpm' || path.isAbsolute(pnpmBinary),
    'Owning pnpm binary must be absolute',
  );
  assert(
    path.isAbsolute(workDirectory),
    'Absolute owned qualification parent required',
  );
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(workDirectory), `native-${label}-`),
  );
  const artifactOwner = `native-qualification-${process.pid}-${path.basename(root)}`;
  const registered = new Set();
  const env = { ...buildEnvironment(), OWNED_TEMP_DIR: root };
  const run = (command, args, cwd = root, options = {}) => {
    assert(
      cwd === root || cwd.startsWith(`${root}${path.sep}`),
      'Build commands stay inside their operation',
    );
    if (command === 'pnpm') command = pnpmBinary;
    if (command === pnpmBinary && args[0] === 'install') {
      // Owning suites predate portable CI; retain their install semantics but
      // never use their workstation-specific store paths or a per-worktree store.
      args = args.filter(
        (arg, i) => arg !== '--store-dir' && args[i - 1] !== '--store-dir',
      );
      args = [
        ...args,
        '--store-dir',
        path.join(env.HOME, '.local/share/pnpm/store'),
        '--config.package-import-method=clone-or-copy',
      ];
    }
    return execute(command, args, { cwd, env, stdio: 'inherit', ...options });
  };
  const disk = () => {
    let stats = fs.statfsSync(root);
    if (
      process.platform === 'darwin' &&
      stats.bavail * stats.bsize < 80 * 1024 ** 3
    ) {
      run('/Users/satan/bin/safe-disk-janitor.sh', []);
      stats = fs.statfsSync(root);
    }
    assert(
      stats.bavail * stats.bsize >= 20 * 1024 ** 3,
      'Native qualification needs at least 20 GiB free',
    );
  };
  const register = (directory, kind) => {
    assert(
      directory.startsWith(`${root}${path.sep}`),
      'Only this qualification owns its outputs',
    );
    fs.mkdirSync(directory, { recursive: true });
    if (process.platform === 'darwin' && !registered.has(directory)) {
      run('/Users/satan/bin/disk-guardian-artifacts', [
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
      ]);
      registered.add(directory);
    }
  };
  try {
    const version = run('pnpm', ['--version'], root, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    assertToolchain({ pnpm: version }, owner);
    return await operation({ root, run, disk, register, env, pnpmBinary });
  } finally {
    try {
      for (const directory of [...registered].reverse())
        run('/Users/satan/bin/disk-guardian-artifacts', [
          'release',
          directory,
          '--owner',
          artifactOwner,
        ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
export function unpackNpm(bytes, directory) {
  const inspected = inspectNpmTarball(bytes);
  fs.mkdirSync(directory);
  for (const file of inspected.files) {
    const absolute = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, inspected.fileContents.get(file.path), {
      flag: 'wx',
      mode: file.mode & 0o777,
    });
  }
  return inspected;
}
function tree(root) {
  return fs
    .readdirSync(root, { recursive: true })
    .filter(file => fs.lstatSync(path.join(root, file)).isFile())
    .sort();
}
export function assertSameLayout(actual, expected) {
  const files = tree(actual);
  assert.deepEqual(files, tree(expected), 'Qualified npm file layout differs');
  for (const file of files) {
    assert.deepEqual(
      fs.readFileSync(path.join(actual, file)),
      fs.readFileSync(path.join(expected, file)),
      `Qualified npm bytes differ: ${file}`,
    );
    assert.equal(
      fs.statSync(path.join(actual, file)).mode & 0o777,
      fs.statSync(path.join(expected, file)).mode & 0o777,
      `Qualified npm mode differs: ${file}`,
    );
  }
}
export function builtPatch(original, corrected, abbreviation = 10) {
  const result = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      `--abbrev=${abbreviation}`,
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      original,
      corrected,
    ],
    { env: buildEnvironment(), encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 },
  );
  assert.equal(
    result.status,
    1,
    result.stderr || 'Expected an actual built package correction',
  );
  return Buffer.from(
    result.stdout
      .replaceAll(`a/${original.slice(1)}/`, 'a/')
      .replaceAll(`b/${corrected.slice(1)}/`, 'b/')
      .replaceAll(`a/${corrected.slice(1)}/`, 'a/')
      .replaceAll(`b/${original.slice(1)}/`, 'b/'),
  );
}
function json(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}
async function originalPackage(item, directory, fetchArtifact) {
  const bytes = await readBytes(item.upstream.request, { fetchArtifact });
  assert.equal(integrity(bytes), item.upstream.integrity);
  const inspected = unpackNpm(bytes, directory);
  assert.equal(
    sha256(inspected.fileContents.get('LICENSE')),
    item.upstream.licenseSha256,
  );
  return bytes;
}
function assertPatch(item, bytes) {
  assert.equal(
    sha256(bytes),
    item.patchSha256,
    'Actual owning build differs from recipe patch digest',
  );
  assert.deepEqual(
    bytes,
    fs.readFileSync(item.patchPath),
    'Actual owning build differs from canonical npm-layout patch',
  );
}
function qualifiedTarget({ packedDirectory, name, corrected, root }) {
  if (!packedDirectory) return corrected;
  const archive = fs.readFileSync(
    path.join(
      packedDirectory,
      assetFilename(
        name,
        JSON.parse(fs.readFileSync(path.join(corrected, 'package.json')))
          .version,
      ),
    ),
  );
  const target = path.join(root, 'actual-release-package');
  unpackNpm(archive, target);
  assertSameLayout(target, corrected);
  return target;
}

/** Rebuild router CJS/ESM/maps/declarations, then run the owning source and packed suites. */
export async function qualifyRouterSource({
  item,
  provenance,
  workDirectory,
  packedDirectory,
  fetchArtifact = fetch,
}) {
  assertOwningLicense('@tanstack/router-core', item.upstream.licenseSha256);
  return ownedQualification(
    workDirectory,
    'router',
    async ({ root, run, register, disk }) => {
      const here = path.join(
        repo,
        'scripts/ultramodern-renderers/router-corrections',
      );
      const original = path.join(root, 'original');
      const bytes = await originalPackage(item, original, fetchArtifact);
      fs.writeFileSync(path.join(root, 'upstream.tgz'), bytes);
      const git = path.join(root, 'upstream-git');
      fs.mkdirSync(git);
      run('git', ['init', '--quiet', git]);
      run('git', [
        '-C',
        git,
        'fetch',
        '--depth=1',
        '--no-tags',
        `https://github.com/${item.upstream.repository}.git`,
        item.upstream.commit,
      ]);
      assert.equal(
        run('git', ['-C', git, 'rev-parse', 'FETCH_HEAD'], root, {
          stdio: 'pipe',
          encoding: 'utf8',
        }).trim(),
        item.upstream.commit,
      );
      const sourceArchiveBytes = run(
        'git',
        [
          '-C',
          git,
          'archive',
          item.upstream.commit,
          'packages/router-core',
          'tsconfig.json',
          'LICENSE',
        ],
        root,
        { stdio: 'pipe', maxBuffer: 64 * 1024 ** 2 },
      );
      assert.equal(
        integrity(sourceArchiveBytes),
        item.upstream.sourceArchiveIntegrity,
      );
      const source = path.join(root, 'source');
      fs.mkdirSync(source);
      run('tar', ['-xf', '-', '-C', source], root, {
        input: sourceArchiveBytes,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      const pkg = path.join(source, 'packages/router-core');
      assertSameLayout(path.join(original, 'src'), path.join(pkg, 'src'));
      const licenseBytes = fs.readFileSync(path.join(source, 'LICENSE'));
      assert.equal(sha256(licenseBytes), item.upstream.licenseSha256);
      const correction = fs.readFileSync(path.join(here, 'source.patch'));
      assert.equal(sha256(correction), provenance.sourcePatchSha256);
      applyExactPatch(correction, source);
      for (const file of fs.readdirSync(path.join(here, 'tests')))
        fs.copyFileSync(
          path.join(here, 'tests', file),
          path.join(pkg, 'tests', file),
        );
      const manifest = JSON.parse(
        fs.readFileSync(path.join(pkg, 'package.json')),
      );
      manifest.dependencies = {
        '@tanstack/history': '1.162.5',
        'cookie-es': '3.1.1',
        seroval: '1.6.7',
        'seroval-plugins': '1.6.7',
      };
      manifest.devDependencies = {
        '@tanstack/store': '0.11.2',
        '@types/node': '25.0.9',
        esbuild: '0.27.4',
        vite: '8.3.4',
        '@tanstack/vite-config': '0.5.2',
        vitest: '5.0.4',
        jsdom: '25.0.1',
        typescript: '6.0.2',
      };
      json(path.join(pkg, 'package.json'), manifest);
      json(path.join(source, 'package.json'), {
        private: true,
        type: 'module',
        packageManager: 'pnpm@11.21.0',
      });
      fs.writeFileSync(
        path.join(source, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/router-core\npackageImportMethod: clone-or-copy\n',
      );
      const buildLockBytes = fs.readFileSync(
        path.join(here, 'build-lock.yaml'),
      );
      assertRouterBuildLock(buildLockBytes);
      fs.writeFileSync(path.join(source, 'pnpm-lock.yaml'), buildLockBytes, {
        flag: 'wx',
      });
      disk();
      register(path.join(source, 'node_modules'), 'dependencies');
      register(path.join(pkg, 'node_modules'), 'dependencies');
      run(
        'pnpm',
        [
          'install',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--config.package-import-method=clone-or-copy',
        ],
        source,
      );
      register(path.join(pkg, 'dist'), 'build');
      run('pnpm', ['exec', 'vite', 'build'], pkg);
      const corrected = path.join(root, 'corrected');
      fs.cpSync(original, corrected, { recursive: true });
      fs.cpSync(path.join(pkg, 'src'), path.join(corrected, 'src'), {
        recursive: true,
      });
      fs.rmSync(path.join(corrected, 'dist'), { recursive: true });
      fs.cpSync(path.join(pkg, 'dist'), path.join(corrected, 'dist'), {
        recursive: true,
      });
      json(
        path.join(corrected, 'package.json'),
        portableExports(
          JSON.parse(fs.readFileSync(path.join(original, 'package.json'))),
        ),
      );
      const builtPatchBytes = builtPatch(original, corrected);
      assertPatch(item, builtPatchBytes);
      const reconstructed = path.join(root, 'reconstructed');
      fs.cpSync(original, reconstructed, { recursive: true });
      applyExactPatch(builtPatchBytes, reconstructed);
      assertSameLayout(reconstructed, corrected);
      run(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          '--typecheck.enabled=false',
          'dehydration-hook-loads',
          'server-route-lifecycle',
          'server-load-dehydration',
          'commit-location-public-href',
          'mask-inherit-search',
          'headers.test',
          'transformStreamWithRouter.test',
        ],
        pkg,
      );
      run(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          '--typecheck.only',
          'mask-inherit-search',
          'headers',
          'transformStreamWithRouter',
        ],
        pkg,
      );
      const actual = qualifiedTarget({
        packedDirectory,
        name: '@tanstack/router-core',
        item,
        corrected: reconstructed,
        root,
      });
      qualifyRouter({
        root,
        pkg,
        reconstructed: actual,
        here,
        run,
        register,
        disk,
      });
      return { sourceArchiveBytes, builtPatchBytes, licenseBytes };
    },
  );
}

/** The adapter's published layout is source; its actual compilation is the owning Vite test plugin. */
export async function qualifyAdapterSource({
  item,
  source,
  workDirectory,
  packedDirectory,
  fetchArtifact = fetch,
}) {
  assertOwningLicense('@octanejs/tanstack-router', item.upstream.licenseSha256);
  return ownedQualification(
    workDirectory,
    'adapter',
    async ({ root, run, register, disk }) => {
      const here = path.join(
        repo,
        'scripts/ultramodern-renderers/octane-corrections',
      );
      const sourceArchiveBytes = await readBytes(source.url, { fetchArtifact });
      assert.equal(sha256(sourceArchiveBytes), source.sha256);
      assert.equal(
        integrity(sourceArchiveBytes),
        item.upstream.sourceArchiveIntegrity,
      );
      const archive = path.join(root, 'source.tgz');
      fs.writeFileSync(archive, sourceArchiveBytes);
      const sourceRoot = path.join(root, 'source');
      fs.mkdirSync(sourceRoot);
      run('tar', ['-xzf', archive, '--strip-components=1', '-C', sourceRoot]);
      const original = path.join(root, 'original');
      await originalPackage(item, original, fetchArtifact);
      const licenseBytes = fs.readFileSync(path.join(sourceRoot, 'LICENSE'));
      assert.equal(sha256(licenseBytes), item.upstream.licenseSha256);
      const sourcePackage = path.join(sourceRoot, 'packages/tanstack-router');
      assertSameLayout(
        path.join(original, 'src'),
        path.join(sourcePackage, 'src'),
      );
      const corrected = path.join(root, 'corrected');
      fs.cpSync(original, corrected, { recursive: true });
      const builtPatchBytes = fs.readFileSync(item.patchPath);
      assertPatch(item, builtPatchBytes);
      applyExactPatch(builtPatchBytes, corrected);
      const actual = qualifiedTarget({
        packedDirectory,
        name: '@octanejs/tanstack-router',
        item,
        corrected,
        root,
      });
      await qualifyAdapter({
        work: root,
        sourceRoot,
        corrected: actual,
        here,
        run,
        disk,
        register,
        applyExactPatch: (directory, patch) =>
          applyExactPatch(fs.readFileSync(patch), directory),
        verifyIntegrity: (bytes, expected) =>
          assert.equal(integrity(bytes), expected),
      });
      assertSameLayout(
        path.join(sourcePackage, 'src'),
        path.join(corrected, 'src'),
      );
      // Derive source-layout npm bytes independently, after the owning suite
      // compiled and checked source/packed layouts. Never return a patch-file
      // read as if it were proof of a built correction.
      const emitted = path.join(root, 'source-emitted-npm');
      fs.cpSync(original, emitted, { recursive: true });
      fs.cpSync(path.join(sourcePackage, 'src'), path.join(emitted, 'src'), {
        recursive: true,
      });
      const emittedManifest = JSON.parse(
        fs.readFileSync(path.join(original, 'package.json')),
      );
      Object.assign(emittedManifest.dependencies, {
        '@tanstack/router-core': '1.171.39',
        '@tanstack/history': '1.162.5',
        '@tanstack/store': '0.11.2',
      });
      json(path.join(emitted, 'package.json'), emittedManifest);
      const actualBuiltPatch = builtPatch(original, emitted);
      assertPatch(item, actualBuiltPatch);
      return {
        sourceArchiveBytes,
        builtPatchBytes: actualBuiltPatch,
        licenseBytes,
      };
    },
    { owner: 'adapter' },
  );
}

/** Adapter to the owning runtime build. A failed query/HMR gate propagates;
 * reconstruction or a current unqualified patch can never produce this receipt. */
async function qualifyRuntimePackageSource(
  { name, item, workDirectory, packedDirectory },
  { qualifier, execute = execFileSync, pnpmBinary } = {},
) {
  assertOwningLicense(name, item.upstream.licenseSha256);
  const upstream = octaneInputs.find(input => input.name === name);
  assert.equal(
    item.upstream.request,
    upstream.url,
    'Runtime recipe has another package identity',
  );
  assert.equal(
    item.upstream.integrity,
    upstream.integrity,
    'Runtime recipe has another upstream archive',
  );
  assert.equal(item.upstream.repository, 'octanejs/octane');
  assert.equal(
    item.upstream.commit,
    octaneSource.commit,
    'Runtime recipe has another owning source',
  );
  assert.equal(
    item.upstream.sourceArchiveIntegrity,
    runtimeSourceIntegrity,
    'Runtime recipe has another owning source archive',
  );
  const expectedPatch = fs.readFileSync(item.patchPath);
  assert.equal(
    sha256(expectedPatch),
    item.patchSha256,
    'Runtime recipe patch digest mismatch',
  );
  return ownedQualification(
    workDirectory,
    'runtime',
    async ({ root, run, disk, register, pnpmBinary }) => {
      const evidence = await qualifier({
        work: path.join(root, 'owning-build'),
        expectedPatch,
        writePatch: false,
        packageName: name,
        runner: { run, disk, register },
        pnpm: pnpmBinary,
      });
      exactKeys(
        evidence,
        ['sourceArchiveBytes', 'builtPatchBytes', 'licenseBytes'],
        'runtime owning byte receipt',
      );
      for (const bytes of Object.values(evidence))
        assert(
          Buffer.isBuffer(bytes),
          'Owning runtime must return actual bytes',
        );
      assert.equal(
        integrity(evidence.sourceArchiveBytes),
        item.upstream.sourceArchiveIntegrity,
      );
      assert.deepEqual(
        evidence.builtPatchBytes,
        expectedPatch,
        'Runtime owning build differs from recipe patch',
      );
      assertOwningLicense(name, sha256(evidence.licenseBytes));
      if (packedDirectory) {
        // The owning qualifier already ran source/build/packed gates. Bind the
        // transported layout as well, without replacing those gates by unpacking.
        const actual = path.join(root, 'transported');
        const original = path.join(root, 'upstream');
        const bytes = await readBytes(item.upstream.request);
        assert.equal(integrity(bytes), item.upstream.integrity);
        unpackNpm(bytes, original);
        applyExactPatch(evidence.builtPatchBytes, original);
        unpackNpm(
          fs.readFileSync(
            path.join(packedDirectory, assetFilename(name, upstream.version)),
          ),
          actual,
        );
        assertSameLayout(actual, original);
      }
      return evidence;
    },
    { owner: 'runtime', execute, ...(pnpmBinary ? { pnpmBinary } : {}) },
  );
}

async function runOwningRuntime(options) {
  // Loading the owning build implementation belongs behind qualification, not
  // the producer CLI's dependency-free inventory/publish import closure.
  const owner = await import('../octane-corrections/qualify-runtime.mjs');
  assert.equal(
    owner.sourceIntegrity,
    runtimeSourceIntegrity,
    'Owning qualifier source archive changed',
  );
  return options.packageName === 'octane'
    ? owner.qualifyRuntime(options)
    : owner.qualifyRspack(options);
}
export function qualifyRuntimeSource(options, dependencies = {}) {
  return qualifyRuntimePackageSource(
    { ...options, name: 'octane' },
    { qualifier: runOwningRuntime, ...dependencies },
  );
}
export function qualifyRspackSource(options, dependencies = {}) {
  return qualifyRuntimePackageSource(
    { ...options, name: '@octanejs/rspack-plugin' },
    { qualifier: runOwningRuntime, ...dependencies },
  );
}

// Parent-authenticated 53f0 handoff. Updating a worker output does not update
// production pins: a fresh explicit handoff must change these expected digests.
export const runtimeHandoffFiles = Object.freeze({
  'patches/octane@0.18.0.patch':
    '529e0cbb9dd695c7569ae9d64b04ee0ba9685402823faa230c339d582d811f74',
  'patches/@octanejs__rspack-plugin@0.2.10.patch':
    '930795abefa05ae08954654b99b4f5a1442f50d89aa58900c164a0200cb7e3f0',
  'scripts/ultramodern-renderers/octane-corrections/runtime-source.patch':
    'a3e4e1e0ad6b99e97fd368bea03e50c89594c587cb5a59c40544f02e2a086a4a',
  'scripts/ultramodern-renderers/octane-corrections/runtime-tests.patch':
    '45fd5daf6c151630cec2239d655c60615f9f51e4fd4d8f499f30555873e5281d',
  'scripts/ultramodern-renderers/octane-corrections/rspack-source.patch':
    'd1c3701919c7e7ed7129479497089aa14df8f0f41818b29795ac49998917336e',
});
export function verifyRuntimeHandoff(root = repo) {
  for (const [relative, expected] of Object.entries(runtimeHandoffFiles))
    assert.equal(
      sha256(fs.readFileSync(path.join(root, relative))),
      expected,
      `Runtime handoff drift: ${relative}; require fresh authenticated handoff`,
    );
}
