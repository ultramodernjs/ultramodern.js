#!/usr/bin/env node
// Two-app Solid Module Federation proof, built from workspace source.
//
//   /Users/satan/bin/owned-temp-dir --run solid-federation-proof -- \
//     node tests/ultramodern-renderers/solid-federation/proof.mjs
//
// Builds a remote Solid app exposing ./Widget, a server-rendering Solid host
// and a client-only Solid host that render it with federatedComponent(),
// serves them on random loopback ports, and drives a headless browser through
// agent-browser:
// - the SSR document holds the remote markup, its stylesheet and module
//   preloads; hydration keeps that server node, without warnings, under one
//   solid-js;
// - a remote that is down or exceeds its timeout renders its fallback on the
//   server, with a 200 document;
// - a React-stamped publication of the same container is rejected by the
//   renderer runtime gate on the server and in the browser.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveSourceFederationDependencies } from '../../../scripts/ultramodern-renderers/native-federation-source-dependencies.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = process.env.OWNED_TEMP_DIR;
assert.ok(temporary, 'Run through owned-temp-dir so the apps have an owner.');
const packedHelpers = process.env.ULTRAMODERN_MF_PACKED_CONTEXT
  ? await import(
      '../../../scripts/ultramodern-renderers/native-federation-packed.mjs'
    )
  : undefined;
const packedContext = packedHelpers
  ? await packedHelpers.readPackedNativeFederationContext(
      process.env.ULTRAMODERN_MF_PACKED_CONTEXT,
      'solid',
    )
  : undefined;
const sourceFederation = packedContext
  ? undefined
  : await resolveSourceFederationDependencies(root);
const appTools =
  packedContext?.appToolsRoot ??
  path.join(root, 'packages/solutions/ultramodern-app-tools');
const rendererSolid = path.join(root, 'packages/runtime/renderer-solid');
let browserSession = `lane-mf-proof-${process.pid}`;
const real = (from, request) =>
  fs.realpath(path.join(from, 'node_modules', request));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function linkDependencies(directory) {
  const links = {
    '@modern-js/ultramodern-app-tools': appTools,
    '@modern-js/renderer-solid': rendererSolid,
    '@modern-js/renderer-core': path.join(
      root,
      'packages/runtime/renderer-core',
    ),
    'solid-js': await real(rendererSolid, 'solid-js'),
    '@solidjs/web': await real(rendererSolid, '@solidjs/web'),
    '@solidjs/signals': await real(rendererSolid, '@solidjs/signals'),
    typescript: await real(appTools, 'typescript'),
    '@types/node': await real(appTools, '@types/node'),
    '@module-federation/enhanced': sourceFederation.enhanced.root,
    '@module-federation/node': sourceFederation.node.root,
  };
  for (const [name, target] of Object.entries(links)) {
    const link = path.join(directory, 'node_modules', name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, 'dir');
  }
}

async function writeApp(directory, files) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  if (packedContext)
    await packedHelpers.preparePackedNativeFederationApp({
      directory,
      renderer: 'solid',
      context: packedContext,
    });
  else await linkDependencies(directory);
}

const tsconfig = JSON.stringify({
  compilerOptions: {
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    jsx: 'preserve',
    jsxImportSource: '@solidjs/web',
    strict: true,
    noEmit: true,
    types: ['node'],
  },
  include: [
    'modern.config.ts',
    'module-federation.config.ts',
    'src',
    'node_modules/.modern-js',
  ],
});

const packageJson = name =>
  JSON.stringify({
    name,
    private: true,
    type: 'module',
    dependencies: {
      '@modern-js/ultramodern-app-tools': 'workspace',
      '@modern-js/renderer-solid': 'workspace',
      '@modern-js/renderer-core': 'workspace',
      '@module-federation/enhanced':
        packedContext?.packageRequests['@module-federation/enhanced'] ??
        sourceFederation.enhanced.version,
      '@module-federation/node':
        packedContext?.packageRequests['@module-federation/node'] ??
        sourceFederation.node.version,
      'solid-js': '2.0.0-rc.22',
      '@solidjs/web': '2.0.0-rc.22',
      '@solidjs/signals': '2.0.0-rc.22',
    },
  });

