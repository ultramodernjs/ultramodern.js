import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildInputs,
  restoreBuild,
  restorePackedManifest,
  snapshotBuild,
  verifyCurrentPreparedBuild,
} from '../ci/prepared-build-cache.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-build-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  write('packages/example/src/index.ts', 'export const value = 1;');
  write('packages/example/package.json', '{}');
  write('scripts/build.mjs', 'build();');
  write('pnpm-lock.yaml', 'lockfileVersion: 9');
  write('nx.json', '{}');
  write('tests/example.test.ts', 'test();');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return {
    root,
    write,
    inputs: () => buildInputs(root, { CI: 'true' }, { pnpm: '12.11.2' }),
  };
}

test('packed prerequisites round-trip without the retired aggregate edge list', t => {
  const { root, write, inputs } = fixture(t);
  const project = { name: '@modern-js/example', version: '1.0.0' };
  write('packages/example/package.json', JSON.stringify(project));
  const baseline = inputs();
  write('packages/example/dist/index.js', 'compiled');
  write('packed/package/package.json', JSON.stringify(project));
  const tarball = path.join(root, 'packed/example.tgz');
  execFileSync('tar', [
    '-czf', tarball, '-C', path.join(root, 'packed'), 'package',
  ]);
  const manifest = {
    packages: {
      [project.name]: {
        tarball,
        integrity: createHash('sha256')
          .update(fs.readFileSync(tarball))
          .digest('hex'),
      },
    },
    sidecars: {},
    allowBuilds: {},
    minimumReleaseAgeExclude: [],
  };
  const manifestPath = path.join(root, 'packed/packages.json');
  write('packed/packages.json', JSON.stringify(manifest));
  snapshotBuild(root, baseline, manifestPath);
  assert.equal(restoreBuild(root, baseline.key), 1);
  const restored = JSON.parse(
    fs.readFileSync(restorePackedManifest(root, baseline.key), 'utf8'),
  );
  assert.equal(restored.packages[project.name].version, project.version);
  assert.deepEqual(
    fs.readFileSync(restored.packages[project.name].tarball),
    fs.readFileSync(tarball),
  );
  assert.deepEqual(restored.allowBuilds, manifest.allowBuilds);
});

test('identity changes with source, lockfile, shared build scripts and toolchain', t => {
  const { root, write, inputs } = fixture(t);
  const original = inputs().key;
  for (const file of [
    'packages/example/src/index.ts',
    'scripts/build.mjs',
    'pnpm-lock.yaml',
    'nx.json',
  ]) {
    const before = fs.readFileSync(path.join(root, file));
    write(file, `${before}\nchanged`);
    assert.notEqual(inputs().key, original, file);
    write(file, before);
  }
  write('tests/example.test.ts', 'changed test');
  assert.equal(inputs().key, original);
  assert.notEqual(
    buildInputs(root, { CI: 'true' }, { pnpm: '12.8.2' }).key,
    original,
  );
  assert.notEqual(
    buildInputs(
      root,
      { CI: 'true', NODE_ENV: 'production' },
      { pnpm: '12.11.2' },
    ).key,
    original,
  );
  write('packages/example/src/new.ts', 'new source');
  execFileSync('git', ['add', 'packages/example/src/new.ts'], { cwd: root });
  assert.notEqual(inputs().key, original);
});

test('snapshot includes prebundles, generated source and arbitrary configured outputs', t => {
  const { root, write, inputs } = fixture(t);
  const baseline = inputs();
  write('packages/example/dist/index.js', 'compiled');
  write('packages/example/src/generated.ts', 'generated source');
  write('packages/example/deploy/runtime.js', 'deploy output');
  write('packages/toolkit/utils/compiled/dep/index.js', 'prebundle');
  write('scripts/prebundle/dist/index.js', 'bundle driver');
  write('packages/example/node_modules/private/index.js', 'must not cache');
  const manifest = snapshotBuild(root, baseline);
  assert.equal(Object.keys(manifest.outputs).length, 5);
  assert.equal(
    manifest.outputs['packages/example/node_modules/private/index.js'],
    undefined,
  );
  fs.rmSync(path.join(root, 'packages/example/dist'), { recursive: true });
  fs.unlinkSync(path.join(root, 'packages/example/src/generated.ts'));
  assert.equal(restoreBuild(root, baseline.key), 5);
  assert.equal(
    fs.readFileSync(path.join(root, 'packages/example/dist/index.js'), 'utf8'),
    'compiled',
  );
  assert.equal(
    fs.readFileSync(
      path.join(root, 'packages/example/src/generated.ts'),
      'utf8',
    ),
    'generated source',
  );
});

