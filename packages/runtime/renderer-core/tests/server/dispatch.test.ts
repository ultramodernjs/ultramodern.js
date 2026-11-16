import {
  assertRendererIdentity,
  identityCacheKey,
  type RendererIdentity,
  resolveRenderer,
} from '../../src/identity';
import {
  type CachedNativeDocument,
  dispatchNativeNodeRequest,
  type NativeDispatchOptions,
  type NativeRequestContext,
  type NativeRequestHandler,
} from '../../src/server';

const identity: RendererIdentity = {
  renderer: 'solid',
  appId: 'dispatch-test',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'build-a',
};

function options(
  handler: NativeRequestHandler,
  overrides: Partial<NativeDispatchOptions> = {},
): NativeDispatchOptions {
  return {
    identity,
    loadManifest: () => ({
      rendererIdentity: identity,
      nativeRequestHandler: handler,
    }),
    context: { bindings: {} },
    ...overrides,
  };
}

function publicDocument(
  text: string,
  context: NativeRequestContext,
  statusText?: string,
): Response {
  context.session.resolveResponse({
    kind: 'document',
    status: 200,
    statusText,
    headers: [['content-type', 'text/html; charset=utf-8']],
    cache: { mode: 'public', maxAgeSeconds: 60 },
  });
  context.session.startRendering();
  return context.session.respond(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  );
}

function store() {
  const documents = new Map<string, CachedNativeDocument>();
  return {
    documents,
    get: rstest.fn(async (key: string) => documents.get(key)),
    set: rstest.fn(async (key: string, value: CachedNativeDocument) => {
      documents.set(key, value);
    }),
  };
}

