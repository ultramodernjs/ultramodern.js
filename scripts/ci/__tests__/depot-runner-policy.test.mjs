import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';

const workflows = new URL('../../../.github/workflows/', import.meta.url);
const npmOidcJobs = new Set([
  'publish-bleedingdev.yml:publish',
  'publish-bleedingdev.yml:publish-sidecars',
]);

function assertRunner(value, label, { npmOidc = false } = {}) {
  assert.equal(typeof value, 'string', `${label}: runner must be explicit`);
  if (npmOidc) {
    assert.equal(
      value,
      'ubuntu-24.04',
      `${label}: npm requires GitHub-hosted OIDC`,
    );
    return;
  }
  // Every runner this repository selects is a Depot label. A `depot-` label
  // anywhere in the expression used to be enough, which silently permitted
  // `vars.DEPOT_LINUX_RUNNER || 'ubuntu-24.04'` and the fork-isolation
  // `&& 'ubuntu-latest' ||` prefixes, so every literal in the expression is
  // checked instead: an unreachable GitHub-hosted fallback is still a job that
  // can land on different hardware.
  assert.match(
    value,
    /depot-|vars\.DEPOT_/u,
    `${label}: use Depot; every runner label in this repository is a Depot label`,
  );
  for (const [, release] of value.matchAll(/depot-ubuntu-(\d+\.\d+)/gu)) {
    assert.ok(
      Number(release) >= 24.04,
      `${label}: Ubuntu 24.04 is the minimum`,
    );
  }
  const hosted = [
    ...value.matchAll(
      /(?<![\w-])(?:ubuntu|macos|windows)-(?:latest|\d[\w.-]*)/giu,
    ),
  ].map(([literal]) => literal);
  assert.deepEqual(
    hosted,
    [],
    `${label}: ${hosted.join(', ')} is a GitHub-hosted label; use a Depot label, including in every fallback`,
  );
}

test('every regular job selects Depot except the two npm trusted-publisher jobs', () => {
  const foundNpmJobs = new Set();
  for (const name of fs
    .readdirSync(workflows)
    .filter(name => /\.ya?ml$/u.test(name))) {
    const workflow = yaml.load(
      fs.readFileSync(new URL(name, workflows), 'utf8'),
    );
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const label = `${name}:${id}`;
      if (job.uses) continue;
      if (npmOidcJobs.has(label)) {
        assertRunner(job['runs-on'], label, { npmOidc: true });
        foundNpmJobs.add(label);
      } else if (job['runs-on'] === '${{ matrix.runner }}') {
        const entries = job.strategy?.matrix?.include;
        assert(
          Array.isArray(entries) && entries.length,
          `${label}: missing runner matrix`,
        );
        for (const entry of entries) assertRunner(entry.runner, label);
      } else {
        assertRunner(job['runs-on'], label);
      }
    }
  }
  assert.deepEqual(foundNpmJobs, npmOidcJobs);
});

test('runner policy rejects the old compiler and acceptance defaults', () => {
  for (const runner of ['ubuntu-24.04', 'macos-26-intel', 'windows-latest'])
    assert.throws(() => assertRunner(runner, 'regression'), /use Depot/u);
  // A GitHub-hosted fallback behind a Depot variable is the pattern that
  // survived the first sweep, so it is a named negative control.
  for (const runner of [
    "${{ vars.DEPOT_LINUX_RUNNER || 'ubuntu-24.04' }}",
    "${{ vars.DEPOT_MACOS_RUNNER || 'macos-26' }}",
    '${{ vars.DEPOT_LINUX_RUNNER || fromJSON(vars.SELF_LINUX_LABELS || \'"ubuntu-latest"\') }}',
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest' || vars.DEPOT_LINUX_RUNNER || 'depot-ubuntu-24.04-8' }}",
  ])
    assert.throws(
      () => assertRunner(runner, 'regression'),
      /GitHub-hosted label/u,
      runner,
    );
  assert.doesNotThrow(() => assertRunner('depot-ubuntu-24.04-arm-8', 'arm64'));
  for (const runner of [
    "${{ vars.DEPOT_LINUX_RUNNER || 'depot-ubuntu-24.04-8' }}",
    "${{ vars.DEPOT_WINDOWS_RUNNER || 'depot-windows-2025-8' }}",
    "${{ vars.DEPOT_MACOS_RUNNER || 'depot-macos-26' }}",
  ])
    assert.doesNotThrow(() => assertRunner(runner, 'owned'), runner);
});

test('Depot Linux images retain the Ubuntu 24.04 minimum', () => {
  assert.throws(
    () => assertRunner('depot-ubuntu-22.04-8', 'old'),
    /24.04 is the minimum/u,
  );
  assert.doesNotThrow(() => assertRunner('depot-ubuntu-24.04-16', 'current'));
});

test('native provider comparisons are manual-only, not automatic duplicates of required Depot-backed checks', () => {
  const native = new URL('../../../.depot/workflows/', import.meta.url);
  const files = fs.readdirSync(native).filter(file => /\.ya?ml$/u.test(file));
  assert.ok(files.length > 0);
  for (const file of files) {
    const workflow = yaml.load(fs.readFileSync(new URL(file, native), 'utf8'));
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'], file);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (job['runs-on'] === `\${{ matrix.runner }}`) {
        for (const entry of job.strategy.matrix.include)
          assertRunner(entry.runner, `${file}:${id}`);
      } else {
        assertRunner(job['runs-on'], `${file}:${id}`);
      }
    }
  }
});
