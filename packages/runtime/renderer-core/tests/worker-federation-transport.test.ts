import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as workerFederationContract from '../src/worker-federation/contract';
import {
  admitWorkerFederationExpose,
  workerFederationEnvelope,
  workerFederationWireJson,
} from '../src/worker-federation/contract';
import { WORKER_FEDERATION_MAX_BODY_BYTES } from '../src/worker-federation/lease';
import {
  createWorkerFederationTransport,
  type WorkerFederationService,
} from '../src/worker-federation/transport';
import {
  admitRendererContract,
  manifestFixture,
  requestCoordinate,
} from './worker-federation.fixture';

const coordinate = { remote: 'tractor', expose: './Widget', locale: 'en' };
const nativePayload =
  '{"nativeCodec":"opaque","html":"<span>native & bytes</span>"}';

function responseFor(
  request: Record<string, unknown>,
  payload: unknown = nativePayload,
) {
  return Response.json({
    ...request,
    schema: 'ultramodern.worker-federation-response',
    payload,
  });
}

function fixture(
  options: {
    manifest?: unknown;
    render?: (request: Request) => Promise<Response>;
    requestTimeout?: number;
    fetchManifest?: (request: Request) => Promise<Response>;
    signal?: AbortSignal;
  } = {},
) {
  let manifestRequests = 0;
  let renderRequests = 0;
  const service: WorkerFederationService = {
    remote: coordinate.remote,
    manifestUrl: requestCoordinate.manifestUrl,
    fragments: [
      {
        expose: coordinate.expose,
        boundaryId: 'tractorContainer',
        paths: { en: '/en/_mf/fragment/widget', fr: '/fr/_mf/fragment/widget' },
      },
    ],
    async fetch(request) {
      renderRequests++;
      if (options.render) return options.render(request);
      return responseFor((await request.json()) as Record<string, unknown>);
    },
  };
  const transport = createWorkerFederationTransport({
    services: [service],
    admitRendererContract,
    requestTimeout: options.requestTimeout,
    signal: options.signal,
    async fetchManifest(request) {
      manifestRequests++;
      if (options.fetchManifest) return options.fetchManifest(request);
      return Response.json(options.manifest ?? manifestFixture());
    },
  });
  return {
    transport,
    service,
    counts: () => [manifestRequests, renderRequests],
  };
}

test('admits publication before POST and returns the native codec string unchanged', async () => {
  const { transport, counts } = fixture({
    async render(request) {
      expect(request.url).toBe(
        'https://tractor.example/en/_mf/fragment/widget',
      );
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('manual');
      const envelope = (await request.json()) as Record<string, unknown>;
      expect(envelope.payload).toBe(nativePayload);
      return responseFor(envelope);
    },
  });
  const result = await transport.request({
    ...coordinate,
    payload: nativePayload,
  });
  expect(result.payload).toBe(nativePayload);
  expect(result.admitted.identity.buildId).toBe('built-remote');
  expect(counts()).toEqual([1, 1]);
});

test('supports Worker Request redirect modes without following manifest or snapshot redirects', async () => {
  const NativeRequest = globalThis.Request;
  const observed: { method: string; redirect: RequestRedirect }[] = [];
  class WorkerRequest extends NativeRequest {
    constructor(
      input: ConstructorParameters<typeof NativeRequest>[0],
      init?: RequestInit,
    ) {
      if (init?.redirect === 'error')
        throw new TypeError(
          'Invalid redirect value, must be follow or manual.',
        );
      super(input, init);
      observed.push({ method: this.method, redirect: this.redirect });
    }
  }
  globalThis.Request = WorkerRequest;
  try {
    const { transport, counts } = fixture();
    expect(
      (await transport.request({ ...coordinate, payload: nativePayload }))
        .payload,
    ).toBe(nativePayload);
    expect(observed).toEqual([
      { method: 'GET', redirect: 'manual' },
      { method: 'POST', redirect: 'manual' },
    ]);
    expect(counts()).toEqual([1, 1]);
  } finally {
    globalThis.Request = NativeRequest;
  }
});

