#!/usr/bin/env node
// Consumer: publish-bleedingdev.yml `record-publish-outcome` create command;
// exports also support fail-closed publish-outcome artifact discovery.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import validationKit from '../lib/validation-kit.js';
import { assertOperationalIndependenceEvidenceMatchesReceipt } from '../ultramodern-production-readiness/published-create-proof/acceptance-contract.mjs';
import { assertAcceptanceReceipt } from '../ultramodern-production-readiness/published-create-proof/acceptance-receipt.mjs';
import {
  assertTractorAcceptanceReport,
  promotableTractorAcceptanceMode,
} from '../ultramodern-production-readiness/tractor-downstream/contract.mjs';
import { isDirectRun } from './lib/direct-run.mjs';
import { readReleaseManifest } from './lib/source-create-proof/release-manifest.mjs';

const { assertNonEmptyString: assertBaseNonEmptyString, assertPlainObject } =
  validationKit;

const publishOutcomeSchema = 'bleedingdev.ultramodern.publish-outcome';
const publishOutcomeSchemaVersion = 6;
const publishOutcomeArtifactPrefix = 'bleedingdev-publish-outcome';
const digestPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function assertNonEmptyString(value, label) {
  assertBaseNonEmptyString(value, label);
  if (/\r|\n/u.test(value)) {
    throw new Error(`${label} must not contain line breaks`);
  }
}

function positiveInteger(value, label) {
  const normalized =
    typeof value === 'string' && /^[1-9]\d*$/u.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return normalized;
}

function runIdString(value, label = 'workflow run id') {
  const normalized = String(value);
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error(`${label} must be a positive decimal integer`);
  }
  return normalized;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function readJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} must contain valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parsed;
}

function sha256File(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function readTractorAcceptanceEvidence({
  baselineRevision,
  manifest,
  reportPath,
  reportSha256,
}) {
  if (
    reportPath === undefined &&
    baselineRevision === undefined &&
    reportSha256 === undefined
  ) {
    return null;
  }
  if (
    reportPath === undefined ||
    baselineRevision === undefined ||
    reportSha256 === undefined
  ) {
    throw new Error(
      'Tractor acceptance report, baseline revision, and SHA-256 must be provided together',
    );
  }
  assertSourceCommit(baselineRevision, 'Tractor baseline revision');
  assertDigest(reportSha256, 'Tractor report SHA-256');
  const actualSha256 = sha256File(reportPath);
  if (actualSha256 !== reportSha256) {
    throw new Error(
      'Tractor acceptance report SHA-256 does not match the workflow output',
    );
  }
  // Second promotion barrier, independent of the evidence binder: publish
  // outcome identity accepts only the published-mode report. A pre-publication
  // rehearsal report carries mode 'source' and can never satisfy this.
  assertTractorAcceptanceReport(
    readJson(reportPath, 'Tractor acceptance report'),
    { baselineRevision, manifest, mode: promotableTractorAcceptanceMode },
  );
  return {
    baselineRevision,
    reportSha256: actualSha256,
  };
}

function publishOutcomeArtifactName({ runId, runAttempt }) {
  return `${publishOutcomeArtifactPrefix}-run-${runIdString(
    runId,
  )}-attempt-${positiveInteger(runAttempt, 'workflow run attempt')}`;
}

function assertRepository(value, label) {
  assertNonEmptyString(value, label);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(value)) {
    throw new Error(`${label} must be an owner/repository identity`);
  }
}

function assertSourceCommit(value, label) {
  if (typeof value !== 'string' || !commitPattern.test(value)) {
    throw new Error(`${label} must be a full lowercase Git object id`);
  }
}

function assertVersion(value, label) {
  if (typeof value !== 'string' || !semverPattern.test(value)) {
    throw new Error(`${label} must be an exact semantic version`);
  }
}

