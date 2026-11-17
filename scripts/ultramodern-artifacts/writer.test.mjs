import assert from 'node:assert/strict';
import test from 'node:test';
import * as protocol from '../ultramodern-renderers/native-artifacts/protocol.mjs';
import { writerApi } from './main.mjs';

const route = `/repos/${protocol.repository}/releases`;
const token = 'unit-secret-token';

test('release errors retain permission and rate-limit evidence without credentials', async () => {
  const api = writerApi({
    protocol,
    token,
    fetchArtifact: async () =>
      new Response(
        JSON.stringify({
          message: `Resource not accessible by integration ${token}`,
          ignored: 'Do not log arbitrary response fields',
        }),
        {
          status: 403,
          headers: {
            'x-github-request-id': 'unit-request',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '123',
            'retry-after': '60',
            'set-cookie': 'Do not log arbitrary headers',
          },
        },
      ),
  });
  await assert.rejects(api('POST', route, { draft: true }), error => {
    assert.match(error.message, /HTTP 403/u);
    assert.match(error.message, /Resource not accessible by integration/u);
    assert.match(error.message, /"x-github-request-id":"unit-request"/u);
    assert.match(error.message, /"x-ratelimit-remaining":"0"/u);
    assert.match(error.message, /"retry-after":"60"/u);
    assert(!error.message.includes(token));
    assert(!error.message.includes('Do not log'));
    return true;
  });
});

test('non-JSON errors still retain status and request identity', async () => {
  const api = writerApi({
    protocol,
    token,
    fetchArtifact: async () =>
      new Response('upstream HTML', {
        status: 502,
        headers: { 'x-github-request-id': 'unit-gateway' },
      }),
  });
  await assert.rejects(api('POST', route), /HTTP 502.*unit-gateway/u);
});

test('optional absence stays distinct from a refused write', async () => {
  const api = writerApi({
    protocol,
    token,
    fetchArtifact: async () => new Response(null, { status: 404 }),
  });
  assert.equal(await api('GET', route, undefined, { optional: true }), null);
  await assert.rejects(api('POST', route), /HTTP 404/u);
});
