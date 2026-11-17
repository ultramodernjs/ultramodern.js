#!/usr/bin/env node
// Consumer: accept-bleedingdev-release.yml. Reads one publish-bleedingdev.yml
// run's npm upload back from the registry and binds the published acceptance
// of it under a separate execution: the original npm/source identities never
// become those of the run that accepts them. No publication API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDirectRun } from './lib/direct-run.mjs';
import {
  createRegistryProvenanceExpectation,
  validateRegistryCohort,
  verifyRegistryProvenance,
} from './lib/prepare-bleedingdev-packages/registry.mjs';
import { mapWithConcurrency } from './lib/prepare-bleedingdev-packages/registry-read.mjs';
import { readReleaseManifest } from './lib/source-create-proof/release-manifest.mjs';
import {
  createPublishOutcome,
  readReleaseEvidence,
} from './publish-outcome.mjs';

const repository = 'ultramodernjs/ultramodern.js';
const repositoryId = 1151231350;
const publicationWorkflow = '.github/workflows/publish-bleedingdev.yml';
const acceptanceWorkflow = '.github/workflows/accept-bleedingdev-release.yml';
const branch = 'main-ultramodern';
const owner = 'BleedingDev';
// start-release-acceptance dispatches with GITHUB_TOKEN, so an automatic
// acceptance run is github-actions[bot]'s. Only that job holds actions: write
// (workflow-security), and the original run is authenticated below.
const dispatchers = [owner, 'github-actions[bot]'];
const publicationJobs = [
  'Publish the qualified stable sidecars',
  'Publish accepted @bleedingdev tarballs',
];
const tractorJob =
  'Accept the exact published cohort in Tractor / Exact cohort passes Tractor Node and workerd acceptance';
const positive = (value, label) => {
  assert.match(String(value), /^[1-9]\d*$/u, label);
  return String(value);
};
const hash = filename =>
  crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

export function acceptanceArtifactNames({
  runId,
  producerAttempt,
  publicationAttempt,
}) {
  const producer = `run-${positive(runId, 'Original run')}-attempt-${positive(
    producerAttempt,
    'Producer attempt',
  )}`;
  const publication = positive(publicationAttempt, 'Publication attempt');
  return {
    identity: `bleedingdev-release-identity-${producer}-publication-attempt-${publication}`,
    bundle: `bleedingdev-accepted-publication-${producer}-publication-attempt-${publication}`,
  };
}

function originalAttempts(expected) {
  const runId = positive(expected.runId, 'Original run');
  const producerAttempt = positive(
    expected.producerAttempt,
    'Producer attempt',
  );
  const publicationAttempt = positive(
    expected.publicationAttempt,
    'Publication attempt',
  );
  // A failed-job rerun advances only the jobs that failed, so the publish job
  // may run in a later attempt than the one that produced the bundle, never in
  // an earlier one.
  assert(
    Number(producerAttempt) <= Number(publicationAttempt),
    'The producer attempt cannot follow the publication attempt',
  );
  return { runId, producerAttempt, publicationAttempt };
}

// The original run may still be finishing start-release-acceptance when this
// runs, so its own status and conclusion are not read: only the two jobs that
// wrote to npm, in the attempt that published, and the identity they uploaded.
export function assertPublishedRun(run, jobs, artifacts, expected) {
  const { runId, producerAttempt, publicationAttempt } =
    originalAttempts(expected);
  assert.equal(String(run.id), runId);
  assert(
    Number(run.run_attempt) >= Number(publicationAttempt),
    'The publication attempt does not exist in the original run',
  );
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.repository?.id, repositoryId);
  assert.equal(run.head_repository?.id, repositoryId);
  assert.equal(run.path, publicationWorkflow);
  assert.equal(run.head_branch, branch);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.actor?.login, owner);
  assert.equal(run.triggering_actor?.login, owner);
  assert.match(run.head_sha, /^[a-f0-9]{40}$/u);
  for (const name of publicationJobs) {
    const found = jobs.filter(job => job.name === name);
    assert.equal(found.length, 1, `Missing or duplicate original job: ${name}`);
    assert.equal(found[0].status, 'completed', `Original job: ${name}`);
    assert.equal(
      found[0].conclusion,
      'success',
      `Original job did not pass: ${name}`,
    );
    assert.equal(String(found[0].run_id), runId);
    assert.equal(String(found[0].run_attempt), publicationAttempt);
    assert.equal(found[0].head_sha, run.head_sha);
  }
  const names = acceptanceArtifactNames({
    runId,
    producerAttempt,
    publicationAttempt,
  });
  const found = artifacts.filter(artifact => artifact.name === names.identity);
  assert.equal(
    found.length,
    1,
    `Missing or duplicate original artifact: ${names.identity}`,
  );
  assert.equal(found[0].expired, false);
  assert.match(found[0].digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(String(found[0].workflow_run?.id), runId);
  assert.equal(found[0].workflow_run?.head_sha, run.head_sha);
  assert.equal(found[0].workflow_run?.repository_id, repositoryId);
  assert.equal(found[0].workflow_run?.head_repository_id, repositoryId);
  return names;
}

