import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectNpmTarball } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { assertReleaseCompilerPayload } from '../ultramodern-publish/stage-effect-compiler-payload.mjs';

const format = 3;
const storage = '.ci-build-cache';
const compilerPackage = 'packages/solutions/app-tools-extensions';
const compilerPayload = `${compilerPackage}/compiler/payload`;
const generatedTracked = new Set([
  'packages/runtime/plugin-runtime/static/modern-inline.js',
  'packages/runtime/plugin-runtime/static/modern-run-router-data-fn.js',
  'packages/runtime/plugin-runtime/static/modern-run-window-fn.js',
]);
const hash = value => createHash('sha256').update(value).digest('hex');
const gitFiles = root =>
  execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .sort();

function safePath(value) {
  return (
    typeof value === 'string' &&
    /^(packages|scripts)\//u.test(value) &&
    !/[\\:\0]/u.test(value) &&
    !value
      .split('/')
      .some(
        part =>
          !part || part === '.' || part === '..' || part === 'node_modules',
      )
  );
}

function fingerprint(root, file) {
  const location = path.join(root, file);
  const stat = fs.lstatSync(location);
  if (stat.isSymbolicLink()) {
    return {
      type: 'symlink',
      digest: hash(fs.readlinkSync(location)),
      mode: stat.mode & 0o777,
    };
  }
  if (!stat.isFile()) throw new Error(`Unsupported input file: ${file}`);
  return {
    type: 'file',
    digest: hash(fs.readFileSync(location)),
    mode: stat.mode & 0o777,
  };
}

function existingStat(location) {
  try {
    return fs.lstatSync(location);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function validateDestination(root, location) {
  let parent = path.dirname(location);
  while (parent !== root) {
    const stat = existingStat(parent);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error(`Invalid parent for cached output: ${location}`);
    parent = path.dirname(parent);
  }
  const stat = existingStat(location);
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    throw new Error(`Invalid destination for cached output: ${location}`);
}

export function buildInputs(root, environment = process.env, toolchain = {}) {
  root = path.resolve(root);
  // Hash tracked source content, rather than the commit: a tests-only PR can
  // reuse the exact prepared packages from its base. Root configuration and
  // every shared package/build script remain part of the identity.
  const files = gitFiles(root).filter(
    file =>
      (!file.startsWith('tests/') ||
        file.startsWith('tests/utils/') ||
        file === 'tests/package.json') &&
      !file.startsWith('.github/workflows/') &&
      !file.startsWith('.beads/'),
  );
  const inputs = Object.fromEntries(
    files.map(file => [file, fingerprint(root, file)]),
  );
  let compiler = null;
  if (fs.existsSync(path.join(root, compilerPayload))) {
    const { manifest } = assertReleaseCompilerPayload(
      path.join(root, compilerPackage),
      { sameRun: false },
    );
    // Validate the actual bytes, not just a claimed identity. Run receipts
    // change on every invocation, while the source and file inventory name
    // exactly the compiler that produced these build outputs and test packs.
    compiler = {
      schemaVersion: manifest.schemaVersion,
      source: manifest.source,
      targets: manifest.targets,
    };
  }
  const runtime = {
    compiler,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pnpm:
      toolchain.pnpm ??
      execFileSync('pnpm', ['--version'], {
        cwd: root,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      }).trim(),
    environment: Object.fromEntries(
      [
        'CI',
        'NODE_ENV',
        'NODE_OPTIONS',
        'BROWSERSLIST_ENV',
        'SOURCE_DATE_EPOCH',
        'ULTRAMODERN_RELEASE_LANE',
        'SKIP_DTS',
      ].map(name => [name, environment[name] ?? '']),
    ),
    ...toolchain,
  };
  const key = `test-build-v${format}-${runtime.platform}-${runtime.arch}-${runtime.node}-${hash(JSON.stringify({ inputs, runtime }))}`;
  return { format, key, inputs, runtime };
}

function outputFiles(root) {
  const files = [];
  function visit(relative) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        [
          'node_modules',
          '.git',
          '.nx',
          '.cache',
          '.rspress',
          '.test-tmp',
        ].includes(entry.name)
      )
        continue;
      const file = `${relative}/${entry.name}`;
      // The caller stages and validates its own same-run compiler receipt.
      // Never overwrite it with a cache seed's historical producer identity.
      if (file === compilerPayload) continue;
      if (entry.isDirectory()) visit(file);
      else files.push(file);
    }
  }
  visit('packages');
  visit('scripts');
  return files.sort();
}

