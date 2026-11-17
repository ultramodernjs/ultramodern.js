// Consumer: publish-bleedingdev.yml qualify-source and prepare-release jobs.
//
// A recovery dispatch (`recovery_run_id`) publishes bytes an earlier run
// produced, but `qualify-source` qualifies this run's own HEAD, and the
// recovered manifest only has to name an *ancestor* of it. Nothing therefore
// proved that the commit whose bytes reach the registry was ever qualified: a
// run whose qualification failed while its producer succeeded still leaves a
// recoverable bundle behind.
//
// This receipt is that proof. `qualify-source` records the exact commit it
// qualified, bound to its own run identity, and a recovery run may reuse a
// prior bundle only when that run's receipt names the manifest's own source
// commit. Once the proof is required, re-running the *source* suites in a
// recovery run would only qualify a commit nothing publishes, so the recovery
// lane skips them. It does not skip the tooling qualification: the workflow and
// the OIDC publish CLIs always come from the dispatch's own HEAD.
//
// A recovery run records no receipt of its own — the create/upload steps are
// source-lane only — so a repeated recovery keeps naming the original producer
// run rather than chaining through the recovery run before it.
//
// `runAttempt` is the attempt that recorded the receipt, which need not be the
// attempt that produced the bundle: a native failed-job rerun advances only the
// failed jobs. The workflow addresses it with `recovery_qualification_attempt`,
// independent of `recovery_run_attempt`. That decoupling is safe because the
// attempt only selects the artifact; `expectedCommit` below is what authorizes
// the reuse.
//
// Schema version 2 also records which integration evidence qualified the
// commit: the suites this run executed (`in-run`), or the pull request
// Integration Test run that select-integration-evidence proved tested this
// exact tree (`reused`). The release record links to the publication run, so
// this receipt and that run's summary keep the record truthful either way.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceQualificationSchema =
  'bleedingdev.ultramodern.source-qualification';
export const sourceQualificationSchemaVersion = 2;
export const sourceQualificationArtifactPrefix =
  'bleedingdev-source-qualification';
export const integrationWorkflowPath = '.github/workflows/integration-test.yml';

const repositoryPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

function assertPattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is not a valid ${label.toLowerCase()}`);
  }
  return value;
}

function runIdentityOf({ repository, runAttempt, runId }) {
  return `github:${repository}:run:${runId}:attempt:${runAttempt}`;
}

function runUrlOf({ repository, runId }) {
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

const sameKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());

const inRunKeys = ['mode', 'runAttempt', 'runId'];
const reusedKeys = [
  'mode',
  'payloadSha256',
  'repository',
  'runAttempt',
  'runId',
  'testedCommit',
  'tree',
  'url',
  'workflow',
];

// Either this run's own integration job, or a reused pull request run whose
// tested tree equals the tree of the qualified commit.
export function assertIntegrationEvidence(
  integration,
  { repository, runAttempt, runId, sourceTree },
) {
  const invalid = () => {
    throw new Error(
      'Source qualification receipt does not record valid integration evidence',
    );
  };
  if (sameKeys(integration, inRunKeys) && integration.mode === 'in-run') {
    if (integration.runId !== runId || integration.runAttempt !== runAttempt) {
      invalid();
    }
    return integration;
  }
  if (!sameKeys(integration, reusedKeys) || integration.mode !== 'reused') {
    invalid();
  }
  try {
    assertPattern(integration.runId, runIdPattern, 'Run id');
    assertPattern(integration.runAttempt, runIdPattern, 'Run attempt');
    assertPattern(integration.testedCommit, commitPattern, 'Source commit');
    assertPattern(integration.tree, commitPattern, 'Source tree');
    assertPattern(integration.payloadSha256, digestPattern, 'Digest');
  } catch {
    invalid();
  }
  if (
    integration.repository !== repository ||
    integration.workflow !== integrationWorkflowPath ||
    integration.runId === runId ||
    integration.url !== runUrlOf({ repository, runId: integration.runId }) ||
    (sourceTree !== undefined && integration.tree !== sourceTree)
  ) {
    invalid();
  }
  return integration;
}

function integrationEvidenceOf({
  decision,
  repository,
  runAttempt,
  runId,
  sourceTree,
  reused,
}) {
  if (decision === 'run') {
    return assertIntegrationEvidence(
      { mode: 'in-run', runId, runAttempt },
      { repository, runAttempt, runId },
    );
  }
  if (decision !== 'reuse') {
    throw new Error(`Unknown integration decision ${String(decision)}`);
  }
  return assertIntegrationEvidence(
    {
      mode: 'reused',
      repository,
      workflow: integrationWorkflowPath,
      runId: reused?.runId,
      runAttempt: reused?.runAttempt,
      testedCommit: reused?.testedCommit,
      tree: reused?.tree,
      url: reused?.url,
      payloadSha256: reused?.payloadSha256,
    },
    {
      repository,
      runAttempt,
      runId,
      sourceTree: assertPattern(sourceTree, commitPattern, 'Source tree'),
    },
  );
}

export function integrationEvidenceSummary(integration) {
  if (integration.mode === 'in-run') {
    return `Integration ran in this publish (run ${integration.runId} attempt ${integration.runAttempt}).`;
  }
  return `Integration reused from [run ${integration.runId}](${integration.url}) attempt ${integration.runAttempt}, tested commit \`${integration.testedCommit}\`, tree \`${integration.tree}\` = this commit's tree, compiler payload sha256 \`${integration.payloadSha256}\`.`;
}