describe('production native Node Fetch dispatch', () => {
  it('validates generic selected renderer tokens and keeps identity equality exact', () => {
    const fourth = { ...identity, renderer: 'fourth-native' };
    expect(resolveRenderer(fourth.renderer)).toBe('fourth-native');
    expect(() => assertRendererIdentity({ ...fourth }, fourth)).not.toThrow();
    expect(() =>
      assertRendererIdentity({ ...fourth, renderer: 'another-native' }, fourth),
    ).toThrow('conflicts with the application build');
    for (const renderer of [
      '',
      'Fourth-native',
      'fourth/native',
      'fourth native',
      '-fourth',
      'fourth-',
      'fourth--native',
      'fourth\n',
    ]) {
      expect(() => identityCacheKey({ ...identity, renderer })).toThrow(
        'Unsupported UltraModern renderer',
      );
    }
  });

  it('rejects RSC before manifest imports, matching or cache lookup', async () => {
    const loadManifest = rstest.fn();
    const cache = store();
    for (const header of ['x-rsc-tree', 'x-rsc-action']) {
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/static/file', {
          headers: { [header]: '' },
        }),
        options(rstest.fn(), { loadManifest, cache }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: 'unsupported-renderer-capability',
        capability: 'rsc',
      });
    }
    expect(loadManifest).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('preserves terminal binary bytes, status text, content type and repeated cookies', async () => {
    let context: NativeRequestContext | undefined;
    const headers = new Headers({
      'content-type': 'application/x-native-data',
      'x-native': 'yes',
    });
    headers.append('set-cookie', 'first=1; Path=/; HttpOnly');
    headers.append(
      'set-cookie',
      'second=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
    );
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/data'),
      options((_request, requestContext) => {
        context = requestContext;
        return new Response(new Uint8Array([0, 255, 128, 13, 10]), {
          status: 201,
          statusText: 'Native Created',
          headers,
        });
      }),
    );
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Native Created');
    expect(context?.session.committedPolicy?.statusText).toBe('Native Created');
    expect(context?.session.ownsResponseBody(response)).toBe(true);
    expect(response.headers.get('content-type')).toBe(
      'application/x-native-data',
    );
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 128, 13, 10]),
    );
  });

  it.each([204, 205, 304])('preserves bodyless HTTP %s', async status => {
    let context: NativeRequestContext | undefined;
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/empty'),
      options((_request, requestContext) => {
        context = requestContext;
        return new Response(null, {
          status,
          statusText: 'Native Empty',
          headers: { 'x-empty': 'true' },
        });
      }),
    );
    expect(response.status).toBe(status);
    expect(response.statusText).toBe('Native Empty');
    expect(context?.session.committedPolicy?.statusText).toBe('Native Empty');
    expect(context?.session.ownsResponseBody(response)).toBe(true);
    expect(response.body).toBeNull();
    expect(response.headers.get('x-empty')).toBe('true');
  });

  it('preserves terminal redirect and non-HTML error without document cache admission', async () => {
    const cache = store();
    const redirect = await dispatchNativeNodeRequest(
      new Request('https://example.test/redirect'),
      options(
        () =>
          new Response(null, { status: 307, headers: { location: '/target' } }),
        { cache },
      ),
    );
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get('location')).toBe('/target');
    const error = await dispatchNativeNodeRequest(
      new Request('https://example.test/error'),
      options(
        () =>
          new Response('denied', {
            status: 401,
            headers: { 'content-type': 'text/plain' },
          }),
        { cache },
      ),
    );
    expect(error.status).toBe(401);
    expect(await error.text()).toBe('denied');
    expect(error.headers.get('content-type')).toBe('text/plain');
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('cancels HEAD bodies and disposes exactly once', async () => {
    const cleanup = rstest.fn();
    const cancelled = rstest.fn();
    const cache = store();
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/', { method: 'HEAD' }),
      options(
        (_request, context) => {
          context.session.registerCleanup(cleanup);
          return new Response(new ReadableStream({ cancel: cancelled }), {
            status: 202,
            headers: { 'content-type': 'text/html', 'x-native': 'head' },
          });
        },
        { cache },
      ),
    );
    expect(response.body).toBeNull();
    expect(response.status).toBe(202);
    expect(response.headers.get('x-native')).toBe('head');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('stops waiting for a manifest load or error fallback after request cancellation', async () => {
    for (const stage of ['manifest', 'fallback'] as const) {
      const controller = new AbortController();
      let reached!: () => void;
      const stageStarted = new Promise<void>(resolve => {
        reached = resolve;
      });
      const pending = () => {
        reached();
        return new Promise<never>(() => {});
      };
      const handler = rstest.fn(() => {
        throw new Error('handler failure');
      });
      const dispatched = dispatchNativeNodeRequest(
        new Request('https://example.test/', { signal: controller.signal }),
        options(handler, {
          ...(stage === 'manifest'
            ? { loadManifest: pending as never }
            : { onError: pending as never }),
        }),
      );
      await stageStarted;
      controller.abort(new Error(`${stage} disconnected`));
      await expect(dispatched).rejects.toThrow(`${stage} disconnected`);
    }
  });

  it('stops waiting for a selective-SSR matcher after request cancellation', async () => {
    const controller = new AbortController();
    let matched!: () => void;
    const matchStarted = new Promise<void>(resolve => {
      matched = resolve;
    });
    const handler = rstest.fn();
    const dispatched = dispatchNativeNodeRequest(
      new Request('https://example.test/', { signal: controller.signal }),
      options(handler, {
        context: { bindings: {}, serverConfig: { ssrByRouteIds: ['main'] } },
        loadManifest: () => ({
          rendererIdentity: identity,
          nativeRequestHandler: handler,
          nativeCSRRequestHandler: handler,
          nativeMatchRouteIds: () => {
            matched();
            return new Promise(() => {});
          },
        }),
      }),
    );
    await matchStarted;
    controller.abort(new Error('client disconnected'));
    await expect(dispatched).rejects.toThrow('client disconnected');
    expect(handler).not.toHaveBeenCalled();
  });

  it('stops waiting for a cache lookup after request cancellation', async () => {
    const controller = new AbortController();
    let looked!: () => void;
    const lookupStarted = new Promise<void>(resolve => {
      looked = resolve;
    });
    const handler = rstest.fn();
    const onCacheError = rstest.fn();
    const dispatched = dispatchNativeNodeRequest(
      new Request('https://example.test/', { signal: controller.signal }),
      options(handler, {
        cache: {
          get: () => {
            looked();
            return new Promise(() => {});
          },
          set: rstest.fn(),
        },
        onCacheError,
      }),
    );
    await lookupStarted;
    controller.abort(new Error('client disconnected'));
    await expect(dispatched).rejects.toThrow('client disconnected');
    expect(handler).not.toHaveBeenCalled();
    expect(onCacheError).not.toHaveBeenCalled();
  });

  it('stops waiting for a handler that ignores request cancellation', async () => {
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    let started!: () => void;
    const handlerStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    const fallback = rstest.fn();
    const dispatched = dispatchNativeNodeRequest(
      new Request('https://example.test/', { signal: controller.signal }),
      options(
        () => {
          started();
          return new Promise<Response>(resolve => {
            finish = resolve;
          });
        },
        { onError: fallback },
      ),
    );
    await handlerStarted;
    controller.abort(new Error('client disconnected'));
    await expect(dispatched).rejects.toThrow('client disconnected');
    expect(fallback).not.toHaveBeenCalled();
    // The late response is discarded, not left with an unread body.
    const cancelled = rstest.fn();
    finish(new Response(new ReadableStream({ cancel: cancelled })));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('answers HEAD without waiting on, or failing with, its body cancellation', async () => {
    for (const cancel of [
      () => new Promise<void>(() => {}),
      () => Promise.reject(new Error('cancel failed')),
    ]) {
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/', { method: 'HEAD' }),
        options(
          () =>
            new Response(new ReadableStream({ cancel }), {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
        ),
      );
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
    }
  });

  it('rejects conflicting bundle identity before lookup or handler execution', async () => {
    const handler = rstest.fn();
    const cache = store();
    const fallback = rstest.fn();
    await expect(
      dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options(handler, {
          loadManifest: () => ({
            rendererIdentity: { ...identity, buildId: 'stale' },
            nativeRequestHandler: handler,
          }),
          cache,
          onError: fallback,
        }),
      ),
    ).rejects.toThrow('Renderer identity conflicts');
    expect(handler).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('writes only after bytes complete and cleanup succeeds, then reuses the exact bytes', async () => {
    const cleanup = rstest.fn();
    const cache = store();
    let matchedContext: NativeRequestContext | undefined;
    const handler = rstest.fn((_request, context: NativeRequestContext) => {
      context.session.registerCleanup(cleanup);
      return publicDocument('<html>native</html>', context, 'Native Cached');
    });
    const selected = options(handler, {
      cache,
      context: {
        bindings: {},
        serverConfig: { ssrByRouteIds: ['main'] },
      },
      loadManifest: () => ({
        rendererIdentity: identity,
        nativeRequestHandler: handler,
        nativeMatchRouteIds: (_request, context) => {
          matchedContext = context;
          return ['main'];
        },
      }),
    });
    const first = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      selected,
    );
    expect(cache.set).not.toHaveBeenCalled();
    expect(first.statusText).toBe('Native Cached');
    expect(await first.text()).toBe('<html>native</html>');
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    const second = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      selected,
    );
    expect(second.statusText).toBe('Native Cached');
    expect(matchedContext?.session.committedPolicy?.statusText).toBe(
      'Native Cached',
    );
    expect(matchedContext?.session.ownsResponseBody(second)).toBe(true);
    expect(await second.text()).toBe('<html>native</html>');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('renders HEAD without a body even when GET has warmed the cache', async () => {
    const cache = store();
    const handler = rstest.fn((_request, context: NativeRequestContext) =>
      publicDocument('<html>native</html>', context),
    );
    const warm = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(handler, { cache }),
    );
    expect(await warm.text()).toBe('<html>native</html>');
    expect(cache.set).toHaveBeenCalledTimes(1);
    const head = await dispatchNativeNodeRequest(
      new Request('https://example.test/', { method: 'HEAD' }),
      options(handler, { cache }),
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // Only GET reads the cache; HEAD renders and discards its own body.
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('ends the response without waiting for a stalled cache write', async () => {
    const cache = store();
    cache.set.mockImplementation(() => new Promise<void>(() => {}));
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => publicDocument('<html>native</html>', context),
        { cache },
      ),
    );
    expect(await response.text()).toBe('<html>native</html>');
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('replays a cached document with the Age elapsed since it was stored', async () => {
    const cache = store();
    const handler = rstest.fn((_request, context: NativeRequestContext) => {
      context.session.resolveResponse({
        kind: 'document',
        status: 200,
        headers: [
          ['content-type', 'text/html; charset=utf-8'],
          ['cache-control', 'public, max-age=60'],
        ],
        cache: { mode: 'public', maxAgeSeconds: 60 },
      });
      context.session.startRendering();
      return context.session.respond(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<html>aged</html>'));
            controller.close();
          },
        }),
      );
    });
    const selected = options(handler, { cache });
    const storedAt = 1_800_000_000_000;
    const now = rstest.spyOn(Date, 'now').mockReturnValue(storedAt);
    try {
      const first = await dispatchNativeNodeRequest(
        new Request('https://example.test/aged'),
        selected,
      );
      expect(first.headers.has('age')).toBe(false);
      expect(await first.text()).toBe('<html>aged</html>');
      expect(cache.set).toHaveBeenCalledTimes(1);
      now.mockReturnValue(storedAt + 25_900);
      const replay = await dispatchNativeNodeRequest(
        new Request('https://example.test/aged'),
        selected,
      );
      expect(replay.headers.get('cache-control')).toBe('public, max-age=60');
      expect(replay.headers.get('age')).toBe('25');
      expect(await replay.text()).toBe('<html>aged</html>');
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('partitions identical URLs by app, entry, renderer, protocol and hydration build', async () => {
    const cache = store();
    for (const selectedIdentity of [
      identity,
      { ...identity, appId: 'other' },
      { ...identity, entryName: 'admin' },
      { ...identity, renderer: 'octane' as const },
      { ...identity, renderer: 'fourth-native' },
      { ...identity, buildId: 'build-b' },
    ]) {
      const handler = (_request: Request, context: NativeRequestContext) =>
        publicDocument(identityCacheKey(selectedIdentity), context);
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options(handler, {
          identity: selectedIdentity,
          loadManifest: () => ({
            rendererIdentity: selectedIdentity,
            nativeRequestHandler: handler,
          }),
          cache,
        }),
      );
      expect(await response.text()).toBe(identityCacheKey(selectedIdentity));
    }
    expect(cache.documents.size).toBe(6);
    expect(new Set(cache.get.mock.calls.map(([key]) => key)).size).toBe(6);
  });

  it.each([
    { method: 'POST' },
    { headers: { cookie: 'user=one' } },
    { headers: { authorization: 'Bearer token' } },
    { headers: { 'cache-control': 'no-cache' } },
    { headers: { 'cache-control': 'no-store' } },
    { headers: { 'cache-control': 'max-age=0' } },
    { headers: { 'Cache-Control': 'public, MaX-aGe = 0 , max-stale=30' } },
    { headers: { 'cache-control': 'max-age="0"' } },
    { headers: { 'cache-control': 'max-age=000' } },
    { headers: { 'cache-control': 'max-age=3600, max-age=10' } },
    { headers: { 'If-None-Match': 'W/"current"' } },
    { headers: { 'if-none-match': '' } },
    { headers: { 'If-Modified-Since': 'Wed, 07 Oct 2026 10:00:00 GMT' } },
    { headers: { 'if-modified-since': '' } },
    { headers: { 'If-Match': '"other"' } },
    { headers: { 'If-Unmodified-Since': 'Wed, 07 Oct 2026 10:00:00 GMT' } },
    { headers: { pragma: 'no-cache' } },
    { headers: { pragma: 'extension, No-Cache' } },
    { headers: { 'cache-control': 'min-fresh=10' } },
    { headers: { range: 'bytes=0-5' } },
  ])(
    'bypasses cache before lookup for private or non-document request %j',
    async requestOptions => {
      const cache = store();
      let renders = 0;
      const handler = rstest.fn(
        (_request: Request, context: NativeRequestContext) =>
          publicDocument(`render ${++renders}`, context),
      );
      const selected = options(handler, { cache });
      const first = await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        selected,
      );
      expect(await first.text()).toBe('render 1');
      expect(cache.set).toHaveBeenCalledTimes(1);
      cache.get.mockClear();
      cache.set.mockClear();
      const request = new Request('https://example.test/', requestOptions);
      const response = await dispatchNativeNodeRequest(request, selected);
      expect(await response.text()).toBe('render 2');
      expect(handler).toHaveBeenCalledTimes(2);
      expect([...handler.mock.calls[1][0].headers]).toEqual([
        ...request.headers,
      ]);
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['If-None-Match', 'W/"current"'],
    ['If-Modified-Since', 'Wed, 07 Oct 2026 10:00:00 GMT'],
  ])('preserves live native validation for %s', async (name, value) => {
    const cache = store();
    const handler = rstest.fn(
      (request: Request, context: NativeRequestContext) => {
        if (request.headers.has(name)) {
          expect(request.headers.get(name)).toBe(value);
          return new Response(null, {
            status: 304,
            headers: { etag: 'W/"current"', 'x-native-validation': name },
          });
        }
        return publicDocument('cached document', context);
      },
    );
    const selected = options(handler, { cache });
    const first = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      selected,
    );
    expect(await first.text()).toBe('cached document');
    expect(cache.set).toHaveBeenCalledTimes(1);
    cache.get.mockClear();
    cache.set.mockClear();
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/', { headers: { [name]: value } }),
      selected,
    );
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get('etag')).toBe('W/"current"');
    expect(response.headers.get('x-native-validation')).toBe(name);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each(['public, max-age=60', 'max-age=01', 'x-max-age=0'])(
    'retains cache reuse for request Cache-Control %s',
    async cacheControl => {
      const cache = store();
      const handler = rstest.fn(
        (_request: Request, context: NativeRequestContext) =>
          publicDocument('cached document', context),
      );
      const selected = options(handler, { cache });
      const first = await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        selected,
      );
      expect(await first.text()).toBe('cached document');
      cache.get.mockClear();
      cache.set.mockClear();
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/', {
          headers: { 'cache-control': cacheControl },
        }),
        selected,
      );
      expect(await response.text()).toBe('cached document');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(cache.get).toHaveBeenCalledTimes(1);
      expect(cache.set).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['max-age=10', false],
    ['max-age="10"', false],
    ['public, max-age=30', false],
    ['public, max-age=31', true],
    ['max-age=60', true],
  ])(
    'compares the cached age with request Cache-Control %s',
    async (cacheControl, reused) => {
      const cache = store();
      let renders = 0;
      const handler = rstest.fn(
        (_request: Request, context: NativeRequestContext) =>
          publicDocument(`render ${++renders}`, context),
      );
      const selected = options(handler, { cache });
      await (
        await dispatchNativeNodeRequest(
          new Request('https://example.test/'),
          selected,
        )
      ).text();
      for (const [key, document] of cache.documents)
        cache.documents.set(key, {
          ...document,
          storedAt: document.storedAt - 30_000,
        });
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/', {
          headers: { 'cache-control': cacheControl },
        }),
        selected,
      );
      expect(await response.text()).toBe(reused ? 'render 1' : 'render 2');
      expect(handler).toHaveBeenCalledTimes(reused ? 1 : 2);
    },
  );

  it.each(['__loader=route', '__ssrDirect=1'])(
    'bypasses loader protocol cache before lookup: %s',
    async query => {
      const cache = store();
      const response = await dispatchNativeNodeRequest(
        new Request(`https://example.test/?${query}`),
        options(() => Response.json({ ok: true }), { cache }),
      );
      await response.text();
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['set-cookie', 'late=1'],
    ['cache-control', 'private'],
    ['vary', 'Accept-Language'],
  ])(
    'rejects mutable delivered privacy header %s at cache commit',
    async (name, value) => {
      const cache = store();
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options((_request, context) => publicDocument('private', context), {
          cache,
        }),
      );
      response.headers.append(name, value);
      await response.text();
      expect(cache.set).not.toHaveBeenCalled();
    },
  );

  it('bounds capture memory without interrupting native body delivery', async () => {
    const cache = store();
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => publicDocument('more than five bytes', context),
        { cache, maxCacheBytes: 5 },
      ),
    );
    expect(await response.text()).toBe('more than five bytes');
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('uses native route IDs for selected CSR and never caches fallback', async () => {
    const cache = store();
    const ssr = rstest.fn();
    const cleanup = rstest.fn();
    const bindings = { trace: 'native-route-scope' };
    const match = rstest.fn(
      (request: Request, context: NativeRequestContext) => {
        expect(context.session.request).toBe(request);
        expect(context.session.platform.bindings).toBe(bindings);
        context.session.registerCleanup(cleanup);
        return ['layout', 'excluded'];
      },
    );
    const csr = rstest.fn((_request, context: NativeRequestContext) =>
      publicDocument('native CSR shell', context),
    );
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/excluded'),
      options(ssr, {
        cache,
        context: {
          bindings,
          serverConfig: { ssrByRouteIds: ['included'] },
        },
        loadManifest: () => ({
          rendererIdentity: identity,
          nativeRequestHandler: ssr,
          nativeCSRRequestHandler: csr,
          nativeMatchRouteIds: match,
        }),
      }),
    );
    expect(await response.text()).toBe('native CSR shell');
    expect(match).toHaveBeenCalledTimes(1);
    expect(ssr).not.toHaveBeenCalled();
    expect(csr).toHaveBeenCalledTimes(1);
    expect(match.mock.calls[0][1]).toBe(csr.mock.calls[0][1]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('allows a selected pre-commit fallback after failed cleanup, without caching', async () => {
    const cleanup = rstest.fn();
    const cache = store();
    const fallback = rstest.fn(
      (_error, _request, context: NativeRequestContext) => {
        expect(cleanup).toHaveBeenCalledTimes(1);
        return publicDocument('selected fallback', context);
      },
    );
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => {
          context.session.registerCleanup(cleanup);
          throw new Error('pre-shell failure');
        },
        { cache, onError: fallback },
      ),
    );
    expect(await response.text()).toBe('selected fallback');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('never selects a fallback after header commit', async () => {
    const fallback = rstest.fn();
    await expect(
      dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options(
          (_request, context) => {
            publicDocument('committed', context);
            throw new Error('after commit');
          },
          { onError: fallback },
        ),
      ),
    ).rejects.toThrow('after commit');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not cache cancelled streaming bodies and disposes once', async () => {
    const cache = store();
    const cleanup = rstest.fn();
    const cancelled = rstest.fn();
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => {
          context.session.resolveResponse({
            kind: 'document',
            status: 200,
            headers: [['content-type', 'text/html']],
            cache: { mode: 'public', maxAgeSeconds: 60 },
          });
          context.session.registerCleanup(cleanup);
          return context.session.respond(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('shell'));
              },
              cancel: cancelled,
            }),
          );
        },
        { cache },
      ),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('shell');
    await reader.cancel('client disconnected');
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('cancels a cached body without waiting on, or failing with, its source cancellation', async () => {
    for (const cancel of [
      () => new Promise<void>(() => {}),
      () => Promise.reject(new Error('cancel failed')),
    ]) {
      const cache = store();
      const cleanup = rstest.fn();
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options(
          (_request, context) => {
            context.session.resolveResponse({
              kind: 'document',
              status: 200,
              headers: [['content-type', 'text/html']],
              cache: { mode: 'public', maxAgeSeconds: 60 },
            });
            context.session.registerCleanup(cleanup);
            return context.session.respond(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('shell'));
                },
                cancel,
              }),
            );
          },
          { cache },
        ),
      );
      const reader = response.body!.getReader();
      await reader.read();
      await expect(reader.cancel('client disconnected')).resolves.toBe(
        undefined,
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(cache.set).not.toHaveBeenCalled();
    }
  });

  it('closes the consumer before transport confirmation and checks final wire privacy', async () => {
    const cache = store();
    let confirm!: (headers: Headers | undefined) => void;
    const delivery = new Promise<Headers | undefined>(resolve => {
      confirm = resolve;
    });
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => publicDocument('completed shell', context),
        {
          cache,
          confirmDelivery: () => delivery,
        },
      ),
    );
    expect(await response.text()).toBe('completed shell');
    expect(cache.set).not.toHaveBeenCalled();
    confirm(
      new Headers({
        'content-type': 'text/html',
        'set-cookie': 'late-middleware=1',
      }),
    );
    await delivery;
    await Promise.resolve();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('stores only after successful transport confirmation', async () => {
    const cache = store();
    let confirm!: (headers: Headers | undefined) => void;
    const delivery = new Promise<Headers | undefined>(resolve => {
      confirm = resolve;
    });
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => publicDocument('delivered shell', context),
        {
          cache,
          confirmDelivery: () => delivery,
        },
      ),
    );
    await response.text();
    expect(cache.set).not.toHaveBeenCalled();
    confirm(new Headers({ 'content-type': 'text/html', 'x-wire': 'final' }));
    await delivery;
    await Promise.resolve();
    expect(cache.set).toHaveBeenCalledTimes(1);
    const [stored] = cache.documents.values();
    expect(stored.headers).toContainEqual([
      'content-type',
      'text/html; charset=utf-8',
    ]);
    expect(stored.headers.map(([name]) => name)).not.toContain('x-wire');
  });

  it('stores the renderer fields so a cache hit does not repeat host headers', async () => {
    const cache = store();
    let renders = 0;
    const host = (response: Response) => {
      // The Node host merges configured cumulative fields in place.
      response.headers.append('link', '</host.css>; rel=preload; as=style');
      return response;
    };
    const selected = options(
      (_request, context) => publicDocument(`render ${++renders}`, context),
      {
        cache,
        confirmDelivery: async response => new Headers(response.headers),
      },
    );
    const first = host(
      await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        selected,
      ),
    );
    await first.text();
    await new Promise(resolve => setTimeout(resolve, 0));
    const hit = host(
      await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        selected,
      ),
    );
    expect(await hit.text()).toBe('render 1');
    expect(hit.headers.get('link')).toBe('</host.css>; rel=preload; as=style');
  });

  it.each([
    ['public, max-age=10', undefined, 10_000],
    ['public, max-age=30, s-maxage=5', undefined, 5_000],
    ['public, max-age=0', undefined, undefined],
    ['public, max-age=60', '50', 10_000],
    ['public, max-age=60', '60', undefined],
    ['public, max-age=60', 'date-50', 10_000],
  ])(
    'stores no longer than confirmed Cache-Control %s with Age %s allows',
    async (cacheControl, age, remaining) => {
      // HTTP dates discard milliseconds. Exercise that boundary without
      // letting runner scheduling consume the remaining cache lifetime.
      const checkedAt = 1_800_000_000_999;
      const clock = rstest.spyOn(Date, 'now').mockReturnValue(checkedAt);
      try {
        const cache = store();
        const response = await dispatchNativeNodeRequest(
          new Request('https://example.test/'),
          options(
            (_request, context) => publicDocument('delivered shell', context),
            {
              cache,
              confirmDelivery: async () =>
                new Headers({
                  'content-type': 'text/html',
                  'cache-control': cacheControl,
                  ...(age === undefined
                    ? {}
                    : age.startsWith('date-')
                      ? {
                          date: new Date(
                            Date.now() - Number(age.slice(5)) * 1000,
                          ).toUTCString(),
                        }
                      : { age }),
                }),
            },
          ),
        );
        await response.text();
        await new Promise(resolve => setTimeout(resolve, 0));
        const [stored] = cache.documents.values();
        if (remaining === undefined) expect(stored).toBeUndefined();
        else {
          expect(stored.expiresAt - checkedAt).toBe(remaining);
        }
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('does not cache complete source bytes after interrupted transport delivery', async () => {
    const cache = store();
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => publicDocument('source complete', context),
        {
          cache,
          confirmDelivery: async () => undefined,
        },
      ),
    );
    await response.text();
    await Promise.resolve();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('rejects late stream failures without fallback or successful cache storage', async () => {
    const cache = store();
    const cleanup = rstest.fn();
    const fallback = rstest.fn();
    let failBody!: () => void;
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => {
          context.session.resolveResponse({
            kind: 'document',
            status: 200,
            headers: [['content-type', 'text/html']],
            cache: { mode: 'public', maxAgeSeconds: 60 },
          });
          context.session.registerCleanup(cleanup);
          return context.session.respond(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('committed shell'));
                failBody = () =>
                  controller.error(new Error('late renderer failure'));
              },
            }),
          );
        },
        { cache, onError: fallback },
      ),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'committed shell',
    );
    failBody();
    await expect(reader.read()).rejects.toThrow('late renderer failure');
    expect(response.status).toBe(200);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('never admits a document whose request cleanup failed', async () => {
    const cache = store();
    const cleanup = rstest.fn(() => {
      throw new Error('cleanup failed');
    });
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => {
          context.session.registerCleanup(cleanup);
          return publicDocument('native bytes', context);
        },
        { cache },
      ),
    );
    await expect(response.text()).rejects.toThrow(
      'Renderer request cleanup failed',
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('does not redirect loader and action requests into a configured CSR shell', async () => {
    const handler = rstest.fn(() => Response.json({ nativeData: true }));
    const csr = rstest.fn(() => new Response('wrong CSR shell'));
    for (const request of [
      new Request('https://example.test/?__loader=route'),
      new Request('https://example.test/action', { method: 'POST' }),
    ]) {
      const response = await dispatchNativeNodeRequest(
        request,
        options(handler, {
          context: { bindings: {}, serverConfig: { forceCSR: true } },
          loadManifest: () => ({
            rendererIdentity: identity,
            nativeRequestHandler: handler,
            nativeCSRRequestHandler: csr,
          }),
        }),
      );
      expect(await response.json()).toEqual({ nativeData: true });
    }
    expect(handler).toHaveBeenCalledTimes(2);
    expect(csr).not.toHaveBeenCalled();
  });

  it('rejects unrelated streams after commitment and disposes the abandoned owner', async () => {
    const cache = store();
    const cleanup = rstest.fn();
    const cancelled = rstest.fn();
    await expect(
      dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options(
          (_request, context) => {
            context.session.resolveResponse({
              kind: 'document',
              status: 200,
              headers: [['content-type', 'text/html']],
              cache: { mode: 'public', maxAgeSeconds: 60 },
            });
            context.session.registerCleanup(cleanup);
            context.session.respond(new ReadableStream({ cancel: cancelled }));
            return new Response('unrelated stream');
          },
          { cache },
        ),
      ),
    ).rejects.toThrow('outside its committed request session');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('allows header-only wrappers retaining the exact owned response body', async () => {
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options((_request, context) => {
        const owned = publicDocument('same owned body', context);
        return new Response(owned.body, {
          status: owned.status,
          headers: {
            ...Object.fromEntries(owned.headers),
            'x-native': 'wrapped',
          },
        });
      }),
    );
    expect(await response.text()).toBe('same owned body');
    expect(response.headers.get('x-native')).toBe('wrapped');
  });

  it('rejects status changes after the native policy is committed', async () => {
    await expect(
      dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options((_request, context) => {
          const owned = publicDocument('wrong status', context);
          return new Response(owned.body, { status: 404 });
        }),
      ),
    ).rejects.toThrow('changed HTTP status after committing');
  });

  it('rejects status text changes after the native policy is committed', async () => {
    const cleanup = rstest.fn();
    await expect(
      dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options((_request, context) => {
          context.session.registerCleanup(cleanup);
          const owned = publicDocument('wrong reason', context, 'Native OK');
          return new Response(owned.body, {
            status: owned.status,
            statusText: 'Changed Reason',
            headers: owned.headers,
          });
        }),
      ),
    ).rejects.toThrow('changed HTTP status text after committing');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('partitions cache by actual native hydration build and emitted asset inventory', async () => {
    const cache = store();
    const handler = (_request: Request, context: NativeRequestContext) =>
      publicDocument('native', context);
    for (const [hydrationBuildId, href] of [
      ['hash-a', '/main.a.js'],
      ['hash-b', '/main.a.js'],
      ['hash-b', '/main.b.js'],
    ]) {
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options(handler, {
          cache,
          hydrationBuildId,
          context: { bindings: {}, assets: [{ kind: 'script', href }] },
        }),
      );
      await response.text();
    }
    expect(cache.documents.size).toBe(3);
    expect(new Set(cache.get.mock.calls.map(([key]) => key)).size).toBe(3);
  });

  it('checks a native header wrapper even when transport returns different final headers', async () => {
    const cache = store();
    const response = await dispatchNativeNodeRequest(
      new Request('https://example.test/'),
      options(
        (_request, context) => {
          const owned = publicDocument('private native wrapper', context);
          const headers = new Headers(owned.headers);
          headers.append('set-cookie', 'native-wrapper=private');
          return new Response(owned.body, { status: owned.status, headers });
        },
        {
          cache,
          confirmDelivery: async () =>
            new Headers({ 'content-type': 'text/html' }),
        },
      ),
    );
    await response.text();
    await Promise.resolve();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('never replays a document under a different request script nonce', async () => {
    const cache = store();
    for (const nonce of ['nonce-one', 'nonce-two']) {
      const response = await dispatchNativeNodeRequest(
        new Request('https://example.test/'),
        options(
          (_request, context) =>
            publicDocument(
              `<script nonce="${context.nonce}"></script>`,
              context,
            ),
          {
            cache,
            context: { bindings: {}, nonce },
          },
        ),
      );
      expect(await response.text()).toContain(nonce);
    }
    expect(cache.documents.size).toBe(2);
  });
});