function assertContainedFile(root, file) {
  root = path.resolve(root);
  const location = path.resolve(file);
  const relative = path.relative(root, location);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Packed archive is outside its preparation directory: ${file}`,
    );
  }
  let current = location;
  while (current !== root) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink())
      throw new Error(`Symlink in packed archive path: ${file}`);
    if (current === location ? !stat.isFile() : !stat.isDirectory())
      throw new Error(`Invalid packed archive path: ${file}`);
    current = path.dirname(current);
  }
  return location;
}

const packageNamePatterns = {
  packages: /^@modern-js\/[a-z0-9][a-z0-9._-]*$/u,
  sidecars: /^@bleedingdev\/[a-z0-9][a-z0-9._-]*$/u,
};

function checkTarballIdentity(bytes, name, version) {
  const packedPackage = JSON.parse(inspectNpmTarball(bytes).packageJsonBytes);
  if (
    packedPackage.name !== name ||
    typeof packedPackage.version !== 'string' ||
    (version !== undefined && packedPackage.version !== version)
  )
    throw new Error(`Packed archive identity mismatch: ${name}`);
  return packedPackage.version;
}

function snapshotPackedManifest(root, directory, manifestPath) {
  // Keep the preparation directory's lexical prefix: macOS commonly exposes
  // /var through /private/var. Descendant symlinks remain forbidden.
  const sourceRoot = path.resolve(path.dirname(manifestPath));
  assertContainedFile(sourceRoot, path.resolve(manifestPath));
  const source = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const archives = {};
  const portable = { ...source, packages: {}, sidecars: {} };
  const sourceVersions = new Map();
  for (const file of gitFiles(root)
    .filter(
      file => file.startsWith('packages/') && file.endsWith('/package.json'),
    )
    .sort((left, right) => left.split('/').length - right.split('/').length)) {
    const project = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (
      typeof project.name === 'string' &&
      packageNamePatterns.packages.test(project.name) &&
      !project.private &&
      !sourceVersions.has(project.name)
    )
      sourceVersions.set(project.name, project.version);
  }
  if (
    !source.packages ||
    !Object.keys(source.packages).length ||
    !source.sidecars ||
    !Array.isArray(source.edges) ||
    !source.allowBuilds ||
    !Array.isArray(source.minimumReleaseAgeExclude)
  ) {
    throw new Error('Packed prerequisite manifest is incomplete');
  }
  for (const group of ['packages', 'sidecars']) {
    for (const [name, entry] of Object.entries(source[group])) {
      if (
        !packageNamePatterns[group].test(name) ||
        !/^[a-f0-9]{64}$/u.test(entry.integrity) ||
        typeof entry.tarball !== 'string' ||
        (group === 'sidecars' && typeof entry.version !== 'string')
      )
        throw new Error(`Invalid packed prerequisite: ${name}`);
      const tarball = assertContainedFile(sourceRoot, entry.tarball);
      const archive = `${group}/${name.slice(1).replaceAll('/', '-')}.tgz`;
      const actual = fingerprint(
        sourceRoot,
        path.relative(sourceRoot, tarball),
      );
      if (actual.type !== 'file' || actual.digest !== entry.integrity)
        throw new Error(
          `Packed prerequisite changed after preparation: ${name}`,
        );
      if (group === 'packages' && typeof sourceVersions.get(name) !== 'string')
        throw new Error(`Packed prerequisite has no source package: ${name}`);
      const expectedVersion =
        group === 'packages' ? sourceVersions.get(name) : entry.version;
      if (entry.version !== undefined && entry.version !== expectedVersion)
        throw new Error(`Packed archive identity mismatch: ${name}`);
      const version = checkTarballIdentity(
        fs.readFileSync(tarball),
        name,
        expectedVersion,
      );
      archives[archive] = actual;
      const target = path.join(directory, 'packed', archive);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(tarball, target);
      fs.chmodSync(target, actual.mode);
      portable[group][name] = { ...entry, version, tarball: archive };
    }
  }
  return {
    count: Object.keys(archives).length,
    digest: hash(JSON.stringify({ archives, manifest: portable })),
    archives,
    manifest: portable,
  };
}

export function snapshotBuild(root, baseline, packedManifestPath) {
  root = path.resolve(root);
  const directory = path.join(root, storage, 'snapshot');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const outputs = {};
  for (const file of outputFiles(root)) {
    const entry = fingerprint(root, file);
    if (JSON.stringify(entry) === JSON.stringify(baseline.inputs[file]))
      continue;
    if (baseline.inputs[file] && !generatedTracked.has(file))
      throw new Error(`Build changed a tracked input file: ${file}`);
    if (entry.type !== 'file')
      throw new Error(`Build output must be a regular file: ${file}`);
    if (!safePath(file)) throw new Error(`Unsafe build output: ${file}`);
    outputs[file] = entry;
    const target = path.join(directory, 'files', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
    fs.chmodSync(target, entry.mode);
  }
  if (!Object.keys(outputs).length)
    throw new Error('Build produced no cacheable outputs');
  for (const file of Object.keys(baseline.inputs)) {
    if (!fs.existsSync(path.join(root, file)))
      throw new Error(`Build deleted an input file: ${file}`);
  }
  const manifest = {
    format,
    key: baseline.key,
    count: Object.keys(outputs).length,
    digest: hash(JSON.stringify(outputs)),
    outputs,
    packed: packedManifestPath
      ? snapshotPackedManifest(root, directory, packedManifestPath)
      : null,
  };
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest)}\n`,
  );
  return manifest;
}

