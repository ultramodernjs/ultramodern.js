import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDiskGuardian } from '../../../scripts/ultramodern-production-readiness/renderer-worker-lifecycle-proof/support.mjs';
import { createAdmissionProcessScope } from './processes.mjs';

const consumer = process.env.ULTRAMODERN_SOLID_FIXTURE_DIRECTORY;
const temporary = process.env.OWNED_TEMP_DIR;
const owner = 'solid-managed-deferred-hydration';
// On a runner there is no guardian: the job's own directory lease owns the
// build output. A configured guardian that cannot run still fails loudly.
const guardian = resolveDiskGuardian();
const processes = createAdmissionProcessScope();
let fixture;
let output;
let fixtureCreated = false;
let outputCreated = false;
let registered = false;
let browser;
let host;
let hostUrl;
let beginDeferredDocument;
let assets;
const documents = new Map();
const streams = new Map();
const serverFailures = [];
const activeDocuments = new Set();
const cases = [];
let interruptedError;
function assertActive() {
  processes.signal.throwIfAborted();
  if (interruptedError) throw interruptedError;
}
// node:test installs async hooks which add private own symbols to every Promise.
// Run the native SSR host with ordinary application Promises instead.
function test(name, { timeout }, run) {
  cases.push({ name, timeout, run });
}
const interruptActiveProbe = () => {
  for (const control of activeDocuments)
    control.session.abort(interruptedError ?? processes.signal.reason);
  host?.closeAllConnections();
  void browser?.close().catch(() => {});
};
processes.signal.addEventListener('abort', interruptActiveProbe);