export function assertAcceptanceExecutor(executor, environment) {
  assert.equal(executor.repository?.id, repositoryId);
  assert.equal(executor.head_repository?.id, repositoryId);
  assert.equal(executor.path, acceptanceWorkflow);
  assert.equal(executor.event, 'workflow_dispatch');
  assert.equal(executor.head_branch, branch);
  assert.equal(executor.head_sha, environment.GITHUB_SHA);
  assert(
    dispatchers.includes(executor.actor?.login),
    'Acceptance must be dispatched by the owner or by start-release-acceptance',
  );
  assert(
    dispatchers.includes(executor.triggering_actor?.login),
    'Acceptance must be triggered by the owner or by start-release-acceptance',
  );
  assert.equal(
    String(executor.run_attempt),
    positive(environment.GITHUB_RUN_ATTEMPT, 'Acceptance attempt'),
  );
}

// The run that published signed its own head commit. In the normal lane that
// is the manifest commit; a recovery publish signs its later HEAD instead.
export function originalRegistryExpectation(release, environment, context) {
  const expectation = createRegistryProvenanceExpectation(release, {
    ...environment,
    GITHUB_RUN_ID: positive(context.runId, 'Original publication run'),
    GITHUB_RUN_ATTEMPT: positive(
      context.attempt,
      'Original publication attempt',
    ),
  });
  if (context.sourceCommit !== undefined) {
    assert.match(context.sourceCommit, /^[a-f0-9]{40}$/u);
  }
  return {
    ...expectation,
    source: {
      ...expectation.source,
      commit: context.sourceCommit ?? expectation.source.commit,
    },
    invocation: { ...expectation.invocation, exactAttempt: true },
  };
}

export function assertCompletePublishedRegistry(states, release) {
  assert.equal(states.size, release.packages.length);
  for (const item of release.packages) {
    assert.equal(
      states.get(item.targetName)?.exists,
      true,
      `Acceptance cannot publish missing ${item.targetName}`,
    );
  }
}

export async function verifyOriginalPublicationProvenance(
  release,
  states,
  expectation,
  { fetchImpl, bundleVerifier } = {},
) {
  assertCompletePublishedRegistry(states, release);
  assert.match(
    expectation.source?.commit,
    /^[a-f0-9]{40}$/u,
    'Original signed source commit is required',
  );
  assert.equal(
    expectation.invocation?.exactAttempt,
    true,
    'Original signed attempt must be exact',
  );
  // The registry poll accepts provenance from the trusted workflow. Acceptance
  // instead requires the original signed source/run/attempt: feed its complete
  // expectation directly to the authenticated SLSA verifier.
  return mapWithConcurrency(release.packages, 8, item =>
    verifyRegistryProvenance(
      item,
      states.get(item.targetName).dist,
      expectation,
      fetchImpl,
      bundleVerifier,
    ),
  );
}

// Polls npm once, for the whole cohort, until it serves the exact accepted
// bytes at `latest`, then authenticates every package's signed invocation.
export async function verifyPublishedCohort(
  release,
  expectation,
  {
    validate = validateRegistryCohort,
    authenticate = verifyOriginalPublicationProvenance,
  } = {},
) {
  const dists = await validate(release, {
    provenanceExpectation: expectation,
    publishConcurrency: 8,
    tag: release.release.tag,
  });
  const states = new Map(
    release.packages.map(item => [
      item.targetName,
      { exists: dists.has(item.targetName), dist: dists.get(item.targetName) },
    ]),
  );
  return authenticate(release, states, expectation);
}

export function assertOriginalPublishedIdentity(identity, release, expected) {
  const { runId, producerAttempt, publicationAttempt } =
    originalAttempts(expected);
  assert.equal(
    identity.schema,
    'bleedingdev.ultramodern.published-release-identity',
  );
  assert.equal(identity.schemaVersion, 2);
  assert.equal(identity.dryRun, false);
  assert.equal(identity.releaseRunId, runId);
  assert.equal(String(identity.publicationRunAttempt), publicationAttempt);
  assert.equal(String(identity.producerRunAttempt), producerAttempt);
  assert.equal(
    identity.producerArtifactIdentity,
    `run-${runId}-attempt-${producerAttempt}`,
  );
  assert.equal(
    identity.producerRunIdentity,
    `github:${repository}:run:${runId}:attempt:${producerAttempt}`,
  );
  assert.deepEqual(identity.source, release.source);
  assert.deepEqual(identity.release, release.release);
  assert.equal(identity.manifestSha256, release.manifestSha256);
  assert.equal(identity.cohortDigest, release.cohortDigest);
  assert.equal(identity.acceptanceReceiptSha256, expected.receiptSha256);
}

