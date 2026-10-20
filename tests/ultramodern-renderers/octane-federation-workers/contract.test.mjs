import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { reservePort } from '../../../scripts/ultramodern-production-readiness/renderer-mf-lifecycle-proof/runtime.mjs';
import { readInstalledPackageFiles } from '../../../scripts/ultramodern-renderers/installed-cohort.mjs';
import {
  readWorkerFederationProvider,
  startWorkerFederationRuntime,
  verifyWorkerFederationModule,
  workerFederationOptions,
} from '../../../scripts/ultramodern-renderers/native-federation-workers.mjs';
import {
  createOctaneWorkerFederationFixtures,
  createWorkerFederationFaultHandler,
  workerFederationFaultSource,
} from './fixtures.mjs';
import {
  isSharedCounterCompilation,
  openWorkerFixtureBrowser,
  readWorkerFixturePlan,
  verifyWorkerCompositionRoutes,
} from './proof.mjs';
import { sourceWorkerGitignore } from './source.mjs';

for (const inspectionFails of [false, true]) {
  test(`Worker composition failure diagnostics retain the original assertion and cleanup (inspectionFails=${inspectionFails})`, async t => {
    const original = new Error('Original SSR CSS assertion failure');
    const listeners = new Map();
    const cleanup = [];
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    const remote = {
      tagName: 'SECTION',
      className: '',
      dataset: {
        appId: 'host',
        owner: 'host',
        language: 'cs',
        matchParams: 'p'.repeat(1024),
        unrelated: 'Do not capture arbitrary dataset values',
      },
      querySelector: () => ({ textContent: 'remote greeting' }),
    };
    const host = {
      dataset: { appId: 'host', language: 'en', matchParams: '{}' },
      querySelector: () => ({ textContent: 'host greeting' }),
    };
    const browserGlobals = {
      location: { href: 'http://127.0.0.1:9999/en' },
      document: {
        readyState: 'complete',
        querySelector: selector =>
          selector === '[data-host-context]' ? host : remote,
        querySelectorAll: () => [],
      },
      performance: { getEntriesByType: () => [] },
      getComputedStyle: () => ({ borderTopColor: 'rgb(0, 0, 0)' }),
    };
    const page = {
      setDefaultTimeout(value) {
        assert.equal(value, 15_000);
      },
      on(name, handler) {
        listeners.set(name, handler);
      },
      async route() {},
      async goto() {
        listeners.get('console')({
          type: () => 'error',
          text: () => 'e'.repeat(1024),
        });
        for (let index = 0; index < 30; index++) {
          const request = { resourceType: () => 'stylesheet' };
          listeners.get('response')({
            request: () => request,
            url: () => `http://127.0.0.1/remote-${index}.css`,
            status: () => 404,
          });
        }
        listeners.get('requestfailed')({
          url: () => 'http://127.0.0.1/remote.css',
          resourceType: () => 'stylesheet',
          failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
        });
        return { status: () => 200 };
      },
      locator() {
        return {
          async waitFor() {},
          async count() {
            return 1;
          },
        };
      },
      async waitForFunction() {
        throw original;
      },
      async evaluate(callback, argument) {
        if (inspectionFails) throw new Error('Browser inspection unavailable');
        return runInNewContext(`(${callback.toString()})(argument)`, {
          ...browserGlobals,
          argument,
        });
      },
      async unrouteAll(options) {
        cleanup.push(['unroute', options]);
      },
      async close() {
        cleanup.push(['close']);
      },
    };
    const expected = {
      remote: 'remote-a',
      expose: './Widget',
      selector: '[data-worker-remote="a"]',
      contextSelector: '[data-host-context]',
    };
    await assert.rejects(
      verifyWorkerCompositionRoutes(
        {
          async newPage() {
            return page;
          },
        },
        'http://127.0.0.1:9999',
        [{ path: '/en', expected: [expected] }],
        'host',
      ),
      error => error === original,
    );
    assert.deepEqual(cleanup, [['unroute', { behavior: 'wait' }], ['close']]);
    assert.equal(logs.length, 1);
    const detail = JSON.parse(logs[0][1]);
    assert.equal(logs[0][0], 'Worker composition failure diagnostic:');
    assert.equal(detail.route, '/en');
    assert.deepEqual(detail.expected, expected);
    assert.equal(detail.phase, 'SSR stylesheet application');
    assert.equal(detail.resourceEvents.length, 24);
    assert.equal(detail.resourceEvents[0].url, 'http://127.0.0.1/remote-6.css');
    assert.equal(detail.requestFailures[0].error, 'net::ERR_CONNECTION_RESET');
    assert.equal(detail.errors[0].length, 512);
    if (inspectionFails)
      assert.match(
        detail.browser.inspectionError,
        /Browser inspection unavailable/,
      );
    else {
      assert.equal(
        detail.browser.observed.style.borderTopColor,
        'rgb(0, 0, 0)',
      );
      assert.equal(detail.browser.context.remote.language, 'cs');
      assert.equal(detail.browser.context.host.language, 'en');
      assert.equal(detail.browser.context.remote.greeting, 'remote greeting');
      assert.equal(detail.browser.context.host.greeting, 'host greeting');
      assert.equal(detail.browser.context.remote.matchParams.length, 512);
      assert.equal(detail.browser.context.remote.unrelated, undefined);
    }
  });
}

