import type {
  DataStreamFrame,
  FileSystemRouteIR,
} from '@modern-js/renderer-core/data';
import {
  createDataClient,
  createDataResponse,
  DATA_STREAM_CONTENT_TYPE,
  serializePublicData,
} from '@modern-js/renderer-core/data';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { flush } from 'solid-js';
import { mountApplication } from '../../src/client';
import {
  ApplicationRouter,
  Await,
  createApplicationRouter,
  createFileSystemRouteTree,
  createMemoryHistory,
  Outlet,
  useLoaderData,
} from '../../src/router';

const identity: RendererIdentity = {
  renderer: 'solid',
  appId: 'completion-app',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'completion-build',
};
const routes: FileSystemRouteIR[] = [
  {
    id: 'layout',
    isRoot: true,
    children: [
      {
        id: 'item',
        path: 'items/:itemId',
        modules: { data: '/item.data.ts' },
        children: [],
      },
      { id: 'done', path: 'done', children: [] },
    ],
  },
];
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  flush();
});

// These are real bytes consumed by the core parser, including its actual
// nonenumerable completion promise. No completion DTO is fabricated by a test.
function byteResponse(
  critical: Record<string, unknown>,
  deferredKeys: string[] = [],
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  const send = (frame: DataStreamFrame) =>
    controller.enqueue(
      new TextEncoder().encode(`${serializePublicData(frame)}\n`),
    );
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      controller = stream;
      send({
        type: 'initial',
        envelope: {
          version: 1,
          identity,
          routeId: 'item',
          operation: 'loader',
          outcome: { kind: 'success', value: critical, status: 200 },
          deferredKeys,
        },
      });
    },
    cancel() {
      cancellations++;
    },
  });
  return {
    response: new Response(body, {
      headers: { 'content-type': DATA_STREAM_CONTENT_TYPE },
    }),
    resolve: (key: string, value: unknown) =>
      send({ type: 'resolve', key, value }),
    terminal: () => send({ type: 'complete' }),
    close: () => controller.close(),
    complete() {
      send({ type: 'complete' });
      controller.close();
    },
    truncate: () => controller.close(),
    cancellations: () => cancellations,
  };
}

type ByteResponse = ReturnType<typeof byteResponse>;

function fixture(
  response?: (
    generation: number,
    signal: AbortSignal,
  ) => Response | Promise<Response>,
  options: {
    initialEntry?: string;
    staleTime?: number;
    awaitDeferred?: boolean;
    pendingComponent?: boolean;
  } = {},
) {
  const requests: Request[] = [];
  const signals: AbortSignal[] = [];
  const streams: ByteResponse[] = [];
  const errors: unknown[] = [];
  let resetBoundary: (() => void) | undefined;
  const client = createDataClient('item', identity, {
    fetch: async (input, init) => {
      const request = input as Request;
      const signal = init?.signal ?? request.signal;
      requests.push(request);
      signals.push(signal);
      if (response) return response(requests.length, signal);
      const stream = byteResponse({
        critical: `generation-${requests.length}`,
      });
      streams.push(stream);
      return stream.response;
    },
  });
  const router = createApplicationRouter({
    routeTree: createFileSystemRouteTree(
      routes,
      {
        layout: { component: Outlet },
        item: {
          component: () => {
            const data = useLoaderData({ strict: false });
            const later = () => {
              const value: unknown = data();
              if (
                value !== null &&
                typeof value === 'object' &&
                'later' in value &&
                value.later instanceof Promise
              )
                return value.later;
              throw new Error('The route has no deferred data');
            };
            return (
              <>
                <p data-testid="critical">
                  {String(
                    (data() as Record<string, unknown>).critical ?? 'empty',
                  )}
                </p>
                {options.awaitDeferred ? (
                  <Await
                    promise={later()}
                    fallback={<p data-testid="pending">pending</p>}
                  >
                    {value => <p data-testid="late">{String(value)}</p>}
                  </Await>
                ) : null}
              </>
            );
          },
          errorComponent: ({ error, reset }) => {
            errors.push(error);
            resetBoundary = reset;
            return (
              <p data-testid="error">
                {error instanceof Error ? error.message : String(error)}
              </p>
            );
          },
        },
        done: { component: () => <p data-testid="done">complete</p> },
      },
      {
        // A real request supplies the same absolute native URL in this DOM
        // realm and in an SSR request; no synthetic localhost production base.
        request: new Request('http://localhost/items/42'),
        loadRoute: (_route, input) => client.loader(input),
      },
    ),
    history: createMemoryHistory({
      initialEntries: [options.initialEntry ?? '/items/42'],
    }),
    origin: 'http://localhost',
    context: { ultramodern: { rendererIdentity: identity } },
    defaultStaleTime: options.staleTime ?? Number.POSITIVE_INFINITY,
    ...(options.pendingComponent
      ? {
          defaultPendingComponent: () => (
            <p data-testid="route-pending">loading route</p>
          ),
        }
      : { defaultPendingMs: 0, defaultPendingMinMs: 0 }),
    isServer: false,
  });
  const element = document.createElement('div');
  const mount = (hot?: { dispose(callback: () => void): void }) => {
    const dispose = mountApplication(
      () => <ApplicationRouter router={router} />,
      element,
      { hot },
    );
    disposers.push(dispose);
    return dispose;
  };
  return {
    router,
    element,
    requests,
    signals,
    streams,
    errors,
    mount,
    resetBoundary: () => resetBoundary?.(),
  };
}

