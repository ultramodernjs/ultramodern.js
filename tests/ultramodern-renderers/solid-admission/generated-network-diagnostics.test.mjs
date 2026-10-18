import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  observeDeferredLoaderNetwork,
  probeRawDeferredLoader,
} from './generated-network-diagnostics.mjs';

function fakePage() {
  const session = new EventEmitter();
  const commands = [];
  session.send = async command => commands.push(command);
  const page = new EventEmitter();
  page.context = () => ({
    newCDPSession: async target => {
      assert.equal(target, page);
      return session;
    },
  });
  return { page, session, commands };
}
const target =
  'http://fixture.test/?case=deferred&__loader=index_page&__ssrDirect=true';

test('passively records byte completion and exact CDP failure details', async () => {
  const { page, session, commands } = fakePage();
  const diagnostic = await observeDeferredLoaderNetwork(page);
  assert.deepEqual(commands, ['Network.enable']);
  session.emit('Network.requestWillBeSent', {
    requestId: 'ignored',
    request: { url: 'http://fixture.test/main.js' },
    timestamp: 1,
  });
  session.emit('Network.requestWillBeSent', {
    requestId: 'target',
    request: { url: target },
    timestamp: 2,
  });
  session.emit('Network.responseReceived', {
    requestId: 'target',
    timestamp: 2.1,
    response: {
      status: 200,
      protocol: 'http/1.1',
      headers: {
        'Transfer-Encoding': 'chunked',
        'Content-Type': 'application/ndjson',
        'Set-Cookie': 'not-retained',
      },
    },
  });
  session.emit('Network.dataReceived', {
    requestId: 'target',
    timestamp: 2.2,
    dataLength: 100,
    encodedDataLength: 115,
  });
  session.emit('Network.dataReceived', {
    requestId: 'target',
    timestamp: 3.5,
    dataLength: 50,
    encodedDataLength: 65,
  });
  session.emit('Network.loadingFailed', {
    requestId: 'target',
    timestamp: 3.51,
    errorText: 'net::ERR_ABORTED',
    canceled: true,
    blockedReason: 'other',
    corsErrorStatus: { corsError: 'InvalidResponse', failedParameter: 'test' },
    type: 'Fetch',
  });
  const failed = diagnostic.snapshot().requests[0];
  assert.equal(failed.chunks, 2);
  assert.equal(failed.dataLength, 150);
  assert.equal(failed.encodedDataLength, 180);
  assert.deepEqual(failed.response.headers, {
    'transfer-encoding': 'chunked',
    'content-type': 'application/ndjson',
  });
  assert.equal(failed.failure.canceled, true);
  assert.equal(failed.failure.errorText, 'net::ERR_ABORTED');
  assert.equal(failed.failure.corsErrorStatus.corsError, 'InvalidResponse');
  session.emit('Network.requestWillBeSent', {
    requestId: 'finished',
    request: { url: target },
    timestamp: 4,
  });
  session.emit('Network.loadingFinished', {
    requestId: 'finished',
    timestamp: 5.5,
    encodedDataLength: 234,
  });
  assert.deepEqual(diagnostic.snapshot().requests[1].finished, {
    at: 5.5,
    encodedDataLength: 234,
  });
  failed.response.headers['content-type'] = 'mutated';
  assert.equal(
    diagnostic.snapshot().requests[0].response.headers['content-type'],
    'application/ndjson',
  );
});

test('bounds target request records without routine traffic consuming capacity', async () => {
  const { page, session } = fakePage();
  const diagnostic = await observeDeferredLoaderNetwork(page);
  for (let i = 0; i < 150; i++)
    session.emit('Network.requestWillBeSent', {
      requestId: `routine-${i}`,
      request: { url: `http://fixture.test/${i}.js` },
    });
  for (let i = 0; i < 20; i++)
    session.emit('Network.requestWillBeSent', {
      requestId: String(i),
      request: { url: target },
      timestamp: i,
    });
  assert.equal(diagnostic.snapshot().requests.length, 16);
  assert.equal(diagnostic.snapshot().dropped, 4);
  assert.equal(diagnostic.snapshot().requests[0].requestId, '4');
});

test('raw diagnostic consumes an actual chunked HTTP body through EOF and closes its context', async () => {
  let chunksEnded = false;
  const server = createServer((request, response) => {
    if (request.url === '/')
      return response.end(
        '<script>throw new Error("must not execute")</script>',
      );
    assert.equal(
      request.url,
      '/?case=deferred&__loader=index_page&__ssrDirect=true',
    );
    response.setHeader('content-type', 'application/ndjson');
    response.write('{"type":"critical"}\n');
    setTimeout(() => {
      chunksEnded = true;
      response.end('{"type":"complete"}\n');
    }, 20);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { page } = fakePage();
  let closed = false;
  page.goto = async url => {
    assert.equal(url, origin);
    await (await fetch(url)).text();
  };
  page.evaluate = fn =>
    vm.runInNewContext(`(${fn.toString()})()`, {
      fetch: (url, options) => fetch(new URL(url, origin), options),
      performance,
      AbortSignal,
      TextDecoder,
      Error,
      JSON,
    });
  const browser = {
    newContext: async options => {
      assert.deepEqual(options, { javaScriptEnabled: false });
      return {
        newPage: async () => page,
        close: async () => {
          closed = true;
        },
      };
    },
  };
  try {
    const result = await probeRawDeferredLoader(browser, origin);
    assert.equal(result.transport.trueEof, true);
    assert.equal(result.transport.status, 200);
    assert.equal(result.transport.completeFrames, 1);
    assert.equal(result.transport.frameTypes.join(','), 'critical,complete');
    assert.equal(chunksEnded, true);
    assert.deepEqual(result.failures, []);
    assert.equal(closed, true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('preserves transport EOF facts when response framing is malformed', async () => {
  const { page } = fakePage();
  let closed = false;
  page.goto = async () => {};
  page.evaluate = fn =>
    vm.runInNewContext(`(${fn.toString()})()`, {
      fetch: async () =>
        new Response('{"type":"critical"}\nmalformed\n', {
          headers: { 'content-type': 'application/ndjson' },
        }),
      performance,
      AbortSignal,
      TextDecoder,
      Error,
      JSON,
    });
  const browser = {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {
        closed = true;
      },
    }),
  };
  const result = await probeRawDeferredLoader(browser, 'http://fixture.test');
  assert.equal(result.transport.trueEof, true);
  assert.equal(result.transport.status, 200);
  assert.equal(result.transport.chunks, 1);
  assert(result.transport.bytes > 0);
  assert.equal(typeof result.transport.elapsedMs, 'number');
  assert.match(result.transport.frameError, /SyntaxError/);
  assert.equal(closed, true);
});

test('closes a hung evaluation context once within the Node-side deadline', async () => {
  const { page } = fakePage();
  let closeCount = 0;
  page.goto = async () => {};
  page.evaluate = () => new Promise(() => {});
  const browser = {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {
        closeCount++;
      },
    }),
  };
  const result = await probeRawDeferredLoader(browser, 'http://fixture.test', {
    evaluationTimeoutMs: 20,
  });
  assert.match(result.transport.error, /evaluation timed out/);
  assert.equal(closeCount, 1);
});
