// The one advisory this repository corrects in place instead of waiving.
//
// GHSA-fc5q-39xc-vjpf has no patched picomatch release. The repository patches
// the exact installed versions, so `pnpm audit` still names them. The advisory
// gate acknowledges the finding only when this module proves, against the
// physical repository checkout, that every installed picomatch@2.3.2 and
// picomatch@4.0.7 is byte-identical to the pinned registry tarball with the
// canonical repository patch applied at zero fuzz. advisory-exceptions.json
// can never acknowledge it, and release contexts never enable this module.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const inventoryPath =
  'packages/toolkit/ultramodern-create/src/ultramodern-workspace/patch-inventory.ts';
const exceptionsPath = 'scripts/security/advisory-exceptions.json';

const version = (number, integrity, patchSha256) =>
  Object.freeze({
    version: number,
    tarball: `https://registry.npmjs.org/picomatch/-/picomatch-${number}.tgz`,
    integrity,
    patchPath: `patches/picomatch@${number}.patch`,
    patchSha256,
  });

export const picomatchCorrection = Object.freeze({
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  correction: 'repository-picomatch-extglob-correction',
  owner: 'bleedingdev',
  reason:
    'No picomatch release fixes the single-branch repeated extglob advisory; the repository installs canonically patched 2.3.2 and 4.0.7.',
  remediation:
    'Delete this correction, both patches and their inventory entries once a fixed picomatch release is adopted in each major.',
  expires: '2027-02-17',
  parents: Object.freeze(
    [
      '@bleedingdev/micromatch',
      '@changesets/config',
      '@changesets/git',
      '@parcel/watcher',
      '@rollup/pluginutils',
      '@vercel/nft',
      'anymatch',
      'fdir',
      'jest-message-util',
      'jest-util',
      'micromatch',
      'readdirp',
      'tinyglobby',
      'vite',
    ].sort(),
  ),
  versions: Object.freeze([
    version(
      '2.3.2',
      'sha512-V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==',
      '1b702d20ae6bcdcbe35e484772e3ceecae5f9b004cd4be2e1bd40b5172e9afc2',
    ),
    version(
      '4.0.7',
      'sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==',
      'ec7809bedc98f3bdcfd79f9ae4a21a7c74915cf40e70ef640437cb6ffed17960',
    ),
  ]),
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sha512Integrity = bytes =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** Refuses an expired correction and any version whose patch digest is not recorded. */
export function assertCorrectionCurrent(
  correction = picomatchCorrection,
  now = new Date(),
) {
  assert.ok(Number.isFinite(now.getTime()), 'correction time is invalid');
  assert.ok(
    now.toISOString().slice(0, 10) <= correction.expires,
    `${correction.correction} expired ${correction.expires}`,
  );
  for (const entry of correction.versions)
    assert.match(
      String(entry.patchSha256),
      /^[a-f0-9]{64}$/u,
      `${correction.package}@${entry.version} canonical patch digest is not recorded; ${correction.id} stays unacknowledged`,
    );
}

/**
 * Reads repository files once, through physical paths only, and keeps their
 * bytes so later steps use exactly what was checked.
 */
export function captureCorrectionSourceFiles(root, relativePaths) {
  const identity = stat =>
    ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key =>
      String(stat[key]),
    );
  const inspect = relativePath => {
    assert.ok(
      !path.isAbsolute(relativePath) &&
        !relativePath.split(/[\\/]/u).includes('..'),
      'correction source path must stay inside the repository',
    );
    const file = path.join(root, relativePath);
    assert.equal(
      fs.realpathSync(file),
      file,
      `correction source must be physical: ${relativePath}`,
    );
    const before = fs.lstatSync(file, { bigint: true });
    assert.ok(
      before.isFile(),
      `correction source must be a regular file: ${relativePath}`,
    );
    const descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    let bytes;
    try {
      assert.deepEqual(
        identity(fs.fstatSync(descriptor, { bigint: true })),
        identity(before),
        `correction source changed while opening: ${relativePath}`,
      );
      bytes = fs.readFileSync(descriptor);
      assert.deepEqual(
        identity(fs.fstatSync(descriptor, { bigint: true })),
        identity(before),
        `correction source changed while reading: ${relativePath}`,
      );
    } finally {
      fs.closeSync(descriptor);
    }
    assert.deepEqual(
      identity(fs.lstatSync(file, { bigint: true })),
      identity(before),
      `correction source changed while reading: ${relativePath}`,
    );
    return {
      path: relativePath,
      sha256: sha256(bytes),
      identity: identity(before),
      bytes,
    };
  };
  const withoutBytes = ({ bytes: _bytes, ...entry }) => entry;
  const captured = [...new Set(relativePaths)].sort().map(inspect);
  const files = captured.map(withoutBytes);
  const bytes = new Map(captured.map(entry => [entry.path, entry.bytes]));
  return {
    files,
    bytes(relativePath) {
      assert.ok(bytes.has(relativePath), `uncaptured source ${relativePath}`);
      return bytes.get(relativePath);
    },
    assertUnchanged() {
      assert.deepEqual(
        files.map(entry => withoutBytes(inspect(entry.path))),
        files,
        'correction source identity drift',
      );
    },
  };
}

/** Requires every finding to be an exact corrected version reached through a recorded parent. */
export function assertCorrectionFindings(
  advisory,
  correction = picomatchCorrection,
) {
  assert.equal(
    advisory?.github_advisory_id,
    correction.id,
    'correction advisory',
  );
  assert.equal(advisory.module_name, correction.package, 'correction package');
  assert.ok(
    Array.isArray(advisory.findings) && advisory.findings.length > 0,
    'correction requires nonempty findings',
  );
  const versions = new Set(correction.versions.map(entry => entry.version));
  const paths = [];
  for (const finding of advisory.findings) {
    assert.ok(
      versions.has(finding?.version),
      `correction finding version ${finding?.version}`,
    );
    assert.ok(
      Array.isArray(finding.paths) && finding.paths.length > 0,
      'correction requires nonempty finding paths',
    );
    for (const dependencyPath of finding.paths) {
      assert.equal(typeof dependencyPath, 'string', 'correction path');
      const chain = dependencyPath.split('>');
      assert.ok(
        chain.length >= 2 &&
          chain.every(part => part.length > 0) &&
          chain.at(-1) === correction.package &&
          correction.parents.includes(chain.at(-2)),
        `correction finding parent: ${dependencyPath}`,
      );
      paths.push(dependencyPath);
    }
  }
  return {
    versions: [...new Set(advisory.findings.map(f => f.version))].sort(),
    paths: [...new Set(paths)].sort(),
  };
}

/** The inventory must hold exactly one repository-only entry per corrected version. */
export function assertCorrectionInventory(
  inventory,
  correction = picomatchCorrection,
) {
  assert.ok(Array.isArray(inventory), 'patch inventory must be an array');
  const entries = inventory
    .filter(entry => entry?.packageName === correction.package)
    .sort((a, b) => String(a.version).localeCompare(String(b.version)));
  assert.deepEqual(
    entries.map(entry => entry.version),
    correction.versions.map(entry => entry.version),
    `${correction.package} inventory versions`,
  );
  entries.forEach((entry, index) => {
    const expected = correction.versions[index];
    assert.deepEqual(
      Object.keys(entry).sort(),
      [
        'packageName',
        'path',
        'reason',
        'repository',
        'sha256',
        'version',
        'workspace',
      ],
      `${correction.package}@${expected.version} inventory fields`,
    );
    assert.equal(entry.path, expected.patchPath);
    assert.equal(entry.sha256, expected.patchSha256);
    assert.equal(entry.repository, true, 'correction patch is repository-only');
    assert.equal(entry.workspace, null, 'generated workspaces stay patch-free');
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.trim().length > 0,
      `${correction.package}@${expected.version} inventory reason`,
    );
  });
}

