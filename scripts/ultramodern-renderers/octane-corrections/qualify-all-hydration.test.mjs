import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertCommonAssertions,
  assertHydrationEvidence,
  partitionSuites,
  qualifyAllHydration,
  readBatch,
} from './qualify-all-hydration.mjs';

test('whole-suite partition is sorted, bounded, duplicate-free and exhaustive', () => {
  const suites = Array.from(
    { length: 197 },
    (_, index) => `suite-${String(index).padStart(3, '0')}`,
  );
  const batches = partitionSuites(suites);
  assert.equal(batches.length, 25);
  assert.deepEqual(batches.flat(), suites);
  assert(batches.every(batch => batch.length <= 8));
  assert.throws(() => partitionSuites(['same', 'same']));
  assert.throws(() => partitionSuites(['b', 'a']));
  assert.throws(() => partitionSuites(suites, 197));
});

test('evidence rejects load errors, failures, skips, missing and duplicate suite/assertion IDs', () => {
  const suite = 'packages/octane/tests/hydration/example.test.ts';
  const good = {
    suites: [
      {
        suite,
        loadError: null,
        assertions: [{ id: 'real case', status: 'passed' }],
      },
    ],
    commandFailures: [],
  };
  assertHydrationEvidence(good, [suite]);
  for (const status of ['failed', 'skipped', 'pending', 'todo']) {
    const bad = structuredClone(good);
    bad.suites[0].assertions[0].status = status;
    assert.throws(() => assertHydrationEvidence(bad, [suite]));
  }
  const load = structuredClone(good);
  load.suites[0].loadError = 'Cannot resolve owning export';
  load.suites[0].assertions = [];
  assert.throws(() => assertHydrationEvidence(load, [suite]));
  assert.throws(() => assertHydrationEvidence(good, []));
  assert.throws(() =>
    assertHydrationEvidence(
      { ...good, suites: [...good.suites, ...good.suites] },
      [suite],
    ),
  );
  assert.throws(() =>
    assertCommonAssertions(good, {
      suites: [
        { suite, assertions: [{ id: 'different case', status: 'passed' }] },
      ],
    }),
  );
  const report = {
    testResults: [
      {
        name: `/root/${suite}`,
        assertionResults: [
          { fullName: 'same', status: 'passed' },
          { fullName: 'same', status: 'passed' },
        ],
      },
    ],
  };
  assert.throws(() => readBatch(report, '/root', [suite]));
  assert.throws(() =>
    readBatch(
      {
        testResults: [
          {
            name: `/root/${suite}`,
            assertionResults: [
              { fullName: 'no real task ID', status: 'passed' },
            ],
          },
        ],
      },
      '/root',
      [suite],
      true,
    ),
  );
  const repeatedTitles = readBatch(
    {
      testResults: [
        {
          name: `/root/${suite}`,
          assertionResults: [
            {
              fullName: 'same authored title',
              status: 'passed',
              meta: { octaneTaskId: 'task_0' },
            },
            {
              fullName: 'same authored title',
              status: 'passed',
              meta: { octaneTaskId: 'task_1' },
            },
          ],
        },
      ],
    },
    '/root',
    [suite],
    true,
  );
  assert.equal(
    new Set(repeatedTitles[0].assertions.map(test => test.id)).size,
    2,
  );
  assert.throws(() =>
    assertHydrationEvidence(
      {
        ...good,
        unhandledErrors: [{ message: 'worker OOM' }],
      },
      [suite],
    ),
  );
  assert.throws(() =>
    assertHydrationEvidence(
      {
        ...good,
        runEndReasons: ['interrupted'],
      },
      [suite],
    ),
  );
});

test('complete source and packed gates execute all 180 plus 17 suite identities', () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run in owned-temp-dir');
  const work = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'full-gate-test-'),
  );
  try {
    const baselineRoot = path.join(work, 'baseline'),
      composedRoot = path.join(work, 'composed');
    for (const [root, count] of [
      [baselineRoot, 180],
      [composedRoot, 197],
    ]) {
      const dir = path.join(root, 'packages/octane/tests/hydration');
      fs.mkdirSync(dir, { recursive: true });
      for (let index = 0; index < count; index++)
        fs.writeFileSync(
          path.join(dir, `test-${String(index).padStart(3, '0')}.test.ts`),
          '',
        );
    }
    const executed = [];
    const qualifyTree = (root, _modules, packed, _execute, options) => {
      executed.push({ root, packed, suites: options.suites });
      fs.writeFileSync(
        options.jsonReport,
        JSON.stringify({
          runEndReason: 'passed',
          testResults: options.suites.map(suite => ({
            name: path.join(root, suite),
            assertionResults: [
              {
                fullName: 'unchanged real assertion name',
                status: 'passed',
                meta: { octaneTaskId: `${suite}_0` },
              },
            ],
          })),
        }),
      );
    };
    const options = {
      baselineRoot,
      composedRoot,
      modules: work,
      qualifyTree,
      execute() {},
      record() {},
    };
    const source = qualifyAllHydration({
      ...options,
      work: path.join(work, 'source-report'),
    });
    const result = qualifyAllHydration({
      ...options,
      sourceEvidence: source,
      packed: path.join(work, 'packed'),
      work: path.join(work, 'packed-report'),
    });
    assert.equal(result.baseline.suites.length, 180);
    assert.equal(result.composed.suites.length, 197);
    assert.equal(result.packed.suites.length, 197);
    assert.equal(
      executed.reduce((sum, batch) => sum + batch.suites.length, 0),
      574,
    );
    assert.equal(executed.length, 23 + 25 + 25);
    assert.equal(result.inventory.additional.length, 17);
    assert(
      fs.existsSync(path.join(work, 'packed-report/complete-statuses.json')),
    );
    const failingQualify = (root, modules, packed, execute, options) => {
      qualifyTree(root, modules, packed, execute, options);
      if (
        root === baselineRoot &&
        options.suites.some(suite => suite.endsWith('/test-000.test.ts'))
      ) {
        const report = JSON.parse(fs.readFileSync(options.jsonReport));
        report.testResults[0].assertionResults[0].status = 'failed';
        report.testResults[0].assertionResults[0].failureMessages = [
          'real failed assertion retained',
        ];
        fs.writeFileSync(options.jsonReport, JSON.stringify(report));
        throw new Error('Vitest returned failure');
      }
    };
    const failedDirectory = path.join(work, 'failed-report');
    assert.throws(() =>
      qualifyAllHydration({
        ...options,
        qualifyTree: failingQualify,
        work: failedDirectory,
      }),
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(failedDirectory, 'complete-statuses.json')),
    );
    assert.equal(saved.baseline.suites.length, 180);
    assert.equal(saved.composed.suites.length, 197);
    assert.equal(saved.baseline.suites[0].assertions[0].status, 'failed');
    assert.deepEqual(saved.baseline.suites[0].assertions[0].failures, [
      'real failed assertion retained',
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
