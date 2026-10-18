import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createRequestDiagnostics } from './generated-request-diagnostics.mjs';

function request(url, failure = undefined) {
  return {
    url: () => url,
    method: () => 'GET',
    resourceType: () => 'fetch',
    failure: () => failure,
  };
}

test('correlates overlapping page requests, phases and terminal outcomes', () => {
  let time = 100;
  const diagnostic = createRequestDiagnostics({ now: () => time++ });
  const main = new EventEmitter();
  const isolated = new EventEmitter();
  diagnostic.attach(main, 'main');
  diagnostic.attach(isolated, 'isolated-1');
  const first = request('http://localhost/?__loader=index_page');
  const second = request('http://localhost/?__loader=index_page', {
    errorText: 'net::ERR_ABORTED',
  });
  diagnostic.phase('deferred navigation');
  main.emit('request', first);
  isolated.emit('request', second);
  main.emit('response', { request: () => first, status: () => 200 });
  diagnostic.phase('overlapping pages');
  isolated.emit('requestfailed', second);
  main.emit('requestfinished', first);
  const snapshot = diagnostic.snapshot();
  assert.equal(snapshot.dropped, 0);
  assert.deepEqual(
    snapshot.events.map(({ id, page, phase, kind, timeMs }) => ({
      id,
      page,
      phase,
      kind,
      timeMs,
    })),
    [
      {
        id: 1,
        page: 'main',
        phase: 'deferred navigation',
        kind: 'request',
        timeMs: 1,
      },
      {
        id: 2,
        page: 'isolated-1',
        phase: 'deferred navigation',
        kind: 'request',
        timeMs: 2,
      },
      {
        id: 1,
        page: 'main',
        phase: 'deferred navigation',
        kind: 'response',
        timeMs: 3,
      },
      {
        id: 2,
        page: 'isolated-1',
        phase: 'overlapping pages',
        kind: 'failed',
        timeMs: 4,
      },
      {
        id: 1,
        page: 'main',
        phase: 'overlapping pages',
        kind: 'finished',
        timeMs: 5,
      },
    ],
  );
  assert.equal(snapshot.events[2].status, 200);
  assert.equal(snapshot.events[3].failure, 'net::ERR_ABORTED');
});

test('bounds retained events and strings without losing request identity', () => {
  const diagnostic = createRequestDiagnostics({ limit: 2, now: () => 0 });
  const page = new EventEmitter();
  diagnostic.attach(page, 'main');
  const first = request('x'.repeat(3000), { errorText: 'e'.repeat(1000) });
  page.emit('request', first);
  page.emit('response', { request: () => first, status: () => 200 });
  page.emit('requestfailed', first);
  const snapshot = diagnostic.snapshot();
  assert.equal(snapshot.dropped, 1);
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(
    snapshot.events.map(event => event.id),
    [1, 1],
  );
  assert.equal(snapshot.events[1].url.length, 2048);
  assert.equal(snapshot.events[1].failure.length, 512);
  snapshot.events.pop();
  assert.equal(diagnostic.snapshot().events.length, 2);
});

test('retains early failures and HTTP errors after normal traffic rolls over', () => {
  let time = 0;
  const diagnostic = createRequestDiagnostics({
    limit: 2,
    abnormalLimit: 2,
    now: () => time++,
  });
  const page = new EventEmitter();
  diagnostic.attach(page, 'main');
  const failed = request('http://localhost/?__loader=index_page', {
    errorText: 'net::ERR_ABORTED',
  });
  diagnostic.phase('deferred navigation');
  page.emit('request', failed);
  diagnostic.phase('deferred completion');
  page.emit('requestfailed', failed);
  const broken = request('http://localhost/broken.js');
  page.emit('request', broken);
  page.emit('response', { request: () => broken, status: () => 500 });
  diagnostic.phase('isolated pages');
  for (let i = 0; i < 10; i++) {
    const healthy = request(`http://localhost/healthy-${i}.js`);
    page.emit('request', healthy);
    page.emit('response', { request: () => healthy, status: () => 200 });
    page.emit('requestfinished', healthy);
  }
  const snapshot = diagnostic.snapshot();
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.dropped, 32);
  assert.equal(snapshot.abnormal.length, 2);
  assert.equal(snapshot.droppedAbnormal, 0);
  assert.equal(snapshot.abnormal[0].id, 1);
  assert.equal(snapshot.abnormal[0].phase, 'deferred completion');
  assert.equal(snapshot.abnormal[0].startedPhase, 'deferred navigation');
  assert.equal(snapshot.abnormal[0].startedAtMs, 1);
  assert.equal(snapshot.abnormal[0].failure, 'net::ERR_ABORTED');
  assert.equal(snapshot.abnormal[1].status, 500);
  page.emit(
    'requestfailed',
    request('http://localhost/later', {
      errorText: 'later failure',
    }),
  );
  assert.equal(diagnostic.snapshot().droppedAbnormal, 1);
  assert.deepEqual(diagnostic.snapshot().abnormal, snapshot.abnormal);
  snapshot.abnormal[0].failure = 'modified snapshot';
  assert.equal(diagnostic.snapshot().abnormal[0].failure, 'net::ERR_ABORTED');
});