export function assertAcceptedTractorExecution({
  artifactName,
  artifacts,
  jobs,
  baseline,
  runId,
  runAttempt,
  sourceCommit,
}) {
  const prefix = `ultramodern-tractor-downstream-acceptance-${baseline}-attempt-`;
  assert(
    artifactName.startsWith(prefix),
    'Unexpected Tractor evidence artifact',
  );
  const tractorAttempt = positive(
    artifactName.slice(prefix.length),
    'Tractor attempt',
  );
  assert(
    Number(tractorAttempt) <= Number(runAttempt),
    'Tractor attempt follows the acceptance outcome',
  );
  const matching = jobs.filter(job => job.name === tractorJob);
  assert.equal(matching.length, 1, 'Missing or duplicate Tractor job');
  const job = matching[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  assert.equal(String(job.run_id), runId);
  assert.equal(String(job.run_attempt), tractorAttempt);
  assert.equal(job.head_sha, sourceCommit);
  const found = artifacts.filter(artifact => artifact.name === artifactName);
  assert.equal(found.length, 1, 'Missing or duplicate Tractor artifact');
  assert.equal(found[0].expired, false);
  assert.match(found[0].digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(String(found[0].workflow_run?.id), runId);
  assert.equal(found[0].workflow_run?.head_sha, sourceCommit);
  assert.equal(found[0].workflow_run?.repository_id, repositoryId);
  assert.equal(found[0].workflow_run?.head_repository_id, repositoryId);
  return Number(tractorAttempt);
}

const api = endpoint =>
  JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
const pages = endpoint =>
  JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
      encoding: 'utf8',
    }),
  );
const isAncestor = (ancestor, descendant) =>
  execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant]);

function authorize(environment) {
  assert.equal(environment.GITHUB_REPOSITORY, repository);
  assert.equal(environment.GITHUB_REPOSITORY_ID, String(repositoryId));
  assert.equal(environment.GITHUB_REF, `refs/heads/${branch}`);
  assertAcceptanceExecutor(
    api(
      `repos/${repository}/actions/runs/${positive(environment.GITHUB_RUN_ID, 'Acceptance run')}`,
    ),
    environment,
  );
  const expected = originalAttempts({
    runId: environment.ORIGINAL_RUN_ID,
    producerAttempt: environment.PRODUCER_RUN_ATTEMPT,
    publicationAttempt: environment.PUBLICATION_RUN_ATTEMPT,
  });
  const run = api(`repos/${repository}/actions/runs/${expected.runId}`);
  const jobs = pages(
    `repos/${repository}/actions/runs/${expected.runId}/attempts/${expected.publicationAttempt}/jobs?per_page=100`,
  ).flatMap(page => page.jobs);
  const artifacts = pages(
    `repos/${repository}/actions/runs/${expected.runId}/artifacts?per_page=100`,
  ).flatMap(page => page.artifacts);
  const names = assertPublishedRun(run, jobs, artifacts, expected);
  return { ...expected, run, names };
}

// Only the job that checks out this run's own HEAD with full history runs
// these: the acceptance tooling must descend from the release, and the
// Tractor job consumes this HEAD's baseline pin.
function assertToolingDescendsFromRelease(context, environment) {
  isAncestor(context.run.head_sha, environment.GITHUB_SHA);
  const pin = 'scripts/ultramodern-publish/tractor-baseline-revision';
  const baseline = execFileSync(
    'git',
    ['show', `${context.run.head_sha}:${pin}`],
    { encoding: 'utf8' },
  ).trim();
  assert.match(baseline, /^[a-f0-9]{40}$/u);
  assert.equal(
    fs.readFileSync(pin, 'utf8').trim(),
    baseline,
    'The Tractor baseline changed after this release; accept it from a checkout with the release baseline',
  );
}

