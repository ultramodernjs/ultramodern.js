import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packages, source } from './inputs.mjs';
import { qualifyAllHydration } from './qualify-all-hydration.mjs';
import {
  applyExact,
  buildEnvironment,
  qualifyPackedApi,
  qualifyRuntimeTree,
  sourceIntegrity,
} from './qualify-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const historicalLoadSuites = Object.freeze(
  ['initial-suspense-hydrate', 'range-boundary', 'unclosed-range'].map(
    name => `packages/octane/tests/hydration/${name}.test.ts`,
  ),
);
// Recovered from actual tool outputs for the original broad run. The raw log
// was cleaned and that output was truncated: this is NOT all twelve failures
// and cannot establish identities for the unresolved 29-count difference.
export const recoveredHistoricalSuites = Object.freeze(
  [
    'automatic-signal-stream',
    'early-control-handoff',
    'independent-island-signal-identity',
    'initial-suspense-hydrate',
    'pending-snapshot-seed',
    'range-boundary',
    'returned-jsx-query-resume',
    'signal-declaration-owner',
    'stream-delivery',
    'streamed-query-hydrate',
    'unclosed-range',
  ].map(name => `packages/octane/tests/hydration/${name}.test.ts`),
);

export function assertionInventory(report, root) {
  return report.testResults.map(suite => ({
    suite: path.relative(root, suite.name),
    loadError: suite.assertionResults.length === 0 ? suite.message : null,
    assertions: suite.assertionResults.map(test => ({
      name: test.fullName,
      status: test.status,
      errors: test.failureMessages,
    })),
  }));
}

export function summarizeSelectiveHydration(result) {
  const hash = value =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    sourceCommit: result.sourceCommit,
    historicalEvidenceComplete: false,
    unresolvedHistoricalFailureCountDifference: 29,
    inventory: result.inventory.map(entry => ({
      tree: entry.tree,
      totalHydrationSuites: entry.suites.length,
      inventorySha256: hash(entry.suites),
      recoveredHistoricalScope: recoveredHistoricalSuites.map(suite => ({
        suite,
        present: entry.suites.includes(path.basename(suite)),
      })),
    })),
    results: result.results.map(entry => ({
      tree: entry.tree,
      legacyAliases: entry.legacyAliases,
      passed: entry.passed,
      failed: entry.failed,
      suites: entry.suites.map(suite => ({
        suite: suite.suite,
        loadError: suite.loadError?.split('\n')[0] ?? null,
        assertionCount: suite.assertions.length,
        exactAssertionNamesSha256: hash(
          suite.assertions.map(test => test.name).sort(),
        ),
        failures: suite.assertions.filter(test => test.status !== 'passed'),
      })),
    })),
  };
}

