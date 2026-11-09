import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertBracesArchiveIntegrity,
  assertBracesCorrectionFindings,
  assertBracesCorrectionPolicy,
  assertBracesDepthRegressions,
  bracesCorrection,
  captureCorrectionSourceFiles,
  prepareRepositoryBracesCorrection,
} from '../braces-correction.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const policy = () => ({
  id: bracesCorrection.id,
  package: bracesCorrection.package,
  version: bracesCorrection.version,
  parents: ['chokidar', 'micromatch'],
  correction: bracesCorrection.correction,
  owner: bracesCorrection.owner,
  reason: 'Historical correction fixture for the withdrawn advisory.',
  remediation: 'Retire the live exception when the advisory is withdrawn.',
  expires: bracesCorrection.expires,
});
const advisory = () => ({
  github_advisory_id: bracesCorrection.id,
  module_name: 'braces',
  findings: [
    { version: '3.0.3', paths: ['packages__toolkit__utils>micromatch>braces'] },
  ],
});
const now = new Date('2026-10-07T00:00:00Z');
async function owned(run) {
  const directory = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR ?? os.tmpdir()),
      'braces-correction-test-',
    ),
  );
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('correction policy permits only the exact identity, parents, owner and finite expiry', () => {
  assert.doesNotThrow(() => assertBracesCorrectionPolicy(policy(), now));
  for (const [field, value] of Object.entries({
    id: 'GHSA-5p2g-fcmc-qvqq',
    package: 'image-size',
    version: '3.0.4',
    correction: 'anything',
    owner: 'someone',
    expires: '2099-01-01',
    parents: ['micromatch'],
    reason: '',
    remediation: '',
  })) {
    const changed = policy();
    changed[field] = value;
    assert.throws(
      () => assertBracesCorrectionPolicy(changed, now),
      undefined,
      field,
    );
  }
  const widened = policy();
  widened.extra = true;
  assert.throws(
    () => assertBracesCorrectionPolicy(widened, now),
    /closed fields/u,
  );
  assert.throws(
    () => assertBracesCorrectionPolicy(policy(), new Date('2026-11-07')),
    /expired/u,
  );
});

test('correction refuses missing findings, empty paths and every other version or parent', () => {
  assert.deepEqual(assertBracesCorrectionFindings(advisory()), [
    'packages__toolkit__utils>micromatch>braces',
  ]);
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
      value.findings[0].version = '3.0.2';
    },
    value => {
      value.findings[0].paths = ['root>unknown>braces'];
    },
    value => {
      value.findings[0].paths = ['root>micromatch>other'];
    },
    value => {
      value.findings[0].paths = ['>micromatch>braces'];
    },
    value => {
      value.module_name = 'other';
    },
    value => {
      value.github_advisory_id = 'GHSA-5p2g-fcmc-qvqq';
    },
  ]) {
    const value = advisory();
    mutate(value);
    assert.throws(() => assertBracesCorrectionFindings(value));
  }
});

test('a caller cannot enable repository correction for a different physical cwd', async () => {
  await owned(async directory => {
    await assert.rejects(
      prepareRepositoryBracesCorrection({
        cwd: directory,
        exception: policy(),
        now,
        repositoryRoot: directory,
        allowRepositoryCorrections: true,
      }),
      /physical repository/u,
    );
  });
});

test('source identity checks reject changed policy, lock, patch, reference and replacement files', async () => {
  for (const name of [
    'policy.json',
    'pnpm-lock.yaml',
    'patch.patch',
    'reference.js',
    'parent.json',
  ]) {
    await owned(directory => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, 'original');
      const snapshot = captureCorrectionSourceFiles(directory, [name]);
      snapshot.assertUnchanged();
      fs.writeFileSync(file, 'changed');
      assert.throws(() => snapshot.assertUnchanged(), /identity drift/u);
    });
  }
  await owned(directory => {
    const file = path.join(directory, 'same.js');
    fs.writeFileSync(file, 'same');
    const snapshot = captureCorrectionSourceFiles(directory, ['same.js']);
    fs.renameSync(file, path.join(directory, 'old.js'));
    fs.writeFileSync(file, 'same');
    assert.throws(() => snapshot.assertUnchanged(), /identity drift/u);
    fs.symlinkSync(file, path.join(directory, 'link.js'));
    assert.throws(
      () => captureCorrectionSourceFiles(directory, ['link.js']),
      /physical/u,
    );
  });
});

test('the recorded upstream archive is authenticated and any changed byte is refused', () => {
  const archive = fs.readFileSync(
    new URL('./fixtures/braces-upstream-3.0.3.tgz', import.meta.url),
  );
  assertBracesArchiveIntegrity(archive);
  archive[archive.length - 1] ^= 1;
  assert.throws(
    () => assertBracesArchiveIntegrity(archive),
    /archive integrity/u,
  );
});

test('actual upstream public parser and AST walkers fail before the canonical patch and pass after it', async () => {
  await owned(directory => {
    const archive = fileURLToPath(
      new URL('./fixtures/braces-upstream-3.0.3.tgz', import.meta.url),
    );
    const patchBytes = fs.readFileSync(
      path.join(root, bracesCorrection.patchPath),
    );
    assert.equal(
      createHash('sha256').update(patchBytes).digest('hex'),
      bracesCorrection.patchSha256,
    );
    const dependencyDirectory = path.join(
      root,
      'node_modules/.pnpm/node_modules',
    );
    for (const patched of [false, true]) {
      const destination = path.join(
        directory,
        patched ? 'patched' : 'upstream',
      );
      fs.mkdirSync(destination);
      execFileSync('tar', ['-xzf', archive, '-C', destination]);
      const packageRoot = path.join(destination, 'package');
      // The fixture's actual upstream code gets ordinary installed dependencies.
      fs.symlinkSync(
        dependencyDirectory,
        path.join(packageRoot, 'node_modules'),
        'dir',
      );
      if (patched) {
        execFileSync('patch', ['-p1', '-E', '--fuzz=0', '--batch'], {
          cwd: packageRoot,
          input: patchBytes,
        });
        assert.doesNotThrow(() => assertBracesDepthRegressions(packageRoot));
      } else {
        const require = createRequire(path.join(packageRoot, 'package.json'));
        const braces = require(path.join(packageRoot, 'index.js'));
        for (const [open, close] of [
          ['{', '}'],
          ['(', ')'],
        ]) {
          assert.doesNotThrow(() =>
            braces.parse(open.repeat(101) + 'x' + close.repeat(101)),
          );
        }
        for (const method of ['compile', 'expand', 'stringify']) {
          let ast = { type: 'root', nodes: [] };
          for (let depth = 0; depth < 101; depth++)
            ast = { type: 'root', nodes: [ast] };
          assert.doesNotThrow(
            () => braces[method](ast),
            `upstream ${method} lacks the depth bound`,
          );
        }
        assert.throws(
          () => assertBracesDepthRegressions(packageRoot),
          assert.AssertionError,
        );
      }
    }
  });
});

test('RangeError cannot satisfy the depth rejection contract', async () => {
  await owned(directory => {
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'braces', version: '3.0.3' }),
    );
    fs.writeFileSync(
      path.join(directory, 'index.js'),
      "exports.parse = input => { if (input.length > 201) throw new RangeError('stack'); };\n",
    );
    assert.throws(
      () => assertBracesDepthRegressions(directory),
      assert.AssertionError,
    );
  });
});
