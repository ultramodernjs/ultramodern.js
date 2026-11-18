import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseSync, transformFromAstSync, traverse, types } from '@babel/core';
import { assertNoHighAdvisories } from '../../security/advisory-gate.mjs';
import { readSmokeContract } from '../browser-smoke/contract.mjs';
import { createSmokeTargets } from '../browser-smoke/targets.mjs';
import {
  assembleOperationalEvidence,
  captureOperationalBaseline,
  proveOperationalTarget,
} from '../operational-independence.mjs';
import {
  assertApiAcceptance,
  assertBackendAcceptance,
  assertModuleFederationAcceptance,
  assertTopologyAcceptance,
  assertWorkspaceCheckContract,
  readWorkspaceAcceptanceArtifacts,
} from './acceptance-assertions.mjs';
import {
  assertReleaseAcceptanceProfile,
  assertRuntimeAcceptanceDimension,
  createOperationalIndependenceResultDetails,
  createReleaseArtifactBinding,
  operationalIndependenceEvidencePath,
  operationalIndependenceResultId,
  projectRuntimeArtifactBinding,
  resolutionParityResultId,
  runtimeAcceptanceDimensions,
  runtimeAcceptanceInvocation,
  runtimeAcceptancePlatforms,
  runtimeIdentityBinding,
} from './acceptance-contract.mjs';
import {
  assertAcceptanceReceipt,
  bindRuntimeIdentityEvidence,
  bindSupplyChainEvidence,
  createAcceptanceReceipt,
  finalizeAcceptanceReceipt,
  recordAcceptanceResult,
} from './acceptance-receipt.mjs';
import { runBrowserSmoke } from './browser-smoke.mjs';
import {
  browserSmokePlaywrightPackage,
  repoRoot,
  writeJsonFile,
} from './constants.mjs';
import {
  assertBootstrapReleaseAgePolicy,
  assertGeneratedCohort,
  resolveCreatePackage,
} from './package-cohort.mjs';
import {
  acceptancePackageManagerRoot,
  createAcceptancePackageManagerEnv,
  createAcceptanceWorkspaceEnv,
  roundDurationMs,
  run,
  runAsync,
} from './process.mjs';
import { verifyRegistryCohort } from './registry-cohort.mjs';
import {
  auditReleaseAgePolicy,
  parseYamlFile,
  releaseAgeExemptions,
  validateExactExclusions,
  verifyStrictInstallInputs,
  YAML_INTEGRITY,
  YAML_NAME,
  YAML_VERSION,
} from './release-age-audit.mjs';
import {
  assertResolutionParity,
  assertScaffoldParity,
  scaffoldFiles,
} from './resolution-parity.mjs';
import { addVertical, createWorkspace } from './workspace.mjs';

const requiredPnpmCommands = Object.freeze({
  // Resolve the dependency closure into a native lockfile without installing
  // node_modules. `@modern-js/ultramodern-create` intentionally does not
  // install (it tells the user to run pnpm install), so acceptance materializes
  // the lock here —
  // against the controlled release registry — before the release-age audit
  // reads it and before the frozen install re-verifies it.
  lockfileOnly: Object.freeze([
    'install',
    '--lockfile-only',
    '--ignore-scripts',
  ]),
  install: Object.freeze(['install', '--frozen-lockfile']),
  check: Object.freeze(['check']),
  build: Object.freeze(['build']),
  cloudflareBuild: Object.freeze(['cloudflare:build']),
});

function createRuntimeArtifactBinding(release) {
  return projectRuntimeArtifactBinding(createReleaseArtifactBinding(release));
}

function createAcceptanceReleaseAgeEnv(
  runtimeEnv,
  createPackage,
  exactExclusions,
  registryEnv = {},
) {
  const policy = assertBootstrapReleaseAgePolicy(createPackage);
  validateExactExclusions(exactExclusions, 'Acceptance release-age exclusions');
  if (
    policy.minimumReleaseAgeExclude.some(
      specifier => !exactExclusions.includes(specifier),
    )
  ) {
    throw new Error(
      'Acceptance release-age exclusions must contain the authenticated create closure',
    );
  }
  return {
    ...runtimeEnv,
    NPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: undefined,
    NPM_CONFIG_TRUST_POLICY_EXCLUDE: undefined,
    PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: undefined,
    PNPM_CONFIG_TRUST_POLICY_EXCLUDE: undefined,
    npm_config_minimum_release_age_exclude: undefined,
    npm_config_trust_policy_exclude: undefined,
    pnpm_config_pm_on_fail: 'ignore',
    pnpm_config_minimum_release_age: String(policy.minimumReleaseAge),
    pnpm_config_minimum_release_age_exclude: JSON.stringify(exactExclusions),
    pnpm_config_trust_policy_exclude:
      registryEnv.PNPM_CONFIG_TRUST_POLICY_EXCLUDE,
    pnpm_config_minimum_release_age_ignore_missing_time: String(
      policy.minimumReleaseAgeIgnoreMissingTime,
    ),
    pnpm_config_minimum_release_age_strict: String(
      policy.minimumReleaseAgeStrict,
    ),
  };
}
const operationalIndependenceChangedPaths = Object.freeze([
  'verticals/inventory/api/index.ts',
  'verticals/inventory/locales/en/inventory.json',
]);
const operationalIndependenceUiValue =
  'C1 operational independence: inventory UI and localization moved together.';
const operationalIndependenceApiValue =
  'Inventory C1 operational proof response';
const operationalIndependenceIds = Object.freeze({
  shell: 'shell-super-app',
  changed: 'inventory',
  sibling: 'finance',
});
const forbiddenDefaultOffRscDependencies = Object.freeze([
  'react-server-dom-rspack',
  'rsbuild-plugin-rsc',
]);