test.each([
  ...[301, 302, 303, 307, 308].map(status => ({ phase: 'manifest', status })),
  ...[301, 302, 303, 307, 308].map(status => ({ phase: 'snapshot', status })),
])(
  'rejects $phase redirect $status and cancels its body without following Location',
  async ({ phase, status }) => {
    let canceled = false;
    const redirect = (body: unknown) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          },
          cancel() {
            canceled = true;
            return new Promise(() => {});
          },
        }),
        {
          status,
          headers: { location: 'https://foreign.example/redirect-target' },
        },
      );
    const { transport, counts } = fixture({
      async fetchManifest(request) {
        expect(request.url).toBe(requestCoordinate.manifestUrl);
        expect(request.redirect).toBe('manual');
        return phase === 'manifest'
          ? redirect(manifestFixture())
          : Response.json(manifestFixture());
      },
      async render(request) {
        expect(request.redirect).toBe('manual');
        const envelope = await request.json();
        return redirect({
          ...envelope,
          schema: 'ultramodern.worker-federation-response',
          payload: nativePayload,
        });
      },
    });
    await expect(
      transport.request({ ...coordinate, payload: nativePayload }),
    ).rejects.toThrow(`publication request failed (${status})`);
    expect(canceled).toBe(true);
    expect(counts()).toEqual([1, phase === 'manifest' ? 0 : 1]);
  },
);

test.each(['admission', 'snapshot'] as const)(
  'a reused admission or repeated snapshot cannot return after its caller deadline (%s)',
  async kind => {
    const { transport, counts } = fixture({ requestTimeout: 100 });
    await transport.request({ ...coordinate, payload: nativePayload });
    const now = rstest
      .spyOn(performance, 'now')
      .mockImplementationOnce(() => 0)
      .mockImplementation(() => 101);
    if (kind === 'snapshot') now.mockImplementationOnce(() => 0);
    try {
      await expect(
        kind === 'admission'
          ? transport.admit(coordinate)
          : transport.request({ ...coordinate, payload: nativePayload }),
      ).rejects.toThrow('deadline');
      expect(counts()).toEqual([1, 1]);
    } finally {
      now.mockRestore();
    }
  },
);

test('rejects foreign renderer admission and changed service paths before remote execution', async () => {
  const foreign = manifestFixture();
  foreign.metaData.ultramodernRenderer.runtime.version = 'incompatible';
  const first = fixture({ manifest: foreign });
  await expect(
    first.transport.request({ ...coordinate, payload: {} }),
  ).rejects.toThrow();
  expect(first.counts()).toEqual([1, 0]);
  const changed = manifestFixture();
  changed.metaData.ultramodernWorkerFederation.exposes['./Widget'].paths.en =
    '/en/arbitrary-import';
  const second = fixture({ manifest: changed });
  await expect(
    second.transport.request({ ...coordinate, payload: {} }),
  ).rejects.toThrow('service coordinate');
  expect(second.counts()).toEqual([1, 0]);
});

test('rejects absent binding/expose/locale before any network request', async () => {
  const { transport, counts } = fixture();
  for (const request of [
    { remote: 'foreign' },
    { expose: './Missing' },
    { locale: 'de' },
  ])
    await expect(
      transport.request({ ...coordinate, ...request, payload: {} }),
    ).rejects.toThrow('configured service');
  expect(counts()).toEqual([0, 0]);
});

test.each(['x', 'é', '😀', '"', '\\'])(
  'caps the final request envelope with UTF8 and JSON escaping for %s',
  async character => {
    const admitted = admitWorkerFederationExpose({
      ...requestCoordinate,
      manifest: manifestFixture(),
    });
    const overhead = new TextEncoder().encode(
      workerFederationWireJson(
        workerFederationEnvelope('request', admitted, ''),
      ),
    ).byteLength;
    const encodedCharacterBytes =
      new TextEncoder().encode(JSON.stringify(character)).byteLength - 2;
    const repetitions = Math.floor(
      (WORKER_FEDERATION_MAX_BODY_BYTES - overhead) / encodedCharacterBytes,
    );
    const payload = character.repeat(repetitions);
    const { transport, counts } = fixture({
      async render(request) {
        expect(
          (await request.clone().arrayBuffer()).byteLength,
        ).toBeLessThanOrEqual(WORKER_FEDERATION_MAX_BODY_BYTES);
        return responseFor(await request.json());
      },
    });
    expect((await transport.request({ ...coordinate, payload })).payload).toBe(
      nativePayload,
    );
    await expect(
      transport.request({ ...coordinate, payload: payload + character }),
    ).rejects.toThrow('8 MiB');
    expect(counts()).toEqual([1, 1]);
  },
);

