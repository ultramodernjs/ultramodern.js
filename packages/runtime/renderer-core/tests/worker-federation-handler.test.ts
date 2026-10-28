import * as workerFederationContract from '../src/worker-federation/contract';
import {
  admitWorkerFederationExpose,
  workerFederationEnvelope,
  workerFederationWireJson,
} from '../src/worker-federation/contract';
import { createWorkerFederationHandler } from '../src/worker-federation/handler';
import { WORKER_FEDERATION_MAX_BODY_BYTES } from '../src/worker-federation/lease';
import { createWorkerFederationTransport } from '../src/worker-federation/transport';
import {
  admitRendererContract,
  manifestFixture,
  requestCoordinate,
} from './worker-federation.fixture';
import { deferred, useDeadlineClock } from './worker-federation-clock.fixture';

afterEach(() => rstest.useRealTimers());

const manifest = manifestFixture();
const admitted = admitWorkerFederationExpose({
  ...requestCoordinate,
  manifest,
});
const nativeRequest = '{"native":"request codec bytes"}';
const nativeSnapshot = '{"native":"snapshot codec bytes"}';

function requestFixture(
  value: unknown = workerFederationEnvelope('request', admitted, nativeRequest),
  url = admitted.endpoint,
) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: workerFederationWireJson(value),
  });
}

