'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { fileURLToPath } = require('node:url');
const { isDeepStrictEqual } = require('node:util');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => {
  throw new Error(`Invalid owned Effect compiler payload: ${message}`);
};
const record = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  record(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const digest = value =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const decimal = value => typeof value === 'string' && /^\d+$/.test(value);

function statIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Installed packages can sit beneath pnpm symlinks. Canonicalize the module's
// parent once, but never follow a symlink within the payload or a supplied root.
function checkedRoot(root) {
  const absolute = path.resolve(root);
  let cursor = path.parse(absolute).root;
  for (const component of absolute.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = statIfPresent(cursor);
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`payload root component is not a real directory: ${cursor}`);
    }
  }
  return absolute;
}

function relativeFile(root, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative.includes(':') ||
    relative.includes('\0') ||
    relative.split('/').some(part => !part || part === '.' || part === '..') ||
    path.posix.isAbsolute(relative)
  ) {
    fail(`unsafe inventory path: ${String(relative)}`);
  }
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!absolute.startsWith(`${root}${path.sep}`))
    fail(`path escapes payload: ${relative}`);
  let cursor = root;
  const components = relative.split('/');
  for (let index = 0; index < components.length; index++) {
    cursor = path.join(cursor, components[index]);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail(`symlink is forbidden: ${relative}`);
    if (index < components.length - 1 && !stat.isDirectory()) {
      fail(`inventory parent is not a directory: ${relative}`);
    }
    if (
      index === components.length - 1 &&
      (!stat.isFile() || stat.size === 0)
    ) {
      fail(`inventory file must be regular and nonempty: ${relative}`);
    }
  }
  return absolute;
}

function sourceContract() {
  const source = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'source.json'), 'utf8'),
  );
  if (
    sha256(fs.readFileSync(path.join(__dirname, 'constraint.patch'))) !==
    source.patchSha256
  ) {
    fail('constraint.patch hash does not match source.json');
  }
  return source;
}