const layout = `import { Outlet } from '@modern-js/renderer-solid/router';
import type { JSX } from '@solidjs/web';
export default function Layout(): JSX.Element {
  return <main><Outlet /></main>;
}
`;

async function ultramodern(directory, command, env) {
  const result = await execute(
    process.execPath,
    [
      packedContext
        ? packedHelpers.installedBin(directory)
        : path.join(appTools, 'bin/ultramodern.mjs'),
      command,
    ],
    {
      cwd: directory,
      env: { ...process.env, NODE_PATH: '', ...env },
      maxBuffer: 32 * 1024 * 1024,
    },
  ).catch(error => {
    process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}`);
    throw error;
  });
  return result;
}

function staticServer(directory, extra) {
  const types = {
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.html': 'text/html',
  };
  return createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    const pathname = decodeURIComponent(
      new URL(request.url, 'http://x').pathname,
    );
    // A remote that accepts the connection and never answers.
    if (pathname.startsWith('/hang/')) return;
    if (extra[pathname]) {
      response.setHeader('content-type', 'application/json');
      response.end(extra[pathname]);
      return;
    }
    const file = path.join(directory, path.normalize(pathname));
    if (!file.startsWith(directory)) return void response.writeHead(403).end();
    try {
      const body = await fs.readFile(file);
      response.setHeader(
        'content-type',
        types[path.extname(file)] ?? 'application/octet-stream',
      );
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
}

/**
 * Forward to the host and mark the server-rendered remote node with a classic
 * script that runs before any module script, so the browser check can tell a
 * hydrated node from a remounted one.
 */
function markingProxy(target) {
  const marker = `<script>window.__ssrRemoteWidget = document.querySelector('[data-testid="remote-widget"]');</script>`;
  return createServer(async (request, response) => {
    const upstream = await fetch(new URL(request.url, target), {
      headers: { accept: request.headers.accept ?? '*/*' },
    });
    const type = upstream.headers.get('content-type') ?? '';
    response.statusCode = upstream.status;
    if (type) response.setHeader('content-type', type);
    if (!type.includes('text/html')) {
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const html = await upstream.text();
    const root = html.indexOf('id="root"');
    const modules = html.indexOf('<script type="module"', root);
    assert.ok(root > 0 && modules > root, 'the document hydrates its root');
    response.end(html.slice(0, modules) + marker + html.slice(modules));
  });
}

async function browser(...args) {
  const { stdout } = await execute('agent-browser', args, {
    env: {
      ...process.env,
      AGENT_BROWSER_SESSION: browserSession,
      AGENT_BROWSER_HEADED: 'false',
    },
    maxBuffer: 8 * 1024 * 1024,
    // A cold agent-browser daemon can take about a minute to start Chrome.
    timeout: 180_000,
  });
  return stdout.trim();
}

const evaluate = async source =>
  JSON.parse(JSON.parse(await browser('eval', `JSON.stringify(${source})`)));

async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`,
  );
}

const shareScopeSource = `(() => {
  const instance = globalThis.__FEDERATION__.__INSTANCES__.find(item => item.name === 'host');
  const scope = instance.shareScopeMap.default;
  return Object.fromEntries(['solid-js', '@solidjs/web', '@solidjs/signals'].map(name => [
    name,
    Object.entries(scope[name] ?? {}).map(([version, shared]) => ({ version, from: shared.from, loaded: Boolean(shared.loaded || shared.lib) })),
  ]));
})()`;