function assertDefaultOffRscInstall(projectDir, closureIdentities) {
  const forbiddenDependencies = forbiddenDefaultOffRscDependencies.filter(
    packageName =>
      closureIdentities.some(identity => identity.name === packageName),
  );
  if (forbiddenDependencies.length > 0) {
    throw new Error(
      `Default-off clean-room install contains forbidden RSC dependencies: ${forbiddenDependencies.join(', ')}`,
    );
  }

  const appsRoot = path.join(projectDir, 'apps');
  const appManifestPaths = fs
    .readdirSync(appsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(appsRoot, entry.name, 'package.json'))
    .filter(file => fs.existsSync(file))
    .sort();
  if (appManifestPaths.length === 0) {
    throw new Error('Default-off clean-room install has no generated app');
  }
  const appManifestPath = appManifestPaths[0];
  const appManifest = JSON.parse(fs.readFileSync(appManifestPath, 'utf8'));
  const runtimeEntry =
    createRequire(appManifestPath).resolve('@modern-js/runtime');
  const renderClient = createRequire(runtimeEntry).resolve(
    '@modern-js/render/client',
  );
  try {
    createRequire(renderClient).resolve(
      'react-server-dom-rspack/client.browser',
    );
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') {
      return {
        appPackage: appManifest.name,
        forbiddenDependencyCount: 0,
        renderClient,
      };
    }
    throw error;
  }
  throw new Error(
    'Default-off clean-room install must not resolve react-server-dom-rspack/client.browser from @modern-js/render/client.',
  );
}

function startOwnedWorkDirGuardian(workDir) {
  const guardian = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./owned-workdir-guardian.mjs', import.meta.url)),
      String(process.pid),
      workDir,
    ],
    { detached: true, stdio: 'ignore' },
  );
  guardian.unref();
}

function currentTime(now) {
  return new now();
}

// Single acceptance runtime-context owner. Every value a clean-room
// subprocess needs to be hermetic — the exact pnpm executable, the PATH that
// binds it, the registry, the npm/pnpm stores, the XDG cache, and
// PLAYWRIGHT_BROWSERS_PATH — is derived here and nowhere else, so ERP and
// Tractor cannot drift apart. Callers layer only their own policy on top.
const acceptancePlaywrightInstallArgs = Object.freeze([
  // Dependency-resolved: `pnpm exec` runs the playwright binary the frozen
  // downstream graph already resolved, so no acceptance surface pins a
  // playwright version of its own.
  'exec',
  'playwright',
  'install',
  '--with-deps',
  'chromium',
]);
const acceptanceBrowserIsolations = Object.freeze(['inherited', 'isolated']);

function acceptancePlaywrightBrowsersPath(workDir) {
  return path.join(
    acceptancePackageManagerRoot(workDir),
    'xdg',
    'ms-playwright',
  );
}

// Playwright's default browser registry is per-platform, and only the Linux
// one is derived from XDG_CACHE_HOME:
//   * linux — $XDG_CACHE_HOME/ms-playwright
//   * darwin — ~/Library/Caches/ms-playwright
//   * win32 — %LOCALAPPDATA%\ms-playwright
// This runtime context always redirects XDG_CACHE_HOME into the disposable
// package-manager root, so on Linux an absent PLAYWRIGHT_BROWSERS_PATH is not
// the runner's registry at all — it silently becomes an empty directory inside
// the work dir. On darwin and win32 the redirect cannot move that default, so
// the pre-redirection registry is derivable and inheriting it is exactly what
// the caller asked for.
const playwrightRegistryCacheHome = Object.freeze({
  darwin: ({ homedir }) => path.join(homedir, 'Library', 'Caches'),
  win32: ({ environment, homedir }) =>
    typeof environment.LOCALAPPDATA === 'string' &&
    path.isAbsolute(environment.LOCALAPPDATA)
      ? environment.LOCALAPPDATA
      : path.join(homedir, 'AppData', 'Local'),
});

// `inherited` browsers only mean anything if this returns the registry the
// browsers actually live in. An explicit PLAYWRIGHT_BROWSERS_PATH always wins
// and must be absolute; otherwise the platform default is derived where the
// XDG redirect cannot reach it, and fails closed everywhere it can — naming
// both ways out rather than guessing a pre-redirection default.
function inheritedPlaywrightBrowsersPath(
  browsersPath,
  {
    environment = process.env,
    homedir = os.homedir(),
    platform = process.platform,
  } = {},
) {
  if (typeof browsersPath === 'string' && path.isAbsolute(browsersPath)) {
    return browsersPath;
  }
  const cacheHome = playwrightRegistryCacheHome[platform];
  if (browsersPath === undefined && cacheHome !== undefined) {
    const derived = path.join(
      cacheHome({ environment, homedir }),
      'ms-playwright',
    );
    if (path.isAbsolute(derived)) {
      return derived;
    }
  }
  const reason =
    browsersPath !== undefined
      ? `A stated inherited browsers path must be absolute.`
      : platform === 'linux'
        ? `This runtime context redirects XDG_CACHE_HOME into the disposable package-manager root, and Playwright derives its default browser directory on linux from that cache home, so an unset value resolves inside the work dir instead of the runner's registry.`
        : `Playwright's default browser registry on ${String(platform)} could not be derived from this environment.`;
  throw new Error(
    `Inherited acceptance browsers require an absolute PLAYWRIGHT_BROWSERS_PATH in the injected environment, found ${String(browsersPath)}. ${reason} Provision the browsers with PLAYWRIGHT_BROWSERS_PATH set (as the acceptance jobs do) or ask for browsers: 'isolated'.`,
  );
}

// Opt-in build parallelism for larger self-hosted runners. Unset (the
// default) returns packageManagerEnv unchanged, so hosted-runner behavior is
// byte-identical. Only the two workspace build invocations honor the knob;
// installs and registry traffic keep the reviewed concurrency profile.
function createAcceptanceBuildEnv(packageManagerEnv, env = process.env) {
  const raw = env.BLEEDINGDEV_ACCEPT_BUILD_CONCURRENCY;
  if (raw === undefined || raw === '') {
    return packageManagerEnv;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(
      `BLEEDINGDEV_ACCEPT_BUILD_CONCURRENCY must be a positive integer, found: ${raw}`,
    );
  }
  return {
    ...packageManagerEnv,
    pnpm_config_workspace_concurrency: raw,
  };
}

function createAcceptanceDeploymentEnv(contract, packageManagerEnv) {
  const env = { ...packageManagerEnv };
  const { targets } = createSmokeTargets(contract, {
    env: { ...process.env, ...env },
    mode: 'local',
  });
  // These are explicit addresses of the proof deployment. Production builds
  // must not depend on the development-only implicit localhost fallback.
  for (const target of targets) {
    if (target.publicUrlEnv) {
      env[target.publicUrlEnv] = target.baseUrl;
    }
    if (target.portEnv) {
      env[target.portEnv] = String(target.port);
    }
  }
  return env;
}

