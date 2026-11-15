import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedHostedJob } from './hosted-job.mjs';

const depot = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'self-hosted',
  RUNNER_NAME: 'depot-control-123',
};

test('accepts GitHub-hosted and the observed Depot GHA identity', () => {
  assert(
    isSupportedHostedJob({
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
    }),
  );
  assert(isSupportedHostedJob(depot));
});

test('does not treat a name, generic self-hosted opt-in or malformed context as a hosted job', () => {
  for (const env of [
    {},
    { RUNNER_NAME: depot.RUNNER_NAME },
    { ...depot, GITHUB_ACTIONS: true },
    { ...depot, GITHUB_ACTIONS: 'false' },
    { ...depot, GITHUB_ACTIONS: undefined },
    { ...depot, RUNNER_ENVIRONMENT: undefined },
    { ...depot, RUNNER_ENVIRONMENT: 'depot' },
    ...[
      undefined,
      null,
      42,
      '',
      'depot-',
      'self-hosted',
      'other-depot-control',
      'Depot-control',
      'depot-control/path',
      'depot-control\n',
      'depot-control\r',
      'depot-control ',
      `depot-${'x'.repeat(130)}`,
    ].map(RUNNER_NAME => ({ ...depot, RUNNER_NAME })),
  ])
    assert.equal(isSupportedHostedJob(env), false, JSON.stringify(env));
});
