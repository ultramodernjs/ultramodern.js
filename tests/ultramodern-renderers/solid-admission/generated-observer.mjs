import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

/** A private observer forces two genuine server loaders to remain in flight. */
export async function createSolidConsumerObserver(signal) {
  const nonce = randomUUID();
  const events = [];
  const pending = new Map();
  const allowed = new Set();
  let barrierPair;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== nonce)
      return void response.writeHead(403).end();
    const pathname = new URL(request.url, 'http://observer').pathname;
    if (pathname === '/event' && request.method === 'POST') {
      let body = '';
      for await (const part of request) {
        body += part;
        if (body.length > 4096) return void response.writeHead(413).end();
      }
      try {
        const event = JSON.parse(body);
        assert(allowed.has(event.id) && typeof event.event === 'string');
        events.push({ ...event, time: performance.now() });
        response.end('accepted');
      } catch {
        response.writeHead(400).end();
      }
      return;
    }
    const id = decodeURIComponent(pathname.slice('/barrier/'.length));
    if (pathname.startsWith('/barrier/') && barrierPair?.includes(id)) {
      if (pending.has(id)) {
        response.writeHead(409).end('A loader reached its barrier twice');
        return;
      }
      pending.set(id, response);
      response.once('close', () => {
        if (pending.get(id) === response) pending.delete(id);
      });
      if (barrierPair.every(item => pending.has(item))) {
        events.push({
          event: 'overlap',
          ids: [...barrierPair],
          time: performance.now(),
        });
        for (const item of barrierPair) pending.get(item).end('released');
        pending.clear();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    env: {
      SOLID_CONSUMER_OBSERVER_URL: `http://127.0.0.1:${server.address().port}`,
      SOLID_CONSUMER_OBSERVER_NONCE: nonce,
    },
    requestId() {
      const id = randomUUID();
      allowed.add(id);
      return id;
    },
    pair(ids) {
      assert.equal(ids.length, 2);
      barrierPair = ids;
    },
    events,
    async wait(id, event) {
      const deadline = performance.now() + 15000;
      for (;;) {
        signal?.throwIfAborted();
        const matches = events.filter(
          item => item.id === id && item.event === event,
        );
        if (matches.length) {
          assert.equal(matches.length, 1);
          return matches[0];
        }
        assert(
          performance.now() < deadline,
          `Server did not observe ${id} ${event}`,
        );
        await delay(10, undefined, { signal });
      }
    },
    async close() {
      for (const response of pending.values()) response.destroy();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    },
  };
}
