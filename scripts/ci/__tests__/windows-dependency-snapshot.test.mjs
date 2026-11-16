import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  dependencyInputs,
  restoreDependencies,
  snapshotDependencies,
} from '../windows-dependency-snapshot.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'windows-dependencies-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace');
  fs.mkdirSync(root);
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), bytes);
  };
  write('package.json', '{"packageManager":"pnpm@12.11.2"}');
  write('packages/example/package.json', '{"name":"example"}');
  write('pnpm-lock.yaml', 'lockfileVersion: 9');
  write('patches/example.patch', 'a correction');
  write('source.js', 'application source');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  write(
    'node_modules/.pnpm/example/node_modules/example/package.json',
    '{"name":"dependency","version":"1.0.0","main":"index.js"}',
  );
  write(
    'node_modules/.pnpm/example/node_modules/example/index.js',
    'module.exports = "native dependency graph works"',
  );
  write('packages/example/node_modules/.bin/example.cmd', 'relative bin shim');
  const target = path.join(
    root,
    'node_modules/.pnpm/example/node_modules/example',
  );
  for (const file of [
    'node_modules/example',
    'packages/example/node_modules/example',
  ]) {
    fs.symlinkSync(target, path.join(root, file), 'junction');
  }
  fs.symlinkSync(
    path.join(root, 'packages/example'),
    path.join(root, 'node_modules/workspace-example'),
    'junction',
  );
  return { root, directory, write, key: dependencyInputs(root) };
}

// Exercise the failure that made a raw node_modules cache unusable: no native
// link crosses tar, and every target is reconstructed for the receiving tree.
test('file-only tar transport rebuilds native links, workspace links and runnable dependencies after relocation', t => {
  const { root, directory, key } = fixture(t);
  const manifest = snapshotDependencies(root, key);
  assert.equal(manifest.links.length, 3);
  const archive = path.join(directory, 'snapshot.tar');
  execFileSync('tar', ['-cf', archive, '.ci-windows-dependencies'], {
    cwd: root,
  });
  const listing = execFileSync('tar', ['-tvf', archive], { encoding: 'utf8' });
  assert.ok(
    listing
      .trim()
      .split('\n')
      .every(line => !line.startsWith('l')),
    'No symbolic links may cross archive transport',
  );
  const received = path.join(directory, 'receiving-workspace');
  fs.mkdirSync(path.join(received, 'packages/example'), { recursive: true });
  fs.writeFileSync(
    path.join(received, 'packages/example/package.json'),
    '{"name":"workspace-example"}',
  );
  execFileSync('tar', ['-xf', archive], { cwd: received });
  // Deleting the sender proves no junction can accidentally resolve to it.
  fs.rmSync(root, { recursive: true, force: true });
  restoreDependencies(received, key);
  const result = execFileSync(
    process.execPath,
    [
      '-e',
      'console.log(require("example")); console.log(require("workspace-example/package.json").name)',
    ],
    { cwd: received, encoding: 'utf8' },
  );
  assert.equal(
    result.trim(),
    'native dependency graph works\nworkspace-example',
  );
  assert.equal(
    fs.readFileSync(
      path.join(received, 'packages/example/node_modules/.bin/example.cmd'),
      'utf8',
    ),
    'relative bin shim',
  );
  assert.equal(
    fs.realpathSync(
      path.join(received, 'packages/example/node_modules/example'),
    ),
    fs.realpathSync(path.join(received, 'node_modules/example')),
  );
});

test('lockfile, manifests, patches, runtime and checkout paths bind the snapshot; unrelated source does not', t => {
  const { root, write, key } = fixture(t);
  write('source.js', 'changed application source');
  assert.equal(dependencyInputs(root), key);
  for (const file of [
    'pnpm-lock.yaml',
    'packages/example/package.json',
    'patches/example.patch',
  ]) {
    const original = fs.readFileSync(path.join(root, file));
    write(file, 'changed');
    assert.notEqual(dependencyInputs(root), key, file);
    write(file, original);
  }
  assert.notEqual(dependencyInputs(root, { node: 'different-runtime' }), key);
});

test('wrong identity and escaping link targets fail closed before an installation is restored', t => {
  const { root, key } = fixture(t);
  snapshotDependencies(root, key);
  assert.throws(() => restoreDependencies(root, 'wrong'), /identity mismatch/);
  assert.ok(!fs.existsSync(path.join(root, 'node_modules')));
  const file = path.join(
    root,
    '.ci-windows-dependencies/snapshot/manifest.json',
  );
  const manifest = JSON.parse(fs.readFileSync(file));
  for (const target of ['../outside', '/absolute', 'C:/absolute']) {
    manifest.links[0].target = target;
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => restoreDependencies(root, key));
    assert.ok(!fs.existsSync(path.join(root, 'node_modules')));
  }
});

test('snapshot refuses an external native link instead of archiving personal or machine state', t => {
  const { root, directory, key } = fixture(t);
  fs.symlinkSync(
    directory,
    path.join(root, 'node_modules/external'),
    'junction',
  );
  assert.throws(() => snapshotDependencies(root, key));
  assert.ok(fs.existsSync(path.join(root, 'node_modules/example')));
});
