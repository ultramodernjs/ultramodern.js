import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyExactPatch,
  packFiles,
} from '../native-artifacts/reconstruct.mjs';
import {
  assertCandidateSource,
  installedPackage,
  qualify,
} from './qualify.mjs';
import {
  lockedIntegrity,
  pinnedAdapterCandidate,
  qualifySharedCorePeer,
} from './qualify-shared-core-peer.mjs';
import {
  assertSharedCoreManifest,
  sharedCoreManifest,
} from './shared-core-peer.mjs';

const here = import.meta.dirname;
const unknown = ['octane-0.19.0', 'octane-0.20', '', null, '__proto__', 0];
const temporary = t => {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'adapter-candidate-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
// JSON string preserves the exact npm package.json bytes of each upstream.
const upstream = directory =>
  JSON.parse(
    fs.readFileSync(
      path.join(here, directory, 'upstream-adapter-package.json'),
    ),
  );
const peered = directory => sharedCoreManifest(JSON.parse(upstream(directory)));
const manifests = {
  'octane-0.18.0': peered('.'),
  'octane-0.20.0': peered('octane-0.20.0'),
};
const neverRun = () => assert.fail('No process may start');

test('candidate shared-core manifests bind the exact adapter and octane range', () => {
  assert.equal(manifests['octane-0.18.0'].version, '0.3.4');
  assert.equal(manifests['octane-0.20.0'].version, '0.3.6');
  assertSharedCoreManifest(manifests['octane-0.18.0']);
  assertSharedCoreManifest(manifests['octane-0.18.0'], 'octane-0.18.0');
  assertSharedCoreManifest(manifests['octane-0.20.0'], 'octane-0.20.0');
  assert.throws(() => assertSharedCoreManifest(manifests['octane-0.20.0']));
  assert.throws(() =>
    assertSharedCoreManifest(manifests['octane-0.18.0'], 'octane-0.20.0'),
  );
  // Neither half of the tuple may drift independently.
  for (const [candidate, patch] of [
    ['octane-0.20.0', m => (m.peerDependencies.octane = '^0.18.0')],
    ['octane-0.20.0', m => (m.version = '0.3.4')],
    ['octane-0.20.0', m => (m.version = '0.3.5')],
    ['octane-0.18.0', m => (m.peerDependencies.octane = '^0.20.0')],
    ['octane-0.18.0', m => (m.version = '0.3.6')],
  ]) {
    const wrong = structuredClone(
      manifests[candidate === 'octane-0.20.0' ? candidate : 'octane-0.18.0'],
    );
    patch(wrong);
    assert.throws(() => assertSharedCoreManifest(wrong, candidate));
  }
  for (const candidate of unknown)
    assert.throws(
      () => assertSharedCoreManifest(manifests['octane-0.18.0'], candidate),
      /Unknown Octane adapter candidate/,
    );
});

test('every candidate keeps the same exact required Router Core and independent checks', () => {
  for (const [candidate, manifest] of Object.entries(manifests))
    for (const mutate of [
      m => (m.dependencies['@tanstack/router-core'] = '1.171.39'),
      m => (m.peerDependencies['@tanstack/router-core'] = '^1.171.39'),
      m => (m.peerDependencies['@tanstack/router-core'] = '1.171.34'),
      m => delete m.peerDependencies['@tanstack/router-core'],
      m =>
        (m.peerDependenciesMeta = {
          '@tanstack/router-core': { optional: true },
        }),
      m => (m.dependencies['@tanstack/history'] = '1.162.4'),
      m => (m.dependencies['@tanstack/store'] = '^0.9.3'),
      m => delete m.dependencies.isbot,
      m => (m.peerDependencies.octane = '*'),
      m => (m.name = '@tanstack/react-router'),
    ]) {
      const wrong = structuredClone(manifest);
      mutate(wrong);
      assert.throws(() => assertSharedCoreManifest(wrong, candidate));
    }
});

test('the pinned 0.3.6 shared-core patch yields the 0.20.0 candidate manifest', t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'package.json'), upstream('octane-0.20.0'));
  const patch = fs.readFileSync(
    path.join(
      here,
      'octane-0.20.0/@octanejs__tanstack-router@0.3.6.shared-core-peer.patch',
    ),
    'utf8',
  );
  applyExactPatch(
    Buffer.from(patch.slice(0, patch.indexOf('diff --git a/src/'))),
    root,
  );
  const actual = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.deepEqual(actual, manifests['octane-0.20.0']);
  assertSharedCoreManifest(actual, 'octane-0.20.0');
  assert.throws(() => assertSharedCoreManifest(actual));
});

test('pinned candidates reuse their exact reviewed npm identities', () => {
  const current = pinnedAdapterCandidate();
  assert.deepEqual(pinnedAdapterCandidate('octane-0.18.0'), current);
  assert.equal(current.adapter.version, '0.3.4');
  assert.equal(current.octane.version, '0.18.0');
  assert.equal(
    current.source.commit,
    '4c35afcdca0f4889921612fc462e6aabe507d78d',
  );
  const next = pinnedAdapterCandidate('octane-0.20.0');
  const provenance = JSON.parse(
    fs.readFileSync(path.join(here, 'octane-0.20.0/provenance.json')),
  ).upstream;
  assert.equal(next.adapter.version, '0.3.6');
  assert.equal(next.octane.version, '0.20.0');
  assert.equal(next.source.commit, provenance.commit);
  assert.equal(next.source.sha256, provenance.sourceArchive.sha256);
  for (const name of ['octane', '@octanejs/tanstack-router']) {
    const item = name === 'octane' ? next.octane : next.adapter;
    assert.equal(item.integrity, provenance.packages[name].integrity);
    assert.equal(item.url, provenance.packages[name].url);
  }
  for (const candidate of unknown)
    assert.throws(
      () => pinnedAdapterCandidate(candidate),
      /Unknown Octane adapter candidate/,
    );
});