test('rejects an oversized raw native payload before cache or manifest allocation', async () => {
  const { transport, counts } = fixture();
  await expect(
    transport.request({
      ...coordinate,
      payload: 'x'.repeat(WORKER_FEDERATION_MAX_BODY_BYTES + 1),
    }),
  ).rejects.toThrow('8 MiB');
  expect(counts()).toEqual([0, 0]);
});

test('hot manifest reads retain the request budget spent encoding its native payload', async () => {
  let clock = 0;
  let pulls = 0;
  let canceled = false;
  rstest.spyOn(performance, 'now').mockImplementation(() => clock);
  const bytes = new TextEncoder().encode(JSON.stringify(manifestFixture()));
  const chunkSize = Math.ceil(bytes.byteLength / 10);
  const { transport, counts } = fixture({
    requestTimeout: 100,
    async fetchManifest() {
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              clock += 10;
              const offset = pulls++ * chunkSize;
              controller.enqueue(bytes.subarray(offset, offset + chunkSize));
              if (offset + chunkSize >= bytes.byteLength) controller.close();
            },
            cancel() {
              canceled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  });
  await expect(
    transport.request({
      ...coordinate,
      payload: {
        get native() {
          clock += 60;
          return 'native codec encoding';
        },
      },
    }),
  ).rejects.toThrow('deadline');
  expect(pulls).toBe(4);
  expect(canceled).toBe(true);
  expect(counts()).toEqual([1, 0]);
});

test('response validation cannot commit success after the outer budget expires', async () => {
  let clock = 0;
  let expire = true;
  rstest.spyOn(performance, 'now').mockImplementation(() => clock);
  const readEnvelope = workerFederationContract.readWorkerFederationEnvelope;
  rstest
    .spyOn(workerFederationContract, 'readWorkerFederationEnvelope')
    .mockImplementation((value, kind, admitted) => {
      const payload = readEnvelope(value, kind, admitted);
      if (kind === 'response' && expire) clock += 101;
      return payload;
    });
  const { transport, counts } = fixture({ requestTimeout: 100 });
  await expect(
    transport.request({ ...coordinate, payload: {} }),
  ).rejects.toThrow('deadline');
  expect(counts()).toEqual([1, 1]);
  expire = false;
  expect(
    (await transport.request({ ...coordinate, payload: {} })).payload,
  ).toBe(nativePayload);
  expect(counts()).toEqual([1, 2]);
});

test('rejects an oversized declared manifest without reading and admits a fresh retry', async () => {
  let healthy = false;
  let pulls = 0;
  let canceled = false;
  const { transport, counts } = fixture({
    async fetchManifest() {
      if (healthy) return Response.json(manifestFixture());
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              pulls++;
            },
            cancel() {
              canceled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            'content-length': String(WORKER_FEDERATION_MAX_BODY_BYTES + 1),
          },
        },
      );
    },
  });
  await expect(transport.admit(coordinate)).rejects.toThrow('8 MiB');
  expect(counts()).toEqual([1, 0]);
  expect(pulls).toBe(0);
  expect(canceled).toBe(true);
  healthy = true;
  expect(
    (await transport.request({ ...coordinate, payload: {} })).payload,
  ).toBe(nativePayload);
  expect(counts()).toEqual([2, 1]);
});

test.each([undefined, '1'])(
  'streamed response overflow with Content-Length %s cancels without awaiting it and retries',
  async contentLength => {
    let healthy = false;
    let canceled = false;
    const { transport, counts } = fixture({
      requestTimeout: 100,
      async render(request) {
        if (healthy) return responseFor(await request.json());
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new Uint8Array(WORKER_FEDERATION_MAX_BODY_BYTES + 1),
              );
            },
            cancel() {
              canceled = true;
              return new Promise(() => undefined);
            },
          }),
          {
            headers: contentLength ? { 'content-length': contentLength } : {},
          },
        );
      },
    });
    await expect(
      transport.request({ ...coordinate, payload: {} }),
    ).rejects.toThrow('8 MiB');
    expect(canceled).toBe(true);
    healthy = true;
    expect(
      (await transport.request({ ...coordinate, payload: {} })).payload,
    ).toBe(nativePayload);
    expect(counts()).toEqual([2, 2]);
  },
);