for (const failurePhase of ['context', 'final errors']) {
  test(`Worker diagnostics report bounded context only during its actual wait (${failurePhase})`, async t => {
    const original = new Error('Original client context mismatch');
    const logs = [];
    const cleanup = [];
    const listeners = new Map();
    t.mock.method(console, 'error', (...args) => logs.push(args));
    const expected = {
      remote: 'remote-a',
      expose: './Widget',
      selector: '[data-worker-remote="a"]',
      contextSelector: '[data-host-context]',
    };
    const canonical = {
      pathname: '/en',
      publicHref: '/en',
      language: 'en',
      greeting: 'g'.repeat(1024),
    };
    const match = {
      id: 'i'.repeat(1024),
      routeId: '/',
      params: 'p'.repeat(1024),
      search: 's'.repeat(1024),
      current: 'true',
      unrelated: 'Do not log arbitrary match fields',
    };
    const appId = 'a'.repeat(1024);
    const observation = {
      id: 'a',
      appId,
      owner: 'host',
      ...canonical,
      match,
      border: 'rgb(13, 117, 83)',
      host: { appId, ...canonical, match },
    };
    let waits = 0;
    const page = {
      setDefaultTimeout(value) {
        assert.equal(value, 15_000);
      },
      on(name, listener) {
        listeners.set(name, listener);
      },
      async route() {},
      async goto() {
        if (failurePhase === 'final errors')
          listeners.get('pageerror')(new Error('Late browser error'));
        return { status: () => 200 };
      },
      locator() {
        return {
          async waitFor() {},
          async count() {
            return 1;
          },
          async evaluate() {
            return observation;
          },
          async textContent() {
            return 'SSR text';
          },
          locator() {
            return {
              first() {
                return { async fill() {} };
              },
            };
          },
        };
      },
      async waitForFunction(_predicate, argument) {
        waits++;
        if (waits === 2) assert.deepEqual(argument, ['a']);
        if (waits === 3) {
          // The predicate still receives the full original values.
          assert.equal(argument.canonical.greeting.length, 1024);
          assert.equal(argument.retainedMatch.params.length, 1024);
          if (failurePhase === 'context') throw original;
        }
      },
      async evaluate(_predicate, argument) {
        return argument ? { inspected: true } : true;
      },
      async unrouteAll() {
        cleanup.push('unroute');
      },
      async close() {
        cleanup.push('close');
      },
    };
    await assert.rejects(
      verifyWorkerCompositionRoutes(
        {
          async newPage() {
            return page;
          },
        },
        'http://127.0.0.1:9999',
        [{ path: '/en', context: canonical, expected: [expected] }],
        appId,
      ),
      error =>
        failurePhase === 'context'
          ? error === original
          : error.code === 'ERR_ASSERTION' &&
            error.actual[0] === 'Late browser error',
    );
    assert.equal(waits, 3);
    assert.deepEqual(cleanup, ['unroute', 'close']);
    assert.equal(logs.length, 1);
    const detail = JSON.parse(logs[0][1]);
    if (failurePhase === 'context') {
      assert.equal(detail.phase, 'browser context adoption');
      assert.deepEqual(detail.expected, expected);
      assert.equal(detail.context.appId.length, 512);
      assert.equal(detail.context.canonical.greeting.length, 512);
      assert.equal(detail.context.retainedMatch.unrelated, undefined);
      for (const name of ['id', 'params', 'search'])
        assert.equal(detail.context.retainedMatch[name].length, 512);
    } else {
      assert.equal(detail.phase, 'browser error assertions');
      assert.equal(detail.expected, null);
      assert.equal(detail.context, undefined);
    }
  });
}

test('compiled Counter resources resolve from the application to the same physical source', t => {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'worker-counter-'),
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'verticals/remote-a');
  const sharedRoot = path.join(root, 'shared');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(sharedRoot);
  const sharedCounter = path.join(sharedRoot, 'Counter.tsx');
  fs.writeFileSync(sharedCounter, 'export default () => 3;\n');
  const source = {
    resource: '../../shared/Counter.tsx',
    transformKind: 'compile',
  };
  assert.equal(
    isSharedCounterCompilation(source, appRoot, sharedCounter),
    true,
  );
  const workspacePackages = path.join(appRoot, 'node_modules/@authored-worker');
  fs.mkdirSync(workspacePackages, { recursive: true });
  fs.symlinkSync(sharedRoot, path.join(workspacePackages, 'shared-counter'));
  assert.equal(
    isSharedCounterCompilation(
      {
        ...source,
        resource: 'node_modules/@authored-worker/shared-counter/Counter.tsx',
      },
      appRoot,
      sharedCounter,
    ),
    true,
  );
  fs.copyFileSync(sharedCounter, path.join(appRoot, 'Counter.tsx'));
  for (const candidate of [
    { ...source, resource: 'Counter.tsx' },
    { ...source, resource: '../shared/Counter.tsx' },
    { ...source, resource: '../../shared/missing.tsx' },
    { ...source, resource: '../../shared/Counter.tsx?facade' },
    { ...source, transformKind: 'slots' },
    { ...source, transformKind: 'client-only-stub' },
  ])
    assert.equal(
      isSharedCounterCompilation(candidate, appRoot, sharedCounter),
      false,
      JSON.stringify(candidate),
    );
  assert.throws(
    () =>
      isSharedCounterCompilation(
        { ...source, resource: sharedCounter },
        appRoot,
        sharedCounter,
      ),
    /relative to the actual application/u,
  );
});

test('authored source ignores temporary compiler configs while retaining source changes', t => {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'worker-git-source-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith('GIT_'),
    ),
  );
  const git = args =>
    execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(root, '.gitignore'), sourceWorkerGitignore);
  const temporary = [
    'apps/host/.modern-js/tsgo/tsconfig.host.json',
    'verticals/remote-a/.modern-js/tsgo/tsconfig.remote-a.json',
    'verticals/remote-b/.modern-js/tsgo/tsconfig.58fde6bbfd.json',
  ];
  const authored = [
    'apps/host/src/routes/index.tsx',
    'verticals/remote-b/src/components/Widget.tsx',
    'shared/Counter.tsx',
    'topology/reference-topology.json',
    'verticals/remote-b/.modern-js/authored.json',
  ];
  for (const relative of [...temporary, ...authored]) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, '{}\n');
  }
  assert.deepEqual(
    git(['check-ignore', '--no-index', ...temporary])
      .trim()
      .split('\n'),
    temporary,
  );
  const changes = git(['status', '--porcelain', '--untracked-files=all']);
  for (const relative of temporary) assert(!changes.includes(relative));
  for (const relative of authored) assert(changes.includes(`?? ${relative}\n`));
});