test('the 0.20.0 runtime build locks the same octane tarball the adapter pins', () => {
  const lock = fs.readFileSync(
    path.join(here, 'octane-0.20.0/runtime-build-pnpm-lock.yaml'),
    'utf8',
  );
  const { octane } = pinnedAdapterCandidate('octane-0.20.0');
  assert.equal(lockedIntegrity(lock, 'octane', '0.20.0'), octane.integrity);
  assert.throws(() => lockedIntegrity(lock, 'octane', '0.18.0'));
  const entry = `  octane@0.20.0:\n    resolution: {integrity: ${octane.integrity}}\n`;
  assert.equal(
    lockedIntegrity(
      `packages:\n\n  'octane@0.20.0':\n    resolution: {integrity: ${octane.integrity}}\n`,
      'octane',
      '0.20.0',
    ),
    octane.integrity,
  );
  assert.throws(() =>
    lockedIntegrity(`packages:\n${entry}\n${entry}`, 'octane', '0.20.0'),
  );
});

test('qualifiers reject an unknown candidate before any process or fetch', async t => {
  for (const candidate of unknown) {
    assert.throws(
      () =>
        qualifySharedCorePeer({
          work: '/nonexistent',
          adapterBytes: Buffer.alloc(0),
          coreBytes: Buffer.alloc(0),
          run: neverRun,
          disk: neverRun,
          register: neverRun,
          pnpm: '/nonexistent/pnpm',
          octaneCandidate: candidate,
        }),
      /Unknown Octane adapter candidate/,
    );
    await assert.rejects(
      qualify({
        work: '/nonexistent',
        sourceRoot: '/nonexistent',
        corrected: '/nonexistent',
        here,
        run: neverRun,
        disk: neverRun,
        register: neverRun,
        applyExactPatch: neverRun,
        verifyIntegrity: neverRun,
        assertSameLayout: neverRun,
        octaneCandidate: candidate,
      }),
      /Unknown Octane adapter candidate/,
    );
  }
  // The source tree must be the candidate's octane and adapter release.
  const root = temporary(t);
  const tree = (octane, adapter) => {
    for (const [directory, name, version] of [
      ['packages/octane', 'octane', octane],
      ['packages/tanstack-router', '@octanejs/tanstack-router', adapter],
    ]) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
      fs.writeFileSync(
        path.join(root, directory, 'package.json'),
        JSON.stringify({ name, version }),
      );
    }
  };
  const next = pinnedAdapterCandidate('octane-0.20.0');
  tree('0.20.0', '0.3.6');
  assertCandidateSource(root, next);
  assert.throws(() => assertCandidateSource(root, pinnedAdapterCandidate()));
  tree('0.18.0', '0.3.6');
  assert.throws(() => assertCandidateSource(root, next));
  tree('0.20.0', '0.3.4');
  assert.throws(() => assertCandidateSource(root, next));
  await assert.rejects(
    qualify({
      work: root,
      sourceRoot: root,
      corrected: root,
      here,
      run: neverRun,
      disk: neverRun,
      register: neverRun,
      applyExactPatch: neverRun,
      verifyIntegrity: neverRun,
      assertSameLayout: neverRun,
      octaneCandidate: 'octane-0.20.0',
    }),
    /source @octanejs\/tanstack-router is not 0.3.6/,
  );
});

test('shared-core controls inspect the candidate adapter and exact Core before installing', t => {
  const work = temporary(t);
  const archive = manifest =>
    packFiles(
      new Map([
        [
          'package.json',
          { bytes: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
        ],
      ]),
    );
  const core = archive({ name: '@tanstack/router-core', version: '1.171.39' });
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args[0] === '--version') return '12.21.0\n';
    assert.fail('Install must not start for a rejected tuple');
  };
  const attempt = (manifest, coreBytes, octaneCandidate) =>
    qualifySharedCorePeer({
      work,
      adapterBytes: archive(manifest),
      coreBytes,
      run,
      disk: neverRun,
      register: neverRun,
      pnpm: '/nonexistent/pnpm',
      octaneCandidate,
    });
  assert.throws(() =>
    attempt(manifests['octane-0.18.0'], core, 'octane-0.20.0'),
  );
  assert.throws(() => attempt(manifests['octane-0.20.0'], core));
  assert.throws(() =>
    attempt(
      manifests['octane-0.20.0'],
      archive({ name: '@tanstack/router-core', version: '1.171.34' }),
      'octane-0.20.0',
    ),
  );
  assert(calls.every(args => args[0] === '--version'));
  assert.equal(fs.readdirSync(work).length, 0);
  // Lookup without exports maps walks up to the operation-owned links.
  fs.mkdirSync(path.join(work, 'node_modules/octane'), { recursive: true });
  fs.writeFileSync(path.join(work, 'node_modules/octane/package.json'), '{}');
  fs.mkdirSync(path.join(work, 'packages/adapter'), { recursive: true });
  assert.equal(
    installedPackage(path.join(work, 'packages/adapter'), 'octane'),
    fs.realpathSync(path.join(work, 'node_modules/octane')),
  );
  assert.throws(() =>
    installedPackage(
      path.join(work, 'packages/adapter'),
      'octane-missing-for-test',
    ),
  );
});