async function exerciseRemoteWidget(result) {
  result.owner = await browser(
    'get',
    'attr',
    '[data-testid="remote-widget"]',
    'data-owner',
  );
  result.labelBefore = await browser(
    'get',
    'text',
    '[data-testid="remote-label"]',
  );
  await browser('click', '[data-testid="remote-increment"]');
  await browser('click', '[data-testid="remote-increment"]');
  result.counter = await browser(
    'get',
    'text',
    '[data-testid="remote-increment"]',
  );
  await browser('click', '[data-testid="host-relabel"]');
  result.labelAfter = await browser(
    'get',
    'text',
    '[data-testid="remote-label"]',
  );
  result.color = await evaluate(
    `getComputedStyle(document.querySelector('[data-testid="remote-widget"]')).color`,
  );
  result.reactRejected = await waitFor(
    async () => browser('get', 'text', '[data-testid="react-rejected"]'),
    'React remote rejection',
  );
  result.shareScope = await evaluate(shareScopeSource);
  result.console = await browser('console');
  result.pageErrors = await browser('errors');
  assert.equal(result.owner, 'host-owned');
  assert.equal(result.labelBefore, 'from host');
  assert.equal(result.counter, 'Count 2');
  assert.equal(result.labelAfter, 'relabelled');
  assert.equal(result.color, 'rgb(1, 2, 3)', 'the remote stylesheet applies');
  assert.match(result.reactRejected, /Renderer federation manifest contract/u);
  for (const [name, versions] of Object.entries(result.shareScope))
    assert.equal(versions.length, 1, `${name} has exactly one shared version`);
  assert.equal(result.pageErrors, '', 'no uncaught page errors');
  assert.doesNotMatch(result.console, /hydrat/iu, 'no hydration diagnostics');
}

async function verifySSRInBrowser() {
  const result = (results.ssrBrowser = {});
  await browser('open', proxyUrl);
  await waitFor(
    async () =>
      (await browser('get', 'text', '[data-testid="remote-increment"]')) ===
        'Count 0' && (await evaluate(`Boolean(globalThis._$HY?.done)`)),
    'hydrated remote widget',
  );
  // Hydration claimed the server-rendered node instead of remounting it.
  result.retainedSSRNode = await evaluate(
    `window.__ssrRemoteWidget !== null && window.__ssrRemoteWidget === document.querySelector('[data-testid="remote-widget"]') && window.__ssrRemoteWidget.isConnected`,
  );
  result.fallbackShown = await browser(
    'get',
    'count',
    '[data-testid="remote-fallback"]',
  );
  await exerciseRemoteWidget(result);
  result.slowFailed = await waitFor(
    async () => browser('get', 'text', '[data-testid="slow-failed"]'),
    'slow remote failure in the browser',
  );
  result.clickedSSRNode = await evaluate(
    `window.__ssrRemoteWidget.querySelector('[data-testid="remote-increment"]').textContent`,
  );
  assert.equal(result.retainedSSRNode, true, 'the SSR remote node is retained');
  assert.equal(result.fallbackShown, '0', 'hydration never showed a fallback');
  assert.equal(result.clickedSSRNode, 'Count 2', 'the SSR node is interactive');
  assert.match(result.slowFailed, /did not load within 1000ms/u);
  await browser('close');
}

async function verifyCSRInBrowser() {
  const result = (results.csrBrowser = {});
  // A separate session: no page state carries over from the SSR document.
  browserSession = `${browserSession}-csr`;
  await browser('open', csrUrl);
  await waitFor(
    async () =>
      (await browser('get', 'url')).startsWith(csrUrl) &&
      (await browser('get', 'count', '[data-testid="remote-widget"]')) === '1',
    'client-rendered remote widget',
  );
  await exerciseRemoteWidget(result);
  await browser('close');
}

async function startHost(directory, port) {
  const child = spawn(
    process.execPath,
    [
      packedContext
        ? packedHelpers.installedBin(directory)
        : path.join(appTools, 'bin/ultramodern.mjs'),
      'serve',
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        NODE_PATH: '',
        PORT: String(port),
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.log = '';
  child.stdout.on('data', chunk => (child.log += chunk));
  child.stderr.on('data', chunk => (child.log += chunk));
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(url)).status > 0, 'host server').catch(
    error => {
      process.stderr.write(child.log);
      throw error;
    },
  );
  return child;
}

