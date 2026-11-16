#!/usr/bin/env node
// Three-app Octane Module Federation proof, built from workspace source.
//
//   owned-temp-dir --run octane-federation-proof -- \
//     node tests/ultramodern-renderers/octane-federation/proof.mjs
//
// Builds a remote Octane app exposing ./Widget, a server-rendering Octane host
// and a client-only Octane host that render it with federatedComponent(),
// serves them on random loopback ports, and drives a headless browser through
// agent-browser:
// - the SSR document holds the remote markup and its stylesheet; hydration
//   keeps that server node, without warnings, under one
//   Octane runtime and host-owned router context;
// - a remote that is down or exceeds its timeout renders its fallback on the
//   server, with a 200 document;
// - a failed server container recovers in the browser and on a later server
//   request in the same host process after the container becomes available;
// - a React-stamped publication of the same container is rejected by the
//   renderer runtime gate on the server and in the browser.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveDiskGuardian } from '../../../scripts/ultramodern-production-readiness/renderer-worker-lifecycle-proof/support.mjs';
import {
  createOctaneFederationFixtures,
  decodeOctaneSSRDocument,
  linkOctaneFederationDependencies,
} from './fixtures.mjs';
import { createSSRMarkerProxy } from './marker-proxy.mjs';

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
      'octane',
    )
  : undefined;
if (packedContext)
  assert.equal(path.resolve(temporary), path.resolve(packedContext.workRoot));
const appTools =
  packedContext?.appToolsRoot ??
  path.join(root, 'packages/solutions/ultramodern-app-tools');
let browserSession = `octane-mf-proof-${process.pid}`;
const openedSessions = new Set();
const children = [];
const httpServers = new Set();
const artifacts = new Set();
const owner = `octane-mf-proof-${process.pid}`;
const cancellation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(signal, () =>
    cancellation.abort(new Error(`Received ${signal}`)),
  );

// On a runner there is no guardian: the job's own directory lease owns this
// tree, and the proof's subject is Octane federation, not disk accounting.
// A configured guardian that cannot run still fails this proof loudly.
const guardian = resolveDiskGuardian();

async function registerArtifact(directory, kind) {
  await fs.mkdir(directory, { recursive: true });
  if (guardian)
    await execute(guardian, [
      'register',
      directory,
      '--owner',
      owner,
      '--owner-pid',
      String(process.pid),
      '--kind',
      kind,
      '--grace-hours',
      '24',
    ]);
  artifacts.add(directory);
}

