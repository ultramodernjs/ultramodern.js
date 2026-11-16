import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAdmissionPackages } from './native-artifact.mjs';

// Run inside an operation-owned directory containing this fixture and its
// strictly installed package.json. Source and package patches are forbidden.
const root = process.cwd();
const buildMode = process.argv.includes('--production')
  ? 'production'
  : 'development';
const outputRoot = path.join(
  root,
  'dist',
  buildMode === 'production' ? 'production' : '',
);
const clientOutput = path.join(outputRoot, 'client');
const require = createRequire(path.join(root, 'package.json'));
const { rspack } = await import(pathToFileURL(require.resolve('@rspack/core')));
const { OctaneRspackPlugin, getOctaneRspackBuildInfo } = await import(
  pathToFileURL(require.resolve('@octanejs/rspack-plugin'))
);
const privateManifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const { packageVersions, nativeArtifact, nativeRouterArtifact } =
  await validateAdmissionPackages({
    root,
    workspacePath: privateManifest.ultramodernAdmission?.workspacePath,
    nativeArtifacts: privateManifest.ultramodernAdmission?.nativeArtifacts,
    nativeArchives: privateManifest.ultramodernAdmission?.nativeArchives,
  });

const compilationEvidence = [];
async function compile(environment) {
  const outputPath = path.join(outputRoot, environment);
  const plugin = new OctaneRspackPlugin({
    root,
    environment,
    transpile: false,
    parallel: false,
  });
  const compiler = rspack({
    context: root,
    mode: buildMode,
    target: environment === 'server' ? 'node' : 'web',
    devtool: 'source-map',
    entry:
      environment === 'server'
        ? { server: './src/server.ts' }
        : {
            client: './src/client.ts',
            'router-client': './src/router-client.ts',
            'signals-client': './src/signals-client.ts',
          },
    output: {
      path: outputPath,
      filename: '[name].js',
      chunkFilename: '[name].chunk.js',
      publicPath: '/',
      ...(environment === 'server' ? { library: { type: 'commonjs2' } } : {}),
    },
    resolve: { extensions: ['.tsrx', '.tsx', '.ts', '.js'] },
    module: {
      rules: [
        {
          test: /\.(?:tsrx|[cm]?[jt]sx?)$/,
          type: 'javascript/auto',
          use: [
            { loader: 'builtin:swc-loader', options: { detectSyntax: 'auto' } },
          ],
        },
      ],
    },
    plugins: [plugin],
    optimization: { minimize: false },
  });
  const stats = await new Promise((resolve, reject) => {
    compiler.run((error, stats) => (error ? reject(error) : resolve(stats)));
  });
  try {
    assert.ok(stats, 'Missing compilation stats');
    assert.equal(
      stats.hasErrors(),
      false,
      stats.toString({ all: false, errors: true, errorDetails: true }),
    );
    const modules = [...stats.compilation.modules];
    const identities = modules.map(module => module.identifier());
    assert.equal(
      identities.some(id =>
        /node_modules[/\\](?:react|react-dom)(?:[/\\]|$)/.test(id),
      ),
      false,
    );
    const transformed = modules.flatMap(module => {
      const info = getOctaneRspackBuildInfo(module);
      return info ? [{ resource: module.resource, ...info }] : [];
    });
    assert.ok(
      transformed.some(info => info.resource?.endsWith('Counter.tsrx')),
    );
    assert.ok(transformed.some(info => info.resource?.endsWith('App.tsx')));
    assert.ok(
      transformed.some(
        info =>
          info.resource?.endsWith('plain.ts') && info.transformKind === 'slots',
      ),
    );
    assert.ok(
      transformed.some(
        info =>
          info.resource?.includes('@octanejs/tanstack-router') &&
          info.resource.endsWith('.tsrx'),
      ),
    );
    const artifacts = fs
      .readdirSync(outputPath)
      .filter(file => file.endsWith('.js'))
      .map(file => ({
        file,
        sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(outputPath, file)))
          .digest('hex'),
      }));
    compilationEvidence.push({
      environment,
      transformed,
      artifacts,
      sourceDependencies: plugin.sourceDependencies,
    });
  } finally {
    await new Promise((resolve, reject) =>
      compiler.close(error => (error ? reject(error) : resolve())),
    );
  }
  return outputPath;
}

const serverPath = await compile('server');
await compile('client');
// The Node compiler emits CommonJS while the isolated source package is ESM.
fs.writeFileSync(path.join(serverPath, 'package.json'), '{"type":"commonjs"}');
const server = require(path.join(serverPath, 'server.js'));

async function consume(stream) {
  // Attach rejection immediately. EOF alone is not successful Octane SSR.
  const completion = stream.allReady.then(
    () => ({ ok: true }),
    error => ({ ok: false, error }),
  );
  const html = await new Response(stream).text();
  return { html, completion: await completion };
}

const order = [];
const stream = await server.render(
  {},
  {
    headChannel: 'separate',
    nonce: 'admission-nonce',
    onHeadReady(head) {
      order.push(['head', head]);
    },
    onShellReady() {
      order.push(['shell']);
    },
  },
);
order.push(['returned']);
assert.equal(order[0][0], 'head');
assert.match(order[0][1], /<title>Octane admission<\/title>/);
const success = await consume(stream);
assert.equal(success.completion.ok, true);
assert.match(success.html, /Released Octane/);
assert.match(success.html, /Count: 0/);
assert.match(success.html, /Native lazy component/);
assert.doesNotMatch(success.html, /<title>/);

