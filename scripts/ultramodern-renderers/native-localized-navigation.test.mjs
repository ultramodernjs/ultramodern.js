import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  observeLocalizedNavigationErrors,
  settleLocalizedNavigation,
} from '../../tests/ultramodern-renderers/i18n/navigation-browser.mjs';
import { rendererAcceptanceRegistryUrl } from './feature-gates.mjs';
import {
  localizedNavigationBrowserRequest,
  localizedNavigationChecks,
  localizedNavigationInputs,
  localizedNavigationRegistry,
  runLocalizedNavigationCommand,
  verifyLocalizedNavigationCore,
  verifyLocalizedNavigationResult,
} from './native-localized-navigation.mjs';

function proof() {
  // Fabricated verifier controls never execute or qualify a real browser.
  const expected = {
    nonce: 'fresh-operation',
    binding: { sourceRevision: 'a'.repeat(40) },
    mode: 'published',
    registryUrl: 'https://registry.npmjs.org/',
    expectedNativeTuples: Object.fromEntries(
      ['solid', 'octane'].map(renderer => [
        renderer,
        {
          routerCore: { name: '@tanstack/router-core', version: '1.171.37' },
          history: { name: '@tanstack/history', version: '1.162.5' },
        },
      ]),
    ),
  };
  return {
    expected,
    result: {
      schemaVersion: 1,
      nonce: expected.nonce,
      binding: structuredClone(expected.binding),
      mode: expected.mode,
      registryUrl: expected.registryUrl,
      renderers: Object.fromEntries(
        ['solid', 'octane'].map(renderer => [
          renderer,
          {
            strictGeneratedTypes: true,
            nativeTuple: structuredClone(
              expected.expectedNativeTuples[renderer],
            ),
            checks: Object.fromEntries(
              localizedNavigationChecks.map(check => [check, true]),
            ),
          },
        ]),
      ),
    },
  };
}

test('accepts both independently completed strict native navigation consumers', () => {
  const { result, expected } = proof();
  assert.deepEqual(verifyLocalizedNavigationResult(result, expected), {
    solidNavigation: true,
    octaneNavigation: true,
    strictGeneratedTypes: true,
    acceptedNativeTuples: true,
    nativeMasks: true,
    blockers: true,
    documentLifetime: true,
  });
});
for (const renderer of ['solid', 'octane']) {
  for (const check of localizedNavigationChecks)
    test(`rejects ${renderer} without executed ${check}`, () => {
      const { result, expected } = proof();
      delete result.renderers[renderer].checks[check];
      assert.throws(
        () => verifyLocalizedNavigationResult(result, expected),
        new RegExp(`${renderer} did not execute ${check}`, 'u'),
      );
    });
  test(`rejects missing ${renderer} browser and failed strict types`, () => {
    const { result, expected } = proof();
    result.renderers[renderer].strictGeneratedTypes = false;
    assert.throws(
      () => verifyLocalizedNavigationResult(result, expected),
      /strict generated types did not pass/u,
    );
    delete result.renderers[renderer];
    assert.throws(
      () => verifyLocalizedNavigationResult(result, expected),
      /deep-equal/u,
    );
  });
  test(`rejects ${renderer} on a stale native tuple`, () => {
    const { result, expected } = proof();
    result.renderers[renderer].nativeTuple.routerCore.version = '1.171.15';
    assert.throws(
      () => verifyLocalizedNavigationResult(result, expected),
      /1\.171\.15/u,
    );
  });
}
for (const [name, change] of Object.entries({
  'source replay as published': result => {
    result.mode = 'source';
  },
  'source registry as published': result => {
    result.registryUrl = 'http://127.0.0.1:4873/';
  },
  'another operation': result => {
    result.nonce = 'old-operation';
  },
  'another cohort': result => {
    result.binding.sourceRevision = 'b'.repeat(40);
  },
}))
  test(`rejects ${name}`, () => {
    const { result, expected } = proof();
    change(result);
    assert.throws(
      () => verifyLocalizedNavigationResult(result, expected),
      /equal/u,
    );
  });