export function sourceQualificationArtifactName({ runAttempt, runId }) {
  return `${sourceQualificationArtifactPrefix}-run-${assertPattern(
    runId,
    runIdPattern,
    'Run id',
  )}-attempt-${assertPattern(runAttempt, runIdPattern, 'Run attempt')}`;
}

export function createSourceQualification({
  commit,
  integrationDecision,
  outPath,
  repository,
  reusedIntegration,
  runAttempt,
  runId,
  sourceTree,
}) {
  const receipt = {
    schema: sourceQualificationSchema,
    schemaVersion: sourceQualificationSchemaVersion,
    source: {
      repository: assertPattern(repository, repositoryPattern, 'Repository'),
      commit: assertPattern(commit, commitPattern, 'Source commit'),
    },
    runId: assertPattern(runId, runIdPattern, 'Run id'),
    runAttempt: assertPattern(runAttempt, runIdPattern, 'Run attempt'),
    runIdentity: runIdentityOf({ repository, runAttempt, runId }),
    integration: integrationEvidenceOf({
      decision: integrationDecision,
      repository,
      runAttempt,
      runId,
      sourceTree,
      reused: reusedIntegration,
    }),
  };
  if (typeof outPath !== 'string' || outPath.length === 0) {
    throw new Error('Receipt output path is required');
  }
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

// Fails closed on anything but a receipt this repository's run `runId`/
// `runAttempt` wrote. `expectedCommit` additionally binds it to the exact
// source commit of the bundle being recovered, so an ancestral bundle whose own
// commit was never qualified cannot be promoted.
export function verifySourceQualification({
  expectedCommit = null,
  receiptPath,
  repository,
  runAttempt,
  runId,
}) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const isPlainObject = value =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const expectedKeys = [
    'integration',
    'runAttempt',
    'runId',
    'runIdentity',
    'schema',
    'schemaVersion',
    'source',
  ].sort();
  if (
    !isPlainObject(receipt) ||
    JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify(expectedKeys) ||
    !isPlainObject(receipt.source) ||
    JSON.stringify(Object.keys(receipt.source).sort()) !==
      JSON.stringify(['commit', 'repository'])
  ) {
    throw new Error(
      'Source qualification receipt does not match the strict receipt shape',
    );
  }
  if (
    receipt.schema !== sourceQualificationSchema ||
    receipt.schemaVersion !== sourceQualificationSchemaVersion
  ) {
    throw new Error(
      `Unknown source qualification schema ${receipt.schema}@${receipt.schemaVersion}`,
    );
  }
  const expected = {
    repository: assertPattern(repository, repositoryPattern, 'Repository'),
    runId: assertPattern(runId, runIdPattern, 'Run id'),
    runAttempt: assertPattern(runAttempt, runIdPattern, 'Run attempt'),
  };
  if (
    receipt.source.repository !== expected.repository ||
    receipt.runId !== expected.runId ||
    receipt.runAttempt !== expected.runAttempt ||
    receipt.runIdentity !==
      runIdentityOf({
        repository: expected.repository,
        runAttempt: expected.runAttempt,
        runId: expected.runId,
      })
  ) {
    throw new Error(
      'Source qualification receipt was not produced by the recovered run',
    );
  }
  assertPattern(receipt.source.commit, commitPattern, 'Source commit');
  assertIntegrationEvidence(receipt.integration, expected);
  if (expectedCommit !== null) {
    if (
      assertPattern(expectedCommit, commitPattern, 'Source commit') !==
      receipt.source.commit
    ) {
      throw new Error(
        'Recovered release bundle was not qualified at its own source commit',
      );
    }
  }
  return receipt;
}

function required(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1 || typeof values[index + 1] !== 'string') {
    throw new Error(`Missing ${flag}`);
  }
  return values[index + 1];
}

function optional(values, flag) {
  return values.includes(flag) ? required(values, flag) : null;
}

export function runSourceQualificationCli(argv) {
  const [command, ...values] = argv;
  if (command === 'create') {
    const integrationDecision = required(values, '--integration-decision');
    const reused =
      integrationDecision === 'reuse'
        ? {
            runId: required(values, '--integration-run-id'),
            runAttempt: required(values, '--integration-run-attempt'),
            testedCommit: required(values, '--integration-tested-commit'),
            tree: required(values, '--integration-tree'),
            url: required(values, '--integration-url'),
            payloadSha256: required(values, '--integration-payload-sha256'),
          }
        : undefined;
    const receipt = createSourceQualification({
      commit: required(values, '--commit'),
      integrationDecision,
      outPath: required(values, '--out'),
      repository: required(values, '--repository'),
      reusedIntegration: reused,
      runAttempt: required(values, '--run-attempt'),
      runId: required(values, '--run-id'),
      sourceTree: optional(values, '--source-tree') ?? undefined,
    });
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Source qualification\n\n${integrationEvidenceSummary(receipt.integration)}\n`,
      );
    }
    return;
  }
  if (command === 'verify') {
    verifySourceQualification({
      expectedCommit: optional(values, '--expect-commit'),
      receiptPath: required(values, '--receipt'),
      repository: required(values, '--repository'),
      runAttempt: required(values, '--run-attempt'),
      runId: required(values, '--run-id'),
    });
    return;
  }
  throw new Error(`Unknown source qualification command ${String(command)}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSourceQualificationCli(process.argv.slice(2));
}
