#!/usr/bin/env node
// Fixed workflow commands. Job permissions, authentication and attempt bindings
// stay in GitHub Actions; these commands cannot publish packages.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isDirectRun } from './lib/direct-run.mjs';
import { assertRegistrySourceCommitUnpublished } from './lib/prepare-bleedingdev-packages/registry.mjs';
import { verifyReleaseArtifacts } from './lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { readPreviousReleaseAcceptance } from './lib/release-acceptance-gate.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = file =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function releaseManifest(env) {
  return verifyReleaseArtifacts(env.BLEEDINGDEV_RELEASE_DIR, {
    tag: env.BLEEDINGDEV_PUBLISH_TAG,
    version: env.PUBLISH_VERSION,
  });
}

async function rejectPublishedSource(env) {
  const packageName = '@bleedingdev/modern-js-ultramodern-create';
  const requestedVersion = env.PUBLISH_VERSION;
  const sourceCommit = env.GITHUB_SHA;
  const sourceRepository = env.GITHUB_REPOSITORY;

  await assertRegistrySourceCommitUnpublished({
    packageName,
    requestedVersion,
    sourceCommit,
    sourceRepository,
  });
}

function verifyBundle(env) {
  const release = releaseManifest(env);
  if (release.manifest.source.repository !== env.GITHUB_REPOSITORY) {
    throw new Error(
      'Release artifact repository does not match this repository',
    );
  }
  execFileSync(
    'git',
    [
      'merge-base',
      '--is-ancestor',
      release.manifest.source.commit,
      env.GITHUB_SHA,
    ],
    { stdio: 'inherit' },
  );
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `source_commit=${release.manifest.source.commit}\n`,
  );
}

function createPublishedIdentity(env) {
  const verified = releaseManifest(env);
  const manifest = verified.manifest;
  const manifestSha256 = verified.manifestSha256;
  const runId = env.GITHUB_RUN_ID;

  if (
    manifest.source.commit !== env.SOURCE_COMMIT ||
    manifest.source.repository !== env.GITHUB_REPOSITORY
  ) {
    throw new Error(
      'Release manifest source or release identity does not match this publish',
    );
  }
  const identity = {
    schema: 'bleedingdev.ultramodern.published-release-identity',
    schemaVersion: 2,
    releaseRunId: runId,
    producerArtifactIdentity: env.PRODUCER_ARTIFACT_IDENTITY,
    producerRunAttempt: env.PRODUCER_RUN_ATTEMPT,
    producerRunIdentity: env.PRODUCER_RUN_IDENTITY,
    publicationRunAttempt: env.PUBLICATION_RUN_ATTEMPT,
    source: manifest.source,
    release: manifest.release,
    cohortDigest: manifest.cohortDigest,
    manifestSha256,
    acceptanceReceiptSha256: sha256(env.BLEEDINGDEV_RELEASE_ACCEPTANCE_RECEIPT),
    dryRun: false,
  };
  fs.writeFileSync(
    env.BLEEDINGDEV_RELEASE_IDENTITY,
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `publication_run_attempt=${env.PUBLICATION_RUN_ATTEMPT}\n`,
  );
}

async function assertPreviousReleaseSettled(env) {
  const { status, message } = await readPreviousReleaseAcceptance(env);
  const summary = [
    '## Previous live cohort',
    '',
    `- ${{ clear: 'Accepted', withdrawn: 'NOT ACCEPTED, withdrawn', blocked: 'Blocks this cohort' }[status]}: ${message}`,
    '',
  ].join('\n');
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  }
  if (status === 'blocked') {
    throw new Error(message);
  }
  if (status === 'withdrawn') {
    console.log(`::error title=Previous cohort not accepted::${message}`);
    return;
  }
  console.log(message);
}

function summarizeDelivery(env) {
  const outcome = JSON.parse(
    fs.readFileSync(env.BLEEDINGDEV_PUBLISH_OUTCOME, 'utf8'),
  );
  const runUrl = id =>
    `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${id}`;
  const yesno = (label, value) =>
    value ? `passed (${label})` : 'skipped (dry run)';
  const lines = [];
  lines.push('## UltraModern publish delivery state');
  lines.push('');
  lines.push(
    outcome.dryRun
      ? `- Mode: dry run rehearsal of \`${outcome.release.version}\` — nothing below is promotable`
      : `- Mode: live publish of \`${outcome.release.version}\` @ \`${outcome.source.commit}\` ([publication](${runUrl(outcome.workflowRun.id)}), [published acceptance](${runUrl(outcome.acceptance.workflowRun.id)}))`,
  );
  lines.push(
    `- Immutable bundle / ERP-10 accepted (source): ${
      outcome.evidence.prepublishAcceptance ? 'passed' : 'missing'
    }`,
  );
  lines.push(
    `- npm \`${outcome.release.tag}\` cohort converged: ${yesno('verify-publication', !outcome.dryRun)}`,
  );
  lines.push(
    `- npm resolves the accepted ERP-10 closure: ${yesno('accept-published', outcome.evidence.publishedAcceptance !== null)}`,
  );
  lines.push(
    `- Published Tractor Node/workerd/browser accepted: ${yesno('tractor-downstream', outcome.evidence.tractorAcceptance !== null)}`,
  );
  const baseline = outcome.evidence.tractorAcceptance?.baselineRevision;
  lines.push(
    `- Tractor baseline used for published acceptance: ${baseline ? `\`${baseline}\`` : 'none (dry run)'}`,
  );
  lines.push(
    baseline
      ? `- Persistent Tractor adoption: REQUIRED, not automated by this workflow. Run published-mode acceptance using this release's exact bundle in a persistent ${env.TRACTOR_STORE_REPOSITORY} checkout, push the passing report's \`applicationSourceRevision\` to main, then advance \`scripts/ultramodern-publish/tractor-baseline-revision\` to it. The uploaded report contains no recoverable application source.`
      : '- Persistent Tractor main promotion/adoption: not applicable to a dry run.',
  );
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function sourceCommit(env) {
  process.stdout.write(
    readJson(env.BLEEDINGDEV_RELEASE_MANIFEST).source.commit,
  );
}

const commands = Object.freeze({
  'reject-published-source': rejectPublishedSource,
  'verify-bundle': verifyBundle,
  'create-published-identity': createPublishedIdentity,
  'assert-previous-release-settled': assertPreviousReleaseSettled,
  'summarize-delivery': summarizeDelivery,
  'source-commit': sourceCommit,
});

async function runWorkflowCommand(
  argv = process.argv.slice(2),
  env = process.env,
) {
  if (argv.length !== 1 || !Object.hasOwn(commands, argv[0])) {
    throw new Error(
      `Expected one workflow command: ${Object.keys(commands).join(', ')}`,
    );
  }
  await commands[argv[0]](env);
}

if (isDirectRun(import.meta.url)) {
  runWorkflowCommand().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { runWorkflowCommand };
