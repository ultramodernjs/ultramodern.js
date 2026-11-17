import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertCorrectionCurrent,
  assertCorrectionFindings,
  assertCorrectionInventory,
  buildPatchedReference,
  captureCorrectionSourceFiles,
  picomatchCorrection,
  prepareRepositoryCorrection,
} from '../repository-correction.mjs';

const now = new Date('2026-11-17T00:00:00Z');
const digest = character => character.repeat(64);
// The built-in descriptor once its canonical patch digests are recorded.
const recorded = () => ({
  ...picomatchCorrection,
  versions: picomatchCorrection.versions.map((entry, index) => ({
    ...entry,
    patchSha256: digest(String(index + 1)),
  })),
});
const inventory = (correction = recorded()) =>
  correction.versions.map(entry => ({
    packageName: 'picomatch',
    version: entry.version,
    path: entry.patchPath,
    sha256: entry.patchSha256,
    repository: true,
    workspace: null,
    reason: 'Repository-only correction fixture.',
  }));
const advisory = () => ({
  github_advisory_id: picomatchCorrection.id,
  module_name: 'picomatch',
  findings: [
    { version: '2.3.2', paths: ['.>micromatch>picomatch'] },
    {
      version: '4.0.7',
      paths: [
        'packages__toolkit__utils>tinyglobby>picomatch',
        '.>vite>picomatch',
      ],
    },
  ],
});

async function owned(run) {
  const directory = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR ?? os.tmpdir()),
      'repository-correction-test-',
    ),
  );
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('the correction stays shut until each patch digest is recorded and until it expires', () => {
  assert.doesNotThrow(() => assertCorrectionCurrent(recorded(), now));
  const unrecorded = recorded();
  unrecorded.versions[1].patchSha256 = null;
  assert.throws(
    () => assertCorrectionCurrent(unrecorded, now),
    /picomatch@4\.0\.7 canonical patch digest is not recorded/u,
  );
  assert.throws(
    () => assertCorrectionCurrent(recorded(), new Date('2027-02-18T00:00:00Z')),
    /expired/u,
  );
  assert.throws(
    () => assertCorrectionCurrent(recorded(), new Date(Number.NaN)),
    /time is invalid/u,
  );
});

test('findings must be exact corrected versions reached through a recorded parent', () => {
  assert.deepEqual(assertCorrectionFindings(advisory()), {
    versions: ['2.3.2', '4.0.7'],
    paths: [
      '.>micromatch>picomatch',
      '.>vite>picomatch',
      'packages__toolkit__utils>tinyglobby>picomatch',
    ],
  });
  for (const parent of picomatchCorrection.parents) {
    const value = advisory();
    value.findings[0].paths = [`.>${parent}>picomatch`];
    assert.doesNotThrow(() => assertCorrectionFindings(value), parent);
  }
  for (const mutate of [
    value => {
      delete value.findings;
    },
    value => {
      value.findings = [];
    },
    value => {
      value.findings[0].paths = [];
    },
    value => {
      value.findings[0].version = '4.0.5';
    },
    value => {
      value.findings[0].version = '3.0.2';
    },
    value => {
      value.findings[0].paths = ['.>unknown>picomatch'];
    },
    value => {
      value.findings[0].paths = ['.>micromatch>other'];
    },
    value => {
      value.findings[0].paths = ['>micromatch>picomatch'];
    },
    value => {
      value.findings[0].paths = ['picomatch'];
    },
    value => {
      value.module_name = 'braces';
    },
    value => {
      value.github_advisory_id = 'GHSA-vfj7-8cjw-p6xm';
    },
  ]) {
    const value = advisory();
    mutate(value);
    assert.throws(() => assertCorrectionFindings(value));
  }
});

test('only the exact repository-only inventory entries carry the correction', () => {
  const correction = recorded();
  assert.doesNotThrow(() =>
    assertCorrectionInventory(
      [{ packageName: 'braces' }, ...inventory(correction).reverse()],
      correction,
    ),
  );
  for (const mutate of [
    entries => entries.pop(),
    entries => entries.push({ ...entries[0], version: '4.0.5' }),
    entries => {
      entries[0].repository = false;
    },
    entries => {
      entries[0].workspace = 'base';
    },
    entries => {
      entries[1].sha256 = digest('f');
    },
    entries => {
      entries[1].path = 'patches/other.patch';
    },
    entries => {
      entries[0].reason = ' ';
    },
    entries => {
      entries[0].extra = true;
    },
  ]) {
    const entries = inventory(correction);
    mutate(entries);
    assert.throws(() => assertCorrectionInventory(entries, correction));
  }
  assert.throws(
    () => assertCorrectionInventory(inventory(correction)),
    undefined,
    'unrecorded built-in digests never match an inventory digest',
  );
});