let resolveDeferred;
const deferred = new Promise(resolve => {
  resolveDeferred = resolve;
});
const deferredStream = await server.render({ deferred }, {});
const reader = deferredStream.getReader();
const deferredCompletion = deferredStream.allReady.then(
  () => ({ ok: true }),
  error => ({ ok: false, error }),
);
const first = await reader.read();
assert.match(new TextDecoder().decode(first.value), /Loading native data/);
resolveDeferred('Native deferred result');
let deferredHtml = new TextDecoder().decode(first.value);
while (true) {
  const chunk = await reader.read();
  if (chunk.done) break;
  deferredHtml += new TextDecoder().decode(chunk.value);
}
assert.match(deferredHtml, /Native deferred result/);
assert.equal((await deferredCompletion).ok, true);

const pending = new Promise(() => {});
const abortController = new AbortController();
const aborted = await server.render(
  { deferred: pending },
  { signal: abortController.signal },
);
const abortCompletion = aborted.allReady.then(
  () => ({ ok: true }),
  error => ({ ok: false, error }),
);
const abortReader = aborted.getReader();
await abortReader.read();
abortController.abort(new DOMException('Admission abort', 'AbortError'));
while (!(await abortReader.read()).done) {}
assert.equal((await abortCompletion).ok, false);

const cancelled = await server.render({ deferred: pending }, {});
const cancelCompletion = cancelled.allReady.then(
  () => ({ ok: true }),
  error => ({ ok: false, error }),
);
const cancelReader = cancelled.getReader();
await cancelReader.read();
await cancelReader.cancel('Admission cancellation');
assert.equal((await cancelCompletion).ok, false);

for (const [url, text] of [
  ['/', 'Native home loader'],
  ['/about', 'Native about loader'],
]) {
  const response = await server.routerRequest(
    new Request(`http://admission.local${url}`, {
      headers: { 'user-agent': 'Mozilla/5.0' },
    }),
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(text));
  assert.match(html, /<html[^>]*lang="en"/);
  assert.match(html, /Native Octane router/);
}

const evidence = {
  buildMode,
  packageVersions,
  nativeArtifact,
  nativeRouterArtifact,
  compilationEvidence,
  node: {
    headBeforeShell: true,
    lazy: true,
    deferred: true,
    abort: true,
    readerCancel: true,
    routerLoaders: true,
  },
};
fs.writeFileSync(
  path.join(
    root,
    buildMode === 'production' ? 'production-evidence.json' : 'evidence.json',
  ),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    admission: 'node-and-compiler-passed',
    buildMode,
    packageVersions,
    nativeArtifact,
    nativeRouterArtifact,
    checks: evidence.node,
  }),
);

if (process.argv.includes('--serve')) {
  let signalRequests = 0;
  const http = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/slow') {
        signalRequests++;
        await new Promise(resolve => setTimeout(resolve, 50));
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('Native streamed signal');
      } else if (url.pathname === '/signal-requests') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ signalRequests }));
      } else if (url.pathname === '/signals') {
        const build = JSON.parse(
          fs.readFileSync(
            path.join(clientOutput, 'octane-client-build.json'),
            'utf8',
          ),
        );
        const identity = {
          buildId: build.buildId,
          documentId: 'octane-admission-document',
          url: `http://127.0.0.1:${http.address().port}/slow`,
        };
        const rendered = await consume(
          await server.renderSignals(
            { url: identity.url },
            {
              streamedSignals: identity,
              earlySignalBootstrap: 'external',
              nonce: 'signal-admission-nonce',
            },
          ),
        );
        assert.equal(rendered.completion.ok, true);
        const bootstrap = server.earlySignalBootstrapScript({
          nonce: 'signal-admission-nonce',
        });
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          `<!doctype html><html><head>${bootstrap}</head><body><div id="app">${rendered.html}</div><script type="application/json" id="signal-identity">${JSON.stringify(identity)}</script><script src="/signals-client.js" defer></script></body></html>`,
        );
      } else if (url.pathname === '/octane-client-build.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          fs.readFileSync(path.join(clientOutput, 'octane-client-build.json')),
        );
      } else if (
        url.pathname.endsWith('.js') ||
        url.pathname.endsWith('.map')
      ) {
        const file = path.join(clientOutput, path.basename(url.pathname));
        assert.ok(file.startsWith(`${clientOutput}${path.sep}`));
        response.writeHead(200, {
          'content-type': url.pathname.endsWith('.map')
            ? 'application/json'
            : 'text/javascript',
        });
        response.end(fs.readFileSync(file));
      } else if (url.pathname === '/app') {
        const result = await consume(await server.render({}, {}));
        assert.equal(result.completion.ok, true);
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          `<!doctype html><html><head></head><body><div id="app">${result.html}</div><script src="/client.js" defer></script></body></html>`,
        );
      } else {
        const result = await server.routerRequest(
          new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
            headers: { 'user-agent': 'Mozilla/5.0' },
          }),
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    }
  });
  http.listen(0, '127.0.0.1', () =>
    console.log(
      JSON.stringify({
        browserAdmissionUrl: `http://127.0.0.1:${http.address().port}`,
      }),
    ),
  );
}