function fixtures(t) {
  const root = fs.mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'octane-worker-contract-',
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const applications = ['host', 'remote-a', 'remote-b'].map(name => {
    const outputRoot = path.join(root, name, '.output');
    for (const directory of ['server', 'worker', 'public'])
      fs.mkdirSync(path.join(outputRoot, directory), { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'server/index.mjs'),
      'export default {};',
    );
    fs.writeFileSync(
      path.join(outputRoot, 'worker/entry.mjs'),
      'export default {};',
    );
    return {
      outputRoot,
      wrangler: {
        name,
        main: 'server/index.mjs',
        compatibility_date: '2026-10-07',
        compatibility_flags: [],
        assets: { binding: 'ASSETS', directory: 'public' },
        vars: { appId: name },
        services:
          name === 'host'
            ? [
                { binding: 'REMOTE_A', service: 'remote-a' },
                { binding: 'REMOTE_B', service: 'remote-b' },
              ]
            : [],
      },
    };
  });
  return { root, applications };
}

test('emitted names, resources, variables and two service bindings stay intact', t => {
  const { applications } = fixtures(t);
  const workers = workerFederationOptions(applications);
  assert.deepEqual(
    workers.map(worker => worker.name),
    ['host', 'remote-a', 'remote-b'],
  );
  assert.deepEqual(workers[0].serviceBindings, {
    REMOTE_A: 'remote-a',
    REMOTE_B: 'remote-b',
  });
  assert.deepEqual(workers[0].bindings, { appId: 'host' });
  assert.equal(workers[0].modulesRoot, applications[0].outputRoot);
  assert.equal(workers[0].modules.length, 2);
  assert.equal(workers[0].assets.binding, 'ASSETS');
});

test('an undeployed remote, duplicate binding or duplicate Worker name fails closed', t => {
  const { applications } = fixtures(t);
  applications[0].wrangler.services[0].service = 'foreign-worker';
  assert.throws(
    () => workerFederationOptions(applications),
    /Missing deployed Worker/,
  );
  applications[0].wrangler.services[0].service = 'remote-a';
  applications[0].wrangler.services[1].binding = 'REMOTE_A';
  assert.throws(
    () => workerFederationOptions(applications),
    /Duplicate Worker binding/,
  );
  applications[1].wrangler.name = 'host';
  assert.throws(
    () => workerFederationOptions(applications),
    /Worker names must be unique/,
  );
});

test('every emitted binding name is retained, including __proto__, with duplicates rejected', t => {
  const { applications } = fixtures(t);
  applications[0].wrangler.services[0].binding = '__proto__';
  const bindings = workerFederationOptions(applications)[0].serviceBindings;
  assert.equal(Object.getPrototypeOf(bindings), Object.prototype);
  assert(Object.hasOwn(bindings, '__proto__'));
  assert.equal(
    Object.getOwnPropertyDescriptor(bindings, '__proto__').value,
    'remote-a',
  );
  applications[0].wrangler.services[1].binding = '__proto__';
  assert.throws(
    () => workerFederationOptions(applications),
    /Duplicate Worker binding/,
  );
});