function handlerFixture(
  options: {
    rejectNative?: boolean;
    render?: () => Promise<unknown>;
    requestTimeout?: number;
    load?: () => Promise<unknown>;
    prepare?: () => Promise<string>;
    release?: () => void | Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const executions: unknown[] = [];
  const handler = createWorkerFederationHandler({
    publication: {
      renderer: manifest.metaData.ultramodernRenderer,
      worker: manifest.metaData.ultramodernWorkerFederation,
    },
    manifestUrl: requestCoordinate.manifestUrl,
    exposes: {
      './Widget': () => {
        calls.push('import');
        if (options.load) return options.load();
        return Promise.resolve({ default: 'static native component' });
      },
    },
    admitRendererContract,
    admitNativeRequest(payload, execution) {
      calls.push('native admission');
      expect(execution.admitted.coordinate.native).toEqual({
        publisherBuildId: 'native-client-build',
        runtimeABI: 1,
      });
      expect(execution.admitted.identity.buildId).toBe('built-remote');
      expect(payload).toBe(nativeRequest);
      executions.push(execution);
      if (options.rejectNative) throw new Error('native authority rejected');
      return options.prepare ? options.prepare() : nativeRequest;
    },
    releaseNativeRequest(payload) {
      calls.push('release');
      expect(payload).toBe(nativeRequest);
      return options.release?.();
    },
    async renderNativeSnapshot(module, payload, execution) {
      calls.push('render');
      expect(module).toEqual({ default: 'static native component' });
      expect(payload).toBe(nativeRequest);
      executions.push(execution);
      return options.render ? options.render() : nativeSnapshot;
    },
    requestTimeout: options.requestTimeout,
  });
  return { handler, calls, executions };
}

test('admits native authority before importing and preserves the native codec bytes', async () => {
  const { handler, calls, executions } = handlerFixture();
  const response = await handler(requestFixture());
  expect(response?.status).toBe(200);
  const snapshot = await response?.json();
  expect(snapshot?.payload).toBe(nativeSnapshot);
  expect(calls).toEqual(['native admission', 'import', 'render', 'release']);
  expect(executions[0]).toBe(executions[1]);
});

test('rejects native admission before an expose module can execute', async () => {
  const { handler, calls } = handlerFixture({ rejectNative: true });
  const response = await handler(requestFixture());
  expect(response?.status).toBe(400);
  expect(calls).toEqual(['native admission']);
});

test('disposal before deferred native admission prevents its side effects', async () => {
  const controller = new AbortController();
  const readEnvelope = workerFederationContract.readWorkerFederationEnvelope;
  const reader = rstest
    .spyOn(workerFederationContract, 'readWorkerFederationEnvelope')
    .mockImplementation((...args) => {
      const payload = readEnvelope(...args);
      queueMicrotask(() =>
        controller.abort(new Error('disposed before admission')),
      );
      return payload;
    });
  try {
    const { handler, calls } = handlerFixture();
    await expect(
      handler(new Request(requestFixture(), { signal: controller.signal })),
    ).rejects.toThrow('disposed before admission');
    expect(calls).toEqual([]);
  } finally {
    reader.mockRestore();
  }
});

test('releases a prepared native request after expose import fails', async () => {
  const { handler, calls } = handlerFixture({
    async load() {
      throw new Error('expose import failed');
    },
  });
  expect((await handler(requestFixture()))?.status).toBe(502);
  expect(calls).toEqual(['native admission', 'import', 'release']);
});

test('retains both the expose failure and a failing native release', async () => {
  const { handler, calls } = handlerFixture({
    async load() {
      throw new Error('expose import failed');
    },
    release() {
      throw new Error('native context disposal failed');
    },
  });
  const response = await handler(requestFixture());
  expect(response?.status).toBe(502);
  const message = await response?.text();
  expect(message).toContain('expose import failed');
  expect(message).toContain('native context disposal failed');
  expect(calls).toEqual(['native admission', 'import', 'release']);
});

test('releases a preparation resolving after the deadline without importing', async () => {
  useDeadlineClock();
  const preparing = deferred();
  const preparation = deferred<string>();
  const releaseCompleted = deferred();
  const { handler, calls } = handlerFixture({
    requestTimeout: 20,
    prepare: () => {
      preparing.resolve();
      return preparation.promise;
    },
    release: () => releaseCompleted.resolve(),
  });
  const pending = handler(requestFixture());
  await preparing.promise;
  await rstest.advanceTimersByTimeAsync(20);
  expect((await pending)?.status).toBe(504);
  expect(calls).toEqual(['native admission']);
  preparation.resolve(nativeRequest);
  await releaseCompleted.promise;
  expect(calls).toEqual(['native admission', 'release']);
});

test('request abort releases an admitted handle once and preserves its reason', async () => {
  let entered!: () => void;
  const rendering = new Promise<void>(resolve => {
    entered = resolve;
  });
  const controller = new AbortController();
  const { handler, calls } = handlerFixture({
    render: () => {
      entered();
      return new Promise(() => undefined);
    },
  });
  const pending = handler(
    new Request(requestFixture(), { signal: controller.signal }),
  );
  await rendering;
  controller.abort(new Error('document canceled'));
  await expect(pending).rejects.toThrow('document canceled');
  expect(calls).toEqual(['native admission', 'import', 'render', 'release']);
});

test('the same outer deadline bounds native release without blocking later requests', async () => {
  useDeadlineClock();
  const releasing = deferred();
  let healthy = false;
  const { handler, calls } = handlerFixture({
    requestTimeout: 20,
    release: () => {
      releasing.resolve();
      return healthy ? Promise.resolve() : new Promise(() => undefined);
    },
  });
  const pending = handler(requestFixture());
  await releasing.promise;
  await rstest.advanceTimersByTimeAsync(20);
  expect((await pending)?.status).toBe(504);
  healthy = true;
  expect((await handler(requestFixture()))?.status).toBe(200);
  expect(calls.filter(value => value === 'release')).toHaveLength(2);
});

test('a hot failing native release cannot return before checking its expired deadline', async () => {
  useDeadlineClock();
  let clock = 0;
  rstest.spyOn(performance, 'now').mockImplementation(() => clock);
  const { handler, calls } = handlerFixture({
    requestTimeout: 100,
    release() {
      clock = 101;
      throw new Error('native context disposal failed');
    },
  });
  const response = await handler(requestFixture());
  expect(response?.status).toBe(504);
  const message = await response?.text();
  expect(message).toContain('native context disposal failed');
  expect(message).toContain('deadline');
  expect(calls).toEqual(['native admission', 'import', 'render', 'release']);
});

test('caller disposal during release prevents an already prepared successful response', async () => {
  const controller = new AbortController();
  const { handler, calls } = handlerFixture({
    release: () => controller.abort(new Error('disposed during release')),
  });
  await expect(
    handler(new Request(requestFixture(), { signal: controller.signal })),
  ).rejects.toThrow('disposed during release');
  expect(calls).toEqual(['native admission', 'import', 'render', 'release']);
});

test('rejects an oversized declared request before reading or native admission', async () => {
  let pulls = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulls++;
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const { handler, calls } = handlerFixture();
  const response = await handler(
    new Request(admitted.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(WORKER_FEDERATION_MAX_BODY_BYTES + 1),
      },
      body,
      duplex: 'half',
    } as RequestInit),
  );
  expect(response?.status).toBe(413);
  expect(pulls).toBe(0);
  expect(canceled).toBe(true);
  expect(calls).toEqual([]);
});

