import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  buildInputs,
  restoreBuild,
  restorePackedManifest,
  snapshotBuild,
  verifyCurrentPreparedBuild,
} from '../ci/prepared-build-cache.mjs';

const environment = { CI: 'true' };
const toolchain = { pnpm: '12.11.2' };
const generatedTracked = [
  'packages/runtime/plugin-runtime/static/modern-inline.js',
  'packages/runtime/plugin-runtime/static/modern-run-router-data-fn.js',
  'packages/runtime/plugin-runtime/static/modern-run-window-fn.js',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function packageArchive(name, version = '1.0.0') {
  const contents = Buffer.from(JSON.stringify({ name, version }));
  const header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return gzipSync(
    Buffer.concat([
      header,
      contents,
      Buffer.alloc((512 - (contents.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}

function fixture(t, { generated = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-packed-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
    return destination;
  };
  write('packages/example/src/index.ts', 'export const value = 1;');
  write(
    'packages/example/package.json',
    JSON.stringify({ name: '@modern-js/example', version: '1.0.0' }),
  );
  write('package.json', '{}');
  write('scripts/build.mjs', 'build();');
  write('scripts/ci/prepared-build-cache.mjs', 'export const cache = true;');
  write('tests/utils/packagePacking.mjs', 'export const pack = true;');
  write('pnpm-lock.yaml', 'lockfileVersion: 9');
  write('nx.json', '{}');
  write('tests/example.test.ts', 'test();');
  if (generated) {
    for (const file of generatedTracked)
      write(file, 'tracked generator source');
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  const inputs = () => buildInputs(root, environment, toolchain);
  return { root, write, inputs };
}

function prepare(fixture) {
  const { root, write, inputs } = fixture;
  const baseline = inputs();
  write('.ci-build-cache/inputs.json', JSON.stringify(baseline));
  write('packages/example/dist/index.js', 'compiled');
  const packageBytes = packageArchive('@modern-js/example');
  const sidecarBytes = packageArchive('@bleedingdev/example');
  const manifest = {
    packages: {
      '@modern-js/example': {
        tarball: write('.ci-build-cache/packed/example.tgz', packageBytes),
        version: '1.0.0',
        integrity: digest(packageBytes),
      },
    },
    sidecars: {
      '@bleedingdev/example': {
        tarball: write('.ci-build-cache/packed/sidecar.tgz', sidecarBytes),
        version: '1.0.0',
        integrity: digest(sidecarBytes),
      },
    },
    allowBuilds: { esbuild: true },
  };
  const manifestPath = write(
    '.ci-build-cache/packed/packages.json',
    JSON.stringify(manifest),
  );
  return { baseline, manifest, manifestPath, root, write };
}

function packedSnapshotArchive(root, snapshot) {
  return path.join(
    root,
    '.ci-build-cache/snapshot/packed',
    Object.keys(snapshot.packed.archives)[0],
  );
}

test('prepared cache APIs accept a checkout root with a trailing separator', t => {
  const prepared = prepare(fixture(t));
  const root = prepared.root + path.sep;
  assert.equal(
    buildInputs(root, environment, toolchain).key,
    prepared.baseline.key,
  );
  snapshotBuild(root, prepared.baseline, prepared.manifestPath);
  fs.rmSync(path.join(root, 'packages/example/dist'), { recursive: true });
  assert.equal(restoreBuild(root, prepared.baseline.key), 1);
  assert.equal(verifyCurrentPreparedBuild(root, environment, toolchain), 1);
  assert.equal(
    fs.existsSync(restorePackedManifest(root, prepared.baseline.key)),
    true,
  );
});

test('packed snapshots relocate with complete metadata and verified tarballs', t => {
  const source = prepare(fixture(t));
  snapshotBuild(source.root, source.baseline, source.manifestPath);
  const destination = fixture(t);
  assert.equal(destination.inputs().key, source.baseline.key);
  fs.cpSync(
    path.join(source.root, '.ci-build-cache'),
    path.join(destination.root, '.ci-build-cache'),
    { recursive: true },
  );
  assert.equal(restoreBuild(destination.root, source.baseline.key), 1);
  const relocatedPath = restorePackedManifest(
    destination.root,
    source.baseline.key,
  );
  assert.equal(
    relocatedPath,
    path.join(destination.root, '.ci-build-cache/restored-packages.json'),
  );
  const relocated = JSON.parse(fs.readFileSync(relocatedPath, 'utf8'));
  for (const group of ['packages', 'sidecars']) {
    for (const [name, expected] of Object.entries(source.manifest[group])) {
      const actual = relocated[group][name];
      assert.deepEqual({ ...actual, tarball: expected.tarball }, expected);
      assert.equal(path.isAbsolute(actual.tarball), true);
      assert.equal(
        actual.tarball.startsWith(
          path.join(
            destination.root,
            '.ci-build-cache/snapshot/packed',
            group,
          ) + path.sep,
        ),
        true,
      );
      assert.equal(digest(fs.readFileSync(actual.tarball)), expected.integrity);
    }
  }
  assert.deepEqual(relocated.allowBuilds, source.manifest.allowBuilds);
  assert.deepEqual(Object.keys(relocated).sort(), [
    'allowBuilds',
    'packages',
    'sidecars',
  ]);
  assert.equal(
    verifyCurrentPreparedBuild(destination.root, environment, toolchain),
    1,
  );
});

for (const property of ['packages', 'sidecars', 'allowBuilds']) {
  test(`snapshot and restore still require ${property} metadata`, t => {
    const prepared = prepare(fixture(t));
    const snapshot = snapshotBuild(
      prepared.root,
      prepared.baseline,
      prepared.manifestPath,
    );
    delete prepared.manifest[property];
    prepared.write(
      '.ci-build-cache/packed/packages.json',
      JSON.stringify(prepared.manifest),
    );
    assert.throws(
      () =>
        snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath),
      /Packed prerequisite manifest is incomplete/u,
    );
    delete snapshot.packed.manifest[property];
    snapshot.packed.digest = digest(
      JSON.stringify({
        archives: snapshot.packed.archives,
        manifest: snapshot.packed.manifest,
      }),
    );
    prepared.write(
      '.ci-build-cache/snapshot/manifest.json',
      JSON.stringify(snapshot),
    );
    fs.rmSync(path.join(prepared.root, 'packages/example/dist'), {
      recursive: true,
    });
    assert.throws(
      () => restoreBuild(prepared.root, prepared.baseline.key),
      /Packed cache manifest is invalid/u,
    );
    assert.equal(
      fs.existsSync(path.join(prepared.root, 'packages/example/dist/index.js')),
      false,
    );
  });
}

for (const mutation of ['corrupt', 'missing']) {
  test(`${mutation} packed archive rejects restore before any output copy`, t => {
    const prepared = prepare(fixture(t));
    const snapshot = snapshotBuild(
      prepared.root,
      prepared.baseline,
      prepared.manifestPath,
    );
    fs.rmSync(path.join(prepared.root, 'packages/example/dist'), {
      recursive: true,
    });
    const archive = packedSnapshotArchive(prepared.root, snapshot);
    if (mutation === 'corrupt') fs.writeFileSync(archive, 'corrupted gzip');
    else fs.unlinkSync(archive);
    assert.throws(() => restoreBuild(prepared.root, prepared.baseline.key));
    assert.equal(
      fs.existsSync(path.join(prepared.root, 'packages/example/dist/index.js')),
      false,
    );
  });
}

test('packed metadata mutation rejects restore before any output copy', t => {
  const prepared = prepare(fixture(t));
  const snapshot = snapshotBuild(
    prepared.root,
    prepared.baseline,
    prepared.manifestPath,
  );
  snapshot.packed.manifest.allowBuilds.esbuild = false;
  prepared.write(
    '.ci-build-cache/snapshot/manifest.json',
    JSON.stringify(snapshot),
  );
  fs.rmSync(path.join(prepared.root, 'packages/example/dist'), {
    recursive: true,
  });
  assert.throws(() => restoreBuild(prepared.root, prepared.baseline.key));
  assert.equal(
    fs.existsSync(path.join(prepared.root, 'packages/example/dist/index.js')),
    false,
  );
});

test('snapshot rejects archives outside the preparation directory', t => {
  const prepared = prepare(fixture(t));
  const entry = prepared.manifest.packages['@modern-js/example'];
  entry.tarball = prepared.write(
    'outside.tgz',
    packageArchive('@modern-js/example'),
  );
  prepared.write(
    '.ci-build-cache/packed/packages.json',
    JSON.stringify(prepared.manifest),
  );
  assert.throws(() =>
    snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath),
  );
});

test('snapshot rejects tarball symlinks', {
  skip: process.platform === 'win32',
}, t => {
  const prepared = prepare(fixture(t));
  const entry = prepared.manifest.packages['@modern-js/example'];
  const target = prepared.write(
    'outside.tgz',
    packageArchive('@modern-js/example'),
  );
  fs.unlinkSync(entry.tarball);
  fs.symlinkSync(target, entry.tarball);
  assert.throws(() =>
    snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath),
  );
});

test('snapshot rejects archive paths through a descendant directory symlink', {
  skip: process.platform === 'win32',
}, t => {
  const prepared = prepare(fixture(t));
  const target = prepared.write(
    '.ci-build-cache/packed/real/example.tgz',
    packageArchive('@modern-js/example'),
  );
  const link = path.join(prepared.root, '.ci-build-cache/packed/link');
  fs.symlinkSync(path.dirname(target), link);
  prepared.manifest.packages['@modern-js/example'].tarball = path.join(
    link,
    'example.tgz',
  );
  prepared.write(
    '.ci-build-cache/packed/packages.json',
    JSON.stringify(prepared.manifest),
  );
  assert.throws(() =>
    snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath),
  );
});

test('snapshot accepts a preparation path through an ancestor symlink', {
  skip: process.platform === 'win32',
}, t => {
  const prepared = prepare(fixture(t));
  const alias = `${prepared.root}-alias`;
  fs.symlinkSync(prepared.root, alias);
  t.after(() => fs.unlinkSync(alias));
  for (const group of ['packages', 'sidecars']) {
    for (const entry of Object.values(prepared.manifest[group])) {
      entry.tarball = path.join(
        alias,
        path.relative(prepared.root, entry.tarball),
      );
    }
  }
  prepared.write(
    '.ci-build-cache/packed/packages.json',
    JSON.stringify(prepared.manifest),
  );
  assert.equal(
    snapshotBuild(
      prepared.root,
      prepared.baseline,
      path.join(alias, '.ci-build-cache/packed/packages.json'),
    ).packed.count,
    2,
  );
});

for (const [name, version] of [
  ['@modern-js/wrong', '1.0.0'],
  ['@modern-js/example', '2.0.0'],
]) {
  test(`snapshot rejects archive identity ${name}@${version}`, t => {
    const prepared = prepare(fixture(t));
    const entry = prepared.manifest.packages['@modern-js/example'];
    const bytes = packageArchive(name, version);
    fs.writeFileSync(entry.tarball, bytes);
    entry.integrity = digest(bytes);
    prepared.write(
      '.ci-build-cache/packed/packages.json',
      JSON.stringify(prepared.manifest),
    );
    assert.throws(() =>
      snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath),
    );
  });
}

test('snapshot rejects a sidecar whose actual package version differs from its manifest', t => {
  const prepared = prepare(fixture(t));
  const entry = prepared.manifest.sidecars['@bleedingdev/example'];
  const bytes = packageArchive('@bleedingdev/example', '2.0.0');
  fs.writeFileSync(entry.tarball, bytes);
  entry.integrity = digest(bytes);
  prepared.write(
    '.ci-build-cache/packed/packages.json',
    JSON.stringify(prepared.manifest),
  );
  assert.throws(() =>
    snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath),
  );
});

test('snapshot rejects matching archive metadata for a different tracked source version', t => {
  const prepared = prepare(fixture(t));
  const entry = prepared.manifest.packages['@modern-js/example'];
  const bytes = packageArchive('@modern-js/example', '2.0.0');
  fs.writeFileSync(entry.tarball, bytes);
  entry.version = '2.0.0';
  entry.integrity = digest(bytes);
  prepared.write(
    '.ci-build-cache/packed/packages.json',
    JSON.stringify(prepared.manifest),
  );
  assert.throws(() =>
    snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath),
  );
});

test('packing helper and cache helper source changes invalidate the cache identity', t => {
  const { root, write, inputs } = fixture(t);
  const original = inputs().key;
  for (const file of [
    'tests/utils/packagePacking.mjs',
    'scripts/ci/prepared-build-cache.mjs',
  ]) {
    const before = fs.readFileSync(path.join(root, file));
    write(file, `${before}\nchanged`);
    assert.notEqual(inputs().key, original, file);
    write(file, before);
  }
});

test('prepared verification rejects output changes and stale source or toolchain', t => {
  const prepared = prepare(fixture(t));
  snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath);
  assert.equal(
    verifyCurrentPreparedBuild(prepared.root, environment, toolchain),
    1,
  );
  prepared.write('packages/example/dist/index.js', 'changed compiled output');
  assert.throws(() =>
    verifyCurrentPreparedBuild(prepared.root, environment, toolchain),
  );
  assert.throws(() =>
    restorePackedManifest(prepared.root, prepared.baseline.key),
  );
  restoreBuild(prepared.root, prepared.baseline.key);
  prepared.write('packages/example/src/index.ts', 'changed source');
  assert.throws(() =>
    verifyCurrentPreparedBuild(prepared.root, environment, toolchain),
  );
  prepared.write('packages/example/src/index.ts', 'export const value = 1;');
  assert.throws(() =>
    verifyCurrentPreparedBuild(prepared.root, environment, { pnpm: '12.8.2' }),
  );
  assert.throws(() =>
    verifyCurrentPreparedBuild(
      prepared.root,
      { CI: 'true', SKIP_DTS: 'true' },
      toolchain,
    ),
  );
});

