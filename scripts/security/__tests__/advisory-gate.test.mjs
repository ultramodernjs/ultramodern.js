import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertNoHighAdvisories,
  readAdvisoryExceptions,
} from '../advisory-gate.mjs';

// Recorded from `pnpm audit --prod --audit-level=high --json` on a scratch
// lockfile that pins image-size 2.0.2.
const imageSizeReport = fs.readFileSync(
  new URL('./fixtures/pnpm-audit-image-size-2.0.2.json', import.meta.url),
  'utf8',
);
const now = new Date('2026-09-27T00:00:00Z');

async function withExceptions(entries, run) {
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'advisory-gate-'),
  );
  const exceptionsPath = path.join(directory, 'exceptions.json');
  fs.writeFileSync(exceptionsPath, JSON.stringify(entries));
  try {
    return await run(exceptionsPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function auditReturning(stdout, exitCode = 1) {
  const calls = [];
  const runCommandImpl = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return { exitCode, stdout, stderr: '' };
  };
  return { calls, runCommandImpl };
}

test('a lockfile pinning image-size 2.0.2 fails with the advisory and the fix', async () => {
  const { calls, runCommandImpl } = auditReturning(imageSizeReport);
  await withExceptions([], async exceptionsPath => {
    await assert.rejects(
      () =>
        assertNoHighAdvisories({
          cwd: '/scratch',
          exceptionsPath,
          now,
          runCommandImpl,
        }),
      error =>
        error.message.includes('found 2 high or critical advisories') &&
        error.message.includes('GHSA-5p2g-fcmc-qvqq image-size@2.0.2') &&
        error.message.includes('patched >=2.0.3') &&
        error.message.includes('fix: pnpm update --recursive image-size'),
    );
  });
  assert.deepEqual(calls, [
    {
      command: 'pnpm',
      args: ['audit', '--prod', '--audit-level=high', '--json'],
      cwd: '/scratch',
    },
  ]);
});

test('an unexpired exception acknowledges exactly its advisory', async () => {
  const { runCommandImpl } = auditReturning(imageSizeReport);
  const exception = (id, parents = ['.']) => ({
    id,
    package: 'image-size',
    parents,
    reason: 'test',
    expires: '2026-10-01',
  });
  await withExceptions(
    [exception('GHSA-5p2g-fcmc-qvqq'), exception('GHSA-w3rx-r6r6-pgpr')],
    async exceptionsPath => {
      assert.deepEqual(
        await assertNoHighAdvisories({
          cwd: '/scratch',
          exceptionsPath,
          now,
          runCommandImpl,
        }),
        {
          auditLevel: 'high',
          acknowledged: ['GHSA-5p2g-fcmc-qvqq', 'GHSA-w3rx-r6r6-pgpr'],
        },
      );
    },
  );
  await withExceptions(
    [exception('GHSA-5p2g-fcmc-qvqq')],
    async exceptionsPath => {
      await assert.rejects(
        () =>
          assertNoHighAdvisories({
            cwd: '/scratch',
            exceptionsPath,
            now,
            runCommandImpl,
          }),
        /found 1 high or critical advisory:\nhigh GHSA-w3rx-r6r6-pgpr/u,
      );
    },
  );
  // Same advisory, but pulled in by a parent the exception does not name.
  await withExceptions(
    [
      exception('GHSA-5p2g-fcmc-qvqq', ['some-parent']),
      exception('GHSA-w3rx-r6r6-pgpr'),
    ],
    async exceptionsPath => {
      await assert.rejects(
        () =>
          assertNoHighAdvisories({
            cwd: '/scratch',
            exceptionsPath,
            now,
            runCommandImpl,
          }),
        /found 1 high or critical advisory:\nhigh GHSA-5p2g-fcmc-qvqq[\s\S]*via \.>image-size/u,
      );
    },
  );
});

test('an expired exception fails before auditing', async () => {
  const { calls, runCommandImpl } = auditReturning(imageSizeReport);
  await withExceptions(
    [
      {
        id: 'GHSA-5p2g-fcmc-qvqq',
        package: 'image-size',
        parents: ['.'],
        reason: 'test',
        expires: '2026-09-26',
      },
    ],
    async exceptionsPath => {
      await assert.rejects(
        () =>
          assertNoHighAdvisories({
            cwd: '/scratch',
            exceptionsPath,
            now,
            runCommandImpl,
          }),
        /expired .*\n {2}GHSA-5p2g-fcmc-qvqq image-size \(expired 2026-09-26\)/u,
      );
    },
  );
  assert.equal(calls.length, 0);
});

test('a missing audit report fails closed', async () => {
  const { runCommandImpl } = auditReturning('', 1);
  await withExceptions([], async exceptionsPath => {
    await assert.rejects(
      () =>
        assertNoHighAdvisories({
          cwd: '/scratch',
          exceptionsPath,
          now,
          runCommandImpl,
        }),
      /pnpm audit returned no advisory report \(exit 1\)/u,
    );
  });
});

test('moderate advisories do not fail the gate', async () => {
  const report = JSON.parse(imageSizeReport);
  for (const advisory of Object.values(report.advisories)) {
    advisory.severity = 'moderate';
  }
  const { runCommandImpl } = auditReturning(JSON.stringify(report), 0);
  await withExceptions([], async exceptionsPath => {
    assert.deepEqual(
      await assertNoHighAdvisories({
        cwd: '/scratch',
        exceptionsPath,
        now,
        runCommandImpl,
      }),
      { auditLevel: 'high', acknowledged: [] },
    );
  });
});

test('the committed exceptions are well formed', async () => {
  assert.ok(readAdvisoryExceptions() instanceof Map);
});

const picomatchReport = JSON.stringify({
  advisories: {
    picomatch: {
      github_advisory_id: 'GHSA-fc5q-39xc-vjpf',
      module_name: 'picomatch',
      severity: 'high',
      findings: [
        { version: '2.3.2', paths: ['.>micromatch>picomatch'] },
        { version: '4.0.7', paths: ['.>vite>picomatch'] },
      ],
    },
  },
});

test('release contexts cannot acknowledge the repository picomatch correction', async () => {
  for (const allowRepositoryCorrections of [false, undefined, 'true', 1]) {
    const { runCommandImpl } = auditReturning(picomatchReport);
    await withExceptions([], async exceptionsPath => {
      await assert.rejects(
        assertNoHighAdvisories({
          cwd: '/scratch',
          exceptionsPath,
          now,
          runCommandImpl,
          allowRepositoryCorrections,
        }),
        /found 1 high or critical advisory:\nhigh GHSA-fc5q-39xc-vjpf[\s\S]*correction refused: repository correction is not enabled/u,
      );
    });
  }
});

test('no exception entry can waive the repository picomatch correction', async () => {
  for (const entry of [
    {
      id: 'GHSA-fc5q-39xc-vjpf',
      package: 'picomatch',
      parents: ['micromatch', 'vite'],
      reason: 'test',
      expires: '2026-12-01',
    },
    {
      id: 'GHSA-fc5q-39xc-vjpf',
      package: 'picomatch',
      version: '2.3.2',
      parents: ['micromatch'],
      correction: 'repository-picomatch-extglob-correction',
      owner: 'bleedingdev',
      reason: 'test',
      remediation: 'test',
      expires: '2026-12-01',
    },
  ]) {
    const { calls, runCommandImpl } = auditReturning(picomatchReport);
    await withExceptions([entry], async exceptionsPath => {
      assert.throws(
        () => readAdvisoryExceptions(exceptionsPath),
        /repository correction and cannot be waived/u,
      );
      await assert.rejects(
        assertNoHighAdvisories({
          cwd: '/scratch',
          exceptionsPath,
          now,
          runCommandImpl,
        }),
        /cannot be waived/u,
      );
    });
    assert.equal(calls.length, 0);
  }
  // The retired correction shape is no longer an accepted exception form.
  await withExceptions(
    [
      {
        id: 'GHSA-vfj7-8cjw-p6xm',
        package: 'braces',
        version: '3.0.3',
        parents: ['chokidar', 'micromatch'],
        correction: 'repository-braces-depth-bound',
        owner: 'bleedingdev',
        reason: 'test',
        remediation: 'test',
        expires: '2026-12-01',
      },
    ],
    async exceptionsPath => {
      assert.throws(
        () => readAdvisoryExceptions(exceptionsPath),
        /every exception needs exactly/u,
      );
    },
  );
});

test('the repository correction fails shut before auditing when it cannot be proven', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  for (const [cwd, when, pattern] of [
    [
      fs.realpathSync(process.env.OWNED_TEMP_DIR ?? os.tmpdir()),
      now,
      /restricted to its physical repository/u,
    ],
    [root, new Date('2027-02-18T00:00:00Z'), /expired 2027-02-17/u],
  ]) {
    const { calls, runCommandImpl } = auditReturning(picomatchReport);
    await withExceptions([], async exceptionsPath => {
      await assert.rejects(
        assertNoHighAdvisories({
          cwd,
          exceptionsPath,
          now: when,
          runCommandImpl,
          allowRepositoryCorrections: true,
        }),
        pattern,
      );
    });
    assert.equal(calls.length, 0);
  }
});

test('an empty finding cannot be acknowledged and policy mutation during audit fails', async () => {
  await withExceptions(
    [
      {
        id: 'GHSA-5p2g-fcmc-qvqq',
        package: 'image-size',
        parents: ['.'],
        reason: 'test',
        expires: '2026-10-01',
      },
    ],
    async exceptionsPath => {
      const report = JSON.parse(imageSizeReport);
      for (const value of Object.values(report.advisories)) value.findings = [];
      await assert.rejects(
        assertNoHighAdvisories({
          cwd: '/scratch',
          exceptionsPath,
          now,
          ...auditReturning(JSON.stringify(report)),
        }),
        /found 2 high or critical advisories/u,
      );
      await assert.rejects(
        assertNoHighAdvisories({
          cwd: '/scratch',
          exceptionsPath,
          now,
          runCommandImpl() {
            fs.writeFileSync(exceptionsPath, '[]');
            return { stdout: JSON.stringify({ advisories: {} }) };
          },
        }),
        /policy changed during audit/u,
      );
    },
  );
});