test('caps the complete producer response and releases its prepared request', async () => {
  const envelopeBytes = new TextEncoder().encode(
    workerFederationWireJson(
      workerFederationEnvelope('response', admitted, ''),
    ),
  ).byteLength;
  let size = WORKER_FEDERATION_MAX_BODY_BYTES - envelopeBytes;
  const { handler, calls } = handlerFixture({
    render: () => Promise.resolve('a'.repeat(size)),
  });
  const accepted = await handler(requestFixture());
  expect(accepted?.status).toBe(200);
  expect((await accepted?.arrayBuffer())?.byteLength).toBe(
    WORKER_FEDERATION_MAX_BODY_BYTES,
  );
  size++;
  const rejected = await handler(requestFixture());
  expect(rejected?.status).toBe(502);
  expect(await rejected?.text()).toContain('8 MiB');
  expect(calls.filter(value => value === 'release')).toHaveLength(2);
});

test('a huge native exception cannot bypass the error body limit', async () => {
  const { handler, calls } = handlerFixture({
    async render() {
      throw new Error('x'.repeat(WORKER_FEDERATION_MAX_BODY_BYTES + 1));
    },
  });
  const response = await handler(requestFixture());
  expect(response?.status).toBe(502);
  expect(await response?.text()).toBe('Worker federation request failed.');
  expect(calls).toEqual(['native admission', 'import', 'render', 'release']);
});

test.each([
  'renderer-build',
  'native-build',
  'runtime-abi',
  'expose',
  'locale',
  'origin',
  'source',
])('rejects forged %s before native admission/import', async field => {
  const envelope = JSON.parse(
    workerFederationWireJson(
      workerFederationEnvelope('request', admitted, nativeRequest),
    ),
  );
  if (field === 'renderer-build')
    envelope.authority.renderer.identities.index.buildId = 'another-build';
  if (field === 'native-build')
    envelope.authority.worker.exposes['./Widget'].native.publisherBuildId =
      'another-native-build';
  if (field === 'runtime-abi')
    envelope.authority.worker.exposes['./Widget'].native.runtimeABI = 2;
  if (field === 'expose') envelope.expose = './Missing';
  if (field === 'locale') envelope.locale = 'fr';
  if (field === 'origin') envelope.authority.origin = 'https://another.example';
  if (field === 'source') envelope.import = './arbitrary-component.ts';
  const { handler, calls } = handlerFixture();
  expect((await handler(requestFixture(envelope)))?.status).toBe(400);
  expect(calls).toEqual([]);
});

test.each([
  'https://another.example/en/_mf/fragment/widget',
  'https://tractor.example/en/_mf/fragment/widget?source=other',
  'https://tractor.example/fr/_mf/fragment/widget',
])(
  'compares incoming endpoint %s with its own pinned publication',
  async url => {
    const { handler, calls } = handlerFixture();
    expect((await handler(requestFixture(undefined, url)))?.status).toBe(400);
    expect(calls).toEqual([]);
  },
);

