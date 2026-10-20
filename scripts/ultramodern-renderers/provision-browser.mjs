import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Chromium CL 8508456 fixes completed no-store fetches being reported aborted.
// Keep this exact CfT build until the normal Playwright revision contains it.
export const rendererBrowserVersion = '157.0.8103.6';
const supportedPlatforms = new Set([
  'linux',
  'mac',
  'mac_arm',
  'win32',
  'win64',
]);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Resolve through declared owners, including a strict external pnpm store. */
export function rendererBrowserTools(ownerRoot) {
  const owner = fs.realpathSync(ownerRoot);
  const manifestPath = path.join(owner, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const name of ['puppeteer', 'playwright'])
    assert(
      manifest.dependencies?.[name] || manifest.devDependencies?.[name],
      `${owner} must declare ${name}`,
    );
  const request = createRequire(manifestPath);
  const puppeteerManifest = request.resolve('puppeteer/package.json');
  const puppeteer = JSON.parse(fs.readFileSync(puppeteerManifest, 'utf8'));
  assert.equal(puppeteer.name, 'puppeteer');
  assert(puppeteer.dependencies?.['@puppeteer/browsers']);
  return {
    browsers: createRequire(puppeteerManifest)('@puppeteer/browsers'),
    chromium: request('playwright').chromium,
  };
}

/** Allow only this downloaded Chrome to create its normal Linux sandbox. */
export function configureHostedRendererSandbox(
  executable,
  {
    environment = process.env,
    platform = process.platform,
    command = execFileSync,
  } = {},
) {
  if (
    platform !== 'linux' ||
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    return;
  const temporaryRoot = fs.realpathSync(environment.RUNNER_TEMP);
  const binary = fs.realpathSync(executable);
  const relative = path.relative(temporaryRoot, binary);
  assert(
    relative &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    'Hosted renderer sandbox executable must belong to the job temporary directory',
  );
  // AppArmor treats these as policy syntax even inside a quoted attachment.
  assert(!/[\\"\r\n*?[\]{}@]/u.test(binary), 'Unsafe AppArmor executable path');
  const profile = path.join(path.dirname(binary), 'renderer-chrome.apparmor');
  fs.writeFileSync(
    profile,
    `abi <abi/4.0>,\ninclude <tunables/global>\nprofile ultramodern-renderer-chrome-${process.pid} "${binary}" flags=(unconfined) {\n  userns,\n}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  try {
    // Ubuntu 24.04 restricts user namespaces for downloaded CfT executables.
    // Keep the browser sandbox and grant only this exact binary its namespace.
    command('sudo', ['-n', 'apparmor_parser', '--replace', profile], {
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(profile);
  }
}

/** The job owns its cache; browser downloads never run as install side effects. */
export async function provisionRendererBrowser(
  { ownerRoot = path.join(root, 'tests'), environment = process.env } = {},
  {
    resolveTools = rendererBrowserTools,
    configureSandbox = configureHostedRendererSandbox,
  } = {},
) {
  assert(
    typeof environment.RUNNER_TEMP === 'string' &&
      path.isAbsolute(environment.RUNNER_TEMP),
    'RUNNER_TEMP must name the actual job temporary directory',
  );
  const temporaryRoot = fs.realpathSync(environment.RUNNER_TEMP);
  const { browsers, chromium } = resolveTools(ownerRoot);
  const platform = browsers.detectBrowserPlatform();
  assert(
    supportedPlatforms.has(platform),
    `Unsupported CfT platform: ${platform}`,
  );
  const cacheDir = path.join(
    temporaryRoot,
    `renderer-chrome-${rendererBrowserVersion}-${platform}`,
  );
  fs.mkdirSync(cacheDir, { recursive: true });
  assert(
    !fs.lstatSync(cacheDir).isSymbolicLink() &&
      fs.statSync(cacheDir).isDirectory(),
    'Renderer browser cache must be a real job-owned directory',
  );
  const options = {
    browser: browsers.Browser.CHROME,
    buildId: rendererBrowserVersion,
    platform,
    cacheDir,
    // The existing Playwright provisioner installs Linux system libraries.
    // This API's installDeps requires root, unlike Playwright's sudo support.
    installDeps: false,
  };
  const installed = await browsers.install(options);
  const expected = browsers.computeExecutablePath(options);
  assert.equal(path.resolve(installed.executablePath), path.resolve(expected));
  assert(
    fs.statSync(expected).isFile(),
    `Browser was not installed: ${expected}`,
  );
  configureSandbox(expected, { environment });
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: expected,
      chromiumSandbox: true,
    });
    assert.equal(
      browser.version(),
      rendererBrowserVersion,
      'The installed renderer browser must match the fixed exact build',
    );
  } finally {
    await browser?.close();
  }
  return {
    executable_path: expected,
    browser_version: rendererBrowserVersion,
    browser_platform: platform,
  };
}

export function writeRendererBrowserOutputs(outputs, filename) {
  assert(
    filename,
    'GITHUB_OUTPUT is required to hand the exact browser to acceptance',
  );
  for (const [name, value] of Object.entries(outputs)) {
    assert(!/[\r\n]/u.test(value), `${name} must be one line`);
    fs.appendFileSync(filename, `${name}=${value}\n`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  provisionRendererBrowser()
    .then(outputs =>
      writeRendererBrowserOutputs(outputs, process.env.GITHUB_OUTPUT),
    )
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