async function reserveAcceptanceSmokePorts(contract) {
  const { targets } = createSmokeTargets(contract, { env: {}, mode: 'local' });
  const servers = [];
  const portEnv = {};
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await Promise.all(
      servers.map(
        server =>
          new Promise((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
          }),
      ),
    );
  };
  try {
    for (const target of targets) {
      if (!target.portEnv || target.portEnv in portEnv) {
        throw new Error(
          `${target.app.id} requires a unique local smoke port environment name`,
        );
      }
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
      portEnv[target.portEnv] = String(server.address().port);
    }
    return { portEnv, release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function withDuration(action) {
  const startedAt = performance.now();
  const details = await action();
  return {
    ...details,
    durationMs: roundDurationMs(performance.now() - startedAt),
  };
}

function normalizedRegistryTool(registryTool) {
  return {
    name: registryTool?.name ?? 'npm-registry',
    version: registryTool?.version ?? null,
    integrity: registryTool?.integrity ?? null,
  };
}

function runtimeVersions(runImpl, registryTool) {
  return {
    node: process.version,
    npm: runImpl('npm', ['--version'], { stdio: 'pipe' }),
    pnpm: runImpl('pnpm', ['--version'], { stdio: 'pipe' }),
    playwright: browserSmokePlaywrightPackage,
    platform: process.platform,
    arch: process.arch,
    registry: normalizedRegistryTool(registryTool),
    yaml: {
      name: YAML_NAME,
      version: YAML_VERSION,
      integrity: YAML_INTEGRITY,
    },
  };
}

function resolveExactPnpmExecutable(
  runImpl,
  expectedVersion,
  environment = process.env,
  verificationCwd = repoRoot,
) {
  if (
    typeof expectedVersion !== 'string' ||
    !/^[1-9]\d*\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion)
  ) {
    throw new Error(
      `Release manifest must bind an exact pnpm version, found ${String(expectedVersion)}`,
    );
  }
  const discoveryScript = `
    const fs = require('node:fs');
    const path = require('node:path');
    const names = process.platform === 'win32'
      ? ['pnpm.cmd', 'pnpm.exe', 'pnpm']
      : ['pnpm'];
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      for (const name of names) {
        const candidate = path.resolve(directory, name);
        try {
          fs.accessSync(
            candidate,
            process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
          );
          if (fs.statSync(candidate).isFile()) {
            process.stdout.write(candidate);
            process.exit(0);
          }
        } catch {}
      }
    }
    throw new Error('pnpm executable is absent from the exact pnpm exec PATH');
  `;
  const names =
    process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm'];
  const candidates = [];
  const provisionedExecutable = environment.ULTRAMODERN_PNPM_EXECUTABLE;
  if (provisionedExecutable !== undefined) {
    if (
      typeof provisionedExecutable !== 'string' ||
      !path.isAbsolute(provisionedExecutable)
    ) {
      throw new Error(
        `Provisioned acceptance pnpm executable must be absolute: ${String(provisionedExecutable)}`,
      );
    }
    candidates.push(provisionedExecutable);
  } else {
    try {
      const nestedExecutable = runImpl(
        'pnpm',
        ['exec', 'node', '-e', discoveryScript],
        {
          cwd: repoRoot,
          // Discovery reads the PATH of the environment this resolution was
          // handed, exactly like the parent-PATH scan below and exactly like
          // the child PATH built from the executable it returns. Falling back
          // to the ambient parent PATH here would let a candidate be
          // discovered from an environment the child never gets.
          env: { PATH: environment.PATH },
          stdio: 'pipe',
        },
      );
      if (path.isAbsolute(nestedExecutable)) {
        candidates.push(nestedExecutable);
      }
    } catch {
      // mise can execute pnpm without exposing its shim in `pnpm exec` PATH.
      // Parent PATH discovery below covers that installation shape.
    }
  }
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      try {
        fs.accessSync(
          candidate,
          process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
        );
        if (fs.statSync(candidate).isFile()) {
          candidates.push(candidate);
        }
      } catch {
        // Continue exactly as executable lookup would for a missing PATH entry.
      }
    }
  }
  const observedVersions = new Set();
  for (const executable of new Set(candidates)) {
    let actualVersion;
    try {
      actualVersion = runImpl(executable, ['--version'], {
        cwd: verificationCwd,
        stdio: 'pipe',
      });
    } catch {
      continue;
    }
    if (actualVersion === expectedVersion) {
      return executable;
    }
    observedVersions.add(actualVersion);
  }
  if (observedVersions.size > 0) {
    throw new Error(
      `Exact pnpm discovery resolved ${[...observedVersions].join(', ')}, expected ${expectedVersion}`,
    );
  }
  if (candidates.length === 0) {
    throw new Error(
      'pnpm executable is absent from the acceptance parent PATH',
    );
  }
  throw new Error(
    `No executable pnpm candidate could be verified as ${expectedVersion}`,
  );
}

// The one constructor for an acceptance runtime context. `isolated` browsers
// keep chromium inside the disposable package-manager root (Tractor, which
// installs it from the downstream frozen graph); `inherited` reuses the
// browsers the operational provisioning step already placed on the runner
// (ERP), taking the stated path when there is one and otherwise the platform
// default the XDG redirect cannot move. Either way the value is decided here
// and carried only by `env`, so the install path and the launch path cannot
// disagree: both read PLAYWRIGHT_BROWSERS_PATH out of this one environment,
// which always defines it.
function createAcceptanceRuntimeContext({
  browsers = 'inherited',
  environment = process.env,
  expectedPnpmVersion,
  registryEnv = {},
  storeDir,
  resolveExactPnpmExecutableImpl = resolveExactPnpmExecutable,
  runImpl = run,
  verificationCwd,
  workDir,
}) {
  if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) {
    throw new Error(
      `Acceptance runtime context requires an absolute work directory: ${String(workDir)}`,
    );
  }
  if (!acceptanceBrowserIsolations.includes(browsers)) {
    throw new Error(
      `Acceptance browser isolation must be ${acceptanceBrowserIsolations.join(' or ')}, found ${String(browsers)}`,
    );
  }
  // Decided before anything is spawned: an inherited path that cannot be
  // stated or derived is a caller mistake, not a runtime failure to discover
  // halfway through.
  const playwrightBrowsersPath =
    browsers === 'isolated'
      ? acceptancePlaywrightBrowsersPath(workDir)
      : inheritedPlaywrightBrowsersPath(environment.PLAYWRIGHT_BROWSERS_PATH, {
          environment,
        });
  const pnpmExecutable = resolveExactPnpmExecutableImpl(
    runImpl,
    expectedPnpmVersion,
    environment,
    verificationCwd ?? workDir,
  );
  const env = createAcceptancePackageManagerEnv(
    workDir,
    registryEnv,
    pnpmExecutable,
    environment,
    { storeDir },
  );
  env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  // Only what a clean room actually consumes: the child environment and the
  // absolute pnpm the Tractor bootstrap invokes directly. Everything else the
  // owner decides is observable through `env`.
  return { env, pnpmExecutable };
}

