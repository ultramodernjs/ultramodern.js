import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';

function workflow(file) {
  return yaml.load(
    fs.readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'),
  );
}

const expression = value => '$' + '{{ ' + value + ' }}';

const benchmarkPaths = [
  [
    '.github/workflows/ci-benchmark.yml',
    expression(
      "vars.CI_BENCHMARK_RUNNER || vars.DEPOT_LINUX_RUNNER || 'depot-ubuntu-24.04-8'",
    ),
  ],
  ['.depot/workflows/ci-benchmark.yml', 'depot-ubuntu-24.04-8'],
];

function step(job, name) {
  const matches = job.steps.filter(item => item.name === name);
  assert.equal(matches.length, 1, `exactly one ${name} step`);
  return matches[0];
}

test('benchmark providers use identical workloads and controls, with explicit hardware', () => {
  const parsed = benchmarkPaths.map(([file, runner]) => {
    const parsed = workflow(file);
    assert.equal(parsed.jobs.benchmark['runs-on'], runner);
    parsed.jobs.benchmark['runs-on'] = 'matched-hardware-placeholder';
    return parsed;
  });
  assert.deepEqual(parsed[0], parsed[1]);
});

test('benchmark samples are manual, read-only, bounded, and cannot cancel each other', () => {
  for (const [file] of benchmarkPaths) {
    const parsed = workflow(file);
    assert.deepEqual(Object.keys(parsed.on), ['workflow_dispatch']);
    assert.deepEqual(parsed.permissions, { contents: 'read' });
    assert.equal(parsed.concurrency['cancel-in-progress'], false);
    assert.match(parsed.concurrency.group, /github\.run_id/);
    assert.match(parsed.concurrency.group, /github\.run_attempt/);
    assert.deepEqual(Object.keys(parsed.jobs), ['benchmark']);
    const job = parsed.jobs.benchmark;
    assert.equal(job['timeout-minutes'], 60);
    assert.equal(job.strategy['fail-fast'], false);
    assert.deepEqual(job.strategy.matrix.workload, [
      'type-check',
      'unit-build-consumers',
    ]);
    assert.equal(job['continue-on-error'], undefined);
    for (const item of job.steps) {
      assert.equal(item['continue-on-error'], undefined);
      if (item.uses)
        assert.match(
          item.uses,
          /^(actions\/(checkout|setup-node)|jdx\/mise-action)@[a-f0-9]{40}$/u,
        );
      assert.doesNotMatch(JSON.stringify(item), /secrets\.|id-token|publish/u);
    }
    const checkout = step(job, 'Checkout');
    assert.equal(checkout.with.ref, '${{ github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(checkout.with['fetch-depth'], 1);
  }
});

test('cold measurements bypass project caches and clean only the owned temporary directory', () => {
  for (const [file] of benchmarkPaths) {
    const parsed = workflow(file);
    const job = parsed.jobs.benchmark;
    for (const key of [
      'NX_SKIP_NX_CACHE',
      'NX_SKIP_REMOTE_CACHE',
      'NX_NO_CLOUD',
    ])
      assert.equal(parsed.env[key], 'true');
    assert.equal(parsed.env.NX_DAEMON, 'false');
    const initialize = step(job, 'Initialize isolated project caches').run;
    assert.match(initialize, /git rev-parse --verify HEAD/u);
    assert.match(initialize, /= "\$GITHUB_SHA"/u);
    assert.match(
      initialize,
      /mktemp -d "\$RUNNER_TEMP\/ci-benchmark\.XXXXXXXX"/u,
    );
    for (const key of [
      'CI_BENCHMARK_TEMP',
      'MISE_DATA_DIR',
      'MISE_CACHE_DIR',
      'npm_config_cache',
      'PLAYWRIGHT_BROWSERS_PATH',
      'NX_CACHE_DIRECTORY',
      'NX_WORKSPACE_DATA_DIRECTORY',
    ])
      assert.match(initialize, new RegExp(`${key}=\\$benchmark_root`));
    assert.match(initialize, /CI_BENCHMARK_CACHE_EVIDENCE/u);
    const mise = step(job, 'Setup mise');
    assert.equal(mise.with.cache, false);
    assert.equal(mise.with.cache_save, false);
    assert.equal(mise.with.mise_dir, '${{ env.MISE_DATA_DIR }}');
    assert.equal(mise.with.version, '2026.11.8');
    assert.equal(mise.with.install, true);
    assert.equal(
      step(job, 'Install Dependencies').run,
      'pnpm install --frozen-lockfile --store-dir "$CI_BENCHMARK_TEMP/pnpm-store"',
    );
    assert.equal(
      step(job, 'Record CI benchmark evidence').run.trim(),
      'pnpm_version="$(pnpm --version)"\n' +
        'node scripts/ci/record-runner-evidence.mjs "$pnpm_version"',
    );
    const cleanup = step(job, 'Remove owned benchmark caches');
    assert.equal(cleanup.if, 'always()');
    assert.match(cleanup.run, /"\$RUNNER_TEMP"\/ci-benchmark\.\?{8}\)/u);
    assert.match(cleanup.run, /rm -rf -- "\$CI_BENCHMARK_TEMP"/u);
    assert.doesNotMatch(cleanup.run, /rm[^\n]*"\$RUNNER_TEMP"/u);
  }
});

test('measurement commands retain existing type-check and Linux unit coverage', () => {
  const typeCheck = workflow('.github/workflows/type-check.yml').jobs[
    'type-check'
  ];
  const unit = workflow('.github/workflows/ut-Linux.yml').jobs['ut-linux'];
  const commandSets = [
    [
      'type-check',
      typeCheck,
      [
        'Type Check',
        'Build cross-project type-check dependency',
        'Validate critical packages with native TypeScript',
      ],
    ],
    [
      'unit-build-consumers',
      unit,
      [
        'Build Required Pkg',
        'Test release browser contracts',
        'Resolve Playwright runtime',
        'Install Playwright browsers',
        'Test',
        'Test build consumers',
      ],
    ],
  ];
  for (const [file] of benchmarkPaths) {
    const benchmark = workflow(file).jobs.benchmark;
    for (const [workload, source, names] of commandSets) {
      for (const name of names) {
        const original = step(source, name);
        const measured = step(benchmark, name);
        assert.equal(measured.run, original.run, `${workload}: ${name}`);
        assert.equal(measured.if, `matrix.workload == '${workload}'`);
      }
    }
    assert.equal(
      step(benchmark, 'Setup mise').uses,
      step(unit, 'Setup mise').uses,
    );
    assert.equal(
      step(benchmark, 'Setup Node.js 26.13.1').uses,
      step(typeCheck, 'Setup Node.js 26.13.1').uses,
    );
    assert.deepEqual(
      step(benchmark, 'Setup Node.js 26.13.1').with,
      step(typeCheck, 'Setup Node.js 26.13.1').with,
    );
  }
});