function payloadFiles(directory) {
  const files = new Map();
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const entry = path.join(current, name);
      const stat = fs.lstatSync(entry);
      assert.ok(!stat.isSymbolicLink(), `reference symlink: ${entry}`);
      if (stat.isDirectory()) visit(entry);
      else {
        assert.ok(stat.isFile(), `reference non-file: ${entry}`);
        files.set(
          path.relative(directory, entry).split(path.sep).join('/'),
          fs.readFileSync(entry),
        );
      }
    }
  }
  visit(directory);
  return files;
}

/**
 * Builds the expected installed payload: the authenticated registry archive
 * with the canonical patch applied exactly (no fuzz, no offset), leaving the
 * npm manifest byte-for-byte untouched.
 */
export function buildPatchedReference({
  archive,
  integrity,
  packageName,
  version: expectedVersion,
  patch,
}) {
  assert.equal(
    sha512Integrity(archive),
    integrity,
    `${packageName}@${expectedVersion} registry archive integrity`,
  );
  const scratch = fs.mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'ultramodern-correction-reference-',
    ),
  );
  const cleanup = () => fs.rmSync(scratch, { recursive: true, force: true });
  const terminate = signal => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const interrupt = () => terminate('SIGINT');
  const stop = () => terminate('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', stop);
  try {
    const tarball = path.join(scratch, 'upstream.tgz');
    const extracted = path.join(scratch, 'extracted');
    fs.writeFileSync(tarball, archive);
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xzf', tarball, '-C', extracted], { stdio: 'pipe' });
    assert.deepEqual(
      fs.readdirSync(extracted),
      ['package'],
      'registry archive must contain only package/',
    );
    const packageRoot = path.join(extracted, 'package');
    const manifestBytes = fs.readFileSync(
      path.join(packageRoot, 'package.json'),
    );
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.name, packageName, 'registry archive name');
    assert.equal(manifest.version, expectedVersion, 'registry archive version');
    const applied = spawnSync(
      'patch',
      [
        '-p1',
        '-E',
        '--fuzz=0',
        '--batch',
        '--no-backup-if-mismatch',
        '--verbose',
      ],
      { cwd: packageRoot, input: patch, encoding: 'utf8' },
    );
    const output = `${applied.stdout ?? ''}${applied.stderr ?? ''}`;
    assert.ok(
      applied.status === 0 && !applied.error,
      `${packageName}@${expectedVersion} canonical patch does not apply:\n${output}${applied.error?.message ?? ''}`,
    );
    // Verbose GNU and BSD patch report each hunk; any offset or fuzz suffix fails.
    const hunks = output.split('\n').filter(line => line.startsWith('Hunk #'));
    assert.ok(
      hunks.length > 0 &&
        hunks.every(line => /^Hunk #\d+ succeeded at \d+\.$/u.test(line)),
      `${packageName}@${expectedVersion} canonical patch must apply exactly:\n${hunks.join('\n')}`,
    );
    assert.ok(
      fs
        .readFileSync(path.join(packageRoot, 'package.json'))
        .equals(manifestBytes),
      `${packageName}@${expectedVersion} reference must preserve its npm manifest`,
    );
    return payloadFiles(packageRoot);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', stop);
    cleanup();
  }
}