// In-process Playwright reads PLAYWRIGHT_BROWSERS_PATH from the real process
// environment, not from a subprocess env object, so the runtime context is
// applied around the launch and the parent process value restored afterwards
// — including when the launch throws.
async function withAcceptancePlaywrightBrowsersPath(browsersPath, action) {
  const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    if (browsersPath === undefined) {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    } else {
      process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
    }
    return await action();
  } finally {
    if (previousBrowsersPath === undefined) {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    } else {
      process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
    }
  }
}

function registryReceiptMetadata({ mode, registryUrl }) {
  return {
    url: registryUrl,
    resolution: 'package-manager-registry',
    cohortPackages: 'registry-only-exact-name-and-version',
    externalDependencies:
      mode === 'source' ? 'explicit-npmjs-direct' : 'selected-registry',
  };
}

// Source-mode install proof: with the scoped .npmrc (only @<targetScope> routed
// to the ephemeral registry, everything else direct npmjs), pnpm derives the
// cohort tarball URLs from the scope mapping and therefore omits
// resolution.tarball for cohort entries — an explicit tarball only appears for
// packages served from somewhere other than their configured registry. The
// proof is: every cohort entry is pinned to the exact release revision (which
// exists only on the ephemeral registry before publish) with a pinned
// integrity hash, any explicit cohort tarball is on the release registry
// origin, and no non-cohort package carries a tarball from that origin.
function assertCohortResolutionProvenance(
  projectDir,
  release,
  registryUrl,
  parseYamlFileImpl = parseYamlFile,
) {
  const lockPath = path.join(projectDir, 'pnpm-lock.yaml');
  const lock = parseYamlFileImpl(lockPath);
  const lockPackages =
    lock && typeof lock === 'object' ? lock.packages : undefined;
  if (!lockPackages || typeof lockPackages !== 'object') {
    throw new Error(
      `Cohort resolution proof requires a packages section in ${lockPath}`,
    );
  }
  const registryOrigin = new URL(registryUrl).origin;
  const cohortScopePrefix = `@${release.targetScope}/`;
  const releaseVersion = release.release?.version;
  if (typeof releaseVersion !== 'string' || releaseVersion.length === 0) {
    throw new Error(
      'Cohort resolution proof requires the strict release manifest version',
    );
  }
  const cohortByName = new Map(
    (release.packages ?? []).map(item => [item.targetName, item]),
  );
  const sidecarsByName = new Map(
    (release.sidecars?.packages ?? []).map(item => [item.name, item]),
  );
  let cohortPackageCount = 0;
  for (const [packageKey, record] of Object.entries(lockPackages)) {
    const tarball = record?.resolution?.tarball;
    if (packageKey.startsWith(cohortScopePrefix)) {
      const peerSuffixStart = packageKey.indexOf('(');
      const bareKey =
        peerSuffixStart === -1
          ? packageKey
          : packageKey.slice(0, peerSuffixStart);
      const separator = bareKey.lastIndexOf('@');
      const packageName = bareKey.slice(0, separator);
      const lockedVersion = bareKey.slice(separator + 1);
      const cohort = cohortByName.get(packageName);
      const sidecar = sidecarsByName.get(packageName);
      if (!cohort && !sidecar) {
        throw new Error(
          `Scoped release package ${packageKey} is outside the authenticated cohort and sidecars`,
        );
      }
      const expectedVersion = cohort ? releaseVersion : sidecar.version;
      if (lockedVersion !== expectedVersion) {
        throw new Error(
          `${cohort ? 'Cohort' : 'Sidecar'} package ${packageKey} locked version ${lockedVersion} is not the release revision ${expectedVersion}`,
        );
      }
      const integrity = record?.resolution?.integrity;
      if (
        typeof integrity !== 'string' ||
        integrity.length === 0 ||
        integrity !== (cohort ?? sidecar).integrity
      ) {
        throw new Error(
          `Release package ${packageKey} resolution integrity differs from its authenticated manifest`,
        );
      }
      if (typeof tarball === 'string' && tarball.length > 0) {
        const tarballOrigin = new URL(tarball).origin;
        if (tarballOrigin !== registryOrigin) {
          throw new Error(
            `Cohort package ${packageKey} tarball origin ${tarballOrigin} is not the release registry ${registryOrigin}`,
          );
        }
      }
      if (cohort) cohortPackageCount += 1;
    } else if (typeof tarball === 'string' && tarball.length > 0) {
      if (new URL(tarball).origin === registryOrigin) {
        throw new Error(
          `Non-cohort package ${packageKey} was served by the ephemeral release registry: ${tarball}`,
        );
      }
    }
  }
  if (cohortPackageCount === 0) {
    throw new Error(
      `Cohort resolution proof found no ${cohortScopePrefix}* packages in ${lockPath}`,
    );
  }
  return { cohortPackageCount, registryOrigin };
}

function configureAcceptanceWorkspaceGit(projectDir, env, runImpl = run) {
  const git = args =>
    runImpl('git', args, { cwd: projectDir, env, stdio: 'pipe' });
  const workspaceRoot = fs.realpathSync(projectDir);
  const gitRoot = fs.realpathSync(git(['rev-parse', '--show-toplevel']));
  if (gitRoot !== workspaceRoot) {
    throw new Error(
      `Generated acceptance workspace must be its own Git root: ${workspaceRoot} belongs to ${gitRoot}. Use a work directory outside an existing repository.`,
    );
  }
  git(['config', 'user.name', 'UltraModern Acceptance']);
  git(['config', 'user.email', 'acceptance@ultramodern.local']);
  git([
    'remote',
    'add',
    'origin',
    'https://github.com/ultramodern-ci/acceptance-superapp.git',
  ]);
}

