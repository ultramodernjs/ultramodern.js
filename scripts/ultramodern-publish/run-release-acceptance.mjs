#!/usr/bin/env node
// Consumer: publish-bleedingdev.yml source and published ERP-10 acceptance receipts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptanceContinuationSchema,
  assertAcceptanceContinuation,
  verifyAcceptanceContinuationOperationalEvidence,
} from '../ultramodern-production-readiness/published-create-proof/acceptance-continuation.mjs';
import { assertReleaseAcceptanceProfile } from '../ultramodern-production-readiness/published-create-proof/acceptance-contract.mjs';
import {
  acceptedResolution,
  assertAcceptanceReceipt,
  readAcceptanceReceipt,
  verifyAcceptanceReceiptOperationalEvidence,
} from '../ultramodern-production-readiness/published-create-proof/acceptance-receipt.mjs';
import { generateVerticalNames } from '../ultramodern-production-readiness/published-create-proof/args.mjs';
import {
  defaultProjectName,
  scaleProfiles,
} from '../ultramodern-production-readiness/published-create-proof/constants.mjs';
import { run } from '../ultramodern-production-readiness/published-create-proof/process.mjs';
import { readReleaseManifest } from './lib/source-create-proof/release-manifest.mjs';
import { startEphemeralRegistry } from './lib/source-create-proof/runtime-proof/registry.mjs';

const defaultReleaseAgePolicyPath = fileURLToPath(
  new URL('./release-age-exceptions-2026-08-10.json', import.meta.url),
);

