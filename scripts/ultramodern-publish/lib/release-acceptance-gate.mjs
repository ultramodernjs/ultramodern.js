// Consumer: publish-security in publish-bleedingdev.yml, through
// `workflow.mjs assert-previous-release-settled`. A live cohort reaches npm in
// its own run; its published checks run in accept-bleedingdev-release.yml.
// The next live cohort must not move `latest` while those checks still read
// the previous cohort, and a cohort whose checks never ran must not be buried
// under a newer one. A previous acceptance that finished red does not block:
// the only remedy for a broken cohort is publishing a corrected one, so its
// failure is reported loudly instead.
// No dependency install precedes publish-security: node built-ins only.
import { execFileSync } from 'node:child_process';

export const publicationJobName = 'Publish accepted @bleedingdev tarballs';
export const handoffJobName = 'Start the published release acceptance';
export const acceptanceWorkflowFile = 'accept-bleedingdev-release.yml';
export const acceptanceRunName = runId =>
  `Accept published release from run ${runId}`;

const identityArtifactPattern =
  /^bleedingdev-release-identity-run-(\d+)-attempt-(\d+)-publication-attempt-(\d+)$/u;

function dispatchCommand(repository, runId, artifacts, publicationAttempt) {
  const identity = artifacts
    .map(artifact => identityArtifactPattern.exec(artifact.name))
    .find(
      match =>
        match && match[1] === String(runId) && match[3] === publicationAttempt,
    );
  return [
    `gh workflow run ${acceptanceWorkflowFile} --repo ${repository} --ref main-ultramodern`,
    `-f original_run_id=${runId}`,
    `-f producer_run_attempt=${identity ? identity[2] : '<producer attempt>'}`,
    `-f publication_run_attempt=${publicationAttempt}`,
  ].join(' ');
}

// Returns { status: 'clear' | 'failed' | 'blocked', message }. `failed` lets
// the cohort start and must be reported as an error; `blocked` refuses it.
export function assessPreviousReleaseAcceptance({
  acceptanceRuns,
  artifactsFor,
  currentRunId,
  jobsFor,
  publishRuns,
  repository,
  serverUrl = 'https://github.com',
}) {
  let previous;
  for (const run of publishRuns) {
    if (String(run.id) === String(currentRunId) || run.status !== 'completed') {
      continue;
    }
    const jobs = jobsFor(run.id);
    const publication = jobs.find(job => job.name === publicationJobName);
    if (publication?.conclusion === 'success') {
      previous = { run, jobs, publication };
      break;
    }
  }
  if (!previous) {
    return { status: 'clear', message: 'No earlier live cohort was found.' };
  }
  const { run, jobs, publication } = previous;
  const runUrl = `${serverUrl}/${repository}/actions/runs/${run.id}`;
  const handoff = jobs.find(job => job.name === handoffJobName);
  if (!handoff) {
    // Published by a workflow that ran its acceptance inside the publish run.
    return {
      status: 'clear',
      message: `Live cohort ${runUrl} accepted itself before its run ended.`,
    };
  }
  const publicationAttempt = String(publication.run_attempt);
  const redispatch = () =>
    dispatchCommand(
      repository,
      run.id,
      artifactsFor(run.id),
      publicationAttempt,
    );
  const accepting = acceptanceRuns.filter(
    candidate => candidate.display_title === acceptanceRunName(run.id),
  );
  if (accepting.length === 0) {
    return {
      status: 'blocked',
      message:
        handoff.conclusion === 'success'
          ? `The published acceptance of live cohort ${runUrl} was started but is not listed yet. Dispatch this cohort again once it has finished.`
          : `Live cohort ${runUrl} is on npm but never started its published acceptance. Start it, then dispatch this cohort again: ${redispatch()}`,
    };
  }
  const [latest] = [...accepting].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );
  const latestUrl = `${serverUrl}/${repository}/actions/runs/${latest.id}`;
  if (latest.status !== 'completed') {
    return {
      status: 'blocked',
      message: `The published acceptance ${latestUrl} of live cohort ${runUrl} is still ${latest.status}. A new cohort would move latest under it; dispatch this cohort again once it has finished.`,
    };
  }
  if (latest.conclusion === 'success') {
    return {
      status: 'clear',
      message: `Live cohort ${runUrl} was accepted by ${latestUrl}.`,
    };
  }
  if (latest.conclusion === 'cancelled') {
    return {
      status: 'blocked',
      message: `The published acceptance ${latestUrl} of live cohort ${runUrl} was cancelled, so nothing proves that cohort. Run it to completion first: ${redispatch()}`,
    };
  }
  return {
    status: 'failed',
    message: `The published acceptance ${latestUrl} of live cohort ${runUrl} concluded ${latest.conclusion}: that cohort is on npm but not accepted and has no release record. This cohort may replace it; fix the cause first.`,
  };
}

function ghApi(endpoint) {
  return JSON.parse(
    execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

export function readPreviousReleaseAcceptance(env, api = ghApi) {
  const repository = env.GITHUB_REPOSITORY;
  return assessPreviousReleaseAcceptance({
    acceptanceRuns: api(
      `repos/${repository}/actions/workflows/${acceptanceWorkflowFile}/runs?per_page=100`,
    ).workflow_runs,
    artifactsFor: runId =>
      api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`)
        .artifacts,
    currentRunId: env.GITHUB_RUN_ID,
    jobsFor: runId =>
      api(
        `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      ).jobs,
    publishRuns: api(
      `repos/${repository}/actions/workflows/publish-bleedingdev.yml/runs?branch=main-ultramodern&event=workflow_dispatch&per_page=30`,
    ).workflow_runs,
    repository,
    serverUrl: env.GITHUB_SERVER_URL,
  });
}