function evidence(context, releaseDir, { published = false } = {}) {
  const at = filename => path.join(releaseDir, filename);
  const release = readReleaseManifest({ manifestPath: at('manifest.json') });
  assert.equal(release.source.repository, repository);
  assert.equal(release.release.tag, 'latest');
  assert.equal(
    process.version,
    release.tools.node,
    'Acceptance must use the accepted Node interpreter',
  );
  assertOriginalPublishedIdentity(json(at('release-identity.json')), release, {
    ...context,
    receiptSha256: hash(at('acceptance-receipt.json')),
  });
  const runIdentity = `github:${repository}:run:${context.runId}:attempt:${context.producerAttempt}`;
  const options = {
    manifestPath: at('manifest.json'),
    manifestDigestPath: at('manifest.json.sha256'),
    cohortDigestPath: at('cohort.sha256'),
    receiptPath: at('acceptance-receipt.json'),
    operationalEvidencePath: at(
      'acceptance-receipt.operational-independence.json',
    ),
    ...(published
      ? { publishedReceiptPath: at('published-acceptance-receipt.json') }
      : {}),
    repository,
    sourceCommit: release.source.commit,
    tag: release.release.tag,
    version: release.release.version,
    runIdentity,
  };
  readReleaseEvidence(options);
  return { release, options };
}

export async function main(command, environment = process.env) {
  const context = authorize(environment);
  const output = fields => {
    assert(environment.GITHUB_OUTPUT);
    fs.appendFileSync(
      environment.GITHUB_OUTPUT,
      Object.entries(fields)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  };
  if (command === 'authorize') {
    assertToolingDescendsFromRelease(context, environment);
    output({
      identity_artifact: context.names.identity,
      bundle_artifact: context.names.bundle,
      run_head_sha: context.run.head_sha,
    });
    return;
  }
  const releaseDir = path.resolve(
    environment.BLEEDINGDEV_RELEASE_DIR ?? '.modern/bleedingdev-publish',
  );
  if (command === 'verify-registry') {
    assertToolingDescendsFromRelease(context, environment);
    const { release, options } = evidence(context, releaseDir);
    isAncestor(release.source.commit, context.run.head_sha);
    // The authenticated ORIGINAL publication expectations, not those of this
    // run. Never remove invocation checks to reuse npm.
    const expectation = originalRegistryExpectation(release, environment, {
      runId: context.runId,
      attempt: context.publicationAttempt,
      sourceCommit: context.run.head_sha,
    });
    await verifyPublishedCohort(release, expectation);
    output({
      version: release.release.version,
      source_commit: release.source.commit,
      producer_artifact_identity: `run-${context.runId}-attempt-${context.producerAttempt}`,
      producer_run_identity: options.runIdentity,
    });
    return;
  }
  assert.equal(command, 'outcome', 'Unknown published acceptance command');
  const { release, options } = evidence(context, releaseDir, {
    published: true,
  });
  const acceptanceRunId = positive(environment.GITHUB_RUN_ID, 'Acceptance run');
  const artifactName = environment.TRACTOR_ARTIFACT_NAME;
  assert.equal(
    typeof artifactName,
    'string',
    'Actual Tractor artifact name is required',
  );
  const tractorAttempt = positive(
    artifactName.split('-attempt-').at(-1),
    'Tractor attempt',
  );
  const baseline = fs
    .readFileSync(
      'scripts/ultramodern-publish/tractor-baseline-revision',
      'utf8',
    )
    .trim();
  const tractorRunAttempt = assertAcceptedTractorExecution({
    artifactName,
    artifacts: pages(
      `repos/${repository}/actions/runs/${acceptanceRunId}/artifacts?per_page=100`,
    ).flatMap(page => page.artifacts),
    jobs: pages(
      `repos/${repository}/actions/runs/${acceptanceRunId}/attempts/${tractorAttempt}/jobs?per_page=100`,
    ).flatMap(page => page.jobs),
    baseline,
    runId: acceptanceRunId,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    sourceCommit: environment.GITHUB_SHA,
  });
  const outcome = createPublishOutcome({
    ...options,
    outPath: path.join(releaseDir, 'publish-outcome.json'),
    dryRun: false,
    runId: context.runId,
    runAttempt: context.publicationAttempt,
    publicationRunAttempt: context.publicationAttempt,
    producerArtifactIdentity: `run-${context.runId}-attempt-${context.producerAttempt}`,
    producerRunAttempt: context.producerAttempt,
    producerRunIdentity: options.runIdentity,
    tractorBaselineRevision: baseline,
    tractorReportPath: path.join(
      releaseDir,
      'tractor-downstream-acceptance.json',
    ),
    tractorReportSha256: environment.TRACTOR_REPORT_SHA256,
    acceptanceExecution: {
      runId: acceptanceRunId,
      runAttempt: environment.GITHUB_RUN_ATTEMPT,
      tractorRunAttempt,
      sourceCommit: environment.GITHUB_SHA,
    },
  });
  output({
    artifact_name: outcome.artifactName,
    source_commit: release.source.commit,
    version: release.release.version,
  });
}

if (isDirectRun(import.meta.url)) await main(process.argv[2]);
