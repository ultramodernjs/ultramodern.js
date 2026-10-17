#!/usr/bin/env node
// Acceptance-only recovery: original npm/source identities never become those
// of the workflow executing the missing Tractor proof. No publication API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDirectRun } from './lib/direct-run.mjs';
import {
  createRegistryProvenanceExpectation,
  preflightRegistryPackages,
} from './lib/prepare-bleedingdev-packages/registry.mjs';
import { readReleaseManifest } from './lib/source-create-proof/release-manifest.mjs';
import {
  createPublishOutcome,
  readReleaseEvidence,
} from './publish-outcome.mjs';
import { verifySourceQualification } from './source-qualification.mjs';

const repository = 'ultramodernjs/ultramodern.js';
const repositoryId = 1151231350;
const publicationWorkflow = '.github/workflows/publish-bleedingdev.yml';
const recoveryWorkflow = '.github/workflows/recover-bleedingdev-acceptance.yml';
const branch = 'main-ultramodern';
const tractorJob =
  'Accept the exact published cohort in Tractor / Exact cohort passes Tractor Node and workerd acceptance';
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
const positive = (value, label) => {
  assert.match(String(value), /^[1-9]\d*$/u, label);
  return String(value);
};
const hash = filename =>
  crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

export function recoveryArtifactNames(runId, attempt) {
  const identity = `run-${positive(runId, 'Original run')}-attempt-${positive(attempt, 'Original attempt')}`;
  return {
    identity: `bleedingdev-release-identity-${identity}-publication-attempt-${attempt}`,
    qualification: `bleedingdev-source-qualification-${identity}`,
    published: `bleedingdev-published-acceptance-${identity}-publication-attempt-${attempt}`,
    bundle: `bleedingdev-acceptance-recovery-${identity}`,
  };
}

export function assertRecoverablePublication(run, jobs, artifacts, expected) {
  const runId = positive(expected.runId, 'Original run');
  const attempt = positive(expected.attempt, 'Original attempt');
  assert.equal(String(run.id), runId);
  assert.equal(
    String(run.run_attempt),
    attempt,
    'Inspect the latest original attempt before recovery',
  );
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.repository?.id, repositoryId);
  assert.equal(run.head_repository?.id, repositoryId);
  assert.equal(run.path, publicationWorkflow);
  assert.equal(run.head_branch, branch);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'failure');
  assert.equal(run.actor?.login, 'BleedingDev');
  assert.equal(run.triggering_actor?.login, 'BleedingDev');
  assert.match(run.head_sha, /^[a-f0-9]{40}$/u);
  for (const job of jobs) {
    assert.equal(job.status, 'completed');
    assert.equal(String(job.run_id), runId);
    assert.equal(String(job.run_attempt), attempt);
    assert.equal(job.head_sha, run.head_sha);
    assert(
      ['success', 'skipped', 'failure'].includes(job.conclusion),
      `Unrecoverable original job: ${job.name}`,
    );
  }
  for (const name of requiredJobs) {
    const found = jobs.filter(job => job.name === name);
    assert.equal(found.length, 1, `Missing or duplicate original job: ${name}`);
    assert.equal(
      found[0].conclusion,
      'success',
      `Original job did not pass: ${name}`,
    );
    assert.equal(String(found[0].run_id), runId);
    assert.equal(String(found[0].run_attempt), attempt);
    assert.equal(found[0].head_sha, run.head_sha);
  }
  const failed = jobs.filter(job => job.conclusion === 'failure');
  assert.deepEqual(
    failed.map(job => job.name),
    [tractorJob],
    'Only missing published Tractor acceptance can be recovered',
  );
  const names = recoveryArtifactNames(runId, attempt);
  for (const name of [names.identity, names.qualification, names.published]) {
    const found = artifacts.filter(artifact => artifact.name === name);
    assert.equal(
      found.length,
      1,
      `Missing or duplicate original artifact: ${name}`,
    );
    assert.equal(found[0].expired, false);
    assert.match(found[0].digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(String(found[0].workflow_run?.id), runId);
    assert.equal(found[0].workflow_run?.head_sha, run.head_sha);
    assert.equal(found[0].workflow_run?.repository_id, repositoryId);
    assert.equal(found[0].workflow_run?.head_repository_id, repositoryId);
  }
  return names;
}

export function originalRegistryExpectation(release, environment, context) {
  return createRegistryProvenanceExpectation(release, {
    ...environment,
    GITHUB_RUN_ID: positive(context.runId, 'Original publication run'),
    GITHUB_RUN_ATTEMPT: positive(
      context.attempt,
      'Original publication attempt',
    ),
  });
}