const valueOptions = new Set([
  '--cloudflare-run-log',
  '--continue-from',
  '--expected-source-revision',
  '--expected-mode',
  '--expected-version',
  '--manifest',
  '--mode',
  '--node-report',
  '--prior-run-log',
  '--receipt',
  '--registry-url',
  '--release-age-policy',
  '--run-identity',
  '--scale-profile',
  '--shell-finalization',
  '--source-receipt',
  '--store-dir',
  '--work-dir',
]);
const booleanOptions = new Set(['--verify-receipt']);

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.includes('=')) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (booleanOptions.has(argument)) {
      if (flags.has(argument)) {
        throw new Error(`Duplicate argument: ${argument}`);
      }
      flags.add(argument);
      continue;
    }
    if (!valueOptions.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (values.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }

  const explicitMode = values.get('--mode');
  const verifyFlag = flags.has('--verify-receipt');
  if (verifyFlag && explicitMode && explicitMode !== 'verify') {
    throw new Error(
      '--verify-receipt cannot be combined with a non-verify --mode',
    );
  }
  const mode = verifyFlag ? 'verify' : (explicitMode ?? 'prepublish');
  if (!['prepublish', 'published', 'verify'].includes(mode)) {
    throw new Error('--mode must be prepublish, published, or verify');
  }
  const expectedMode = values.get('--expected-mode') ?? 'source';
  if (!['source', 'published'].includes(expectedMode)) {
    throw new Error('--expected-mode must be source or published');
  }
  if (mode !== 'verify' && values.has('--expected-mode')) {
    throw new Error('--expected-mode is only valid with receipt verification');
  }

  const manifestValue = values.get('--manifest');
  if (!manifestValue) {
    throw new Error('--manifest is required');
  }
  const manifestPath = path.resolve(manifestValue);
  const releaseDir = path.dirname(manifestPath);
  if (path.basename(manifestPath) !== 'manifest.json') {
    throw new Error(
      `Strict release manifest must be ${path.join(releaseDir, 'manifest.json')}`,
    );
  }

  const receipt = values.get('--receipt');
  if (!receipt) {
    throw new Error('--receipt is required');
  }
  const sourceReceipt = values.get('--source-receipt');
  if ((mode === 'published') !== (sourceReceipt !== undefined)) {
    throw new Error(
      '--source-receipt names the passed source receipt whose resolution published acceptance must reproduce; it is required with --mode published and valid only there',
    );
  }
  const scaleProfile = values.get('--scale-profile') ?? 'erp-10';
  if (scaleProfile !== 'erp-10') {
    throw new Error('--scale-profile must be erp-10 for release acceptance');
  }
  const storeValue = values.get('--store-dir');
  if (
    storeValue !== undefined &&
    (!path.isAbsolute(storeValue) || storeValue.includes('\0'))
  ) {
    throw new Error('--store-dir must be an absolute path');
  }
  const workDirValue = values.get('--work-dir');
  if (
    workDirValue !== undefined &&
    (!path.isAbsolute(workDirValue) || workDirValue.includes('\0'))
  ) {
    throw new Error('--work-dir must be an absolute path');
  }
  if (workDirValue !== undefined && mode !== 'prepublish') {
    throw new Error('--work-dir is only valid with prepublish acceptance');
  }
  const continueFrom = values.get('--continue-from');
  if (continueFrom !== undefined) {
    if (!['source-node', 'source-workerd'].includes(continueFrom)) {
      throw new Error('--continue-from must be source-node or source-workerd');
    }
    if (mode !== 'prepublish') {
      throw new Error(
        '--continue-from is only valid with prepublish acceptance',
      );
    }
    if (workDirValue === undefined || !values.has('--prior-run-log')) {
      throw new Error(
        '--continue-from requires --work-dir and --prior-run-log',
      );
    }
    if (
      continueFrom === 'source-workerd' &&
      (!values.has('--node-report') || !values.has('--cloudflare-run-log'))
    ) {
      throw new Error(
        'source-workerd requires --node-report and --cloudflare-run-log',
      );
    }
    if (
      continueFrom === 'source-node' &&
      (values.has('--cloudflare-run-log') || values.has('--shell-finalization'))
    ) {
      throw new Error(
        '--cloudflare-run-log and --shell-finalization require source-workerd',
      );
    }
  } else if (values.has('--prior-run-log') || values.has('--node-report')) {
    throw new Error(
      '--prior-run-log and --node-report require --continue-from',
    );
  } else if (
    values.has('--cloudflare-run-log') ||
    values.has('--shell-finalization')
  ) {
    throw new Error(
      '--cloudflare-run-log and --shell-finalization require source-workerd',
    );
  }
  return {
    continueFrom,
    cloudflareRunLogPath: values.has('--cloudflare-run-log')
      ? path.resolve(values.get('--cloudflare-run-log'))
      : undefined,
    expectedSourceRevision: values.get('--expected-source-revision'),
    expectedMode,
    expectedVersion: values.get('--expected-version'),
    manifestPath,
    mode,
    nodeReportPath: values.has('--node-report')
      ? path.resolve(values.get('--node-report'))
      : undefined,
    priorRunLogPath: values.has('--prior-run-log')
      ? path.resolve(values.get('--prior-run-log'))
      : undefined,
    projectName: defaultProjectName,
    receiptPath: path.resolve(receipt),
    registryUrl: values.get('--registry-url') ?? 'https://registry.npmjs.org/',
    releaseAgePolicyPath: values.has('--release-age-policy')
      ? path.resolve(values.get('--release-age-policy'))
      : defaultReleaseAgePolicyPath,
    releaseDir,
    runIdentity: values.get('--run-identity'),
    scaleProfile,
    shellFinalizationPath: values.has('--shell-finalization')
      ? path.resolve(values.get('--shell-finalization'))
      : undefined,
    sourceReceiptPath:
      sourceReceipt === undefined ? undefined : path.resolve(sourceReceipt),
    storeDir: storeValue === undefined ? undefined : path.resolve(storeValue),
    workDir:
      workDirValue === undefined ? undefined : path.resolve(workDirValue),
  };
}

function assertExpectedRelease(release, options) {
  if (
    options.expectedSourceRevision &&
    release.source.commit !== options.expectedSourceRevision.toLowerCase()
  ) {
    throw new Error(
      `Release source commit ${release.source.commit} does not match expected ${options.expectedSourceRevision}`,
    );
  }
  if (
    options.expectedVersion &&
    release.release.version !== options.expectedVersion
  ) {
    throw new Error(
      `Release version ${release.release.version} does not match expected ${options.expectedVersion}`,
    );
  }
}

