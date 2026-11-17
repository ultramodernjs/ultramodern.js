// Consumer: publish-security's previous-cohort gate in publish-bleedingdev.yml.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptanceRunName,
  assessPreviousReleaseAcceptance,
  handoffJobName,
  publicationJobName,
  readPreviousReleaseAcceptance,
} from '../lib/release-acceptance-gate.mjs';

const repository = 'ultramodernjs/ultramodern.js';
const live = { id: 300, status: 'completed' };
const job = (name, conclusion, run_attempt = 1) => ({
  name,
  conclusion,
  run_attempt,
});
const handedOff = [
  job(publicationJobName, 'success', 2),
  job(handoffJobName, 'success', 2),
];
const acceptance = (
  status,
  conclusion,
  id = 900,
  created_at = '2026-11-17T12:00:00Z',
) => ({
  id,
  display_title: acceptanceRunName(live.id),
  status,
  conclusion,
  created_at,
});

function assess({
  publishRuns = [{ id: 400, status: 'in_progress' }, live],
  jobs = { 300: handedOff },
  acceptanceRuns = [],
  artifacts = [],
} = {}) {
  return assessPreviousReleaseAcceptance({
    acceptanceRuns,
    artifactsFor: () => artifacts,
    currentRunId: 400,
    jobsFor: runId => jobs[runId] ?? [],
    publishRuns,
    repository,
  });
}

test('a live cohort waits while the previous cohort is still being accepted', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending']) {
    const result = assess({ acceptanceRuns: [acceptance(status, null)] });
    assert.equal(result.status, 'blocked', status);
    assert.match(result.message, /still/u);
  }
});

test('a cohort that never started or lost its acceptance blocks with the exact re-dispatch', () => {
  const never = assess({
    jobs: {
      300: [
        job(publicationJobName, 'success', 2),
        job(handoffJobName, 'failure', 2),
      ],
    },
    artifacts: [
      {
        name: 'bleedingdev-release-identity-run-300-attempt-1-publication-attempt-2',
      },
    ],
  });
  assert.equal(never.status, 'blocked');
  assert.match(
    never.message,
    /gh workflow run accept-bleedingdev-release\.yml .* -f original_run_id=300 -f producer_run_attempt=1 -f publication_run_attempt=2$/u,
  );
  // Dispatched but not yet listed: still blocks rather than racing it.
  assert.equal(assess().status, 'blocked');
  const cancelled = assess({
    acceptanceRuns: [acceptance('completed', 'cancelled')],
  });
  assert.equal(cancelled.status, 'blocked');
  assert.match(cancelled.message, /cancelled/u);
});

test('a red acceptance never blocks the corrected cohort, but is reported', () => {
  for (const conclusion of ['failure', 'timed_out', 'startup_failure']) {
    const result = assess({
      acceptanceRuns: [acceptance('completed', conclusion)],
    });
    assert.equal(result.status, 'failed', conclusion);
    assert.match(result.message, /not accepted/u);
  }
});

test('the newest acceptance of the newest live cohort decides', () => {
  assert.equal(
    assess({ acceptanceRuns: [acceptance('completed', 'success')] }).status,
    'clear',
  );
  // An owner re-run that passed after a red one clears the gate.
  assert.equal(
    assess({
      acceptanceRuns: [
        acceptance('completed', 'failure', 901, '2026-11-17T12:00:00Z'),
        acceptance('completed', 'success', 902, '2026-11-17T13:00:00Z'),
      ],
    }).status,
    'clear',
  );
  // Another run's acceptance never stands in for this cohort's.
  assert.equal(
    assess({
      acceptanceRuns: [
        {
          ...acceptance('completed', 'success'),
          display_title: acceptanceRunName(299),
        },
      ],
    }).status,
    'blocked',
  );
});

test('dry runs, failed publications and in-run acceptance do not hold a cohort', () => {
  // Only a run whose publish job passed is a live cohort.
  assert.equal(
    assess({
      publishRuns: [{ id: 301, status: 'completed' }, live],
      jobs: {
        301: [job(publicationJobName, 'skipped')],
        300: [
          job(publicationJobName, 'success'),
          job('Accept the exact published registry cohort', 'success'),
        ],
      },
    }).status,
    'clear',
  );
  assert.equal(
    assess({
      publishRuns: [{ id: 302, status: 'completed' }],
      jobs: { 302: [job(publicationJobName, 'failure')] },
    }).status,
    'clear',
  );
});

test('the gate reads runs through the GitHub API only', () => {
  const requests = [];
  const result = readPreviousReleaseAcceptance(
    {
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: '400',
      GITHUB_SERVER_URL: 'https://github.com',
    },
    endpoint => {
      requests.push(endpoint);
      if (endpoint.includes('publish-bleedingdev.yml/runs'))
        return { workflow_runs: [live] };
      if (endpoint.includes('accept-bleedingdev-release.yml/runs'))
        return { workflow_runs: [acceptance('completed', 'success')] };
      if (endpoint.endsWith('/jobs?filter=latest&per_page=100'))
        return { jobs: handedOff };
      throw new Error(`unexpected ${endpoint}`);
    },
  );
  assert.equal(result.status, 'clear');
  assert.deepEqual(requests, [
    `repos/${repository}/actions/workflows/accept-bleedingdev-release.yml/runs?per_page=100`,
    `repos/${repository}/actions/workflows/publish-bleedingdev.yml/runs?branch=main-ultramodern&event=workflow_dispatch&per_page=30`,
    `repos/${repository}/actions/runs/300/jobs?filter=latest&per_page=100`,
  ]);
});