function readReleaseEvidence({
  cohortDigestPath,
  manifestDigestPath,
  manifestPath,
  operationalEvidencePath,
  publishedReceiptPath,
  receiptPath,
  repository,
  runIdentity,
  sourceCommit,
  tag,
  tractorBaselineRevision,
  tractorReportPath,
  tractorReportSha256,
  version,
}) {
  const manifest = readReleaseManifest({ manifestPath });
  if (
    manifest.source.repository !== repository ||
    manifest.source.commit !== sourceCommit ||
    manifest.release.version !== version ||
    manifest.release.tag !== tag
  ) {
    throw new Error(
      'Release manifest does not match the expected source and version',
    );
  }

  const manifestSha256 = manifest.manifestSha256;
  const detachedManifest = fs.readFileSync(manifestDigestPath, 'utf8');
  const detachedCohort = fs.readFileSync(cohortDigestPath, 'utf8');
  if (detachedManifest !== `${manifestSha256}  manifest.json\n`) {
    throw new Error('Detached release manifest digest is invalid');
  }
  if (detachedCohort !== `${manifest.cohortDigest}\n`) {
    throw new Error('Detached release cohort digest is invalid');
  }
  const acceptanceEvidence = (receiptFile, operationalFile, expectedMode) => {
    const receipt = readJson(receiptFile, `${expectedMode} acceptance receipt`);
    assertPlainObject(receipt, `${expectedMode} acceptance receipt`);
    assertAcceptanceReceipt(receipt, {
      expectedMode,
      profileId: 'erp-10',
      release: manifest,
      runIdentity,
    });
    // ACC-1: operational-independence evidence exists only in the source
    // lane; the published receipt contract excludes that result id.
    if (expectedMode !== 'source') {
      return {
        closureSha256: receipt.binding.supplyChain.closureSha256,
        evidencePath: null,
        receiptPath: path.basename(receiptFile),
      };
    }
    const operationalEvidence = readJson(
      operationalFile,
      `${expectedMode} operational evidence`,
    );
    assertPlainObject(
      operationalEvidence,
      `${expectedMode} operational evidence`,
    );
    const operationalResult = receipt.results.find(
      result => result?.id === 'operational-independence',
    );
    assertOperationalIndependenceEvidenceMatchesReceipt({
      details: operationalResult.details,
      evidence: operationalEvidence,
    });
    if (
      operationalResult?.details?.artifactMode !== expectedMode ||
      path.basename(operationalResult?.details?.evidencePath ?? '') !==
        path.basename(operationalFile)
    ) {
      throw new Error(
        `${expectedMode} acceptance receipt is not bound to the exact operational evidence`,
      );
    }
    return {
      closureSha256: receipt.binding.supplyChain.closureSha256,
      evidencePath: path.basename(operationalFile),
      receiptPath: path.basename(receiptFile),
    };
  };

  const prepublishAcceptance = acceptanceEvidence(
    receiptPath,
    operationalEvidencePath,
    'source',
  );
  const publishedAcceptance =
    publishedReceiptPath === undefined
      ? null
      : acceptanceEvidence(publishedReceiptPath, undefined, 'published');
  // The published receipt proves only that npm resolves the closure the
  // source receipt built and ran; both receipts must name that one closure.
  if (
    publishedAcceptance !== null &&
    publishedAcceptance.closureSha256 !== prepublishAcceptance.closureSha256
  ) {
    throw new Error(
      'Published acceptance resolved a different dependency closure than the source acceptance built and ran',
    );
  }
  const tractorAcceptance = readTractorAcceptanceEvidence({
    baselineRevision: tractorBaselineRevision,
    manifest,
    reportPath: tractorReportPath,
    reportSha256: tractorReportSha256,
  });

  return {
    cohortDigest: manifest.cohortDigest,
    manifestSha256,
    prepublishAcceptance,
    publishedAcceptance,
    tractorAcceptance,
  };
}

function expectedProducerIdentity({ repository, runAttempt, runId }) {
  return `github:${repository}:run:${runIdString(runId)}:attempt:${positiveInteger(
    runAttempt,
    'producer run attempt',
  )}`;
}

function validateProducer({
  artifactIdentity,
  publicationRunAttempt,
  repository,
  runAttempt,
  runId,
  runIdentity,
}) {
  const normalizedAttempt = positiveInteger(runAttempt, 'Producer run attempt');
  const normalizedPublicationAttempt = positiveInteger(
    publicationRunAttempt,
    'Publication run attempt',
  );
  const normalizedRunId = runIdString(runId);
  if (normalizedAttempt > normalizedPublicationAttempt) {
    throw new Error(
      'Producer run attempt must not follow publication run attempt',
    );
  }
  if (
    artifactIdentity !== `run-${normalizedRunId}-attempt-${normalizedAttempt}`
  ) {
    throw new Error(
      'Producer artifact identity does not match the producer run',
    );
  }
  if (
    runIdentity !==
    expectedProducerIdentity({
      repository,
      runAttempt: normalizedAttempt,
      runId: normalizedRunId,
    })
  ) {
    throw new Error(
      'Producer run identity does not match the authenticated source run',
    );
  }
  return normalizedAttempt;
}

