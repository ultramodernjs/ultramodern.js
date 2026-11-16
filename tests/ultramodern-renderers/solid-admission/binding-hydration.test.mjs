import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveDiskGuardian } from '../../../scripts/ultramodern-production-readiness/renderer-worker-lifecycle-proof/support.mjs';

import { assertNativeRendererManifest } from './packages.mjs';

const execute = promisify(execFile);
const fixtureRoot = fileURLToPath(
  new URL('./binding-fixture/', import.meta.url),
);
const consumer = process.env.ULTRAMODERN_SOLID_FIXTURE_DIRECTORY;
const temporary = process.env.OWNED_TEMP_DIR;
// On a runner there is no guardian: the job's own directory lease owns the
// build output. A configured guardian that cannot run still fails loudly.
const guardian = resolveDiskGuardian();
const owner = 'solid-native-binding-hydration';
let output;
let outputCreated = false;
let registered = false;
let browser;
let renderCase;
let clientScripts;
let host;
let hostUrl;
const documents = new Map();

async function guardianCommand(args) {
  assert.ok(guardian, 'No disk guardian is configured');
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await execute(guardian, args, { timeout: 30_000 });
      return;
    } catch (error) {
      if (
        !/lock/u.test(`${error.stdout ?? ''}${error.stderr ?? ''}`) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

before(async () => {
  assert.ok(
    consumer,
    'Set ULTRAMODERN_SOLID_FIXTURE_DIRECTORY to the installed checked admission fixture.',
  );
  assert.ok(
    temporary,
    'Run this test with owned-temp-dir --run so generated assets have an owner.',
  );
  const resolve = createRequire(path.join(consumer, 'package.json'));
  const packageFile = resolve.resolve('@modern-js/renderer-solid/package.json');
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  assertNativeRendererManifest(manifest);
  await access(
    path.join(
      path.dirname(packageFile),
      'dist/esm/router-binding/registryTransfer.js',
    ),
  );
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
  const { createRsbuild } = await import(
    pathToFileURL(resolve.resolve('@rsbuild/core')).href
  );
  const compilerPath = resolve.resolve('@solidjs/compiler');
  const loader = fileURLToPath(
    new URL('./binding-fixture/solid-loader.cjs', import.meta.url),
  );
  const preserveImports = fileURLToPath(
    new URL('./fixture/preserve-import-loader.cjs', import.meta.url),
  );
  const plugin = {
    name: 'solid-native-binding-registry-probe',
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
          include: fixtureRoot,
          enforce: 'pre',
          use: [{ loader, options: { compilerPath, server } }],
        });
        if (!server) {
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
        }
        return config;
      });
    },
  };
  const rsbuild = await createRsbuild({
    cwd: fixtureRoot,
    rsbuildConfig: {
      plugins: [plugin],
      performance: { buildCache: false },
      environments: {
        client: {
          source: { entry: { probe: path.join(fixtureRoot, 'client.tsx') } },
          output: {
            target: 'web',
            cleanDistPath: false,
            distPath: { root: path.join(output, 'client') },
            filename: { js: '[name].js' },
          },
        },
        server: {
          source: { entry: { probe: path.join(fixtureRoot, 'server.tsx') } },
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
  ({ renderCase } = await import(
    pathToFileURL(path.join(output, 'server/probe.mjs')).href
  ));
  const clientHtml = await readFile(
    path.join(output, 'client/probe.html'),
    'utf8',
  );
  clientScripts = clientHtml.match(
    /<script\b[^>]*\bsrc=(?:"[^"]+"|'[^']+')[^>]*>\s*<\/script>/gu,
  );
  assert.ok(clientScripts?.length, 'Native client build emitted no scripts');
  const { chromium } = resolve('playwright');
  browser = await chromium.launch({ headless: true });
  host = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const key = url.searchParams.get('case');
    const html = documents.get(key);
    if (html) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(html);
      return;
    }
    const clientRoot = path.join(output, 'client');
    const filename = path.resolve(clientRoot, `.${url.pathname}`);
    if (!filename.startsWith(`${clientRoot}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const asset = await readFile(filename);
      response.setHeader(
        'content-type',
        filename.endsWith('.js')
          ? 'application/javascript'
          : filename.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream',
      );
      response.end(asset);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  hostUrl = `http://127.0.0.1:${host.address().port}`;
});

after(async () => {
  const failures = [];
  const clean = async operation => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  await clean(() => browser?.close());
  if (host) {
    host.closeAllConnections();
    await clean(() => new Promise(resolve => host.close(resolve)));
  }
  if (outputCreated) {
    if (registered) {
      await clean(() => guardianCommand(['release', output, '--owner', owner]));
    }
    await clean(() => rm(output, { recursive: true, force: true }));
  }
  if (failures.length)
    throw new AggregateError(failures, 'Native binding probe cleanup failed');
});

async function runBrowser(mode, html) {
  const page = await browser.newPage();
  const errors = [];
  let phase = 'document';
  page.on('pageerror', error => errors.push({ message: error.message, phase }));
  const key = String(documents.size);
  documents.set(
    key,
    `<!doctype html><html><body><div id="root">${html}</div>${clientScripts.join('')}</body></html>`,
  );
  try {
    await page.goto(`${hostUrl}/?case=${key}`);
    await page.waitForFunction(
      () => typeof globalThis.runBindingProbe === 'function',
    );
    phase = 'router-bootstrap';
    const result = await page.evaluate(
      mode => globalThis.runBindingProbe(mode),
      mode,
    );
    assert.deepEqual(
      errors,
      [],
      JSON.stringify({
        mode,
        result,
        html: mode === 'rejected' ? html : undefined,
      }),
    );
    return result;
  } finally {
    documents.delete(key);
    await page.close();
  }
}

test('real native SSR transfers loader data and hydrates the same nodes without a second loader call', async () => {
  const server = await renderCase('sync');
  assert.equal(server.loaderCalls, 1);
  assert.match(server.html, /loaded-on-server/u);
  assert.match(server.html, /server-fallback/u);
  assert.doesNotMatch(server.html, /client-visible/u);
  assert.doesNotMatch(
    server.html,
    /PRIVATE_(?:BEFORE_LOAD|REQUEST|HEADERS|CALLBACK)_TOKEN/u,
  );
  assert.match(server.html, /beforeLoadContext/u);
  assert.deepEqual(await runBrowser('sync', server.html), {
    transferred: 2,
    sameNode: true,
    loaderCalls: 0,
    beforeLoadCalls: 0,
    routeContextCalls: 1,
    beforeLoadOwner: 'before-load-on-server',
    routeContext: 'before-load-on-server',
    routeOwner: 'route-context-on-client',
    optionsOwner: 'options-context-on-client',
    tenant: { name: 'public-tenant' },
    text: 'loaded-on-server',
    hydrated: 'settled',
    clientOnly: 'client-visible',
    fallback: null,
    loaderData: { text: 'loaded-on-server' },
  });
});

for (const mode of [
  'partial',
  'pending',
  'absent',
  'noHydration',
  // Genuine native writer output: a valid root and a fulfilled rich leaf slot
  // that the framework's immutable UI receiver must reject atomically.
  'invalidDeferredSlot',
  // Raw writer injection bypasses the owned settled-match producer. Keep its
  // failing native ABI reproduction separate from product qualification.
  ...(process.env.ULTRAMODERN_SOLID_RAW_PROTOCOL_DIAGNOSTIC === '1'
    ? ['rejected']
    : []),
]) {
  test(`native ${mode} transfer falls back to the client loader`, async () => {
    const server = await renderCase(mode);
    if (mode === 'noHydration') assert.doesNotMatch(server.html, /tsr:/u);
    assert.deepEqual(await runBrowser(mode, server.html), {
      transferred: 0,
      loaderCalls: 1,
      beforeLoadCalls: 1,
      loaderData: { text: 'loaded-on-client' },
    });
  });
}

test('purported public loader results reject private native objects, functions and accessors before bytes are returned', async () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'PRIVATE_GETTER_TOKEN';
    },
  });
  for (const value of [
    { value: new Headers({ authorization: 'PRIVATE_LOADER_TOKEN' }) },
    {
      value: new Request('https://example.test/', {
        headers: { authorization: 'PRIVATE_LOADER_TOKEN' },
      }),
    },
    { value: new Uint8Array([1]) },
    { value: () => 'PRIVATE_LOADER_TOKEN' },
    accessor,
  ]) {
    await assert.rejects(
      () => renderCase('sync', value),
      /Public data|Unsupported public data/u,
    );
  }
  assert.equal(getterCalls, 0);
});
