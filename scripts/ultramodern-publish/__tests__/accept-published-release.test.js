const assert = require('node:assert/strict');
const test = require('node:test');

const repository = 'ultramodernjs/ultramodern.js';
const repositoryId = 1151231350;
const runId = '39078116263';
const producerAttempt = '1';
const publicationAttempt = '2';
const sourceCommit = '10a6ecde904554e3e0db1eaf56d0d4a5f350a04a';
const publicationJobs = [
  'Publish the qualified stable sidecars',
  'Publish accepted @bleedingdev tarballs',
];

async function fixture() {
  const api = await import('../accept-published-release.mjs');
  // The automatic acceptance authorizes while the original run is still
  // finishing start-release-acceptance.
  const run = {
    id: Number(runId),
    run_attempt: 2,
    repository: { full_name: repository, id: repositoryId },
    head_repository: { id: repositoryId },
    path: '.github/workflows/publish-bleedingdev.yml',
    head_branch: 'main-ultramodern',
    head_sha: sourceCommit,
    event: 'workflow_dispatch',
    status: 'in_progress',
    conclusion: null,
    actor: { login: 'BleedingDev' },
    triggering_actor: { login: 'BleedingDev' },
  };
  const job = (name, conclusion) => ({
    name,
    conclusion,
    status: 'completed',
    run_id: Number(runId),
    run_attempt: 2,
    head_sha: sourceCommit,
  });
  const jobs = [
    ...publicationJobs.map(name => job(name, 'success')),
    {
      ...job('Start the published release acceptance', null),
      status: 'in_progress',
    },
  ];
  const expected = { runId, producerAttempt, publicationAttempt };
  const names = api.acceptanceArtifactNames(expected);
  const artifacts = [
    {
      name: names.identity,
      expired: false,
      digest: `sha256:${'a'.repeat(64)}`,
      workflow_run: {
        id: Number(runId),
        head_sha: sourceCommit,
        repository_id: repositoryId,
        head_repository_id: repositoryId,
      },
    },
  ];
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
    publicationRunAttempt: publicationAttempt,
    producerRunAttempt: producerAttempt,
    producerArtifactIdentity: `run-${runId}-attempt-${producerAttempt}`,
    producerRunIdentity: `github:${repository}:run:${runId}:attempt:${producerAttempt}`,
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
    expected: { ...expected, receiptSha256: identity.acceptanceReceiptSha256 },
  };
}

test('artifact names keep the producer and publication attempts apart', async () => {
  const { api } = await fixture();
  assert.deepEqual(
    api.acceptanceArtifactNames({
      runId,
      producerAttempt: '1',
      publicationAttempt: '2',
    }),
    {
      identity: `bleedingdev-release-identity-run-${runId}-attempt-1-publication-attempt-2`,
      bundle: `bleedingdev-accepted-publication-run-${runId}-attempt-1-publication-attempt-2`,
    },
  );
  assert.throws(() =>
    api.acceptanceArtifactNames({
      runId,
      producerAttempt: '0',
      publicationAttempt: '1',
    }),
  );
});

test('only an owner-dispatched main publish whose npm jobs passed in the publication attempt is accepted', async () => {
  const { api, run, jobs, artifacts, expected } = await fixture();
  assert.equal(
    api.assertPublishedRun(run, jobs, artifacts, expected).identity,
    `bleedingdev-release-identity-run-${runId}-attempt-1-publication-attempt-2`,
  );
  // Finished, red only in its handoff, or re-run later: npm still holds it.
  for (const patch of [
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'failure' },
    { run_attempt: 3 },
  ])
    api.assertPublishedRun({ ...run, ...patch }, jobs, artifacts, expected);
  for (const patch of [
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { run_attempt: 1 },
    { path: '.github/workflows/other.yml' },
    { repository: { full_name: repository, id: 99 } },
    { head_repository: { id: 99 } },
    { actor: { login: 'someone-else' } },
    { triggering_actor: { login: 'someone-else' } },
    { actor: { login: 'github-actions[bot]' } },
  ])
    assert.throws(
      () =>
        api.assertPublishedRun({ ...run, ...patch }, jobs, artifacts, expected),
      undefined,
      JSON.stringify(patch),
    );
  for (const name of publicationJobs)
    for (const patch of [
      { conclusion: 'failure' },
      { conclusion: 'skipped' },
      { status: 'in_progress' },
      { run_attempt: 1 },
      { head_sha: 'e'.repeat(40) },
    ]) {
      const changed = jobs.map(job =>
        job.name === name ? { ...job, ...patch } : job,
      );
      assert.throws(
        () => api.assertPublishedRun(run, changed, artifacts, expected),
        undefined,
        `${name} ${JSON.stringify(patch)}`,
      );
    }
  assert.throws(
    () => api.assertPublishedRun(run, [...jobs, jobs[0]], artifacts, expected),
    /duplicate/,
  );
  assert.throws(
    () => api.assertPublishedRun(run, jobs.slice(1), artifacts, expected),
    /Missing/,
  );
  // The bundle can never come from a later attempt than its publication.
  assert.throws(
    () =>
      api.assertPublishedRun(run, jobs, artifacts, {
        ...expected,
        producerAttempt: '3',
        publicationAttempt: '2',
      }),
    /producer attempt cannot follow/,
  );
});