test('ordinary fixtures retain public generator identity and share one native signal source', () => {
  const descriptor = (id, directory, container) => ({
    id,
    directory,
    renderer: 'octane',
    moduleFederationName: container,
    packageName: `@worker-proof/${id}`,
    exposes: {
      './Widget': './src/components/widget.tsx',
      './Route': './src/federation-entry.tsx',
    },
    manifest: {
      name: `@worker-proof/${id}`,
      version: '1.0.0',
      modernjs: {
        appId: id,
        topology: '../../topology/reference-topology.json',
      },
      dependencies: { preserved: '1.2.3' },
    },
  });
  const host = descriptor(
    'shell-super-app',
    'apps/shell-super-app',
    'shellSuperApp',
  );
  const remotes = [
    descriptor('remote-a', 'verticals/remote-a', 'verticalRemoteA'),
    descriptor('remote-b', 'verticals/remote-b', 'verticalRemoteB'),
  ];
  const dependencies = Object.fromEntries(
    [
      '@modern-js/ultramodern-app-tools',
      '@modern-js/renderer-octane',
      '@modern-js/renderer-core',
      '@modern-js/i18n-runtime-extensions',
      '@tsrx/oxc',
      'octane',
      'i18next',
    ].map(name => [name, '1.0.0']),
  );
  const options = {
    host,
    remotes,
    dependencies,
    remoteOrigins: ['http://127.0.0.1:41001', 'http://127.0.0.1:41002'],
    services: [{ binding: 'REMOTE_A' }, { binding: 'REMOTE_B' }],
    remoteServices: { 'remote-a': [{ binding: 'REMOTE_B' }] },
  };
  assert.throws(
    () =>
      createOctaneWorkerFederationFixtures({
        ...options,
        remoteServices: undefined,
      }),
    /ordinary Worker service binding/,
  );
  const fixture = createOctaneWorkerFederationFixtures(options);
  assert.equal(fixture.routes[0].path, '/en/');
  assert.equal(fixture.routes[0].context.pathname, '/');
  assert.equal(fixture.routes[0].context.publicHref, '/en');
  const presetFixture = createOctaneWorkerFederationFixtures({
    ...options,
    hostServiceSource: 'topology',
  });
  const packageFixture = createOctaneWorkerFederationFixtures({
    ...options,
    sharedCounterPackage: '@authored-worker/shared-counter',
    dependencies: {
      ...dependencies,
      '@authored-worker/shared-counter': 'workspace:*',
    },
  });
  assert.equal(
    packageFixture.shared['Counter.tsx'],
    fixture.shared['Counter.tsx'],
  );
  for (const { app, files } of packageFixture.applications) {
    const source =
      files[
        app === host ? 'src/components/Shell.tsx' : 'src/components/widget.tsx'
      ];
    assert.match(
      source,
      /import Counter from '@authored-worker\/shared-counter'/u,
    );
    assert.equal(
      JSON.parse(files['package.json']).dependencies[
        '@authored-worker/shared-counter'
      ],
      'workspace:*',
    );
    assert.deepEqual(JSON.parse(files['tsconfig.json']).include, [
      'src',
      '*.config.ts',
      'node_modules/.modern-js',
    ]);
    assert.equal(
      Object.keys(files).filter(name => name.endsWith('Counter.tsx')).length,
      0,
    );
  }
  assert.throws(
    () =>
      createOctaneWorkerFederationFixtures({
        ...options,
        sharedCounterPackage: '@authored-worker/shared-counter',
      }),
    /workspace:\*/u,
  );
  assert.doesNotMatch(
    presetFixture.applications[0].files['modern.config.ts'],
    /"services":/u,
  );
  assert.match(
    presetFixture.applications[1].files['modern.config.ts'],
    /"services":\[\{"binding":"REMOTE_B"\}\]/u,
  );
  assert.match(
    fixture.applications[0].files['modern.config.ts'],
    /"services":/u,
  );
  assert.match(fixture.shared['Counter.tsx'], /signal\$\(3\)/);
  for (const { app, files } of fixture.applications) {
    const manifest = JSON.parse(files['package.json']);
    assert.equal(manifest.name, app.packageName);
    assert.equal(manifest.version, app.manifest.version);
    assert.deepEqual(manifest.modernjs, app.manifest.modernjs);
    assert.equal(manifest.dependencies.preserved, '1.2.3');
    assert.match(files['modern.config.ts'], /plugins: \[i18nPlugin\(/);
    assert.deepEqual(JSON.parse(files['locales/en/translation.json']), {
      greeting: app === host ? 'Hello from host' : `Hello from ${app.id}`,
    });
    assert.deepEqual(JSON.parse(files['locales/cs/translation.json']), {
      greeting: app === host ? 'Ahoj od hostitele' : `Ahoj od ${app.id}`,
    });
    assert.doesNotMatch(
      files['src/routes/layout.tsx'],
      /I18nProvider|createInstance|register/,
    );
    assert.match(files['modern.config.ts'], /presetUltramodernWorkspace/);
    assert.match(files['modern.config.ts'], /deployTarget: 'cloudflare'/);
    assert(files['modern.config.ts'].includes(JSON.stringify(app.id)));
    const source =
      app === host
        ? files['src/components/Shell.tsx']
        : files['src/components/widget.tsx'];
    assert.match(
      source,
      /import Counter from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/Counter'/,
    );
    if (app !== host) {
      assert.match(source, /useRouterState/);
      assert.match(source, /useMatch\(\{ strict: false/);
      assert.match(
        source,
        /data-match-current=\{matches.includes\(match.id\)\}/,
      );
      assert(
        files['module-federation.config.ts'].includes(app.moduleFederationName),
      );
    }
    assert.equal(
      Object.keys(files).filter(filename => filename.endsWith('Counter.tsx'))
        .length,
      0,
    );
  }
  const firstRemote = fixture.applications[1].files;
  assert.match(
    firstRemote['modern.config.ts'],
    /"services":\[\{"binding":"REMOTE_B"\}\]/,
  );
  assert.match(
    firstRemote['module-federation.config.ts'],
    /verticalRemoteB@http:\/\/127\.0\.0\.1:41002\/mf-manifest\.json/,
  );
  assert.match(
    firstRemote['src/components/widget.tsx'],
    /federatedComponent<RemoteProps>\("remote-b\/Widget"/,
  );
  assert.match(
    fixture.applications[0].files['src/routes/nested/page.tsx'],
    /nested=\{true\}/,
  );
  assert.deepEqual(fixture.hops, [
    {
      from: remotes[0].id,
      to: remotes[1].id,
      expose: './Widget',
      selector: '[data-worker-remote="b-hop"]',
      routes: ['/en/nested', '/cs/nested'],
    },
  ]);
  assert.deepEqual(
    fixture.routes.map(route => route.context.language),
    ['en', 'en', 'cs'],
  );
  assert.equal(fixture.routes[2].expected.length, 4);
});

test('a named fault Worker forwards through a real target binding without editing deployment files', t => {
  const { root, applications } = fixtures(t);
  const scriptPath = path.join(root, 'fault-worker.mjs');
  fs.writeFileSync(scriptPath, workerFederationFaultSource);
  const workers = workerFederationOptions(applications, {
    faults: [
      {
        name: 'fault-a',
        host: 'host',
        binding: 'REMOTE_A',
        target: 'remote-a',
        scriptPath,
      },
    ],
  });
  assert.equal(workers[0].serviceBindings.REMOTE_A, 'fault-a');
  assert.equal(workers[0].serviceBindings.REMOTE_B, 'remote-b');
  assert.deepEqual(workers[3].serviceBindings, { TARGET: 'remote-a' });
  assert.equal(workers[3].modules[0].path, scriptPath);
  assert.equal(applications[0].wrangler.services[0].service, 'remote-a');
  assert.equal(
    fs.readFileSync(
      path.join(applications[1].outputRoot, 'server/index.mjs'),
      'utf8',
    ),
    'export default {};',
  );
});

async function faultMode(handler, mode) {
  const response = await handler.fetch(
    new Request('https://fault.invalid/__proof/control', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
    {},
  );
  assert.equal(response.status, 200);
  return response.json();
}

test('the fault Worker pass mode preserves the native Request and Response objects', async () => {
  const handler = createWorkerFederationFaultHandler();
  const request = new Request('https://remote.invalid/native', {
    method: 'POST',
    body: 'opaque native bytes',
  });
  const response = new Response('untouched native response', { status: 202 });
  assert.equal(
    await handler.fetch(request, {
      TARGET: {
        async fetch(value) {
          assert.equal(value, request);
          return response;
        },
      },
    }),
    response,
  );
});

test('native failure diagnostics preserve the original Response and report bounded status and body', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const handler = createWorkerFederationFaultHandler();
  const jobs = [];
  const original = new Response('Native context admission rejected', {
    status: 400,
    headers: { 'x-native': 'preserved' },
  });
  const response = await handler.fetch(
    new Request('https://remote.invalid/_mf/widget'),
    { TARGET: { fetch: async () => original } },
    { waitUntil: job => jobs.push(job) },
  );
  assert.equal(response, original);
  assert.equal(response.bodyUsed, false);
  assert.equal(response.headers.get('x-native'), 'preserved');
  assert.equal(await response.text(), 'Native context admission rejected');
  await Promise.all(jobs);
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0][1]), {
    method: 'GET',
    path: '/_mf/widget',
    status: 400,
    body: 'Native context admission rejected',
    truncated: false,
  });
});

test('native failure diagnostics truncate at 1024 bytes without truncating the original Response', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const handler = createWorkerFederationFaultHandler();
  const jobs = [];
  const body = 'x'.repeat(4096);
  const original = new Response(body, { status: 400 });
  const response = await handler.fetch(
    new Request('https://remote.invalid/_mf/widget'),
    { TARGET: { fetch: async () => original } },
    { waitUntil: job => jobs.push(job) },
  );
  assert.equal(response, original);
  assert.equal(await response.text(), body);
  await Promise.all(jobs);
  const diagnostic = JSON.parse(logs[0][1]);
  assert.equal(diagnostic.body, body.slice(0, 1024));
  assert.equal(diagnostic.truncated, true);
});

for (const stop of ['abort', 'budget']) {
  test(`native failure diagnostics release a never-yielding reader on ${stop}`, {
    timeout: 1000,
  }, async t => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    const handler = createWorkerFederationFaultHandler();
    const jobs = [];
    const controller = new AbortController();
    let canceled = 0;
    const original = new Response(
      new ReadableStream({
        cancel() {
          canceled++;
          return new Promise(() => {});
        },
      }),
      { status: 400 },
    );
    const response = await handler.fetch(
      new Request('https://remote.invalid/_mf/widget', {
        signal: controller.signal,
      }),
      { TARGET: { fetch: async () => original } },
      { waitUntil: job => jobs.push(job) },
    );
    assert.equal(response, original);
    assert.equal(response.bodyUsed, false);
    if (stop === 'abort')
      controller.abort(new Error('Owned diagnostic request stopped'));
    await Promise.all(jobs);
    const diagnostic = JSON.parse(logs[0][1]);
    assert.match(
      diagnostic.interrupted,
      stop === 'abort'
        ? /Owned diagnostic request stopped/
        : /Diagnostic read budget exceeded/,
    );
    assert.equal(diagnostic.body, '');
    // A tee cancels its underlying body once both owners have canceled. The
    // diagnostic owner must already have canceled without awaiting this body.
    void response.body.cancel().catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(canceled, 1);
  });
}