function snapshotAcceptanceWorkspaceSource(projectDir, env, runImpl = run) {
  const git = (args, stdio = 'pipe') =>
    runImpl('git', args, { cwd: projectDir, env, stdio });

  git(['add', '-A'], 'inherit');
  const pending = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (pending) {
    git(
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=UltraModern Acceptance',
        '-c',
        'user.email=acceptance@ultramodern.local',
        'commit',
        '-m',
        'test: snapshot generated ERP-10 application source',
      ],
      'inherit',
    );
  }

  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) {
    throw new Error(
      `Generated acceptance application source is dirty after snapshot commit: ${dirty}`,
    );
  }
  const revision = git(['rev-parse', 'HEAD']).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) {
    throw new Error(
      `Generated acceptance application source revision is invalid: ${revision}`,
    );
  }
  return revision;
}

function isNamedObjectProperty(property, name) {
  return (
    types.isObjectProperty(property) &&
    !property.computed &&
    (types.isIdentifier(property.key, { name }) ||
      types.isStringLiteral(property.key, { value: name }))
  );
}

function setGeneratedInventoryApiTitle(apiPath, title) {
  const source = fs.readFileSync(apiPath, 'utf8');
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    filename: apiPath,
    parserOpts: {
      plugins: ['typescript'],
      sourceType: 'module',
    },
  });
  if (ast === null) {
    throw new Error('Inventory Effect API could not be parsed');
  }

  const titleProperties = [];
  traverse(ast, {
    ObjectExpression(objectPath) {
      const idProperty = objectPath.node.properties.find(property =>
        isNamedObjectProperty(property, 'id'),
      );
      if (
        !types.isObjectProperty(idProperty) ||
        !types.isStringLiteral(idProperty.value, {
          value: 'starter-inventory',
        })
      ) {
        return;
      }

      const titleProperty = objectPath.node.properties.find(property =>
        isNamedObjectProperty(property, 'title'),
      );
      if (
        !types.isObjectProperty(titleProperty) ||
        !types.isStringLiteral(titleProperty.value)
      ) {
        throw new Error(
          'Generated inventory API starter item must have one static title',
        );
      }
      titleProperties.push(titleProperty);
    },
  });
  if (titleProperties.length !== 1) {
    throw new Error(
      `Generated inventory API must have one starter item, found ${titleProperties.length}`,
    );
  }

  titleProperties[0].value = types.stringLiteral(title);
  const transformed = transformFromAstSync(ast, source, {
    ast: false,
    babelrc: false,
    cloneInputAst: false,
    code: true,
    configFile: false,
    filename: apiPath,
  });
  if (typeof transformed?.code !== 'string') {
    throw new Error('Inventory Effect API transformation produced no code');
  }
  fs.writeFileSync(apiPath, `${transformed.code}\n`);
}

function assertCleanApplicationGit(
  projectDir,
  expectedRevision,
  env,
  runImpl,
  label,
) {
  const revision = runImpl('git', ['rev-parse', 'HEAD'], {
    cwd: projectDir,
    env,
    stdio: 'pipe',
  }).toLowerCase();
  if (revision !== expectedRevision) {
    throw new Error(
      `${label} application HEAD must be ${expectedRevision}, found ${revision}`,
    );
  }
  const dirty = runImpl(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: projectDir, env, stdio: 'pipe' },
  );
  if (dirty) {
    throw new Error(`${label} application workspace is dirty: ${dirty}`);
  }
}

function createOperationalIndependenceCommit(
  projectDir,
  applicationSourceRevision,
  env,
  runImpl = run,
) {
  assertCleanApplicationGit(
    projectDir,
    applicationSourceRevision,
    env,
    runImpl,
    'C0',
  );
  const localePath = path.join(
    projectDir,
    'verticals/inventory/locales/en/inventory.json',
  );
  const locale = JSON.parse(fs.readFileSync(localePath, 'utf8'));
  if (locale?.inventory?.widgetBody !== 'Owns a vertical route surface.') {
    throw new Error(
      'Inventory C0 localization widgetBody does not match the generated ERP-10 contract',
    );
  }
  locale.inventory.widgetBody = operationalIndependenceUiValue;
  writeJsonFile(localePath, locale, { atomic: false });

  const apiPath = path.join(projectDir, 'verticals/inventory/api/index.ts');
  setGeneratedInventoryApiTitle(apiPath, operationalIndependenceApiValue);

  const changedBeforeCommit = runImpl(
    'git',
    ['diff', '--name-only', '--no-renames', '--'],
    { cwd: projectDir, env, stdio: 'pipe' },
  );
  const changedPaths = changedBeforeCommit
    .split('\n')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(changedPaths) !==
    JSON.stringify(operationalIndependenceChangedPaths)
  ) {
    throw new Error(
      `Operational-independence C1 must change only the inventory UI/localization and API response files; found ${changedPaths.join(', ')}`,
    );
  }

  runImpl('git', ['add', '--', ...operationalIndependenceChangedPaths], {
    cwd: projectDir,
    env,
    stdio: 'inherit',
  });
  runImpl(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-gpg-sign',
      '-m',
      'test: rotate inventory operational identity',
    ],
    { cwd: projectDir, env, stdio: 'inherit' },
  );
  const changedRevision = runImpl('git', ['rev-parse', 'HEAD'], {
    cwd: projectDir,
    env,
    stdio: 'pipe',
  }).toLowerCase();
  const parentLine = runImpl(
    'git',
    ['rev-list', '--parents', '-n', '1', changedRevision],
    { cwd: projectDir, env, stdio: 'pipe' },
  ).split(/\s+/u);
  if (parentLine.length !== 2 || parentLine[1] !== applicationSourceRevision) {
    throw new Error(
      'Operational-independence C1 must be one clean commit directly on application C0',
    );
  }
  assertCleanApplicationGit(projectDir, changedRevision, env, runImpl, 'C1');
  // The branch keeps C1; acceptance continues building C0, so HEAD goes back.
  runImpl('git', ['switch', '--detach', applicationSourceRevision], {
    cwd: projectDir,
    env,
    stdio: 'pipe',
  });
  assertCleanApplicationGit(
    projectDir,
    applicationSourceRevision,
    env,
    runImpl,
    'C0',
  );
  return {
    applicationSourceRevision,
    changedPaths,
    changedRevision,
    mutations: {
      apiResponse: {
        path: operationalIndependenceChangedPaths[0],
        value: operationalIndependenceApiValue,
      },
      uiLocalization: {
        path: operationalIndependenceChangedPaths[1],
        value: operationalIndependenceUiValue,
      },
    },
  };
}

