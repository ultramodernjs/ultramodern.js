#!/usr/bin/env node
// Run through owned-temp-dir. This proof edits only its disposable remote app.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { retryMaintenanceOperation } from '../../../scripts/ultramodern-production-readiness/react-rsc-worker-proof/lifecycle.mjs';
import { inspectOwnedProcessGroup } from '../../../scripts/ultramodern-production-readiness/react-rsc-worker-proof/runtime.mjs';
import {
  createOctaneFederationFixtures,
  decodeOctaneSSRDocument,
  linkOctaneFederationDependencies,
} from './fixtures.mjs';
import { assertLifecycle, compatibleActivationDeltas } from './lifecycle.mjs';
import { createSSRMarkerProxy } from './marker-proxy.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryInput = process.env.OWNED_TEMP_DIR;
assert.ok(
  temporaryInput,
  'Run through owned-temp-dir so the apps have an owner.',
);
const temporary = await fs.realpath(temporaryInput);
const compilerDebounceMs = 100;
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
assert(
  !(packedContext && process.env.ULTRAMODERN_MF_SOURCE_DEV_CONTEXT),
  'Source dev validation cannot claim a packed release cohort.',
);
const sourceHelpers = process.env.ULTRAMODERN_MF_SOURCE_DEV_CONTEXT
  ? await import('./source-dev.mjs')
  : undefined;
const sourceContext = sourceHelpers
  ? sourceHelpers.readSourceDevContext(
      process.env.ULTRAMODERN_MF_SOURCE_DEV_CONTEXT,
    )
  : undefined;
if (packedContext)
  assert.equal(path.resolve(temporary), path.resolve(packedContext.workRoot));
const owner = `octane-mf-dev-${process.pid}`;
const cancellation = new AbortController();
const children = [];
const artifacts = new Set();
const results = {};
let browserOpened = false;
let proxy;
let developmentURLs;
let remoteWidgetFile;
let remoteEdited = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(signal, () =>
    cancellation.abort(new Error(`Received ${signal}`)),
  );

async function registerArtifact(directory, kind) {
  cancellation.signal.throwIfAborted();
  await fs.mkdir(directory, { recursive: true });
  // An interrupted guardian command may already have registered this owner.
  artifacts.add(directory);
  await guardianCommand(
    [
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
    ],
    cancellation.signal,
  );
  cancellation.signal.throwIfAborted();
}

const guardianCommand = (args, signal) =>
  retryMaintenanceOperation(timeout => {
    signal?.throwIfAborted();
    return execute('/Users/satan/bin/disk-guardian-artifacts', args, {
      timeout,
      maxBuffer: 1024 * 1024,
      signal,
    });
  });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function writeApp(directory, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  if (packedContext)
    await packedHelpers.preparePackedNativeFederationApp({
      directory,
      renderer: 'octane',
      context: packedContext,
      registerArtifact,
      signal: cancellation.signal,
    });
  else if (sourceContext)
    await sourceHelpers.prepareSourceDevApp({
      directory,
      context: sourceContext,
      registerArtifact,
      signal: cancellation.signal,
    });
  else
    await linkOctaneFederationDependencies({
      root,
      directory,
      registerArtifact,
    });
}