test('a snapshot 503 keeps manifest forwarding healthy and recovers in the same fault Worker', async () => {
  const handler = createWorkerFederationFaultHandler();
  let forwards = 0;
  const env = {
    TARGET: {
      async fetch() {
        forwards++;
        return new Response('native');
      },
    },
  };
  await faultMode(handler, 'unavailable');
  assert.equal(
    (await handler.fetch(new Request('https://remote.invalid/manifest'), env))
      .status,
    200,
  );
  assert.equal(
    (
      await handler.fetch(
        new Request('https://remote.invalid/native', { method: 'POST' }),
        env,
      )
    ).status,
    503,
  );
  assert.equal(forwards, 1);
  await faultMode(handler, 'pass');
  assert.equal(
    await (
      await handler.fetch(
        new Request('https://remote.invalid/native', { method: 'POST' }),
        env,
      )
    ).text(),
    'native',
  );
  assert.equal(forwards, 2);
});

test('header and full-body hangs release their request lease once on cancellation', async () => {
  for (const mode of ['headers-hang', 'body-hang']) {
    const handler = createWorkerFederationFaultHandler();
    await faultMode(handler, mode);
    const controller = new AbortController();
    const request = new Request('https://remote.invalid/native', {
      method: 'POST',
      signal: controller.signal,
    });
    const env = {
      TARGET: {
        async fetch() {
          return new Response('native body prefix');
        },
      },
    };
    const pending = handler.fetch(request, env);
    if (mode === 'headers-hang') {
      const failure = assert.rejects(pending, /owned request ended/);
      controller.abort(new Error('owned request ended'));
      await failure;
    } else {
      const response = await pending;
      const reader = response.body.getReader();
      assert.equal(
        new TextDecoder().decode((await reader.read()).value),
        'native body prefix',
      );
      const failure = assert.rejects(reader.read(), /owned request ended/);
      controller.abort(new Error('owned request ended'));
      await failure;
    }
    controller.abort();
    const state = await faultMode(handler, 'pass');
    assert.equal(state.active, 0);
    assert.equal(state.cancellations, 1);
  }
});

test('foreign request admission changes only the test authority and retains opaque native bytes', async () => {
  const handler = createWorkerFederationFaultHandler();
  await faultMode(handler, 'foreign-request-authority');
  const opaque = '{"native":"renderer-owned bytes"}';
  const envelope = {
    authority: { origin: 'https://remote.invalid' },
    payload: opaque,
  };
  await handler.fetch(
    new Request('https://remote.invalid/native', {
      method: 'POST',
      body: JSON.stringify(envelope),
    }),
    {
      TARGET: {
        async fetch(request) {
          const received = await request.json();
          assert.equal(received.authority.origin, 'https://foreign.invalid');
          assert.equal(received.payload, opaque);
          return new Response('rejected before expose', { status: 400 });
        },
      },
    },
  );
});