test('prepared verification checks current output permissions', {
  skip: process.platform === 'win32',
}, t => {
  const prepared = prepare(fixture(t));
  snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath);
  const output = path.join(prepared.root, 'packages/example/dist/index.js');
  fs.chmodSync(output, (fs.statSync(output).mode & 0o777) ^ 0o100);
  assert.throws(() =>
    verifyCurrentPreparedBuild(prepared.root, environment, toolchain),
  );
});

test('restore rejects a dangling output symlink before copying earlier outputs', {
  skip: process.platform === 'win32',
}, t => {
  const prepared = prepare(fixture(t));
  prepared.write('packages/example/dist/z.js', 'later output');
  snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath);
  fs.rmSync(path.join(prepared.root, 'packages/example/dist'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(prepared.root, 'packages/example/dist'));
  const external = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-packed-external-'),
  );
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const target = path.join(external, 'not-created.js');
  fs.symlinkSync(
    target,
    path.join(prepared.root, 'packages/example/dist/z.js'),
  );
  assert.throws(() => restoreBuild(prepared.root, prepared.baseline.key));
  assert.equal(fs.existsSync(target), false);
  assert.equal(
    fs.existsSync(path.join(prepared.root, 'packages/example/dist/index.js')),
    false,
  );
});