// Node and Cloudflare builds both write each app's `.output`, so the Node C0
// artifacts exist only until the Cloudflare build. Prove Node in that window.
async function proveNodeOperationalIndependence({
  applicationSourceRevision,
  baseline,
  ephemeralWorkDir,
  outPath,
  packageManagerEnv,
  projectDir,
  runImpl = run,
  proveOperationalTargetImpl = proveOperationalTarget,
}) {
  const startedAt = performance.now();
  const evidencePath = operationalIndependenceEvidencePath(outPath);
  if (ephemeralWorkDir) {
    const relativeEvidencePath = path.relative(
      path.resolve(ephemeralWorkDir),
      evidencePath,
    );
    if (
      relativeEvidencePath === '' ||
      (!relativeEvidencePath.startsWith('..') &&
        !path.isAbsolute(relativeEvidencePath))
    ) {
      throw new Error(
        `Operational-independence evidence path must survive ephemeral workspace cleanup: ${evidencePath}`,
      );
    }
  }
  const transition = createOperationalIndependenceCommit(
    projectDir,
    applicationSourceRevision,
    packageManagerEnv,
    runImpl,
  );
  const proof = await proveOperationalTargetImpl({
    baseline,
    changedRef: transition.changedRevision,
    expectedApiValue: transition.mutations.apiResponse.value,
    expectedUiValue: transition.mutations.uiLocalization.value,
    packageManagerEnv,
  });
  return {
    durationMs: performance.now() - startedAt,
    evidencePath,
    proof,
    transition,
  };
}

async function completeOperationalIndependence({
  applicationSourceRevision,
  baseline,
  mode,
  node,
  packageManagerEnv,
  proveOperationalTargetImpl = proveOperationalTarget,
}) {
  const startedAt = performance.now();
  const { evidencePath, transition } = node;
  const cloudflare = await proveOperationalTargetImpl({
    baseline,
    changedRef: transition.changedRevision,
    expectedApiValue: transition.mutations.apiResponse.value,
    expectedUiValue: transition.mutations.uiLocalization.value,
    packageManagerEnv,
  });
  const evidence = assembleOperationalEvidence({
    node: node.proof,
    cloudflare,
    out: evidencePath,
  });
  return {
    ...createOperationalIndependenceResultDetails({
      applicationSourceRevision,
      changedRevision: transition.changedRevision,
      evidence,
      evidencePath,
      expectedApiValue: transition.mutations.apiResponse.value,
      expectedChangedPaths: transition.changedPaths,
      expectedUiValue: transition.mutations.uiLocalization.value,
      mode,
    }),
    durationMs: roundDurationMs(
      node.durationMs + performance.now() - startedAt,
    ),
  };
}

function receiptFailure(receipt, error) {
  receipt.status = 'failed';
  receipt.passed = false;
  receipt.error = error instanceof Error ? error.message : String(error);
}