function resolveRunIdentity(release, explicit, env = process.env) {
  if (explicit) {
    if (explicit.trim() !== explicit || explicit.length < 3) {
      throw new Error('--run-identity must be a non-empty stable identity');
    }
    return explicit;
  }
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const runAttempt = env.GITHUB_RUN_ATTEMPT;
  if (!repository || !runId || !runAttempt) {
    throw new Error(
      '--run-identity is required outside a GitHub Actions run with GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT',
    );
  }
  if (repository.toLowerCase() !== release.source.repository.toLowerCase()) {
    throw new Error(
      `Workflow repository ${repository} does not match release source ${release.source.repository}`,
    );
  }
  if (!/^\d+$/u.test(runId) || !/^\d+$/u.test(runAttempt)) {
    throw new Error('GitHub run id and attempt must be decimal integers');
  }
  return `github:${release.source.repository}:run:${runId}:attempt:${runAttempt}`;
}

function profileOptions(options) {
  const selectedProfile = scaleProfiles[options.scaleProfile];
  return assertReleaseAcceptanceProfile({
    selectedProfile,
    scaleProfile: selectedProfile.id,
    verticalCount: selectedProfile.verticalCount,
    verticals: generateVerticalNames(selectedProfile.verticalCount),
    projectName: options.projectName,
    createPackage: undefined,
    deployCloudflare: false,
  });
}

function verifyReceipt({
  release,
  options,
  runIdentity,
  expectedMode = options.expectedMode,
}) {
  const receipt = readAcceptanceReceipt(options.receiptPath);
  if (receipt.schema === acceptanceContinuationSchema) {
    if (expectedMode !== 'source') {
      throw new Error('Acceptance continuation is only valid for source mode');
    }
    const verified = assertAcceptanceContinuation(receipt, {
      release,
      runIdentity,
    });
    verifyAcceptanceContinuationOperationalEvidence({
      receipt,
      receiptPath: options.receiptPath,
      release,
    });
    return verified;
  }
  const verified = assertAcceptanceReceipt(receipt, {
    release,
    profileId: options.scaleProfile,
    runIdentity,
    expectedMode,
  });
  // ACC-1: only source receipts carry operational-independence evidence.
  if (receipt.mode === 'source') {
    verifyAcceptanceReceiptOperationalEvidence(receipt, options.receiptPath);
  }
  return verified;
}

function verifyProducedReceipt({ release, options, runIdentity }) {
  return verifyReceipt({
    release,
    options,
    runIdentity,
    expectedMode: options.mode === 'published' ? 'published' : 'source',
  });
}

async function executeAcceptanceProfile({ supportGithubToken, ...options }) {
  const { supportAdmissionRun } = await import(
    './lib/support-release-admission.mjs'
  );
  const { runAcceptanceProfile } = await import(
    '../ultramodern-production-readiness/published-create-proof/acceptance-profile.mjs'
  );
  return runAcceptanceProfile({
    ...options,
    runImpl: supportAdmissionRun(run, { githubToken: supportGithubToken }),
  });
}

async function runPrepublish({
  release,
  options,
  runIdentity,
  supportGithubToken,
}) {
  if (options.continueFrom) {
    const { verifyInstalledSupportWorkspace } = await import(
      './lib/support-release-admission.mjs'
    );
    verifyInstalledSupportWorkspace(
      path.join(options.workDir, options.projectName),
      process.env,
      { githubToken: supportGithubToken },
    );
    const { runAcceptanceContinuation } = await import(
      '../ultramodern-production-readiness/published-create-proof/acceptance-continuation.mjs'
    );
    return runAcceptanceContinuation({
      release,
      options: profileOptions(options),
      outPath: options.receiptPath,
      runIdentity,
      workDir: options.workDir,
      storeDir: options.storeDir,
      priorRunLogPath: options.priorRunLogPath,
      nodeReportPath: options.nodeReportPath,
      cursor: options.continueFrom,
      cloudflareRunLogPath: options.cloudflareRunLogPath,
      shellFinalizationPath: options.shellFinalizationPath,
    });
  }
  if (options.workDir !== undefined) {
    const stat = fs.lstatSync(options.workDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(options.workDir) !== options.workDir ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      throw new Error(
        '--work-dir must be an existing physical caller-owned directory',
      );
    }
    const entries = fs.readdirSync(options.workDir);
    if (entries.some(entry => entry !== '.disk-guardian-owner')) {
      throw new Error(
        '--work-dir must be fresh; retained workspaces are rechecked with the browser-smoke CLI',
      );
    }
    if (entries.length > 0) {
      const marker = fs.lstatSync(
        path.join(options.workDir, '.disk-guardian-owner'),
      );
      if (!marker.isFile() || marker.isSymbolicLink()) {
        throw new Error('--work-dir ownership marker must be an ordinary file');
      }
    }
  }
  const registryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultramodern-verdaccio-'),
  );
  let registry;
  try {
    registry = await startEphemeralRegistry({
      release,
      releaseDir: options.releaseDir,
      rootDir: registryRoot,
      storeDir: options.storeDir,
    });
    return await executeAcceptanceProfile({
      supportGithubToken,
      mode: 'source',
      release,
      registryUrl: registry.registryUrl,
      registryEnv: registry.env,
      registryTool: registry.tool,
      options: profileOptions(options),
      outPath: options.receiptPath,
      runIdentity,
      releaseAgePolicyPath: options.releaseAgePolicyPath,
      storeDir: options.storeDir,
      // A supplied directory remains owned by the caller on success or failure.
      workDir: options.workDir,
    });
  } finally {
    await registry?.stop();
    fs.rmSync(registryRoot, { recursive: true, force: true });
  }
}