test('a caller cannot enable the correction for another physical root', async () => {
  await owned(async directory => {
    await assert.rejects(
      prepareRepositoryCorrection({ cwd: directory, now }),
      /restricted to its physical repository/u,
    );
  });
});

test('captured sources keep their checked bytes and reject later drift, replacement and links', async () => {
  await owned(directory => {
    const file = path.join(directory, 'pnpm-lock.yaml');
    fs.writeFileSync(file, 'original');
    const snapshot = captureCorrectionSourceFiles(directory, [
      'pnpm-lock.yaml',
    ]);
    snapshot.assertUnchanged();
    fs.writeFileSync(file, 'changed');
    assert.equal(snapshot.bytes('pnpm-lock.yaml').toString(), 'original');
    assert.throws(() => snapshot.assertUnchanged(), /identity drift/u);
    assert.throws(() => snapshot.bytes('other'), /uncaptured/u);
  });
  await owned(directory => {
    const file = path.join(directory, 'same.patch');
    fs.writeFileSync(file, 'same');
    const snapshot = captureCorrectionSourceFiles(directory, ['same.patch']);
    fs.renameSync(file, path.join(directory, 'old.patch'));
    fs.writeFileSync(file, 'same');
    assert.throws(() => snapshot.assertUnchanged(), /identity drift/u);
    fs.symlinkSync(file, path.join(directory, 'link.patch'));
    assert.throws(
      () => captureCorrectionSourceFiles(directory, ['link.patch']),
      /physical/u,
    );
    assert.throws(
      () => captureCorrectionSourceFiles(directory, ['../same.patch']),
      /inside the repository/u,
    );
  });
});

const manifest = `${JSON.stringify({ name: 'picomatch', version: '2.3.2' })}\n`;
const source = 'one\ntwo\nthree\n';
const patch = (from, to, file = 'lib/value.js', start = 1) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},3 +${start},3 @@`,
    ` one`,
    `-${from}`,
    `+${to}`,
    ` three`,
    '',
  ].join('\n');

function archive(directory, { files = {}, root = 'package' } = {}) {
  const staging = path.join(directory, `staging-${Math.random()}`);
  const contents = {
    'package.json': manifest,
    'lib/value.js': source,
    ...files,
  };
  for (const [name, bytes] of Object.entries(contents)) {
    const file = path.join(staging, root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const tarball = path.join(directory, `${Math.random()}.tgz`);
  execFileSync('tar', ['-czf', tarball, '-C', staging, root], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = fs.readFileSync(tarball);
  return {
    archive: bytes,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

test('the reference is the authenticated archive with the patch applied exactly', async () => {
  await owned(directory => {
    const input = archive(directory);
    const files = buildPatchedReference({
      ...input,
      packageName: 'picomatch',
      version: '2.3.2',
      patch: patch('two', 'TWO'),
    });
    assert.deepEqual([...files.keys()], ['lib/value.js', 'package.json']);
    assert.equal(files.get('lib/value.js').toString(), 'one\nTWO\nthree\n');
    assert.equal(files.get('package.json').toString(), manifest);

    const changed = Buffer.from(input.archive);
    changed[changed.length - 1] ^= 1;
    assert.throws(
      () =>
        buildPatchedReference({
          ...input,
          archive: changed,
          packageName: 'picomatch',
          version: '2.3.2',
          patch: patch('two', 'TWO'),
        }),
      /registry archive integrity/u,
    );
    assert.throws(
      () =>
        buildPatchedReference({
          ...input,
          packageName: 'picomatch',
          version: '4.0.7',
          patch: patch('two', 'TWO'),
        }),
      /registry archive version/u,
    );
  });
});

test('the reference refuses fuzzy, offset, failing and manifest-changing patches', async () => {
  await owned(directory => {
    const build = (input, patchText) => () =>
      buildPatchedReference({
        ...input,
        packageName: 'picomatch',
        version: '2.3.2',
        patch: patchText,
      });
    const plain = archive(directory);
    assert.throws(build(plain, patch('missing', 'TWO')), /does not apply/u);
    const shifted = archive(directory, {
      files: { 'lib/value.js': `zero\nzero\n${source}` },
    });
    assert.throws(build(shifted, patch('two', 'TWO')), /apply exactly/u);
    const withNotes = archive(directory, {
      files: { 'notes.txt': source },
    });
    assert.throws(
      build(
        withNotes,
        `${patch('two', 'TWO')}${[
          'diff --git a/package.json b/package.json',
          '--- a/package.json',
          '+++ b/package.json',
          '@@ -1 +1 @@',
          `-${manifest.trimEnd()}`,
          `+${manifest.trimEnd().replace('2.3.2', '2.3.2 ')}`,
          '',
        ].join('\n')}`,
      ),
      /preserve its npm manifest/u,
    );
    const elsewhere = archive(directory, { root: 'other' });
    assert.throws(build(elsewhere, patch('two', 'TWO')), /only package\//u);
  });
});