function validateOwnedEffectPayload({
  requireComplete = false,
  payloadRoot,
} = {}) {
  const root = checkedRoot(
    payloadRoot ?? path.join(fs.realpathSync(__dirname), 'payload'),
  );
  if (!root) {
    if (requireComplete)
      fail('complete payload required but payload is absent');
    return { kind: 'absent' };
  }
  const source = sourceContract();
  const manifestFile = relativeFile(root, 'manifest.json');
  const bytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (
    !exactKeys(manifest, ['schemaVersion', 'source', 'producer', 'targets']) ||
    manifest.schemaVersion !== 1 ||
    !isDeepStrictEqual(manifest.source, source)
  )
    fail('manifest does not match the exact source.json contract');
  const producer = manifest.producer;
  if (
    !exactKeys(producer, [
      'repository',
      'workflow',
      'runId',
      'runAttempt',
      'sourceCommit',
    ]) ||
    producer.repository !== 'ultramodernjs/ultramodern.js' ||
    producer.workflow !== 'effect-compiler-payload.yml' ||
    !decimal(producer.runId) ||
    !decimal(producer.runAttempt) ||
    !commit(producer.sourceCommit)
  )
    fail('invalid producer metadata');
  if (!record(manifest.targets) || Object.keys(manifest.targets).length === 0) {
    fail('targets must contain at least one target');
  }
  const targets = Object.keys(manifest.targets);
  if (targets.some(target => !source.targets.includes(target)))
    fail('unknown target');
  if (
    requireComplete &&
    !isDeepStrictEqual([...targets].sort(), [...source.targets].sort())
  ) {
    fail('complete payload requires all source targets');
  }
  const listed = new Set(['manifest.json']);
  for (const [target, inventory] of Object.entries(manifest.targets)) {
    const executable = `${target}/tsrs${target.startsWith('win32-') ? '.exe' : ''}`;
    if (
      !exactKeys(inventory, ['executable', 'files']) ||
      inventory.executable !== executable ||
      !Array.isArray(inventory.files) ||
      inventory.files.length === 0
    )
      fail(`invalid target inventory: ${target}`);
    for (const file of inventory.files) {
      if (
        !exactKeys(file, ['path', 'size', 'sha256', 'executable']) ||
        typeof file.path !== 'string' ||
        !file.path.startsWith(`${target}/`) ||
        !Number.isSafeInteger(file.size) ||
        file.size <= 0 ||
        !digest(file.sha256) ||
        typeof file.executable !== 'boolean' ||
        listed.has(file.path)
      )
        fail(`invalid or duplicate file metadata in ${target}`);
      const absolute = relativeFile(root, file.path);
      const stat = fs.lstatSync(absolute);
      if (
        stat.size !== file.size ||
        sha256(fs.readFileSync(absolute)) !== file.sha256
      ) {
        fail(`size or SHA-256 mismatch: ${file.path}`);
      }
      // Windows does not preserve Unix executable bits when validating a bundle.
      if (
        process.platform !== 'win32' &&
        !target.startsWith('win32-') &&
        Boolean(stat.mode & 0o111) !== file.executable
      ) {
        fail(`executable mode mismatch: ${file.path}`);
      }
      if (file.path === executable && !file.executable)
        fail(`native compiler is not executable: ${target}`);
      listed.add(file.path);
    }
    if (!listed.has(executable)) fail(`missing native compiler: ${target}`);
    const paths = inventory.files.map(file => file.path);
    if (!paths.some(file => /\/lib[^/]*\.d\.ts$/.test(file)))
      fail(`missing TypeScript libs: ${target}`);
    // These paths are the producer's legal-text inventory, not proof of license
    // authenticity. The authenticated producer preserves the actual source texts;
    // this validator verifies that every inventoried byte was delivered intact.
    for (const notice of [
      'LICENSE-Effect',
      'LICENSE-tsrs',
      'LICENSE-TypeScript',
      'THIRD-PARTY-NOTICES',
    ]) {
      if (!paths.includes(`${target}/notices/${notice}`)) {
        fail(`missing license/notice ${notice}: ${target}`);
      }
    }
  }
  // The inventory is exhaustive, so an unlisted lib, executable, symlink or
  // special file cannot escape validation merely by being absent from JSON.
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory)) {
      const relative = prefix + entry;
      const absolute = path.join(directory, entry);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`symlink is forbidden: ${relative}`);
      if (stat.isDirectory()) {
        if (!Array.from(listed).some(file => file.startsWith(`${relative}/`))) {
          fail(`unlisted directory: ${relative}`);
        }
        walk(absolute, `${relative}/`);
      } else if (!stat.isFile() || !listed.has(relative)) {
        fail(`unlisted or nonregular file: ${relative}`);
      }
    }
  }
  walk(root);
  return { kind: 'owned', manifest, manifestSha256: sha256(bytes) };
}