async function startDev(directory, port) {
  await registerArtifact(path.join(directory, 'dist'), 'build');
  const child = spawn(
    process.execPath,
    [
      packedContext
        ? packedHelpers.installedBin(directory)
        : sourceContext
          ? sourceHelpers.installedBin(directory)
          : path.join(
              root,
              'packages/solutions/ultramodern-app-tools/bin/ultramodern.mjs',
            ),
      'dev',
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        NODE_PATH: '',
        NODE_ENV: 'development',
        PORT: String(port),
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.log = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', chunk => {
      child.log = (child.log + chunk).slice(-128 * 1024);
    });
  child.completion = new Promise(resolve => {
    child.once('error', error => {
      child.failure = error;
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  children.push(child);
  if (packedContext && child.pid) {
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
      await stopChild(child);
      throw error;
    }
  }
  if (sourceContext && child.pid) {
    try {
      sourceHelpers.recordPackedNativeFederationProcess(
        path.join(
          sourceContext.workRoot,
          `source-dev-process-${child.pid}.json`,
        ),
        child.pid,
      );
    } catch (error) {
      await stopChild(child);
      throw error;
    }
  }
  return child;
}

async function groupAlive(child) {
  if (!child.pid) return false;
  if (process.platform === 'win32')
    return child.exitCode === null && child.signalCode === null;
  const group = inspectOwnedProcessGroup(child.pid);
  if (
    (child.exitCode !== null || child.signalCode !== null) &&
    group.members.some(member => member.pid === child.pid && member.live)
  )
    throw new Error('The proof process group identity was reused.');
  return group.liveMemberCount > 0;
}

async function stopChild(child) {
  if (child.retirement) return child.retirement;
  child.retirement = (async () => {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (!(await groupAlive(child))) break;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + 5000;
      while (await groupAlive(child)) {
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.equal(
      await groupAlive(child),
      false,
      'the dev process group retired',
    );
    await child.completion;
  })();
  return child.retirement;
}

async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted();
    for (const child of children)
      if (
        !child.expectedStop &&
        (child.failure || child.exitCode !== null || child.signalCode !== null)
      )
        throw child.failure ?? new Error(`Dev server exited: ${child.log}`);
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`,
  );
}

const request = (url, timeout = 2000, options = {}) =>
  fetch(url, {
    ...options,
    signal: AbortSignal.any([
      cancellation.signal,
      AbortSignal.timeout(timeout),
    ]),
  });

async function verifyNodePublication(url) {
  const options = { headers: { 'accept-encoding': 'identity' } };
  const response = await request(url, 10_000, options);
  assert.equal(
    response.status,
    200,
    'the native Node container is downloadable',
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0, 'the published Node container holds bytes');
  assert.match(
    response.headers.get('content-type') ?? '',
    /(?:java|ecma)script/u,
  );
  assert.match(
    bytes.toString('utf8'),
    /module\.exports\s*=/u,
    'the published entry is a Node container',
  );
  const revision = response.headers.get('x-ultramodern-mf-revision');
  assert.match(
    revision ?? '',
    /^[0-9a-f]{64}$/u,
    'the Node graph has a SHA-256 revision',
  );
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  const head = await request(url, 10_000, { ...options, method: 'HEAD' });
  assert.equal(head.status, 200, 'HEAD reaches the native Node publisher');
  assert.equal(head.headers.get('x-ultramodern-mf-revision'), revision);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  return { url, bytes: bytes.length, revision, headMatches: true };
}

async function editRemoteSource() {
  cancellation.signal.throwIfAborted();
  const source = await fs.readFile(remoteWidgetFile, 'utf8');
  assert.equal(
    source.split('Remote native v1').length,
    2,
    'one native remote marker changes',
  );
  cancellation.signal.throwIfAborted();
  await fs.writeFile(
    remoteWidgetFile,
    source.replace('Remote native v1', 'Remote native v2'),
  );
  remoteEdited = true;
}

const remoteVersions = markup =>
  [
    ...markup.matchAll(
      /<span\b(?=[^>]*\bdata-testid="remote-version")[^>]*>([\s\S]*?)<\/span>/gu,
    ),
  ].map(match =>
    match[1]
      .replace(/<!--[\s\S]*?-->/gu, '')
      .replace(/<[^>]*>/gu, '')
      .trim(),
  );

let previousPublication;
async function verifyFreshRemoteSSR(
  { remoteUrl, hostUrl },
  {
    version = 'Remote native v2',
    previous = 'Remote native v1',
    key = 'freshSSR',
    requireRevisionChange = true,
    shape,
  } = {},
) {
  await waitFor(async () => {
    const response = await request(remoteUrl, 10_000);
    const { markup } = decodeOctaneSSRDocument(await response.text());
    return (
      response.ok &&
      markup.includes('data-testid="remote-widget"') &&
      remoteVersions(markup).includes(version) &&
      (shape === null
        ? !markup.includes('data-refresh-shape=')
        : !shape || markup.includes(`data-refresh-shape="${shape}"`))
    );
  }, 'the completed remote server compilation');
  const publication = await verifyNodePublication(results.nodePublication.url);
  const prior = previousPublication ?? results.nodePublication;
  if (requireRevisionChange)
    assert.notEqual(
      publication.revision,
      prior.revision,
      `${key} publishes a new Node graph revision`,
    );
  previousPublication = publication;
  const response = await request(hostUrl, 10_000);
  const { markup, segments } = decodeOctaneSSRDocument(await response.text());
  const completedRemoteSegments = segments.filter(
    segment =>
      segment.completed &&
      segment.markup.includes('data-testid="remote-widget"'),
  );
  const effectiveMarkup = completedRemoteSegments.length
    ? completedRemoteSegments.map(segment => segment.markup).join('\n')
    : markup;
  const observation = {
    status: response.status,
    rawFallbackCount: [...markup.matchAll(/data-testid="remote-fallback"/gu)]
      .length,
    completedRemoteSegments,
    expectedVersion: version,
    expectedShape: shape,
    shapes: [...effectiveMarkup.matchAll(/data-refresh-shape="([^"]+)"/gu)].map(
      match => match[1],
    ),
    previousVersion: previous,
    versions: remoteVersions(effectiveMarkup),
    owners: [...effectiveMarkup.matchAll(/data-owner="([^"]+)"/gu)].map(
      match => match[1],
    ),
    fallbackCount: [
      ...effectiveMarkup.matchAll(/data-testid="remote-fallback"/gu),
    ].length,
    remoteMarkup: effectiveMarkup.includes('data-testid="remote-widget"'),
    currentRemote: remoteVersions(effectiveMarkup).includes(version),
    nativeHostOwner: effectiveMarkup.includes('data-owner="host-owned"'),
    staleRemote:
      previous == null
        ? false
        : remoteVersions(effectiveMarkup).includes(previous),
    publication: { previous: prior, current: publication },
    segments: segments.map(({ completed, markup }) => ({
      completed,
      remoteMarkup: markup.includes('data-testid="remote-widget"'),
    })),
  };
  results[key] = observation;
  assert.equal(response.status, 200, 'fresh dev SSR still answers a document');
  assert.equal(
    observation.remoteMarkup,
    true,
    'fresh dev SSR renders its remote',
  );
  assert.equal(
    observation.currentRemote,
    true,
    'the same host process loads the edited remote',
  );
  assert.equal(
    observation.nativeHostOwner,
    true,
    'fresh dev SSR retains the active native host provider',
  );
  assert.equal(
    observation.staleRemote,
    false,
    'SSR does not retain the old remote module',
  );
  assert.equal(
    observation.fallbackCount,
    0,
    'recovered/current SSR has no remote fallback',
  );
  return observation;
}

async function settleUpdate(waiters, label) {
  const settled = await Promise.allSettled(waiters);
  const errors = settled
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, label);
  return settled.map(result => result.value);
}

// Sample completed client/server graphs beyond the fixture's actual Rspack
// aggregation interval. Recheck the final browser and SSR observations afterwards.
async function waitForStableCompilation(remoteUrl) {
  let last;
  let stableSince = 0;
  let samples = 0;
  return waitFor(async () => {
    const [assets, nativeManifestResponse, entry] = await settleUpdate(
      [
        request(`${remoteUrl}/renderer-assets.json`, 10_000),
        request(`${remoteUrl}/octane-module-manifest.index.json`, 10_000),
        request(results.nodePublication.url, 10_000, { method: 'HEAD' }),
      ],
      'stable client/server graph sample',
    );
    assert.equal(assets.status, 200);
    assert.equal(entry.status, 200);
    assert.equal(nativeManifestResponse.status, 200);
    const nativeManifest = await nativeManifestResponse.json();
    assert.equal(nativeManifest.renderer, 'octane');
    const clientCompilationHash = nativeManifest.nativeHydrationBuildId;
    assert.match(clientCompilationHash ?? '', /^[a-f0-9]{8,}$/u);
    const clientAssetsSha256 = createHash('sha256')
      .update(await assets.text())
      .digest('hex');
    const serverRevision = entry.headers.get('x-ultramodern-mf-revision');
    assert.match(serverRevision ?? '', /^[a-f0-9]{64}$/u);
    const current = `${clientCompilationHash}:${clientAssetsSha256}:${serverRevision}`;
    samples++;
    if (current !== last) {
      last = current;
      stableSince = Date.now();
      return false;
    }
    const stableMs = Date.now() - stableSince;
    return (
      stableMs >= compilerDebounceMs * 5 && {
        clientCompilationHash,
        clientAssetsSha256,
        serverRevision,
        stableMs,
        compilerDebounceMs,
        samples,
      }
    );
  }, 'stable completed compiler client/server hashes');
}

// Delay only the initial native entries until the completed streamed SSR node
// can be observed. Redirects preserve their native module URLs and HMR runtime.
// This measures exact node reuse after completion; native stream probes cover
// bootstrap overlap with segments that are still arriving.
async function markingProxy(target, port, allowedEntrySources) {
  const sockets = new Set();
  const server = createSSRMarkerProxy({
    target,
    signal: cancellation.signal,
    absoluteEntries: 'redirect',
    allowedEntrySources,
  });
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  server.on('connection', track);
  server.on('upgrade', (incoming, socket, head) => {
    const url = new URL(target);
    const upstream = track(net.connect(Number(url.port), url.hostname));
    upstream.once('connect', () => {
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${incoming.rawHeaders.reduce((text, value, index) => text + (index % 2 ? `${value}\r\n` : `${value}: `), '')}\r\n`,
      );
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once('error', () => socket.destroy());
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  };
  close.proof = server.proof;
  return close;
}

async function browser(...args) {
  if (args[0] === 'open') browserOpened = true;
  const { stdout } = await execute('agent-browser', args, {
    env: {
      ...process.env,
      AGENT_BROWSER_SESSION: owner,
      AGENT_BROWSER_HEADED: 'false',
      ...(sourceContext
        ? { AGENT_BROWSER_EXECUTABLE_PATH: sourceContext.browserExecutable }
        : {}),
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
    signal: cancellation.signal,
  });
  return stdout.trim();
}
const evaluate = async source =>
  JSON.parse(JSON.parse(await browser('eval', `JSON.stringify(${source})`)));
const text = testId => browser('get', 'text', `[data-testid="${testId}"]`);
const click = testId => browser('click', `[data-testid="${testId}"]`);
const documentState = () =>
  evaluate(
    `({ sentinel: globalThis.__octaneMFDocumentSentinel, timeOrigin: performance.timeOrigin, location: location.href, historyLength: history.length, navigationCount: performance.getEntriesByType('navigation').length, routerPath: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-path'), routerKey: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-router-key') })`,
  );
const browserObservation = () =>
  evaluate(
    `({ version: document.querySelector('[data-testid="remote-version"]')?.textContent, remoteCount: document.querySelector('[data-testid="remote-increment"]')?.textContent, hostCount: document.querySelector('[data-testid="host-increment"]')?.textContent, label: document.querySelector('[data-testid="remote-label"]')?.textContent, owner: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-owner'), refreshShape: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-refresh-shape'), remoteRoots: document.querySelectorAll('[data-testid="remote-widget"]').length, remoteFallbacks: document.querySelectorAll('[data-testid="remote-fallback"]').length, fallbackEverSeen: window.__remoteFallbackSeen, lifecycle: globalThis.__octaneMFRemoteLifecycle })`,
  );

let failure;
try {
  if (sourceContext) {
    results.mode = 'source-installed';
    results.installedConsumers = sourceContext.installations;
  }
  const remotePort = await freePort();
  const hostPort = await freePort();
  const proxyPort = await freePort();
  const remoteUrl = `http://127.0.0.1:${remotePort}`;
  const hostUrl = `http://127.0.0.1:${hostPort}`;
  developmentURLs = { remoteUrl, hostUrl };
  const fixtures = createOctaneFederationFixtures({
    remoteUrl,
    failures: false,
    development: true,
  });
  fixtures.remote['modern.config.ts'] = fixtures.remote[
    'modern.config.ts'
  ].replace(
    "renderer: 'octane',",
    `renderer: 'octane', tools: { rspack: { watchOptions: { aggregateTimeout: ${compilerDebounceMs} } } },`,
  );
  fixtures.remote['src/components/Widget.tsx'] = fixtures.remote[
    'src/components/Widget.tsx'
  ].replace(
    'data-path={router.state.location.pathname}',
    'data-path={router.state.location.pathname} data-router-key={router.state.location.state.__TSR_key}',
  );
  fixtures.host['src/routes/page.tsx'] = fixtures.host['src/routes/page.tsx']
    .replace('{ useApplicationIdentity }', '{ useApplicationIdentity, Link }')
    .replace(
      '<section>',
      '<section><Link to="/away" data-testid="host-away">Away</Link>',
    );
  fixtures.host['src/routes/away/page.tsx'] =
    `import { Link, useRouter } from '@modern-js/renderer-octane/router';
export default function Away() { const router = useRouter(); return <section data-testid="away-route" data-path={router.state.location.pathname} data-router-key={router.state.location.state.__TSR_key}><Link to="/" data-testid="host-back">Back</Link></section>; }
`;
  const remoteDirectory = path.join(temporary, 'remote');
  const hostDirectory = path.join(temporary, 'host');
  await writeApp(remoteDirectory, fixtures.remote);
  await writeApp(hostDirectory, fixtures.host);
  remoteWidgetFile = path.join(remoteDirectory, 'src/components/Widget.tsx');
  const initialRemoteProcess = await startDev(remoteDirectory, remotePort);
  const manifest = await waitFor(
    async () => {
      const response = await request(`${remoteUrl}/mf-manifest.json`);
      return response.ok && response.json();
    },
    'the remote dev manifest',
    120_000,
  );
  assert.equal(
    manifest.metaData.ultramodernRenderer.profile.renderer,
    'octane',
  );
  results.remoteManifest = {
    renderer: manifest.metaData.ultramodernRenderer.profile.renderer,
    remoteEntry: manifest.metaData.remoteEntry,
    ssrRemoteEntry: manifest.metaData.ssrRemoteEntry,
    publicPath: manifest.metaData.publicPath,
    ssrPublicPath: manifest.metaData.ssrPublicPath,
  };
  assert.equal(manifest.metaData.ssrRemoteEntry?.type, 'commonjs-module');
  const nodeEntry = new URL(
    `${manifest.metaData.ssrRemoteEntry.path}${manifest.metaData.ssrRemoteEntry.name}`,
    manifest.metaData.ssrPublicPath,
  );
  assert.equal(nodeEntry.port, String(remotePort));
  assert.ok(['localhost', '127.0.0.1'].includes(nodeEntry.hostname));
  results.nodePublication = await verifyNodePublication(nodeEntry.href);
  process.stdout.write(
    `${JSON.stringify({ stage: 'remote-published', remoteUrl, ...results.remoteManifest, nodePublication: results.nodePublication })}\n`,
  );
  await startDev(hostDirectory, hostPort);
  const document = await waitFor(
    async () => {
      // The native remote load timeout is 3000ms. Keep its actual fallback/error
      // document observable instead of aborting HTTP before that deadline.
      const response = await request(hostUrl, 10_000);
      const html = await response.text();
      const decoded = decodeOctaneSSRDocument(html);
      results.lastSSRResponse = {
        status: response.status,
        remoteMarkup: decoded.markup.includes('data-testid="remote-widget"'),
        segments: decoded.segments.map(({ id, markup, completed }) => ({
          id,
          completed,
          remoteMarkup: markup.includes('data-testid="remote-widget"'),
        })),
        sample: html.slice(0, 2000),
      };
      return (
        response.ok &&
        decoded.markup.includes('data-testid="remote-widget"') &&
        decoded
      );
    },
    'native dev SSR of the remote',
    120_000,
  );
  assert.match(document.markup, /Remote native v1/u);
  assert.match(document.markup, /data-owner="host-owned"/u);
  const remoteStylesheets = [
    ...new Set(
      (manifest.exposes ?? []).flatMap(expose => [
        ...(expose.assets?.css?.sync ?? []),
        ...(expose.assets?.css?.async ?? []),
      ]),
    ),
  ].map(name => new URL(name, manifest.metaData.publicPath).href);
  assert.ok(remoteStylesheets.length > 0, 'the native remote publishes CSS');
  for (const href of remoteStylesheets)
    assert.ok(
      document.markup.includes(`href="${href}"`),
      'native SSR links the remote stylesheet',
    );
  results.ssr = {
    remoteMarkup: true,
    renderer: 'octane',
    cssLinked: true,
    completedRemoteSegments: document.segments.filter(
      segment =>
        segment.completed &&
        segment.markup.includes('data-testid="remote-widget"'),
    ).length,
  };
  process.stdout.write(
    `${JSON.stringify({ stage: 'native-ssr', hostUrl, ...results.ssr })}\n`,
  );
  const nativeHostOrigin = `http://localhost:${hostPort}`;
  const assetsResponse = await request(
    `${nativeHostOrigin}/renderer-assets.json`,
  );
  assert.equal(assetsResponse.status, 200);
  const assets = await assetsResponse.json();
  assert.equal(assets.schema, 'ultramodern-renderer-assets');
  assert.equal(assets.version, 1);
  assert.equal(assets.renderer, 'octane');
  const hostAssets = assets.entries.index;
  assert.equal(hostAssets.rendererIdentity.appId, 'octane-mf-proof-host');
  const allowedEntrySources = hostAssets.assets
    .filter(asset => asset.kind === 'script')
    .map(asset => {
      assert.equal(
        asset.scriptType,
        'module',
        'the native host entries use modules',
      );
      const url = new URL(asset.href, nativeHostOrigin);
      assert.equal(
        url.origin,
        nativeHostOrigin,
        'the admitted entries belong to the owned host compiler',
      );
      assert.match(
        url.pathname,
        /\.[cm]?js$/u,
        'the compiler entry is JavaScript',
      );
      return url.href;
    });
  assert.ok(allowedEntrySources.length > 0);
  proxy = await markingProxy(nativeHostOrigin, proxyPort, allowedEntrySources);
  results.entryBarrier = proxy.proof;
  await browser('open', 'about:blank');
  await browser('network', 'requests', '--clear');
  await browser('open', `http://127.0.0.1:${proxyPort}`);
  await waitFor(
    async () =>
      (await text('remote-increment')) === 'Count 0' &&
      (await browser(
        'get',
        'attr',
        '[data-testid="remote-widget"]',
        'data-hydrated',
      )) === 'true',
    'the native remote hydration',
  );
  assert.equal(
    await evaluate(
      `window.__ssrRemoteWidget !== null && window.__ssrRemoteWidget === document.querySelector('[data-testid="remote-widget"]') && window.__ssrRemoteWidget.isConnected`,
    ),
    true,
  );
  assert.equal(await evaluate('window.__ssrRemoteAlreadyHydrated'), false);
  results.entryBarrier = proxy.proof;
  assert.equal(results.entryBarrier.markerCaptured, true);
  assert.equal(
    results.entryBarrier.redirectedEntries.length,
    allowedEntrySources.length,
  );
  const redirectedSources = results.entryBarrier.redirectedEntries.map(
    entry => entry.url,
  );
  assert.equal(new Set(redirectedSources).size, allowedEntrySources.length);
  assert.deepEqual(
    [...redirectedSources].sort(),
    [...allowedEntrySources].sort(),
  );
  assert.ok(
    results.entryBarrier.redirectedEntries.every(entry => entry.markerCaptured),
  );
  assert.equal(
    await browser('get', 'count', '[data-testid="remote-fallback"]'),
    '0',
  );
  assert.equal(await evaluate('window.__remoteFallbackSeen'), false);
  await waitFor(
    async () =>
      (await evaluate(
        `getComputedStyle(document.querySelector('[data-testid="remote-widget"]')).color`,
      )) === 'rgb(1, 2, 3)',
    'the remote native stylesheet',
  );
  results.remoteStyle = 'rgb(1, 2, 3)';
  assert.equal(
    await browser('get', 'attr', '[data-testid="remote-widget"]', 'data-owner'),
    'host-owned',
  );
  await click('host-increment');
  await click('host-increment');
  await click('remote-increment');
  await click('remote-increment');
  await click('host-relabel');
  assert.equal(await text('remote-label'), 'relabelled');
  assert.equal(await text('remote-increment'), 'Count 2');
  assert.equal(await text('host-increment'), 'Host count 2');
  const sentinel = await evaluate(`(() => {
    globalThis.__octaneMFDocumentSentinel = crypto.randomUUID();
    return { sentinel: globalThis.__octaneMFDocumentSentinel, timeOrigin: performance.timeOrigin, location: location.href, navigationCount: performance.getEntriesByType('navigation').length, historyLength: history.length, routerPath: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-path'), routerKey: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-router-key') };
  })()`);
  const beforeBrowser = await browserObservation();
  results.initialBrowser = beforeBrowser;
  assert.equal(typeof sentinel.routerKey, 'string');
  assert.ok(
    sentinel.routerKey.length > 0,
    'native router publishes its history key',
  );
  const before = await evaluate('globalThis.__octaneMFRemoteLifecycle');
  assertLifecycle(before);
  process.stdout.write(
    `${JSON.stringify({ stage: 'hydrated-before-edit', retainedServerNode: true, owner: 'host-owned', hostCount: 2, remoteCount: 2, label: 'relabelled' })}\n`,
  );
  await editRemoteSource();
  const updates = await Promise.allSettled([
    waitFor(
      async () => (await text('remote-version')) === 'Remote native v2',
      'the remote component HMR update',
    ),
    verifyFreshRemoteSSR(developmentURLs),
  ]);
  results.postEdit = updates.map((update, index) => ({
    observation:
      index === 0
        ? 'browser remote update'
        : 'same-process server remote update',
    status: update.status,
    ...(update.status === 'rejected' ? { error: String(update.reason) } : {}),
  }));
  results.browserAfterEdit = await evaluate(`({
    version: document.querySelector('[data-testid="remote-version"]')?.textContent,
    hostCount: document.querySelector('[data-testid="host-increment"]')?.textContent,
    remoteCount: document.querySelector('[data-testid="remote-increment"]')?.textContent,
    label: document.querySelector('[data-testid="remote-label"]')?.textContent,
    sentinel: globalThis.__octaneMFDocumentSentinel,
    timeOrigin: performance.timeOrigin,
    location: location.href
  })`);
  const updateErrors = updates
    .filter(update => update.status === 'rejected')
    .map(update => update.reason);
  if (updateErrors.length)
    throw new AggregateError(
      updateErrors,
      'Native remote edit acceptance failed',
    );
  assert.equal(
    await text('host-increment'),
    'Host count 2',
    'remote HMR retains host state',
  );
  assert.equal(
    await text('remote-label'),
    'relabelled',
    'remote HMR retains host props',
  );
  const editedCounter = await text('remote-increment');
  assert.equal(
    editedCounter,
    'Count 2',
    'compatible component edits preserve remote state',
  );
  await click('remote-increment');
  assert.equal(
    await text('remote-increment'),
    `Count ${Number(editedCounter.slice('Count '.length)) + 1}`,
    'the edited remote keeps exactly one native event handler',
  );
  assert.equal(
    await browser('get', 'attr', '[data-testid="remote-widget"]', 'data-owner'),
    'host-owned',
    'remote HMR retains the host application context',
  );
  assert.equal(
    await browser('get', 'attr', '[data-testid="remote-widget"]', 'data-path'),
    new URL(sentinel.location).pathname,
    'remote HMR retains the host router context',
  );
  assert.deepEqual(
    await evaluate(
      `({ sentinel: globalThis.__octaneMFDocumentSentinel, timeOrigin: performance.timeOrigin, location: location.href, navigationCount: performance.getEntriesByType('navigation').length, historyLength: history.length, routerPath: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-path'), routerKey: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-router-key') })`,
    ),
    sentinel,
  );
  assert.equal(
    await browser('get', 'count', '[data-testid="remote-widget"]'),
    '1',
  );
  const edited = await evaluate('globalThis.__octaneMFRemoteLifecycle');
  assertLifecycle(edited, {
    previous: before,
    transition: 'compatible',
    activations: [1, 1],
  });
  results.initialCompatibleUpdate = {
    before,
    after: edited,
    remoteCountBefore: beforeBrowser.remoteCount,
    remoteCountAfter: editedCounter,
    documentBefore: sentinel,
    documentAfter: await documentState(),
  };
  let retained = await browserObservation();
  results.refreshes = {};
  const assertRetainedUpdate = async (
    version,
    previous,
    key,
    { compatible = true, shape, requireRevisionChange = true } = {},
  ) => {
    const baseline = retained;
    const settled = await settleUpdate(
      [
        waitFor(async () => {
          const observation = await browserObservation();
          if (observation.version !== version) return false;
          if (shape !== undefined && observation.refreshShape !== shape)
            return false;
          return observation;
        }, `${key} browser update`),
        verifyFreshRemoteSSR(developmentURLs, {
          version,
          previous,
          key,
          requireRevisionChange,
          shape,
        }),
      ],
      `${key} browser/SSR acceptance`,
    );
    const observation = await browserObservation();
    const document = await documentState();
    results.refreshes[key] = {
      before: baseline,
      after: observation,
      document,
      waiters: settled.map((value, index) => ({
        target: index === 0 ? 'browser' : 'ssr',
        value,
      })),
    };
    assert.equal(observation.version, version);
    assert.equal(observation.hostCount, 'Host count 2');
    assert.equal(observation.label, 'relabelled');
    assert.equal(observation.owner, 'host-owned');
    assert.equal(observation.remoteRoots, 1);
    assert.equal(observation.remoteFallbacks, 0);
    assert.deepEqual(
      document,
      sentinel,
      `${key} preserves document/history/native router state`,
    );
    if (compatible) {
      assert.equal(
        observation.remoteCount,
        baseline.remoteCount,
        `${key} preserves compatible remote state`,
      );
      assertLifecycle(observation.lifecycle, {
        previous: baseline.lifecycle,
        transition: 'compatible',
        activations: compatibleActivationDeltas[key],
      });
    }
    retained = observation;
    return observation;
  };
  // This adds a dependency and changes the component's render expression. The
  // subsequent burst changes only that dependency, keeping component source fixed.
  const dependency = path.join(path.dirname(remoteWidgetFile), 'version.ts');
  await fs.writeFile(
    dependency,
    "export const remoteVersion = 'Remote native v3';\n",
  );
  const component = await fs.readFile(remoteWidgetFile, 'utf8');
  assert.equal(component.split('Remote native v2').length, 2);
  await fs.writeFile(
    remoteWidgetFile,
    `import { remoteVersion } from './version';\n${component.replace('Remote native v2', '{remoteVersion}')}`,
  );
  await assertRetainedUpdate(
    'Remote native v3',
    'Remote native v2',
    'componentAndDependencyRefresh',
  );
  await fs.writeFile(
    dependency,
    "export const remoteVersion = 'Remote native v4';\n",
  );
  await fs.writeFile(
    dependency,
    "export const remoteVersion = 'Remote native v5';\n",
  );
  await assertRetainedUpdate(
    'Remote native v5',
    'Remote native v4',
    'burstRefresh',
  );
  results.burstStability = await waitForStableCompilation(remoteUrl);
  await assertRetainedUpdate(
    'Remote native v5',
    'Remote native v4',
    'burstStableRefresh',
    { requireRevisionChange: false },
  );
  // Stop only this proof's remote process group; mark the expected exit before
  // concurrent waiters can observe its termination.
  const outageBefore = await browserObservation();
  initialRemoteProcess.expectedStop = true;
  await stopChild(initialRemoteProcess);
  assert.deepEqual(await browserObservation(), outageBefore);
  const unavailableResponse = await request(hostUrl, 10_000);
  const unavailable = decodeOctaneSSRDocument(await unavailableResponse.text());
  const outageServer = {
    status: unavailableResponse.status,
    hostDocuments: [
      ...unavailable.markup.matchAll(/data-testid="host-title"/gu),
    ].length,
    fallbackCount: [
      ...unavailable.markup.matchAll(/data-testid="remote-fallback"/gu),
    ].length,
    staleRemoteCount: [...unavailable.markup.matchAll(/Remote native v5/gu)]
      .length,
  };
  assert.equal(outageServer.status, 200);
  assert.equal(outageServer.hostDocuments, 1);
  assert.ok(outageServer.fallbackCount > 0);
  assert.equal(outageServer.staleRemoteCount, 0);
  const outageSamples = [];
  const outageStarted = Date.now();
  const outageUntil = outageStarted + compilerDebounceMs * 5;
  do {
    const observation = await browserObservation();
    const document = await documentState();
    outageSamples.push({ observation, document });
    assert.deepEqual(
      observation,
      outageBefore,
      'outage preserves mounted browser state without a fallback',
    );
    assert.equal(observation.remoteFallbacks, 0);
    assert.equal(
      observation.fallbackEverSeen,
      false,
      'the observer never saw a transient outage fallback',
    );
    assert.deepEqual(document, sentinel);
    await new Promise(resolve => setTimeout(resolve, compilerDebounceMs));
  } while (Date.now() < outageUntil || outageSamples.length < 2);
  const outageObservedMs = Date.now() - outageStarted;
  await startDev(remoteDirectory, remotePort);
  await verifyFreshRemoteSSR(developmentURLs, {
    version: 'Remote native v5',
    previous: null,
    key: 'recoveredSsr',
    requireRevisionChange: false,
  });
  await fs.writeFile(
    dependency,
    "export const remoteVersion = 'Remote native v6';\n",
  );
  await assertRetainedUpdate(
    'Remote native v6',
    'Remote native v5',
    'reconnectedRefresh',
  );
  results.outageRecovery = {
    before: outageBefore,
    server: outageServer,
    samples: outageSamples,
    observedMs: outageObservedMs,
    after: retained,
    document: await documentState(),
  };
  // Change only the native declaration shape, without a separate version-file
  // update. Wait for the new rendered shape so one source edit means one remount.
  const shapeBefore = retained;
  const previousShape = await fs.readFile(remoteWidgetFile, 'utf8');
  assert.equal(previousShape.split('const count$ = useSignal$(0);').length, 2);
  assert.equal(previousShape.split('data-hydrated={hydrated}').length, 2);
  await fs.writeFile(
    remoteWidgetFile,
    previousShape
      .replace(
        'const count$ = useSignal$(0);',
        "const refreshShape$ = useSignal$('expanded');\n  const count$ = useSignal$(0);",
      )
      .replace(
        'data-hydrated={hydrated}',
        'data-refresh-shape={refreshShape$.get()} data-hydrated={hydrated}',
      ),
  );
  const shapeAfter = await assertRetainedUpdate(
    'Remote native v6',
    null,
    'incompatibleRefresh',
    { compatible: false, shape: 'expanded' },
  );
  assert.equal(
    shapeAfter.remoteCount,
    'Count 0',
    'incompatible native shape remount starts with initial remote state',
  );
  assertLifecycle(shapeAfter.lifecycle, {
    previous: shapeBefore.lifecycle,
    transition: 'new-owner',
    activations: [1, 1],
  });
  await click('remote-increment');
  const shapeCountAfterClick = await text('remote-increment');
  assert.equal(
    shapeCountAfterClick,
    'Count 1',
    'incompatible refresh leaves one native event handler',
  );
  results.incompatibleUpdate = {
    before: shapeBefore,
    after: shapeAfter,
    countAfterClick: shapeCountAfterClick,
    renderedShape: await browser(
      'get',
      'attr',
      '[data-testid="remote-widget"]',
      'data-refresh-shape',
    ),
    document: await documentState(),
  };
  // Shrinking the declaration layout is a separate incompatible update and
  // must reset only the remote once, just like adding a declaration.
  const removalBefore = await browserObservation();
  retained = removalBefore;
  await fs.writeFile(remoteWidgetFile, previousShape);
  const removalAfter = await assertRetainedUpdate(
    'Remote native v6',
    null,
    'incompatibleRemoval',
    { compatible: false, shape: null },
  );
  assert.equal(removalAfter.remoteCount, 'Count 0');
  assertLifecycle(removalAfter.lifecycle, {
    previous: removalBefore.lifecycle,
    transition: 'new-owner',
    activations: [1, 1],
  });
  await click('remote-increment');
  const removalCountAfterClick = await text('remote-increment');
  assert.equal(removalCountAfterClick, 'Count 1');
  results.incompatibleRemovalUpdate = {
    before: removalBefore,
    after: removalAfter,
    countAfterClick: removalCountAfterClick,
    renderedShape: removalAfter.refreshShape,
    document: await documentState(),
  };
  await click('host-toggle');
  await waitFor(
    async () =>
      (await browser('get', 'count', '[data-testid="remote-widget"]')) === '0',
    'normal Octane remote removal',
  );
  const removed = await evaluate('globalThis.__octaneMFRemoteLifecycle');
  assertLifecycle(removed, {
    previous: removalAfter.lifecycle,
    transition: 'unmounted',
    activations: [0, 0],
  });
  assert.equal(await text('host-increment'), 'Host count 2');
  const navigationBefore = await documentState();
  await click('host-away');
  await waitFor(
    async () =>
      (await browser('get', 'count', '[data-testid="away-route"]')) === '1',
    'native router navigation after HMR',
  );
  const navigationAway = await evaluate(
    `({ sentinel: globalThis.__octaneMFDocumentSentinel, timeOrigin: performance.timeOrigin, location: location.href, historyLength: history.length, routerPath: document.querySelector('[data-testid="away-route"]')?.getAttribute('data-path'), routerKey: document.querySelector('[data-testid="away-route"]')?.getAttribute('data-router-key') })`,
  );
  assert.equal(new URL(navigationAway.location).pathname, '/away');
  assert.equal(navigationAway.routerPath, '/away');
  assert.equal(navigationAway.sentinel, sentinel.sentinel);
  assert.equal(navigationAway.timeOrigin, sentinel.timeOrigin);
  assert.equal(navigationAway.historyLength, sentinel.historyLength + 1);
  await click('host-back');
  await waitFor(
    async () => (await text('remote-version')) === 'Remote native v6',
    'native router return after HMR',
  );
  const navigationBack = await documentState();
  const navigationBackBrowser = await browserObservation();
  assertLifecycle(navigationBackBrowser.lifecycle, {
    previous: removed,
    transition: 'new-owner',
    activations: [1, 1],
  });
  assert.equal(new URL(navigationBack.location).pathname, '/');
  assert.equal(navigationBack.routerPath, '/');
  assert.equal(navigationBack.sentinel, sentinel.sentinel);
  assert.equal(navigationBack.timeOrigin, sentinel.timeOrigin);
  assert.equal(navigationBack.historyLength, sentinel.historyLength + 2);
  assert.notEqual(navigationAway.routerKey, sentinel.routerKey);
  assert.notEqual(navigationBack.routerKey, navigationAway.routerKey);
  results.navigation = {
    before: navigationBefore,
    away: navigationAway,
    back: navigationBack,
  };
  await click('host-toggle');
  await waitFor(
    async () =>
      (await browser('get', 'count', '[data-testid="remote-widget"]')) === '0',
    'returned route remote removal',
  );
  const finalCleanup = await evaluate('globalThis.__octaneMFRemoteLifecycle');
  assertLifecycle(finalCleanup, {
    transition: 'unmounted',
    previous: navigationBackBrowser.lifecycle,
    activations: [0, 0],
  });
  results.hmr = {
    nativeCleanup: finalCleanup,
    beforeFinalCleanup: navigationBackBrowser.lifecycle,
    removedLifecycle: removed,
    documentBefore: sentinel,
    documentAfterUpdates: results.incompatibleUpdate.document,
    hostCountAfterUpdates: shapeAfter.hostCount,
    hostPropsAfterUpdates: shapeAfter.label,
    remoteRootsAfterUpdates: shapeAfter.remoteRoots,
  };
  results.pageErrors = await browser('errors');
  results.console = await browser('console');
  assert.equal(results.pageErrors, '', 'no uncaught browser errors');
  assert.doesNotMatch(
    results.console,
    /hydration|hydrating|mismatch/iu,
    'no hydration diagnostics',
  );
  results.verdict = 'PASS';
} catch (error) {
  failure = error;
  results.verdict = 'FAIL';
  results.failure = String(error);
  if (browserOpened && !cancellation.signal.aborted) {
    results.entryRequests = await browser(
      'network',
      'requests',
      '--filter',
      'localhost',
    ).catch(String);
    results.markerRequests = await browser(
      'network',
      'requests',
      '--filter',
      '__octane_mf_marker',
    ).catch(String);
    results.browserSnapshot = await evaluate(`({
      marker: typeof window.__ssrRemoteWidget !== 'undefined',
      markerIsNull: window.__ssrRemoteWidget === null,
      markerConnected: window.__ssrRemoteWidget?.isConnected ?? false,
      markerMatchesCurrent: window.__ssrRemoteWidget !== null && window.__ssrRemoteWidget === document.querySelector('[data-testid="remote-widget"]'),
      markerCapture: window.__ssrRemoteWidgetCapture,
      markedWidgetHTML: window.__ssrRemoteWidget?.outerHTML ?? null,
      currentWidgetHTML: document.querySelector('[data-testid="remote-widget"]')?.outerHTML ?? null,
      markerBeforeHydration: window.__ssrRemoteAlreadyHydrated,
      nativeScripts: window.__ssrEntryScripts,
      hydration: document.querySelector('[data-testid="remote-widget"]')?.getAttribute('data-hydrated'),
      lifecycle: globalThis.__octaneMFRemoteLifecycle,
      resources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, initiator: entry.initiatorType, responseEnd: entry.responseEnd, transferSize: entry.transferSize }))
    })`).catch(String);
    results.pageErrors = await browser('errors').catch(String);
    results.console = await browser('console').catch(String);
    results.html = await browser('get', 'html', 'body').catch(String);
    if (
      results.ssr?.remoteMarkup &&
      !remoteEdited &&
      !cancellation.signal.aborted
    ) {
      let directHydrated = false;
      try {
        const originalHost = new URL(developmentURLs.hostUrl);
        originalHost.hostname = 'localhost';
        await browser('open', originalHost.href);
        await waitFor(
          async () =>
            (await text('remote-increment')) === 'Count 0' &&
            (await browser(
              'get',
              'attr',
              '[data-testid="remote-widget"]',
              'data-hydrated',
            )) === 'true',
          'direct native host hydration',
        );
        await click('remote-increment');
        await click('remote-increment');
        await click('host-increment');
        await click('host-increment');
        await click('host-relabel');
        assert.equal(await text('remote-increment'), 'Count 2');
        assert.equal(await text('host-increment'), 'Host count 2');
        assert.equal(await text('remote-label'), 'relabelled');
        assert.equal(
          await browser(
            'get',
            'attr',
            '[data-testid="remote-widget"]',
            'data-owner',
          ),
          'host-owned',
        );
        results.directHostControl = await evaluate(`(() => {
          globalThis.__octaneMFControlSentinel = crypto.randomUUID();
          return { hydrated: true, remoteCount: 2, hostCount: 2, label: 'relabelled', owner: 'host-owned', sentinel: globalThis.__octaneMFControlSentinel, timeOrigin: performance.timeOrigin, location: location.href, lifecycle: globalThis.__octaneMFRemoteLifecycle };
        })()`);
        directHydrated = true;
      } catch (error) {
        results.directHostControl = { hydrated: false, error: String(error) };
      }
      // Initial hydration failure must not hide same-process server freshness.
      // Keep the original failure verdict while measuring the real native edit.
      try {
        cancellation.signal.throwIfAborted();
        await editRemoteSource();
        const diagnosticUpdates = await Promise.allSettled([
          verifyFreshRemoteSSR(developmentURLs),
          directHydrated
            ? waitFor(
                async () =>
                  (await text('remote-version')) === 'Remote native v2',
                'direct native remote update',
              )
            : Promise.resolve(),
        ]);
        results.updatesAfterFailure = diagnosticUpdates.map(
          (update, index) => ({
            observation:
              index === 0
                ? 'same-process server update'
                : 'direct native browser update',
            status: index === 1 && !directHydrated ? 'not-run' : update.status,
            ...(index === 1 && !directHydrated
              ? { reason: 'direct native hydration failed' }
              : {}),
            ...(update.status === 'rejected'
              ? { error: String(update.reason) }
              : {}),
          }),
        );
        results.directHostAfterEdit = await evaluate(`({
        version: document.querySelector('[data-testid="remote-version"]')?.textContent,
        hostCount: document.querySelector('[data-testid="host-increment"]')?.textContent,
        remoteCount: document.querySelector('[data-testid="remote-increment"]')?.textContent,
        label: document.querySelector('[data-testid="remote-label"]')?.textContent,
        sentinel: globalThis.__octaneMFControlSentinel,
        timeOrigin: performance.timeOrigin,
        location: location.href,
        lifecycle: globalThis.__octaneMFRemoteLifecycle
      })`).catch(String);
        results.directHostErrors = await browser('errors').catch(String);
        results.directHostConsole = await browser('console').catch(String);
        results.directHostEntryRequests = await browser(
          'network',
          'requests',
          '--filter',
          'localhost',
        ).catch(String);
      } catch (error) {
        results.editDiagnosticsFailure = String(error);
      }
    }
  }
  results.serverLogs = children.map(child =>
    child.log.length <= 8192
      ? child.log
      : `${child.log.slice(0, 4096)}\n[intermediate log omitted]\n${child.log.slice(-4096)}`,
  );
} finally {
  const cleanupErrors = [];
  if (browserOpened)
    await execute('agent-browser', ['close'], {
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: owner,
        AGENT_BROWSER_HEADED: 'false',
        ...(sourceContext
          ? { AGENT_BROWSER_EXECUTABLE_PATH: sourceContext.browserExecutable }
          : {}),
      },
      timeout: 15_000,
    }).catch(error => cleanupErrors.push(error));
  let processesRetired = true;
  for (const child of children)
    await stopChild(child).catch(error => {
      processesRetired = false;
      cleanupErrors.push(error);
    });
  if (sourceContext)
    await sourceHelpers
      .retireSourceDevInstallers(sourceContext)
      .catch(error => {
        processesRetired = false;
        cleanupErrors.push(error);
      });
  await proxy?.().catch(error => cleanupErrors.push(error));
  let releasedArtifactCount = 0;
  if (processesRetired)
    for (const directory of artifacts)
      await guardianCommand(['release', directory, '--owner', owner]).then(
        () => {
          releasedArtifactCount++;
        },
        error => cleanupErrors.push(error),
      );
  else results.retainedArtifacts = [...artifacts];
  const processGroups = [];
  for (const child of children) {
    try {
      processGroups.push({ pid: child.pid, alive: await groupAlive(child) });
    } catch (error) {
      cleanupErrors.push(error);
      processGroups.push({ pid: child.pid, inspectionError: String(error) });
    }
  }
  results.resourceCleanup = {
    processGroups,
    releasedArtifactCount,
    registeredArtifactCount: artifacts.size,
    errorCount: cleanupErrors.length,
  };
  if (sourceContext && processesRetired && cleanupErrors.length === 0)
    try {
      sourceHelpers.cleanupSourceDevContext(sourceContext);
    } catch (error) {
      cleanupErrors.push(error);
      results.resourceCleanup.errorCount = cleanupErrors.length;
    }
  if (cleanupErrors.length) {
    results.verdict = 'FAIL';
    results.cleanupErrors = cleanupErrors.map(String);
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'The Octane dev proof did not retire all owned resources.',
    );
  }
  if (packedContext && !failure) {
    const receipt = process.env.ULTRAMODERN_MF_DEV_OBSERVATIONS;
    assert.ok(
      receipt,
      'Packed dev refresh must persist its actual observations.',
    );
    await fs.writeFile(receipt, `${JSON.stringify(results, null, 2)}\n`, {
      flag: 'wx',
    });
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}
if (failure) throw failure;
