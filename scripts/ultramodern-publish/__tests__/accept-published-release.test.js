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
  // `gh run rerun --failed` re-runs a failed publish but carries over the
  // publish-sidecars that already passed in attempt 1.
  const carried = jobs.map(job =>
    job.name === publicationJobs[0] ? { ...job, run_attempt: 1 } : job,
  );
  api.assertPublishedRun(run, carried, artifacts, expected);
  // Its latest execution up to the publication attempt decides; a later
  // attempt does not vouch for this publication.
  for (const later of [
    [
      { ...jobs[0], run_attempt: 1 },
      { ...jobs[0], conclusion: 'failure' },
    ],
    [{ ...jobs[0], run_attempt: 3 }],
  ])
    assert.throws(
      () =>
        api.assertPublishedRun(
          run,
          [...later, ...jobs.slice(1)],
          artifacts,
          expected,
        ),
      undefined,
      JSON.stringify(later),
    );
  assert.throws(
    () =>
      api.assertPublishedRun(
        run,
        [
          ...carried,
          { ...jobs[1], run_attempt: 1, conclusion: 'failure' },
        ].filter(job => job !== carried[1]),
        artifacts,
        expected,
      ),
    /Missing or duplicate original job: Publish accepted/,
  );
  for (const name of publicationJobs)
    for (const patch of [
      { conclusion: 'failure' },
      { conclusion: 'skipped' },
      { status: 'in_progress' },
      ...(name === publicationJobs[1] ? [{ run_attempt: 1 }] : []),
      { run_attempt: 3 },
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
      () =>
        api.assertAcceptanceExecutor({ ...executor, ...patch }, environment),
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

const verifierEnvironment = {
  GITHUB_REPOSITORY: repository,
  GITHUB_REPOSITORY_ID: String(repositoryId),
  GITHUB_REF: 'refs/heads/main-ultramodern',
};

test('registry verification uses the publish job predicate, never this run as signer', async () => {
  const { api, release } = await fixture();
  const expectation = api.publishedRegistryExpectation(release, {
    ...verifierEnvironment,
    GITHUB_RUN_ID: '999',
    GITHUB_RUN_ATTEMPT: '1',
  });
  // The acceptance run is never named as the signer of the cohort.
  assert.equal(expectation.invocation, undefined);
  assert.equal(expectation.source.commit, sourceCommit);
  assert.equal(
    expectation.workflow.path,
    '.github/workflows/publish-bleedingdev.yml',
  );
  assert.equal(expectation.workflow.ref, 'refs/heads/main-ultramodern');
  for (const patch of [
    { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REPOSITORY: 'fork/ultramodern.js' },
  ])
    assert.throws(
      () =>
        api.publishedRegistryExpectation(release, {
          ...verifierEnvironment,
          ...patch,
        }),
      undefined,
      JSON.stringify(patch),
    );
});

async function verifyPublishedMember(change = statement => statement) {
  const { api, release } = await fixture();
  const { npmPackagePurl, slsaProvenanceV1, githubActionsBuildType } =
    await import('../lib/prepare-bleedingdev-packages/provenance.mjs');
  const { verifyRegistryPackageDist, verifyRegistryProvenance } = await import(
    '../lib/prepare-bleedingdev-packages/registry.mjs'
  );
  const item = {
    targetName: '@bleedingdev/a',
    version: release.release.version,
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  };
  const statement = change({
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
          invocationId: `https://github.com/${repository}/actions/runs/${runId}/attempts/${publicationAttempt}`,
        },
      },
    },
  });
  const fetchImpl = async url => {
    assert(
      decodeURIComponent(url).endsWith(`${item.targetName}@${item.version}`),
      'The real verifier must request the pinned npm attestation endpoint',
    );
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
  };
  // Unit seams substitute only the byte download and the cryptographic
  // signature check. The expectation the publish job derives, the subject,
  // the signed workflow and source go through the production code.
  return verifyRegistryPackageDist(
    item,
    { attestations: { provenance: { predicateType: slsaProvenanceV1 } } },
    api.publishedRegistryExpectation(release, verifierEnvironment),
    {
      deadline: { remainingMs: () => 1 },
      assertRegistryDistMatches: () => {},
      verifyRegistryTarball: async () => {},
      verifyRegistryProvenance: (member, dist, expected) =>
        verifyRegistryProvenance(
          member,
          dist,
          expected,
          fetchImpl,
          async (_bundle, authenticated) => {
            if (statement.rejectSignature) {
              throw new Error('Invalid attestation signature');
            }
            return {
              certificateIdentity: authenticated.certificateIdentity,
              issuer: authenticated.issuer,
              verifierVersion: 'unit-fixture',
            };
          },
        ),
    },
  );
}

const signedBy =
  (attempt, run = runId) =>
  statement => {
    statement.predicate.runDetails.metadata.invocationId = `https://github.com/${repository}/actions/runs/${run}/attempts/${attempt}`;
    return statement;
  };

test('members a failed-job rerun or a recovery run reused from npm are accepted', async () => {
  await verifyPublishedMember();
  // `gh run rerun --failed`: attempt 2 reused what attempt 1 uploaded.
  await verifyPublishedMember(signedBy('1'));
  // A recovery dispatch reused what the original producer run uploaded, and
  // signed its own later HEAD for the rest.
  await verifyPublishedMember(signedBy('1', '39078000000'));
  await verifyPublishedMember(statement => {
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
      '5'.repeat(40);
    return statement;
  });
});