// The source lane builds the scaffolded workspace and runs it on Node and
// workerd. The published lane never gets here: npm serves the tarballs built
// and run below, so it proves resolution parity instead.
async function acceptBuiltWorkspace({
  audit,
  browserSmokeImpl,
  now,
  options,
  outPath,
  ownedWorkDir,
  packageManagerEnv,
  projectDir,
  proveOperationalTargetImpl,
  receipt,
  registryUrl,
  release,
  runImpl,
  runtimeArtifactBinding,
}) {
  let applicationSourceRevision;
  let artifacts;
  let operationalNode;
  const operationalBaselines = {};
  const runtimeReports = new Map();
  const runtimeIdentityDetails = new Map();
  await recordAcceptanceResult(receipt, 'install', () =>
    withDuration(() => {
      const beforeInstall = verifyStrictInstallInputs(projectDir, audit, {
        now: currentTime(now),
        phase: 'before-frozen-install',
      });
      runImpl('pnpm', requiredPnpmCommands.install, {
        cwd: projectDir,
        env: packageManagerEnv,
      });
      const afterInstall = verifyStrictInstallInputs(projectDir, audit, {
        now: currentTime(now),
        phase: 'after-frozen-install',
      });
      return {
        command: 'pnpm install --frozen-lockfile',
        beforeInstall,
        afterInstall,
        cohort: assertGeneratedCohort(projectDir, release),
        defaultOffRsc: assertDefaultOffRscInstall(
          projectDir,
          audit.closureIdentities,
        ),
        cohortResolution: assertCohortResolutionProvenance(
          projectDir,
          release,
          registryUrl,
        ),
      };
    }),
  );

  await recordAcceptanceResult(receipt, 'pnpm-check', () =>
    withDuration(() => {
      runImpl('pnpm', requiredPnpmCommands.check, {
        cwd: projectDir,
        env: packageManagerEnv,
      });
      // A real first install materializes pinned generated-workspace assets
      // such as clone-backed agent skills. Snapshot only after lifecycle
      // scripts and the full workspace check have completed so the exact
      // committed source built below is clean and promotable.
      applicationSourceRevision = snapshotAcceptanceWorkspaceSource(
        projectDir,
        packageManagerEnv,
        runImpl,
      );
      return {
        command: 'pnpm check',
        applicationSourceRevision,
        ...assertWorkspaceCheckContract(projectDir),
      };
    }),
  );

  const smokeContract = readSmokeContract(projectDir).contract;
  const reservedSmokePorts = await reserveAcceptanceSmokePorts(smokeContract);
  const deploymentEnv = createAcceptanceDeploymentEnv(smokeContract, {
    ...packageManagerEnv,
    ...reservedSmokePorts.portEnv,
  });
  try {
    await recordAcceptanceResult(receipt, 'build', () =>
      withDuration(() => {
        runImpl('pnpm', requiredPnpmCommands.build, {
          cwd: projectDir,
          env: createAcceptanceBuildEnv(deploymentEnv),
        });
        operationalBaselines.node = captureOperationalBaseline({
          workspace: projectDir,
          target: 'node',
          ids: operationalIndependenceIds,
          packageManagerEnv: deploymentEnv,
        });
        return { command: 'pnpm build' };
      }),
    );
  } finally {
    await reservedSmokePorts.release();
  }

  // Cloudflare builds reuse each app's .output directory. Execute and cache
  // the strict Node report while the final Node deployment roots still
  // exist; the receipt loop below consumes this exact report in its normal
  // platform/dimension order.
  const nodeRuntimeReport = await browserSmokeImpl(projectDir, {
    ...runtimeAcceptanceInvocation('source', 'node'),
    packageManagerEnv: deploymentEnv,
  });
  if (!nodeRuntimeReport || typeof nodeRuntimeReport !== 'object') {
    throw new Error('Node runtime acceptance did not produce a report');
  }
  runtimeReports.set('node', nodeRuntimeReport);

  await recordAcceptanceResult(receipt, 'topology', () =>
    withDuration(() => {
      artifacts = readWorkspaceAcceptanceArtifacts(projectDir);
      return assertTopologyAcceptance(artifacts, options.verticals);
    }),
  );
  await recordAcceptanceResult(receipt, 'module-federation', () =>
    withDuration(() =>
      assertModuleFederationAcceptance(artifacts, options.verticals),
    ),
  );
  await recordAcceptanceResult(receipt, 'api', () =>
    withDuration(() => assertApiAcceptance(artifacts, options.verticals)),
  );
  await recordAcceptanceResult(receipt, 'backend', () =>
    withDuration(() => assertBackendAcceptance(artifacts, options.verticals)),
  );

  // The Cloudflare deploy replaces each app's final `.output` directory.
  // Capture every path-based Node artifact assertion first; the strict Node
  // browser report above and this backend-envelope assertion must describe
  // the same executed deployment roots, not the later Cloudflare staging.
  try {
    operationalNode = await proveNodeOperationalIndependence({
      applicationSourceRevision,
      baseline: operationalBaselines.node,
      ephemeralWorkDir: ownedWorkDir,
      outPath,
      packageManagerEnv: deploymentEnv,
      projectDir,
      runImpl,
      proveOperationalTargetImpl,
    });
  } catch (error) {
    await recordAcceptanceResult(receipt, operationalIndependenceResultId, () =>
      Promise.reject(error),
    );
  }
  await recordAcceptanceResult(receipt, 'cloudflare-build', () =>
    withDuration(() => {
      runImpl('pnpm', requiredPnpmCommands.cloudflareBuild, {
        cwd: projectDir,
        env: createAcceptanceBuildEnv(deploymentEnv),
      });
      operationalBaselines.cloudflare = captureOperationalBaseline({
        workspace: projectDir,
        target: 'cloudflare',
        ids: operationalIndependenceIds,
        packageManagerEnv: deploymentEnv,
      });
      return { command: 'pnpm cloudflare:build' };
    }),
  );
  for (const platform of runtimeAcceptancePlatforms) {
    for (const dimension of runtimeAcceptanceDimensions) {
      const resultId = `${platform}-${dimension}`;
      const details = await recordAcceptanceResult(receipt, resultId, () =>
        withDuration(async () => {
          let report = runtimeReports.get(platform);
          if (!report) {
            report = await browserSmokeImpl(projectDir, {
              ...runtimeAcceptanceInvocation('source', platform),
              packageManagerEnv: deploymentEnv,
            });
            runtimeReports.set(platform, report);
          }
          return assertRuntimeAcceptanceDimension(report, {
            applicationSourceRevision,
            artifactBinding: runtimeArtifactBinding,
            dimension,
            mode: 'source',
            platform,
            release,
            verticals: options.verticals,
          });
        }),
      );
      if (dimension === 'release-identity') {
        runtimeIdentityDetails.set(platform, details);
      }
    }
  }
  bindRuntimeIdentityEvidence(
    receipt,
    runtimeIdentityBinding(
      runtimeIdentityDetails.get('node'),
      runtimeIdentityDetails.get('workerd'),
    ),
  );
  await recordAcceptanceResult(receipt, operationalIndependenceResultId, () =>
    completeOperationalIndependence({
      applicationSourceRevision,
      baseline: operationalBaselines.cloudflare,
      mode: 'source',
      node: operationalNode,
      packageManagerEnv: deploymentEnv,
      proveOperationalTargetImpl,
    }),
  );
}