async function fetchArchive(tarball) {
  const response = await fetch(tarball, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `${tarball} fetch failed: ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 1024 * 1024, `${tarball} exceeds its size bound`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Proves the correction against the physical repository and returns a guard
 * the gate re-runs after `pnpm audit` so the audited lockfile and installed
 * bytes are the ones that were proven.
 */
export async function prepareRepositoryCorrection({ cwd, now = new Date() }) {
  const correction = picomatchCorrection;
  const root = fs.realpathSync(repositoryRoot);
  assert.equal(
    fs.realpathSync(cwd),
    root,
    'repository correction is restricted to its physical repository',
  );
  assertCorrectionCurrent(correction, now);
  const source = captureCorrectionSourceFiles(root, [
    exceptionsPath,
    'scripts/security/advisory-gate.mjs',
    'scripts/security/repository-correction.mjs',
    'scripts/security/installed-correction-graph.mjs',
    inventoryPath,
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    ...correction.versions.map(entry => entry.patchPath),
  ]);
  const policy = JSON.parse(source.bytes(exceptionsPath));
  assert.ok(
    Array.isArray(policy) && !policy.some(entry => entry?.id === correction.id),
    `${correction.id} cannot be waived by an advisory exception`,
  );
  // Evaluate the captured inventory bytes, not whatever the path holds later.
  const { default: inventory } = await import(
    `data:text/javascript;base64,${source.bytes(inventoryPath).toString('base64')}`
  );
  assertCorrectionInventory(inventory, correction);
  const versions = {};
  const pinned = [];
  for (const entry of correction.versions) {
    const patch = source.bytes(entry.patchPath);
    assert.equal(
      sha256(patch),
      entry.patchSha256,
      `${correction.package}@${entry.version} canonical patch integrity`,
    );
    versions[entry.version] = {
      expectedIntegrity: entry.integrity,
      patchSha256: entry.patchSha256,
      referenceFiles: buildPatchedReference({
        archive: await fetchArchive(entry.tarball),
        integrity: entry.integrity,
        packageName: correction.package,
        version: entry.version,
        patch,
      }),
    };
    pinned.push({
      version: entry.version,
      tarball: entry.tarball,
      upstreamIntegrity: entry.integrity,
      patchPath: entry.patchPath,
      patchSha256: entry.patchSha256,
    });
  }
  const { inspectInstalledCorrectionGraph } = await import(
    './installed-correction-graph.mjs'
  );
  const graph = inspectInstalledCorrectionGraph({
    root,
    packageName: correction.package,
    versions,
  });
  const provenVersions = [
    ...new Set(graph.targets.map(target => target.version)),
  ].sort();
  const proof = {
    schemaVersion: 2,
    correction: correction.correction,
    id: correction.id,
    package: correction.package,
    owner: correction.owner,
    reason: correction.reason,
    remediation: correction.remediation,
    expires: correction.expires,
    parents: correction.parents,
    versions: pinned,
    sourceFiles: source.files,
    targets: graph.targets,
    identities: graph.identities,
    installedFiles: graph.digests,
  };
  const proofSha256 = sha256(JSON.stringify(proof));
  const assertUnchanged = () => {
    assertCorrectionCurrent(correction);
    source.assertUnchanged();
    graph.assertUnchanged();
    assert.equal(
      sha256(JSON.stringify(proof)),
      proofSha256,
      'correction proof drift',
    );
  };
  assertUnchanged();
  return {
    id: correction.id,
    proof: { ...proof, proofSha256 },
    assertUnchanged,
    acknowledges(advisory) {
      const findings = assertCorrectionFindings(advisory, correction);
      for (const found of findings.versions)
        assert.ok(
          provenVersions.includes(found),
          `${correction.package}@${found} has no proven installed payload`,
        );
      return findings;
    },
  };
}