test('members not signed by the trusted publish workflow over the exact bytes fail', async () => {
  for (const [change, error] of [
    [
      statement => {
        statement.predicate.buildDefinition.externalParameters.workflow.path =
          '.github/workflows/accept-bleedingdev-release.yml';
        return statement;
      },
      /workflow path.*does not match trusted path/,
    ],
    [
      statement => {
        statement.predicate.buildDefinition.externalParameters.workflow.ref =
          'refs/heads/feature';
        return statement;
      },
      /workflow ref/,
    ],
    [
      statement => {
        statement.subject[0].digest.sha512 = Buffer.alloc(64, 2).toString(
          'hex',
        );
        return statement;
      },
      /does not match the accepted tarball integrity/,
    ],
    [
      statement => Object.assign(statement, { rejectSignature: true }),
      /Invalid attestation signature/,
    ],
  ])
    await assert.rejects(verifyPublishedMember(change), error);
});

test('the cohort verifier waits for the origin, then for the install view pnpm reads', async () => {
  const { api, release } = await fixture();
  const { validateRegistryCohort, verifyRegistryPackage } = await import(
    '../lib/prepare-bleedingdev-packages/registry.mjs'
  );
  const packages = ['a', 'b'].map(name => ({
    targetName: `@bleedingdev/${name}`,
    version: release.release.version,
  }));
  const cohort = { ...release, packages };
  const expectation = api.publishedRegistryExpectation(
    release,
    verifierEnvironment,
  );
  const reads = new Map();
  const waits = [];
  const order = [];
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
              order.push(`origin ${dist.name}`);
              return dist;
            },
            wait: async delay => waits.push(delay),
          }),
      }),
    awaitInstallView: async (manifest, options) => {
      assert.equal(manifest, cohort);
      assert.equal(options.tag, 'latest');
      order.push('install view');
    },
  });
  assert.equal(reads.get('@bleedingdev/a'), 1);
  assert.equal(reads.get('@bleedingdev/b'), 3);
  assert.equal(waits.length, 2);
  assert.deepEqual(order.at(-1), 'install view');
  assert.deepEqual(
    [...result],
    packages.map(item => [item.targetName, { name: item.targetName }]),
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
      awaitInstallView: () => assert.fail('an unverified cohort is not read'),
    }),
    /@bleedingdev\/b@3\.9\.3-ultramodern\.8 is not present in the registry/u,
  );
});

test('the install view is read like pnpm reads it, and every member must show the version at latest', async () => {
  const { readRegistryInstallView } = await import(
    '../lib/prepare-bleedingdev-packages/registry-read.mjs'
  );
  const { awaitRegistryInstallView } = await import(
    '../lib/prepare-bleedingdev-packages/registry.mjs'
  );
  const version = '3.9.3-ultramodern.8';
  const requests = [];
  const answer = body => async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => body };
  };
  assert.deepEqual(
    await readRegistryInstallView(
      '@bleedingdev/a',
      'latest',
      version,
      answer({ 'dist-tags': { latest: version }, versions: { [version]: {} } }),
    ),
    { settled: true, value: version },
  );
  // The plain packument URL with pnpm's accept header: the CDN copy.
  assert.equal(
    requests[0].url,
    'https://registry.npmjs.org/%40bleedingdev%2Fa',
  );
  assert.match(
    requests[0].init.headers.accept,
    /^application\/vnd\.npm\.install-v1\+json/u,
  );
  assert.equal(requests[0].init.headers['cache-control'], undefined);
  for (const fetchImpl of [
    answer({ 'dist-tags': { latest: '0.0.1' }, versions: { [version]: {} } }),
    answer({ 'dist-tags': { latest: version }, versions: {} }),
    async () => ({ ok: false, status: 404 }),
    async () => {
      throw new Error('socket hang up');
    },
  ])
    assert.equal(
      (
        await readRegistryInstallView(
          '@bleedingdev/a',
          'latest',
          version,
          fetchImpl,
        )
      ).settled,
      false,
    );

  const manifest = {
    release: { version },
    packages: ['a', 'b', 'c'].map(name => ({
      targetName: `@bleedingdev/${name}`,
    })),
  };
  const reads = new Map();
  const waits = [];
  await awaitRegistryInstallView(
    manifest,
    { tag: 'latest' },
    {
      // The CDN copy of `c` is stale for two more reads.
      readInstallView: async (name, tag, expected) => {
        assert.equal(tag, 'latest');
        assert.equal(expected, version);
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        return name.endsWith('/c') && count < 3
          ? { settled: false, detail: `${name} stale` }
          : { settled: true, value: version };
      },
      wait: async delay => waits.push(delay),
    },
  );
  assert.deepEqual([...reads.values()], [1, 1, 3]);
  assert.equal(waits.length, 2);
  await assert.rejects(
    awaitRegistryInstallView(
      manifest,
      { tag: 'latest' },
      {
        readInstallView: async name =>
          name.endsWith('/b')
            ? { settled: false, detail: `${name} stale` }
            : { settled: true, value: version },
        wait: async () => {},
      },
    ),
    /never served 3\.9\.3-ultramodern\.8 at latest for 1 member\(s\)[\s\S]*@bleedingdev\/b stale/u,
  );
});

test('an advanced Tractor pin is reported, never refused', async () => {
  const { api } = await fixture();
  const rehearsed = '1'.repeat(40);
  assert.match(
    api.describeTractorBaseline(rehearsed, rehearsed),
    /rehearsed baseline 1{40}/u,
  );
  assert.match(
    api.describeTractorBaseline(rehearsed, '2'.repeat(40)),
    /^::notice title=Tractor baseline advanced::.*1{40}.*2{40}/u,
  );
  assert.throws(() => api.describeTractorBaseline(rehearsed, 'main'));
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
