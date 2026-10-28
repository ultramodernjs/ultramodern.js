import { execFile } from 'node:child_process';
import path from 'node:path';
import { createProcessEnv, repoRoot, runCommand } from './constants.mjs';
import { authenticatedCompilerTrustExclusions } from './package-cohort.mjs';

function run(command, args, options = {}) {
  const result = runCommand(command, args, {
    cwd: options.cwd || repoRoot,
    env: createProcessEnv(options.env || {}),
    encoding: 'utf-8',
    stdio: options.stdio || 'inherit',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(' ')}`);
  }
  return result.stdout?.trim() ?? '';
}

// Async sibling of run() for call sites that need real subprocess
// concurrency; spawnSync blocks the event loop, so a pool built on run()
// executes strictly serially. maxBuffer covers `npm pack --json` /
// `npm view --json` output captured by the registry cohort proof.
function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd || repoRoot,
        env: createProcessEnv(options.env || {}),
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Command failed: ${[command, ...args].join(' ')}`));
          return;
        }
        resolve(stdout?.trim() ?? '');
      },
    );
  });
}

function createCleanPnpmDlxEnv(root, { storeDir } = {}) {
  if (
    storeDir !== undefined &&
    (typeof storeDir !== 'string' ||
      storeDir.trim() !== storeDir ||
      storeDir.includes('\0') ||
      !path.isAbsolute(storeDir))
  ) {
    throw new Error('Acceptance store directory must be an absolute path');
  }
  const selectedStore =
    storeDir === undefined ? path.join(root, 'store') : path.resolve(storeDir);
  return {
    XDG_CACHE_HOME: path.join(root, 'xdg'),
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_store_dir: selectedStore,
    pnpm_config_store_dir: selectedStore,
    ...(storeDir === undefined
      ? {}
      : {
          npm_config_package_import_method: 'clone-or-copy',
          pnpm_config_package_import_method: 'clone-or-copy',
        }),
  };
}

function acceptancePackageManagerRoot(workDir) {
  return path.join(workDir, 'package-manager');
}

function createAcceptancePackageManagerEnv(
  workDir,
  registryEnv = {},
  pnpmExecutable,
  environment = process.env,
  { storeDir } = {},
) {
  const packageManagerEnv = createCleanPnpmDlxEnv(
    acceptancePackageManagerRoot(workDir),
    { storeDir },
  );
  if (storeDir !== undefined) {
    const relative = path.relative(
      workDir,
      packageManagerEnv.pnpm_config_store_dir,
    );
    if (
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    ) {
      throw new Error(
        'Acceptance external store must be outside its work directory',
      );
    }
  }
  const env = {
    ...packageManagerEnv,
    ...registryEnv,
    CI: 'true',
    npm_config_fetch_retries: '5',
    npm_config_fetch_timeout: '600000',
    MODERN_CREATE_ULTRAMODERN_FRAMEWORK_VERSION: undefined,
    pnpm_config_fetch_retries: '5',
    pnpm_config_fetch_timeout: '600000',
    pnpm_config_network_concurrency: '8',
    ULTRAMODERN_CREATE_BIN: undefined,
    ZE_CI_TOKEN: undefined,
  };
  if (storeDir !== undefined) {
    for (const name of [
      'npm_config_store_dir',
      'pnpm_config_store_dir',
      'npm_config_package_import_method',
      'pnpm_config_package_import_method',
    ]) {
      for (const inheritedName of Object.keys(env)) {
        if (inheritedName.toLowerCase() === name) {
          delete env[inheritedName];
        }
      }
      env[name] = packageManagerEnv[name];
    }
  }
  if (pnpmExecutable !== undefined) {
    if (!path.isAbsolute(pnpmExecutable)) {
      throw new Error(
        `Acceptance pnpm executable must be absolute: ${pnpmExecutable}`,
      );
    }
    // The PATH the caller injected, never the ambient parent PATH: a runtime
    // context is only hermetic if its own environment decides what the child
    // can execute.
    env.PATH = [path.dirname(pnpmExecutable), environment.PATH]
      .filter(Boolean)
      .join(path.delimiter);
  }
  // The clean room performs no Zephyr Cloud deploy, so ZE_CI_TOKEN is absent
  // and the generated build never engages Zephyr (it stays a registered but
  // inactive plugin). This tests "builds without a Zephyr Cloud account".
  return env;
}

function createAcceptanceWorkspaceEnv(
  runtimeEnv,
  { mode, release, registryEnv = {} } = {},
) {
  const env = { ...runtimeEnv, pnpm_config_pm_on_fail: 'ignore' };
  // Commands merge their environment with process.env again. Undefined values
  // remove inherited overrides so the generated workspace owns its policy.
  for (const name of new Set([
    ...Object.keys(process.env),
    ...Object.keys(runtimeEnv),
  ])) {
    const configName = name.replace(/[-_]/gu, '').toLowerCase();
    if (
      /^(?:npm|pnpm)config(?:minimumreleaseage|trustpolicy)/u.test(configName)
    ) {
      env[name] = undefined;
    }
  }
  // Unsigned local candidates cannot have npm Trusted Publishing provenance
  // before publication. Only their verified source cohort is exempt; published
  // acceptance retains the ordinary consumer trust policy.
  if (mode === 'source') {
    if (!Array.isArray(release?.packages) || release.packages.length === 0) {
      throw new Error(
        'Source candidate trust requires the authenticated release cohort',
      );
    }
    const selectors = release.packages
      .map(item => {
        if (
          item?.version !== release.release?.version ||
          !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(
            item?.targetName ?? '',
          ) ||
          !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
            item?.version ?? '',
          )
        ) {
          throw new Error(
            'Source candidate trust requires exact authenticated target names and versions',
          );
        }
        return `${item.targetName}@${item.version}`;
      })
      .sort();
    if (new Set(selectors).size !== selectors.length) {
      throw new Error(
        'Source candidate trust cohort contains duplicate selectors',
      );
    }
    let provided;
    try {
      provided = JSON.parse(registryEnv.PNPM_CONFIG_TRUST_POLICY_EXCLUDE);
    } catch {
      throw new Error(
        'Source candidate trust requires exact registry-provided cohort selectors',
      );
    }
    if (JSON.stringify(provided) !== JSON.stringify(selectors)) {
      throw new Error(
        'Source candidate trust exclusions must equal the exact authenticated release cohort',
      );
    }
    env.pnpm_config_trust_policy_exclude = JSON.stringify(
      [...selectors, ...authenticatedCompilerTrustExclusions(release)].sort(),
    );
  }
  return env;
}

function roundDurationMs(value) {
  return Math.round(value * 100) / 100;
}

export {
  acceptancePackageManagerRoot,
  createAcceptancePackageManagerEnv,
  createAcceptanceWorkspaceEnv,
  createCleanPnpmDlxEnv,
  roundDurationMs,
  run,
  runAsync,
};
