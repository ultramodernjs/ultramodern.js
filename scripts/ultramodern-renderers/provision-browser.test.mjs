import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  provisionRendererBrowser,
  rendererBrowserTools,
  rendererBrowserVersion,
  writeRendererBrowserOutputs,
} from './provision-browser.mjs';

// These controls use fabricated modules and bytes, never a real browser download.
assert(
  process.env.OWNED_TEMP_DIR,
  'Run filesystem controls through owned-temp-dir',
);
function directory(t) {
  const root = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR),
      'renderer-browser-control-',
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function tools(
  root,
  {
    platform = 'linux',
    version = rendererBrowserVersion,
    wrongPath = false,
  } = {},
) {
  const calls = { installs: [], launches: [], closes: 0 };
  const executable = options => path.join(options.cacheDir, 'chrome-control');
  return {
    calls,
    value: {
      browsers: {
        Browser: { CHROME: 'chrome' },
        detectBrowserPlatform: () => platform,
        computeExecutablePath: executable,
        install: async options => {
          calls.installs.push(options);
          const executablePath = executable(options);
          fs.writeFileSync(executablePath, 'fabricated control, not a browser');
          return {
            executablePath: wrongPath
              ? path.join(root, 'other')
              : executablePath,
          };
        },
      },
      chromium: {
        launch: async options => {
          calls.launches.push(options);
          return {
            version: () => version,
            close: async () => {
              calls.closes++;
            },
          };
        },
      },
    },
  };
}

for (const platform of ['linux', 'mac', 'mac_arm', 'win64'])
  test(`pins the fixed official Chrome build and launches the installed executable on ${platform}`, async t => {
    const root = directory(t);
    const supplied = tools(root, { platform });
    const output = await provisionRendererBrowser(
      { environment: { RUNNER_TEMP: root } },
      { resolveTools: () => supplied.value },
    );
    assert.equal(rendererBrowserVersion, '157.0.8103.6');
    assert.deepEqual(supplied.calls.installs, [
      {
        browser: 'chrome',
        buildId: '157.0.8103.6',
        platform,
        cacheDir: path.join(root, `renderer-chrome-157.0.8103.6-${platform}`),
        installDeps: false,
      },
    ]);
    assert.deepEqual(supplied.calls.launches, [
      { headless: true, executablePath: output.executable_path },
    ]);
    assert.equal(output.browser_version, '157.0.8103.6');
    assert.equal(output.browser_platform, platform);
    assert.equal(supplied.calls.closes, 1);
  });

test('rejects the affected browser build after launch and closes it', async t => {
  const root = directory(t);
  const supplied = tools(root, { version: '156.0.8078.4' });
  await assert.rejects(
    provisionRendererBrowser(
      { environment: { RUNNER_TEMP: root } },
      { resolveTools: () => supplied.value },
    ),
    /must match the fixed exact build/u,
  );
  assert.equal(supplied.calls.closes, 1);
});

test('rejects an unsupported platform before any browser installation', async t => {
  const root = directory(t);
  const supplied = tools(root, { platform: undefined });
  supplied.value.browsers.detectBrowserPlatform = () => undefined;
  await assert.rejects(
    provisionRendererBrowser(
      { environment: { RUNNER_TEMP: root } },
      { resolveTools: () => supplied.value },
    ),
    /Unsupported CfT platform/u,
  );
  assert.equal(supplied.calls.installs.length, 0);
});

test('rejects an unexpected installed path before launching it', async t => {
  const root = directory(t);
  const supplied = tools(root, { wrongPath: true });
  await assert.rejects(
    provisionRendererBrowser(
      { environment: { RUNNER_TEMP: root } },
      { resolveTools: () => supplied.value },
    ),
    { code: 'ERR_ASSERTION' },
  );
  assert.equal(supplied.calls.launches.length, 0);
});

test('never follows a browser-cache symlink outside the job directory', async t => {
  const root = directory(t);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(
    elsewhere,
    path.join(root, 'renderer-chrome-157.0.8103.6-linux'),
    'dir',
  );
  const supplied = tools(root);
  await assert.rejects(
    provisionRendererBrowser(
      { environment: { RUNNER_TEMP: root } },
      { resolveTools: () => supplied.value },
    ),
    /real job-owned directory/u,
  );
  assert.equal(supplied.calls.installs.length, 0);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('resolves the browser installer through Puppeteer rather than a hoisted different copy', t => {
  const root = directory(t);
  const owner = path.join(root, 'owner');
  const puppeteer = path.join(root, 'external/puppeteer');
  const browser = path.join(puppeteer, 'node_modules/@puppeteer/browsers');
  const wrong = path.join(owner, 'node_modules/@puppeteer/browsers');
  const playwright = path.join(owner, 'node_modules/playwright');
  const writePackage = (directory, manifest, code = 'module.exports = {};') => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ main: 'index.cjs', ...manifest }),
    );
    fs.writeFileSync(path.join(directory, 'index.cjs'), code);
  };
  writePackage(owner, {
    devDependencies: { puppeteer: '25.14.0', playwright: '1.64.1' },
  });
  writePackage(puppeteer, {
    name: 'puppeteer',
    dependencies: { '@puppeteer/browsers': '3.2.5' },
  });
  writePackage(
    browser,
    { name: '@puppeteer/browsers' },
    "module.exports = { control: 'declared installer' };",
  );
  writePackage(
    wrong,
    { name: '@puppeteer/browsers' },
    "throw new Error('hoisted installer must not load');",
  );
  writePackage(
    playwright,
    { name: 'playwright' },
    "module.exports = { chromium: { control: 'declared driver' } };",
  );
  fs.symlinkSync(puppeteer, path.join(owner, 'node_modules/puppeteer'), 'dir');
  const resolved = rendererBrowserTools(owner);
  assert.equal(resolved.browsers.control, 'declared installer');
  assert.equal(resolved.chromium.control, 'declared driver');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(owner, 'package.json'), 'utf8'),
  );
  delete manifest.devDependencies.puppeteer;
  fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify(manifest));
  assert.throws(() => rendererBrowserTools(owner), /must declare puppeteer/u);
});

test('writes the exact executable output and rejects multiline paths', t => {
  const root = directory(t);
  const output = path.join(root, 'github-output');
  writeRendererBrowserOutputs(
    {
      executable_path: '/control/chrome with spaces',
      browser_version: rendererBrowserVersion,
    },
    output,
  );
  assert.equal(
    fs.readFileSync(output, 'utf8'),
    'executable_path=/control/chrome with spaces\nbrowser_version=157.0.8103.6\n',
  );
  assert.throws(
    () =>
      writeRendererBrowserOutputs(
        { executable_path: '/control/chrome\ninjected=value' },
        output,
      ),
    /one line/u,
  );
});