function createPublishOutcome({
  acceptanceRecovery,
  cohortDigestPath,
  dryRun,
  manifestDigestPath,
  manifestPath,
  operationalEvidencePath,
  outPath,
  publicationRunAttempt,
  producerArtifactIdentity,
  producerRunAttempt,
  producerRunIdentity,
  publishedReceiptPath,
  receiptPath,
  repository,
  runAttempt,
  runId,
  sourceCommit,
  tag,
  tractorBaselineRevision,
  tractorReportPath,
  tractorReportSha256,
  version,
}) {
  assertRepository(repository, 'Expected repository');
  assertSourceCommit(sourceCommit, 'Expected source commit');
  assertVersion(version, 'Expected release version');
  assertNonEmptyString(tag, 'Expected release tag');
  if (typeof dryRun !== 'boolean') {
    throw new Error('dryRun must be a boolean');
  }
  const normalizedRunId = runIdString(runId);
  const normalizedRunAttempt = positiveInteger(
    runAttempt,
    'Workflow run attempt',
  );
  const normalizedPublicationAttempt = dryRun
    ? null
    : positiveInteger(publicationRunAttempt, 'Publication run attempt');
  if (
    normalizedPublicationAttempt !== null &&
    normalizedPublicationAttempt > normalizedRunAttempt
  ) {
    throw new Error(
      'Publication run attempt must not follow workflow outcome attempt',
    );
  }
  const expectedArtifactName = publishOutcomeArtifactName({
    runId: normalizedRunId,
    runAttempt: normalizedRunAttempt,
  });
  let recovery;
  if (acceptanceRecovery !== undefined) {
    assertPlainObject(acceptanceRecovery, 'Acceptance recovery');
    assertSourceCommit(
      acceptanceRecovery.sourceCommit,
      'Recovery tooling commit',
    );
    const recoveryRunId = runIdString(
      acceptanceRecovery.runId,
      'Recovery run id',
    );
    const recoveryAttempt = positiveInteger(
      acceptanceRecovery.runAttempt,
      'Recovery run attempt',
    );
    const tractorRunAttempt = positiveInteger(
      acceptanceRecovery.tractorRunAttempt,
      'Recovered Tractor run attempt',
    );
    if (tractorRunAttempt > recoveryAttempt) {
      throw new Error('Recovered Tractor attempt cannot follow its outcome');
    }
    if (dryRun || recoveryRunId === normalizedRunId) {
      throw new Error(
        'Acceptance recovery must name a separate live acceptance run',
      );
    }
    recovery = {
      result: 'tractor-downstream',
      sourceCommit: acceptanceRecovery.sourceCommit,
      tractorRunAttempt,
      workflowRun: { id: recoveryRunId, attempt: recoveryAttempt },
    };
  }
  const normalizedProducerAttempt = validateProducer({
    artifactIdentity: producerArtifactIdentity,
    publicationRunAttempt: normalizedPublicationAttempt ?? normalizedRunAttempt,
    repository,
    runAttempt: producerRunAttempt,
    runId: normalizedRunId,
    runIdentity: producerRunIdentity,
  });
  const evidence = readReleaseEvidence({
    cohortDigestPath,
    manifestDigestPath,
    manifestPath,
    operationalEvidencePath,
    publishedReceiptPath,
    receiptPath,
    repository,
    runIdentity: producerRunIdentity,
    sourceCommit,
    tag,
    tractorBaselineRevision,
    tractorReportPath,
    tractorReportSha256,
    version,
  });
  if (
    (dryRun &&
      (evidence.publishedAcceptance !== null ||
        evidence.tractorAcceptance !== null)) ||
    (!dryRun &&
      (evidence.publishedAcceptance === null ||
        evidence.tractorAcceptance === null))
  ) {
    throw new Error(
      dryRun
        ? 'Dry-run publish outcome must not contain published or Tractor acceptance evidence'
        : 'Non-dry publish outcome requires published and Tractor acceptance evidence',
    );
  }
  const outcome = {
    schema: publishOutcomeSchema,
    // Version 7 preserves the original publication and separately identifies
    // the execution that supplied its missing Tractor acceptance.
    schemaVersion: recovery ? 7 : publishOutcomeSchemaVersion,
    artifactName: recovery
      ? `bleedingdev-recovered-publish-outcome-run-${recovery.workflowRun.id}-attempt-${recovery.workflowRun.attempt}`
      : expectedArtifactName,
    dryRun,
    source: { commit: sourceCommit, repository },
    release: { tag, version },
    workflowRun: { attempt: normalizedRunAttempt, id: normalizedRunId },
    publication:
      normalizedPublicationAttempt === null
        ? null
        : { runAttempt: normalizedPublicationAttempt },
    producer: {
      artifactIdentity: producerArtifactIdentity,
      runAttempt: normalizedProducerAttempt,
      runIdentity: producerRunIdentity,
    },
    evidence,
    ...(recovery ? { acceptanceRecovery: recovery } : {}),
  };
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

function parseOptions(argv, allowed) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Unknown or incomplete argument: ${name ?? '<missing>'}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate argument: ${name}`);
    }
    values.set(name, value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function booleanValue(value, label) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${label} must be true or false`);
}

