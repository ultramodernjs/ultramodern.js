#!/usr/bin/env node
// CI producer/stager only. Installed consumers never copy or repair payloads.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const compilerRoot = path.join(
  repoRoot,
  'packages/solutions/app-tools-extensions/compiler',
);
const source = JSON.parse(
  fs.readFileSync(path.join(compilerRoot, 'source.json'), 'utf8'),
);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const fail = message => {
  throw new Error(`Compiler payload: ${message}`);
};

export function producerIdentity(env = process.env) {
  const producer = {
    repository: env.GITHUB_REPOSITORY,
    workflow: 'effect-compiler-payload.yml',
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    sourceCommit: env.GITHUB_SHA,
  };
  if (
    producer.repository !== 'ultramodernjs/ultramodern.js' ||
    !/^[1-9]\d*$/.test(producer.runId ?? '') ||
    !/^[1-9]\d*$/.test(producer.runAttempt ?? '') ||
    !/^[a-f0-9]{40}$/.test(producer.sourceCommit ?? '')
  ) {
    fail('requires the authenticated UltraModern workflow/run/source context');
  }
  return producer;
}

function checkSource() {
  if (
    digest(fs.readFileSync(path.join(compilerRoot, 'constraint.patch'))) !==
    source.patchSha256
  )
    fail('committed correction does not match source.json');
}

function walk(root, relative = '') {
  const entries = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    if (!name || name.includes('\\') || name === '.' || name === '..')
      fail('nonportable payload name');
    const rel = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, rel));
    if (stat.isSymbolicLink()) fail(`symlink is not allowed: ${rel}`);
    if (stat.isDirectory()) entries.push(...walk(root, rel));
    else if (stat.isFile()) entries.push(rel);
    else fail(`nonregular payload file: ${rel}`);
  }
  return entries;
}

function contained(root, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative.split('/').some(part => !part || part === '.' || part === '..') ||
    path.posix.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative)
  ) {
    fail(`invalid inventory path: ${String(relative)}`);
  }
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail(`symlink: ${relative}`);
  }
  return current;
}

function copyInventory(input, output, manifest) {
  const seen = new Set();
  for (const [target, item] of Object.entries(manifest.targets)) {
    if (
      !source.targets.includes(target) ||
      !Array.isArray(item.files) ||
      !item.files.length
    )
      fail(`invalid target ${target}`);
    let executableFound = false;
    for (const file of item.files) {
      if (!file.path.startsWith(`${target}/`) || seen.has(file.path))
        fail(`duplicate or cross-target inventory: ${file.path}`);
      seen.add(file.path);
      if (
        typeof file.executable !== 'boolean' ||
        !Number.isSafeInteger(file.size) ||
        file.size <= 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
      )
        fail(`invalid file receipt: ${file.path}`);
      const filename = contained(input, file.path);
      if (!fs.lstatSync(filename).isFile())
        fail(`not a regular file: ${file.path}`);
      const bytes = fs.readFileSync(filename);
      if (bytes.length !== file.size || digest(bytes) !== file.sha256)
        fail(`digest/size mismatch: ${file.path}`);
      if (file.path === item.executable) executableFound = file.executable;
      const destination = path.join(output, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, {
        flag: 'wx',
        mode: file.executable ? 0o755 : 0o644,
      });
      if (process.platform !== 'win32')
        fs.chmodSync(destination, file.executable ? 0o755 : 0o644);
    }
    if (!executableFound) fail(`missing executable inventory for ${target}`);
  }
}

function assertReceipt(manifest, producer) {
  if (
    manifest.schemaVersion !== 1 ||
    !isDeepStrictEqual(manifest.source, source) ||
    !isDeepStrictEqual(manifest.producer, producer) ||
    !manifest.targets ||
    typeof manifest.targets !== 'object' ||
    Array.isArray(manifest.targets)
  )
    fail('source or same-run producer receipt mismatch');
}

export function assertReleaseCompilerPayload(
  packageRoot = path.dirname(compilerRoot),
  { sameRun = true } = {},
) {
  checkSource();
  for (const filename of [
    'resolve.cjs',
    'resolve.d.cts',
    'source.json',
    'constraint.patch',
  ]) {
    let packagedFile;
    try {
      packagedFile = contained(packageRoot, `compiler/${filename}`);
    } catch {
      fail(`missing or unsafe compiler bootstrap ${filename}`);
    }
    if (
      !fs.lstatSync(packagedFile).isFile() ||
      !fs
        .readFileSync(packagedFile)
        .equals(fs.readFileSync(path.join(compilerRoot, filename)))
    )
      fail(
        `packaged compiler bootstrap differs from reviewed source: ${filename}`,
      );
  }
  const result = require(
    path.join(compilerRoot, 'resolve.cjs'),
  ).validateOwnedEffectPayload({
    payloadRoot: path.join(packageRoot, 'compiler/payload'),
    requireComplete: true,
  });
  if (result.kind !== 'owned')
    fail('release requires the complete corrected compiler payload');
  if (sameRun) assertReceipt(result.manifest, producerIdentity());
  return result;
}