test('restore rejects a dangling packed-manifest symlink before copying outputs', {
  skip: process.platform === 'win32',
}, t => {
  const prepared = prepare(fixture(t));
  snapshotBuild(prepared.root, prepared.baseline, prepared.manifestPath);
  const restoredPath = restorePackedManifest(
    prepared.root,
    prepared.baseline.key,
  );
  fs.unlinkSync(restoredPath);
  fs.rmSync(path.join(prepared.root, 'packages/example/dist'), {
    recursive: true,
  });
  const external = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-packed-external-'),
  );
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const target = path.join(external, 'not-created.json');
  fs.symlinkSync(target, restoredPath);
  assert.throws(() => restoreBuild(prepared.root, prepared.baseline.key));
  assert.equal(fs.existsSync(target), false);
  assert.equal(
    fs.existsSync(path.join(prepared.root, 'packages/example/dist/index.js')),
    false,
  );
});

test('only manifested generated static changes can satisfy prepared verification', t => {
  const prepared = prepare(fixture(t, { generated: true }));
  for (const file of generatedTracked)
    prepared.write(file, 'generated build output');
  const snapshot = snapshotBuild(
    prepared.root,
    prepared.baseline,
    prepared.manifestPath,
  );
  assert.equal(
    verifyCurrentPreparedBuild(prepared.root, environment, toolchain),
    4,
  );
  for (const file of generatedTracked) {
    const entry = snapshot.outputs[file];
    delete snapshot.outputs[file];
    snapshot.count = Object.keys(snapshot.outputs).length;
    snapshot.digest = digest(JSON.stringify(snapshot.outputs));
    prepared.write(
      '.ci-build-cache/snapshot/manifest.json',
      JSON.stringify(snapshot),
    );
    assert.throws(
      () => verifyCurrentPreparedBuild(prepared.root, environment, toolchain),
      file,
    );
    snapshot.outputs[file] = entry;
  }
});