async function runAcceptanceProfile({
  mode,
  acceptedResolution,
  release,
  registryUrl,
  registryEnv = {},
  registryTool,
  options,
  outPath,
  runIdentity,
  releaseAgePolicyPath,
  runImpl = run,
  browserSmokeImpl = runBrowserSmoke,
  auditReleaseAgePolicyImpl = auditReleaseAgePolicy,
  assertNoHighAdvisoriesImpl = assertNoHighAdvisories,
  proveOperationalTargetImpl = proveOperationalTarget,
  now = Date,
  workDir: suppliedWorkDir,
  storeDir,
}) {
  if (!['source', 'published'].includes(mode)) {
    throw new Error(
      `Acceptance mode must be source or published, found ${mode}`,
    );
  }
  if ((mode === 'published') !== (acceptedResolution !== undefined)) {
    throw new Error(
      'Published acceptance compares against the resolution a passed source receipt accepted; pass acceptedResolution in published mode and only there.',
    );
  }
  assertReleaseAcceptanceProfile(options);

  const createPackage = resolveCreatePackage(release, options.createPackage);
  const commandExclusions = releaseAgeExemptions(release, {
    policyPath: releaseAgePolicyPath,
    now: currentTime(now),
  });
  const workDir =
    suppliedWorkDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-release-acceptance-'));
  const ownsWorkDir = suppliedWorkDir === undefined;
  if (ownsWorkDir) {
    startOwnedWorkDirGuardian(workDir);
  }
  try {
    const projectDir = path.join(workDir, options.projectName);
    const runtime = runtimeVersions(runImpl, registryTool);
    // ERP subprocesses take their whole runtime context from the shared owner.
    // The source lane inherits the browsers the runner provisioned; the
    // published lane runs no browser, so it gets an unused isolated path.
    const { env: runtimeEnv } = createAcceptanceRuntimeContext({
      browsers: mode === 'source' ? 'inherited' : 'isolated',
      expectedPnpmVersion: release.tools?.pnpm ?? runtime.pnpm,
      registryEnv,
      storeDir,
      runImpl,
      workDir,
    });
    const bootstrapEnv = createAcceptanceReleaseAgeEnv(
      runtimeEnv,
      createPackage,
      commandExclusions,
      registryEnv,
    );
    const packageManagerEnv = createAcceptanceWorkspaceEnv(runtimeEnv, {
      mode,
      release,
      registryEnv,
    });
    const receipt = createAcceptanceReceipt({
      release,
      mode,
      profile: options.selectedProfile,
      createPackage,
      runtime,
      registry: {
        ...registryReceiptMetadata({ mode, registryUrl }),
        sourceCandidateTrustPolicyExclude: JSON.parse(
          packageManagerEnv.pnpm_config_trust_policy_exclude ?? '[]',
        ),
      },
      runIdentity,
      now,
    });
    const runtimeArtifactBinding = createRuntimeArtifactBinding(release);

    let failure;
    let audit;
    try {
      await recordAcceptanceResult(receipt, 'registry-cohort-integrity', () =>
        withDuration(() =>
          verifyRegistryCohort({
            release,
            registryUrl,
            env: bootstrapEnv,
            workDir,
            // Async runner: the cohort proof verifies packages through a
            // bounded concurrent pool; the profile's shared sync runImpl would
            // serialize it (spawnSync blocks the event loop).
            runImpl: runAsync,
          }),
        ),
      );

      await recordAcceptanceResult(receipt, 'native-create', () =>
        withDuration(() => {
          createWorkspace(
            workDir,
            options.projectName,
            createPackage,
            bootstrapEnv,
            runImpl,
          );
          // The generated project is always-Zephyr by design (the zephyr-gating
          // policy forbids disabling it), and zephyr-agent requires git identity
          // and a remote origin to initialize a build — a hard requirement in CI.
          // The create CLI initializes Git without committing before install.
          // Set the acceptance author and remote here; the checked workspace is
          // committed with hooks after installation, before its first build.
          // This origin is never fetched; Zephyr only parses the URL to identify
          // the repository. No Zephyr token is set, so nothing
          // is uploaded: this exercises "builds with Zephyr present, without a
          // Zephyr account".
          configureAcceptanceWorkspaceGit(
            projectDir,
            packageManagerEnv,
            runImpl,
          );
          return {
            runner: 'pnpm dlx',
            exactSpecifier: createPackage.exactSpecifier,
            projectName: options.projectName,
          };
        }),
      );

      await recordAcceptanceResult(receipt, 'vertical-additions', () =>
        withDuration(() => {
          for (const vertical of options.verticals) {
            addVertical(
              projectDir,
              vertical,
              createPackage,
              packageManagerEnv,
              runImpl,
            );
          }
          return {
            count: options.verticals.length,
            verticals: options.verticals,
            frameworkVersion: createPackage.frameworkVersion,
            ...scaffoldFiles(projectDir),
          };
        }),
      );

      await recordAcceptanceResult(receipt, 'generate-lockfile', () =>
        withDuration(() => {
          runImpl('pnpm', requiredPnpmCommands.lockfileOnly, {
            cwd: projectDir,
            env: packageManagerEnv,
          });
          return {
            command: 'pnpm install --lockfile-only --ignore-scripts',
            lockfile: 'pnpm-lock.yaml',
          };
        }),
      );

      await recordAcceptanceResult(receipt, 'dependency-closure-audit', () =>
        withDuration(async () => {
          audit = await auditReleaseAgePolicyImpl({
            projectDir,
            release,
            commandExclusions,
            registryUrl,
            policyPath: releaseAgePolicyPath,
            runImpl,
            now: currentTime(now),
          });
          bindSupplyChainEvidence(receipt, audit.digests);
          const advisories = await assertNoHighAdvisoriesImpl({
            allowRepositoryCorrections: false,
            cwd: projectDir,
            env: packageManagerEnv,
            now: currentTime(now),
          });
          return {
            advisories,
            approvals: audit.approvals,
            candidateDiscovery: audit.candidateDiscovery,
            closureCount: audit.closureCount,
            closureIdentities: audit.closureIdentities,
            digests: audit.digests,
            exactExclusionCount: audit.exactExclusions.length,
            importerCount: audit.importerCount,
            lockfileVersion: audit.lockfileVersion,
            matureCount: audit.matureCount,
            policyEntryCount: audit.policyEntryCount,
            registryMetadataCount: audit.registryMetadataCount,
            workspacePolicySha256: audit.workspacePolicySha256,
          };
        }),
      );

      if (mode === 'published') {
        const scaffold = receipt.results.find(
          result => result.id === 'vertical-additions',
        ).details;
        await recordAcceptanceResult(receipt, resolutionParityResultId, () =>
          withDuration(() => ({
            ...assertScaffoldParity(acceptedResolution, scaffold, {
              lane: 'Published ERP-10',
            }),
            ...assertResolutionParity(
              acceptedResolution,
              {
                closureIdentities: audit.closureIdentities,
                closureSha256: audit.digests.closureSha256,
              },
              { lane: 'Published ERP-10' },
            ),
          })),
        );
      } else {
        await acceptBuiltWorkspace({
          audit,
          browserSmokeImpl,
          now,
          options,
          outPath,
          ownedWorkDir: ownsWorkDir ? workDir : undefined,
          packageManagerEnv,
          projectDir,
          proveOperationalTargetImpl,
          receipt,
          registryUrl,
          release,
          runImpl,
          runtimeArtifactBinding,
        });
      }
    } catch (error) {
      failure = error;
    }

    finalizeAcceptanceReceipt(receipt, failure);
    if (!failure) {
      try {
        assertAcceptanceReceipt(receipt, {
          release,
          profileId: options.selectedProfile.id,
          runIdentity,
          expectedMode: mode,
        });
      } catch (error) {
        failure = error;
        receiptFailure(receipt, error);
      }
    }
    writeJsonFile(outPath, receipt, { atomic: false });
    if (failure) {
      throw failure;
    }
    return receipt;
  } finally {
    if (ownsWorkDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

export {
  acceptancePlaywrightInstallArgs,
  assertCohortResolutionProvenance,
  assertDefaultOffRscInstall,
  configureAcceptanceWorkspaceGit,
  createAcceptanceBuildEnv,
  createAcceptanceDeploymentEnv,
  createAcceptancePackageManagerEnv,
  createAcceptanceReleaseAgeEnv,
  createAcceptanceRuntimeContext,
  createOperationalIndependenceCommit,
  createRuntimeArtifactBinding,
  inheritedPlaywrightBrowsersPath,
  operationalIndependenceIds,
  requiredPnpmCommands,
  reserveAcceptanceSmokePorts,
  resolveExactPnpmExecutable,
  runAcceptanceProfile,
  snapshotAcceptanceWorkspaceSource,
  withAcceptancePlaywrightBrowsersPath,
};