test('pins the configured service method even when its source object changes later', async () => {
  const { transport, service, counts } = fixture();
  service.fetch = async () => {
    throw new Error('replacement binding must not run');
  };
  expect(
    (await transport.request({ ...coordinate, payload: {} })).payload,
  ).toBe(nativePayload);
  expect(counts()).toEqual([1, 1]);
});

test('uses the same service binding for manifest admission and the native snapshot', async () => {
  const methods: string[] = [];
  const transport = createWorkerFederationTransport({
    services: [
      {
        remote: coordinate.remote,
        manifestUrl: requestCoordinate.manifestUrl,
        fragments: [
          {
            expose: coordinate.expose,
            boundaryId: 'tractorContainer',
            paths: { en: '/en/_mf/fragment/widget' },
          },
        ],
        async fetch(request) {
          methods.push(request.method);
          if (request.method === 'GET') return Response.json(manifestFixture());
          return responseFor((await request.json()) as Record<string, unknown>);
        },
      },
    ],
    admitRendererContract,
  });
  expect(
    (await transport.request({ ...coordinate, payload: {} })).payload,
  ).toBe(nativePayload);
  expect(methods).toEqual(['GET', 'POST']);
});

test('keeps the admitted publication throughout one document when the publisher changes', async () => {
  const manifest = manifestFixture();
  const { transport } = fixture({
    manifest,
    async render(request) {
      const envelope = (await request.json()) as Record<string, unknown>;
      manifest.metaData.ultramodernRenderer.identities.index.buildId =
        'new-build';
      return responseFor(envelope);
    },
  });
  const first = await transport.request({
    ...coordinate,
    payload: { boundary: 'first' },
  });
  const second = await transport.request({
    ...coordinate,
    payload: { boundary: 'second' },
  });
  expect(first.admitted.identity.buildId).toBe('built-remote');
  expect(second.admitted.identity.buildId).toBe('built-remote');
});

test('deduplicates equal native requests within one document and separates native authorities', async () => {
  const { transport, counts } = fixture();
  const [first, second] = await Promise.all([
    transport.request({
      ...coordinate,
      payload: { document: 'one', boundary: 'same' },
    }),
    transport.request({
      ...coordinate,
      payload: { boundary: 'same', document: 'one' },
    }),
  ]);
  expect(first).toBe(second);
  expect(counts()).toEqual([1, 1]);
  await transport.request({
    ...coordinate,
    payload: { document: 'two', boundary: 'same' },
  });
  expect(counts()).toEqual([1, 2]);
  const otherDocument = fixture();
  await otherDocument.transport.request({
    ...coordinate,
    payload: { document: 'one', boundary: 'same' },
  });
  expect(otherDocument.counts()).toEqual([1, 1]);
});

test('one canceled consumer does not abort another consumer of the same native snapshot', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {
    finish = resolve;
  });
  let sharedSignal!: AbortSignal;
  const { transport, counts } = fixture({
    async render(request) {
      sharedSignal = request.signal;
      const envelope = (await request.json()) as Record<string, unknown>;
      await gate;
      return responseFor(envelope);
    },
  });
  const canceled = new AbortController();
  const first = transport.request({
    ...coordinate,
    payload: {},
    signal: canceled.signal,
  });
  const second = transport.request({ ...coordinate, payload: {} });
  await Promise.resolve();
  canceled.abort(new Error('caller canceled'));
  await expect(first).rejects.toThrow('caller canceled');
  finish();
  expect((await second).payload).toBe(nativePayload);
  expect(sharedSignal.aborted).toBe(false);
  expect(counts()).toEqual([1, 1]);
});

test('canceling the final consumer aborts transport and allows an immediate fresh retry', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const stalled = new Promise<void>(resolve => {
    release = resolve;
  });
  let requests = 0;
  let firstSignal!: AbortSignal;
  const { transport, counts } = fixture({
    async render(request) {
      const envelope = (await request.json()) as Record<string, unknown>;
      if (++requests === 1) {
        firstSignal = request.signal;
        entered();
        await stalled;
      }
      return responseFor(envelope);
    },
  });
  const canceled = new AbortController();
  const pending = transport.request({
    ...coordinate,
    payload: {},
    signal: canceled.signal,
  });
  await started;
  canceled.abort(new Error('document disposed'));
  await expect(pending).rejects.toThrow('document disposed');
  expect(firstSignal.aborted).toBe(true);
  expect(
    (await transport.request({ ...coordinate, payload: {} })).payload,
  ).toBe(nativePayload);
  release();
  expect(requests).toBe(2);
  // A canceled snapshot does not invalidate the already accepted publication.
  expect(counts()).toEqual([1, 2]);
});

