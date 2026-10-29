import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parse as load } from 'yaml';
import { readReleaseManifest } from '../../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import { defaultReleaseAgePolicyPath } from '../../ultramodern-publish/run-release-acceptance.mjs';
import {
  assertLocalPortsAvailable,
  launchBrowser,
  startServer,
  startWorkerdProof,
} from '../browser-smoke/bootstrap.mjs';
import { validateNoJavaScriptSsrTarget } from '../browser-smoke/browser-validate.mjs';
import { readSmokeContract } from '../browser-smoke/contract.mjs';
import {
  validateHttpTarget,
  waitForTarget,
} from '../browser-smoke/http-validate.mjs';
import { bindContractToReleaseIdentity } from '../browser-smoke/runtime-evidence.mjs';
import {
  createSmokeTargets,
  orderTargetsForLocalStartup,
} from '../browser-smoke/targets.mjs';
import {
  acceptancePlaywrightInstallArgs,
  createAcceptanceRuntimeContext,
  resolveExactPnpmExecutable,
  snapshotAcceptanceWorkspaceSource,
  withAcceptancePlaywrightBrowsersPath,
} from '../published-create-proof/acceptance-profile.mjs';
import { writeJsonFile } from '../published-create-proof/constants.mjs';
import {
  createPnpmDlxArgs,
  resolveCreatePackage,
} from '../published-create-proof/package-cohort.mjs';
import {
  createAcceptanceWorkspaceEnv,
  run,
} from '../published-create-proof/process.mjs';
import {
  releaseAgeExemptions,
  validateExactExclusions,
} from '../published-create-proof/release-age-audit.mjs';
import {
  assertAuthenticatedTractorCohort,
  assertExactModernDependencySpecifiers,
  assertTractorEffectDependencies,
  assertTractorReactDependencies,
  prepareTractorCohortInstallation,
  tractorEffectPackages,
  tractorReactPackages,
} from './cohort-install.mjs';
import {
  assertNativeTanStackSearch,
  assertTractorAcceptanceReport,
  assertVisibleTractorUi,
  collectPackageJsonFiles,
  promotableTractorAcceptanceMode,
  requiredVisibleRuntimePlatforms,
  tractorAcceptanceModes,
} from './contract.mjs';

const defaultOut =
  '.modern/production-readiness/tractor-downstream-acceptance.json';
// The ephemeral registry the source-candidate rehearsal seeds binds to loopback
// only (see startEphemeralRegistry). Stating the host here lets both directions
// of the mode/registry pairing fail closed: a rehearsal may reach nothing else,
// and a published acceptance may never be satisfied by it.
const sourceCandidateRegistryHost = '127.0.0.1';
// Naming either of these routes every dependency, not just the cohort scope,
// at the stated registry. Only the published lane is allowed to do that.
const globalRegistryEnvKeys = Object.freeze([
  'npm_config_registry',
  'pnpm_config_registry',
]);
const nodeBackendProofPath =
  '.codex/reports/node-backend-federation-proof/proof.json';
const requiredCommands = Object.freeze([
  Object.freeze(['pnpm', ['install', '--frozen-lockfile']]),
  // Installation refreshes pinned skills.
  // Run the consumer's standard formatter before its mandatory quality checks.
  Object.freeze(['pnpm', ['format']]),
  Object.freeze(['pnpm', ['check']]),
  Object.freeze(['pnpm', ['build']]),
  Object.freeze(['pnpm', ['node:proof']]),
  Object.freeze(['pnpm', ['cloudflare:build']]),
]);
const executionCommands = Object.freeze([
  Object.freeze({ command: requiredCommands[0], report: true }),
  // Runs after the frozen install so `pnpm exec` resolves the playwright the
  // downstream lockfile already pinned. Operational, never reported: it
  // provisions the runtime and contributes no acceptance check id.
  Object.freeze({
    command: Object.freeze(['pnpm', acceptancePlaywrightInstallArgs]),
    report: false,
  }),
  ...requiredCommands
    .slice(1)
    .map(command => Object.freeze({ command, report: true })),
]);

function createTractorPnpmDlxArgs(
  createPackage,
  minimumReleaseAgeExclude,
  forwardedArgs,
  environment,
) {
  const exactExclusions = validateExactExclusions(
    minimumReleaseAgeExclude,
    'Tractor bootstrap minimumReleaseAgeExclude',
  );
  const baseArgs = createPnpmDlxArgs(createPackage, forwardedArgs, environment);
  const dlxIndex = baseArgs.indexOf('dlx');
  if (dlxIndex < 0) {
    throw new Error('Authenticated create command is missing pnpm dlx');
  }
  const inheritedExclusions = baseArgs
    .slice(0, dlxIndex)
    .filter(argument =>
      argument.startsWith('--config.minimum-release-age-exclude='),
    )
    .map(argument => argument.slice(argument.indexOf('=') + 1));
  if (
    inheritedExclusions.some(specifier => !exactExclusions.includes(specifier))
  ) {
    throw new Error(
      'Tractor bootstrap exclusions must contain the authenticated create closure',
    );
  }
  return [
    ...baseArgs
      .slice(0, dlxIndex)
      .filter(
        argument =>
          !argument.startsWith('--config.minimum-release-age-exclude='),
      ),
    ...exactExclusions.map(
      specifier => `--config.minimum-release-age-exclude=${specifier}`,
    ),
    ...baseArgs.slice(dlxIndex),
  ];
}

