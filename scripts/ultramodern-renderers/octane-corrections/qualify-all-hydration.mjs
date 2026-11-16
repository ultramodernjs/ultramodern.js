import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const hashInventory = value =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function hydrationSuites(root) {
  const directory = path.join(root, 'packages/octane/tests/hydration');
  return fs
    .readdirSync(directory, { recursive: true })
    .filter(name => name.endsWith('.test.ts'))
    .map(name => `packages/octane/tests/hydration/${name}`)
    .sort();
}

export function partitionSuites(suites, size = 8) {
  assert(
    Number.isInteger(size) && size >= 1 && size <= 12,
    'Bounded whole-suite batch size',
  );
  assert.deepEqual(
    suites,
    [...new Set(suites)].sort(),
    'Sorted unique suite inventory required',
  );
  return Array.from({ length: Math.ceil(suites.length / size) }, (_, index) =>
    suites.slice(index * size, (index + 1) * size),
  );
}

export function readBatch(report, root, expected, requireTaskIds = false) {
  if (requireTaskIds) {
    for (const suite of report.testResults)
      for (const test of suite.assertionResults)
        assert(
          typeof test.meta?.octaneTaskId === 'string' &&
            test.meta.octaneTaskId.length > 0,
          `Missing authoritative Vitest task identity: ${suite.name}: ${test.fullName}`,
        );
  }
  const suites = report.testResults
    .map(suite => ({
      suite: path.relative(root, suite.name),
      loadError: suite.assertionResults.length
        ? null
        : suite.message || 'No assertions loaded',
      assertions: suite.assertionResults.map(test => ({
        id: test.meta?.octaneTaskId
          ? `${test.meta.octaneTaskId}: ${test.fullName}`
          : test.fullName,
        status: test.status,
        failures: test.failureMessages ?? [],
      })),
    }))
    .sort((a, b) => a.suite.localeCompare(b.suite));
  assert.deepEqual(
    suites.map(suite => suite.suite).sort(),
    [...expected].sort(),
    'Missing/duplicate/unexpected suites',
  );
  for (const suite of suites)
    assert.equal(
      new Set(suite.assertions.map(test => test.id)).size,
      suite.assertions.length,
      `Duplicate assertion IDs: ${suite.suite}`,
    );
  return suites;
}

export function assertHydrationEvidence(evidence, expectedSuites) {
  assert.deepEqual(
    evidence.suites.map(suite => suite.suite).sort(),
    expectedSuites,
    'Inventory coverage must be exact',
  );
  assert.equal(
    evidence.commandFailures.length,
    0,
    JSON.stringify(evidence.commandFailures),
  );
  assert.equal(
    evidence.unhandledErrors?.length ?? 0,
    0,
    'No unhandled worker errors',
  );
  assert(
    (evidence.runEndReasons ?? []).every(reason => reason === 'passed'),
    'Every shard must finish normally, never interrupted',
  );
  for (const suite of evidence.suites) {
    assert(
      suite.assertions.length > 0,
      `Suite must load assertions: ${suite.suite}`,
    );
    assert.equal(
      new Set(suite.assertions.map(test => test.id)).size,
      suite.assertions.length,
      `Duplicate assertion IDs: ${suite.suite}`,
    );
  }
  const failures = evidence.suites.flatMap(suite => [
    ...(suite.loadError
      ? [{ suite: suite.suite, loadError: suite.loadError }]
      : []),
    ...suite.assertions
      .filter(test => test.status !== 'passed')
      .map(test => ({ suite: suite.suite, ...test })),
  ]);
  assert.deepEqual(
    failures,
    [],
    'Full hydration gate: no load errors, failures, skips or pending assertions',
  );
}

export function assertCommonAssertions(baseline, composed) {
  const bySuite = new Map(composed.suites.map(suite => [suite.suite, suite]));
  for (const suite of baseline.suites) {
    assert(
      bySuite.has(suite.suite),
      `Composed dropped baseline suite: ${suite.suite}`,
    );
    assert.deepEqual(
      bySuite
        .get(suite.suite)
        .assertions.map(test => test.id)
        .sort(),
      suite.assertions.map(test => test.id).sort(),
      `Common assertion parity: ${suite.suite}`,
    );
  }
}

