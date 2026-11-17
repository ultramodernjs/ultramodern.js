import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from '../../packages/toolkit/utils/compiled/js-yaml/index.js';

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

test('one Mac executes the entire suite with eight workers and no selection filter', () => {
  assert.deepEqual(Object.keys(workflow.jobs), ['ut-mac']);
  const job = workflow.jobs['ut-mac'];
  assert.equal(job.if, undefined);
  assert.equal(job.needs, undefined);
  assert.equal(job.strategy, undefined);
  assert.equal(
    job.steps.find(step => step.name === 'Test').run,
    '/usr/bin/time -l pnpm run test:ut:prepared --pool.maxWorkers=8',
  );
  assert.ok(!job.steps.some(step => step['continue-on-error']));
  assert.ok(
    !job.steps.some(step => step.run?.includes('browser-provisioning')),
  );
  assert.equal(
    job.steps.find(step => step.name === 'Restore installed dependencies').with[
      'store-required'
    ],
    'false',
  );
  assert.equal(
    job.steps.find(step => step.name === 'Install Dependencies').run,
    'pnpm install --frozen-lockfile',
  );
  assert.equal(
    job.steps.find(step => step.name === 'Build Required Pkg').if,
    "steps.build-cache.outputs.cache-hit != 'true'",
  );
});