test('rejects changed response publication and retries without a failed snapshot cache', async () => {
  let requests = 0;
  const { transport } = fixture({
    async render(request) {
      const envelope = (await request.json()) as Record<string, unknown>;
      if (++requests === 1) {
        const authority = envelope.authority as { origin: string };
        authority.origin = 'https://foreign.example';
      }
      return responseFor(envelope);
    },
  });
  await expect(
    transport.request({ ...coordinate, payload: {} }),
  ).rejects.toThrow('admitted publication');
  expect(
    (await transport.request({ ...coordinate, payload: {} })).payload,
  ).toBe(nativePayload);
  expect(requests).toBe(2);
});

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

test.each(['http503', 'header-hang', 'body-hang', 'manifest-body-hang'])(
  'bounds real HTTP %s through the full body and retries after recovery in the same transport',
  async failure => {
    let healthy = false;
    let manifestRequests = 0;
    let renderRequests = 0;
    const server = http.createServer(async (request, response) => {
      if (request.url === '/mf-manifest.json') {
        manifestRequests++;
        if (!healthy && failure === 'manifest-body-hang') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(manifestFixture()));
        return;
      }
      renderRequests++;
      if (!healthy && failure === 'http503') {
        response.writeHead(503).end('native snapshot unavailable');
        return;
      }
      if (!healthy && failure === 'header-hang') return;
      if (!healthy && failure === 'body-hang') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ...envelope,
          schema: 'ultramodern.worker-federation-response',
          payload: nativePayload,
        }),
      );
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const transport = createWorkerFederationTransport({
      services: [
        {
          remote: coordinate.remote,
          manifestUrl: `${origin}/mf-manifest.json`,
          fragments: [
            {
              expose: './Widget',
              boundaryId: 'tractorContainer',
              paths: { en: '/en/_mf/fragment/widget' },
            },
          ],
          fetch: request => fetch(request),
        },
      ],
      admitRendererContract,
      requestTimeout: 100,
    });
    await expect(
      transport.request({ ...coordinate, payload: nativePayload }),
    ).rejects.toThrow(failure === 'http503' ? '503' : 'deadline');
    healthy = true;
    expect(
      (await transport.request({ ...coordinate, payload: nativePayload }))
        .payload,
    ).toBe(nativePayload);
    expect(manifestRequests).toBe(
      failure === 'header-hang' || failure === 'body-hang' ? 1 : 2,
    );
    expect(renderRequests).toBe(failure === 'manifest-body-hang' ? 1 : 2);
  },
);

test('lazy admission shares the document authority with the following snapshot', async () => {
  const { transport, counts } = fixture();
  const admitted = await transport.admit(coordinate);
  expect(counts()).toEqual([1, 0]);
  const result = await transport.request({
    ...coordinate,
    payload: nativePayload,
  });
  expect(result.admitted).toBe(admitted);
  expect(counts()).toEqual([1, 1]);
});

test('cancelling one lazy admission preserves another consumer and snapshot', async () => {
  const abort = new AbortController();
  const { transport, counts } = fixture();
  const first = transport.admit({ ...coordinate, signal: abort.signal });
  const second = transport.admit(coordinate);
  abort.abort(new Error('first admission disposed'));
  await expect(first).rejects.toThrow('first admission disposed');
  const admitted = await second;
  const result = await transport.request({
    ...coordinate,
    payload: nativePayload,
  });
  expect(result.admitted).toBe(admitted);
  expect(counts()).toEqual([1, 1]);
});

