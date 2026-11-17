import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const storage = '.ci-dependencies/snapshot';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const trackedFiles = root =>
  execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();
const portable = value => value.split(path.sep).join('/');

function contained(root, relative) {
  assert.equal(typeof relative, 'string');
  assert.ok(relative && !/[\\:\0]/u.test(relative));
  assert.ok(
    relative.split('/').every(part => part && part !== '.' && part !== '..'),
  );
  const result = path.resolve(root, relative);
  assert.ok(
    result.startsWith(`${path.resolve(root)}${path.sep}`),
    'Snapshot path escapes workspace',
  );
  return result;
}

function dependencyRoot(value) {
  return value === 'node_modules' || value.endsWith('/node_modules');
}

export function dependencyInputs(root, runtime = {}) {
  const files = trackedFiles(root).filter(
    file =>
      file === 'pnpm-lock.yaml' ||
      file === 'pnpm-workspace.yaml' ||
      file === '.npmrc' ||
      file === '.mise.toml' ||
      file === '.pnpmfile.cjs' ||
      file.endsWith('/package.json') ||
      file === 'package.json' ||
      file.startsWith('patches/') ||
      file === 'scripts/ci/dependency-snapshot.mjs',
  );
  const inputs = files.map(file => [
    file,
    hash(fs.readFileSync(path.join(root, file))),
  ]);
  // pnpm's bin shims and .modules.yaml contain absolute installation paths.
  // Do not claim that two different checkout/toolchain locations are portable.
  const identity = {
    root: path.resolve(root),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    ...runtime,
    inputs,
  };
  return `installed-linked-files-v2-${hash(JSON.stringify(identity))}`;
}

function dependencyRoots(root) {
  return [
    ...new Set([
      'node_modules',
      ...trackedFiles(root)
        .filter(file => file.endsWith('/package.json'))
        .map(file => `${path.posix.dirname(file)}/node_modules`),
    ]),
  ].filter(file => fs.existsSync(path.join(root, file)));
}

export function snapshotDependencies(root, key) {
  root = path.resolve(root);
  const directory = path.join(root, storage);
  assert.ok(!fs.existsSync(directory), 'Snapshot already exists');
  const roots = dependencyRoots(root);
  assert.ok(roots.includes('node_modules'), 'No installed root dependencies');
  const links = [];
  // Walk without following links. Transport regular files only; the relative
  // graph is rebuilt natively after extraction (junctions on Windows).
  function visit(relative) {
    const absolute = contained(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const destination = path.resolve(
        path.dirname(absolute),
        fs.readlinkSync(absolute),
      );
      const target = portable(path.relative(root, destination));
      contained(root, target);
      const type = fs.statSync(absolute).isDirectory() ? 'dir' : 'file';
      links.push({ path: relative, target, type });
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) visit(`${relative}/${name}`);
    } else {
      assert.ok(stat.isFile(), `Unsupported dependency entry: ${relative}`);
    }
  }
  for (const relative of roots) visit(relative);
  fs.mkdirSync(path.join(directory, 'files'), { recursive: true });
  for (const link of links) fs.unlinkSync(contained(root, link.path));
  for (const relative of roots) {
    const destination = contained(path.join(directory, 'files'), relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(contained(root, relative), destination);
  }
  const manifest = { format: 1, key, roots, links };
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify(manifest),
  );
  console.log(
    `Dependency snapshot: ${roots.length} trees, ${links.length} native links encoded as JSON`,
  );
  return manifest;
}

export function restoreDependencies(root, key) {
  root = path.resolve(root);
  const directory = path.join(root, storage);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.format, 1);
  assert.equal(manifest.key, key, 'Dependency snapshot identity mismatch');
  assert.ok(
    Array.isArray(manifest.roots) && manifest.roots.includes('node_modules'),
  );
  assert.equal(new Set(manifest.roots).size, manifest.roots.length);
  const withinTree = value =>
    manifest.roots.some(tree => value.startsWith(`${tree}/`));
  for (const tree of manifest.roots) {
    contained(root, tree);
    assert.ok(dependencyRoot(tree), 'Not a dependency root');
    assert.ok(
      !fs.existsSync(contained(root, tree)),
      'Refusing to overwrite an installation',
    );
    const stat = fs.lstatSync(contained(path.join(directory, 'files'), tree));
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'Snapshot tree is not a regular directory',
    );
  }
  assert.ok(Array.isArray(manifest.links));
  assert.equal(
    new Set(manifest.links.map(link => link.path)).size,
    manifest.links.length,
  );
  for (const link of manifest.links) {
    contained(root, link.path);
    contained(root, link.target);
    assert.ok(withinTree(link.path), 'Link is not inside dependencies');
    assert.ok(link.type === 'dir' || link.type === 'file');
    assert.ok(
      !manifest.links.some(other => link.path.startsWith(`${other.path}/`)),
      'Nested link parent',
    );
  }
  for (const tree of manifest.roots) {
    const destination = contained(root, tree);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(contained(path.join(directory, 'files'), tree), destination);
  }
  for (const link of manifest.links) {
    const destination = contained(root, link.path);
    assert.ok(
      !fs.existsSync(destination),
      'Snapshot unexpectedly contains a transported link',
    );
    fs.symlinkSync(
      contained(root, link.target),
      destination,
      process.platform === 'win32' && link.type === 'dir'
        ? 'junction'
        : link.type,
    );
  }
  for (const link of manifest.links) {
    assert.equal(
      fs.realpathSync(contained(root, link.path)),
      fs.realpathSync(contained(root, link.target)),
    );
  }
  console.log(
    `Restored ${manifest.roots.length} dependency trees and ${manifest.links.length} native links without pnpm relinking`,
  );
  fs.rmSync(directory, { recursive: true });
  return manifest;
}

export function verifyTransport(root, key) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'dependency-transport-'),
  );
  const archive = path.join(temporary, 'dependencies.tar');
  // Git Bash's GNU tar interprets C: as a remote host. Use Windows' native
  // archive executable, with only regular files on either side of transport.
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
      : 'tar';
  try {
    execFileSync(tar, ['-cf', archive, storage], { cwd: root });
    fs.rmSync(path.join(root, storage), { recursive: true });
    execFileSync(tar, ['-xf', archive], { cwd: root });
    return restoreDependencies(root, key);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const command = process.argv[2];
  const root = process.cwd();
  const key = dependencyInputs(root);
  if (command === 'key') {
    output('key', key);
    console.log(key);
  } else if (command === 'snapshot') {
    snapshotDependencies(root, key);
  } else if (command === 'restore') {
    restoreDependencies(root, key);
  } else if (command === 'verify-transport') {
    verifyTransport(root, key);
  } else {
    throw new Error(
      'Usage: dependency-snapshot.mjs key|snapshot|restore|verify-transport',
    );
  }
}