async function guardianCommand(args) {
  assert.ok(guardian, 'No disk guardian is configured');
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      // Cleanup registrations must remain available after interrupt.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)(guardian, args, { timeout: 30_000 });
      return;
    } catch (error) {
      if (
        !/lock/u.test(`${error.stdout ?? ''}${error.stderr ?? ''}`) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function initialize() {
  assertActive();
  assert.ok(
    consumer && temporary,
    'Use the checked packed fixture and owned-temp-dir --run',
  );
  const resolve = createRequire(path.join(consumer, 'package.json'));
  fixture = path.join(consumer, 'managed-deferred-hydration');
  await mkdir(fixture);
  fixtureCreated = true;
  await cp(
    fileURLToPath(new URL('./deferred-fixture/', import.meta.url)),
    fixture,
    {
      recursive: true,
    },
  );
  assertActive();
  const types = JSON.parse(
    await readFile(path.join(consumer, 'tsconfig.json'), 'utf8'),
  );
  types.include = ['./*.tsx'];
  await writeFile(path.join(fixture, 'tsconfig.json'), JSON.stringify(types));
  await processes.execute(
    path.join(consumer, 'node_modules/.bin/tsc'),
    ['--project', path.join(fixture, 'tsconfig.json')],
    { cwd: consumer },
  );
  assertActive();
  output = path.join(temporary, 'dist');
  await mkdir(output);
  outputCreated = true;
  if (guardian) {
    await guardianCommand([
      'register',
      output,
      '--owner',
      owner,
      '--owner-pid',
      String(process.pid),
      '--kind',
      'build',
    ]);
    registered = true;
  }
  assertActive();
  const { createRsbuild } = await import(
    pathToFileURL(resolve.resolve('@rsbuild/core')).href
  );
  const loader = fileURLToPath(
    new URL('./binding-fixture/solid-loader.cjs', import.meta.url),
  );
  const compilerPath = resolve.resolve('@solidjs/compiler');
  const preserveImports = fileURLToPath(
    new URL('./fixture/preserve-import-loader.cjs', import.meta.url),
  );
  const rsbuild = await createRsbuild({
    cwd: fixture,
    rsbuildConfig: {
      plugins: [
        {
          name: 'managed-solid-deferred-hydration-probe',
          setup(api) {
            api.modifyRspackConfig((config, { environment }) => {
              const server = environment.config.output.target === 'node';
              config.resolve.conditionNames = [
                server ? 'node' : 'browser',
                'import',
                'default',
              ];
              config.resolve.modules = [
                path.join(consumer, 'node_modules'),
                'node_modules',
              ];
              config.module.rules.unshift({
                test: /\.tsx$/u,
                include: fixture,
                enforce: 'pre',
                use: [{ loader, options: { compilerPath, server } }],
              });
              if (!server)
                config.module.rules.unshift({
                  test: /[/]@solidjs[/]web[/]dist[/]web(?:\.dev)?\.js$/u,
                  enforce: 'pre',
                  use: [
                    {
                      loader: preserveImports,
                      options: { babelPath: resolve.resolve('@babel/core') },
                    },
                  ],
                });
              return config;
            });
          },
        },
      ],
      performance: { buildCache: false },
      environments: {
        client: {
          source: { entry: { deferred: path.join(fixture, 'client.tsx') } },
          output: {
            target: 'web',
            module: true,
            cleanDistPath: false,
            distPath: { root: path.join(output, 'client') },
            filename: { js: '[name].js' },
          },
        },
        server: {
          source: { entry: { deferred: path.join(fixture, 'server.tsx') } },
          output: {
            target: 'node',
            module: true,
            cleanDistPath: false,
            distPath: { root: path.join(output, 'server') },
            filename: { js: '[name].mjs' },
          },
          tools: { rspack: { externals: [] } },
        },
      },
    },
  });
  await rsbuild.build();
  assertActive();
  ({ beginDeferredDocument } = await import(
    pathToFileURL(path.join(output, 'server/deferred.mjs')).href
  ));
  const html = await readFile(
    path.join(output, 'client/deferred.html'),
    'utf8',
  );
  const scripts = [
    ...html.matchAll(/<script\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>/gu),
  ];
  assert.ok(
    scripts.length,
    'Expected real emitted client entry and shared runtime assets',
  );
  assets = scripts.map(match => ({
    kind: 'script',
    href: match[1] ?? match[2],
    scriptType: /\btype=["']module["']/u.test(match[0]) ? 'module' : 'classic',
  }));
  assert.ok(assets.every(asset => asset.scriptType === 'module'));
  const { chromium } = resolve('playwright');
  browser = await chromium.launch({ headless: true });
  assertActive();
  host = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const key = url.searchParams.get('case');
      if (documents.has(key)) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(documents.get(key));
        return;
      }
      const control = streams.get(key);
      if (control) {
        response.once('close', () => {
          if (!response.writableEnded)
            control.session.abort(new Error('Deferred browser disconnected'));
        });
        response.writeHead(
          control.response.status,
          Object.fromEntries(control.response.headers),
        );
        const reader = control.response.body.getReader();
        const decoder = new TextDecoder();
        control.html = '';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            control.html += decoder.decode(chunk.value, { stream: true });
            response.write(chunk.value);
          }
          response.end();
        } finally {
          reader.releaseLock();
        }
        return;
      }
      const root = path.join(output, 'client');
      const filename = path.resolve(root, `.${url.pathname}`);
      if (!filename.startsWith(`${root}${path.sep}`)) {
        response.writeHead(404).end();
        return;
      }
      try {
        response.setHeader(
          'content-type',
          filename.endsWith('.js')
            ? 'application/javascript'
            : 'application/octet-stream',
        );
        response.end(await readFile(filename));
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
        response.writeHead(404).end();
      }
    } catch (error) {
      serverFailures.push(error);
      response.destroy(error);
    }
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  assertActive();
  hostUrl = `http://127.0.0.1:${host.address().port}`;
}

async function cleanup() {
  processes.signal.removeEventListener('abort', interruptActiveProbe);
  const failures = [];
  const clean = async operation => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const control of activeDocuments)
    await clean(() =>
      control.session.abort(new Error('Deferred browser probe closed')),
    );
  await clean(() => browser?.close());
  if (host) {
    host.closeAllConnections();
    await clean(() => new Promise(resolve => host.close(resolve)));
  }
  await clean(() => processes.dispose());
  if (registered)
    await clean(() => guardianCommand(['release', output, '--owner', owner]));
  if (outputCreated)
    await clean(() => rm(output, { recursive: true, force: true }));
  if (fixtureCreated)
    await clean(() => rm(fixture, { recursive: true, force: true }));
  if (failures.length)
    throw new AggregateError(failures, 'Managed deferred probe cleanup failed');
}