function createTractorPackageManagerContext({
  mode,
  release,
  expectedPnpmVersion,
  environment = process.env,
  packageManagerRoot,
  registryEnv,
  storeDir,
  resolveExactPnpmExecutableImpl = resolveExactPnpmExecutable,
  runImpl = run,
}) {
  // Thin delegate: the shared acceptance owner decides the exact pnpm
  // executable, PATH, registry, npm/pnpm stores, XDG cache, and
  // PLAYWRIGHT_BROWSERS_PATH. Native workspace YAML owns the age and trust
  // policy. The registry environment is decided by the mode
  // (see resolveAcceptanceRegistryEnv) and passed straight through.
  const runtime = createAcceptanceRuntimeContext({
    browsers: 'isolated',
    environment: {
      ...environment,
      PATH: [path.dirname(process.execPath), environment.PATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
    expectedPnpmVersion,
    registryEnv,
    storeDir,
    resolveExactPnpmExecutableImpl,
    runImpl,
    workDir: packageManagerRoot,
  });
  const env = createAcceptanceWorkspaceEnv(runtime.env, {
    mode,
    release,
    registryEnv,
  });
  // Tractor's committed pnpm-workspace.yaml owns pmOnFail. Its packageManager is
  // pinned to this exact pnpm, so that policy cannot trip; overriding it would
  // leave packageManagerDependencies out of the adopted lockfile, which
  // Tractor's own frozen CI install then rejects.
  env.pnpm_config_pm_on_fail = undefined;
  // An executable pnpm directory can itself contain a different node binary.
  // Keep the accepted interpreter first, including in that case.
  env.PATH = [
    ...new Set([
      path.dirname(process.execPath),
      ...env.PATH.split(path.delimiter),
    ]),
  ].join(path.delimiter);
  return { env, pnpmExecutable: runtime.pnpmExecutable };
}

// Obtain the current policy from the exact producer, using its ordinary
// fresh-workspace command rather than duplicating framework defaults here.
function readTractorProducerOverrides({
  createPackage,
  minimumReleaseAgeExclude,
  packageManager,
  packageManagerRoot,
  runImpl = run,
}) {
  const root = fs.mkdtempSync(
    path.join(packageManagerRoot, 'producer-policy-'),
  );
  const workspace = path.join(root, 'workspace');
  try {
    runImpl(
      packageManager.pnpmExecutable,
      createTractorPnpmDlxArgs(
        createPackage,
        minimumReleaseAgeExclude,
        [workspace, '--lang', 'en', '--no-agents-md'],
        packageManager.env,
      ),
      { cwd: root, env: packageManager.env },
    );
    const policy = load(
      fs.readFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'utf8'),
    );
    const overrides = policy?.overrides;
    if (
      !overrides ||
      typeof overrides !== 'object' ||
      Array.isArray(overrides) ||
      Object.values(overrides).some(value => typeof value !== 'string')
    ) {
      throw new Error(
        'Exact producer workspace must provide native pnpm overrides',
      );
    }
    if (
      policy.minimumReleaseAge !== 1440 ||
      policy.minimumReleaseAgeStrict !== true ||
      policy.minimumReleaseAgeIgnoreMissingTime !== false ||
      policy.trustPolicy !== 'no-downgrade' ||
      policy.trustPolicyIgnoreAfter !== 1440
    ) {
      throw new Error(
        'Exact producer workspace must retain strict 24-hour age and no-downgrade trust policies',
      );
    }
    const producerExclusions = validateExactExclusions(
      policy.minimumReleaseAgeExclude,
      'Exact producer workspace minimumReleaseAgeExclude',
    );
    if (!producerExclusions.includes(createPackage.exactSpecifier)) {
      throw new Error(
        'Exact producer workspace minimumReleaseAgeExclude must include its installed producer',
      );
    }
    const producerTrustExclusions = validateExactExclusions(
      policy.trustPolicyExclude ?? [],
      'Exact producer workspace trustPolicyExclude',
    );
    const producerManifest = JSON.parse(
      fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'),
    );
    const producerReactDependencies = assertTractorReactDependencies(
      Object.fromEntries(
        tractorReactPackages.map(name => {
          const requests = new Set(
            collectPackageJsonFiles(workspace).flatMap(file => {
              const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
              return [
                manifest.dependencies?.[name],
                manifest.devDependencies?.[name],
              ].filter(value => value !== undefined);
            }),
          );
          if (requests.size !== 1)
            throw new Error(
              `Exact producer must select one ${name} dependency`,
            );
          return [name, [...requests][0]];
        }),
      ),
    );
    return {
      producerReactDependencies,
      producerEffectDependencies: assertTractorEffectDependencies(
        Object.fromEntries(
          tractorEffectPackages.map(name => [
            name,
            producerManifest.devDependencies?.[name],
          ]),
        ),
      ),
      pnpmOverrides: overrides,
      minimumReleaseAgeExclude: producerExclusions,
      trustPolicy: policy.trustPolicy,
      trustPolicyIgnoreAfter: policy.trustPolicyIgnoreAfter,
      trustPolicyExclude: producerTrustExclusions,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A source-candidate rehearsal may reach the throwaway loopback registry and
// nothing else, and a published acceptance may never be satisfied by one. Both
// directions are checked here, so neither the workflow nor a hand-run CLI can
// pair a mode with the wrong registry.
function assertAcceptanceRegistry(mode, registryUrl) {
  if (typeof registryUrl !== 'string' || registryUrl.length === 0) {
    throw new Error(
      `Tractor ${String(mode)} acceptance requires an exact registry URL`,
    );
  }
  const url = new URL(registryUrl);
  const loopback = url.hostname === sourceCandidateRegistryHost;
  if (mode === promotableTractorAcceptanceMode) {
    if (loopback) {
      throw new Error(
        'Published Tractor acceptance must read a real registry, never the ephemeral rehearsal registry',
      );
    }
  } else if (!loopback || url.protocol !== 'http:') {
    throw new Error(
      `Source-candidate Tractor rehearsal must target the loopback ephemeral registry at http://${sourceCandidateRegistryHost}, found ${registryUrl}`,
    );
  }
  return url.toString();
}

// The published lane owns exactly one registry and may name it globally. A
// rehearsal may not: its ephemeral registry serves the cohort scope alone, and
// the seeder has already written a user config that routes `@<targetScope>`
// there while leaving npmjs the stated default. Naming the loopback registry
// globally would drag every unrelated dependency through a throwaway Verdaccio
// proxy, so a source-mode context is refused unless it carries that user
// config and states no global registry at all.
function assertSourceCandidateRegistryEnv(registryEnv) {
  if (
    !registryEnv ||
    typeof registryEnv !== 'object' ||
    Array.isArray(registryEnv)
  ) {
    throw new Error(
      'Source-candidate Tractor rehearsal requires the ephemeral registry environment',
    );
  }
  for (const key of ['npm_config_userconfig', 'npm_config_cache']) {
    const value = registryEnv[key];
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error(
        `Source-candidate Tractor rehearsal requires an absolute ${key}, found ${String(value)}`,
      );
    }
  }
  for (const key of Object.keys(registryEnv)) {
    if (globalRegistryEnvKeys.includes(key.toLowerCase())) {
      throw new Error(
        `Source-candidate Tractor rehearsal must not name a global registry (${key}); only the cohort scope resolves from the ephemeral registry`,
      );
    }
  }
  return { ...registryEnv };
}

function resolveAcceptanceRegistryEnv(mode, registryUrl, registryEnv) {
  if (mode === promotableTractorAcceptanceMode) {
    return {
      npm_config_registry: registryUrl,
      pnpm_config_registry: registryUrl,
    };
  }
  return assertSourceCandidateRegistryEnv(registryEnv);
}

// The seeder republishes the accepted tarball bytes through the exact-artifact
// publisher, which refuses to publish under any Node.js other than the one the
// accepted manifest records. Stating that here fails a mis-provisioned
// rehearsal on the manifest alone, before a registry is started, rather than
// midway through the seed loop.
function assertSourceCandidateSeedRuntime(release, version = process.version) {
  const accepted = release?.tools?.node;
  if (typeof accepted !== 'string' || accepted.length === 0) {
    throw new Error(
      'Source-candidate Tractor rehearsal requires the accepted release Node.js version',
    );
  }
  if (accepted !== version) {
    throw new Error(
      `Source-candidate Tractor rehearsal must seed under the accepted release Node.js ${accepted}, found ${String(version)}`,
    );
  }
  return accepted;
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set([
    '--manifest',
    '--mode',
    '--out',
    '--registry-url',
    '--release-age-policy',
    '--store-dir',
    '--workspace',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument) || argument.includes('=')) {
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
  for (const required of ['--manifest', '--workspace']) {
    if (!values.has(required)) {
      throw new Error(`${required} is required`);
    }
  }
  const mode = values.get('--mode') ?? promotableTractorAcceptanceMode;
  if (!tractorAcceptanceModes.includes(mode)) {
    throw new Error(`--mode must be ${tractorAcceptanceModes.join(' or ')}`);
  }
  // In source mode the registry does not exist yet: it is started inside this
  // process from the immutable bundle, and it decides its own port. Accepting a
  // caller-supplied URL there would let a rehearsal be pointed at npm.
  if (
    mode !== promotableTractorAcceptanceMode &&
    values.has('--registry-url')
  ) {
    throw new Error(
      '--registry-url is decided by the ephemeral registry in source mode',
    );
  }
  const manifestPath = path.resolve(values.get('--manifest'));
  const storeDir = values.get('--store-dir');
  if (
    storeDir !== undefined &&
    (storeDir.trim() !== storeDir ||
      storeDir.includes('\0') ||
      !path.isAbsolute(storeDir))
  ) {
    throw new Error('--store-dir must be an absolute path');
  }
  return {
    manifestPath,
    mode,
    outPath: path.resolve(values.get('--out') ?? defaultOut),
    registryUrl:
      mode === promotableTractorAcceptanceMode
        ? assertAcceptanceRegistry(
            mode,
            values.get('--registry-url') ?? 'https://registry.npmjs.org/',
          )
        : undefined,
    releaseAgePolicyPath: path.resolve(
      values.get('--release-age-policy') ?? defaultReleaseAgePolicyPath,
    ),
    releaseDir: path.dirname(manifestPath),
    storeDir: storeDir === undefined ? undefined : path.resolve(storeDir),
    workspace: fs.realpathSync(path.resolve(values.get('--workspace'))),
  };
}

function assertCleanCheckout(workspace, runImpl) {
  const status = runImpl(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    {
      cwd: workspace,
      stdio: 'pipe',
    },
  );
  if (status) {
    throw new Error(
      `Tractor downstream acceptance requires a clean disposable checkout, found: ${status}`,
    );
  }
  const revision = runImpl('git', ['rev-parse', 'HEAD'], {
    cwd: workspace,
    stdio: 'pipe',
  }).toLowerCase();
  if (!/^[a-f\d]{40,64}$/u.test(revision)) {
    throw new Error(`Tractor checkout revision is invalid: ${revision}`);
  }
  return revision;
}

async function stopRuntimes(runtimes, message) {
  const results = await Promise.allSettled(
    runtimes.reverse().map(runtime => runtime.stop()),
  );
  const failures = results.flatMap(result =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

function requirePassingAssertionTypes(assertions, requiredTypes, label) {
  if (!Array.isArray(assertions)) {
    throw new Error(`${label} did not return an assertion array`);
  }
  const assertionsByType = new Map();
  for (const assertion of assertions) {
    if (typeof assertion?.type !== 'string' || assertion.status !== 'pass') {
      throw new Error(`${label} returned malformed or failing evidence`);
    }
    assertionsByType.set(assertion.type, assertion);
  }
  for (const type of requiredTypes) {
    if (!assertionsByType.has(type)) {
      throw new Error(`${label} is missing required ${type} evidence`);
    }
  }
  return assertions.map(assertion => assertion.type);
}

async function proveNodeServerRenderedSsr({
  artifactDir,
  browser,
  fetchImpl = fetch,
  targets,
  validateHttpTargetImpl = validateHttpTarget,
  validateNoJavaScriptSsrTargetImpl = validateNoJavaScriptSsrTarget,
}) {
  const shells = targets.filter(target => target.app.kind === 'shell');
  if (shells.length !== 1) {
    throw new Error(
      'Tractor Node SSR acceptance requires exactly one shell target',
    );
  }
  const [shell] = shells;
  if (
    shell.routes.distributedSsr === shell.routes.ssr ||
    !Array.isArray(shell.app.moduleFederation?.verticalRefs) ||
    shell.app.moduleFederation.verticalRefs.length === 0
  ) {
    throw new Error(
      'Tractor Node SSR acceptance requires a dedicated distributed-SSR route with declared MicroVerticals',
    );
  }

  const results = [];
  for (const target of targets) {
    const httpAssertions = await validateHttpTargetImpl(target, {
      fetchImpl,
      includeCloudflareJsonSmokeChecks: false,
    });
    const requiredHttpTypes = [
      'ssr-route',
      'ui-marker-html',
      'css-root-marker',
    ];
    if (target.app.api) {
      requiredHttpTypes.push('effect-readiness');
    }
    const httpAssertionTypes = requirePassingAssertionTypes(
      httpAssertions,
      requiredHttpTypes,
      `${target.app.id} Node HTTP SSR`,
    );

    const appArtifactDir = path.join(artifactDir, target.app.id);
    fs.mkdirSync(appArtifactDir, { recursive: true });
    const noJavaScriptAssertions = await validateNoJavaScriptSsrTargetImpl(
      target,
      browser,
      {
        appArtifactDir,
      },
    );
    const requiredNoJavaScriptTypes =
      target.app.kind === 'shell'
        ? [
            'no-js-distributed-ssr-route',
            'no-js-shell-composition-boundary',
            'no-js-ssr-css-root-marker',
            'no-js-ssr-failed-responses',
          ]
        : [
            'no-js-ssr-ui-marker',
            'no-js-ssr-css-root-marker',
            'no-js-ssr-failed-responses',
          ];
    const noJavaScriptAssertionTypes = requirePassingAssertionTypes(
      noJavaScriptAssertions,
      requiredNoJavaScriptTypes,
      `${target.app.id} Node no-JS SSR`,
    );
    results.push({
      appId: target.app.id,
      httpAssertions,
      httpAssertionTypes,
      noJavaScriptAssertions,
      noJavaScriptAssertionTypes,
    });
  }
  return {
    appCount: results.length,
    distributedSsrRoute: shell.routes.distributedSsr,
    results,
    status: 'pass',
  };
}

function loadWorkspacePlaywright(workspace) {
  const workspaceRequire = createRequire(path.join(workspace, 'package.json'));
  return workspaceRequire('@playwright/test');
}

// The subprocess env and this in-process launch must agree on where the
// browsers were installed, so both read the same runtime-context value; the
// shared owner restores the parent process afterwards.
function launchWorkspaceBrowser(
  { browserProvider, processEnv, workspace },
  { launchBrowserImpl = launchBrowser } = {},
) {
  return withAcceptancePlaywrightBrowsersPath(
    processEnv.PLAYWRIGHT_BROWSERS_PATH,
    () =>
      launchBrowserImpl(browserProvider ?? loadWorkspacePlaywright(workspace)),
  );
}

function createReleaseBoundNodeSmokeTargets(
  { contract, projectDir },
  {
    bindContractToReleaseIdentityImpl = bindContractToReleaseIdentity,
    createSmokeTargetsImpl = createSmokeTargets,
  } = {},
) {
  const releaseBoundContract = bindContractToReleaseIdentityImpl({
    contract,
    platform: 'node',
    projectDir,
  });
  return createSmokeTargetsImpl(releaseBoundContract, { mode: 'local' });
}

async function startNodeProof(
  { artifactDir, processEnv = process.env, projectDir, timeoutMs = 90_000 },
  {
    browserProvider,
    launchBrowserImpl = launchBrowser,
    proveNodeServerRenderedSsrImpl = proveNodeServerRenderedSsr,
  } = {},
) {
  const { contract } = readSmokeContract(projectDir);
  const { targets } = createReleaseBoundNodeSmokeTargets({
    contract,
    projectDir,
  });
  const startup = orderTargetsForLocalStartup(targets);
  if (startup.shells.length !== 1) {
    throw new Error(
      'Tractor Node browser acceptance requires exactly one shell target',
    );
  }
  await assertLocalPortsAvailable(startup.validation);
  const runtimes = [];
  try {
    for (const layer of startup.remoteLayers) {
      const layerRuntimes = layer.map(target => {
        const runtime = startServer(target, { artifactDir, projectDir });
        runtimes.push(runtime);
        return { runtime, target };
      });
      await Promise.all(
        layerRuntimes.map(({ runtime, target }) =>
          waitForTarget(target, {
            fetchImpl: fetch,
            requireManifest: true,
            serverExit: runtime.exited,
            serverLogPath: runtime.logPath,
            timeoutMs,
          }),
        ),
      );
    }
    const shellTarget = startup.shells[0];
    const shellRuntime = startServer(shellTarget, {
      artifactDir,
      projectDir,
    });
    runtimes.push(shellRuntime);
    await waitForTarget(shellTarget, {
      fetchImpl: fetch,
      serverExit: shellRuntime.exited,
      serverLogPath: shellRuntime.logPath,
      timeoutMs,
    });
    const browser = await launchWorkspaceBrowser(
      {
        browserProvider,
        processEnv,
        workspace: projectDir,
      },
      { launchBrowserImpl },
    );
    let ssrEvidence;
    try {
      ssrEvidence = await proveNodeServerRenderedSsrImpl({
        artifactDir,
        browser,
        targets: startup.validation,
      });
    } finally {
      await browser.close();
    }
    return {
      baseUrl: shellTarget.baseUrl,
      ssrEvidence,
      stop: () =>
        stopRuntimes(
          runtimes,
          'Failed to stop Tractor Node browser acceptance processes',
        ),
    };
  } catch (error) {
    try {
      await stopRuntimes(
        runtimes,
        'Failed to stop Tractor Node browser acceptance processes',
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Tractor Node browser acceptance and cleanup both failed',
      );
    }
    throw error;
  }
}

function runVisibleWorkflow({
  artifactDir,
  baseUrl,
  env,
  platform,
  runImpl,
  workspace,
}) {
  const browserEvidence = path.join(
    artifactDir,
    `tractor-visible-workflow-${platform}.json`,
  );
  runImpl(
    process.execPath,
    ['scripts/proof-public-workflow.mjs', '--out', browserEvidence],
    {
      cwd: workspace,
      env: {
        ...env,
        ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: baseUrl,
      },
    },
  );
  const workflow = JSON.parse(fs.readFileSync(browserEvidence, 'utf8'));
  if (
    workflow.status !== 'pass' ||
    !Array.isArray(workflow.assertions) ||
    workflow.assertions.length < 5
  ) {
    throw new Error(
      `Tractor ${platform} visible shopping workflow evidence is incomplete`,
    );
  }
  return {
    assertionCount: workflow.assertions.length,
    nativeSearch: assertNativeTanStackSearch(workflow),
    platform,
    routes: workflow.assertions.map(assertion => assertion.route),
    ui: assertVisibleTractorUi(workflow),
  };
}

function expectedNodeBackendAppIds(workspace) {
  const topologyPath = path.join(workspace, 'topology/reference-topology.json');
  const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
  if (!Array.isArray(topology.verticals)) {
    throw new Error('Tractor reference topology is missing verticals');
  }
  const expected = topology.verticals
    .filter(app => app?.kind === 'vertical' && app.api)
    .map(app => app.id);
  if (
    expected.length === 0 ||
    expected.some(id => typeof id !== 'string' || id.length === 0) ||
    new Set(expected).size !== expected.length
  ) {
    throw new Error(
      'Tractor reference topology must contain unique API-bearing MicroVertical ids',
    );
  }
  return expected.sort((left, right) => left.localeCompare(right));
}

function readPassingNodeBackendProof(workspace) {
  const evidencePath = path.join(workspace, nodeBackendProofPath);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const expectedAppIds = expectedNodeBackendAppIds(workspace);
  if (
    evidence.status !== 'pass' ||
    !Array.isArray(evidence.results) ||
    evidence.results.length === 0
  ) {
    throw new Error(
      'Tractor Node backend-federation proof was skipped or has no executed results',
    );
  }
  const actualAppIds = [];
  for (const result of evidence.results) {
    if (
      typeof result?.appId !== 'string' ||
      result.appId.length === 0 ||
      result.status !== 'pass' ||
      actualAppIds.includes(result.appId)
    ) {
      throw new Error(
        'Tractor Node backend-federation proof contains duplicate, malformed, or failing results',
      );
    }
    actualAppIds.push(result.appId);
  }
  actualAppIds.sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualAppIds) !== JSON.stringify(expectedAppIds)) {
    throw new Error(
      `Tractor Node backend-federation proof app set must exactly match API-bearing MicroVerticals: expected ${expectedAppIds.join(
        ', ',
      )}; found ${actualAppIds.join(', ')}`,
    );
  }
  return {
    appIds: actualAppIds,
    evidencePath: nodeBackendProofPath,
    resultCount: evidence.results.length,
    status: evidence.status,
  };
}

function installTractorRelease({
  workspace,
  createPackage,
  minimumReleaseAgeExclude,
  packageManager,
  runImpl = run,
}) {
  const options = { cwd: workspace, env: packageManager.env };
  runImpl(packageManager.pnpmExecutable, ['clean', '--lockfile'], options);
  runImpl(
    packageManager.pnpmExecutable,
    ['install', '--no-frozen-lockfile'],
    options,
  );
  for (const command of ['sync-delivery-unit', 'validate']) {
    runImpl(
      packageManager.pnpmExecutable,
      createTractorPnpmDlxArgs(
        createPackage,
        minimumReleaseAgeExclude,
        ['ultramodern', command],
        options.env,
      ),
      options,
    );
  }
}

function* executeTractorCommands({
  workspace,
  env,
  report,
  pnpmExecutable = 'pnpm',
  runImpl = run,
}) {
  for (const {
    command: [command, args],
    report: reportCommand,
  } of executionCommands) {
    if (args[0] === 'node:proof') {
      fs.rmSync(path.join(workspace, nodeBackendProofPath), { force: true });
    }
    runImpl(command === 'pnpm' ? pnpmExecutable : command, args, {
      cwd: workspace,
      env,
    });
    if (reportCommand) {
      report.checks.push({
        id: args.join('-'),
        status: 'passed',
        detail: { command: [command, ...args].join(' ') },
      });
    }
    yield args;
  }
}

async function runTractorDownstreamAcceptance(
  options,
  {
    runImpl = run,
    startNodeProofImpl = startNodeProof,
    startWorkerdProofImpl = startWorkerdProof,
    now = Date,
  } = {},
) {
  const mode = options.mode ?? promotableTractorAcceptanceMode;
  if (!tractorAcceptanceModes.includes(mode)) {
    throw new Error(
      `Tractor acceptance mode must be ${tractorAcceptanceModes.join(' or ')}, found ${String(mode)}`,
    );
  }
  const registryUrl = assertAcceptanceRegistry(mode, options.registryUrl);
  const registryEnv = resolveAcceptanceRegistryEnv(
    mode,
    registryUrl,
    options.registryEnv,
  );
  const release = readReleaseManifest({
    manifestPath: options.manifestPath,
  });
  const createPackage = resolveCreatePackage(release);
  const startedAt = new now();
  const minimumReleaseAgeExclude = releaseAgeExemptions(release, {
    policyPath: options.releaseAgePolicyPath,
    now: startedAt,
  });
  const packageManagerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultramodern-tractor-downstream-'),
  );
  const packageManager = createTractorPackageManagerContext({
    mode,
    release,
    expectedPnpmVersion: release.tools?.pnpm,
    packageManagerRoot,
    registryEnv,
    storeDir: options.storeDir,
    runImpl,
  });
  const env = packageManager.env;
  const report = {
    schema: 'bleedingdev.ultramodern.tractor-downstream-acceptance',
    schemaVersion: 1,
    // Same shape, same check ids, same order in both lanes. Only a
    // `published` report is promotable: the evidence binder and the publish
    // outcome both reject anything else, so a rehearsal can never stand in for
    // the persistent Tractor adoption the published lane proves.
    mode,
    status: 'running',
    sourceCandidateTrustPolicyExclude: JSON.parse(
      env.pnpm_config_trust_policy_exclude ?? '[]',
    ),
    startedAt: startedAt.toISOString(),
    release: {
      cohortDigest: release.cohortDigest,
      manifestSha256: release.manifestSha256,
      sourceRevision: release.source.commit,
      version: release.release.version,
    },
    tractor: {},
    checks: [],
  };
  try {
    report.tractor.baselineRevision = assertCleanCheckout(
      options.workspace,
      runImpl,
    );
    const childNode = runImpl('node', ['--version'], {
      cwd: options.workspace,
      env: packageManager.env,
      stdio: 'pipe',
    });
    if (childNode !== release.tools.node) {
      throw new Error(
        `Tractor child Node.js must match release ${release.tools.node}, found ${childNode}`,
      );
    }
    const producerPolicy = readTractorProducerOverrides({
      createPackage,
      minimumReleaseAgeExclude,
      packageManager,
      packageManagerRoot,
      runImpl,
    });
    prepareTractorCohortInstallation(
      options.workspace,
      release,
      producerPolicy,
    );
    // pnpm validates the existing lock before resolving new dependencies. A
    // recently accepted previous cohort is outside this candidate's exact
    // release-age approvals, so resolve the candidate from a fresh native lock.
    installTractorRelease({
      workspace: options.workspace,
      createPackage,
      minimumReleaseAgeExclude,
      packageManager,
      runImpl,
    });
    report.checks.push({
      id: 'exact-create-validation',
      status: 'passed',
      detail: {
        createPackage: createPackage.exactSpecifier,
        version: release.release.version,
      },
    });

    const generatedCohort = assertAuthenticatedTractorCohort(
      options.workspace,
      release,
    );
    const dependencyObservations = assertExactModernDependencySpecifiers(
      options.workspace,
      release,
    );
    report.checks.push({
      id: 'exact-cohort',
      status: 'passed',
      detail: {
        dependencyObservationCount: dependencyObservations.length,
        producerEffectDependencies: producerPolicy.producerEffectDependencies,
        producerReactDependencies: producerPolicy.producerReactDependencies,
        generatedCohort,
      },
    });

    for (const args of executeTractorCommands({
      workspace: options.workspace,
      env,
      report,
      pnpmExecutable: packageManager.pnpmExecutable,
      runImpl,
    })) {
      if (args[0] === 'check') {
        const applicationSourceRevision = snapshotAcceptanceWorkspaceSource(
          options.workspace,
          env,
          runImpl,
        );
        report.tractor.applicationSourceRevision = applicationSourceRevision;
        report.checks.push({
          id: 'promotable-application-source',
          status: 'passed',
          detail: { applicationSourceRevision },
        });
      }
      if (args[0] === 'node:proof') {
        report.checks.push({
          id: 'node-backend-federation-executed',
          status: 'passed',
          detail: readPassingNodeBackendProof(options.workspace),
        });
        const nodeArtifactDir = path.join(
          options.workspace,
          '.codex/reports/tractor-downstream-node',
        );
        const nodeRuntime = await startNodeProofImpl({
          artifactDir: nodeArtifactDir,
          processEnv: env,
          projectDir: options.workspace,
          timeoutMs: 90_000,
        });
        try {
          report.checks.push({
            id: 'node-server-rendered-ssr-executed',
            status: 'passed',
            detail: nodeRuntime.ssrEvidence,
          });
          report.checks.push({
            id: 'node-visible-tractor-workflow',
            status: 'passed',
            detail: runVisibleWorkflow({
              artifactDir: nodeArtifactDir,
              baseUrl: nodeRuntime.baseUrl,
              env,
              platform: 'node',
              runImpl,
              workspace: options.workspace,
            }),
          });
        } finally {
          await nodeRuntime.stop();
        }
      }
    }

    const artifactDir = path.join(
      options.workspace,
      '.codex/reports/tractor-downstream-workerd',
    );
    const workerd = await startWorkerdProofImpl({
      pnpmExecutable: packageManager.pnpmExecutable,
      artifactDir,
      processEnv: env,
      projectDir: options.workspace,
      requireTargetUrls: true,
      timeoutMs: 90_000,
    });
    try {
      if (!workerd.baseUrl) {
        throw new Error(
          'Tractor generated workerd proof did not expose a shell URL',
        );
      }
      report.checks.push({
        id: 'workerd-visible-tractor-workflow',
        status: 'passed',
        detail: runVisibleWorkflow({
          artifactDir,
          baseUrl: workerd.baseUrl,
          env,
          platform: 'workerd',
          runImpl,
          workspace: options.workspace,
        }),
      });
    } finally {
      await workerd.stop();
    }

    report.checks.push({
      id: 'native-tanstack-search',
      status: 'passed',
      detail: Object.fromEntries(
        requiredVisibleRuntimePlatforms.map(platform => [
          platform,
          report.checks.find(
            check => check.id === `${platform}-visible-tractor-workflow`,
          )?.detail.nativeSearch,
        ]),
      ),
    });

    report.checks.push({
      id: 'visible-tractor-ui',
      status: 'passed',
      detail: Object.fromEntries(
        requiredVisibleRuntimePlatforms.map(platform => [
          platform,
          report.checks.find(
            check => check.id === `${platform}-visible-tractor-workflow`,
          )?.detail.ui,
        ]),
      ),
    });
    // The recorder's contract, asserted before this report may claim `passed`:
    // both lanes run it, so a rehearsal catches report drift before publish.
    assertTractorAcceptanceReport(
      { ...report, status: 'passed' },
      {
        baselineRevision: report.tractor.baselineRevision,
        manifest: release,
        mode,
      },
    );
    report.finishedAt = new now().toISOString();
    report.status = 'passed';
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.finishedAt = new now().toISOString();
    report.status = 'failed';
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      {
        tractorAcceptanceReport: report,
      },
    );
  } finally {
    fs.rmSync(packageManagerRoot, { recursive: true, force: true });
    writeJsonFile(options.outPath, report, { atomic: false });
  }
}

// The registry seeder spawns bare `pnpm` and `npm`. The acceptance jobs pin
// pnpm through the manifest and export it as an absolute path, so put that
// exact executable's directory first when it is present; a local run keeps the
// ambient PATH.
function sourceCandidateRegistryPath(environment, execPath = process.execPath) {
  const provisioned = environment.ULTRAMODERN_PNPM_EXECUTABLE;
  if (
    provisioned !== undefined &&
    (typeof provisioned !== 'string' || !path.isAbsolute(provisioned))
  ) {
    throw new Error(
      `Provisioned acceptance pnpm executable must be absolute: ${String(provisioned)}`,
    );
  }
  if (typeof execPath !== 'string' || !path.isAbsolute(execPath)) {
    throw new Error(
      `Source-candidate seeding interpreter must be absolute: ${String(execPath)}`,
    );
  }
  return [
    provisioned === undefined ? undefined : path.dirname(provisioned),
    // The bundled `npm` of the interpreter this process runs under, so the
    // publisher's accepted-toolchain guard reads the same npm the accepted
    // manifest recorded instead of whatever npm the Tractor checkout's mise
    // toolchain happens to expose first.
    path.dirname(execPath),
    environment.PATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
}

// The seeding window only. The Tractor workspace commands that follow keep the
// PATH the job gave them, so the rehearsal exercises the same toolchain
// resolution the published lane does.
async function withSourceCandidateSeedPath(action) {
  const inheritedPath = process.env.PATH;
  process.env.PATH = sourceCandidateRegistryPath(process.env);
  try {
    return await action();
  } finally {
    process.env.PATH = inheritedPath;
  }
}

// Starts one fresh registry for this process, seeds it from the verified bundle
// tarballs in dependency order using the same implementation the exact-artifact
// acceptance uses, and stops it again. The seeder is imported lazily so the
// published lane never loads the publishing runtime at all.
async function withSourceCandidateRegistry(
  options,
  action,
  {
    nodeVersion = process.version,
    readReleaseManifestImpl = readReleaseManifest,
    startEphemeralRegistryImpl,
  } = {},
) {
  const startEphemeralRegistry =
    startEphemeralRegistryImpl ??
    (
      await import(
        '../../ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs'
      )
    ).startEphemeralRegistry;
  const release = readReleaseManifestImpl({
    manifestPath: options.manifestPath,
  });
  assertSourceCandidateSeedRuntime(release, nodeVersion);
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultramodern-tractor-rehearsal-registry-'),
  );
  let registry;
  try {
    registry = await withSourceCandidateSeedPath(() =>
      startEphemeralRegistry({
        release,
        releaseDir: options.releaseDir,
        rootDir,
        storeDir: options.storeDir,
      }),
    );
    // The seeder's own scoped user config, not a global registry override: the
    // rehearsal reads `@<targetScope>` from loopback and everything else
    // straight from npmjs.
    return await action(
      assertAcceptanceRegistry(options.mode, registry.registryUrl),
      assertSourceCandidateRegistryEnv(registry.env),
    );
  } finally {
    await registry?.stop();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report =
    options.mode === promotableTractorAcceptanceMode
      ? await runTractorDownstreamAcceptance(options)
      : await withSourceCandidateRegistry(options, (registryUrl, registryEnv) =>
          runTractorDownstreamAcceptance({
            ...options,
            registryEnv,
            registryUrl,
          }),
        );
  process.stdout.write(
    `Tractor ${options.mode}-mode downstream acceptance passed for ${report.release.version}: ${options.outPath}\n`,
  );
}

export {
  assertAcceptanceRegistry,
  assertSourceCandidateRegistryEnv,
  assertSourceCandidateSeedRuntime,
  createReleaseBoundNodeSmokeTargets,
  createTractorPackageManagerContext,
  createTractorPnpmDlxArgs,
  executeTractorCommands,
  executionCommands,
  installTractorRelease,
  launchWorkspaceBrowser,
  main,
  parseArgs,
  promotableTractorAcceptanceMode,
  proveNodeServerRenderedSsr,
  readPassingNodeBackendProof,
  readTractorProducerOverrides,
  requiredCommands,
  requiredVisibleRuntimePlatforms,
  resolveAcceptanceRegistryEnv,
  runTractorDownstreamAcceptance,
  runVisibleWorkflow,
  sourceCandidateRegistryPath,
  tractorAcceptanceModes,
  withSourceCandidateRegistry,
};