test('native identity faults preserve unrelated request fields', async () => {
  for (const mode of [
    'foreign-native-publisher',
    'foreign-native-abi',
    'foreign-native-document',
    'foreign-native-boundary',
  ]) {
    const handler = createWorkerFederationFaultHandler();
    await faultMode(handler, mode);
    const native = {
      authority: { publisherBuildId: 'actual-publisher', runtimeABI: 1 },
      documentId: 'actual-document',
      boundaryId: 'actual-boundary',
      props: ['opaque-native-props'],
    };
    const expected = structuredClone(native);
    if (mode === 'foreign-native-publisher')
      expected.authority.publisherBuildId = 'foreign-publisher';
    else if (mode === 'foreign-native-abi') expected.authority.runtimeABI = 2;
    else if (mode === 'foreign-native-document')
      expected.documentId = 'foreign-document';
    else expected.boundaryId = 'foreign-boundary';
    const envelope = {
      authority: { origin: 'https://remote.invalid' },
      payload: JSON.stringify(native),
    };
    const response = await handler.fetch(
      new Request('https://remote.invalid/native', {
        method: 'POST',
        body: JSON.stringify(envelope),
      }),
      {
        TARGET: {
          async fetch(request) {
            const received = await request.json();
            assert.deepEqual(received.authority, envelope.authority);
            assert.deepEqual(JSON.parse(received.payload), expected);
            return new Response('rejected', { status: 400 });
          },
        },
      },
    );
    assert.equal(response.status, 400);
    const evidence = await faultMode(handler, 'pass');
    assert.equal(evidence.requests[0].mutation, mode);
  }
});

test('packed public reader resolution authenticates the actual transitive owner before execution', t => {
  const { root } = fixtures(t);
  const directory = path.join(
    root,
    'node_modules/@modern-js/federation-runtime',
  );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: '@bleedingdev/modern-js-federation-runtime',
      version: '3.9.0-proof',
      exports: { './renderer-contract': './index.cjs' },
    }),
  );
  const filename = path.join(directory, 'index.cjs');
  fs.writeFileSync(
    filename,
    'throw new Error("must not execute before authentication");',
  );
  const artifact = {
    sourceName: '@modern-js/federation-runtime',
    targetName: '@bleedingdev/modern-js-federation-runtime',
    version: '3.9.0-proof',
    files: readInstalledPackageFiles(directory).map(file => ({
      path: file.path,
      size: file.byteLength,
      sha256: file.sha256,
    })),
  };
  const input = {
    request: createRequire(path.join(root, 'package.json')),
    specifier: '@modern-js/federation-runtime/renderer-contract',
    sourceName: artifact.sourceName,
    cohort: { artifacts: [artifact] },
    consumerRoot: root,
  };
  assert.equal(verifyWorkerFederationModule(input).directory, directory);
  fs.appendFileSync(filename, '\nthrow new Error("unpacked injected helper");');
  assert.throws(
    () => verifyWorkerFederationModule(input),
    /differs from its tarball/,
  );
});

test('missing output modules and output paths outside the deployment fail before execution', t => {
  const { root, applications } = fixtures(t);
  fs.unlinkSync(path.join(applications[1].outputRoot, 'server/index.mjs'));
  assert.throws(() => workerFederationOptions(applications));
  fs.writeFileSync(path.join(root, 'caller-owned.mjs'), 'export default {};');
  applications[1].wrangler.main = '../../caller-owned.mjs';
  assert.throws(
    () => workerFederationOptions(applications),
    /escape|outside|confined/i,
  );
  assert(fs.existsSync(path.join(root, 'caller-owned.mjs')));
});

function provider(Runtime) {
  return {
    Miniflare: Runtime,
    convertV4MiniflareOptions: options => options,
    Log: class {},
    LogLevel: { ERROR: 0 },
  };
}

test('failure immediately after runtime creation disposes it and preserves the failure', async t => {
  const { applications } = fixtures(t);
  const failure = new Error('workerd startup failed');
  let disposals = 0;
  class Runtime {
    ready = Promise.reject(failure);
    async dispose() {
      disposals++;
    }
  }
  await assert.rejects(
    startWorkerFederationRuntime({
      applications,
      provider: provider(Runtime),
      bridgeNames: [],
    }),
    error => error === failure,
  );
  assert.equal(disposals, 1);
});

test('an interrupted pending startup disposes its runtime without opening bridges', async t => {
  const { applications } = fixtures(t);
  const cancellation = new AbortController();
  let disposals = 0;
  class Runtime {
    ready = new Promise(() => {});
    async getWorker() {
      throw new Error('must not open a bridge');
    }
    async dispose() {
      disposals++;
    }
  }
  const pending = startWorkerFederationRuntime({
    applications,
    provider: provider(Runtime),
    bridgeNames: ['host'],
    signal: cancellation.signal,
  });
  const failure = new Error('proof interrupted');
  const rejected = assert.rejects(pending, error => error === failure);
  cancellation.abort(failure);
  await rejected;
  assert.equal(disposals, 1);
});