test('expired, duplicate, wrong-source and foreign-run identity artifacts fail closed', async () => {
  const { api, run, jobs, artifacts, expected } = await fixture();
  for (const patch of [
    { expired: true },
    { digest: undefined },
    { name: `${artifacts[0].name.replace('attempt-2', 'attempt-1')}` },
    { workflow_run: { ...artifacts[0].workflow_run, id: 99 } },
    {
      workflow_run: { ...artifacts[0].workflow_run, head_sha: 'f'.repeat(40) },
    },
    { workflow_run: { ...artifacts[0].workflow_run, head_repository_id: 99 } },
  ])
    assert.throws(() =>
      api.assertPublishedRun(
        run,
        jobs,
        [{ ...artifacts[0], ...patch }],
        expected,
      ),
    );
  assert.throws(
    () =>
      api.assertPublishedRun(run, jobs, [...artifacts, artifacts[0]], expected),
    /duplicate/,
  );
});

test('the acceptance run is dispatched by the owner or by start-release-acceptance only', async () => {
  const { api } = await fixture();
  const environment = { GITHUB_SHA: '3'.repeat(40), GITHUB_RUN_ATTEMPT: '1' };
  const executor = {
    repository: { id: repositoryId },
    head_repository: { id: repositoryId },
    path: '.github/workflows/accept-bleedingdev-release.yml',
    event: 'workflow_dispatch',
    head_branch: 'main-ultramodern',
    head_sha: environment.GITHUB_SHA,
    actor: { login: 'github-actions[bot]' },
    triggering_actor: { login: 'github-actions[bot]' },
    run_attempt: 1,
  };
  api.assertAcceptanceExecutor(executor, environment);
  // The owner re-runs the automatic run, or dispatches it again.
  api.assertAcceptanceExecutor(
    { ...executor, triggering_actor: { login: 'BleedingDev' } },
    environment,
  );
  api.assertAcceptanceExecutor(
    {
      ...executor,
      actor: { login: 'BleedingDev' },
      triggering_actor: { login: 'BleedingDev' },
    },
    environment,
  );
  for (const patch of [
    { actor: { login: 'someone-else' } },
    { triggering_actor: { login: 'someone-else' } },
    { path: '.github/workflows/recover-bleedingdev-acceptance.yml' },
    { event: 'workflow_run' },
    { head_branch: 'feature' },
    { head_sha: '4'.repeat(40) },
    { head_repository: { id: 99 } },
    { run_attempt: 2 },
  ])
    assert.throws(
      () => api.assertAcceptanceExecutor({ ...executor, ...patch }, environment),
      undefined,
      JSON.stringify(patch),
    );
});