function appendGithubOutputs(filePath, outputs) {
  if (!filePath) {
    return;
  }
  const lines = Object.entries(outputs).map(([name, value]) => {
    const normalized = String(value);
    assertNonEmptyString(normalized, `GitHub output ${name}`);
    return `${name}=${normalized}`;
  });
  fs.appendFileSync(filePath, `${lines.join('\n')}\n`);
}

const evidenceOptions = new Set([
  '--cohort-digest',
  '--manifest',
  '--manifest-digest',
  '--operational-evidence',
  '--published-receipt',
  '--receipt',
  '--tractor-baseline-revision',
  '--tractor-report',
  '--tractor-report-sha256',
]);

function evidencePaths(values, { dryRun } = {}) {
  const publishedReceipt = values.get('--published-receipt');
  const tractorBaselineRevision = values.get('--tractor-baseline-revision');
  const tractorReport = values.get('--tractor-report');
  const tractorReportSha256 = values.get('--tractor-report-sha256');
  if (dryRun === false && publishedReceipt === undefined) {
    throw new Error('Non-dry publish outcome requires --published-receipt');
  }
  if (dryRun === true && publishedReceipt !== undefined) {
    throw new Error('Dry-run publish outcome must not bind published evidence');
  }
  const tractorValues = [
    tractorBaselineRevision,
    tractorReportSha256,
    tractorReport,
  ];
  if (
    tractorValues.some(value => value === undefined) &&
    tractorValues.some(value => value !== undefined)
  ) {
    throw new Error(
      '--tractor-baseline-revision, --tractor-report, and --tractor-report-sha256 must be provided together',
    );
  }
  if (dryRun === false && tractorReport === undefined) {
    throw new Error(
      'Non-dry publish outcome requires Tractor acceptance evidence',
    );
  }
  if (dryRun === true && tractorReport !== undefined) {
    throw new Error('Dry-run publish outcome must not bind Tractor evidence');
  }
  return {
    cohortDigestPath: path.resolve(required(values, '--cohort-digest')),
    manifestDigestPath: path.resolve(required(values, '--manifest-digest')),
    manifestPath: path.resolve(required(values, '--manifest')),
    operationalEvidencePath: path.resolve(
      required(values, '--operational-evidence'),
    ),
    publishedReceiptPath:
      publishedReceipt === undefined
        ? undefined
        : path.resolve(publishedReceipt),
    receiptPath: path.resolve(required(values, '--receipt')),
    tractorBaselineRevision,
    tractorReportPath:
      tractorReport === undefined ? undefined : path.resolve(tractorReport),
    tractorReportSha256,
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'create') {
    const values = parseOptions(
      args,
      new Set([
        ...evidenceOptions,
        '--dry-run',
        '--github-output',
        '--out',
        '--publication-run-attempt',
        '--producer-artifact-identity',
        '--producer-run-attempt',
        '--producer-run-identity',
        '--repository',
        '--run-attempt',
        '--run-id',
        '--source-commit',
        '--tag',
        '--version',
      ]),
    );
    const dryRun = booleanValue(required(values, '--dry-run'), '--dry-run');
    const outcome = createPublishOutcome({
      ...evidencePaths(values, { dryRun }),
      dryRun,
      outPath: path.resolve(required(values, '--out')),
      publicationRunAttempt: dryRun
        ? undefined
        : required(values, '--publication-run-attempt'),
      producerArtifactIdentity: required(
        values,
        '--producer-artifact-identity',
      ),
      producerRunAttempt: required(values, '--producer-run-attempt'),
      producerRunIdentity: required(values, '--producer-run-identity'),
      repository: required(values, '--repository'),
      runAttempt: required(values, '--run-attempt'),
      runId: required(values, '--run-id'),
      sourceCommit: required(values, '--source-commit'),
      tag: required(values, '--tag'),
      version: required(values, '--version'),
    });
    appendGithubOutputs(values.get('--github-output'), {
      artifact_name: outcome.artifactName,
    });
    return 0;
  }
  throw new Error('Command must be create');
}

if (isDirectRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

export {
  createPublishOutcome,
  main,
  publishOutcomeArtifactName,
  publishOutcomeArtifactPrefix,
  publishOutcomeSchema,
  publishOutcomeSchemaVersion,
  readReleaseEvidence,
};
