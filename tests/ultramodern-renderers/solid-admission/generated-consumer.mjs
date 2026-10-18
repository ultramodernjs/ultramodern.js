import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseSync } from '@babel/core';
import tsgoInvocation from '../../../scripts/lib/tsgo-invocation.js';
import {
  checkInstalledCohort,
  readCohort,
} from '../../../scripts/ultramodern-renderers/installed-cohort.mjs';
import {
  installedBin,
  verifyPackedNativeFederationDependencies,
} from '../../../scripts/ultramodern-renderers/native-federation-packed.mjs';
import { checkSolidBundleModules } from './generated-bundle.mjs';
import { installCancellationDiagnostics } from './generated-cancellation-diagnostics.mjs';
import {
  observeDeferredLoaderNetwork,
  probeRawDeferredLoader,
} from './generated-network-diagnostics.mjs';
import { createSolidConsumerObserver } from './generated-observer.mjs';
import { createRequestDiagnostics } from './generated-request-diagnostics.mjs';
import { createAdmissionProcessScope } from './processes.mjs';

const target = '2.0.0-rc.15';
const sourceExtensions = /\.[cm]?tsx?$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function installedCompiler(appRoot) {
  return tsgoInvocation.resolveTsgoBin({
    requireFrom: createRequire(path.join(appRoot, 'package.json')),
  });
}

async function listFiles(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    assert(
      !entry.isSymbolicLink(),
      `Consumer source is a symlink: ${filename}`,
    );
    if (entry.isDirectory()) files.push(...(await listFiles(filename)));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

export function nativeClientCall(source) {
  const ast = parseSync(source, {
    filename: 'entry.ts',
    configFile: false,
    babelrc: false,
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
  });
  const imports = ast.program.body.filter(
    node =>
      node.type === 'ImportDeclaration' &&
      node.source.value === '@modern-js/renderer-solid/entry-client',
  );
  const names = imports.flatMap(node =>
    node.specifiers
      .filter(
        specifier =>
          specifier.type === 'ImportSpecifier' &&
          specifier.imported.name === 'startNativeClient',
      )
      .map(specifier => specifier.local.name),
  );
  const calls = ast.program.body.filter(
    node =>
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      node.expression.callee.type === 'Identifier' &&
      names.includes(node.expression.callee.name),
  );
  if (!calls.length) return undefined;
  assert.equal(
    calls.length,
    1,
    'A generated browser entry must start one native client',
  );
  const options = calls[0].expression.arguments[0];
  assert.equal(options?.type, 'ObjectExpression');
  const identity = options.properties.find(
    property => property.key?.name === 'identity',
  )?.value;
  assert.equal(identity?.type, 'ObjectExpression');
  return Object.fromEntries(
    identity.properties.map(property => {
      assert.equal(property.type, 'ObjectProperty');
      assert(['StringLiteral', 'NumericLiteral'].includes(property.value.type));
      return [property.key.name ?? property.key.value, property.value.value];
    }),
  );
}

/** Require the actual browser entry selected by the completed native build. */
export async function generatedBrowserEntries(appRoot) {
  const build = JSON.parse(
    await fs.readFile(path.join(appRoot, 'dist/renderer-build.json'), 'utf8'),
  );
  assert.equal(build.schema, 'ultramodern-renderer-build');
  assert.equal(build.version, 2);
  assert.equal(build.renderer, 'solid');
  const directory = path.join(appRoot, 'node_modules/.modern-js/solid');
  const files = (await listFiles(directory)).filter(file =>
    sourceExtensions.test(file),
  );
  const entries = [];
  for (const [entry, identity] of Object.entries(build.entries)) {
    const filename = path.join(directory, entry, 'index.ts');
    assert(
      files.includes(filename),
      `Build entry has no generated client: ${entry}`,
    );
    const actual = nativeClientCall(await fs.readFile(filename, 'utf8'));
    assert(
      actual,
      'Generated entry does not invoke its imported native client',
    );
    assert.deepEqual(
      actual,
      identity,
      'Generated entry and actual build identity differ',
    );
    const application = path.join(path.dirname(filename), 'app.client.ts');
    assert(
      files.includes(application),
      `Generated entry has no application: ${filename}`,
    );
    entries.push(filename, application);
  }
  assert(
    entries.length > 0,
    'The public build emitted no Solid client entries',
  );
  return [...new Set(entries)].sort();
}

export function cleanConsumerEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  return env;
}