function installedPackage(requireFrom, name) {
  const file = requireFrom.resolve(`${name}/package.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function installedIdentity(requireFrom, source) {
  const effect = installedPackage(requireFrom, '@effect/tsgo');
  const tsrs = installedPackage(requireFrom, 'tsrs');
  if (
    effect.name !== '@effect/tsgo' ||
    effect.version !== source.effect.baseVersion ||
    tsrs.name !== 'tsrs' ||
    tsrs.version !== source.tsrs.version ||
    tsrs.tsrs?.typescriptVersion !== source.typescript.version ||
    tsrs.tsrs?.typescriptCommit !== source.typescript.sourceCommit
  ) {
    fail('installed Effect/tsrs identity does not match source.json');
  }
  // The separately installed TypeScript package serves the JS adapter. This
  // executable embeds the TypeScript identity declared by tsrs above and ships
  // its own matching libraries; the adapter need not have the embedded version.
  return tsrs;
}

// Same names and non-executing probes as tsrs/lib/platform.js. Unlike its final
// ldd subprocess fallback, an unknown libc is unsupported here: selection must
// never execute a native program or guess that an unknown Linux host is GNU.
function currentPlatformPackage() {
  let suffix = '';
  if (process.platform === 'linux') {
    let musl;
    try {
      musl = fs.readFileSync('/usr/bin/ldd', 'utf8').includes('musl');
    } catch {
      if (typeof process.report?.getReport === 'function') {
        const previous = process.report.excludeNetwork;
        try {
          process.report.excludeNetwork = true;
          const report = process.report.getReport();
          if (report.header?.glibcVersionRuntime) musl = false;
          else if (
            report.sharedObjects?.some(
              file => file.includes('libc.musl-') || file.includes('ld-musl-'),
            )
          )
            musl = true;
        } catch {
          // Disabled reports leave the platform unknown, never implicitly GNU.
        } finally {
          process.report.excludeNetwork = previous;
        }
      }
    }
    if (musl === undefined) return undefined;
    suffix = musl ? '-musl' : '-gnu';
  }
  return `@tsrs/${process.platform}-${process.arch}${suffix}`;
}

function verifyOverride(file, expectedSha256) {
  if (typeof file !== 'string' || !file)
    fail('executable override must be a nonempty path');
  const absolute = path.resolve(file);
  const root = checkedRoot(path.dirname(absolute));
  if (!root) fail(`missing executable override: ${file}`);
  const verified = relativeFile(root, path.basename(absolute));
  if (sha256(fs.readFileSync(verified)) !== expectedSha256) {
    fail(`executable override differs from verified owned compiler: ${file}`);
  }
  if (process.platform !== 'win32' && !(fs.lstatSync(verified).mode & 0o111)) {
    fail(`executable override has no executable mode: ${file}`);
  }
}

function resolveOwnedEffectCompiler({ from, configuredExecutable }) {
  // Reject before absence can route to the official provider, including source
  // checkouts and Rosetta. M3+ is support policy, not a chip-generation probe.
  if (process.platform === 'darwin' && process.arch !== 'arm64') {
    throw new Error(
      'Unsupported macOS process architecture: arm64 on Apple Silicon M3 or newer is required by support policy; Intel and Rosetta processes are not supported.',
    );
  }
  const payload = validateOwnedEffectPayload();
  if (payload.kind === 'absent') return payload;
  const fromPath =
    from instanceof URL ? fileURLToPath(from) : path.resolve(from);
  const requireFrom = createRequire(
    statIfPresent(fromPath)?.isDirectory()
      ? path.join(fromPath, '__effect_payload__.cjs')
      : fromPath,
  );
  const platformPackage = currentPlatformPackage();
  // Musl deliberately has no owned artifact; never select a GNU binary there.
  const target = platformPackage?.slice('@tsrs/'.length).replace(/-gnu$/, '');
  if (!payload.manifest.source.targets.includes(target))
    return { kind: 'absent' };
  const tsrs = installedIdentity(requireFrom, payload.manifest.source);
  if (
    tsrs.optionalDependencies?.[platformPackage] !==
    payload.manifest.source.tsrs.version
  ) {
    fail('installed tsrs platform contract does not match source.json');
  }
  const inventory = payload.manifest.targets[target];
  if (!inventory)
    fail(`owned payload is missing the current target: ${target}`);
  const artifact = inventory.files.find(
    file => file.path === inventory.executable,
  );
  for (const override of [
    configuredExecutable,
    process.env.TSRS_BINARY,
    process.env.EFFECT_TSGO_BIN,
  ]) {
    if (override !== undefined) verifyOverride(override, artifact.sha256);
  }
  const source = payload.manifest.source;
  return {
    kind: 'owned',
    executable: path.join(
      fs.realpathSync(__dirname),
      'payload',
      ...inventory.executable.split('/'),
    ),
    artifactSha256: artifact.sha256,
    manifestSha256: payload.manifestSha256,
    typescriptVersion: source.typescript.version,
    typescriptCommit: source.typescript.sourceCommit,
    effectVersion: source.effect.baseVersion,
    tsrsVersion: source.tsrs.version,
    target,
    distribution: source.distribution,
  };
}

exports.resolveOwnedEffectCompiler = resolveOwnedEffectCompiler;
exports.validateOwnedEffectPayload = validateOwnedEffectPayload;