test('the proof plan preserves per-route owners and confines all compiled outputs to its owner', t => {
  const { root, applications } = fixtures(t);
  const plan = {
    schemaVersion: 1,
    mode: 'source',
    applications: applications.map(({ outputRoot, wrangler }, index) => {
      const appRoot = path.dirname(outputRoot);
      const buildRoot = path.join(appRoot, 'dist');
      const clientRoot = path.join(outputRoot, 'public');
      fs.mkdirSync(buildRoot);
      const wranglerPath = path.join(outputRoot, 'wrangler.json');
      const manifestPath = path.join(clientRoot, 'mf-manifest.json');
      fs.writeFileSync(wranglerPath, JSON.stringify(wrangler));
      fs.writeFileSync(manifestPath, '{}');
      return {
        role: index ? 'remote' : 'host',
        remote: index ? wrangler.name : undefined,
        appRoot,
        buildRoot,
        clientRoot,
        outputRoot,
        wranglerPath,
        manifestPath,
        origin: `http://127.0.0.1:${41000 + index}`,
      };
    }),
    routes: [
      {
        path: '/en/remotes/remote-a',
        context: {
          pathname: '/remotes/remote-a',
          publicHref: '/en/remotes/remote-a',
          language: 'en',
          greeting: 'Hello from host',
        },
        expected: [
          {
            remote: 'remote-a',
            expose: './Route',
            selector: '[data-owner="remote-a"]',
            contextSelector: '[data-worker-host]',
          },
        ],
      },
      ...['en', 'cs'].map(language => ({
        path: `/${language}/nested`,
        context: {
          pathname: '/nested',
          publicHref: `/${language}/nested`,
          language,
          greeting: language === 'en' ? 'Hello from host' : 'Ahoj od hostitele',
        },
        expected: [
          {
            remote: 'remote-b',
            expose: './Widget',
            selector: '[data-worker-remote="b-hop"]',
            contextSelector: '[data-host-nested]',
          },
        ],
      })),
    ],
    hops: [
      {
        from: 'remote-a',
        to: 'remote-b',
        expose: './Widget',
        selector: '[data-worker-remote="b-hop"]',
        routes: ['/en/nested', '/cs/nested'],
      },
    ],
  };
  // Keep a noncanonical request URL separate from the native rewrite output.
  plan.routes.push({
    path: '/en/',
    context: {
      pathname: '/',
      publicHref: '/en',
      language: 'en',
      greeting: 'Hello from host',
    },
    expected: plan.routes[0].expected,
  });
  const filename = path.join(root, 'plan.json');
  fs.writeFileSync(filename, JSON.stringify(plan));
  assert.deepEqual(readWorkerFixturePlan(filename, root).routes, plan.routes);
  const rootRoute = plan.routes.at(-1);
  for (const incorrectPublicHref of [
    '/en/',
    '/cs',
    'https://foreign.test/en',
  ]) {
    rootRoute.context.publicHref = incorrectPublicHref;
    fs.writeFileSync(filename, JSON.stringify(plan));
    assert.throws(
      () => readWorkerFixturePlan(filename, root),
      /explicit native router and i18n expectations/,
    );
  }
  rootRoute.context.publicHref = '/en';
  plan.routes[0].expected[0].contextSelector = '';
  fs.writeFileSync(filename, JSON.stringify(plan));
  assert.throws(
    () => readWorkerFixturePlan(filename, root),
    /nearest-match provider/,
  );
  plan.routes[0].expected[0].contextSelector = '[data-worker-host]';
  plan.hops[0].routes = ['/en/nested'];
  fs.writeFileSync(filename, JSON.stringify(plan));
  assert.throws(
    () => readWorkerFixturePlan(filename, root),
    /both declared languages/,
  );
  plan.hops[0].routes = ['/en/nested', '/cs/nested'];
  plan.applications[0].buildRoot = path.dirname(root);
  fs.writeFileSync(filename, JSON.stringify(plan));
  assert.throws(
    () => readWorkerFixturePlan(filename, root),
    /buildRoot escapes/,
  );
  assert(fs.existsSync(applications[0].outputRoot));
});

test('runtime cleanup is idempotent and preserves startup plus cleanup failures', async t => {
  const { applications } = fixtures(t);
  const startup = new Error('startup');
  const cleanup = new Error('cleanup');
  let disposals = 0;
  class Broken {
    ready = Promise.reject(startup);
    async dispose() {
      disposals++;
      throw cleanup;
    }
  }
  await assert.rejects(
    startWorkerFederationRuntime({
      applications,
      provider: provider(Broken),
      bridgeNames: [],
    }),
    error => {
      assert.equal(error.errors[0], startup);
      assert.equal(error.errors[1].errors[0], cleanup);
      return true;
    },
  );
  class Ready {
    ready = Promise.resolve();
    async dispose() {
      disposals++;
    }
  }
  const runtime = await startWorkerFederationRuntime({
    applications,
    provider: provider(Ready),
    bridgeNames: [],
  });
  const first = runtime.dispose();
  assert.equal(runtime.dispose(), first);
  await first;
  assert.equal(disposals, 2);
});

test('later Worker lookup failure retires earlier bridges and the runtime', async t => {
  const { applications } = fixtures(t);
  const failure = new Error('missing second Worker');
  let disposals = 0;
  class Runtime {
    ready = Promise.resolve();
    async getWorker(name) {
      if (name === 'remote-a') throw failure;
      return { fetch: () => Promise.resolve(new Response('host')) };
    }
    async dispose() {
      disposals++;
    }
  }
  await assert.rejects(
    startWorkerFederationRuntime({
      applications,
      provider: provider(Runtime),
      bridgeNames: ['host', 'remote-a'],
    }),
    error => error === failure,
  );
  assert.equal(disposals, 1);
});

test('Worker bridges use the reserved compiled origins and forward native bytes unchanged', async t => {
  const { applications } = fixtures(t);
  const bridgePorts = {};
  for (const name of ['host', 'remote-a', 'remote-b']) {
    bridgePorts[name] = await reservePort();
  }
  const requests = [];
  let disposals = 0;
  class Runtime {
    ready = Promise.resolve();
    async getWorker(name) {
      return {
        fetch: async (input, init) => {
          requests.push({
            name,
            input,
            bytes: Buffer.from(init.body).toString(),
          });
          return new Response(init.body, {
            headers: { 'x-native-worker': name },
          });
        },
      };
    }
    async dispose() {
      disposals++;
    }
  }
  const instance = await startWorkerFederationRuntime({
    applications,
    provider: provider(Runtime),
    bridgeNames: Object.keys(bridgePorts),
    bridgePorts,
  });
  t.after(() => instance.dispose());
  for (const [name, bridge] of instance.bridges) {
    assert.equal(bridge.url, `http://127.0.0.1:${bridgePorts[name]}`);
    const response = await fetch(`${bridge.url}/snapshot`, {
      method: 'POST',
      body: 'untouched native codec bytes',
    });
    assert.equal(response.headers.get('x-native-worker'), name);
    assert.equal(await response.text(), 'untouched native codec bytes');
  }
  assert.deepEqual(
    requests,
    Object.keys(bridgePorts).map(name => ({
      name,
      input: `https://${name}.invalid/snapshot`,
      bytes: 'untouched native codec bytes',
    })),
  );
  await instance.dispose();
  assert.equal(disposals, 1);
  for (const bridge of instance.bridges.values())
    await assert.rejects(fetch(bridge.url));
});

