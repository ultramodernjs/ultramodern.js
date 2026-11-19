import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const temporary = t => {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'adapter-candidate-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
// JSON string preserves the exact 0.3.6 npm package.json bytes.
const upstream = JSON.parse(
  fs.readFileSync(
    path.join(here, 'octane-0.20.0/upstream-adapter-package.json'),
  ),
);
const manifest = sharedCoreManifest(JSON.parse(upstream));
const neverRun = () => assert.fail('No process may start');
const archive = value =>
  packFiles(
    new Map([
      [
        'package.json',
        { bytes: Buffer.from(JSON.stringify(value)), mode: 0o644 },
      ],
    ]),
  );

test('the shared-core manifest binds adapter 0.3.6 to octane ^0.20.0 only', () => {
  assert.equal(manifest.version, '0.3.6');
  assertSharedCoreManifest(manifest);
  // Neither half of the tuple may drift independently.
  for (const mutate of [
    m => (m.peerDependencies.octane = '^0.18.0'),
    m => (m.version = '0.3.4'),
    m => (m.version = '0.3.5'),
    m => {
      m.version = '0.3.4';
      m.peerDependencies.octane = '^0.18.0';
    },
  ]) {
    const wrong = structuredClone(manifest);
    mutate(wrong);
    assert.throws(() => assertSharedCoreManifest(wrong));
  }
});

test('the adapter requires exact shared Core and every independent dependency', () => {
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
    m => (m.dependencies.isbot = '^5.1.21'),
    m => delete m.dependencies.isbot,
    m => (m.peerDependencies.octane = '*'),
    m => (m.name = '@tanstack/react-router'),
  ]) {
    const wrong = structuredClone(manifest);
    mutate(wrong);
    assert.throws(() => assertSharedCoreManifest(wrong));
  }
});

test('the pinned 0.3.6 shared-core patch yields the 0.20.0 candidate manifest', t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'package.json'), upstream);
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
  assert.deepEqual(actual, manifest);
  assertSharedCoreManifest(actual);
});

test('the adapter pins only the reviewed 0.20.0 source and npm identities', () => {
  const pinned = pinnedAdapterCandidate();
  assert.equal(
    pinned.source.commit,
    '1cdd9d2027bef63e6cec601952795e9ed84e1344',
  );
  const provenance = JSON.parse(
    fs.readFileSync(path.join(here, 'octane-0.20.0/provenance.json')),
  ).upstream;
  assert.equal(pinned.adapter.version, '0.3.6');
  assert.equal(pinned.octane.version, '0.20.0');
  assert.equal(pinned.source.commit, provenance.commit);
  assert.equal(pinned.source.sha256, provenance.sourceArchive.sha256);
  assert.equal(pinned.source.url, provenance.sourceArchive.url);
  for (const name of ['octane', '@octanejs/tanstack-router']) {
    const item = name === 'octane' ? pinned.octane : pinned.adapter;
    assert.equal(item.integrity, provenance.packages[name].integrity);
    assert.equal(item.url, provenance.packages[name].url);
  }
});

test('the 0.20.0 runtime build locks the same octane tarball the adapter pins', () => {
  const lock = fs.readFileSync(
    path.join(here, 'octane-0.20.0/runtime-build-pnpm-lock.yaml'),
    'utf8',
  );
  const { octane } = pinnedAdapterCandidate();
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

test('the qualifier rejects old or mixed source releases before any process or fetch', async t => {
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
  const pinned = pinnedAdapterCandidate();
  tree('0.20.0', '0.3.6');
  assertCandidateSource(root, pinned);
  for (const [octane, adapter] of [
    ['0.18.0', '0.3.4'],
    ['0.18.0', '0.3.6'],
    ['0.20.0', '0.3.4'],
  ]) {
    tree(octane, adapter);
    assert.throws(() => assertCandidateSource(root, pinned));
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
      }),
      /source .* is not /,
    );
  }
});

test('shared-core controls reject old adapters and wrong Core before installing', t => {
  const work = temporary(t);
  const core = archive({ name: '@tanstack/router-core', version: '1.171.39' });
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args[0] === '--version') return '12.21.0\n';
    assert.fail('Install must not start for a rejected tuple');
  };
  const attempt = (value, coreBytes) =>
    qualifySharedCorePeer({
      work,
      adapterBytes: archive(value),
      coreBytes,
      run,
      disk: neverRun,
      register: neverRun,
      pnpm: '/nonexistent/pnpm',
    });
  assert.throws(() => attempt({ ...manifest, version: '0.3.4' }, core));
  assert.throws(() =>
    attempt(
      manifest,
      archive({ name: '@tanstack/router-core', version: '1.171.34' }),
    ),
  );
  assert.throws(() =>
    attempt(
      manifest,
      archive({ name: '@tanstack/react-router', version: '1.171.39' }),
    ),
  );
  assert(calls.every(args => args[0] === '--version'));
  assert.equal(fs.readdirSync(work).length, 0);
});

test('the 0.20.0 shared-core install enforces strict peers without dependency overrides', t => {
  const work = temporary(t);
  const stopped = new Error('Stop before any real install');
  let installs = 0;
  assert.throws(
    () =>
      qualifySharedCorePeer({
        work,
        adapterBytes: archive(manifest),
        coreBytes: archive({
          name: '@tanstack/router-core',
          version: '1.171.39',
        }),
        pnpm: '/nonexistent/pnpm',
        disk: () => {},
        register: () => {},
        run: (command, args, root) => {
          assert.equal(command, '/nonexistent/pnpm');
          if (args[0] === '--version') return '12.21.0\n';
          installs++;
          assert.equal(args[0], 'install');
          assert(args.includes('--strict-peer-dependencies'));
          assert(args.includes('--ignore-scripts'));
          assert(
            args.includes('--config.manage-package-manager-versions=false'),
          );
          assert.deepEqual(
            JSON.parse(fs.readFileSync(path.join(root, 'package.json'))),
            {
              private: true,
              dependencies: {
                '@octanejs/tanstack-router': 'file:./adapter.tgz',
                '@tanstack/router-core': 'file:./core.tgz',
                octane: '0.20.0',
              },
            },
          );
          assert.equal(
            fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
            'packages: []\npackageImportMethod: clone-or-copy\nautoInstallPeers: false\n',
          );
          throw stopped;
        },
      }),
    error => error === stopped,
  );
  assert.equal(installs, 1);
});

test('dependency lookup resolves only operation-owned installations without exports maps', t => {
  const work = temporary(t);
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
