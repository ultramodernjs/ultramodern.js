import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const YAML = require('yaml');
const { resolvePackage } = require(path.join(here, 'resolve-package.cjs'));
const temporary = process.env.OWNED_TEMP_DIR;
assert(
  temporary,
  'Run with owned-temp-dir --run websocket-corrections -- node scripts/ultramodern-dependencies/websocket-corrections/qualify.mjs',
);
const pnpm =
  process.env.PNPM_BINARY ||
  '/Users/satan/.local/share/mise/installs/pnpm/12.21.0/pnpm';
const guardian = '/Users/satan/bin/disk-guardian-artifacts';
const owner = `websocket-corrections-${process.pid}`;
const artifacts = [];
function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: 'true', TMPDIR: temporary },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error || (!allowFailure && result.status !== 0))
    throw new Error(`${command} ${args.join(' ')}: ${result.error || output}`);
  return { status: result.status, output };
}
function documents(file) {
  return YAML.parseAllDocuments(fs.readFileSync(file, 'utf8')).map(d => {
    assert.equal(d.errors.length, 0);
    return d.toJSON();
  });
}
function register(directory) {
  fs.mkdirSync(directory, { recursive: true });
  run(
    guardian,
    [
      'register',
      directory,
      '--owner',
      owner,
      '--owner-pid',
      String(process.pid),
      '--kind',
      'dependencies',
    ],
    temporary,
  );
  artifacts.push(directory);
}
const original7 = 'ws@>=7.0.0 <7.5.11';
const original8 = 'ws@>=8.0.0 <8.21.3';
const runtimeOnly = Object.fromEntries(
  ['prod', 'optional'].flatMap(type => [
    [`ws@>=7.0.0 <7.5.11:${type}`, '7.5.11'],
    [`ws@>=8.0.0 <8.23.0:${type}`, '8.23.0'],
  ]),
);
const corrected = {
  [original7]: '7.5.11',
  'ws@>=8.0.0 <8.23.0': '8.23.0',
  'isomorphic-ws@5.0.0>ws:peer': '*',
};
const receipt = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  pnpm: run(pnpm, ['--version'], temporary).output.trim(),
  policies: { corrected },
  evidenceLimits:
    'Installed selection and runtime qualification; registry metadata only. No fresh package-byte SRI or signature authentication is claimed. historical-proposal.patch records the already-integrated proposal, not a rerun step.',
  repository: {},
  cases: [],
};
assert.equal(receipt.pnpm, '12.21.0');
const rootDocs = documents(path.join(repo, 'pnpm-lock.yaml'));
const rootPolicy = YAML.parse(
  fs.readFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'utf8'),
).overrides;
for (const [selector, value] of Object.entries(corrected))
  assert.equal(
    rootPolicy[selector],
    value,
    'Installed repository must use the audited policy',
  );