async function document(url) {
  const started = Date.now();
  const response = await fetch(url);
  return {
    status: response.status,
    html: await response.text(),
    ms: Date.now() - started,
  };
}

const remotePort = await freePort();
const hostPort = await freePort();
const proxyPort = await freePort();
const csrPort = await freePort();
const remoteUrl = `http://127.0.0.1:${remotePort}`;
const hostUrl = `http://127.0.0.1:${hostPort}`;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const csrUrl = `http://127.0.0.1:${csrPort}`;
const remoteDirectory = path.join(temporary, 'remote');
const hostDirectory = path.join(temporary, 'host');
const csrDirectory = path.join(temporary, 'host-csr');
const children = [];
let remoteServer;
let proxy;
const results = {};

const hostConfig = `export default {
  name: 'host',
  remotes: {
    remote: 'remote@${remoteUrl}/mf-manifest.json',
    reactremote: 'reactremote@${remoteUrl}/react/mf-manifest.json',
    slowremote: 'slowremote@${remoteUrl}/hang/mf-manifest.json',
  },
};
`;

const hostPage = `import { federatedComponent } from '@modern-js/renderer-solid/federation';
import type { JSX } from '@solidjs/web';
import { createSignal, Errored } from 'solid-js';

const RemoteWidget = federatedComponent<{ label: string }>('remote/Widget', {
  fallback: () => <p data-testid="remote-fallback">Loading remote</p>,
});
const ReactWidget = federatedComponent<{ label: string }>('reactremote/Widget');
const SlowWidget = federatedComponent<{ label: string }>('slowremote/Widget', {
  timeout: 1000,
  fallback: () => <p data-testid="slow-fallback">Slow remote</p>,
});
const message = (error: unknown) => String(typeof error === 'function' ? error() : error);

export default function Home(): JSX.Element {
  const [label, setLabel] = createSignal('from host');
  return (
    <section>
      <h1 data-testid="host-title">Solid host</h1>
      <button type="button" data-testid="host-relabel" onClick={() => setLabel('relabelled')}>Relabel</button>
      <RemoteWidget label={label()} />
      <Errored fallback={error => <p data-testid="react-rejected">{message(error)}</p>}>
        <ReactWidget label="react" />
      </Errored>
      <Errored fallback={error => <p data-testid="slow-failed">{message(error)}</p>}>
        <SlowWidget label="slow" />
      </Errored>
    </section>
  );
}
`;

