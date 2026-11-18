#!/usr/bin/env node
/**
 * The one Playwright browser provisioner for CI.
 *
 * A "runtime" is a directory whose node_modules/playwright was materialized
 * by the frozen workspace install (or, for the ERP browser smoke, by the
 * acceptance runtime installer). Its installed playwright version is the one
 * the lockfile resolved for the package under test, and it keys the browser
 * cache: the key changes exactly when that playwright changes.
 *
 *   --resolve --runtime <dir> [--runtime <dir> ...]
 *       Writes `version`, `cache_key` and `cache_path` to $GITHUB_OUTPUT.
 *       Every runtime must resolve the same playwright.
 *   --install --runtime <dir> [...] --version <version>
 *       Re-reads the runtimes after the cache restore, fails closed when they
 *       are not the version that keyed the cache, then runs the first
 *       runtime's own CLI. `playwright install` is a no-op for browsers already restored
 *       from the cache; on Linux `--with-deps` also installs the OS packages,
 *       which live outside the cached directory, but only when the runtime's
 *       own `install-deps --dry-run` reports one missing.
 *
 * The CLI is spawned as `node <playwright bin>`, never through a shell or a
 * `.bin` shim, so the same call works on Linux, macOS and Windows.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { repoRoot } = require('./fs-kit.js');
const { runCommand } = require('./process-kit.js');

const installedBrowsers = Object.freeze(['chromium']);
const playwrightVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function assertExactPlaywrightVersion(version, subject) {
  if (typeof version !== 'string' || !playwrightVersionPattern.test(version)) {
    throw new Error(
      `${subject} must be an exact playwright version, found ${String(version)}`,
    );
  }
  return version;
}

function readPlaywrightManifest(runtimeDir) {
  const manifestPath = path.join(
    runtimeDir,
    'node_modules/playwright/package.json',
  );
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    throw new Error(
      `Playwright is not installed at ${manifestPath}. Install the workspace (pnpm install --frozen-lockfile) before provisioning browsers for ${runtimeDir}.`,
      { cause },
    );
  }
  assertExactPlaywrightVersion(manifest?.version, manifestPath);
  return { manifest, manifestPath };
}

function resolvePlaywrightVersion(runtimeDir) {
  return readPlaywrightManifest(runtimeDir).manifest.version;
}

function browserCacheKey({ runnerOs, version }) {
  assertExactPlaywrightVersion(version, 'Browser cache key');
  if (typeof runnerOs !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(runnerOs)) {
    throw new Error(
      `Browser cache key requires a simple runner OS name, found ${String(runnerOs)}`,
    );
  }
  return `playwright-${installedBrowsers.join('-')}-${version}-${runnerOs}`;
}

// Mirrors playwright's own registry directory so the cache restores exactly
// where the runtime looks for its browsers.
function browserCachePath({
  environment = process.env,
  homedir = os.homedir(),
  platform = process.platform,
} = {}) {
  const override = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (override !== undefined && override !== '') {
    if (override === '0') {
      throw new Error(
        'PLAYWRIGHT_BROWSERS_PATH=0 stores browsers inside node_modules, which the browser cache cannot restore. Unset it or point it at a directory.',
      );
    }
    return path.resolve(override);
  }
  if (platform === 'win32') {
    const localAppData =
      environment.LOCALAPPDATA ?? path.join(homedir, 'AppData', 'Local');
    return path.join(localAppData, 'ms-playwright');
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Caches', 'ms-playwright');
  }
  return path.join(
    environment.XDG_CACHE_HOME ?? path.join(homedir, '.cache'),
    'ms-playwright',
  );
}

// The browsers directory for a job whose runtime reads an explicit
// PLAYWRIGHT_BROWSERS_PATH. RUNNER_TEMP is the runner's own absolute per-job
// directory. A job-level `env:` cannot name it (the `runner` context is not
// available there), so the resolving step exports it through GITHUB_ENV.
function runnerTempBrowsersPath(environment = process.env) {
  const runnerTemp = environment.RUNNER_TEMP;
  if (
    typeof runnerTemp !== 'string' ||
    !path.isAbsolute(runnerTemp) ||
    path.normalize(runnerTemp) !== runnerTemp
  ) {
    throw new Error(
      `RUNNER_TEMP must be an absolute, normalized directory, found ${String(runnerTemp)}. Run on a GitHub Actions runner, or set RUNNER_TEMP to such a directory.`,
    );
  }
  return path.join(runnerTemp, 'ms-playwright');
}

function browserInstallArgs(
  platform = process.platform,
  { systemDependenciesInstalled = false } = {},
) {
  return platform === 'linux' && !systemDependenciesInstalled
    ? ['install', '--with-deps', ...installedBrowsers]
    : ['install', ...installedBrowsers];
}

// `install --with-deps` runs `apt-get update` and `apt-get install` for every
// listed package even when all are installed, and apt then upgrades any the
// refreshed index has newer: 24 s of a 33 s step on a Depot boot whose image
// lagged four mesa updates (publish run 44196872541). `install-deps --dry-run`
// simulates that install against the image's own index and prints this line
// only when no package is missing; anything else installs them as before.
const allSystemDependenciesInstalled =
  /^All system dependencies are installed\.$/mu;

function linuxSystemDependenciesInstalled(cli, runtimeDir, runCommandImpl) {
  const check = runCommandImpl(
    process.execPath,
    [cli, 'install-deps', '--dry-run', ...installedBrowsers],
    { cwd: runtimeDir, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  process.stdout.write(check.stdout ?? '');
  return (
    check.exitCode === 0 &&
    allSystemDependenciesInstalled.test(check.stdout ?? '')
  );
}

// Every runtime the job drives must resolve the same playwright: one browser
// install then serves all of them, and a divergent runtime fails here with
// its path instead of at browser launch.
function resolveSharedPlaywrightVersion(runtimeDirs) {
  if (!Array.isArray(runtimeDirs) || runtimeDirs.length === 0) {
    throw new Error(
      'Browser provisioning requires --runtime <repo-relative directory whose package depends on playwright>',
    );
  }
  const [first, ...rest] = runtimeDirs;
  const version = resolvePlaywrightVersion(first);
  for (const runtimeDir of rest) {
    const other = resolvePlaywrightVersion(runtimeDir);
    if (other !== version) {
      throw new Error(
        `${runtimeDir} resolves playwright ${other} but ${first} resolves ${version}. Align their playwright dependencies or provision them in separate steps.`,
      );
    }
  }
  return version;
}

function installBrowsers(
  { runtimeDirs, version },
  { platform = process.platform, runCommandImpl = runCommand } = {},
) {
  assertExactPlaywrightVersion(version, '--version');
  // Re-read after the cache restore: a runtime that is no longer the version
  // that keyed the cache would get browsers it cannot launch.
  const installed = resolveSharedPlaywrightVersion(runtimeDirs);
  if (installed !== version) {
    throw new Error(
      `Installed playwright ${installed} in ${runtimeDirs.join(', ')} is not the ${version} that keyed the browser cache. Resolve and install in the same job without reinstalling dependencies in between.`,
    );
  }
  const [runtimeDir] = runtimeDirs;
  const { manifest, manifestPath } = readPlaywrightManifest(runtimeDir);
  const bin =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.playwright;
  if (typeof bin !== 'string') {
    throw new Error(`${manifestPath} declares no playwright bin`);
  }
  const cli = path.join(path.dirname(manifestPath), bin);
  const args = browserInstallArgs(platform, {
    systemDependenciesInstalled:
      platform === 'linux' &&
      linuxSystemDependenciesInstalled(cli, runtimeDir, runCommandImpl),
  });
  const result = runCommandImpl(process.execPath, [cli, ...args], {
    cwd: runtimeDir,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `playwright ${args.join(' ')} failed in ${runtimeDir} with exit code ${result.exitCode}`,
    );
  }
  return { browsers: [...installedBrowsers], version };
}

function writeGithubOutputs(outputs, environment = process.env) {
  if (!environment.GITHUB_OUTPUT) {
    return;
  }
  for (const [name, value] of Object.entries(outputs)) {
    fs.appendFileSync(environment.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

// Exports variables to every later step of the job. A missing GITHUB_ENV is an
// error, not a no-op: the install step would silently fill another directory
// than the one the cache restores and saves.
function writeGithubEnv(variables, environment = process.env) {
  if (!environment.GITHUB_ENV) {
    throw new Error(
      `GITHUB_ENV is not set, so ${Object.keys(variables).join(', ')} cannot reach the later steps. Run this inside a GitHub Actions job.`,
    );
  }
  for (const [name, value] of Object.entries(variables)) {
    if (/[\r\n]/u.test(value)) {
      throw new Error(`${name} must be a single line, found ${JSON.stringify(value)}`);
    }
    fs.appendFileSync(environment.GITHUB_ENV, `${name}=${value}\n`);
  }
}

function resolveBrowserOutputs(version, environment = process.env) {
  return {
    cache_key: browserCacheKey({
      runnerOs: environment.RUNNER_OS ?? process.platform,
      version,
    }),
    cache_path: browserCachePath({ environment }),
    version,
  };
}

function parseProvisionArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      install: { type: 'boolean' },
      resolve: { type: 'boolean' },
      runtime: { multiple: true, type: 'string' },
      version: { type: 'string' },
    },
    strict: true,
  });
  if (Boolean(values.install) === Boolean(values.resolve)) {
    throw new Error(
      'Browser provisioning requires exactly one of --resolve or --install',
    );
  }
  if (!values.runtime?.length) {
    throw new Error(
      'Browser provisioning requires --runtime <repo-relative directory whose package depends on playwright>',
    );
  }
  if (values.resolve && values.version !== undefined) {
    throw new Error('--version applies only to --install');
  }
  if (values.install && values.version === undefined) {
    throw new Error(
      '--install requires --version <playwright version> from the matching --resolve step',
    );
  }
  return {
    mode: values.install ? 'install' : 'resolve',
    runtimeDirs: values.runtime.map(runtime => path.resolve(repoRoot, runtime)),
    version: values.version,
  };
}

function provisionBrowsers(
  argv = process.argv.slice(2),
  { environment = process.env, installBrowsersImpl = installBrowsers } = {},
) {
  const { mode, runtimeDirs, version } = parseProvisionArgs(argv);
  if (mode === 'install') {
    return installBrowsersImpl({ runtimeDirs, version });
  }
  const outputs = resolveBrowserOutputs(
    resolveSharedPlaywrightVersion(runtimeDirs),
    environment,
  );
  writeGithubOutputs(outputs, environment);
  return outputs;
}

if (require.main === module) {
  try {
    provisionBrowsers();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(1);
  }
}

module.exports = {
  assertExactPlaywrightVersion,
  browserCacheKey,
  browserCachePath,
  browserInstallArgs,
  installBrowsers,
  parseProvisionArgs,
  provisionBrowsers,
  resolveBrowserOutputs,
  resolvePlaywrightVersion,
  resolveSharedPlaywrightVersion,
  runnerTempBrowsersPath,
  writeGithubEnv,
  writeGithubOutputs,
};
