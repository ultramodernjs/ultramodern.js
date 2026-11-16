import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function outcomes(report) {
  const result = new Map();
  for (const suite of report.testResults) {
    assert(
      suite.assertionResults.length > 0,
      `Suite did not load: ${suite.name}`,
    );
    for (const test of suite.assertionResults) {
      const id = `${path.basename(suite.name)}: ${test.fullName}`;
      assert(!result.has(id), `Duplicate differential test identity: ${id}`);
      result.set(id, test.status);
    }
  }
  return result;
}

/** Compare the observed failing hydration slices, never another broad sweep. */
export function compareHydrationTrees({
  baselineRoot,
  composedRoot,
  modules,
  work,
  qualifyTree,
  execute,
}) {
  assert(
    path.isAbsolute(work),
    'Operation-owned absolute report directory required',
  );
  assert.equal(
    typeof qualifyTree,
    'function',
    'Owning runtime qualification hook required',
  );
  assert.equal(typeof execute, 'function', 'Sanitized owning runner required');
  fs.mkdirSync(work, { recursive: true });
  const reports = [];
  try {
    for (const [name, root] of [
      ['baseline', baselineRoot],
      ['composed', composedRoot],
    ]) {
      const report = path.join(work, `${name}.json`);
      assert(
        !fs.existsSync(report),
        `Do not overwrite another operation: ${report}`,
      );
      reports.push(report);
      let failure;
      try {
        qualifyTree(root, modules, undefined, execute, {
          parityOnly: true,
          jsonReport: report,
        });
      } catch (error) {
        failure = error;
      }
      assert(
        fs.existsSync(report),
        failure?.message ?? 'Missing Vitest differential report',
      );
      reports[reports.length - 1] = {
        file: report,
        report: JSON.parse(fs.readFileSync(report)),
      };
    }
    const [baseline, composed] = reports.map(entry => outcomes(entry.report));
    assert.deepEqual(
      [...composed.keys()].sort(),
      [...baseline.keys()].sort(),
      'Latest source and composed source must run identical assertions',
    );
    const introducedFailures = [...composed]
      .filter(
        ([id, status]) => status !== 'passed' && baseline.get(id) === 'passed',
      )
      .map(([id]) => id);
    const summary = reports.map(({ report }) => ({
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      suites: report.numTotalTestSuites,
    }));
    assert.deepEqual(
      introducedFailures,
      [],
      'Composed source regresses latest hydration',
    );
    assert.equal(
      summary[0].failed,
      0,
      'Latest-source control must pass, not mask regressions',
    );
    assert.equal(summary[1].failed, 0, 'Composed-source parity must pass');
    return { baseline: summary[0], composed: summary[1], introducedFailures };
  } finally {
    for (const entry of reports)
      fs.rmSync(typeof entry === 'string' ? entry : entry.file, {
        force: true,
      });
  }
}
