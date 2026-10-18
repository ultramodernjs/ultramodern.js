import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// Run in its own realm/process: the diagnostic intentionally observes native
// prototypes in an owned page and must not alter this test runner's globals.
test('records native abort/cancel stacks without replacing transport outcomes', () => {
  const helper = new URL(
    './generated-cancellation-diagnostics.mjs',
    import.meta.url,
  );
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { installCancellationDiagnostics } from ${JSON.stringify(helper.href)};
    const nativeFetch = globalThis.fetch;
    let result;
    let received;
    globalThis.fetch = function (...args) { received = { receiver: this, args }; if (args[0] === 'data:text/plain,accessor' || args[0] === 'data:text/plain,invalid') result = Reflect.apply(nativeFetch, this, args); return result; };
    installCancellationDiagnostics();
    const controller = new AbortController();
    const reason = new Error('route retired');
    let cancelled;
    const response = new Response(new ReadableStream({ cancel(value) { cancelled = value; } }));
    result = Promise.resolve(response);
    const input = new Request('http://fixture.test/?__loader=index_page');
    const options = { signal: controller.signal };
    assert.equal(globalThis.fetch(input, options), result);
    assert.equal(received.args[0], input);
    assert.equal(received.args[1], options);
    assert.equal(received.receiver, globalThis);
    assert.equal(await result, response);
    const reader = response.body.getReader();
    const cancellation = reader.cancel(reason);
    assert(cancellation instanceof Promise);
    await cancellation;
    assert.equal(cancelled, reason);
    controller.abort(reason);
    assert.equal(controller.signal.reason, reason);
    const snapshot = globalThis.__solidCancellationDiagnostics.snapshot();
    assert.deepEqual(snapshot.events.map(event => event.kind), ['fetch.request', 'fetch.signal', 'reader.cancel', 'controller.abort', 'fetch.abort']);
    for (const event of snapshot.events) {
      if (event.kind === 'reader.cancel') {
        // A constructed Response has no URL; real fetch Responses retain theirs.
        assert.equal(event.url, '');
      } else {
        assert.equal(event.id, 1);
        assert.equal(event.url, input.url);
      }
      assert.match(event.stack, /Cancellation diagnostic/);
    }
    assert.equal(snapshot.events[2].reason, 'Error: route retired');
    assert.equal(snapshot.events[4].reason, 'Error: route retired');
    const body = new ReadableStream({ cancel(value) { cancelled = value; } });
    await body.cancel('body retired');
    assert.equal(cancelled, 'body retired');
    assert.equal(globalThis.__solidCancellationDiagnostics.snapshot().events.at(-1).kind, 'body.cancel');
    const failure = new Error('native fetch failed');
    result = Promise.reject(failure);
    const rejected = fetch('http://fixture.test/rejected');
    assert.equal(rejected, result);
    await assert.rejects(rejected, error => error === failure);
    assert.equal(globalThis.__solidCancellationDiagnostics.snapshot().events.at(-1).kind, 'fetch.request');
    result = nativeFetch('data:text/plain,native-body');
    const nativeResponse = await fetch('data:text/plain,native-body');
    const nativeReader = nativeResponse.body.getReader();
    await nativeReader.cancel('real fetch body');
    const nativeEvent = globalThis.__solidCancellationDiagnostics.snapshot().events.at(-1);
    assert.equal(nativeEvent.kind, 'reader.cancel');
    assert.equal(nativeEvent.url, 'data:text/plain,native-body');
    const unhandled = new Error('must remain unhandled');
    result = Promise.reject(unhandled);
    const observed = new Promise(resolve => process.once('unhandledRejection', (error, promise) => {
      assert.equal(error, unhandled);
      assert.equal(promise, result);
      resolve();
    }));
    assert.equal(fetch('http://fixture.test/unhandled'), result);
    await observed;
    let getterReads = 0;
    const accessorResponse = await fetch('data:text/plain,accessor', { get signal() { getterReads++; return new AbortController().signal; } });
    assert.equal(getterReads, 1);
    await accessorResponse.text();
    const invalid = fetch('data:text/plain,invalid', { signal: 'invalid' });
    assert.equal(invalid, result);
    await assert.rejects(invalid, TypeError);
    const nullController = new AbortController();
    const nullRequest = new Request('data:text/plain,null', { signal: nullController.signal });
    result = Promise.resolve(new Response());
    await fetch(nullRequest, { signal: null });
    nullController.abort('must not be associated');
    assert.equal(globalThis.__solidCancellationDiagnostics.snapshot().events.some(event => event.url === nullRequest.url && event.kind === 'fetch.signal'), false);
    const hostileReason = new Error('hidden');
    Object.defineProperty(hostileReason, 'name', { get() { throw new Error('diagnostic getter'); } });
    const hostileController = new AbortController();
    hostileController.abort(hostileReason);
    assert.equal(hostileController.signal.reason, hostileReason);
    const hostileBody = new ReadableStream({ cancel(value) { assert.equal(value, hostileReason); } });
    await hostileBody.cancel(hostileReason);
    const hostileResponse = new Response('body');
    Object.defineProperty(hostileResponse, 'url', { get() { throw new Error('diagnostic URL getter'); } });
    assert(hostileResponse.body instanceof ReadableStream);
    assert.throws(() => AbortController.prototype.abort.call({}), TypeError);
    result = Promise.resolve(new Response());
    for (let i = 0; i < 150; i++) fetch('http://fixture.test/routine-' + i);
    const lateController = new AbortController();
    fetch('http://fixture.test/late-cancel', { signal: lateController.signal });
    lateController.abort('late cancellation');
    for (let i = 0; i < 150; i++) fetch('http://fixture.test/later-routine-' + i);
    const priority = globalThis.__solidCancellationDiagnostics.snapshot();
    assert.equal(priority.events.some(event => event.url === 'http://fixture.test/late-cancel'), false);
    assert(priority.cancellations.some(event => event.kind === 'fetch.abort' && event.url === 'http://fixture.test/late-cancel' && event.reason === 'late cancellation'));
    assert(priority.observationErrors > 0);
    for (let i = 0; i < 150; i++) new AbortController().abort();
    const bounded = globalThis.__solidCancellationDiagnostics.snapshot();
    assert.equal(bounded.events.length, 128);
    assert(bounded.dropped > 0);
    assert.equal(bounded.cancellations.length, 64);
    assert(bounded.droppedCancellations > 0);
    console.log('native cancellation outcomes preserved');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.match(output, /native cancellation outcomes preserved/);
});