/** Diagnostic only: explicit whole suites, never a build or producer receipt. */
export async function qualifySelectiveHydration({
  work,
  suites = historicalLoadSuites,
  pnpm = process.env.PNPM_BINARY ?? 'pnpm',
  fullInventory = false,
  preserveFixture = false,
}) {
  assert(
    path.isAbsolute(work),
    'Absolute operation-owned work directory required',
  );
  fs.mkdirSync(work, { recursive: true });
  assert.equal(fs.readdirSync(work).length, 0, 'Work directory must be empty');
  const env = buildEnvironment();
  const run = (command, args, cwd, options = {}) =>
    execFileSync(command, args, { cwd, env, stdio: 'inherit', ...options });
  const owner = `octane-selective-${process.pid}`;
  const dependencies = path.join(work, 'deps/node_modules');
  let registered = false;
  function disk() {
    const stats = fs.statfsSync(work);
    assert(stats.bavail * stats.bsize >= 20 * 1024 ** 3, 'Below 20 GiB');
  }
  try {
    disk();
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(60000),
    });
    assert(response.ok, `Source download: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      sourceIntegrity,
    );
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      source.sha256,
    );
    const archive = path.join(work, 'source.tgz');
    fs.writeFileSync(archive, bytes);
    const roots = ['baseline', 'composed'].map(name => path.join(work, name));
    for (const root of roots) {
      fs.mkdirSync(root);
      run('tar', ['-xzf', archive, '--strip-components=1', '-C', root], work);
    }
    for (const patch of [
      'runtime-source.patch',
      'typescript-compat/typescript-source.patch',
      'typescript-compat/native-signals-source.patch',
      'typescript-compat/volar-core-source.patch',
      'runtime-tests.patch',
    ])
      applyExact(roots[1], path.join(here, patch), run);
    const deps = path.dirname(dependencies);
    fs.mkdirSync(deps);
    for (const file of ['package.json', 'pnpm-lock.yaml'])
      fs.copyFileSync(
        path.join(here, `runtime-build-${file}`),
        path.join(deps, file),
      );
    fs.writeFileSync(path.join(deps, 'pnpm-workspace.yaml'), 'packages: []\n');
    assert.equal(process.versions.node, '26.13.1');
    assert.equal(
      run(pnpm, ['--version'], deps, {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim(),
      '12.21.0',
    );
    disk();
    fs.mkdirSync(dependencies);
    if (process.platform === 'darwin') {
      run(
        '/Users/satan/bin/disk-guardian-artifacts',
        [
          'register',
          dependencies,
          '--owner',
          owner,
          '--owner-pid',
          String(process.pid),
          '--kind',
          'dependencies',
          '--grace-hours',
          '24',
        ],
        work,
      );
      registered = true;
    }
    run(
      pnpm,
      [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--config.manage-package-manager-versions=false',
        '--store-dir',
        path.join(process.env.HOME, '.local/share/pnpm/store'),
        '--config.package-import-method=clone-or-copy',
      ],
      deps,
    );
    for (const root of roots)
      fs.symlinkSync(dependencies, path.join(root, 'node_modules'));
    if (fullInventory) {
      const sourceEvidence = qualifyAllHydration({
        baselineRoot: roots[0],
        composedRoot: roots[1],
        modules: dependencies,
        work: path.join(work, 'full-source'),
        qualifyTree: qualifyRuntimeTree,
        execute: run,
      });
      disk();
      const npm = packages.find(entry => entry.name === 'octane');
      const response = await fetch(npm.url, {
        signal: AbortSignal.timeout(60000),
      });
      assert(response.ok, `Npm download: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(
        `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        npm.integrity,
      );
      const npmArchive = path.join(work, 'npm.tgz');
      fs.writeFileSync(npmArchive, bytes);
      const reconstructed = path.join(work, 'reconstructed');
      fs.mkdirSync(reconstructed);
      run(
        'tar',
        ['-xzf', npmArchive, '--strip-components=1', '-C', reconstructed],
        work,
      );
      applyExact(
        reconstructed,
        path.resolve(here, '../../../patches/octane@0.18.0.patch'),
        run,
      );
      fs.symlinkSync(dependencies, path.join(reconstructed, 'node_modules'));
      const complete = qualifyAllHydration({
        baselineRoot: roots[0],
        composedRoot: roots[1],
        modules: dependencies,
        packed: reconstructed,
        sourceEvidence,
        work: path.join(work, 'full-packed'),
        qualifyTree: qualifyRuntimeTree,
        execute: run,
      });
      qualifyPackedApi(roots[1], dependencies, reconstructed, run);
      const summary = Object.fromEntries(
        ['baseline', 'composed', 'packed'].map(lane => [
          lane,
          {
            suites: complete[lane].suites.length,
            assertions: complete[lane].suites.reduce(
              (sum, suite) => sum + suite.assertions.length,
              0,
            ),
            statusDigest: createHash('sha256')
              .update(JSON.stringify(complete[lane]))
              .digest('hex'),
          },
        ]),
      );
      console.log('HYDRATION_COMPLETE', JSON.stringify(summary));
      return complete;
    }
    const inventory = roots.map(root => ({
      tree: path.basename(root),
      suites: fs
        .readdirSync(path.join(root, 'packages/octane/tests/hydration'))
        .filter(name => name.endsWith('.test.ts'))
        .sort(),
    }));
    const results = [];
    for (const legacyAliases of [true, false]) {
      for (const root of roots) {
        const reportFile = path.join(
          work,
          `${path.basename(root)}-${legacyAliases}.json`,
        );
        let commandError;
        try {
          qualifyRuntimeTree(root, dependencies, undefined, run, {
            suites,
            legacyAliases,
            jsonReport: reportFile,
          });
        } catch (error) {
          commandError = error;
        }
        assert(
          fs.existsSync(reportFile),
          commandError?.message ?? 'No Vitest report',
        );
        const report = JSON.parse(fs.readFileSync(reportFile));
        const actual = assertionInventory(report, root);
        assert.deepEqual(
          actual.map(entry => entry.suite).sort(),
          [...suites].sort(),
          'All explicit suites must be present',
        );
        results.push({
          tree: path.basename(root),
          legacyAliases,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          suites: actual,
        });
      }
    }
    // Do not manufacture a passing classification from equal aggregate counts.
    const corrected = results.filter(entry => !entry.legacyAliases);
    const identities = result =>
      result.suites
        .flatMap(suite =>
          suite.assertions.map(test => `${suite.suite}: ${test.name}`),
        )
        .sort();
    assert.deepEqual(
      identities(corrected[0]),
      identities(corrected[1]),
      'Identical full assertions required',
    );
    for (const result of corrected) {
      assert(
        result.suites.every(suite => suite.assertions.length > 0),
        'Correct export harness must load every suite',
      );
      const failures = result.suites.flatMap(suite =>
        suite.assertions
          .filter(test => test.status !== 'passed')
          .map(test => ({ suite: suite.suite, ...test })),
      );
      assert.deepEqual(
        failures,
        [],
        `${result.tree}: exact failing/skipped/pending assertions`,
      );
      assert.equal(result.failed, 0, `${result.tree} selected suites failed`);
    }
    if (
      JSON.stringify([...suites].sort()) ===
      JSON.stringify([...historicalLoadSuites].sort())
    ) {
      for (const result of results.filter(entry => entry.legacyAliases)) {
        for (const suite of result.suites) {
          assert.equal(
            suite.assertions.length,
            0,
            'Historical alias control must reproduce load failure',
          );
          const missing = suite.suite.endsWith(
            '/initial-suspense-hydrate.test.ts',
          )
            ? 'octane/internal/hydration-query'
            : 'octane/behavior';
          assert(
            suite.loadError?.includes(`Failed to resolve import "${missing}"`),
            'Historical load failure must match exact private subpath',
          );
        }
      }
    }
    return { sourceCommit: source.commit, inventory, results };
  } finally {
    try {
      if (registered && !preserveFixture)
        run(
          '/Users/satan/bin/disk-guardian-artifacts',
          ['release', dependencies, '--owner', owner],
          work,
        );
    } finally {
      if (!preserveFixture) fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  assert(process.env.OWNED_TEMP_DIR, 'Run inside owned-temp-dir');
  const result = await qualifySelectiveHydration({
    work: path.join(fs.realpathSync(process.env.OWNED_TEMP_DIR), 'selective'),
    fullInventory: process.argv.includes('--full-inventory'),
  });
  if (!process.argv.includes('--full-inventory'))
    console.log(JSON.stringify(summarizeSelectiveHydration(result), null, 2));
}