/** No permissive base config or ambient Node globals enter the browser proof. */
export function strictBrowserConfig(files, environment) {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'preserve',
      jsxImportSource: '@solidjs/web',
      customConditions: ['solid', 'browser'],
      strict: true,
      skipLibCheck: false,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noEmit: true,
      types: [],
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    },
    files: [...files, environment],
  };
}

async function installedTuple(appRoot, cohort) {
  verifyPackedNativeFederationDependencies({
    appRoot,
    cohort,
    dependencyNames: [
      'solid-js',
      '@solidjs/web',
      '@solidjs/signals',
      '@solidjs/compiler',
    ],
    packageIdentities: Object.fromEntries(
      ['solid-js', '@solidjs/web', '@solidjs/signals', '@solidjs/compiler'].map(
        name => [name, { name, version: target }],
      ),
    ),
  });
  const requireApp = createRequire(path.join(appRoot, 'package.json'));
  const tuple = {};
  for (const name of [
    'solid-js',
    '@solidjs/web',
    '@solidjs/signals',
    '@solidjs/compiler',
  ]) {
    let directory = path.dirname(await fs.realpath(requireApp.resolve(name)));
    for (;;) {
      const manifest = await fs
        .readFile(path.join(directory, 'package.json'), 'utf8')
        .then(JSON.parse, error => {
          if (error.code !== 'ENOENT') throw error;
        });
      if (manifest?.name === name) {
        assert.equal(
          manifest.version,
          target,
          `Solid consumer tuple drift: ${name}`,
        );
        tuple[name] = manifest.version;
        break;
      }
      const parent = path.dirname(directory);
      assert.notEqual(parent, directory, `No installed identity for ${name}`);
      directory = parent;
    }
  }
  const renderer = createRequire(
    requireApp.resolve('@modern-js/renderer-solid/package.json'),
  );
  assert.equal(
    await fs.realpath(renderer.resolve('@solidjs/compiler')),
    await fs.realpath(requireApp.resolve('@solidjs/compiler')),
    'Renderer peer and application selected different compilers',
  );
  const babel = JSON.parse(
    await fs.readFile(renderer.resolve('@babel/core/package.json'), 'utf8'),
  );
  assert.equal(
    babel.version,
    '7.29.7',
    'The owning renderer Babel host drifted',
  );
  tuple['@babel/core'] = babel.version;
  const typescript = JSON.parse(
    await fs.readFile(requireApp.resolve('typescript/package.json'), 'utf8'),
  );
  assert.equal(typescript.version, '7.0.2', 'Native TypeScript host drift');
  tuple.typescript = typescript.version;
  const solid = createRequire(requireApp.resolve('solid-js'));
  const web = createRequire(requireApp.resolve('@solidjs/web'));
  const appSignals = await fs.realpath(requireApp.resolve('@solidjs/signals'));
  assert.equal(
    await fs.realpath(solid.resolve('@solidjs/signals')),
    appSignals,
    'Solid resolved signals outside the application copy',
  );
  assert.equal(
    await fs.realpath(renderer.resolve('solid-js')),
    await fs.realpath(requireApp.resolve('solid-js')),
    'Renderer and application selected different Solid runtimes',
  );
  for (const name of ['seroval', 'seroval-plugins/web', '@solidjs/signals']) {
    const expected = await fs.realpath(web.resolve(name));
    assert.equal(
      await fs.realpath(solid.resolve(name)),
      expected,
      `Solid and web selected different native instances: ${name}`,
    );
    if (name.startsWith('seroval')) {
      let directory = path.dirname(expected);
      for (;;) {
        const manifest = await fs
          .readFile(path.join(directory, 'package.json'), 'utf8')
          .then(JSON.parse, error => {
            if (error.code !== 'ENOENT') throw error;
          });
        if (manifest?.name === name.split('/')[0]) {
          assert.equal(
            manifest.version,
            '1.6.7',
            `Solid native serializer drift: ${name}`,
          );
          tuple[manifest.name] = manifest.version;
          break;
        }
        const parent = path.dirname(directory);
        assert.notEqual(
          parent,
          directory,
          `No native serializer identity: ${name}`,
        );
        directory = parent;
      }
    }
  }
  return tuple;
}