test('the original published identity cannot be relabeled as the acceptance invocation', async () => {
  const { api, release, identity, expected } = await fixture();
  api.assertOriginalPublishedIdentity(identity, release, expected);
  for (const patch of [
    { releaseRunId: '999' },
    { publicationRunAttempt: '1' },
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
  const expectation = api.originalRegistryExpectation(release, environment, {
    runId,
    attempt: publicationAttempt,
  });
  assert.deepEqual(expectation.invocation, {
    repository,
    runId,
    runAttempt: publicationAttempt,
    exactAttempt: true,
  });
  assert.equal(expectation.source.commit, sourceCommit);
  assert.equal(environment.GITHUB_RUN_ID, '999');
  // A recovery publish signs its own later HEAD, not the manifest commit.
  const recoveryHead = '5'.repeat(40);
  assert.equal(
    api.originalRegistryExpectation(release, environment, {
      runId,
      attempt: publicationAttempt,
      sourceCommit: recoveryHead,
    }).source.commit,
    recoveryHead,
  );
  assert.throws(() =>
    api.originalRegistryExpectation(release, environment, {
      runId,
      attempt: publicationAttempt,
      sourceCommit: 'main',
    }),
  );
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
  const existing = new Map(
    packages.map(item => [item.targetName, { exists: true }]),
  );
  await assert.rejects(
    api.verifyOriginalPublicationProvenance({ packages }, existing, {
      ...expectation,
      source: { repository },
    }),
    /Original signed source commit/,
  );
  await assert.rejects(
    api.verifyOriginalPublicationProvenance({ packages }, existing, {
      ...expectation,
      invocation: { ...expectation.invocation, exactAttempt: false },
    }),
    /Original signed attempt must be exact/,
  );
});

test('the cohort verifier waits for a package npm does not show yet, then authenticates its exact invocation', async () => {
  const { api, release } = await fixture();
  const { validateRegistryCohort, verifyRegistryPackage } = await import(
    '../lib/prepare-bleedingdev-packages/registry.mjs'
  );
  const packages = ['a', 'b'].map(name => ({
    targetName: `@bleedingdev/${name}`,
    version: release.release.version,
  }));
  const cohort = { ...release, packages };
  const expectation = api.originalRegistryExpectation(
    release,
    { GITHUB_REPOSITORY: repository },
    { runId, attempt: publicationAttempt },
  );
  const reads = new Map();
  const waits = [];
  let authenticated;
  const result = await api.verifyPublishedCohort(cohort, expectation, {
    validate: (manifest, options) =>
      validateRegistryCohort(manifest, options, {
        verifyRegistryDistTag: async (_name, tag, version) => {
          assert.equal(tag, 'latest');
          assert.equal(version, release.release.version);
        },
        verifyRegistryPackage: (item, polled, { deadline }) =>
          verifyRegistryPackage(item, polled, {
            deadline,
            // npm lists `b` only on its third read.
            lookupRegistryPackageDist: async name => {
              const count = (reads.get(name) ?? 0) + 1;
              reads.set(name, count);
              return name.endsWith('/b') && count < 3 ? null : { name };
            },
            verifyRegistryPackageDist: async (
              _item,
              dist,
              polledExpectation,
            ) => {
              assert.equal(polledExpectation, expectation);
              return dist;
            },
            wait: async delay => waits.push(delay),
          }),
      }),
    authenticate: (manifest, states, exact) => {
      authenticated = { manifest, states, exact };
      return 'authenticated';
    },
  });
  assert.equal(result, 'authenticated');
  assert.equal(reads.get('@bleedingdev/a'), 1);
  assert.equal(reads.get('@bleedingdev/b'), 3);
  assert.equal(waits.length, 2);
  assert.equal(authenticated.manifest, cohort);
  assert.equal(authenticated.exact, expectation);
  assert.deepEqual(
    [...authenticated.states],
    packages.map(item => [
      item.targetName,
      { exists: true, dist: { name: item.targetName } },
    ]),
  );
  // A package npm never shows fails the run instead of being skipped.
  await assert.rejects(
    api.verifyPublishedCohort(cohort, expectation, {
      validate: (manifest, options) =>
        validateRegistryCohort(manifest, options, {
          verifyRegistryDistTag: async () => {},
          verifyRegistryPackage: (item, polled, { deadline }) =>
            verifyRegistryPackage(item, polled, {
              deadline,
              lookupRegistryPackageDist: async name =>
                name.endsWith('/b') ? null : { name },
              verifyRegistryPackageDist: async (_item, dist) => dist,
              wait: async () => {},
            }),
        }),
      authenticate: () => assert.fail('nothing missing may be authenticated'),
    }),
    /@bleedingdev\/b@3\.9\.3-ultramodern\.8 is not present in the registry/u,
  );
});

async function verifyAttestedPublication({
  change = statement => statement,
  originalAttempt = publicationAttempt,
  rejectSignature = false,
} = {}) {
  const { api, release, expected } = await fixture();
  const { npmPackagePurl, slsaProvenanceV1, githubActionsBuildType } =
    await import('../lib/prepare-bleedingdev-packages/provenance.mjs');
  const packages = ['a', 'b'].map(name => ({
    targetName: `@bleedingdev/${name}`,
    version: release.release.version,
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  }));
  const states = new Map(
    packages.map(item => [
      item.targetName,
      {
        exists: true,
        dist: {
          attestations: { provenance: { predicateType: slsaProvenanceV1 } },
        },
      },
    ]),
  );
  const expectation = api.originalRegistryExpectation(
    release,
    {
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: '999',
      GITHUB_RUN_ATTEMPT: '2',
    },
    { runId: expected.runId, attempt: originalAttempt },
  );
  const visited = [];
  const result = await api.verifyOriginalPublicationProvenance(
    { ...release, packages },
    states,
    expectation,
    {
      fetchImpl: async url => {
        const item = packages.find(candidate =>
          decodeURIComponent(url).endsWith(
            `${candidate.targetName}@${candidate.version}`,
          ),
        );
        assert(
          item,
          'The real verifier must request the pinned npm attestation endpoint',
        );
        visited.push(item.targetName);
        let statement = {
          _type: 'https://in-toto.io/Statement/v1',
          predicateType: slsaProvenanceV1,
          subject: [
            {
              name: npmPackagePurl(item.targetName, item.version),
              digest: { sha512: Buffer.alloc(64, 1).toString('hex') },
            },
          ],
          predicate: {
            buildDefinition: {
              buildType: githubActionsBuildType,
              externalParameters: {
                workflow: {
                  repository: `https://github.com/${repository}`,
                  path: '.github/workflows/publish-bleedingdev.yml',
                  ref: 'refs/heads/main-ultramodern',
                },
              },
              resolvedDependencies: [
                {
                  uri: `git+https://github.com/${repository}@refs/heads/main-ultramodern`,
                  digest: { gitCommit: sourceCommit },
                },
              ],
            },
            runDetails: {
              metadata: {
                invocationId: `https://github.com/${repository}/actions/runs/${runId}/attempts/${originalAttempt}`,
              },
            },
          },
        };
        // Only the second package drifts: checking the first package cannot
        // accidentally qualify the complete cohort.
        if (item.targetName === '@bleedingdev/b') statement = change(statement);
        return {
          ok: true,
          json: async () => ({
            attestations: [
              {
                predicateType: slsaProvenanceV1,
                bundle: {
                  dsseEnvelope: {
                    payloadType: 'application/vnd.in-toto+json',
                    payload: Buffer.from(JSON.stringify(statement)).toString(
                      'base64',
                    ),
                  },
                },
              },
            ],
          }),
        };
      },
      // Unit seam substitutes only cryptographic verification. Subject, signed
      // source, workflow and invocation use the production attestation parser.
      bundleVerifier: async (_bundle, authenticated) => {
        if (rejectSignature) throw new Error('Invalid attestation signature');
        return {
          certificateIdentity: authenticated.certificateIdentity,
          issuer: authenticated.issuer,
          verifierVersion: 'unit-fixture',
        };
      },
    },
  );
  assert.deepEqual(
    visited.sort(),
    packages.map(item => item.targetName),
  );
  return result;
}

test('acceptance authenticates every signed original source/run/attempt instead of historical equivalence', async () => {
  const result = await verifyAttestedPublication();
  assert.equal(result.length, 2);
  assert(result.every(item => item.sourceCommit === sourceCommit));
  await assert.rejects(
    verifyAttestedPublication({
      change: statement => {
        statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
          'f'.repeat(40);
        return statement;
      },
    }),
    /source commit.*does not match accepted commit/,
  );
  await assert.rejects(
    verifyAttestedPublication({
      change: statement => {
        statement.predicate.runDetails.metadata.invocationId = `https://github.com/${repository}/actions/runs/999/attempts/1`;
        return statement;
      },
    }),
    /workflow run 999, expected 39078116263/,
  );
  await assert.rejects(
    verifyAttestedPublication({
      originalAttempt: '2',
      change: statement => {
        statement.predicate.runDetails.metadata.invocationId = `https://github.com/${repository}/actions/runs/${runId}/attempts/1`;
        return statement;
      },
    }),
    /does not match fresh producer attempt 2/,
  );
  await assert.rejects(
    verifyAttestedPublication({
      change: statement => {
        statement.subject[0].digest.sha512 = Buffer.alloc(64, 2).toString(
          'hex',
        );
        return statement;
      },
    }),
    /does not match the accepted tarball integrity/,
  );
  await assert.rejects(
    verifyAttestedPublication({
      change: statement => {
        statement.predicate.buildDefinition.externalParameters.workflow.path =
          '.github/workflows/recover-bleedingdev-acceptance.yml';
        return statement;
      },
    }),
    /workflow path.*does not match trusted path/,
  );
  await assert.rejects(
    verifyAttestedPublication({ rejectSignature: true }),
    /Invalid attestation signature/,
  );
});

test('record-only retries retain the actual successful Tractor attempt of this acceptance run', async () => {
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
        name: 'Accept the exact published cohort in Tractor / Exact cohort passes Tractor Node and workerd acceptance',
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
  assert.equal(api.assertAcceptedTractorExecution(options), 1);
  for (const patch of [
    { conclusion: 'failure' },
    { run_attempt: 2 },
    { run_id: 123 },
    { head_sha: sourceCommit },
  ]) {
    assert.throws(() =>
      api.assertAcceptedTractorExecution({
        ...options,
        jobs: [{ ...options.jobs[0], ...patch }],
      }),
    );
  }
  assert.throws(() =>
    api.assertAcceptedTractorExecution({ ...options, runAttempt: '0' }),
  );
  assert.throws(() =>
    api.assertAcceptedTractorExecution({ ...options, artifacts: [] }),
  );
  assert.throws(() =>
    api.assertAcceptedTractorExecution({
      ...options,
      artifactName: artifactName.replace('-attempt-1', '-attempt-3'),
    }),
  );
});