async function completedDocument(control, settle) {
  const reader = control.response.body.getReader();
  let html = '';
  try {
    const shell = await reader.read();
    html += new TextDecoder().decode(shell.value);
    assert.match(html, /Native deferred pending/u);
    settle();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      html += new TextDecoder().decode(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  control.html = html;
  return html;
}

async function reportProbe(timing, phase, page, control) {
  const browserState = await page.evaluate(() => ({
    events: globalThis.managedDeferredEvents,
    unhandled: globalThis.managedDeferredUnhandled,
    bootstrapAt: globalThis.managedDeferredProbe?.bootstrapAt,
    transferred: globalThis.managedDeferredProbe?.transferred,
    loaderCalls: globalThis.managedDeferredProbe?.counters.loader,
    nativeErrorVisible: Boolean(document.getElementById('deferred-error')),
  }));
  const source = control.html ?? '';
  const promise = source.indexOf('new Promise');
  process.stderr.write(
    `${JSON.stringify({
      probe: 'managed-solid-deferred',
      scriptFormats: assets.map(asset => asset.scriptType),
      timing,
      phase,
      server: control.timeline,
      sessionState: control.session.state,
      serverCounters: control.counters,
      nativeErrors: control.errors,
      browser: browserState,
      nativePromiseSource:
        promise < 0 ||
        !['bootstrap', 'native-settlement-before-bootstrap'].includes(phase)
          ? undefined
          : source.slice(Math.max(0, promise - 150), promise + 1650),
    })}\n`,
  );
}

async function openPage(key, streamed, holdBootstrap = false, control) {
  const page = await browser.newPage();
  let releaseBootstrap;
  const bootstrapHeld = new Promise(resolve => {
    releaseBootstrap = resolve;
  });
  const errors = [];
  page.on('pageerror', error =>
    errors.push({ message: error.message, at: Date.now() }),
  );
  await page.addInitScript(() => {
    globalThis.managedDeferredEvents = [];
    globalThis.managedDeferredUnhandled = [];
    window.addEventListener('error', event => {
      globalThis.managedDeferredEvents.push({
        kind: 'error',
        message: event.message,
        at: Date.now(),
        documentState: document.readyState,
        bootstrapped: Boolean(globalThis.managedDeferredProbe),
      });
    });
    window.addEventListener('unhandledrejection', event => {
      const observation = {
        kind: 'unhandledrejection',
        reason: String(event.reason),
        at: Date.now(),
        documentState: document.readyState,
        bootstrapped: Boolean(globalThis.managedDeferredProbe),
      };
      globalThis.managedDeferredUnhandled.push(observation);
      globalThis.managedDeferredEvents.push(observation);
    });
  });
  if (holdBootstrap)
    await page.route('**/static/js/**', async route => {
      await bootstrapHeld;
      await route.continue();
    });
  try {
    await page.goto(`${hostUrl}/item?case=${key}`, {
      waitUntil: streamed || holdBootstrap ? 'commit' : 'load',
    });
    if (holdBootstrap) {
      await page.waitForFunction(() => document.readyState !== 'loading');
      assert.equal(
        await page.evaluate(() => Boolean(globalThis.managedDeferredProbe)),
        false,
        'Native settlement scripts must parse before the held entry bootstraps',
      );
      await reportProbe(
        key,
        'native-settlement-before-bootstrap',
        page,
        control,
      );
      control.timeline.bootstrapReleasedAt = Date.now();
      releaseBootstrap();
    }
    await page.waitForFunction(() => globalThis.managedDeferredProbe);
    return { page, errors };
  } catch (error) {
    releaseBootstrap();
    await page.close();
    throw new Error(
      `Managed deferred bootstrap failed: ${JSON.stringify({ key, errors })}`,
      { cause: error },
    );
  }
}

test('settled managed deferred data hydrates the original native nodes without repeating a loader', {
  timeout: 30_000,
}, async () => {
  const control = await beginDeferredDocument(assets);
  activeDocuments.add(control);
  const html = await completedDocument(control, control.resolve);
  assert.doesNotMatch(html, /PRIVATE_DEFERRED_REQUEST_TOKEN/u);
  documents.set('fulfilled', html);
  const { page, errors } = await openPage('fulfilled', false);
  try {
    await reportProbe('fulfilled', 'bootstrap', page, control);
    await page
      .getByText('native-server-deferred-success', { exact: true })
      .waitFor();
    assert.deepEqual(
      await page.evaluate(() => ({
        loader: globalThis.managedDeferredProbe.counters.loader,
        transferred: globalThis.managedDeferredProbe.transferred,
        sameNode: globalThis.managedDeferredProbe.sameNode,
      })),
      { loader: 0, transferred: 2, sameNode: true },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      await page.evaluate(() => globalThis.managedDeferredUnhandled),
      [],
    );
    assert.equal((await control.session.completion).state, 'completed');
    await page.evaluate(() => globalThis.managedDeferredProbe.dispose());
    assert.equal(
      await page.evaluate(
        () => globalThis.managedDeferredProbe.counters.cleanup,
      ),
      1,
    );
  } finally {
    await page.close();
  }
});

for (const timing of ['before-bootstrap', 'after-bootstrap']) {
  test(`a managed deferred rejection ${timing} reaches the native error boundary and retries without an unhandled browser rejection`, {
    timeout: 30_000,
  }, async () => {
    const control = await beginDeferredDocument(assets);
    activeDocuments.add(control);
    if (timing === 'before-bootstrap') {
      const html = await completedDocument(control, control.reject);
      assert.doesNotMatch(html, /PRIVATE_DEFERRED_REQUEST_TOKEN/u);
      documents.set(timing, html);
    } else streams.set(timing, control);
    const { page, errors } = await openPage(
      timing,
      timing === 'after-bootstrap',
      timing === 'before-bootstrap',
      control,
    );
    try {
      await reportProbe(timing, 'bootstrap', page, control);
      assert.equal(
        await page.evaluate(
          () => globalThis.managedDeferredProbe.counters.loader,
        ),
        0,
      );
      assert.equal(
        await page.evaluate(() => globalThis.managedDeferredProbe.transferred),
        2,
      );
      if (timing === 'after-bootstrap') {
        assert.equal(control.timeline.settledAt, 0);
        assert.equal(control.session.state, 'committed');
        assert.equal(control.counters.cleanup, 0);
        await page
          .getByText('Native deferred pending', { exact: true })
          .waitFor();
        control.reject();
      } else {
        assert.ok(
          control.timeline.bootstrapReleasedAt > control.timeline.settledAt,
          'The real native module bootstrap is held until settlement is parsed',
        );
      }
      await page.locator('#deferred-error').waitFor();
      await reportProbe(timing, 'native-error-boundary', page, control);
      assert.deepEqual(
        errors,
        [],
        JSON.stringify({ timing, nativeErrors: control.errors }),
      );
      assert.deepEqual(
        await page.evaluate(() => globalThis.managedDeferredUnhandled),
        [],
      );
      await reportProbe(timing, 'document-completion-start', page, control);
      const completion = await control.session.completion;
      await reportProbe(timing, 'document-completion-finished', page, control);
      assert.equal(completion.state, 'completed');
      assert.equal(completion.cacheEligible, false);
      assert.equal(control.counters.cleanup, 1);
      await page.getByRole('button', { name: 'Reset native boundary' }).click();
      await page.locator('#deferred-error').waitFor();
      assert.equal(
        await page.evaluate(
          () => globalThis.managedDeferredProbe.counters.loader,
        ),
        0,
        'Resetting the native boundary alone must not repeat a loader',
      );
      await reportProbe(timing, 'native-boundary-reset', page, control);
      await reportProbe(timing, 'native-retry-start', page, control);
      await page.evaluate(() =>
        globalThis.managedDeferredProbe.router.invalidate({ sync: true }),
      );
      await reportProbe(timing, 'native-retry-loaded', page, control);
      await page
        .getByText('native-client-retry-success', { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => globalThis.managedDeferredProbe.counters.loader,
        ),
        1,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(
        await page.evaluate(() => globalThis.managedDeferredUnhandled),
        [],
      );
      assert.deepEqual(serverFailures, []);
      assert.equal(Object.isFrozen(control.authored), false);
      assert.deepEqual(Reflect.ownKeys(control.authored), []);
      await page.evaluate(() => globalThis.managedDeferredProbe.dispose());
    } finally {
      await page.close();
      control.session.abort(new Error('Managed deferred case finished'));
      streams.delete(timing);
    }
  });
}

async function bounded(operation, timeout) {
  let timer;
  const running = operation();
  try {
    return await Promise.race([
      running,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          interruptedError = new Error(
            `Managed deferred probe timed out (${timeout}ms)`,
          );
          interruptActiveProbe();
          reject(interruptedError);
        }, timeout);
      }),
    ]);
  } catch (error) {
    // Let pending creation settle before cleanup releases its owning paths.
    // Post-await guards prevent a timed-out initializer from creating a host.
    if (interruptedError) await running.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const failures = [];
try {
  await bounded(initialize, 120_000);
  for (const { name, timeout, run } of cases) {
    assertActive();
    try {
      await bounded(run, timeout);
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failures.push(error);
      process.stderr.write(`FAIL ${name}\n${error.stack}\n`);
    }
  }
} catch (error) {
  failures.push(error);
} finally {
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
}
if (failures.length)
  throw new AggregateError(
    failures,
    'Managed deferred native browser gate failed',
  );
assertActive();
process.stdout.write(
  JSON.stringify({ status: 'passed', cases: cases.length }) + '\n',
);