async function runPublished({
  release,
  options,
  runIdentity,
  supportGithubToken,
}) {
  const registryUrl = new URL(options.registryUrl).toString();
  const sourceReceipt = verifyReceipt({
    release,
    options: { ...options, receiptPath: options.sourceReceiptPath },
    runIdentity,
    expectedMode: 'source',
  });
  if (sourceReceipt.schema === acceptanceContinuationSchema) {
    throw new Error(
      '--source-receipt must be a complete source acceptance receipt; a source continuation carries no accepted resolution',
    );
  }
  return executeAcceptanceProfile({
    supportGithubToken,
    mode: 'published',
    acceptedResolution: acceptedResolution(sourceReceipt),
    release,
    registryUrl,
    registryEnv: {
      npm_config_registry: registryUrl,
      pnpm_config_registry: registryUrl,
    },
    registryTool: { name: 'npm-registry' },
    options: profileOptions(options),
    outPath: options.receiptPath,
    runIdentity,
    releaseAgePolicyPath: options.releaseAgePolicyPath,
    storeDir: options.storeDir,
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  // Only the trusted, read-only support verifier may receive this credential.
  // Remove it before registry, install, generator, build or browser children
  // can inherit process.env; retain it only in the coordinator's local state.
  const supportGithubToken = env.SUPPORT_ARTIFACT_GITHUB_TOKEN;
  delete env.SUPPORT_ARTIFACT_GITHUB_TOKEN;
  delete process.env.SUPPORT_ARTIFACT_GITHUB_TOKEN;
  const options = parseArgs(argv);
  const release = readReleaseManifest({ manifestPath: options.manifestPath });
  assertExpectedRelease(release, options);
  if (options.mode === 'verify' && !options.runIdentity) {
    throw new Error(
      '--run-identity is required for receipt verification and must identify the accepted producer run',
    );
  }
  const runIdentity = resolveRunIdentity(release, options.runIdentity, env);
  if (options.mode === 'verify') {
    const verified = verifyReceipt({ release, options, runIdentity });
    process.stdout.write(
      `Verified ERP-10 acceptance ${verified.schema === acceptanceContinuationSchema ? 'continuation' : 'receipt'} for ${release.release.version}.\n`,
    );
    return 0;
  }
  if (options.mode === 'published') {
    await runPublished({ release, options, runIdentity, supportGithubToken });
  } else {
    await runPrepublish({ release, options, runIdentity, supportGithubToken });
  }
  verifyProducedReceipt({ release, options, runIdentity });
  process.stdout.write(
    options.continueFrom
      ? `ERP-10 ${options.continueFrom} continuation passed for ${release.release.version}.\n`
      : `ERP-10 exact-artifact acceptance passed for ${release.release.version}.\n`,
  );
  return 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
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
  assertExpectedRelease,
  defaultReleaseAgePolicyPath,
  main,
  parseArgs,
  profileOptions,
  resolveRunIdentity,
  verifyProducedReceipt,
  verifyReceipt,
};