assert.equal(rootPolicy[original8], undefined, 'Stale cutoff must not remain');
receipt.repository.rootWsPolicy = Object.fromEntries(
  Object.entries(rootPolicy).filter(
    ([key]) => key.startsWith('ws@') || key === 'isomorphic-ws@5.0.0>ws:peer',
  ),
);
receipt.repository.generatorWsPolicy = fs
  .readFileSync(
    path.join(
      repo,
      'packages/toolkit/ultramodern-create/src/ultramodern-workspace/policy.ts',
    ),
    'utf8',
  )
  .split('\n')
  .filter(line => /['"]ws@/.test(line));
receipt.repository.lockDocuments = rootDocs.length;
receipt.repository.wsConsumers = rootDocs.flatMap(d =>
  Object.entries(d.snapshots || {}).flatMap(([name, snapshot]) =>
    ['dependencies', 'optionalDependencies'].flatMap(group =>
      snapshot[group]?.ws ? [{ name, group, ws: snapshot[group].ws }] : [],
    ),
  ),
);
receipt.repository.isomorphicPeers = rootDocs.flatMap(d =>
  Object.entries(d.packages || {})
    .filter(([name]) => name.startsWith('isomorphic-ws@'))
    .map(([name, value]) => ({
      name,
      peerDependencies: value.peerDependencies,
    })),
);
assert(receipt.repository.wsConsumers.length > 0);
assert(receipt.repository.wsConsumers.every(edge => edge.ws.startsWith('8.')));
const metadata = await (
  await fetch('https://registry.npmjs.org/isomorphic-ws/5.0.0', {
    signal: AbortSignal.timeout(30000),
  })
).json();
assert.equal(metadata.peerDependencies.ws, '*');
receipt.publishedIsomorphic = {
  version: metadata.version,
  peerDependencies: metadata.peerDependencies,
  integrity: metadata.dist.integrity,
};
const latest = await (
  await fetch('https://registry.npmjs.org/ws/latest', {
    signal: AbortSignal.timeout(30000),
  })
).json();
assert.equal(
  latest.version,
  '8.23.0',
  'Refresh the explicit qualification pin when latest changes',
);
const sidecar = await (
  await fetch('https://registry.npmjs.org/@bleedingdev%2fmf-dts-plugin/2.9.5', {
    signal: AbortSignal.timeout(30000),
  })
).json();
assert.equal(sidecar.dependencies.ws, '8.21.3');
assert.equal(sidecar.dependencies['isomorphic-ws'], '5.0.0');
receipt.sidecarMetadata = {
  name: sidecar.name,
  version: sidecar.version,
  ws: sidecar.dependencies.ws,
  isomorphicWs: sidecar.dependencies['isomorphic-ws'],
  integrity: sidecar.dist.integrity,
  note: 'Registry metadata check only; signature verification belongs to the parent acceptance record',
};
const example = 'examples/mcp-apps-todo';
const exampleRequire = createRequire(path.join(repo, example, 'package.json'));
const enhanced = resolvePackage(exampleRequire, '@module-federation/enhanced');
const installedOwner = resolvePackage(
  enhanced.require,
  '@module-federation/dts-plugin',
);
const installedIso = resolvePackage(installedOwner.require, 'isomorphic-ws');
const installedWs = resolvePackage(installedIso.require, 'ws');
assert.equal(installedOwner.manifest.name, sidecar.name);
assert.equal(installedOwner.manifest.version, sidecar.version);
assert.equal(installedIso.manifest.name, metadata.name);
assert.equal(installedIso.manifest.version, metadata.version);
assert.equal(
  installedIso.manifest.peerDependencies.ws,
  metadata.peerDependencies.ws,
);
assert.equal(installedWs.manifest.name, 'ws');
assert.equal(installedOwner.manifest.dependencies.ws, sidecar.dependencies.ws);
assert.equal(
  installedOwner.manifest.dependencies['isomorphic-ws'],
  sidecar.dependencies['isomorphic-ws'],
);
const snapshots = Object.assign(
  {},
  ...rootDocs.map(document => document.snapshots || {}),
);
const importer = rootDocs
  .map(document => document.importers?.[example])
  .find(Boolean);
assert(importer, 'Example importer must exist in current lock');
const enhancedReference =
  importer.dependencies['@module-federation/enhanced'].version;
assert(
  enhancedReference.startsWith(
    enhanced.manifest.name + '@' + enhanced.manifest.version + '(',
  ),
);
const ownerReference =
  snapshots[enhancedReference].dependencies['@module-federation/dts-plugin'];
assert(
  ownerReference.startsWith(
    installedOwner.manifest.name + '@' + installedOwner.manifest.version + '(',
  ),
);
const ownerSnapshot = snapshots[ownerReference];
const isoReference = ownerSnapshot.dependencies['isomorphic-ws'];
assert(isoReference.startsWith(metadata.version + '('));
const isoSnapshot = snapshots['isomorphic-ws@' + isoReference];
const auditedWs = corrected['ws@>=8.0.0 <8.23.0'];
const wsReference = ownerSnapshot.dependencies.ws;
assert(wsReference === auditedWs || wsReference.startsWith(auditedWs + '('));
assert.equal(
  isoSnapshot.dependencies.ws,
  wsReference,
  'Owner and wrapper must select the same locked ws',
);
assert(snapshots['ws@' + wsReference], 'Selected ws snapshot must exist');
assert.equal(
  installedWs.manifest.version,
  auditedWs,
  'Actual selected version must equal audited policy and current lock',
);
assert.equal(
  resolvePackage(installedOwner.require, 'ws').entry,
  installedWs.entry,
);
for (const edge of receipt.repository.wsConsumers)
  assert(
    edge.ws === auditedWs || edge.ws.startsWith(auditedWs + '('),
    'Every current ws runtime edge must meet the audited pin',
  );
assert(
  receipt.repository.isomorphicPeers.every(
    record => record.peerDependencies.ws === '*',
  ),
);
receipt.repository.installedIsomorphic = {
  resolutionChain: [enhanced, installedOwner, installedIso, installedWs].map(
    ({ entry, manifest }) => ({
      entry,
      name: manifest.name,
      version: manifest.version,
    }),
  ),
  lockChain: { enhancedReference, ownerReference, isoReference, wsReference },
  peerDependencies: installedIso.manifest.peerDependencies,
  ws: installedWs.manifest.version,
  identityEvidence:
    'Public-entry resolution, installed manifests and current lock/policy agreement only; registry metadata is not tarball SRI or provenance verification',
  runtime: JSON.parse(
    run(
      process.execPath,
      [path.join(here, 'runtime.cjs'), installedOwner.directory],
      repo,
    ).output,
  ),
};
receipt.latestWs = {
  version: latest.version,
  integrity: latest.dist.integrity,
};
const store = run(pnpm, ['config', 'get', 'store-dir'], repo).output.trim();
assert(
  path.isAbsolute(store) &&
    !store.startsWith(repo) &&
    !store.startsWith(temporary),
  'Use the existing external shared store',
);
receipt.store = store;
try {
  for (const [
    name,
    overrides,
    strict,
    expectedStatus,
    expectedPeer,
    rootGroup = 'dependencies',
    incompatiblePeer = false,
  ] of [
    [
      'original-warning',
      { [original7]: '7.5.11', [original8]: '8.23.0' },
      false,
      0,
      '7.5.11',
    ],
    [
      'original-strict-control',
      { [original7]: '7.5.11', [original8]: '8.23.0' },
      true,
      1,
      null,
    ],
    [
      'cutoff-only-negative-control',
      { [original7]: '7.5.11', 'ws@>=8.0.0 <8.23.0': '8.23.0' },
      true,
      1,
      null,
    ],
    ['runtime-only-production-and-optional', runtimeOnly, true, 0, '*'],
    [
      'runtime-only-dev-security-negative-control',
      runtimeOnly,
      true,
      0,
      '*',
      'devDependencies',
    ],
    ['restore-published-peer-all-runtime-groups', corrected, true, 0, '*'],
    [
      'restored-peer-root-dev-dependency',
      corrected,
      true,
      0,
      '*',
      'devDependencies',
    ],
    [
      'generator-current-narrows-peer',
      { 'ws@>=8.0.0 <8.23.0': '8.23.0' },
      true,
      0,
      '8.23.0',
    ],
    [
      'generator-restores-published-peer',
      { 'ws@>=8.0.0 <8.23.0': '8.23.0', 'isomorphic-ws@5.0.0>ws:peer': '*' },
      true,
      0,
      '*',
    ],
    [
      'real-incompatible-peer-negative-control',
      corrected,
      true,
      1,
      null,
      'dependencies',
      true,
    ],
  ]) {
    const directory = path.join(temporary, name);
    fs.mkdirSync(directory);
    const write = (file, value) =>
      fs.writeFileSync(
        path.join(directory, file),
        JSON.stringify(value, null, 2),
      );
    const manifest = {
      name,
      private: true,
      dependencies: {
        'isomorphic-ws': '5.0.0',
        'probe-seven': 'file:./seven',
        'probe-eight': 'file:./eight',
        'probe-optional': 'file:./optional',
      },
    };
    if (name.startsWith('generator-'))
      delete manifest.dependencies['probe-seven'];
    if (incompatiblePeer)
      manifest.dependencies['probe-real-peer-seven'] = 'file:./real-peer-seven';
    manifest[rootGroup] = { ...manifest[rootGroup], ws: '8.21.3' };
    write('package.json', manifest);
    for (const [local, manifest] of [
      ['seven', { dependencies: { ws: '7.5.0' } }],
      ['eight', { dependencies: { ws: '8.22.0' } }],
      ['optional', { optionalDependencies: { ws: '8.22.0' } }],
      ['real-peer-seven', { peerDependencies: { ws: '^7.5.11' } }],
    ]) {
      fs.mkdirSync(path.join(directory, local));
      write(`${local}/package.json`, {
        name: `probe-${local}`,
        version: '1.0.0',
        ...manifest,
      });
    }
    fs.writeFileSync(
      path.join(directory, 'pnpm-workspace.yaml'),
      YAML.stringify({
        packages: ['.'],
        overrides,
        autoInstallPeers: false,
        strictPeerDependencies: strict,
        packageImportMethod: 'clone-or-copy',
        storeDir: store,
      }),
    );
    register(path.join(directory, 'node_modules'));
    const result = run(
      pnpm,
      [
        'install',
        '--ignore-scripts',
        '--no-frozen-lockfile',
        '--reporter=append-only',
      ],
      directory,
      true,
    );
    console.log(`CASE ${name}: ${result.status}\n${result.output}`);
    assert.equal(result.status, expectedStatus, name);
    const record = {
      name,
      rootGroup,
      overrides,
      strictPeerDependencies: strict,
      status: result.status,
      output: result.output,
    };
    if (expectedStatus === 1) {
      assert.match(result.output, /ERR_PNPM_PEER_DEP_ISSUES/);
      if (incompatiblePeer) {
        assert.match(result.output, /probe-real-peer-seven/);
        assert.doesNotMatch(result.output, /isomorphic-ws@5\.0\.0/);
      }
    } else {
      const docs = documents(path.join(directory, 'pnpm-lock.yaml'));
      const iso = docs
        .flatMap(d => Object.entries(d.packages || {}))
        .find(([key]) => key === 'isomorphic-ws@5.0.0')[1];
      assert.equal(iso.peerDependencies.ws, expectedPeer);
      record.peer = iso.peerDependencies.ws;
      const localRequire = createRequire(path.join(directory, 'package.json'));
      record.peerCheck = run(pnpm, ['peers', 'check'], directory, true);
      if (expectedPeer === '*') assert.equal(record.peerCheck.status, 0);
      record.rootWs = localRequire('ws/package.json').version;
      record.installedIsomorphicPeer = localRequire(
        'isomorphic-ws/package.json',
      ).peerDependencies.ws;
      assert.equal(record.installedIsomorphicPeer, '*');
      record.runtimeEdges = docs
        .flatMap(d => Object.entries(d.snapshots || {}))
        .flatMap(([key, snapshot]) =>
          ['dependencies', 'optionalDependencies'].flatMap(group =>
            snapshot[group]?.ws
              ? [{ name: key, group, ws: snapshot[group].ws }]
              : [],
          ),
        );
      if (name === 'original-warning') {
        console.log(record.peerCheck.output);
        assert.match(record.peerCheck.output, /7\.5\.11/);
        assert.match(record.peerCheck.output, /8\.21\.3/);
        assert.equal(record.rootWs, '8.21.3');
        assert(record.runtimeEdges.some(edge => edge.ws === '8.22.0'));
      } else {
        assert.equal(
          record.rootWs,
          name === 'runtime-only-dev-security-negative-control'
            ? '8.21.3'
            : '8.23.0',
        );
        if (name === 'runtime-only-dev-security-negative-control')
          record.rejectedAlternative =
            'Typed prod/optional overrides leave a direct devDependency below the security floor';
        if (!name.startsWith('generator-'))
          assert(
            record.runtimeEdges.some(
              edge => edge.name.includes('probe-seven') && edge.ws === '7.5.11',
            ),
          );
        assert(
          record.runtimeEdges.some(
            edge =>
              edge.name.includes('probe-optional') &&
              edge.group === 'optionalDependencies' &&
              edge.ws === '8.23.0',
          ),
        );
        assert(
          record.runtimeEdges
            .filter(edge => !edge.name.includes('probe-seven'))
            .every(
              edge =>
                edge.ws ===
                (edge.name.startsWith('isomorphic-ws@')
                  ? record.rootWs
                  : '8.23.0'),
            ),
        );
        if (record.rootWs === '8.23.0')
          record.runtime = JSON.parse(
            run(
              process.execPath,
              [path.join(here, 'runtime.cjs'), directory],
              directory,
            ).output,
          );
      }
    }
    receipt.cases.push(record);
  }
  fs.writeFileSync(
    path.join(here, 'proof.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(
    'PASS: negative controls, truthful wildcard peer, both protected runtime majors, latest wrapper send/ping/close',
  );
} finally {
  // Release every lease before attempting cleanup: shared guardian maintenance
  // can temporarily hold its global lock. owned-temp-dir still owns the outer
  // directory and removes it in its own finally, including on interruption.
  for (const directory of artifacts.toReversed()) {
    run(guardian, ['release', directory, '--owner', owner], temporary);
  }
  for (const directory of artifacts.toReversed()) {
    const cleanup = run(
      guardian,
      ['cleanup', '--only', directory, '--no-caches', '--apply'],
      temporary,
      true,
    );
    if (cleanup.status !== 0) {
      assert.match(
        cleanup.output,
        /maintenance-pass\.lock is busy/,
        cleanup.output,
      );
      console.error(
        'Cleanup delegated to enclosing owned-temp-dir: ' +
          cleanup.output.trim(),
      );
      break;
    }
  }
}
