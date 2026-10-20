import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  configureHostedRendererSandbox,
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
      {
        headless: true,
        executablePath: output.executable_path,
        chromiumSandbox: true,
      },
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

test('requires successful sandbox provisioning before the real launch', async t => {
  const root = directory(t);
  const supplied = tools(root);
  const failure = new Error('sandbox provisioning failed');
  let configured;
  await assert.rejects(
    provisionRendererBrowser(
      { environment: { RUNNER_TEMP: root } },
      {
        resolveTools: () => supplied.value,
        configureSandbox(executable) {
          configured = executable;
          throw failure;
        },
      },
    ),
    error => error === failure,
  );
  assert.equal(
    configured,
    path.join(
      root,
      `renderer-chrome-${rendererBrowserVersion}-linux`,
      'chrome-control',
    ),
  );
  assert.equal(supplied.calls.installs.length, 1);
  assert.equal(supplied.calls.launches.length, 0);
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

function hostedSandbox(t) {
  const root = directory(t);
  const binary = path.join(root, 'chrome');
  fs.writeFileSync(binary, 'fabricated executable');
  const environment = {
    RUNNER_TEMP: root,
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
  };
  return { root, binary, environment };
}

test('allows user namespaces only for the exact hosted Chrome and removes its policy source', t => {
  const { binary, environment } = hostedSandbox(t);
  const calls = [];
  configureHostedRendererSandbox(binary, {
    environment,
    platform: 'linux',
    command(name, args, options) {
      calls.push({ name, args, options });
      assert.equal(name, 'sudo');
      assert.deepEqual(args.slice(0, 3), [
        '-n',
        'apparmor_parser',
        '--replace',
      ]);
      assert.equal(
        fs.readFileSync(args[3], 'utf8'),
        `abi <abi/4.0>,\ninclude <tunables/global>\nprofile ultramodern-renderer-chrome-${process.pid} "${binary}" flags=(unconfined) {\n  userns,\n}\n`,
      );
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(calls[0].args[3]), false);
});

test('sandbox provisioning fails closed and retires its own policy source', t => {
  const { binary, environment } = hostedSandbox(t);
  const failure = new Error('AppArmor rejected profile');
  assert.throws(
    () =>
      configureHostedRendererSandbox(binary, {
        environment,
        platform: 'linux',
        command() {
          throw failure;
        },
      }),
    error => error === failure,
  );
  assert.equal(
    fs.existsSync(path.join(path.dirname(binary), 'renderer-chrome.apparmor')),
    false,
  );
});

test('does not change sandbox policy outside a GitHub-hosted Linux job', t => {
  const { binary, environment } = hostedSandbox(t);
  for (const options of [
    { platform: 'darwin', environment },
    { platform: 'win32', environment },
    {
      platform: 'linux',
      environment: { ...environment, RUNNER_ENVIRONMENT: 'self-hosted' },
    },
    {
      platform: 'linux',
      environment: { ...environment, GITHUB_ACTIONS: 'false' },
    },
  ])
    configureHostedRendererSandbox(binary, {
      ...options,
      command() {
        assert.fail('must not configure this host');
      },
    });
});

test('rejects a foreign binary and AppArmor glob syntax before privilege elevation', t => {
  const { root, binary, environment } = hostedSandbox(t);
  const foreignRoot = directory(t);
  const foreignBinary = path.join(foreignRoot, 'chrome');
  fs.writeFileSync(foreignBinary, 'foreign executable');
  const globBinary = path.join(root, 'chrome*');
  fs.writeFileSync(globBinary, 'glob executable');
  for (const executable of [foreignBinary, globBinary])
    assert.throws(
      () =>
        configureHostedRendererSandbox(executable, {
          environment,
          platform: 'linux',
          command() {
            assert.fail('must reject before sudo');
          },
        }),
      /job temporary directory|Unsafe AppArmor/u,
    );
  assert.equal(fs.existsSync(binary), true);
});