test('restore rejects a wrong key and a corrupt partial archive before installing files', t => {
  const { root, write, inputs } = fixture(t);
  const baseline = inputs();
  write('packages/example/dist/a.js', 'first');
  write('packages/example/dist/z.js', 'last');
  snapshotBuild(root, baseline);
  fs.rmSync(path.join(root, 'packages/example/dist'), { recursive: true });
  assert.throws(() => restoreBuild(root, `${baseline.key}-wrong`), /identity/u);
  fs.writeFileSync(
    path.join(
      root,
      '.ci-build-cache/snapshot/files/packages/example/dist/z.js',
    ),
    'corrupt',
  );
  assert.throws(() => restoreBuild(root, baseline.key), /Corrupt/u);
  assert.equal(
    fs.existsSync(path.join(root, 'packages/example/dist/a.js')),
    false,
  );
});

test('restore rejects parent traversal and dependency output paths', t => {
  const { root, write, inputs } = fixture(t);
  const baseline = inputs();
  write('packages/example/dist/index.js', 'compiled');
  const manifest = snapshotBuild(root, baseline);
  const manifestPath = path.join(
    root,
    '.ci-build-cache/snapshot/manifest.json',
  );
  for (const unsafe of [
    'packages/../outside.js',
    'packages/example/node_modules/evil.js',
    'packages\\outside.js',
  ]) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        outputs: { [unsafe]: Object.values(manifest.outputs)[0] },
      }),
    );
    assert.throws(() => restoreBuild(root, baseline.key), /invalid|Unsafe/u);
  }
});

test('snapshot refuses unexpected mutations of tracked build inputs', t => {
  const { root, write, inputs } = fixture(t);
  const baseline = inputs();
  write('packages/example/src/index.ts', 'unexpected build rewrite');
  assert.throws(() => snapshotBuild(root, baseline), /changed a tracked/u);
});

test('restore rejects a manifest which lost an output record', t => {
  const { root, write, inputs } = fixture(t);
  const baseline = inputs();
  write('packages/example/dist/a.js', 'first');
  write('packages/example/dist/b.js', 'second');
  const manifest = snapshotBuild(root, baseline);
  delete manifest.outputs['packages/example/dist/b.js'];
  fs.writeFileSync(
    path.join(root, '.ci-build-cache/snapshot/manifest.json'),
    JSON.stringify(manifest),
  );
  assert.throws(() => restoreBuild(root, baseline.key), /invalid/u);
});

test('snapshot refuses an input deleted by the build', t => {
  const { root, write, inputs } = fixture(t);
  const baseline = inputs();
  write('packages/example/dist/index.js', 'compiled');
  fs.unlinkSync(path.join(root, 'packages/example/src/index.ts'));
  assert.throws(() => snapshotBuild(root, baseline), /deleted/u);
});

test('task tracking records do not change prepared source identity', t => {
  const { root, write, inputs } = fixture(t);
  write('.beads/issues.jsonl', '{"status":"open"}');
  execFileSync('git', ['add', '.beads/issues.jsonl'], { cwd: root });
  const before = inputs().key;
  write('.beads/issues.jsonl', '{"status":"closed"}');
  assert.equal(inputs().key, before);
});

test('prepared verification rejects new untracked source while accepting covered generated outputs', t => {
  const { root, write, inputs } = fixture(t);
  const baseline = inputs();
  write('.ci-build-cache/inputs.json', JSON.stringify(baseline));
  write('packages/example/dist/index.js', 'compiled');
  snapshotBuild(root, baseline);
  assert.equal(
    verifyCurrentPreparedBuild(root, { CI: 'true' }, { pnpm: '12.11.2' }),
    1,
  );
  write('packages/example/src/new.ts', 'new source');
  assert.throws(
    () => verifyCurrentPreparedBuild(root, { CI: 'true' }, { pnpm: '12.11.2' }),
    /Untracked/u,
  );
});