export function assertCompletePublishedRegistry(states, release) {
  assert.equal(states.size, release.packages.length);
  for (const item of release.packages) {
    assert.equal(
      states.get(item.targetName)?.exists,
      true,
      `Recovery cannot publish missing ${item.targetName}`,
    );
  }
}

export function assertOriginalPublishedIdentity(identity, release, expected) {
  const runId = positive(expected.runId, 'Original run');
  const attempt = positive(expected.attempt, 'Original attempt');
  assert.equal(
    identity.schema,
    'bleedingdev.ultramodern.published-release-identity',
  );
  assert.equal(identity.schemaVersion, 2);
  assert.equal(identity.dryRun, false);
  assert.equal(identity.releaseRunId, runId);
  assert.equal(String(identity.publicationRunAttempt), attempt);
  assert.equal(String(identity.producerRunAttempt), attempt);
  assert.equal(
    identity.producerArtifactIdentity,
    `run-${runId}-attempt-${attempt}`,
  );
  assert.equal(
    identity.producerRunIdentity,
    `github:${repository}:run:${runId}:attempt:${attempt}`,
  );
  assert.deepEqual(identity.source, release.source);
  assert.deepEqual(identity.release, release.release);
  assert.equal(identity.manifestSha256, release.manifestSha256);
  assert.equal(identity.cohortDigest, release.cohortDigest);
  assert.equal(identity.acceptanceReceiptSha256, expected.receiptSha256);
}

