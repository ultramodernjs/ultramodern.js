#!/usr/bin/env node
// Consumer: publish-bleedingdev.yml ERP acceptance browser smoke.
//
// The smoke runtime is installed outside the workspace from the exact
// `browserSmokePlaywrightPackage` specifier, so this entry only supplies that
// runtime's directory and version. scripts/lib/browser-provisioning.js owns
// the cache key, the cache path and the install, exactly as for workspace
// runtimes.
//
// The browsers live in the runner's own Playwright registry directory, the
// path every other job restores `playwright-chromium-<version>-<os>` to, so
// this job hits the same cache entry. --resolve also exports that directory as
// PLAYWRIGHT_BROWSERS_PATH through GITHUB_ENV: the acceptance profile moves
// XDG_CACHE_HOME, so on Linux it needs the directory stated, and the install
// step, the cache restore and the acceptance profile all read one directory.
//
//   --resolve                  pure for an exact specifier: installs nothing
//   --install --version <v>    materializes the runtime, then installs browsers
import { parseArgs } from 'node:util';
import provisioning from '../lib/browser-provisioning.js';
import { ensureBrowserSmokeRuntime } from './published-create-proof/browser-smoke.mjs';
import { browserSmokePlaywrightPackage } from './published-create-proof/constants.mjs';

const exactPlaywrightSpec = /^playwright@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

// The registry directory is worked out with any PLAYWRIGHT_BROWSERS_PATH
// already in the environment ignored, so --install compares the exported path
// with the directory the cache step restores, not with itself.
const registryEnvironment = () => ({
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: '',
});

function resolveSmokeVersion() {
  const exact = exactPlaywrightSpec.exec(browserSmokePlaywrightPackage);
  return exact
    ? exact[1]
    : provisioning.resolvePlaywrightVersion(ensureBrowserSmokeRuntime());
}

try {
  const { values } = parseArgs({
    options: {
      install: { type: 'boolean' },
      resolve: { type: 'boolean' },
      version: { type: 'string' },
    },
    strict: true,
  });
  if (Boolean(values.install) === Boolean(values.resolve)) {
    throw new Error('Pass exactly one of --resolve or --install');
  }
  if (values.resolve) {
    if (values.version !== undefined) {
      throw new Error('--version applies only to --install');
    }
    const outputs = provisioning.resolveBrowserOutputs(
      resolveSmokeVersion(),
      registryEnvironment(),
    );
    provisioning.writeGithubEnv({
      PLAYWRIGHT_BROWSERS_PATH: outputs.cache_path,
    });
    provisioning.writeGithubOutputs(outputs);
  } else {
    if (values.version === undefined) {
      throw new Error(
        '--install requires --version <playwright version> from the matching --resolve step',
      );
    }
    const browsersPath = provisioning.browserCachePath({
      environment: registryEnvironment(),
    });
    if (process.env.PLAYWRIGHT_BROWSERS_PATH !== browsersPath) {
      throw new Error(
        `PLAYWRIGHT_BROWSERS_PATH is ${String(process.env.PLAYWRIGHT_BROWSERS_PATH)}, not the ${browsersPath} the browser cache restores. Run --resolve earlier in the same job; it exports the path through GITHUB_ENV.`,
      );
    }
    provisioning.installBrowsers({
      runtimeDirs: [ensureBrowserSmokeRuntime()],
      version: values.version,
    });
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
}
