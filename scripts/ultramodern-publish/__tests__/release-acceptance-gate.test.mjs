// Consumer: publish-security's previous-cohort gate in publish-bleedingdev.yml.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptanceWorkflowPath,
  anchorPackage,
  assessPreviousReleaseAcceptance,
  readPreviousReleaseAcceptance,
} from '../lib/release-acceptance-gate.mjs';

const repository = 'ultramodernjs/ultramodern.js';
const version = '3.11.3-ultramodern.8';
const packument = deprecated => ({
  'dist-tags': { latest: version },
  versions: { [version]: deprecated === undefined ? {} : { deprecated } },
});
const acceptance = (status, conclusion, overrides = {}) => ({
  id: 900,
  path: acceptanceWorkflowPath,
  head_branch: 'main-ultramodern',
  event: 'workflow_dispatch',
  status,
  conclusion,
  created_at: '2026-11-17T12:00:00Z',
  ...overrides,
});

function assess({
  npm = packument(),
  releases = [],
  acceptanceRuns = [],
} = {}) {
  return assessPreviousReleaseAcceptance({
    acceptanceRuns: () => acceptanceRuns,
    packument: npm,
    releaseFor: tag => (releases.includes(tag) ? { tag_name: tag } : null),
    repository,
  });
}

test('the cohort at latest is accepted exactly when its release record exists', () => {
  assert.equal(
    assess({ releases: [`ultramodern-v${version}`] }).status,
    'clear',
  );
  // No live cohort at all, or a package npm does not know yet.
  assert.equal(assess({ npm: null }).status, 'clear');
  assert.equal(assess({ npm: { 'dist-tags': {} } }).status, 'clear');
  // An older cohort's release never stands in for the one at latest.
  assert.equal(
    assess({ releases: ['ultramodern-v3.11.3-ultramodern.7'] }).status,
    'blocked',
  );
});

test('a cohort without a release record blocks whatever its acceptance did', () => {
  for (const [status, conclusion] of [
    ['queued', null],
    ['in_progress', null],
    ['completed', 'failure'],
    ['completed', 'timed_out'],
    ['completed', 'cancelled'],
    ['completed', 'skipped'],
    ['completed', 'startup_failure'],
    // The release record failed after a green outcome: still not recorded.
    ['completed', 'success'],
  ]) {
    const result = assess({ acceptanceRuns: [acceptance(status, conclusion)] });
    assert.equal(result.status, 'blocked', `${status}/${conclusion}`);
    assert.match(result.message, /actions\/runs\/900/u);
  }
  const never = assess();
  assert.equal(never.status, 'blocked');
  assert.match(never.message, /section 5/u);
});

test('runs that are not owner acceptances on main never describe the cohort', () => {
  const result = assess({
    acceptanceRuns: [
      acceptance('in_progress', null, { id: 901, head_branch: 'other' }),
      acceptance('in_progress', null, { id: 902, event: 'push' }),
      acceptance('in_progress', null, {
        id: 903,
        path: '.github/workflows/x.yml',
      }),
      acceptance('completed', 'failure', {
        id: 904,
        created_at: '2026-11-17T11:00:00Z',
      }),
    ],
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /runs\/904 concluded failure/u);
});

test('only deprecating the unaccepted cohort lets a corrected one replace it', () => {
  const result = assess({ npm: packument('Deprecated: use .9') });
  assert.equal(result.status, 'withdrawn');
  assert.match(result.message, /never accepted/u);
  assert.equal(assess({ npm: packument('') }).status, 'blocked');
});

test('the gate reads npm origin and the GitHub API only', async () => {
  const requests = [];
  const fetched = [];
  const result = await readPreviousReleaseAcceptance(
    {
      GITHUB_REPOSITORY: repository,
      GITHUB_SERVER_URL: 'https://github.com',
    },
    {
      api: endpoint => {
        requests.push(endpoint);
        if (endpoint.endsWith(`/releases/tags/ultramodern-v${version}`))
          return null;
        if (endpoint.includes('accept-bleedingdev-release.yml/runs'))
          return { workflow_runs: [acceptance('in_progress', null)] };
        throw new Error(`unexpected ${endpoint}`);
      },
      fetchImpl: async url => {
        fetched.push(url);
        return { ok: true, status: 200, json: async () => packument() };
      },
    },
  );
  assert.equal(result.status, 'blocked');
  assert.deepEqual(fetched, [
    `https://registry.npmjs.org/${encodeURIComponent(anchorPackage)}?write=true`,
  ]);
  assert.deepEqual(requests, [
    `repos/${repository}/releases/tags/ultramodern-v${version}`,
    `repos/${repository}/actions/workflows/accept-bleedingdev-release.yml/runs?branch=main-ultramodern&event=workflow_dispatch&per_page=100`,
  ]);
  await assert.rejects(
    readPreviousReleaseAcceptance(
      { GITHUB_REPOSITORY: repository },
      {
        api: () => assert.fail('npm must answer first'),
        fetchImpl: async () => ({ ok: false, status: 503 }),
      },
    ),
    /HTTP 503/u,
  );
});