try {
  await writeApp(remoteDirectory, {
    'package.json': packageJson('mf-proof-remote'),
    'tsconfig.json': tsconfig,
    'modern.config.ts': `import { defineConfig } from '@modern-js/ultramodern-app-tools';
export default defineConfig({ renderer: 'solid', output: { assetPrefix: '${remoteUrl}/' } });
`,
    'module-federation.config.ts': `export default {
  name: 'remote',
  exposes: { './Widget': './src/components/Widget.tsx' },
};
`,
    'src/routes/layout.tsx': layout,
    'src/routes/page.tsx': `import Widget from '../components/Widget';
export default function Page() { return <Widget label="standalone" />; }
`,
    'src/components/Widget.css': `.remote-widget { color: rgb(1, 2, 3); }\n`,
    'src/env.d.ts': `declare module '*.css';\n`,
    'src/components/Widget.tsx': `import { createSignal, getOwner } from 'solid-js';
import type { JSX } from '@solidjs/web';
import './Widget.css';
export default function Widget(props: { label: string }): JSX.Element {
  const [count, setCount] = createSignal(0);
  // A second solid-js copy would have no owner: the host renders this component.
  const owner = getOwner() ? 'host-owned' : 'detached';
  return (
    <div class="remote-widget" data-testid="remote-widget" data-owner={owner}>
      <span data-testid="remote-label">{props.label}</span>
      <button type="button" data-testid="remote-increment" onClick={() => setCount(value => value + 1)}>
        Count {count()}
      </button>
    </div>
  );
}
`,
  });
  for (const [directory, name, ssr] of [
    [hostDirectory, 'mf-proof-host', true],
    [csrDirectory, 'mf-proof-host-csr', false],
  ])
    await writeApp(directory, {
      'package.json': packageJson(name),
      'tsconfig.json': tsconfig,
      'modern.config.ts': `import { defineConfig } from '@modern-js/ultramodern-app-tools';
export default defineConfig({ renderer: 'solid', server: { ssr: ${ssr} }, output: { assetPrefix: '/' } });
`,
      'module-federation.config.ts': hostConfig,
      'src/routes/layout.tsx': layout,
      'src/routes/page.tsx': hostPage,
    });

  await ultramodern(remoteDirectory, 'build');
  const remoteDist = path.join(remoteDirectory, 'dist');
  const manifest = JSON.parse(
    await fs.readFile(path.join(remoteDist, 'mf-manifest.json'), 'utf8'),
  );
  results.remoteManifest = {
    remoteEntry: manifest.metaData.remoteEntry,
    ssrRemoteEntry: manifest.metaData.ssrRemoteEntry,
    publicPath: manifest.metaData.publicPath,
    ssrPublicPath: manifest.metaData.ssrPublicPath,
    renderer: manifest.metaData.ultramodernRenderer?.profile?.renderer,
    shared: manifest.shared.map(item => `${item.name}@${item.version}`).sort(),
  };
  assert.equal(results.remoteManifest.renderer, 'solid');
  assert.equal(results.remoteManifest.ssrRemoteEntry?.type, 'commonjs-module');
  assert.equal(results.remoteManifest.ssrPublicPath, `${remoteUrl}/bundles/`);
  await fs.access(path.join(remoteDist, 'bundles', 'remoteEntry.js'));

  // The same container, published under the React renderer tuple.
  let react;
  if (packedContext)
    react = {
      profile: {
        ...manifest.metaData.ultramodernRenderer.profile,
        renderer: 'react',
      },
    };
  else {
    const { resolveReactFederationCompatibility } = await import(
      pathToFileURL(
        path.join(
          appTools,
          'dist/esm-node/renderers/react/module-federation.mjs',
        ),
      ).href
    );
    react = resolveReactFederationCompatibility();
  }
  const reactManifest = structuredClone(manifest);
  const contract = reactManifest.metaData.ultramodernRenderer;
  reactManifest.name = 'reactremote';
  reactManifest.metaData.name = 'reactremote';
  reactManifest.metaData.ultramodernRenderer = {
    ...contract,
    ...react,
    identities: Object.fromEntries(
      Object.entries(contract.identities).map(([entry, identity]) => [
        entry,
        { ...identity, renderer: 'react' },
      ]),
    ),
  };
  remoteServer = staticServer(remoteDist, {
    '/react/mf-manifest.json': JSON.stringify(reactManifest),
  });

  await ultramodern(hostDirectory, 'build');
  await ultramodern(csrDirectory, 'build');

  // The remote is down: the host still answers 200 with the fallbacks.
  const host = await startHost(hostDirectory, hostPort);
  const down = await document(hostUrl);
  results.remoteDown = {
    status: down.status,
    fallback: down.html.includes('data-testid="remote-fallback"'),
    widget: down.html.includes('data-testid="remote-widget"'),
    ms: down.ms,
  };
  assert.equal(results.remoteDown.status, 200);
  assert.equal(results.remoteDown.fallback, true);
  assert.equal(results.remoteDown.widget, false);
  assert.equal(host.exitCode, null, 'the host survives an unavailable remote');

  await new Promise(resolve =>
    remoteServer.listen(remotePort, '127.0.0.1', resolve),
  );
  const up = await document(hostUrl);
  const link = (rel, href) =>
    new RegExp(
      `<link(?=[^>]*rel="${rel}")(?=[^>]*href="${href.replace(/[.?/]/gu, '\\$&')}")[^>]*>`,
      'u',
    ).test(up.html);
  const remoteCss = manifest.exposes
    .find(expose => expose.path === './Widget')
    .assets.css.sync.map(file => `${remoteUrl}/${file}`);
  results.ssr = {
    status: up.status,
    ms: up.ms,
    widget: up.html.includes('data-testid="remote-widget"'),
    ownerOnServer:
      /data-testid="remote-widget"[^>]*data-owner="host-owned"|data-owner="host-owned"[^>]*data-testid="remote-widget"/u.test(
        up.html,
      ),
    label: up.html.includes('>from host</span>'),
    fallback: up.html.includes('data-testid="remote-fallback"'),
    remoteCss,
    cssLinked:
      remoteCss.length > 0 && remoteCss.every(href => link('stylesheet', href)),
    remoteEntryPreloaded: link('modulepreload', `${remoteUrl}/remoteEntry.js`),
    hydrationModule:
      /ultramodern-federation-hydration\.[0-9a-f]{8}\.js\?id=remote%2FWidget/u.test(
        up.html,
      ),
    slowFallback: up.html.includes('data-testid="slow-fallback"'),
    reactFallbackOnly: !up.html.includes('data-testid="react-rejected"'),
  };
  assert.equal(results.ssr.status, 200);
  assert.equal(results.ssr.widget, true, 'SSR HTML holds the remote markup');
  assert.equal(results.ssr.ownerOnServer, true, 'one solid-js on the server');
  assert.equal(results.ssr.label, true);
  assert.equal(results.ssr.fallback, false);
  assert.equal(results.ssr.cssLinked, true, 'SSR links the remote stylesheet');
  assert.equal(results.ssr.remoteEntryPreloaded, true);
  assert.equal(results.ssr.hydrationModule, true);
  assert.equal(results.ssr.slowFallback, true, 'a slow remote times out');
  assert.ok(results.ssr.ms < 5000, 'the slow remote cannot hold the document');

  // The remote's own server bundle reaches its renderer through the same
  // import() boundary and still answers its documents.
  const ownPort = await freePort();
  await startHost(remoteDirectory, ownPort);
  const own = await document(`http://127.0.0.1:${ownPort}`);
  results.remoteOwnDocument = {
    status: own.status,
    root: own.html.includes('id="root"'),
  };
  assert.equal(results.remoteOwnDocument.status, 200);
  assert.equal(results.remoteOwnDocument.root, true);

  proxy = markingProxy(hostUrl);
  await new Promise(resolve => proxy.listen(proxyPort, '127.0.0.1', resolve));
  await startHost(csrDirectory, csrPort);

  if (process.env.MF_PROOF_HOLD) {
    // Debugging: keep the servers up until this process is terminated.
    process.stdout.write(
      `${JSON.stringify({ hostUrl, proxyUrl, csrUrl, remoteUrl, temporary })}\n`,
    );
    await new Promise(resolve => process.once('SIGTERM', resolve));
    results.verdict = 'HELD';
  } else {
    await verifySSRInBrowser();
    await verifyCSRInBrowser();
    results.verdict = 'PASS';
  }
} finally {
  if (!results.verdict) {
    results.verdict = 'FAIL';
    results.console = await browser('console').catch(error => String(error));
    results.pageErrors = await browser('errors').catch(error => String(error));
    results.html = await browser('get', 'html', 'body').catch(error =>
      String(error),
    );
    results.hostLogs = children.map(child => child.log.slice(-4000));
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  await browser('close').catch(() => {});
  for (const child of children) child.kill('SIGTERM');
  for (const server of [remoteServer, proxy])
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
}
