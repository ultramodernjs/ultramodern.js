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
  assert.match(
    value,
    /depot-|vars\.DEPOT_/u,
    `${label}: use Depot; preserve only explicit fork-isolation or benchmark exceptions`,
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
  assert.doesNotThrow(() => assertRunner('depot-ubuntu-22.04-arm-8', 'arm64'));
  assert.doesNotThrow(() =>
    assertRunner(
      "${{ vars.DEPOT_LINUX_RUNNER || 'depot-ubuntu-24.04-8' }}",
      'owned',
    ),
  );
});