export function assertRecoveredTractorExecution({
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
    'Tractor attempt follows recovery outcome',
  );
  const matching = jobs.filter(
    job =>
      job.name ===
      'Recover only the missing published Tractor acceptance / Exact cohort passes Tractor Node and workerd acceptance',
  );
  assert.equal(
    matching.length,
    1,
    'Missing or duplicate recovered Tractor job',
  );
  const job = matching[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  assert.equal(String(job.run_id), runId);
  assert.equal(String(job.run_attempt), tractorAttempt);
  assert.equal(job.head_sha, sourceCommit);
  const found = artifacts.filter(artifact => artifact.name === artifactName);
  assert.equal(
    found.length,
    1,
    'Missing or duplicate recovered Tractor artifact',
  );
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

function authorize(environment) {
  assert.equal(environment.GITHUB_REPOSITORY, repository);
  assert.equal(environment.GITHUB_REPOSITORY_ID, String(repositoryId));
  assert.equal(environment.GITHUB_REF, `refs/heads/${branch}`);
  assert.equal(environment.GITHUB_ACTOR, 'BleedingDev');
  assert.equal(environment.GITHUB_TRIGGERING_ACTOR, 'BleedingDev');
  const executor = api(
    `repos/${repository}/actions/runs/${positive(environment.GITHUB_RUN_ID, 'Recovery run')}`,
  );
  assert.equal(executor.repository?.id, repositoryId);
  assert.equal(executor.head_repository?.id, repositoryId);
  assert.equal(executor.path, recoveryWorkflow);
  assert.equal(executor.event, 'workflow_dispatch');
  assert.equal(executor.head_branch, branch);
  assert.equal(executor.head_sha, environment.GITHUB_SHA);
  assert.equal(executor.actor?.login, 'BleedingDev');
  assert.equal(executor.triggering_actor?.login, 'BleedingDev');
  assert.equal(
    String(executor.run_attempt),
    positive(environment.GITHUB_RUN_ATTEMPT, 'Recovery attempt'),
  );
  const runId = positive(environment.ORIGINAL_RUN_ID, 'Original run');
  const attempt = positive(
    environment.ORIGINAL_RUN_ATTEMPT,
    'Original attempt',
  );
  const run = api(`repos/${repository}/actions/runs/${runId}`);
  const jobs = pages(
    `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
  ).flatMap(page => page.jobs);
  const artifacts = pages(
    `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  ).flatMap(page => page.artifacts);
  const names = assertRecoverablePublication(run, jobs, artifacts, {
    runId,
    attempt,
  });
  execFileSync('git', [
    'merge-base',
    '--is-ancestor',
    run.head_sha,
    environment.GITHUB_SHA,
  ]);
  // The reusable Tractor job consumes the reviewed current baseline. Recovery
  // may not silently change which application revision accepts this release.
  const baseline = execFileSync(
    'git',
    [
      'show',
      `${run.head_sha}:scripts/ultramodern-publish/tractor-baseline-revision`,
    ],
    { encoding: 'utf8' },
  ).trim();
  assert.match(baseline, /^[a-f0-9]{40}$/u);
  assert.equal(
    fs
      .readFileSync(
        'scripts/ultramodern-publish/tractor-baseline-revision',
        'utf8',
      )
      .trim(),
    baseline,
    'Tractor baseline changed; inspect acceptance recovery separately',
  );
  return { runId, attempt, run, names, baseline };
}

function evidence(context, releaseDir) {
  const at = filename => path.join(releaseDir, filename);
  const release = readReleaseManifest({ manifestPath: at('manifest.json') });
  assert.equal(release.source.repository, repository);
  assert.equal(release.source.commit, context.run.head_sha);
  assert.equal(release.release.tag, 'latest');
  assert.equal(
    process.version,
    release.tools.node,
    'Recovery must use the accepted Node interpreter',
  );
  verifySourceQualification({
    receiptPath: at('source-qualification.json'),
    repository,
    runId: context.runId,
    runAttempt: context.attempt,
    expectedCommit: release.source.commit,
  });
  assertOriginalPublishedIdentity(json(at('release-identity.json')), release, {
    ...context,
    receiptSha256: hash(at('acceptance-receipt.json')),
  });
  const options = {
    manifestPath: at('manifest.json'),
    manifestDigestPath: at('manifest.json.sha256'),
    cohortDigestPath: at('cohort.sha256'),
    receiptPath: at('acceptance-receipt.json'),
    operationalEvidencePath: at(
      'acceptance-receipt.operational-independence.json',
    ),
    publishedReceiptPath: at('published-acceptance-receipt.json'),
    repository,
    sourceCommit: release.source.commit,
    tag: release.release.tag,
    version: release.release.version,
    runIdentity: `github:${repository}:run:${context.runId}:attempt:${context.attempt}`,
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
    output({
      identity_artifact: context.names.identity,
      qualification_artifact: context.names.qualification,
      published_artifact: context.names.published,
      bundle_artifact: context.names.bundle,
    });
    return;
  }
  const releaseDir = path.resolve(
    environment.BLEEDINGDEV_RELEASE_DIR ?? '.modern/bleedingdev-publish',
  );
  const { release, options } = evidence(context, releaseDir);
  if (command === 'verify-registry') {
    // These are the authenticated ORIGINAL publication expectations, not the
    // recovery executor's run. Never remove invocation checks to reuse npm.
    const expectation = originalRegistryExpectation(
      release,
      environment,
      context,
    );
    const states = await preflightRegistryPackages(
      release.packages,
      {
        version: release.release.version,
        tag: release.release.tag,
        dryRun: true,
        publishConcurrency: 8,
      },
      expectation,
    );
    assertCompletePublishedRegistry(states, release);
    return;
  }
  assert.equal(command, 'outcome', 'Unknown acceptance recovery command');
  const recoveryRunId = positive(environment.GITHUB_RUN_ID, 'Recovery run');
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
  const tractorJobs = pages(
    `repos/${repository}/actions/runs/${recoveryRunId}/attempts/${tractorAttempt}/jobs?per_page=100`,
  ).flatMap(page => page.jobs);
  const tractorArtifacts = pages(
    `repos/${repository}/actions/runs/${recoveryRunId}/artifacts?per_page=100`,
  ).flatMap(page => page.artifacts);
  const tractorRunAttempt = assertRecoveredTractorExecution({
    artifactName,
    artifacts: tractorArtifacts,
    jobs: tractorJobs,
    baseline: context.baseline,
    runId: recoveryRunId,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    sourceCommit: environment.GITHUB_SHA,
  });
  const reportPath = path.join(
    releaseDir,
    'tractor-downstream-acceptance.json',
  );
  const outcome = createPublishOutcome({
    ...options,
    outPath: path.join(releaseDir, 'publish-outcome.json'),
    operationalEvidencePath: options.operationalEvidencePath,
    dryRun: false,
    runId: context.runId,
    runAttempt: context.attempt,
    publicationRunAttempt: context.attempt,
    producerArtifactIdentity: `run-${context.runId}-attempt-${context.attempt}`,
    producerRunAttempt: context.attempt,
    producerRunIdentity: options.runIdentity,
    tractorBaselineRevision: context.baseline,
    tractorReportPath: reportPath,
    tractorReportSha256: environment.TRACTOR_REPORT_SHA256,
    acceptanceRecovery: {
      runId: environment.GITHUB_RUN_ID,
      runAttempt: environment.GITHUB_RUN_ATTEMPT,
      tractorRunAttempt,
      sourceCommit: environment.GITHUB_SHA,
    },
  });
  assert.equal(outcome.acceptanceRecovery.result, 'tractor-downstream');
  output({
    artifact_name: outcome.artifactName,
    source_commit: release.source.commit,
    version: release.release.version,
  });
}

if (isDirectRun(import.meta.url)) await main(process.argv[2]);