/** Collection only; not acceptance or a producer receipt. */
export function collectHydrationLane({
  lane,
  root,
  modules,
  packed,
  suites,
  work,
  qualifyTree,
  execute,
  batchSize = 8,
  record = event => console.log('HYDRATION_BATCH', JSON.stringify(event)),
}) {
  assert(
    ['baseline', 'composed', 'packed'].includes(lane),
    'Known diagnostic lane',
  );
  assert.deepEqual(
    suites,
    hydrationSuites(root),
    'Lane must collect its whole current inventory',
  );
  fs.mkdirSync(work, { recursive: true });
  const result = {
    suites: [],
    commandFailures: [],
    unhandledErrors: [],
    runEndReasons: [],
  };
  const batches = partitionSuites(suites, batchSize);
  for (const [index, selection] of batches.entries()) {
    const reportFile = path.join(
      work,
      `${lane}-${String(index).padStart(2, '0')}.json`,
    );
    assert(!fs.existsSync(reportFile), 'Do not overwrite evidence');
    let error;
    try {
      qualifyTree(root, modules, packed, execute, {
        suites: selection,
        jsonReport: reportFile,
        authoritativeIds: true,
      });
    } catch (failure) {
      error = failure;
    }
    assert(
      fs.existsSync(reportFile),
      error?.message ?? `Missing batch report: ${lane}/${index}`,
    );
    const report = JSON.parse(fs.readFileSync(reportFile));
    result.runEndReasons.push(report.runEndReason);
    result.unhandledErrors.push(...(report.unhandledErrors ?? []));
    const actual = readBatch(report, root, selection, true);
    result.suites.push(...actual);
    if (error)
      result.commandFailures.push({ batch: index, message: error.message });
    fs.writeFileSync(
      path.join(work, `${lane}-statuses.json`),
      JSON.stringify(result, null, 2),
    );
    record({
      lane,
      batch: index + 1,
      batches: batches.length,
      suites: actual.map(suite => ({
        suite: suite.suite,
        assertions: suite.assertions.length,
        idsDigest: hashInventory(suite.assertions.map(test => test.id).sort()),
        loadError: suite.loadError,
      })),
      passed: actual
        .flatMap(suite => suite.assertions)
        .filter(test => test.status === 'passed').length,
      failures: actual.flatMap(suite =>
        suite.assertions
          .filter(test => test.status !== 'passed')
          .map(test => ({ suite: suite.suite, ...test })),
      ),
      commandFailed: Boolean(error),
    });
  }
  result.suites.sort((a, b) => a.suite.localeCompare(b.suite));
  result.inventoryDigest = hashInventory(suites);
  result.assertionIdsDigest = hashInventory(
    result.suites
      .flatMap(suite =>
        suite.assertions.map(test => `${suite.suite}: ${test.id}`),
      )
      .sort(),
  );
  fs.writeFileSync(
    path.join(work, `${lane}-statuses.json`),
    JSON.stringify(result, null, 2),
  );
  return result;
}

/** Full sorted inventory, bounded whole-suite shards, with durable caller-owned evidence. */
export function qualifyAllHydration({
  baselineRoot,
  composedRoot,
  modules,
  packed,
  work,
  qualifyTree,
  execute,
  batchSize = 8,
  sourceEvidence,
  record = event => console.log('HYDRATION_BATCH', JSON.stringify(event)),
}) {
  assert(
    path.isAbsolute(work),
    'Absolute operation-owned evidence directory required',
  );
  fs.mkdirSync(work, { recursive: true });
  const baselineSuites = hydrationSuites(baselineRoot);
  const composedSuites = hydrationSuites(composedRoot);
  assert.equal(
    baselineSuites.length,
    180,
    'Exact authenticated latest inventory',
  );
  assert.equal(composedSuites.length, 197, 'Exact composed inventory');
  assert(
    baselineSuites.every(suite => composedSuites.includes(suite)),
    'No baseline suite may disappear',
  );
  const additional = composedSuites.filter(
    suite => !baselineSuites.includes(suite),
  );
  assert.equal(
    additional.length,
    17,
    'All additional port suites are included',
  );
  const inventory = { baselineSuites, composedSuites, additional };
  fs.writeFileSync(
    path.join(work, 'inventory.json'),
    JSON.stringify(inventory, null, 2),
  );
  record({
    phase: 'inventory',
    baseline: baselineSuites.length,
    composed: composedSuites.length,
    additional,
    baselineDigest: hashInventory(baselineSuites),
    composedDigest: hashInventory(composedSuites),
  });
  const lanes = packed
    ? [['packed', composedRoot, composedSuites, packed]]
    : [
        ['baseline', baselineRoot, baselineSuites],
        ['composed', composedRoot, composedSuites],
      ];
  const evidence = {};
  for (const [lane, root, suites, target] of lanes) {
    evidence[lane] = collectHydrationLane({
      lane,
      root,
      suites,
      packed: target,
      work,
      modules,
      qualifyTree,
      execute,
      batchSize,
      record,
    });
  }
  const combined = { inventory, ...sourceEvidence, ...evidence };
  fs.writeFileSync(
    path.join(work, 'complete-statuses.json'),
    JSON.stringify(combined, null, 2),
  );
  // Validate only after collecting every shard, including failed lanes.
  for (const [lane, , suites] of lanes)
    assertHydrationEvidence(evidence[lane], suites);
  if (packed) {
    assert(
      sourceEvidence?.baseline && sourceEvidence?.composed,
      'Source full inventory evidence required',
    );
    assertHydrationEvidence(sourceEvidence.baseline, baselineSuites);
    assertHydrationEvidence(sourceEvidence.composed, composedSuites);
    assertCommonAssertions(sourceEvidence.composed, evidence.packed);
  } else {
    assertCommonAssertions(evidence.baseline, evidence.composed);
  }
  return combined;
}
