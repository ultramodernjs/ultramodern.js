import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// Use the prebundler's declared parser without requiring generated framework output.
const require = createRequire(
  new URL('../prebundle/package.json', import.meta.url),
);
const yaml = require('js-yaml');

const workflow = yaml.load(
  readFileSync(
    new URL('../../.github/workflows/ut-macOS.yml', import.meta.url),
    'utf8',
  ),
);

test('macOS units stay in the PR-associated check suite', () => {
  assert.deepEqual(workflow.on.pull_request.branches, [
    'main',
    'main-ultramodern',
  ]);
  assert.equal(
    workflow.concurrency.group,
    `\${{ github.workflow }}-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.ref }}`,
  );
});

// Every job of this repository runs on Depot. The former `ci:github-hosted-macos`
// label and the `runner_backend` dispatch input selected GitHub-hosted macOS,
// which is exactly what this check must no longer be able to do: a blocked
// Depot pool has to block the required check, not move it to other hardware.
test('the macOS units select Depot with no GitHub-hosted escape', () => {
  assert.equal(
    workflow.jobs['ut-mac']['runs-on'],
    `\${{ vars.DEPOT_MACOS_RUNNER || 'depot-macos-26' }}`,
  );
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.equal(workflow.on.pull_request.types, undefined);
  const source = readFileSync(
    new URL('../../.github/workflows/ut-macOS.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /runner_backend|ci:github-hosted-macos/u);
  assert.doesNotMatch(source, /macos-26(?!-)(?<!depot-macos-26)/u);
});

const job = workflow.jobs['ut-mac'];

function step(name) {
  const found = job.steps.find(candidate => candidate.name === name);
  assert.ok(found, `ut-mac must have a "${name}" step`);
  return found;
}

// The workflow is one Depot job. A failed step fails the job, so the required
// context is the job itself: no shard fan-out, no gate job, nothing that can
// pass over a failure.
test('the macOS suite is one job with no shard fan-out or gate', () => {
  assert.deepEqual(Object.keys(workflow.jobs), ['ut-mac']);
  assert.equal(job.if, undefined);
  assert.equal(job.needs, undefined);
  assert.equal(job.strategy, undefined);
  for (const candidate of job.steps) {
    assert.notEqual(
      candidate['continue-on-error'],
      true,
      `"${candidate.name}" must fail the job when it fails`,
    );
  }
  assert.equal(
    step('Test').run,
    'pnpm run test:ut:prepared --pool.maxWorkers=6',
  );
  assert.equal(step('Test').if, undefined);
});

// A prepared-build cache miss must rebuild the required packages before tests.
test('a prepared-build cache miss rebuilds the required packages', () => {
  const restore = step('Restore prepared build outputs');
  assert.equal(restore.id, 'build-cache');
  assert.equal(restore.uses, './.github/actions/restore-build-cache');
  assert.equal(
    step('Build Required Pkg').if,
    "steps.build-cache.outputs.cache-hit != 'true'",
  );
  assert.equal(step('Build Required Pkg').run, 'pnpm run build:required');
});

// A Playwright browser cache miss must still install the browsers. There is no
// `if` on the install: playwright install is a no-op for browsers the cache
// already restored, so running it always is the recovery path on a miss.
test('a Playwright browser cache miss still installs the browsers', () => {
  const resolve = step('Resolve Playwright runtime');
  assert.equal(resolve.id, 'browser-runtime');
  assert.equal(
    resolve.run,
    'node scripts/lib/browser-provisioning.js --resolve --runtime tests/integration/rstest/basic-app-rstest-browser',
  );
  const restore = step('Restore Playwright browser cache');
  assert.equal(
    restore.with.path,
    `\${{ steps.browser-runtime.outputs.cache_path }}`,
  );
  assert.equal(
    restore.with.key,
    `\${{ steps.browser-runtime.outputs.cache_key }}`,
  );
  const install = step('Install Playwright browsers');
  assert.equal(install.if, undefined);
  assert.equal(
    install.run,
    `node scripts/lib/browser-provisioning.js --install --runtime tests/integration/rstest/basic-app-rstest-browser --version \${{ steps.browser-runtime.outputs.version }}`,
  );
});

test('the macOS steps run in dependency order', () => {
  const names = [
    'Install Dependencies',
    'Restore prepared build outputs',
    'Build Required Pkg',
    'Resolve Playwright runtime',
    'Restore Playwright browser cache',
    'Install Playwright browsers',
    'Test',
  ];
  const indexes = names.map(name => {
    const index = job.steps.findIndex(candidate => candidate.name === name);
    assert.notEqual(index, -1, `ut-mac must have a "${name}" step`);
    return index;
  });
  assert.deepEqual(
    indexes,
    [...indexes].sort((a, b) => a - b),
  );
});
