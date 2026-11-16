import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { retireOwnedProcessGroup } from '../react-rsc-worker-proof/runtime.mjs';
import { assertRequestHtml, sha256 } from './contract.mjs';

export async function waitFor(
  predicate,
  label,
  { signal, timeoutMs = 30_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const value = await predicate();
    if (value) return value;
    assert(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(25, undefined, { signal });
  }
}

export async function startControlServer(origins) {
  const evidence = [];
  const terminals = [];
  const gates = new Map();
  const held = new Set();
  const sockets = new Set();
  let mode = 'valid';
  let modeRequestCount = 0;
  const server = http.createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://127.0.0.1');
    const started = Date.now();
    const record = {
      method: incoming.method,
      path: url.pathname,
      token: url.searchParams.get('token'),
      mode,
      startedAt: new Date(started).toISOString(),
    };
    evidence.push(record);
    outgoing.setHeader('access-control-allow-origin', '*');
    outgoing.once('close', () => {
      record.elapsedMs = Date.now() - started;
      record.closedBeforeEnd = !outgoing.writableEnded;
      held.delete(outgoing);
    });
    try {
      if (url.pathname === '/gate') {
        const token = url.searchParams.get('token');
        assert(token && /^[a-zA-Z0-9_-]+$/u.test(token));
        const gate = gates.get(token) ?? {
          arrived: 0,
          responses: [],
          released: false,
        };
        gates.set(token, gate);
        gate.arrived += 1;
        outgoing.setHeader('content-type', 'text/plain; charset=utf-8');
        if (gate.released) outgoing.end(token);
        else {
          gate.responses.push(outgoing);
          held.add(outgoing);
        }
        return;
      }
      if (url.pathname === '/terminal' && incoming.method === 'POST') {
        const bytes = [];
        for await (const chunk of incoming) bytes.push(Buffer.from(chunk));
        const value = JSON.parse(Buffer.concat(bytes).toString());
        assert(
          typeof value.token === 'string' && typeof value.status === 'string',
        );
        terminals.push({ ...value, observedAt: new Date().toISOString() });
        outgoing.end('recorded');
        return;
      }
      const match = /^\/manifest\/(healthy|fragile)\.json$/u.exec(url.pathname);
      if (match) {
        const role = match[1];
        record.role = role;
        if (role === 'fragile' && mode !== 'valid') {
          record.modeRequest = ++modeRequestCount;
          if (mode === 'endpoint-failure') {
            outgoing.writeHead(404);
            outgoing.end('Native remote manifest endpoint unavailable');
          } else if (modeRequestCount === 1) {
            outgoing.writeHead(503);
            outgoing.end(
              'Native remote manifest endpoint temporarily unavailable',
            );
          } else {
            record.recoveryHang = true;
            held.add(outgoing);
          }
          return;
        }
        const response = await fetch(`${origins[role]}/mf-manifest.json`, {
          signal: AbortSignal.timeout(15_000),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        record.status = response.status;
        record.byteLength = bytes.length;
        record.sha256 = sha256(bytes);
        outgoing.writeHead(response.status, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        });
        outgoing.end(bytes);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end('Unknown proof control endpoint');
    } catch (error) {
      record.error = error.message;
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end('Proof control endpoint failed');
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    evidence,
    terminals,
    gates,
    origins,
    get pendingConnectionCount() {
      return held.size;
    },
    setMode(value) {
      assert(['valid', 'endpoint-failure', 'timeout'].includes(value));
      assert.equal(
        held.size,
        0,
        'Fault modes may change only after held requests settle',
      );
      mode = value;
      modeRequestCount = 0;
    },
    release(token) {
      const gate = gates.get(token);
      assert(
        gate && !gate.released,
        `Unknown or previously released gate: ${token}`,
      );
      gate.released = true;
      for (const response of gate.responses)
        if (!response.destroyed) response.end(token);
    },
    async close() {
      for (const response of held) response.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      return { heldConnectionsClosed: held.size, requests: evidence.length };
    },
  };
}

export function launchServer(node, cli, { cwd, env, log, signal }) {
  const descriptor = fs.openSync(log, 'wx');
  const child = spawn(node, [cli, 'serve'], {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', descriptor, descriptor],
  });
  let failure;
  let stopping = false;
  let cleanup;
  const closed = new Promise((resolve, reject) => {
    child.once('error', error => {
      failure = error;
      reject(error);
    });
    child.once('close', (code, terminatedBy) => {
      fs.closeSync(descriptor);
      if (!stopping)
        failure ??= new Error(
          `Owned native server exited (${code}, ${terminatedBy}); see ${log}`,
        );
      resolve({ code, terminatedBy });
    });
  });
  closed.catch(() => {});
  const stop = () =>
    (cleanup ??= (async () => {
      stopping = true;
      const terminate = name => {
        try {
          process.platform === 'win32'
            ? child.kill(name)
            : process.kill(-child.pid, name);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      };
      terminate('SIGTERM');
      const deadline = setTimeout(() => terminate('SIGKILL'), 3000);
      try {
        const result = await closed;
        return {
          pid: child.pid,
          ...result,
          ...(process.platform === 'win32'
            ? {}
            : {
                processGroupCleanup: await retireOwnedProcessGroup(child.pid),
              }),
        };
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
      }
    })());
  const abort = () => {
    void stop();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    child,
    closed,
    log,
    stop,
    get failure() {
      return failure;
    },
  };
}

export async function ready(server, url, signal) {
  return waitFor(
    async () => {
      if (server.failure) throw server.failure;
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(1500),
        });
        await response.arrayBuffer();
        return response.status === 200;
      } catch {
        return false;
      }
    },
    `native MF server ${url}`,
    { signal, timeoutMs: 60_000 },
  );
}

// Node's fetch user agent reads as a bot, and native SSR answers bots only
// after all content is ready. A browser agent receives the streamed shell.
const browserUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function readNativeStream(url, signal, headers) {
  const response = await fetch(url, { signal, headers });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const chunks = [];
  let completion;
  const completed = () =>
    (completion ??= (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return Buffer.concat(chunks).toString();
        chunks.push(Buffer.from(chunk.value));
      }
    })());
  return {
    response,
    reader,
    chunks,
    completed,
    text: () => Buffer.concat(chunks).toString(),
  };
}