test('duplicate compiled origins fail before starting workerd', async t => {
  const { applications } = fixtures(t);
  class Runtime {
    constructor() {
      throw new Error('must not start');
    }
  }
  await assert.rejects(
    startWorkerFederationRuntime({
      applications,
      provider: provider(Runtime),
      bridgeNames: ['host', 'remote-a'],
      bridgePorts: { host: 43210, 'remote-a': 43210 },
    }),
    /Compiled Worker origins must be unique/,
  );
});

test('packed execution cannot silently fall back to a source generator', async t => {
  const { root } = fixtures(t);
  const generatorPackageRoot = path.join(root, 'generator');
  fs.mkdirSync(generatorPackageRoot);
  fs.writeFileSync(
    path.join(generatorPackageRoot, 'package.json'),
    JSON.stringify({ name: '@modern-js/ultramodern-create', version: '3.9.0' }),
  );
  await assert.rejects(
    readWorkerFederationProvider({
      mode: 'packed',
      generatorPackageRoot,
      consumerRoot: root,
    }),
    /authenticated public generator/,
  );
});

test('provider resolution rejects a changed Miniflare dependency pin before importing it', async t => {
  const { root } = fixtures(t);
  const generatorPackageRoot = path.join(root, 'generator');
  const miniflare = path.join(generatorPackageRoot, 'node_modules/miniflare');
  fs.mkdirSync(miniflare, { recursive: true });
  fs.writeFileSync(
    path.join(generatorPackageRoot, 'package.json'),
    JSON.stringify({
      name: '@modern-js/ultramodern-create',
      version: '3.9.0',
      dependencies: { miniflare: '5.0.0' },
    }),
  );
  fs.writeFileSync(
    path.join(miniflare, 'package.json'),
    JSON.stringify({ name: 'miniflare', version: '5.0.1', main: 'index.cjs' }),
  );
  fs.writeFileSync(
    path.join(miniflare, 'index.cjs'),
    'throw new Error("must not execute");',
  );
  await assert.rejects(
    readWorkerFederationProvider({
      mode: 'source',
      generatorPackageRoot,
      consumerRoot: root,
    }),
    error => {
      assert.equal(error.actual, '5.0.1');
      assert.equal(error.expected, '5.0.0');
      return true;
    },
  );
});

function workerBrowserControl({
  launchFailure,
  closeFailure,
  cleanupFailure,
  platform = 'linux',
} = {}) {
  const events = [];
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
    TMPDIR: '/long/feature/prebuilt-worker',
    KEEP: 'unchanged',
  };
  const browser = {
    async close() {
      events.push('close');
      if (closeFailure) throw closeFailure;
    },
  };
  const chromium = {
    async launch(options) {
      events.push(['launch', options]);
      if (launchFailure) throw launchFailure;
      return browser;
    },
  };
  const options = {
    env,
    platform,
    createTemporary(input) {
      events.push(['temporary', input]);
      return {
        env: {
          TMPDIR: '/job/b-ABCDEF',
          TMP: '/job/b-ABCDEF',
          TEMP: '/job/b-ABCDEF',
        },
        cleanup() {
          events.push('cleanup');
          if (cleanupFailure) throw cleanupFailure;
        },
      };
    },
  };
  return {
    events,
    env,
    browser,
    chromium,
    options,
    plan: {
      root: '/long/feature/prebuilt-worker',
      browserExecutable: '/fixed/chrome',
    },
  };
}

test('Worker browser uses the short witnessed hosted child environment and cleans it after close', async () => {
  const control = workerBrowserControl();
  const lifetime = await openWorkerFixtureBrowser(
    control.chromium,
    control.plan,
    control.options,
  );
  assert.equal(lifetime.browser, control.browser);
  assert.deepEqual(control.events[0], [
    'temporary',
    { workRoot: control.plan.root, env: control.env, platform: 'linux' },
  ]);
  assert.deepEqual(control.events[1], [
    'launch',
    {
      headless: true,
      executablePath: '/fixed/chrome',
      env: {
        ...control.env,
        TMPDIR: '/job/b-ABCDEF',
        TMP: '/job/b-ABCDEF',
        TEMP: '/job/b-ABCDEF',
      },
    },
  ]);
  assert.equal(control.env.TMPDIR, '/long/feature/prebuilt-worker');
  await lifetime.close();
  assert.deepEqual(control.events.slice(-2), ['close', 'cleanup']);
});

test('Worker browser preserves non-Linux launch behavior without a hosted lease', async () => {
  for (const platform of ['darwin', 'win32']) {
    const control = workerBrowserControl({ platform });
    const lifetime = await openWorkerFixtureBrowser(
      control.chromium,
      control.plan,
      control.options,
    );
    assert.deepEqual(control.events, [
      ['launch', { headless: true, executablePath: '/fixed/chrome' }],
    ]);
    await lifetime.close();
    assert.deepEqual(control.events.at(-1), 'close');
  }
});

test('Worker browser preserves startup failure and retires only its temporary child', async () => {
  const failure = new Error('launch failed');
  const control = workerBrowserControl({ launchFailure: failure });
  await assert.rejects(
    openWorkerFixtureBrowser(control.chromium, control.plan, control.options),
    error => error === failure,
  );
  assert.equal(control.events.at(-1), 'cleanup');
});

test('Worker browser retains temporary files when browser retirement fails', async () => {
  const failure = new Error('close failed');
  const control = workerBrowserControl({ closeFailure: failure });
  const lifetime = await openWorkerFixtureBrowser(
    control.chromium,
    control.plan,
    control.options,
  );
  await assert.rejects(lifetime.close(), error => error === failure);
  assert.equal(control.events.at(-1), 'close');
  assert.equal(control.events.includes('cleanup'), false);
});

test('Worker browser startup and cleanup failures retain the original error first', async () => {
  const failure = new Error('launch failed');
  const cleanupFailure = new Error('identity changed');
  const control = workerBrowserControl({
    launchFailure: failure,
    cleanupFailure,
  });
  await assert.rejects(
    openWorkerFixtureBrowser(control.chromium, control.plan, control.options),
    error => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, cleanupFailure]);
      return true;
    },
  );
});