async function waitFor(
  predicate: () => boolean,
  details?: () => unknown,
  attempts = 200,
) {
  for (let i = 0; i < attempts; i++) {
    flush();
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(
    `The native route completion did not settle${
      details ? `: ${JSON.stringify(details())}` : ''
    }`,
  );
}

describe('native Solid progressive route completion', () => {
  test('native pending presentation keeps the displayed Await stream alive through terminal EOF', async () => {
    const stream = byteResponse({ critical: 'native-pending-navigation' }, [
      'later',
    ]);
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      releaseResponse = resolve;
    });
    const app = fixture(() => response, {
      initialEntry: '/done',
      staleTime: 0,
      awaitDeferred: true,
      pendingComponent: true,
    });
    expect(app.router.options.defaultPendingMs).toBe(1000);
    expect(app.router.options.defaultPendingMinMs).toBe(500);
    await app.router.load();
    app.mount();
    await waitFor(() => app.element.textContent === 'complete');
    const navigation = app.router.navigate({ href: '/items/42' });
    await waitFor(
      () => app.element.querySelector('[data-testid="route-pending"]') !== null,
      undefined,
      600,
    );
    expect(app.requests).toHaveLength(1);
    expect(app.signals[0]?.aborted).toBe(false);
    releaseResponse(stream.response);
    await waitFor(
      () => app.element.querySelector('[data-testid="pending"]') !== null,
      undefined,
      600,
    );
    stream.resolve('later', 'pending-late-value');
    await waitFor(
      () =>
        app.element.querySelector('[data-testid="late"]')?.textContent ===
        'pending-late-value',
    );
    await navigation;
    stream.terminal();
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
    expect(app.signals[0]?.aborted).toBe(false);
    expect(stream.cancellations()).toBe(0);
    expect(app.requests).toHaveLength(1);
    expect(
      app.element.querySelector('[data-testid="route-pending"]'),
    ).toBeNull();
    expect(app.errors).toEqual([]);
    stream.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
    expect(app.signals[0]?.aborted).toBe(false);
    expect(stream.cancellations()).toBe(0);
    expect(app.element.querySelector('[data-testid="late"]')?.textContent).toBe(
      'pending-late-value',
    );
    expect(app.errors).toEqual([]);
  });

  test('settling the active Await keeps its response alive until terminal framing', async () => {
    const stream = byteResponse({ critical: 'active-navigation' }, ['later']);
    const app = fixture(() => stream.response, {
      initialEntry: '/done',
      staleTime: 0,
      awaitDeferred: true,
    });
    await app.router.load();
    app.mount();
    await waitFor(() => app.element.textContent === 'complete');
    const navigation = app.router.navigate({ href: '/items/42' });
    await waitFor(
      () => app.element.querySelector('[data-testid="pending"]') !== null,
    );
    expect(app.requests).toHaveLength(1);
    expect(app.signals[0]?.aborted).toBe(false);
    stream.resolve('later', 'active-late-value');
    await waitFor(
      () =>
        app.element.querySelector('[data-testid="late"]')?.textContent ===
        'active-late-value',
    );
    await navigation;
    expect(app.signals[0]?.aborted).toBe(false);
    expect(stream.cancellations()).toBe(0);
    expect(app.requests).toHaveLength(1);
    stream.terminal();
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
    expect(app.signals[0]?.aborted).toBe(false);
    expect(stream.cancellations()).toBe(0);
    expect(app.requests).toHaveLength(1);
    expect(app.element.querySelector('[data-testid="late"]')?.textContent).toBe(
      'active-late-value',
    );
    expect(app.errors).toEqual([]);
    stream.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
    expect(app.signals[0]?.aborted).toBe(false);
    expect(stream.cancellations()).toBe(0);
    expect(app.element.querySelector('[data-testid="late"]')?.textContent).toBe(
      'active-late-value',
    );
    expect(app.errors).toEqual([]);
  });

  test('critical data paints before the real producer resolves deferred data', async () => {
    let resolveLater!: (value: string) => void;
    const later = new Promise<string>(resolve => {
      resolveLater = resolve;
    });
    const app = fixture((_generation, signal) =>
      createDataResponse(
        {
          kind: 'deferred',
          critical: { critical: 'ready-before-deferred' },
          deferred: { later },
          response: {
            status: 200,
            statusText: 'OK',
            headers: [],
            cachePolicy: 'no-store',
          },
        },
        identity,
        { routeId: 'item', operation: 'loader', signal },
      ),
    );
    await app.router.load();
    const data = app.router.state.matches.at(-1)?.loaderData as {
      later: Promise<string>;
    };
    expect(data.later).toBeInstanceOf(Promise);
    app.mount();
    await waitFor(() => app.element.textContent === 'ready-before-deferred');
    expect(app.signals[0]?.aborted).toBe(false);
    resolveLater('deferred-ready');
    expect(await data.later).toBe('deferred-ready');
    await waitFor(() => app.element.textContent === 'ready-before-deferred');
    expect(app.router.state.matches.at(-1)?.loaderData).toBe(data);
    expect(data.later).toBeInstanceOf(Promise);
  });

  test('truncated terminal framing reaches the actual native route error boundary', async () => {
    const stream = byteResponse({ critical: 'initial-paint' }, ['later']);
    const app = fixture(() => stream.response);
    await app.router.load();
    app.mount();
    await waitFor(() => app.element.textContent === 'initial-paint');
    const data = app.router.state.matches.at(-1)?.loaderData as {
      later: Promise<string>;
    };
    stream.resolve('later', 'already-resolved');
    expect(await data.later).toBe('already-resolved');
    stream.truncate();
    await waitFor(
      () => app.element.querySelector('[data-testid="error"]') !== null,
    );
    expect(app.element.textContent).toContain('Truncated deferred data stream');
    expect(app.element.querySelector('[data-testid="critical"]')).toBeNull();
  });

  test('leaving a pending stream aborts it and long-lived native cache gets a new generation', async () => {
    const app = fixture();
    await app.router.load();
    const first = app.router.state.matches.at(-1)?.loaderData;
    app.mount();
    await waitFor(() => app.element.textContent === 'generation-1');
    await app.router.navigate({ href: '/done' });
    await waitFor(() => app.element.textContent === 'complete');
    await waitFor(() => app.signals[0]?.aborted === true);
    expect(app.streams[0]?.cancellations()).toBe(1);
    await app.router.navigate({ href: '/items/42' });
    await waitFor(() => app.element.textContent === 'generation-2');
    expect(app.requests).toHaveLength(2);
    expect(app.router.state.matches.at(-1)?.loaderData).not.toBe(first);
    expect(app.signals[1]?.aborted).toBe(false);
    app.streams[1]?.complete();
  });

  test('native invalidate recovers a failed stream; resetting a boundary does not fabricate a reload', async () => {
    const app = fixture();
    await app.router.load();
    app.mount();
    await waitFor(() => app.element.textContent === 'generation-1');
    app.streams[0]?.truncate();
    await waitFor(
      () => app.element.querySelector('[data-testid="error"]') !== null,
    );
    app.resetBoundary();
    flush();
    expect(app.requests).toHaveLength(1);
    expect(app.element.textContent).toContain('Truncated deferred data stream');
    await app.router.invalidate({ sync: true });
    await waitFor(
      () => app.element.textContent === 'generation-2',
      () => ({
        text: app.element.textContent,
        requests: app.requests.length,
        signals: app.signals.map(signal => signal.aborted),
        errors: app.errors.map(error =>
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
        ),
      }),
    );
    expect(app.requests).toHaveLength(2);
    expect(app.element.querySelector('[data-testid="error"]')).toBeNull();
    expect(app.signals[1]?.aborted).toBe(false);
    app.streams[1]?.complete();
  });

  test('deeply equal empty initial data cannot retain a failed previous completion generation', async () => {
    const streams: ByteResponse[] = [];
    const app = fixture(() => {
      const stream = byteResponse({});
      streams.push(stream);
      return stream.response;
    });
    await app.router.load();
    const first = app.router.state.matches.at(-1)?.loaderData;
    app.mount();
    await waitFor(() => app.element.textContent === 'empty');
    streams[0]?.truncate();
    await waitFor(
      () => app.element.querySelector('[data-testid="error"]') !== null,
    );
    await app.router.invalidate({ sync: true });
    await waitFor(
      () => app.element.textContent === 'empty',
      () => ({
        text: app.element.textContent,
        requests: app.requests.length,
        signals: app.signals.map(signal => signal.aborted),
        errors: app.errors.map(error =>
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
        ),
      }),
    );
    const second = app.router.state.matches.at(-1)?.loaderData;
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(app.signals[1]?.aborted).toBe(false);
    streams[1]?.complete();
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
    expect(app.element.querySelector('[data-testid="error"]')).toBeNull();
  });

  test('a superseded empty generation cannot poison an equal active generation when its stream aborts', async () => {
    const streams: ByteResponse[] = [];
    const app = fixture(() => {
      const stream = byteResponse({});
      streams.push(stream);
      return stream.response;
    });
    await app.router.load();
    const first = app.router.state.matches.at(-1)?.loaderData;
    app.mount();
    await waitFor(() => app.element.textContent === 'empty');
    await app.router.invalidate({ sync: true });
    expect(app.requests).toHaveLength(2);
    await waitFor(() => app.signals[0]?.aborted === true);
    expect(streams[0]?.cancellations()).toBe(1);
    const second = app.router.state.matches.at(-1)?.loaderData;
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    streams[1]?.complete();
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
    expect(app.signals[1]?.aborted).toBe(false);
    expect(app.element.textContent).toBe('empty');
    expect(app.element.querySelector('[data-testid="error"]')).toBeNull();
  });

  test('HMR root disposal aborts pending owned data exactly once and permits a fresh root', async () => {
    const callbacks: (() => void)[] = [];
    const app = fixture();
    await app.router.load();
    const dispose = app.mount({
      dispose: callback => callbacks.push(callback),
    });
    await waitFor(() => app.element.textContent === 'generation-1');
    callbacks[0]?.();
    dispose();
    callbacks[0]?.();
    await waitFor(() => app.signals[0]?.aborted === true);
    expect(app.streams[0]?.cancellations()).toBe(1);
    expect(app.element.childNodes).toHaveLength(0);
    app.mount();
    await app.router.invalidate({ sync: true });
    await waitFor(() => app.element.textContent === 'generation-2');
    callbacks[0]?.();
    flush();
    expect(app.element.textContent).toBe('generation-2');
    expect(app.signals[1]?.aborted).toBe(false);
    app.streams[1]?.complete();
  });
});