test('leaves ordinary document routes to the existing Worker dispatcher', async () => {
  const { handler, calls } = handlerFixture();
  expect(
    await handler(new Request('https://tractor.example/en/store')),
  ).toBeUndefined();
  expect(calls).toEqual([]);
});

test('rejects a registry which does not match the complete static publication', () => {
  expect(() =>
    createWorkerFederationHandler({
      publication: {
        renderer: manifest.metaData.ultramodernRenderer,
        worker: manifest.metaData.ultramodernWorkerFederation,
      },
      manifestUrl: requestCoordinate.manifestUrl,
      exposes: { './Foreign': async () => ({}) },
      admitRendererContract,
      admitNativeRequest: payload => payload,
      releaseNativeRequest: () => undefined,
      renderNativeSnapshot: () => nativeSnapshot,
    }),
  ).toThrow('registry conflicts');
});

test('bounds a stalled ingress body before any expose runs', async () => {
  useDeadlineClock();
  const reading = deferred();
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    pull() {
      reading.resolve();
    },
    cancel() {
      canceled = true;
    },
  });
  const { handler, calls } = handlerFixture({ requestTimeout: 20 });
  const pending = handler(
    new Request(admitted.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit),
  );
  await reading.promise;
  await rstest.advanceTimersByTimeAsync(20);
  const response = await pending;
  expect(response?.status).toBe(504);
  expect(canceled).toBe(true);
  expect(calls).toEqual([]);
});

test('bounds native rendering, forwards abort, and accepts a fresh request after recovery', async () => {
  useDeadlineClock();
  const rendering = deferred();
  let healthy = false;
  const { handler, executions } = handlerFixture({
    requestTimeout: 20,
    render: () => {
      rendering.resolve();
      return healthy
        ? Promise.resolve(nativeSnapshot)
        : new Promise(() => undefined);
    },
  });
  const pending = handler(requestFixture());
  await rendering.promise;
  await rstest.advanceTimersByTimeAsync(20);
  expect((await pending)?.status).toBe(504);
  expect((executions[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  healthy = true;
  expect((await handler(requestFixture()))?.status).toBe(200);
});

test('caller disposal reaches native rendering through the same abort signal', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const { handler, executions } = handlerFixture({
    render: () => {
      entered();
      return new Promise(() => undefined);
    },
  });
  const controller = new AbortController();
  const pending = handler(
    new Request(requestFixture(), { signal: controller.signal }),
  );
  await started;
  controller.abort(new Error('host document disposed'));
  await expect(pending).rejects.toThrow('host document disposed');
  expect((executions[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
});

test('disposal between import resolution and its continuation prevents native rendering', async () => {
  const controller = new AbortController();
  const { handler, calls } = handlerFixture({
    load() {
      queueMicrotask(() =>
        queueMicrotask(() =>
          controller.abort(new Error('disposed after import')),
        ),
      );
      return Promise.resolve({ default: 'static native component' });
    },
  });
  await expect(
    handler(new Request(requestFixture(), { signal: controller.signal })),
  ).rejects.toThrow('disposed after import');
  expect(calls).toEqual(['native admission', 'import', 'release']);
});

test('transport and static handler agree on the complete admitted response', async () => {
  const { handler, calls } = handlerFixture();
  const transport = createWorkerFederationTransport({
    services: [
      {
        remote: 'tractor',
        manifestUrl: requestCoordinate.manifestUrl,
        fragments: [
          {
            expose: './Widget',
            boundaryId: 'tractorContainer',
            paths: { en: '/en/_mf/fragment/widget' },
          },
        ],
        fetch: async request => (await handler(request))!,
      },
    ],
    admitRendererContract,
    fetchManifest: async () => Response.json(manifestFixture()),
  });
  expect(
    (
      await transport.request({
        remote: 'tractor',
        expose: './Widget',
        locale: 'en',
        payload: nativeRequest,
      })
    ).payload,
  ).toBe(nativeSnapshot);
  expect(calls).toEqual(['native admission', 'import', 'render', 'release']);
});