function atomicOutput(output, write) {
  if (fs.existsSync(output))
    fail(`output already exists; refusing to replace it: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = fs.mkdtempSync(`${output}.staging-`);
  try {
    const result = write(temporary);
    fs.renameSync(temporary, output);
    return result;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function produceTarget({
  artifactDir,
  target,
  output,
  env = process.env,
}) {
  checkSource();
  const producer = producerIdentity(env);
  if (!source.targets.includes(target)) fail(`unsupported target ${target}`);
  if (fs.lstatSync(artifactDir).isSymbolicLink())
    fail('artifact root is a symlink');
  const paths = walk(artifactDir);
  const binaryName = target.startsWith('win32-') ? 'tsrs.exe' : 'tsrs';
  const binaries = paths.filter(
    item => path.posix.basename(item) === binaryName,
  );
  if (binaries.length !== 1)
    fail(`expected one ${binaryName}, got ${binaries.length}`);
  // repoctl's artifact is a complete noembed distribution: preserve its layout.
  const executable = `${target}/${binaries[0]}`;
  const files = paths.map(relative => {
    const bytes = fs.readFileSync(path.join(artifactDir, relative));
    return {
      path: `${target}/${relative}`,
      size: bytes.length,
      sha256: digest(bytes),
      executable: relative === binaries[0],
    };
  });
  const manifest = {
    schemaVersion: 1,
    source,
    producer,
    targets: { [target]: { executable, files } },
  };
  return atomicOutput(output, temporary => {
    const targetRoot = path.join(temporary, target);
    fs.mkdirSync(targetRoot);
    // Reuse the same inventory reader as aggregation, with a target-root view.
    for (const relative of paths) {
      const destination = path.join(targetRoot, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(
        path.join(artifactDir, relative),
        destination,
        fs.constants.COPYFILE_EXCL,
      );
      if (process.platform !== 'win32')
        fs.chmodSync(destination, relative === binaries[0] ? 0o755 : 0o644);
    }
    fs.writeFileSync(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    require(path.join(compilerRoot, 'resolve.cjs')).validateOwnedEffectPayload({
      payloadRoot: temporary,
      requireComplete: false,
    });
    return manifest;
  });
}

export function stagePayload({
  input,
  output = path.join(compilerRoot, 'payload'),
  completeManifest = false,
  env = process.env,
}) {
  checkSource();
  const producer = producerIdentity(env);
  if (fs.lstatSync(input).isSymbolicLink()) fail('input root is a symlink');
  const receipts = completeManifest
    ? [{ root: input, manifest: json(contained(input, 'manifest.json')) }]
    : fs
        .readdirSync(input)
        .sort()
        .map(name => {
          const root = contained(input, name);
          if (!fs.lstatSync(root).isDirectory())
            fail(`unexpected target artifact ${name}`);
          return { root, manifest: json(contained(root, 'manifest.json')) };
        });
  const manifest = { schemaVersion: 1, source, producer, targets: {} };
  for (const receipt of receipts) {
    assertReceipt(receipt.manifest, producer);
    for (const [target, item] of Object.entries(receipt.manifest.targets)) {
      if (manifest.targets[target]) fail(`duplicate target artifact ${target}`);
      manifest.targets[target] = item;
    }
  }
  if (
    !isDeepStrictEqual(
      Object.keys(manifest.targets).sort(),
      [...source.targets].sort(),
    )
  )
    fail('complete supported-target matrix required');
  return atomicOutput(output, temporary => {
    for (const receipt of receipts)
      copyInventory(receipt.root, temporary, receipt.manifest);
    fs.writeFileSync(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    require(path.join(compilerRoot, 'resolve.cjs')).validateOwnedEffectPayload({
      payloadRoot: temporary,
      requireComplete: true,
    });
    console.log(
      `Verified compiler payload ${digest(fs.readFileSync(path.join(temporary, 'manifest.json')))} from run ${producer.runId}/${producer.runAttempt}`,
    );
    return manifest;
  });
}

function main(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--complete-manifest') {
      options.completeManifest = true;
      continue;
    }
    const key = {
      '--input': 'input',
      '--output': 'output',
      '--target': 'target',
      '--artifact-dir': 'artifactDir',
    }[flag];
    if (!key || !rest[i + 1] || rest[i + 1].startsWith('--') || options[key])
      fail(`invalid argument ${flag}`);
    options[key] = rest[++i];
  }
  if (
    command === 'produce' &&
    options.artifactDir &&
    options.target &&
    options.output
  )
    produceTarget(options);
  else if (command === 'stage' && options.input) stagePayload(options);
  else
    fail(
      'use produce --artifact-dir DIR --target TARGET --output DIR, or stage --input DIR [--complete-manifest]',
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