test('resolves the authored import alias to its pinned topology publisher', async () => {
  const methods: string[] = [];
  const transport = createWorkerFederationTransport({
    services: [
      {
        remote: 'tractor',
        alias: 'tractorComponents',
        manifestUrl: requestCoordinate.manifestUrl,
        fragments: [
          {
            expose: './Widget',
            boundaryId: 'tractorContainer',
            paths: { en: '/en/_mf/fragment/widget' },
          },
        ],
        async fetch(request) {
          methods.push(request.method);
          return request.method === 'GET'
            ? Response.json(manifestFixture())
            : responseFor(await request.json());
        },
      },
    ],
    admitRendererContract,
  });
  const admitted = await transport.admit({
    ...coordinate,
    remote: 'tractorComponents',
  });
  const result = await transport.request({
    ...coordinate,
    payload: nativePayload,
  });
  expect(result.admitted).toBe(admitted);
  expect(admitted.authority.worker.remote).toBe('tractor');
  expect(methods).toEqual(['GET', 'POST']);
});

test('settled snapshots stay with live boundaries rather than accumulating in the document transport', async () => {
  const { transport, counts } = fixture();
  const options = { ...coordinate, payload: { revision: 0 } };
  const [first, concurrent] = await Promise.all([
    transport.request(options),
    transport.request(options),
  ]);
  expect(first).toBe(concurrent);
  expect(counts()).toEqual([1, 1]);
  const repeated = await transport.request(options);
  expect(repeated).not.toBe(first);
  expect(repeated.admitted).toBe(first.admitted);
  expect(counts()).toEqual([1, 2]);
  for (let revision = 1; revision <= 40; revision++)
    await transport.request({ ...coordinate, payload: { revision } });
  await transport.request(options);
  expect(counts()).toEqual([1, 43]);
});

test('document retirement aborts all active snapshots and prevents reuse of accepted authority', async () => {
  const owner = new AbortController();
  let entered = 0;
  let allEntered!: () => void;
  const started = new Promise<void>(resolve => {
    allEntered = resolve;
  });
  let release!: () => void;
  const stalled = new Promise<void>(resolve => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  const { transport, counts } = fixture({
    signal: owner.signal,
    async render(request) {
      signals.push(request.signal);
      if (++entered === 2) allEntered();
      const envelope = await request.json();
      await stalled;
      return responseFor(envelope);
    },
  });
  const requests = [1, 2].map(revision =>
    transport.request({ ...coordinate, payload: { revision } }),
  );
  await started;
  owner.abort(new Error('document replaced'));
  await expect(Promise.all(requests)).rejects.toThrow('document replaced');
  expect(signals.every(signal => signal.aborted)).toBe(true);
  await expect(transport.admit(coordinate)).rejects.toThrow(
    'document replaced',
  );
  await expect(
    transport.request({ ...coordinate, payload: {} }),
  ).rejects.toThrow('document replaced');
  expect(counts()).toEqual([1, 2]);
  transport.dispose();
  release();
});

test('a late old-publisher failure cannot evict the replacement publication', async () => {
  const oldManifest = manifestFixture();
  const newManifest = manifestFixture();
  newManifest.metaData.ultramodernRenderer.identities.index.buildId =
    'replacement-build';
  let replacement = false;
  let oldEntered!: () => void;
  const started = new Promise<void>(resolve => {
    oldEntered = resolve;
  });
  let rejectOld!: () => void;
  const oldFailure = new Promise<void>(resolve => {
    rejectOld = resolve;
  });
  const { transport, counts } = fixture({
    async fetchManifest() {
      return Response.json(replacement ? newManifest : oldManifest);
    },
    async render(request) {
      const envelope = await request.json();
      if (envelope.payload === 'slow-old') {
        oldEntered();
        await oldFailure;
        return new Response('old unavailable', { status: 503 });
      }
      if (envelope.payload === 'evict-old')
        return new Response('old unavailable', { status: 503 });
      return responseFor(envelope);
    },
  });
  const stale = transport.request({ ...coordinate, payload: 'slow-old' });
  await started;
  await expect(
    transport.request({ ...coordinate, payload: 'evict-old' }),
  ).rejects.toThrow('503');
  replacement = true;
  const fresh = await transport.request({ ...coordinate, payload: 'fresh' });
  expect(fresh.admitted.identity.buildId).toBe('replacement-build');
  rejectOld();
  await expect(stale).rejects.toThrow('503');
  expect(await transport.admit(coordinate)).toBe(fresh.admitted);
  expect(counts()).toEqual([2, 3]);
});
