import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifyPackedWorkerProofEnvelope,
  verifyPackedWorkerProofResult,
  verifyPrebuiltWorkerServices,
} from './native-federation-worker.mjs';

const browserProof = () => ({
  ssrBeforeHydration: true,
  exactNodeAdoption: true,
  browserRecovery: true,
  ssrElapsedMs: 120,
});
const modes = [
  'unavailable',
  'headers-hang',
  'body-hang',
  'manifest-unavailable',
  'manifest-headers-hang',
  'manifest-body-hang',
  'foreign-manifest',
  'foreign-renderer',
  'foreign-request-authority',
  'foreign-response-authority',
  'foreign-native-publisher',
  'foreign-native-abi',
  'foreign-native-document',
  'foreign-native-boundary',
  'foreign-native-echo',
];
const completeProof = () => ({
  mode: 'packed',
  positive: Array.from({ length: 2 }, browserProof),
  concurrent: Array.from({ length: 4 }, browserProof),
  requestDigests: Array.from({ length: 4 }, (_, index) =>
    String(index).repeat(64),
  ),
  routes: Array.from({ length: 3 }, () => ({
    adopted: true,
    nestedDisposed: true,
    observed: [
      {
        appId: 'host',
        pathname: '/',
        language: 'en',
        greeting: 'hello',
        match: { id: 'root' },
        host: {
          appId: 'host',
          pathname: '/',
          language: 'en',
          greeting: 'hello',
          match: { id: 'root' },
        },
      },
    ],
  })),
  hops: [
    {
      routes: ['/en/', '/cs/'],
      requests: [
        { method: 'POST', status: 200 },
        { method: 'POST', status: 200 },
      ],
    },
  ],
  counterCompilations: [{}, {}, {}],
  faults: modes.map(mode => ({
    mode,
    proof: browserProof(),
    activeRequests: 0,
    cancellations: 1,
    requests: [
      {
        mode,
        method: mode.startsWith('manifest-') ? 'GET' : 'POST',
        mutation: mode,
      },
    ],
  })),
});

test('the installed Worker receipt requires actual isolation, browser, hop and cancellation observations', () => {
  assert(
    Object.values(verifyPackedWorkerProofResult(completeProof())).every(
      Boolean,
    ),
  );
  for (const field of [
    'positive',
    'concurrent',
    'routes',
    'hops',
    'counterCompilations',
    'faults',
  ]) {
    const incomplete = completeProof();
    incomplete[field] = [];
    assert.throws(() => verifyPackedWorkerProofResult(incomplete));
  }
  for (const mutate of [
    result => {
      result.mode = 'source';
    },
    result => {
      result.requestDigests[0] = result.requestDigests[1];
    },
    result => {
      result.positive[0].ssrBeforeHydration = false;
    },
    result => {
      result.positive[0].exactNodeAdoption = false;
    },
    result => {
      result.routes[0].observed[0].host.language = 'cs';
    },
    result => {
      result.hops[0].requests = [];
    },
    result => {
      result.faults[1].cancellations = 0;
    },
    result => {
      result.faults[0].activeRequests = 1;
    },
    result => {
      result.faults[0] = result.faults[1];
    },
  ]) {
    const result = completeProof();
    mutate(result);
    assert.throws(() => verifyPackedWorkerProofResult(result));
  }
});

test('a stale proof from another run or release cannot admit a Worker receipt', () => {
  const binding = {
    sourceRevision: 'a'.repeat(40),
    releaseVersion: '3.9.3-ultramodern.8',
    manifestSha256: 'b'.repeat(64),
    frameworkCohortDigest: 'c'.repeat(64),
  };
  const nonce = '11111111-1111-4111-8111-111111111111';
  const envelope = {
    schemaVersion: 1,
    binding,
    nonce,
    result: completeProof(),
    evidence: Array.from({ length: 10 }, () => ({})),
  };
  assert(
    Object.values(
      verifyPackedWorkerProofEnvelope(envelope, { binding, nonce }),
    ).every(Boolean),
  );
  assert.throws(() =>
    verifyPackedWorkerProofEnvelope(envelope, {
      binding,
      nonce: '22222222-2222-4222-8222-222222222222',
    }),
  );
  assert.throws(() =>
    verifyPackedWorkerProofEnvelope(envelope, {
      binding: { ...binding, sourceRevision: 'd'.repeat(40) },
      nonce,
    }),
  );
  assert.throws(() =>
    verifyPackedWorkerProofEnvelope(
      { ...envelope, evidence: [] },
      { binding, nonce },
    ),
  );
});

test('the prebuilt host uses only genuine preset bindings and preserves the remote hop', () => {
  const services = [
    {
      role: 'host',
      wrangler: {
        services: [
          { binding: 'VERTICAL_A_WORKER', service: 'worker-a' },
          { binding: 'VERTICAL_B_WORKER', service: 'worker-b' },
        ],
      },
    },
    {
      role: 'remote',
      remote: 'a',
      wrangler: { services: [{ binding: 'REMOTE_B', service: 'worker-b' }] },
    },
    { role: 'remote', remote: 'b', wrangler: { services: [] } },
  ];
  assert.equal(
    verifyPrebuiltWorkerServices(services, ['worker-a', 'worker-b']).length,
    3,
  );
  const duplicate = structuredClone(services);
  duplicate[0].wrangler.services.push({
    binding: 'AUTHORED_A',
    service: 'worker-a',
  });
  assert.throws(() =>
    verifyPrebuiltWorkerServices(duplicate, ['worker-a', 'worker-b']),
  );
  const missingHop = structuredClone(services);
  missingHop[1].wrangler.services = [];
  assert.throws(() =>
    verifyPrebuiltWorkerServices(missingHop, ['worker-a', 'worker-b']),
  );
});