test('derives distinct Solid and Octane tuples from verified packed requests and exact archive bytes', t => {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run filesystem controls through owned-temp-dir',
  );
  const directory = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR),
      'navigation-input-controls-',
    ),
  );
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const manifest = {
    name: '@bleedingdev/modern-js-renderer-octane',
    ultramodern: {
      sourceName: '@modern-js/renderer-octane',
      nativeArtifacts: {},
    },
    devDependencies: {},
    peerDependencies: {},
  };
  const nativeInputs = {};
  for (const [name, basename] of Object.entries({
    octane: 'octane',
    '@octanejs/tanstack-router': 'octanejs-tanstack-router',
    '@octanejs/rspack-plugin': 'octanejs-rspack-plugin',
    '@tanstack/router-core': 'tanstack-router-core',
  })) {
    const source = path.join(directory, basename);
    fs.mkdirSync(path.join(source, 'package'), { recursive: true });
    fs.writeFileSync(
      path.join(source, 'package/package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(name === '@tanstack/router-core'
          ? { dependencies: { '@tanstack/history': '1.2.3' } }
          : {}),
        ...(name === '@octanejs/tanstack-router'
          ? { peerDependencies: { '@tanstack/router-core': '1.0.0' } }
          : {}),
      }),
    );
    const archivePath = path.join(directory, `${basename}.tgz`);
    execFileSync('tar', ['-czf', archivePath, '-C', source, 'package'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const repository = name === '@tanstack/router-core' ? 'router' : 'octane';
    const tag =
      name === '@tanstack/router-core'
        ? 'ultramodern-router-core-bbbbbbbbbbbb'
        : 'ultramodern-octane-aaaaaaaaaaaa';
    const request = `https://github.com/BleedingDev/${repository}/releases/download/${tag}/${basename}-1.0.0.tgz`;
    const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(archivePath)).digest('base64')}`;
    manifest.ultramodern.nativeArtifacts[name] = {
      request,
      integrity,
      version: '1.0.0',
    };
    manifest.devDependencies[name] = request;
    manifest.peerDependencies[name] = '1.0.0';
    nativeInputs[name] = { request, integrity, archivePath };
  }
  const solid = {
    sourceName: '@modern-js/renderer-solid',
    packageJson: {
      dependencies: {
        '@tanstack/router-core': '1.171.37',
        '@tanstack/history': '1.162.5',
      },
    },
  };
  const release = {
    packages: [
      solid,
      {
        sourceName: '@modern-js/renderer-octane',
        targetName: manifest.name,
        packageJson: manifest,
      },
    ],
  };
  const tuples = localizedNavigationInputs(
    release,
    nativeInputs,
  ).expectedNativeTuples;
  assert.equal(tuples.octane.routerCore.version, '1.0.0');
  assert.equal(tuples.octane.history.version, '1.2.3');
  assert.equal(tuples.solid.routerCore.version, '1.171.37');
  solid.packageJson.dependencies['@tanstack/router-core'] = '1.0.0';
  const registrySelection = localizedNavigationInputs(release, nativeInputs);
  assert.equal(
    registrySelection.solidUsesNativeCore,
    false,
    'Equal versions retain separate request identities',
  );
  assert.equal(
    registrySelection.expectedNativeTuples.solid.routerCore.version,
    registrySelection.expectedNativeTuples.octane.routerCore.version,
  );
  const coreDirectory = path.join(directory, 'tanstack-router-core/package');
  verifyLocalizedNavigationCore(
    coreDirectory,
    nativeInputs['@tanstack/router-core'],
    true,
  );
  assert.throws(
    () =>
      verifyLocalizedNavigationCore(
        coreDirectory,
        nativeInputs['@tanstack/router-core'],
        false,
      ),
    /unexpectedly contains the fork archive bytes/u,
  );
  const coreManifest = path.join(coreDirectory, 'package.json');
  const registryCore = JSON.parse(fs.readFileSync(coreManifest, 'utf8'));
  fs.writeFileSync(
    coreManifest,
    JSON.stringify({
      ...registryCore,
      description: 'same-version registry control',
    }),
  );
  verifyLocalizedNavigationCore(
    coreDirectory,
    nativeInputs['@tanstack/router-core'],
    false,
  );
  assert.throws(
    () =>
      verifyLocalizedNavigationCore(
        coreDirectory,
        nativeInputs['@tanstack/router-core'],
        true,
      ),
    /differs from its tarball/u,
  );
  solid.packageJson.dependencies['@tanstack/router-core'] =
    nativeInputs['@tanstack/router-core'].request;
  assert.equal(
    localizedNavigationInputs(release, nativeInputs).solidUsesNativeCore,
    true,
  );
  assert.equal(
    localizedNavigationInputs(release, nativeInputs).expectedNativeTuples.solid
      .routerCore.version,
    '1.0.0',
  );
  assert.throws(
    () => localizedNavigationInputs(release, {}),
    /requires authenticated native input octane/u,
  );
  fs.appendFileSync(nativeInputs.octane.archivePath, 'changed bytes');
  assert.throws(
    () => localizedNavigationInputs(release, nativeInputs),
    /equal/u,
  );
});

function controlDirectory(t) {
  const directory = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR),
      'navigation-runtime-controls-',
    ),
  );
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return directory;
}

test('source registry uses the actual ephemeral URL without changing inherited npm defaults or userconfig', t => {
  const directory = controlDirectory(t);
  const userconfig = path.join(directory, 'npmrc');
  const registryUrl = 'http://127.0.0.1:56789/';
  fs.writeFileSync(
    userconfig,
    `registry=https://registry.npmjs.org/\n@bleedingdev:registry=${registryUrl}\n//127.0.0.1:56789/:_authToken=unit-control\n`,
  );
  const environment = {
    npm_config_registry: 'https://registry.npmjs.org/',
    pnpm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: userconfig,
  };
  assert.equal(
    rendererAcceptanceRegistryUrl('source', {
      sourceRegistry: { registryUrl },
      publishedRegistryUrl: environment.npm_config_registry,
    }),
    registryUrl,
  );
  const selected = localizedNavigationRegistry(
    'source',
    registryUrl,
    environment,
    'bleedingdev',
  );
  assert.equal(selected.registryUrl, registryUrl);
  assert.deepEqual({ ...environment, ...selected.env }, environment);
  assert.throws(
    () =>
      localizedNavigationRegistry(
        'source',
        'http://127.0.0.1:56788/',
        environment,
        'bleedingdev',
      ),
    /selects another cohort registry/u,
  );
  assert.throws(
    () => localizedNavigationRegistry('source', registryUrl, {}, 'bleedingdev'),
    /inherited registry userconfig/u,
  );
});

