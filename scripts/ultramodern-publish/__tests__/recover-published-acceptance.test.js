const assert = require('node:assert/strict');
const test = require('node:test');

const repository = 'ultramodernjs/ultramodern.js';
const repositoryId = 1151231350;
const runId = '39078116263';
const attempt = '1';
const sourceCommit = '10a6ecde904554e3e0db1eaf56d0d4a5f350a04a';
const requiredJobs = [
  'Validate publish security',
  'Test the release source and publication tooling',
  'Build the immutable @bleedingdev release bundle',
  'Confirm qualified source and integration',
  'Rehearse Tractor against the immutable bundle / Exact cohort passes Tractor Node and workerd acceptance',
  'Clean-room acceptance of the immutable release bundle / Clean-room acceptance of the immutable release bundle',
  'Publish the qualified stable sidecars',
  'Publish accepted @bleedingdev tarballs',
  'Accept the exact published registry cohort',
];

async function fixture() {
  const api = await import('../recover-published-acceptance.mjs');
  const run = {
    id: Number(runId),
    run_attempt: 1,
    repository: { full_name: repository, id: repositoryId },
    head_repository: { id: repositoryId },
    path: '.github/workflows/publish-bleedingdev.yml',
    head_branch: 'main-ultramodern',
    head_sha: sourceCommit,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
    actor: { login: 'BleedingDev' },
    triggering_actor: { login: 'BleedingDev' },
  };
  const job = (name, conclusion) => ({
    name,
    conclusion,
    status: 'completed',
    run_id: Number(runId),
    run_attempt: 1,
    head_sha: sourceCommit,
  });
  const jobs = [
    ...requiredJobs.map(name => job(name, 'success')),
    job(
      'Accept the exact published cohort in Tractor / Exact cohort passes Tractor Node and workerd acceptance',
      'failure',
    ),
    job('Publish the cohort change record', 'skipped'),
  ];
  const names = api.recoveryArtifactNames(runId, attempt);
  const artifacts = [names.identity, names.qualification, names.published].map(
    name => ({
      name,
      expired: false,
      digest: `sha256:${'a'.repeat(64)}`,
      workflow_run: {
        id: Number(runId),
        head_sha: sourceCommit,
        repository_id: repositoryId,
        head_repository_id: repositoryId,
      },
    }),
  );
  const release = {
    source: { repository, commit: sourceCommit },
    release: { version: '3.9.3-ultramodern.8', tag: 'latest' },
    manifestSha256: 'b'.repeat(64),
    cohortDigest: 'c'.repeat(64),
  };
  const identity = {
    schema: 'bleedingdev.ultramodern.published-release-identity',
    schemaVersion: 2,
    dryRun: false,
    releaseRunId: runId,
    publicationRunAttempt: attempt,
    producerRunAttempt: attempt,
    producerArtifactIdentity: `run-${runId}-attempt-${attempt}`,
    producerRunIdentity: `github:${repository}:run:${runId}:attempt:${attempt}`,
    source: release.source,
    release: release.release,
    manifestSha256: release.manifestSha256,
    cohortDigest: release.cohortDigest,
    acceptanceReceiptSha256: 'd'.repeat(64),
  };
  return {
    api,
    run,
    jobs,
    artifacts,
    release,
    identity,
    expected: {
      runId,
      attempt,
      receiptSha256: identity.acceptanceReceiptSha256,
    },
  };
}