function nodeProcess(directory, arguments_, env) {
  cancellation.signal.throwIfAborted();
  const child = spawn(process.execPath, arguments_, {
    cwd: directory,
    env: { ...process.env, NODE_PATH: '', ...env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.directory = directory;
  child.log = '';
  const append = chunk => {
    child.log = (child.log + chunk).slice(-32 * 1024 * 1024);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.exited = new Promise(resolve => {
    child.once('error', error => {
      child.failure = error;
      resolve({ code: null, signal: null });
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.completion = new Promise(resolve => {
    child.once('close', () => {
      child.closed = true;
      resolve();
    });
  });
  children.push(child);
  const abort = () => {
    void stopChild(child).catch(error => {
      child.cleanupFailure = error;
    });
  };
  cancellation.signal.addEventListener('abort', abort, { once: true });
  void child.completion.then(() =>
    cancellation.signal.removeEventListener('abort', abort),
  );
  return child;
}

async function recordPackedChild(child) {
  if (!packedContext || !child.pid) return;
  try {
    packedHelpers.recordPackedNativeFederationProcess(
      path.join(
        packedContext.workRoot,
        'process-witnesses',
        `${child.pid}.json`,
      ),
      child.pid,
    );
  } catch (error) {
    // A short-lived startup failure can finish before ps records its birth.
    await new Promise(resolve => setImmediate(resolve));
    if (
      child.failure ||
      (child.exitCode !== null && child.exitCode !== 0) ||
      child.signalCode !== null
    )
      return;
    await stopChild(child);
    throw error;
  }
}

async function groupIsAlive(child) {
  if (!child.pid) return false;
  if (process.platform === 'win32')
    return child.exitCode === null && child.signalCode === null;
  const leaderHadExited = child.exitCode !== null || child.signalCode !== null;
  const { stdout } = await execute('ps', ['-axo', 'pid=,pgid=,uid='], {
    timeout: 2000,
  });
  const rows = stdout
    .trim()
    .split('\n')
    .map(line => {
      const values = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)$/u);
      assert.ok(values, 'ps returned a process identity');
      return values.slice(1).map(Number);
    })
    .filter(([, group]) => group === child.pid);
  assert.ok(
    rows.every(([, , uid]) => uid === process.getuid()),
    'the proof owns every member of its process group',
  );
  // Once the original leader closes, a new leader with this PID belongs to a
  // different process lifetime. Never signal a reused process group.
  if (leaderHadExited && rows.some(([pid]) => pid === child.pid))
    throw new Error('The proof process group identity was reused.');
  return rows.length > 0;
}

async function killChild(child, signal) {
  if (!(await groupIsAlive(child))) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stopChild(child) {
  if (child.retirement) return child.retirement;
  child.retirement = (async () => {
    await killChild(child, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (await groupIsAlive(child)) {
      if (Date.now() >= deadline) {
        await killChild(child, 'SIGKILL');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const killedDeadline = Date.now() + 5000;
    while (!child.closed || (await groupIsAlive(child))) {
      if (Date.now() >= killedDeadline)
        throw new Error('The proof process group or its pipes did not retire.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await child.completion;
  })();
  return child.retirement;
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
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
      renderer: 'octane',
      context: packedContext,
      registerArtifact,
    });
  else
    await linkOctaneFederationDependencies({
      root,
      directory,
      registerArtifact,
    });
}

async function ultramodern(directory, command, env) {
  if (command === 'build')
    await registerArtifact(path.join(directory, 'dist'), 'build');
  const child = nodeProcess(
    directory,
    [
      packedHelpers
        ? packedHelpers.installedBin(directory)
        : path.join(appTools, 'bin/ultramodern.mjs'),
      command,
    ],
    env,
  );
  await recordPackedChild(child);
  const result = await child.exited;
  await stopChild(child);
  cancellation.signal.throwIfAborted();
  if (child.failure || result.code !== 0) {
    process.stderr.write(child.log);
    throw (
      child.failure ??
      new Error(`UltraModern ${command} exited ${result.code ?? result.signal}`)
    );
  }
  return result;
}

function ownedHTTPServer(handler) {
  const server = createServer(handler);
  httpServers.add(server);
  return server;
}

async function listen(server, port) {
  cancellation.signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', failed);
      cancellation.signal.removeEventListener('abort', aborted);
    };
    const failed = error => {
      cleanup();
      reject(error);
    };
    const aborted = () => failed(cancellation.signal.reason);
    server.once('error', failed);
    cancellation.signal.addEventListener('abort', aborted, { once: true });
    try {
      server.listen(
        { port, host: '127.0.0.1', signal: cancellation.signal },
        () => {
          cleanup();
          resolve();
        },
      );
    } catch (error) {
      failed(error);
    }
  });
}

function staticServer(directory, extra, control) {
  const types = {
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.html': 'text/html',
  };
  return ownedHTTPServer((request, response) => {
    void (async () => {
      response.setHeader('access-control-allow-origin', '*');
      const pathname = decodeURIComponent(
        new URL(request.url, 'http://x').pathname,
      );
      // A remote that accepts the connection and never answers.
      if (pathname.startsWith('/hang/')) return;
      if (pathname.startsWith('/bundles/')) {
        control.serverRequests.push({ pathname, failure: control.failure });
        if (control.failure === 'hung') return;
        if (control.failure === 'down')
          return void response.writeHead(503).end('SSR container unavailable');
      }
      if (extra[pathname]) {
        response.setHeader('content-type', 'application/json');
        response.end(extra[pathname]);
        return;
      }
      const file = path.resolve(directory, `.${pathname}`);
      if (!file.startsWith(`${directory}${path.sep}`))
        return void response.writeHead(403).end();
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
    })().catch(error => {
      response.writeHead(500).end(String(error));
    });
  });
}

function markingProxy(target) {
  const server = createSSRMarkerProxy({ target, signal: cancellation.signal });
  httpServers.add(server);
  return server;
}

async function browserWithTimeout(timeout, ...args) {
  if (args[0] === 'open') openedSessions.add(browserSession);
  const { stdout } = await execute('agent-browser', args, {
    env: {
      ...process.env,
      AGENT_BROWSER_SESSION: browserSession,
      AGENT_BROWSER_HEADED: 'false',
    },
    maxBuffer: 8 * 1024 * 1024,
    // A cold agent-browser daemon can take about a minute to start Chrome.
    timeout,
    signal: cancellation.signal,
  });
  if (args[0] === 'close') openedSessions.delete(browserSession);
  return stdout.trim();
}

const browser = (...args) => browserWithTimeout(180_000, ...args);

const evaluate = async source =>
  JSON.parse(JSON.parse(await browser('eval', `JSON.stringify(${source})`)));

async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted();
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
  return Object.fromEntries(['octane', 'octane/signals/client', '@modern-js/renderer-octane/router', '@octanejs/tanstack-router'].map(name => [
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
  result.path = await browser(
    'get',
    'attr',
    '[data-testid="remote-widget"]',
    'data-path',
  );
  result.counterBefore = await browser(
    'get',
    'text',
    '[data-testid="remote-increment"]',
  );
  assert.equal(result.counterBefore, 'Count 0');
  await browser('click', '[data-testid="remote-increment"]');
  await waitFor(
    async () =>
      (await browser('get', 'text', '[data-testid="remote-increment"]')) ===
      'Count 1',
    'the first native signal update',
  );
  await browser('click', '[data-testid="remote-increment"]');
  await waitFor(
    async () =>
      (await browser('get', 'text', '[data-testid="remote-increment"]')) ===
      'Count 2',
    'the second native signal update',
  );
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
  result.remoteModuleRequested = await evaluate(
    `performance.getEntriesByType('resource').some(entry => entry.name === ${JSON.stringify(`${remoteUrl}/remoteEntry.js`)})`,
  );
  result.reactRejected = await waitFor(
    async () => browser('get', 'text', '[data-testid="react-rejected"]'),
    'React remote rejection',
  );
  result.shareScope = await evaluate(shareScopeSource);
  result.console = await browser('console');
  result.pageErrors = await browser('errors');
  assert.equal(result.owner, 'host-owned');
  assert.equal(result.path, '/');
  assert.equal(result.labelBefore, 'from host');
  assert.equal(result.counter, 'Count 2');
  assert.equal(result.labelAfter, 'relabelled');
  assert.equal(
    await browser('get', 'text', '[data-testid="remote-increment"]'),
    'Count 2',
    'a host props update preserves the remote signal',
  );
  result.browserVersion = await evaluate('navigator.userAgent');
  await evaluate(`(() => {
    const button = document.querySelector('[data-testid="remote-increment"]');
    window.__nativeRapidClicks = [];
    button.addEventListener('click', event => {
      const observation = { detail: event.detail, timeStamp: event.timeStamp, isTrusted: event.isTrusted, before: button.textContent };
      window.__nativeRapidClicks.push(observation);
      queueMicrotask(() => { observation.afterMicrotask = button.textContent; });
      requestAnimationFrame(() => { observation.afterFrame = button.textContent; });
    }, { capture: true });
    return true;
  })()`);
  // The installed agent-browser dblclick command emits one click(detail=2).
  // Two ordinary native clicks provide the two trusted cycles required here.
  await browser('click', '[data-testid="remote-increment"]');
  await browser('click', '[data-testid="remote-increment"]');
  await waitFor(
    async () =>
      (await browser('get', 'text', '[data-testid="remote-increment"]')) ===
      'Count 4',
    'both rapid native signal updates after hydration',
    5000,
  );
  result.counterAfterRapidClicks = await browser(
    'get',
    'text',
    '[data-testid="remote-increment"]',
  );
  result.rapidClickEvents = await evaluate('window.__nativeRapidClicks');
  assert.equal(result.rapidClickEvents.length, 2, 'two native clicks occurred');
  assert.ok(result.rapidClickEvents.every(event => event.isTrusted));
  assert.equal(result.counterAfterRapidClicks, 'Count 4');
  result.console = await browser('console');
  result.pageErrors = await browser('errors');
  assert.equal(result.color, 'rgb(1, 2, 3)', 'the remote stylesheet applies');
  assert.equal(
    result.remoteModuleRequested,
    true,
    'native MF requests the remote module',
  );
  assert.match(
    result.reactRejected,
    /Renderer federation manifest contract: rendererProfile\.renderer: cross-renderer components are unsupported\./u,
  );
  for (const [name, versions] of Object.entries(result.shareScope)) {
    assert.equal(versions.length, 1, `${name} has exactly one shared version`);
    assert.equal(versions[0].loaded, true, `${name} loads the shared runtime`);
  }
  assert.equal(result.pageErrors, '', 'no uncaught page errors');
  assert.doesNotMatch(result.console, /hydrat/iu, 'no hydration diagnostics');
}

async function verifySSRInBrowser() {
  browserSession = owner;
  const result = (results.ssrBrowser = {});
  await browser('open', proxyUrl);
  await waitFor(
    async () =>
      (await browser('get', 'text', '[data-testid="remote-increment"]')) ===
        'Count 0' &&
      (await browser(
        'get',
        'attr',
        '[data-testid="remote-widget"]',
        'data-hydrated',
      )) === 'true',
    'hydrated remote widget',
  );
  // Hydration claimed the server-rendered node instead of remounting it.
  result.retainedSSRNode = await evaluate(
    `window.__ssrRemoteWidget !== null && window.__ssrRemoteWidget === document.querySelector('[data-testid="remote-widget"]') && window.__ssrRemoteWidget.isConnected`,
  );
  result.markerBeforeHydration = !(await evaluate(
    'window.__ssrRemoteAlreadyHydrated',
  ));
  result.entryScripts = await evaluate('window.__ssrEntryScripts');
  result.fallbackShown = await browser(
    'get',
    'count',
    '[data-testid="remote-fallback"]',
  );
  result.fallbackSeenDuringHydration = await evaluate(
    'window.__remoteFallbackSeen',
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
  assert.equal(
    result.markerBeforeHydration,
    true,
    'SSR DOM is captured before the native hydration effect',
  );
  assert.ok(result.entryScripts.length > 0);
  result.entryBarrier = proxy.proof;
  assert.equal(result.entryBarrier.markerCaptured, true);
  assert.equal(
    result.entryBarrier.deliveredEntries.length,
    result.entryScripts.length,
    'the browser requests each native entry through the barrier',
  );
  assert.ok(
    result.entryBarrier.deliveredEntries.every(entry => entry.markerCaptured),
    'native entry responses arrive after the SSR marker captures its nodes',
  );
  assert.equal(result.fallbackShown, '0', 'hydration never showed a fallback');
  assert.equal(
    result.fallbackSeenDuringHydration,
    false,
    'hydration never inserted its loading fallback',
  );
  assert.equal(
    result.clickedSSRNode,
    result.counterAfterRapidClicks,
    'native clicks update the retained SSR node',
  );
  assert.match(result.slowFailed, /did not load within 1000ms/u);
  await browser('close');
}

async function verifyCSRInBrowser() {
  const result = (results.csrBrowser = {});
  // A separate session: no page state carries over from the SSR document.
  browserSession = `${owner}-csr`;
  await browser('open', csrUrl);
  await waitFor(
    async () =>
      (await browser('get', 'url')).startsWith(csrUrl) &&
      (await browser('get', 'count', '[data-testid="remote-widget"]')) ===
        '1' &&
      (await browser(
        'get',
        'attr',
        '[data-testid="remote-widget"]',
        'data-hydrated',
      )) === 'true',
    'client-rendered remote widget',
  );
  await exerciseRemoteWidget(result);
  await browser('close');
}

async function verifyServerFailureInBrowser(url, failure, result) {
  browserSession = `${owner}-recover-${failure}`;
  await browser('open', url);
  await waitFor(
    async () =>
      (await browser('get', 'text', '[data-testid="remote-increment"]')) ===
        'Count 0' &&
      (await browser(
        'get',
        'attr',
        '[data-testid="remote-widget"]',
        'data-hydrated',
      )) === 'true',
    `browser recovery from the ${failure} server container`,
  );
  result.initialSSRWidget = await evaluate('window.__ssrRemoteWidget !== null');
  result.initialFallback = await evaluate('window.__remoteFallbackSeen');
  result.widgetCount = await browser(
    'get',
    'count',
    '[data-testid="remote-widget"]',
  );
  result.remainingFallbacks = await browser(
    'get',
    'count',
    '[data-testid="remote-fallback"]',
  );
  assert.equal(result.initialSSRWidget, false, 'the server container failed');
  assert.equal(result.initialFallback, true, 'the SSR fallback was visible');
  assert.equal(result.widgetCount, '1', 'one native remote root recovers');
  assert.equal(
    result.remainingFallbacks,
    '0',
    'the browser replaces the fallback',
  );
  await exerciseRemoteWidget(result);
  await browser('close');
}

async function startHost(directory, port) {
  const child = nodeProcess(
    directory,
    [
      packedHelpers
        ? packedHelpers.installedBin(directory)
        : path.join(appTools, 'bin/ultramodern.mjs'),
      'serve',
    ],
    {
      PORT: String(port),
      NODE_ENV: 'production',
    },
  );
  await recordPackedChild(child);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    const response = await fetch(url, {
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
    });
    await response.arrayBuffer();
    return response.status > 0;
  }, 'host server').catch(error => {
    process.stderr.write(child.log);
    throw error;
  });
  return child;
}

async function document(url) {
  const started = Date.now();
  const response = await fetch(url, {
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]),
  });
  const html = await response.text();
  return {
    status: response.status,
    html,
    ...decodeOctaneSSRDocument(html),
    ms: Date.now() - started,
  };
}

async function verifyServerEntryRecovery(failure) {
  remoteControl.failure = failure;
  const requestStart = remoteControl.serverRequests.length;
  let failureHost;
  let failureProxy;
  try {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    failureHost = await startHost(hostDirectory, port);
    const failed = await document(url);
    const result = (results[
      failure === 'down' ? 'serverEntryDown' : 'serverEntryHung'
    ] = {
      status: failed.status,
      ms: failed.ms,
      fallback: failed.html.includes('data-testid="remote-fallback"'),
      widget: failed.html.includes('data-testid="remote-widget"'),
      containerRequested: remoteControl.serverRequests
        .slice(requestStart)
        .some(
          request =>
            request.failure === failure &&
            request.pathname === '/bundles/remoteEntry.js',
        ),
      browser: {},
    });
    assert.equal(result.status, 200);
    assert.equal(result.fallback, true);
    assert.equal(result.widget, false);
    assert.equal(
      result.containerRequested,
      true,
      'the real server entry failed',
    );
    assert.ok(
      result.ms < 5000,
      'a failed server entry cannot hold the document',
    );
    const proxyPort = await freePort();
    failureProxy = markingProxy(url);
    await listen(failureProxy, proxyPort);
    await verifyServerFailureInBrowser(
      `http://127.0.0.1:${proxyPort}`,
      failure,
      result.browser,
    );
    result.requestsBeforeRestore = remoteControl.serverRequests.length;
    remoteControl.failure = undefined;
    const restored = await document(url);
    result.requestsAfterRestore = remoteControl.serverRequests.length;
    result.restoredStatus = restored.status;
    result.sameHostRecovered = restored.markup.includes(
      'data-testid="remote-widget"',
    );
    result.renderErrors =
      failureHost.log.match(/^Octane render error:.*$/gmu) ?? [];
    if (!result.sameHostRecovered) {
      result.restoredHTML = restored.html;
      result.hostLog = failureHost.log;
    }
    assert.equal(result.restoredStatus, 200);
    assert.equal(
      result.sameHostRecovered,
      true,
      `the same host retries the ${failure} container`,
    );
    assert.match(
      restored.markup,
      /data-testid="remote-widget"[^>]*data-owner="host-owned"|data-owner="host-owned"[^>]*data-testid="remote-widget"/u,
      'the recovered server widget retains host context',
    );
    assert.match(
      restored.markup.replace(/<!--[\s\S]*?-->/gu, ''),
      /<span(?=[^>]*data-testid="remote-label")[^>]*>from host<\/span>/u,
    );
  } finally {
    remoteControl.failure = undefined;
    if (failureProxy?.listening) {
      failureProxy.closeAllConnections();
      await new Promise(resolve => failureProxy.close(resolve));
    }
    if (failureHost) await stopChild(failureHost);
  }
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
let remoteServer;
let proxy;
const results = {};
const remoteControl = { failure: 'down', serverRequests: [] };

try {
  const fixture = createOctaneFederationFixtures({ remoteUrl });
  await writeApp(remoteDirectory, fixture.remote);
  await writeApp(hostDirectory, fixture.host);
  await writeApp(csrDirectory, fixture.csr);

  await ultramodern(remoteDirectory, 'build');
  const remoteDist = path.join(remoteDirectory, 'dist');
  const manifest = JSON.parse(
    await fs.readFile(path.join(remoteDist, 'mf-manifest.json'), 'utf8'),
  );
  const serverManifest = JSON.parse(
    await fs.readFile(
      path.join(remoteDist, 'bundles/mf-manifest.json'),
      'utf8',
    ),
  );
  results.remoteManifest = {
    remoteEntry: manifest.metaData.remoteEntry,
    ssrRemoteEntry: manifest.metaData.ssrRemoteEntry,
    publicPath: manifest.metaData.publicPath,
    ssrPublicPath: manifest.metaData.ssrPublicPath,
    renderer: manifest.metaData.ultramodernRenderer?.profile?.renderer,
    shared: manifest.shared.map(item => `${item.name}@${item.version}`).sort(),
    serverShared: serverManifest.shared
      .map(item => `${item.name}@${item.version}`)
      .sort(),
  };
  assert.equal(results.remoteManifest.renderer, 'octane');
  assert.equal(results.remoteManifest.ssrRemoteEntry?.type, 'commonjs-module');
  assert.equal(results.remoteManifest.ssrPublicPath, `${remoteUrl}/bundles/`);
  await fs.access(path.join(remoteDist, 'bundles', 'remoteEntry.js'));

  // A structurally valid publication claiming a foreign renderer must fail
  // before its container loads. This does not require installing that renderer.
  const reactManifest = structuredClone(manifest);
  const contract = reactManifest.metaData.ultramodernRenderer;
  reactManifest.name = 'reactremote';
  reactManifest.metaData.name = 'reactremote';
  reactManifest.metaData.ultramodernRenderer = {
    ...contract,
    profile: { ...contract.profile, renderer: 'react' },
    identities: Object.fromEntries(
      Object.entries(contract.identities).map(([entry, identity]) => [
        entry,
        { ...identity, renderer: 'react' },
      ]),
    ),
  };
  remoteServer = staticServer(
    remoteDist,
    {
      '/react/mf-manifest.json': JSON.stringify(reactManifest),
    },
    remoteControl,
  );

  await ultramodern(hostDirectory, 'build');
  await ultramodern(csrDirectory, 'build');
  results.hostServerShared = JSON.parse(
    await fs.readFile(
      path.join(hostDirectory, 'dist/bundles/mf-manifest.json'),
      'utf8',
    ),
  )
    .shared.map(item => `${item.name}@${item.version}`)
    .sort();

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

  await listen(remoteServer, remotePort);
  remoteControl.failure = undefined;
  proxy = markingProxy(hostUrl);
  await listen(proxy, proxyPort);
  const up = await document(hostUrl);
  const link = (rel, href) =>
    new RegExp(
      `<link(?=[^>]*rel="${rel}")(?=[^>]*href="${href.replace(/[.?/]/gu, '\\$&')}")[^>]*>`,
      'u',
    ).test(up.html);
  const remoteCss = manifest.exposes
    .find(expose => expose.path === './Widget')
    .assets.css.sync.map(file => `${remoteUrl}/${file}`);
  const ssrMarkup = up.markup.replace(/<!--[\s\S]*?-->/gu, '');
  results.ssr = {
    status: up.status,
    ms: up.ms,
    widget: up.markup.includes('data-testid="remote-widget"'),
    ownerOnServer:
      /data-testid="remote-widget"[^>]*data-owner="host-owned"|data-owner="host-owned"[^>]*data-testid="remote-widget"/u.test(
        up.markup,
      ),
    label:
      /<span(?=[^>]*data-testid="remote-label")[^>]*>from host<\/span>/u.test(
        ssrMarkup,
      ),
    initialFallback: up.html.includes('data-testid="remote-fallback"'),
    nativeSegments: up.segments.map(segment => ({
      id: segment.id,
      completed: segment.completed,
      remoteWidget: segment.markup.includes('data-testid="remote-widget"'),
    })),
    remoteCss,
    cssLinked:
      remoteCss.length > 0 && remoteCss.every(href => link('stylesheet', href)),
    remoteEntryPreloaded: link('modulepreload', `${remoteUrl}/remoteEntry.js`),
    slowFallback: up.html.includes('data-testid="slow-fallback"'),
    foreignWidgetAbsent:
      !/<span(?=[^>]*data-testid="remote-label")[^>]*>foreign-renderer<\/span>/u.test(
        ssrMarkup,
      ),
    renderErrors: host.log.match(/^Octane render error:.*$/gmu) ?? [],
  };
  if (!results.ssr.widget) {
    results.ssr.html = up.html;
    results.ssr.hostLog = host.log;
  }
  assert.equal(results.ssr.status, 200);
  assert.equal(results.ssr.widget, true, 'SSR HTML holds the remote markup');
  assert.equal(
    results.ssr.ownerOnServer,
    true,
    'one Octane/router context on the server',
  );
  assert.equal(results.ssr.label, true);
  assert.equal(results.ssr.cssLinked, true, 'SSR links the remote stylesheet');
  assert.equal(results.ssr.slowFallback, true, 'a slow remote times out');
  assert.equal(
    results.ssr.foreignWidgetAbsent,
    true,
    'SSR never renders an incompatible remote',
  );
  assert.ok(results.ssr.ms < 5000, 'the slow remote cannot hold the document');

  // The remote's own server bundle reaches its renderer through the same
  // import() boundary and still answers its documents.
  const ownPort = await freePort();
  const ownHost = await startHost(remoteDirectory, ownPort);
  const own = await document(`http://127.0.0.1:${ownPort}`);
  results.remoteOwnDocument = {
    status: own.status,
    root: own.html.includes('id="root"'),
    widget: own.markup.includes('data-testid="remote-widget"'),
    label:
      /<span(?=[^>]*data-testid="remote-label")[^>]*>standalone<\/span>/u.test(
        own.markup.replace(/<!--[\s\S]*?-->/gu, ''),
      ),
  };
  assert.equal(results.remoteOwnDocument.status, 200);
  assert.equal(results.remoteOwnDocument.root, true);
  assert.equal(results.remoteOwnDocument.widget, true);
  assert.equal(results.remoteOwnDocument.label, true);

  const csrHost = await startHost(csrDirectory, csrPort);

  if (process.env.MF_PROOF_HOLD) {
    // Debugging: keep the servers up until this process is terminated.
    process.stdout.write(
      `${JSON.stringify({ hostUrl, proxyUrl, csrUrl, remoteUrl, temporary })}\n`,
    );
    await new Promise(resolve =>
      cancellation.signal.addEventListener('abort', resolve, { once: true }),
    );
    results.verdict = 'HELD';
  } else {
    await verifySSRInBrowser();
    await verifyCSRInBrowser();
    // Retire positive hosts before starting fresh failure cases. The compiled
    // apps remain the same, and each failure recovers in its own process.
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    await stopChild(host);
    await stopChild(ownHost);
    await stopChild(csrHost);
    await verifyServerEntryRecovery('down');
    await verifyServerEntryRecovery('hung');
    // Collect this separately so a rapid native-signal failure cannot conceal
    // independent transport recovery. The complete proof still fails hard.
    results.rapidSignalUpdates = [
      ['SSR hydration', results.ssrBrowser],
      ['CSR', results.csrBrowser],
      ['503 recovery', results.serverEntryDown.browser],
      ['hung-entry recovery', results.serverEntryHung.browser],
    ].map(([scenario, result]) => ({
      scenario,
      expected: 'Count 4',
      actual: result.counterAfterRapidClicks,
    }));
    for (const result of results.rapidSignalUpdates)
      assert.equal(
        result.actual,
        result.expected,
        `${result.scenario} preserves both rapid native signal updates`,
      );
    results.verdict = 'PASS';
  }
} finally {
  results.serverRequests = remoteControl.serverRequests;
  if (!results.verdict) {
    results.verdict = 'FAIL';
    if (openedSessions.has(browserSession) && !cancellation.signal.aborted) {
      results.console = await browserWithTimeout(5000, 'console').catch(error =>
        String(error),
      );
      results.pageErrors = await browserWithTimeout(5000, 'errors').catch(
        error => String(error),
      );
      results.html = await browserWithTimeout(
        5000,
        'get',
        'html',
        'body',
      ).catch(error => String(error));
    }
    results.hostLogs = children.map(child => child.log.slice(-4000));
  }
  for (const session of openedSessions)
    await execute('agent-browser', ['close'], {
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: session,
        AGENT_BROWSER_HEADED: 'false',
      },
      timeout: 15_000,
    }).catch(error => {
      (results.cleanupErrors ??= []).push(String(error));
    });
  const failedRetirements = [];
  for (const child of children)
    await stopChild(child).catch(error => {
      (results.cleanupErrors ??= []).push(String(error));
      failedRetirements.push(child.directory);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    });
  for (const server of httpServers)
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  for (const directory of artifacts)
    if (
      failedRetirements.some(application =>
        directory.startsWith(`${application}${path.sep}`),
      )
    )
      (results.retainedArtifacts ??= []).push(directory);
    else if (guardian)
      await execute(guardian, ['release', directory, '--owner', owner]).catch(
        error => {
          (results.cleanupErrors ??= []).push(String(error));
        },
      );
  if (results.cleanupErrors?.length) {
    results.verdict = 'FAIL';
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}