test('published registry selects the normalized configured URL and rejects source loopback selection', () => {
  assert.equal(
    rendererAcceptanceRegistryUrl('published', {
      sourceRegistry: { registryUrl: 'http://127.0.0.1:56789/' },
      publishedRegistryUrl: 'https://registry.npmjs.org',
    }),
    'https://registry.npmjs.org/',
  );
  assert.deepEqual(
    localizedNavigationRegistry(
      'published',
      'https://registry.npmjs.org',
      {},
      'bleedingdev',
    ),
    {
      registryUrl: 'https://registry.npmjs.org/',
      env: {
        npm_config_registry: 'https://registry.npmjs.org/',
        pnpm_config_registry: 'https://registry.npmjs.org/',
      },
    },
  );
  assert.throws(
    () =>
      rendererAcceptanceRegistryUrl('published', {
        publishedRegistryUrl: 'http://127.0.0.1:56789/',
      }),
    /cannot use a loopback source registry/u,
  );
  assert.throws(
    () =>
      rendererAcceptanceRegistryUrl('source', {
        sourceRegistry: { registryUrl: 'https://registry.npmjs.org/' },
      }),
    /requires its loopback ephemeral registry/u,
  );
});

test('a failed child command and failed retirement preserve the original failure first', async t => {
  const directory = controlDirectory(t);
  const witness = path.join(directory, 'process.json');
  fs.writeFileSync(witness, JSON.stringify({ pid: 42 }));
  const original = new Error('original navigation assertion failed');
  const cleanup = new Error('process retirement failed');
  let retired = 0;
  await assert.rejects(
    runLocalizedNavigationCommand(
      'control',
      [],
      { witness, log: path.join(directory, 'missing.log') },
      {
        run: async () => {
          throw original;
        },
        retire: async actual => {
          assert.deepEqual(actual, { pid: 42 });
          retired++;
          throw cleanup;
        },
      },
    ),
    error =>
      error instanceof AggregateError &&
      error.errors[0] === original &&
      error.errors[1] === cleanup,
  );
  assert.equal(retired, 1);
});

test('successful retirement retains the exact original command error', async t => {
  const directory = controlDirectory(t);
  const witness = path.join(directory, 'process.json');
  fs.writeFileSync(witness, '{}');
  const original = new Error('original navigation assertion failed');
  await assert.rejects(
    runLocalizedNavigationCommand(
      'control',
      [],
      { witness, log: path.join(directory, 'missing.log') },
      {
        run: async () => {
          throw original;
        },
        retire: async () => {},
      },
    ),
    error => error === original,
  );
});

for (const [event, value, message] of [
  ['pageerror', new Error('runtime failure'), /runtime failure/u],
  [
    'console',
    { type: () => 'error', text: () => 'hydration failure' },
    /hydration failure/u,
  ],
  [
    'requestfailed',
    {
      url: () => 'https://foreign.invalid/resource',
      failure: () => ({ errorText: 'network failure' }),
    },
    /network failure/u,
  ],
  [
    'response',
    { url: () => 'http://127.0.0.1:56789/chunk.js', status: () => 503 },
    /HTTP 503/u,
  ],
])
  test(`navigation observes ${event} and releases all error listeners`, () => {
    const page = new EventEmitter();
    const observer = observeLocalizedNavigationErrors(
      page,
      'http://127.0.0.1:56789',
    );
    page.emit(event, value);
    assert.throws(observer.assertClean, message);
    observer.stop();
    for (const observed of [
      'pageerror',
      'console',
      'requestfailed',
      'response',
    ])
      assert.equal(page.listenerCount(observed), 0);
  });

