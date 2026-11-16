import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';

const workflows = new URL('../../../.github/workflows/', import.meta.url);
const npmOidcJobs = new Set([
  'publish-bleedingdev.yml:publish',
  'publish-bleedingdev.yml:publish-sidecars',
]);
// Both Depot native attempts lost runner capacity (32 min, 0 artifacts), so
// these three jobs, and only these, use the reviewed GitHub-hosted runner.
const nativeRendererJobs = new Set([
  'native-renderer-artifacts.yml:produce',
  'native-renderer-artifacts.yml:qualify',
  'native-renderer-artifacts.yml:release',
]);
const nativeRendererRunner = 'ubuntu-24.04';

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

function parseWorkflows() {
  return Object.fromEntries(
    fs
      .readdirSync(workflows)
      .filter(name => /\.ya?ml$/u.test(name))
      .map(name => [
        name,
        yaml.load(fs.readFileSync(new URL(name, workflows), 'utf8')),
      ]),
  );
}

// Throws on the first policy violation; returns the exception jobs it admitted.
function admitRunners(parsed) {
  const admitted = new Set();
  for (const [name, workflow] of Object.entries(parsed)) {
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const label = `${name}:${id}`;
      if (job.uses) continue;
      if (npmOidcJobs.has(label)) {
        assertRunner(job['runs-on'], label, { npmOidc: true });
        admitted.add(label);
      } else if (nativeRendererJobs.has(label)) {
        assert.equal(
          job['runs-on'],
          nativeRendererRunner,
          `${label}: reviewed native renderer runner`,
        );
        admitted.add(label);
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
  return admitted;
}

test('every regular job selects Depot except the reviewed npm and native renderer exceptions', () => {
  assert.deepEqual(
    admitRunners(parseWorkflows()),
    new Set([...npmOidcJobs, ...nativeRendererJobs]),
  );
});

test('runner exceptions admit only the exact reviewed jobs and runner', () => {
  const hosted = runner => ({ 'runs-on': runner });
  const cases = [
    {
      name: 'native-renderer-artifacts.yml',
      jobs: { produce: hosted('ubuntu-22.04') },
      message: /reviewed native renderer runner/u,
    },
    {
      name: 'native-renderer-artifacts.yml',
      jobs: { qualify: hosted('depot-ubuntu-24.04-8') },
      message: /reviewed native renderer runner/u,
    },
    {
      name: 'native-renderer-artifacts.yml',
      jobs: { release: hosted('macos-26-intel') },
      message: /reviewed native renderer runner/u,
    },
    {
      name: 'native-renderer-artifacts.yml',
      jobs: { extra: hosted('ubuntu-24.04') },
      message: /use Depot/u,
    },
    {
      name: 'ci.yml',
      jobs: { build: hosted('ubuntu-24.04') },
      message: /use Depot/u,
    },
    {
      name: 'publish-bleedingdev.yml',
      jobs: { other: hosted('ubuntu-24.04') },
      message: /use Depot/u,
    },
  ];
  for (const { name, jobs, message } of cases)
    assert.throws(() => admitRunners({ [name]: { jobs } }), message, name);
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