export async function checkGeneratedSolidTypes({ appRoot, execute }) {
  appRoot = await fs.realpath(appRoot);
  const before = new Map(
    await Promise.all(
      (await listFiles(path.join(appRoot, 'src'))).map(async file => [
        file,
        digest(await fs.readFile(file)),
      ]),
    ),
  );
  await execute(process.execPath, [installedBin(appRoot), 'build'], {
    cwd: appRoot,
    env: cleanConsumerEnv({
      NODE_ENV: 'production',
      SOLID_CONSUMER_STATS: 'true',
    }),
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const entries = await generatedBrowserEntries(appRoot);
  const bundle = await checkSolidBundleModules({ appRoot, entries });
  const generated = new Map(
    await Promise.all(
      entries.map(async file => [file, digest(await fs.readFile(file))]),
    ),
  );
  const key = `.solid-generated-acceptance-${randomUUID()}`;
  const config = path.join(appRoot, `${key}.json`);
  const environment = path.join(appRoot, `${key}.ts`);
  try {
    await fs.writeFile(
      environment,
      `import '@modern-js/ultramodern-app-tools/types';\nexport {};\n// @ts-expect-error Browser consumers must not receive Node globals.\nprocess.cwd();\n// @ts-expect-error Browser consumers must not receive Node globals.\nBuffer.from('node');\n`,
      { flag: 'wx' },
    );
    await fs.writeFile(
      config,
      JSON.stringify(strictBrowserConfig(entries, environment)),
      { flag: 'wx' },
    );
    await execute(
      process.execPath,
      [installedCompiler(appRoot), '-p', config],
      {
        cwd: appRoot,
        env: cleanConsumerEnv(),
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    for (const [file, expected] of [...before, ...generated])
      assert.equal(
        digest(await fs.readFile(file)),
        expected,
        `Acceptance changed authored/generated source: ${file}`,
      );
    return {
      bundle,
      entries: entries.map(file => path.relative(appRoot, file)),
      generatedDigests: Object.fromEntries(
        [...generated].map(([file, hash]) => [
          path.relative(appRoot, file),
          hash,
        ]),
      ),
    };
  } finally {
    await Promise.all([
      fs.rm(config, { force: true }),
      fs.rm(environment, { force: true }),
    ]);
  }
}

/** This browser diagnostic is qualified only by runGeneratedSolidConsumer. */
export async function checkGeneratedSolidBrowser({
  appRoot,
  origin,
  browserRoot,
  browserExecutable,
  signal,
  observer,
}) {
  const requireBrowser = createRequire(path.join(browserRoot, 'package.json'));
  const { chromium } = requireBrowser('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
  });
  const abort = () => {
    void browser.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  const timeout = () => AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  try {
    signal.throwIfAborted();
    const page = await browser.newPage();
    const nativeNetwork = await observeDeferredLoaderNetwork(page);
    const traffic = createRequestDiagnostics();
    traffic.attach(page, 'main');
    const errors = [];
    const documentRequests = [];
    const blocked = [];
    const delivered = [];
    let released = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('requestfailed', request =>
      errors.push(`Failed ${request.url()}: ${request.failure()?.errorText}`),
    );
    page.on('response', response => {
      if (response.request().resourceType() === 'script') {
        if (response.status() >= 400)
          errors.push(`Script ${response.status()}: ${response.url()}`);
        delivered.push(response.url());
      }
    });
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        documentRequests.push(request.url());
    });
    await page.addInitScript(installCancellationDiagnostics);
    await page.addInitScript(() => {
      const captured = {
        layout: undefined,
        counter: undefined,
        timeOrigin: performance.timeOrigin,
      };
      globalThis.__solidAcceptedSsr = captured;
      const observe = () => {
        captured.layout ??= document.querySelector(
          '[data-testid="native-layout"]',
        );
        captured.counter ??= document.querySelector(
          '[data-testid="native-count"]',
        );
      };
      new MutationObserver(observe).observe(document, {
        childList: true,
        subtree: true,
      });
      observe();
    });
    let release;
    const entryFence = new Promise(resolve => {
      release = resolve;
    });
    // Only emitted JavaScript participates in the SSR adoption fence. Data
    // responses must retain Chromium's normal streaming Fetch transport.
    const scriptUrls = /\.m?js(?:\?.*)?$/u;
    const holdEntry = async route => {
      assert.equal(route.request().resourceType(), 'script');
      if (!released) {
        blocked.push(route.request().url());
        await entryFence;
      }
      await route.fallback();
    };
    await page.route(scriptUrls, holdEntry);
    let documentResponse;
    try {
      documentResponse = await page.goto(origin, { waitUntil: 'commit' });
      assert.equal(documentResponse.status(), 200);
      await page
        .locator('[data-testid="native-count"]')
        .waitFor({ state: 'attached' });
      await page.waitForFunction(
        () =>
          globalThis.__solidAcceptedSsr.counter &&
          globalThis.__solidAcceptedSsr.layout,
      );
      const fenceDeadline = performance.now() + 5000;
      while (blocked.length === 0) {
        signal.throwIfAborted();
        assert(
          performance.now() < fenceDeadline,
          'No real browser entry request reached the SSR fence',
        );
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(
        delivered.length,
        0,
        'A client script arrived before the SSR fence',
      );
      assert(
        await page.evaluate(() => {
          const { layout, counter } = globalThis.__solidAcceptedSsr;
          return (
            layout instanceof HTMLElement &&
            counter instanceof HTMLElement &&
            layout.isConnected &&
            counter.isConnected &&
            layout ===
              document.querySelector('[data-testid="native-layout"]') &&
            counter ===
              document.querySelector('[data-testid="native-count"]') &&
            counter.textContent === '0'
          );
        }),
        'The first parser-inserted SSR nodes were missing, detached or replaced before entry delivery',
      );
    } finally {
      try {
        await page.unroute(scriptUrls, holdEntry);
      } finally {
        released = true;
        release();
      }
    }
    const initialHtml = await documentResponse.text();
    assert.match(initialHtml, /data-testid="native-layout"/);
    assert.match(initialHtml, /data-testid="native-count"[^>]*>0</);
    await page.waitForLoadState('networkidle');
    assert(
      delivered.some(url => blocked.includes(url)),
      'The captured server nodes were never hydrated by a delivered browser entry',
    );
    await page.locator('[data-testid="native-increment"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="native-count"]')?.textContent ===
        '1',
    );
    assert(
      await page.evaluate(() => {
        const { layout, counter } = globalThis.__solidAcceptedSsr;
        return (
          layout?.isConnected === true &&
          counter?.isConnected === true &&
          layout === document.querySelector('[data-testid="native-layout"]') &&
          counter === document.querySelector('[data-testid="native-count"]')
        );
      }),
      'Solid hydration replaced exact server nodes',
    );
    traffic.phase('action');
    await page.locator('input[name="name"]').fill('Solid RC15 acceptance');
    await page.locator('[data-testid="native-submit"]').click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="native-action-value"]')
        ?.textContent.includes('Solid RC15 acceptance'),
    );
    const requests = documentRequests.length;
    traffic.phase('about navigation');
    await page.locator('[data-testid="nav-about"]').click();
    await page.locator('[data-testid="native-about"]').waitFor();
    assert.equal(
      documentRequests.length,
      requests,
      'Native navigation fetched a replacement document',
    );
    assert(
      await page.evaluate(
        () =>
          globalThis.__solidAcceptedSsr.timeOrigin === performance.timeOrigin &&
          globalThis.__solidAcceptedSsr.layout?.isConnected === true &&
          globalThis.__solidAcceptedSsr.layout ===
            document.querySelector('[data-testid="native-layout"]'),
      ),
      'Navigation replaced the document or layout',
    );
    traffic.phase('deferred navigation');
    await page.locator('[data-testid="nav-deferred"]').click();
    await page.locator('[data-testid="native-deferred-pending"]').waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="native-deferred-late"]')
          ?.textContent === 'Native late value',
    );

    traffic.phase('overlapping server requests');
    const ids = [observer.requestId(), observer.requestId()];
    observer.pair(ids);
    const htmls = await Promise.all(
      [1, 10].map(async (item, index) => {
        const response = await fetch(new URL(`/items/${item}`, origin), {
          headers: { 'x-solid-acceptance-request': ids[index] },
          signal: timeout(),
        });
        assert.equal(response.status, 200);
        return response.text();
      }),
    );
    assert.equal(
      observer.events.filter(event => event.event === 'overlap').length,
      1,
      'The two server loaders never overlapped at their barrier',
    );
    for (const [index, html] of htmls.entries()) {
      const payload = await page.evaluate(source => {
        const document = new DOMParser().parseFromString(source, 'text/html');
        const nodes = document.querySelectorAll(
          '[data-testid="native-item-value"]',
        );
        if (nodes.length !== 1)
          throw new Error('Expected one server item record');
        return JSON.parse(nodes[0].textContent);
      }, html);
      assert.deepEqual(payload, { item: `Item ${[1, 10][index]}` });
      assert(
        !html.includes(`Item ${[10, 1][index]}"`),
        'A concurrent request leaked its serialized item',
      );
      await observer.wait(ids[index], 'loader-released');
    }

    traffic.phase('overlapping browser hydration');
    const hydrationIds = [observer.requestId(), observer.requestId()];
    observer.pair(hydrationIds);
    const isolatedPages = await Promise.all(
      [1, 10].map(async (item, index) => {
        const isolated = await browser.newPage();
        traffic.attach(isolated, `isolated-${item}`);
        isolated.on('pageerror', error => errors.push(error.message));
        isolated.on('console', message => {
          if (message.type() === 'error') errors.push(message.text());
        });
        isolated.on('requestfailed', request =>
          errors.push(`Failed isolated request ${request.url()}`),
        );
        isolated.on('response', response => {
          if (
            response.request().resourceType() === 'script' &&
            response.status() >= 400
          )
            errors.push(`Isolated script ${response.status()}`);
        });
        await isolated.setExtraHTTPHeaders({
          'x-solid-acceptance-request': hydrationIds[index],
        });
        await isolated.addInitScript(() => {
          globalThis.__solidItemSnapshots = [];
          const record = () => {
            const text = document.querySelector(
              '[data-testid="native-item-value"]',
            )?.textContent;
            if (text) globalThis.__solidItemSnapshots.push(text);
          };
          new MutationObserver(record).observe(document, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        });
        await isolated.goto(new URL(`/items/${item}`, origin).href, {
          waitUntil: 'networkidle',
        });
        assert.deepEqual(
          JSON.parse(
            await isolated
              .locator('[data-testid="native-item-value"]')
              .textContent(),
          ),
          { item: `Item ${item}` },
        );
        const snapshots = await isolated.evaluate(
          () => globalThis.__solidItemSnapshots,
        );
        assert(
          snapshots.length > 0,
          'No SSR/hydrated item payload was observed',
        );
        for (const snapshot of snapshots)
          assert.deepEqual(
            JSON.parse(snapshot),
            { item: `Item ${item}` },
            'Concurrent native serialized data crossed requests',
          );
        const timeOrigin = await isolated.evaluate(
          () => performance.timeOrigin,
        );
        await isolated.locator('[data-testid="native-item"] a').click();
        await isolated.locator('[data-testid="native-increment"]').click();
        await isolated.waitForFunction(
          () =>
            document.querySelector('[data-testid="native-count"]')
              ?.textContent === '1',
        );
        assert.equal(
          await isolated.evaluate(() => performance.timeOrigin),
          timeOrigin,
          'The isolated native router reloaded the document',
        );
        return isolated;
      }),
    );
    assert.equal(
      observer.events.filter(event => event.event === 'overlap').length,
      2,
      'The native hydration request pair did not overlap',
    );
    await Promise.all(isolatedPages.map(isolated => isolated.close()));

    const streamed = async (cancel, id) => {
      const response = await fetch(new URL('/?case=deferred', origin), {
        headers: {
          'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
          'x-solid-acceptance-request': id,
        },
        signal: timeout(),
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      let earlyAt;
      let lateAt;
      let chunk = 0;
      let earlyChunk;
      let lateChunk;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunk++;
          html += decoder.decode(next.value, { stream: true });
          if (
            earlyAt === undefined &&
            html.includes('native-deferred-pending')
          ) {
            assert(
              !html.includes('Native late value'),
              'The early shell included the late value',
            );
            earlyAt = performance.now();
            earlyChunk = chunk;
            if (cancel) {
              await reader.cancel('Solid acceptance abort');
              break;
            }
          }
          if (
            lateAt === undefined &&
            /data-testid=[\\]?["']native-deferred-late/.test(html) &&
            html.includes('Native late value')
          ) {
            lateAt = performance.now();
            lateChunk = chunk;
          }
        }
        assert(
          earlyAt !== undefined,
          'The response never streamed an early shell',
        );
        if (!cancel) {
          assert(
            lateAt !== undefined &&
              lateChunk > earlyChunk &&
              lateAt - earlyAt >= 250,
            'The completed response did not deliver late markup in a later chunk after a real gap',
          );
          await observer.wait(id, 'resolved');
        } else await observer.wait(id, 'aborted');
        await observer.wait(id, 'cleaned');
        assert.equal(
          observer.events.filter(
            event => event.id === id && event.event === 'cleaned',
          ).length,
          1,
        );
        if (cancel)
          assert.equal(
            observer.events.filter(
              event => event.id === id && event.event === 'resolved',
            ).length,
            0,
          );
        return {
          earlyChunk,
          lateChunk,
          gapMs: lateAt === undefined ? undefined : lateAt - earlyAt,
        };
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };
    traffic.phase('server stream completion');
    const completion = await streamed(false, observer.requestId());
    traffic.phase('server stream cancellation');
    const cancellation = await streamed(true, observer.requestId());
    traffic.phase('server recovery');
    const recovery = await fetch(new URL('/items/3', origin), {
      signal: timeout(),
    });
    assert.equal(recovery.status, 200);
    await recovery.arrayBuffer();
    let mainPageState;
    let rawLoaderDiagnostic;
    if (errors.length) {
      try {
        const { parsePublicData } = createRequire(
          path.join(appRoot, 'package.json'),
        )('@modern-js/renderer-core/data');
        rawLoaderDiagnostic = await probeRawDeferredLoader(browser, origin, {
          decodeFrame: parsePublicData,
        });
      } catch (error) {
        rawLoaderDiagnostic = { diagnosticError: String(error).slice(0, 2048) };
      }
      let diagnosticTimer;
      try {
        mainPageState = await Promise.race([
          page.evaluate(() => ({
            url: location.href.slice(0, 2048),
            cancellations:
              globalThis.__solidCancellationDiagnostics?.snapshot(),
            handledError: document
              .querySelector('[data-testid="native-error"]')
              ?.textContent?.slice(0, 1024),
            deferredLate: document
              .querySelector('[data-testid="native-deferred-late"]')
              ?.textContent?.slice(0, 1024),
          })),
          new Promise((_, reject) => {
            diagnosticTimer = setTimeout(
              () =>
                reject(new Error('Main-page diagnostics exceeded one second')),
              1000,
            );
          }),
        ]);
      } catch (error) {
        mainPageState = { diagnosticError: String(error).slice(0, 512) };
      } finally {
        clearTimeout(diagnosticTimer);
      }
    }
    assert.deepEqual(
      errors,
      [],
      `The native browser raised errors or failed resources\nBrowser request lifecycle: ${JSON.stringify(traffic.snapshot())}\nMain page state: ${JSON.stringify(mainPageState)}\nNative loader network: ${JSON.stringify(nativeNetwork.snapshot())}\nApp-free Chromium loader: ${JSON.stringify(rawLoaderDiagnostic)}`,
    );
    return {
      retainedSsrNodes: true,
      nativeAction: true,
      nativeNavigation: true,
      deferredHydration: true,
      overlappingRequestIsolation: true,
      completion,
      cancellation,
      serverAbortAndLoaderCleanup: true,
      documentReload: false,
      blockedEntryRequests: blocked,
      deliveredEntryRequests: delivered,
    };
  } finally {
    signal.removeEventListener('abort', abort);
    await browser.close();
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  return port;
}

/** The qualifying entry point builds and starts the exact authenticated app. */
export async function runGeneratedSolidConsumer({
  appRoot,
  manifestPath,
  browserRoot,
  browserExecutable,
  signal,
}) {
  signal?.throwIfAborted();
  appRoot = await fs.realpath(appRoot);
  const cohort = readCohort(manifestPath);
  const copies = checkInstalledCohort({ appRoot, cohort });
  const tuple = await installedTuple(appRoot, cohort);
  const scope = createAdmissionProcessScope({ signal });
  let observer;
  try {
    observer = await createSolidConsumerObserver(scope.signal);
    const types = await checkGeneratedSolidTypes({
      appRoot,
      execute: scope.execute,
    });
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const server = scope.start(
      process.execPath,
      [installedBin(appRoot), 'serve'],
      {
        cwd: appRoot,
        env: cleanConsumerEnv({
          NODE_ENV: 'production',
          PORT: String(port),
          ...observer.env,
        }),
      },
    );
    const deadline = Date.now() + 60000;
    for (;;) {
      scope.signal.throwIfAborted();
      if (
        server.exitCode !== null ||
        server.signalCode !== null ||
        server.admissionResult().failure
      )
        throw new Error(`Installed Solid server exited: ${server.output()}`);
      const response = await fetch(origin, {
        signal: AbortSignal.any([scope.signal, AbortSignal.timeout(1000)]),
      }).catch(() => undefined);
      if (response?.ok) {
        await response.arrayBuffer();
        break;
      }
      await response?.body?.cancel();
      assert(
        Date.now() < deadline,
        'The installed Solid server did not become ready',
      );
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const browser = await checkGeneratedSolidBrowser({
      appRoot,
      origin,
      browserRoot,
      browserExecutable,
      signal: scope.signal,
      observer,
    });
    return {
      gate: 'solid-generated-installed-consumer',
      node: process.version,
      sourceRevision: cohort.sourceRevision,
      cohortDigest: cohort.cohortDigest,
      manifestSha256: cohort.manifestSha256,
      installedCopies: copies,
      tuple,
      types,
      browser,
    };
  } finally {
    try {
      await scope.dispose();
    } finally {
      await observer?.close();
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'app-directory': { type: 'string' },
      'manifest-path': { type: 'string' },
      'browser-root': { type: 'string' },
      'browser-executable': { type: 'string' },
    },
  });
  assert(
    values['app-directory'] &&
      values['manifest-path'] &&
      values['browser-root'],
    'Pass the isolated public app, authenticated cohort manifest and browser dependency root',
  );
  console.log(
    JSON.stringify(
      await runGeneratedSolidConsumer({
        appRoot: values['app-directory'],
        manifestPath: values['manifest-path'],
        browserRoot: values['browser-root'],
        browserExecutable: values['browser-executable'],
      }),
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