test('only the completed original fork publication with successful ERP can recover Tractor', async () => {
  const { api, run, jobs, artifacts, expected } = await fixture();
  assert.equal(
    api.assertRecoverablePublication(run, jobs, artifacts, expected).identity,
    `bleedingdev-release-identity-run-${runId}-attempt-1-publication-attempt-1`,
  );
  for (const patch of [
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { status: 'in_progress' },
    { conclusion: 'success' },
    { run_attempt: 2 },
    { path: '.github/workflows/other.yml' },
    { repository: { full_name: repository, id: 99 } },
    { head_repository: { id: 99 } },
    { actor: { login: 'someone-else' } },
    { triggering_actor: { login: 'someone-else' } },
  ])
    assert.throws(() =>
      api.assertRecoverablePublication(
        { ...run, ...patch },
        jobs,
        artifacts,
        expected,
      ),
    );
  for (const patch of [
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { run_attempt: 2 },
    { head_sha: 'e'.repeat(40) },
  ]) {
    const changed = jobs.map(job =>
      job.name === 'Accept the exact published registry cohort'
        ? { ...job, ...patch }
        : job,
    );
    assert.throws(() =>
      api.assertRecoverablePublication(run, changed, artifacts, expected),
    );
  }
  assert.throws(
    () =>
      api.assertRecoverablePublication(
        run,
        [...jobs, jobs[0]],
        artifacts,
        expected,
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      api.assertRecoverablePublication(run, jobs.slice(1), artifacts, expected),
    /Missing/,
  );
});

test('expired, duplicate, wrong-source and foreign-run artifacts fail closed', async () => {
  const { api, run, jobs, artifacts, expected } = await fixture();
  for (const patch of [
    { expired: true },
    { digest: undefined },
    { workflow_run: { ...artifacts[0].workflow_run, id: 99 } },
    {
      workflow_run: { ...artifacts[0].workflow_run, head_sha: 'f'.repeat(40) },
    },
    { workflow_run: { ...artifacts[0].workflow_run, head_repository_id: 99 } },
  ])
    assert.throws(() =>
      api.assertRecoverablePublication(
        run,
        jobs,
        [{ ...artifacts[0], ...patch }, ...artifacts.slice(1)],
        expected,
      ),
    );
  assert.throws(
    () =>
      api.assertRecoverablePublication(
        run,
        jobs,
        [...artifacts, artifacts[0]],
        expected,
      ),
    /duplicate/,
  );
});

test('the original published identity cannot be relabeled as a recovery invocation', async () => {
  const { api, release, identity, expected } = await fixture();
  api.assertOriginalPublishedIdentity(identity, release, expected);
  for (const patch of [
    { releaseRunId: '999' },
    { publicationRunAttempt: '2' },
    { producerRunAttempt: '2' },
    { producerArtifactIdentity: 'run-999-attempt-1' },
    { producerRunIdentity: `github:${repository}:run:999:attempt:1` },
    { source: { ...release.source, commit: 'e'.repeat(40) } },
    { manifestSha256: 'e'.repeat(64) },
    { cohortDigest: 'e'.repeat(64) },
    { acceptanceReceiptSha256: 'e'.repeat(64) },
    { dryRun: true },
  ])
    assert.throws(() =>
      api.assertOriginalPublishedIdentity(
        { ...identity, ...patch },
        release,
        expected,
      ),
    );
});

test('registry verification keeps the original signed invocation and refuses missing packages', async () => {
  const { api, release, expected } = await fixture();
  const environment = {
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: String(repositoryId),
    GITHUB_REF: 'refs/heads/main-ultramodern',
    GITHUB_RUN_ID: '999',
    GITHUB_RUN_ATTEMPT: '2',
  };
  const expectation = api.originalRegistryExpectation(
    release,
    environment,
    expected,
  );
  assert.deepEqual(expectation.invocation, {
    repository,
    runId,
    runAttempt: attempt,
  });
  assert.equal(expectation.source.commit, sourceCommit);
  assert.equal(environment.GITHUB_RUN_ID, '999');
  const packages = [
    { targetName: '@bleedingdev/a' },
    { targetName: '@bleedingdev/b' },
  ];
  const states = new Map(
    packages.map(item => [item.targetName, { exists: true }]),
  );
  api.assertCompletePublishedRegistry(states, { packages });
  states.set(packages[1].targetName, { exists: false });
  assert.throws(
    () => api.assertCompletePublishedRegistry(states, { packages }),
    /cannot publish missing/,
  );
  states.delete(packages[1].targetName);
  assert.throws(() =>
    api.assertCompletePublishedRegistry(states, { packages }),
  );
});

test('record-only retries retain the actual successful Tractor attempt', async () => {
  const { api } = await fixture();
  const baseline = '1'.repeat(40);
  const artifactName = `ultramodern-tractor-downstream-acceptance-${baseline}-attempt-1`;
  const options = {
    baseline,
    artifactName,
    runId: '999',
    runAttempt: '2',
    sourceCommit: '2'.repeat(40),
    jobs: [
      {
        name: 'Recover only the missing published Tractor acceptance / Exact cohort passes Tractor Node and workerd acceptance',
        status: 'completed',
        conclusion: 'success',
        run_id: 999,
        run_attempt: 1,
        head_sha: '2'.repeat(40),
      },
    ],
    artifacts: [
      {
        name: artifactName,
        expired: false,
        digest: `sha256:${'a'.repeat(64)}`,
        workflow_run: {
          id: 999,
          head_sha: '2'.repeat(40),
          repository_id: repositoryId,
          head_repository_id: repositoryId,
        },
      },
    ],
  };
  assert.equal(api.assertRecoveredTractorExecution(options), 1);
  for (const patch of [
    { conclusion: 'failure' },
    { run_attempt: 2 },
    { run_id: 123 },
    { head_sha: sourceCommit },
  ]) {
    assert.throws(() =>
      api.assertRecoveredTractorExecution({
        ...options,
        jobs: [{ ...options.jobs[0], ...patch }],
      }),
    );
  }
  assert.throws(() =>
    api.assertRecoveredTractorExecution({ ...options, runAttempt: '0' }),
  );
  assert.throws(() =>
    api.assertRecoveredTractorExecution({ ...options, artifacts: [] }),
  );
  assert.throws(() =>
    api.assertRecoveredTractorExecution({
      ...options,
      artifactName: artifactName.replace('-attempt-1', '-attempt-3'),
    }),
  );
});