function loadSnapshot(root, expectedKey) {
  const directory = path.join(root, storage, 'snapshot');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
  );
  if (
    manifest.format !== format ||
    manifest.key !== expectedKey ||
    !manifest.outputs ||
    !Object.keys(manifest.outputs).length ||
    manifest.count !== Object.keys(manifest.outputs).length ||
    manifest.digest !== hash(JSON.stringify(manifest.outputs))
  ) {
    throw new Error('Prepared build cache identity or manifest is invalid');
  }
  return { directory, manifest };
}

function validatePackedSnapshot(root, directory, packed) {
  if (!packed) return;
  const { archives, manifest } = packed;
  if (
    !archives ||
    !Object.keys(archives).length ||
    packed.count !== Object.keys(archives).length ||
    packed.digest !== hash(JSON.stringify({ archives, manifest })) ||
    !manifest?.packages ||
    !Object.keys(manifest.packages).length ||
    !manifest.sidecars ||
    !Array.isArray(manifest.edges) ||
    !manifest.allowBuilds ||
    !Array.isArray(manifest.minimumReleaseAgeExclude)
  )
    throw new Error('Packed cache manifest is invalid');
  const referenced = new Set();
  for (const group of ['packages', 'sidecars']) {
    for (const [name, entry] of Object.entries(manifest[group])) {
      const archive = `${group}/${name.slice(1).replaceAll('/', '-')}.tgz`;
      if (
        !packageNamePatterns[group].test(name) ||
        entry.tarball !== archive ||
        !/^[a-f0-9]{64}$/u.test(entry.integrity) ||
        typeof entry.version !== 'string'
      )
        throw new Error(`Unsafe packed cache prerequisite: ${name}`);
      const expected = archives[archive];
      if (
        !expected ||
        expected.type !== 'file' ||
        expected.digest !== entry.integrity ||
        referenced.has(archive)
      )
        throw new Error(`Invalid packed cache archive: ${name}`);
      referenced.add(archive);
      const location = assertContainedFile(
        path.join(directory, 'packed'),
        path.join(directory, 'packed', archive),
      );
      const actual = fingerprint(
        path.join(directory, 'packed'),
        path.relative(path.join(directory, 'packed'), location),
      );
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Corrupt packed cache archive: ${name}`);
      checkTarballIdentity(fs.readFileSync(location), name, entry.version);
    }
  }
  if (referenced.size !== Object.keys(archives).length)
    throw new Error('Packed cache contains unreferenced archives');
  let parent = path.join(directory, 'packed');
  while (parent !== root) {
    if (
      !fs.lstatSync(parent).isDirectory() ||
      fs.lstatSync(parent).isSymbolicLink()
    )
      throw new Error('Unsafe packed cache directory');
    parent = path.dirname(parent);
  }
}

function validateOutputSnapshot(root, directory, outputs) {
  // Validate every file before copying any. A partial or corrupt archive
  // falls back to the normal build without installing partial outputs.
  const destinations = new Set();
  for (const [file, expected] of Object.entries(outputs)) {
    if (!safePath(file) || expected.type !== 'file')
      throw new Error(`Unsafe cached output: ${file}`);
    const normalized = process.platform === 'win32' ? file.toLowerCase() : file;
    if (destinations.has(normalized))
      throw new Error(`Duplicate cached destination: ${file}`);
    destinations.add(normalized);
    let archiveParent = path.dirname(path.join(directory, 'files', file));
    while (archiveParent !== root) {
      if (fs.lstatSync(archiveParent).isSymbolicLink())
        throw new Error(`Symlink parent in cache archive: ${file}`);
      archiveParent = path.dirname(archiveParent);
    }
    const actual = fingerprint(path.join(directory, 'files'), file);
    if (
      actual.type !== 'file' ||
      actual.digest !== expected.digest ||
      actual.mode !== expected.mode
    )
      throw new Error(`Corrupt cached output: ${file}`);
    validateDestination(root, path.join(root, file));
  }
}

export function restoreBuild(root, expectedKey) {
  root = path.resolve(root);
  const { directory, manifest } = loadSnapshot(root, expectedKey);
  validateOutputSnapshot(root, directory, manifest.outputs);
  validatePackedSnapshot(root, directory, manifest.packed);
  const packageManifestPath = path.join(
    root,
    storage,
    'restored-packages.json',
  );
  if (manifest.packed) validateDestination(root, packageManifestPath);
  for (const [file, entry] of Object.entries(manifest.outputs)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(directory, 'files', file), target);
    fs.chmodSync(target, entry.mode);
  }
  return Object.keys(manifest.outputs).length;
}

export function restorePackedManifest(root, expectedKey) {
  root = path.resolve(root);
  const { directory, manifest } = loadSnapshot(root, expectedKey);
  if (!manifest.packed) return '';
  validateOutputSnapshot(root, directory, manifest.outputs);
  validatePackedSnapshot(root, directory, manifest.packed);
  validateCurrentOutputs(root, manifest.outputs);
  const restored = structuredClone(manifest.packed.manifest);
  for (const group of ['packages', 'sidecars']) {
    for (const entry of Object.values(restored[group]))
      entry.tarball = path.join(directory, 'packed', entry.tarball);
  }
  const manifestPath = path.join(root, storage, 'restored-packages.json');
  validateDestination(root, manifestPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(restored)}\n`);
  return manifestPath;
}

export function verifyCurrentPreparedBuild(
  root,
  environment = process.env,
  toolchain = {},
) {
  root = path.resolve(root);
  const baseline = JSON.parse(
    fs.readFileSync(path.join(root, storage, 'inputs.json'), 'utf8'),
  );
  const { directory, manifest } = loadSnapshot(root, baseline.key);
  const untracked = execFileSync(
    'git',
    [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      'packages',
      'scripts',
      'tests/utils',
      'tests/package.json',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const file of untracked) {
    if (!manifest.outputs[file])
      throw new Error(`Untracked prepared build input: ${file}`);
  }
  const current = buildInputs(root, environment, toolchain);
  if (
    current.format !== baseline.format ||
    JSON.stringify(current.runtime) !== JSON.stringify(baseline.runtime) ||
    JSON.stringify(Object.keys(current.inputs)) !==
      JSON.stringify(Object.keys(baseline.inputs))
  )
    throw new Error('Prepared build source or toolchain identity changed');
  for (const [file, expected] of Object.entries(baseline.inputs)) {
    if (generatedTracked.has(file) && manifest.outputs[file]) {
      if (
        JSON.stringify(current.inputs[file]) !==
        JSON.stringify(manifest.outputs[file])
      )
        throw new Error(`Prepared generated output changed: ${file}`);
    } else if (
      JSON.stringify(current.inputs[file]) !== JSON.stringify(expected)
    )
      throw new Error(`Prepared build input changed: ${file}`);
  }
  // The saved identity itself must agree with the current key material. Only
  // the three generated tracked files above may differ after preparation.
  const material = { inputs: baseline.inputs, runtime: current.runtime };
  const expectedKey = `test-build-v${format}-${current.runtime.platform}-${current.runtime.arch}-${current.runtime.node}-${hash(JSON.stringify(material))}`;
  if (baseline.key !== expectedKey)
    throw new Error('Prepared build input receipt is invalid');
  validateOutputSnapshot(root, directory, manifest.outputs);
  validatePackedSnapshot(root, directory, manifest.packed);
  validateCurrentOutputs(root, manifest.outputs);
  return Object.keys(manifest.outputs).length;
}

function validateCurrentOutputs(root, outputs) {
  for (const [file, expected] of Object.entries(outputs)) {
    validateDestination(root, path.join(root, file));
    if (JSON.stringify(fingerprint(root, file)) !== JSON.stringify(expected))
      throw new Error(`Prepared build output changed: ${file}`);
  }
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function main() {
  const root = process.cwd();
  const command = process.argv[2];
  const inputPath = path.join(root, storage, 'inputs.json');
  if (command === 'key') {
    const inputs = buildInputs(root);
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(inputs));
    output('key', inputs.key);
  } else if (command === 'snapshot') {
    const baseline = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const manifest = snapshotBuild(root, baseline, process.argv[3]);
    console.log(
      `Prepared ${Object.keys(manifest.outputs).length} build output files`,
    );
  } else if (command === 'restore') {
    try {
      const baseline = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      console.log(
        `Restored ${restoreBuild(root, baseline.key)} validated build output files`,
      );
      output('package-manifest', restorePackedManifest(root, baseline.key));
      output('cache-hit', 'true');
    } catch (error) {
      console.warn(`Prepared build cache unavailable: ${error.message}`);
      output('cache-hit', 'false');
      output('package-manifest', '');
    }
  } else if (command === 'verify-current') {
    console.log(
      `Verified ${verifyCurrentPreparedBuild(root)} prepared build output files`,
    );
  } else
    throw new Error(
      'Usage: prepared-build-cache.mjs key|snapshot [packages.json]|restore|verify-current',
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