export async function overlapAndAbortProof(hostOrigin, control, signal) {
  const tokens = {
    first: 'overlap_A',
    second: 'overlap_B',
    aborted: 'abort_A',
    healthy: 'abort_B',
    later: 'after_abort_C',
  };
  const openHeld = async (token, requestSignal = signal, headers) => {
    const promise = readNativeStream(
      `${hostOrigin}/mf?token=${token}&gate=held`,
      requestSignal,
      headers,
    );
    await waitFor(
      () => control.gates.get(token)?.arrived >= 2,
      `both real remote resources for ${token}`,
      { signal },
    );
    return promise;
  };
  // Fetch waits for response headers. Start the consuming tasks before opening
  // the gates so both actual SSR requests can reach their Suspense resources.
  const firstPending = openHeld(tokens.first);
  const secondPending = openHeld(tokens.second);
  await waitFor(
    () =>
      [tokens.first, tokens.second].every(
        token => control.gates.get(token)?.arrived >= 2,
      ),
    'overlapping native SSR request arrivals',
    { signal },
  );
  control.release(tokens.second);
  const second = await secondPending;
  const secondHtml = await second.completed();
  assert(
    !secondHtml.includes(tokens.first),
    'The completed B response must exclude request A',
  );
  control.release(tokens.first);
  const first = await firstPending;
  const firstHtml = await first.completed();
  assert(
    !firstHtml.includes(tokens.second),
    'The completed A response must exclude request B',
  );
  const expectedAssets = {
    origins: control.origins,
    expectedRemoteCss: control.expectedRemoteCss,
  };
  const completed = {
    first: assertRequestHtml(firstHtml, tokens.first, expectedAssets),
    second: assertRequestHtml(secondHtml, tokens.second, expectedAssets),
    completionOrder: ['B', 'A'],
  };
  // The overlap pair is read as a bot, so the cold remotes' Helmet markers
  // finish before the head is sent. Cancellation needs streamed shell bytes,
  // which only a browser agent receives before the held gates open.
  const streamed = { 'user-agent': browserUserAgent };
  const abort = new AbortController();
  const abortedPending = openHeld(
    tokens.aborted,
    AbortSignal.any([signal, abort.signal]),
    streamed,
  );
  // Prevent an unhandled rejection while the other request reaches its gate.
  abortedPending.catch(() => {});
  const healthyPending = openHeld(tokens.healthy, signal, streamed);
  await waitFor(
    () =>
      [tokens.aborted, tokens.healthy].every(
        token => control.gates.get(token)?.arrived >= 2,
      ),
    'abort A and healthy B remote arrivals',
    { signal },
  );
  const aborted = await abortedPending;
  const abortedBody = aborted.completed();
  abortedBody.catch(() => {});
  await waitFor(
    () =>
      aborted.text().includes('healthy-proof') ||
      aborted.text().includes('healthy-pending'),
    'native aborted request shell bytes',
    { signal },
  );
  abort.abort(
    new Error('Owned HTTP consumer intentionally cancelled after shell'),
  );
  await assert.rejects(abortedBody);
  await waitFor(
    () =>
      control.terminals.some(
        record =>
          record.token === tokens.aborted && record.status === 'cancelled',
      ),
    'native cancelled terminal after HTTP abort',
    { signal },
  );
  control.release(tokens.healthy);
  const healthy = await healthyPending;
  const healthyHtml = await healthy.completed();
  assert(!healthyHtml.includes(tokens.aborted));
  control.release(tokens.aborted);
  const laterResponse = await fetch(`${hostOrigin}/mf?token=${tokens.later}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  assert.equal(laterResponse.status, 200);
  const laterHtml = await laterResponse.text();
  assert(
    !laterHtml.includes(tokens.aborted),
    'A later actual request must exclude the cancelled request',
  );
  await waitFor(
    () => control.terminals.some(record => record.token === tokens.later),
    'later native stream terminal',
    { signal },
  );
  const abortedTerminals = control.terminals.filter(
    record => record.token === tokens.aborted,
  );
  assert.deepEqual(
    abortedTerminals.map(record => record.status),
    ['cancelled'],
    'Native cancellation must finalize exactly once, including after late resource bytes',
  );
  return {
    tokens,
    overlap: completed,
    aborted: {
      receivedBytes: Buffer.concat(aborted.chunks).length,
      terminals: abortedTerminals,
      remoteDownloadsCancelled: false,
    },
    healthy: assertRequestHtml(healthyHtml, tokens.healthy, expectedAssets),
    later: assertRequestHtml(laterHtml, tokens.later, {
      deferred: false,
      ...expectedAssets,
    }),
    qualification:
      'actual-native-remote-SSR-request-props-head-CSS-and-stream-cancellation',
  };
}

export async function recoveryTimeoutProof(hostOrigin, control, signal) {
  const token = 'native_recovery_timeout';
  const response = await fetch(`${hostOrigin}/mf?token=${token}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert(
    html.includes('healthy-proof'),
    'The healthy native SSR remote must survive its sibling manifest timeout',
  );
  assert(
    html.includes('fragile-pending') || html.includes('fragile-fallback'),
    'Native React must render the failed remote Suspense/error fallback',
  );
  // Production React marks a boundary it hands to the client with <!--$!-->
  // (or $RX once the shell is out); data-msg is development-only and
  // data-dgst needs an onError digest the framework does not return.
  assert(
    /<!--\$!-->|\$RX\(/u.test(html),
    'Native React must emit its actual failed Suspense marker',
  );
  const attempts = control.evidence.filter(
    record => record.mode === 'timeout' && record.role === 'fragile',
  );
  assert.equal(attempts[0]?.modeRequest, 1);
  assert.equal(
    attempts[0]?.recoveryHang,
    undefined,
    'The initial request must receive real HTTP503 instead of hanging',
  );
  await waitFor(
    () =>
      attempts
        .filter(record => record.recoveryHang)
        .every(record => record.closedBeforeEnd),
    'native recovery fetch connection cancellation',
    { signal },
  );
  const recovery = attempts.filter(record => record.recoveryHang);
  assert(
    recovery.length >= 1,
    'The existing native server manifest recovery hook must fetch again',
  );
  assert(
    recovery.every(
      record =>
        record.closedBeforeEnd &&
        record.elapsedMs >= 750 &&
        record.elapsedMs < 5000,
    ),
    'Actual recovery connections must close at the bounded native fetch deadline',
  );
  await waitFor(
    () => control.terminals.some(record => record.token === token),
    'native timeout fallback terminal',
    { signal },
  );
  return {
    token,
    status: response.status,
    byteLength: Buffer.byteLength(html),
    htmlSha256: sha256(html),
    nativeSuspenseErrorFallback: true,
    healthySiblingSsr: true,
    initialResponse: 503,
    recoveryConnections: recovery,
    terminal: control.terminals.filter(record => record.token === token),
    timeoutObservation:
      'Actual HTTP recovery connections close before any response at the installed server recovery deadline; the native plugin creates AbortSignal.timeout for each retry fetch.',
    initialHangingManifestDeadlineProved: false,
  };
}