test('navigation permits nonerror console output and unrelated-origin HTTP responses', () => {
  const page = new EventEmitter();
  const observer = observeLocalizedNavigationErrors(
    page,
    'http://127.0.0.1:56789',
  );
  page.emit('console', { type: () => 'warn', text: () => 'ordinary warning' });
  page.emit('response', {
    url: () => 'http://127.0.0.1:56789/chunk.js',
    status: () => 200,
  });
  page.emit('response', {
    url: () => 'https://foreign.invalid/resource',
    status: () => 503,
  });
  observer.assertClean();
  observer.stop();
});

for (const host of [
  'localhost',
  'source.localhost',
  '127.12.34.56',
  '[::1]',
  '[::ffff:127.0.0.1]',
  'localhost.',
  '127.0.0.1.',
])
  test(`published navigation rejects loopback registry ${host}`, () => {
    assert.throws(
      () =>
        rendererAcceptanceRegistryUrl('published', {
          publishedRegistryUrl: `http://${host}:56789/`,
        }),
      /cannot use a loopback source registry/u,
    );
  });

test('navigation Puppeteer comes from its declared test owner despite another hoisted copy', t => {
  const directory = controlDirectory(t);
  const owner = path.join(directory, 'workspace/tests');
  fs.mkdirSync(path.join(owner, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(owner, 'package.json'),
    JSON.stringify({
      name: 'browser-owner',
      devDependencies: { puppeteer: '1.0.0' },
    }),
  );
  const packageCopy = (label, target) => {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'package.json'),
      JSON.stringify({
        name: 'puppeteer',
        version: '1.0.0',
        main: 'index.cjs',
      }),
    );
    fs.writeFileSync(
      path.join(target, 'index.cjs'),
      `module.exports = { control: '${label}' };\n`,
    );
  };
  const correct = path.join(directory, 'external-store/puppeteer-correct');
  packageCopy('declared-test-owner', correct);
  packageCopy(
    'unrelated-hoisted-copy',
    path.join(directory, 'workspace/node_modules/puppeteer'),
  );
  fs.symlinkSync(correct, path.join(owner, 'node_modules/puppeteer'), 'dir');
  const alias = path.join(directory, 'owner-alias');
  fs.symlinkSync(owner, alias, 'dir');
  assert.equal(
    localizedNavigationBrowserRequest(alias)('puppeteer').control,
    'declared-test-owner',
  );
  fs.unlinkSync(path.join(owner, 'node_modules/puppeteer'));
  assert.throws(() => localizedNavigationBrowserRequest(alias), {
    code: 'ENOENT',
  });
  const core = path.join(directory, 'playwright-core');
  fs.mkdirSync(core);
  fs.writeFileSync(
    path.join(core, 'package.json'),
    JSON.stringify({ name: 'playwright-core' }),
  );
  assert.throws(
    () => localizedNavigationBrowserRequest(core),
    /must declare Puppeteer/u,
  );
});

test('intentional document replacement waits for the native item and completed requests', async () => {
  const calls = [];
  const ready = Promise.withResolvers();
  const page = {
    waitForFunction: async (predicate, options, item) => {
      assert.equal(typeof predicate, 'function');
      assert.deepEqual(options, {});
      assert.equal(item, 'blue');
      calls.push('native-item');
      await ready.promise;
    },
    waitForNetworkIdle: async options => {
      calls.push('requests-complete');
      assert.deepEqual(options, { idleTime: 500 });
    },
  };
  const settled = settleLocalizedNavigation(page, { item: 'blue' });
  await Promise.resolve();
  assert.deepEqual(calls, ['native-item']);
  ready.resolve();
  await settled;
  assert.deepEqual(calls, ['native-item', 'requests-complete']);
});

test('intentional document replacement waits for the native about view before idle', async () => {
  const calls = [];
  await settleLocalizedNavigation({
    waitForSelector: async selector => {
      assert.equal(selector, '[data-testid="navigation-about"]');
      calls.push('about-view');
    },
    waitForNetworkIdle: async () => {
      calls.push('requests-complete');
    },
  });
  assert.deepEqual(calls, ['about-view', 'requests-complete']);
});

test('unexpected aborted requests still fail navigation acceptance', () => {
  const page = new EventEmitter();
  const observer = observeLocalizedNavigationErrors(
    page,
    'http://127.0.0.1:56789',
  );
  page.emit('requestfailed', {
    url: () => 'http://127.0.0.1:56789/item-data',
    failure: () => ({ errorText: 'net::ERR_ABORTED' }),
  });
  assert.throws(observer.assertClean, /net::ERR_ABORTED/u);
  observer.stop();
});
