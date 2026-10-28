import { runtime } from '@modern-js/plugin/runtime';
import type { TInternalRuntimeContext } from '@modern-js/runtime/context';
import * as runtimeContext from '@modern-js/runtime/context';
import {
  routerProviderRegistryHooks,
  setGlobalContext,
  setGlobalInternalRuntimeContext,
} from '@modern-js/runtime/context';
import { storage } from '@modern-js/runtime-utils/node';
import {
  type AnyRouter,
  RouterProvider,
  redirect,
} from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { routerStatePlugin } from '../../../../solutions/ultramodern-app-tools/src/renderers/react/router-state-runtime';
import type { ResponseProxy } from '../../../plugin-runtime/src/core/server/requestHandler';
import { SSRErrors } from '../../../plugin-runtime/src/core/server/tracer';
import {
  getRouterRuntimeState,
  getRouterServerSnapshot,
} from '../../src/runtime/lifecycle';
import { tanstackRouterPlugin } from '../../src/runtime/plugin.node';
import type { TanstackRouterPluginAPI } from '../../src/runtime/pluginShared';
import * as ssrUtils from '../../src/runtime/ssrManagedTags';
import * as ssrPreload from '../../src/runtime/ssrPreload';
import { createTanstackSsrStreamExtender } from '../../src/runtime/ssrStream';
import type { RouterConfig } from '../../src/runtime/types';

// Preparation uses plain loader data. Keep the native adapters and response
// pipeline, and reject any attempt to run the React server encoder here.
rstest.mock('react-server-dom-rspack/server.node', () => ({
  decodeReply: () => {
    throw new Error('Router preparation must not decode a Flight reply');
  },
  loadServerAction: () => {
    throw new Error('Router preparation must not load a server action');
  },
  renderToReadableStream: () => {
    throw new Error('Router preparation must not render a Flight stream');
  },
}));

type BeforeRenderListener = Parameters<
  TanstackRouterPluginAPI['onBeforeRender']
>[0];

(
  globalThis as typeof globalThis & {
    __webpack_require__?: { u: (chunkId: unknown) => string };
  }
).__webpack_require__ = {
  u: chunkId => String(chunkId),
};

function collectBeforeRender(
  createRoutes: NonNullable<RouterConfig['createRoutes']>,
): BeforeRenderListener {
  const { runtimeContext } = runtime.run({
    config: {},
    plugins: [tanstackRouterPlugin({ createRoutes })],
  });
  return async (context, interrupt) => {
    const result = await runtimeContext.hooks.onBeforeRender.call(context);
    if (result instanceof Response) {
      interrupt(result);
      return result;
    }
  };
}

function createServerContext(
  pathname: string,
  requestOptions: RequestInit = {},
) {
  const responseProxy: ResponseProxy = { headers: {}, status: -1 };
  const status = rstest.fn((code: number) => {
    responseProxy.status = code;
  });
  const setHeader = rstest.fn((key: string, value: string) => {
    responseProxy.headers[key] = value;
  });
  const context = {
    ssrContext: {
      baseUrl: '/',
      loaderContext: {},
      mode: 'string',
      request: {
        raw: new Request(`http://localhost${pathname}`, requestOptions),
      },
      response: { status, setHeader, locals: {} },
    },
  } as unknown as TInternalRuntimeContext;

  return { context, status, setHeader, responseProxy };
}

afterEach(() => {
  rstest.restoreAllMocks();
});

describe('tanstack server plugin router results', () => {
  test.each(['/cs/login', '/en/login'])(
    'renders native link active attributes during SSR at %s',
    async pathname => {
      const { context } = createServerContext(pathname);
      const beforeRender = collectBeforeRender(() => [
        {
          id: 'login',
          path: '/:lang/login',
          Component: () => {
            const Link = context.router?.Link;
            if (!Link) {
              throw new Error('SSR router did not provide its native Link');
            }
            return createElement(Link, { to: '/cs' }, 'Home');
          },
        },
      ]);
      await beforeRender(context, value => value);

      expect(context.router?.Link).toBeTypeOf('function');
      const html = renderToString(
        createElement(RouterProvider, {
          router: getRouterRuntimeState(context)?.instance as AnyRouter,
        }),
      );
      expect(html).toContain('href="/cs"');
      if (pathname === '/cs/login') {
        expect(html).toContain('data-status="active"');
        expect(html).toContain('aria-current="page"');
      } else {
        expect(html).not.toContain('data-status="active"');
        expect(html).not.toContain('aria-current="page"');
      }
    },
  );

  test('uses the router render result as the HTTP and hydration status', async () => {
    const beforeRender = collectBeforeRender(() => [
      {
        id: 'root',
        path: '/',
        Component: () => null,
        children: [
          {
            id: 'target',
            path: 'target',
            Component: () => null,
          },
        ],
      },
    ]);
    const { context, status } = createServerContext('/target');

    await beforeRender(context, value => value);

    expect(status).toHaveBeenCalledWith(200);
    expect(getRouterServerSnapshot(context)).toMatchObject({
      framework: 'tanstack',
      statusCode: 200,
    });
    // Without the dehydrated router the client re-renders matched remotes
    // from scratch instead of hydrating the server HTML.
    expect(getRouterServerSnapshot(context)?.hydrationScripts).toEqual(
      expect.arrayContaining([expect.stringContaining('$_TSR')]),
    );
  });

  test('interrupts SSR with the router redirect response', async () => {
    const beforeRender = collectBeforeRender(() => [
      {
        id: 'root',
        path: '/',
        Component: () => null,
        children: [
          {
            id: 'redirect',
            path: 'redirect',
            loader: () =>
              new Response(null, {
                status: 307,
                headers: { Location: '/target' },
              }),
            Component: () => null,
          },
          {
            id: 'target',
            path: 'target',
            Component: () => null,
          },
        ],
      },
    ]);
    const { context, status } = createServerContext('/redirect');
    const interrupt = rstest.fn((value: unknown) => value);

    const response = await beforeRender(context, interrupt);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(307);
    expect((response as Response).headers.get('Location')).toBe('/target');
    expect(interrupt).toHaveBeenCalledWith(response);
    expect(status).not.toHaveBeenCalled();
  });
});

describe('TanStack Flight response protocol', () => {
  afterEach(() => {
    rstest.restoreAllMocks();
  });

  test.each([
    { enableRsc: true, tree: 'true', action: false, expected: true },
    { enableRsc: true, tree: undefined, action: false, expected: false },
    { enableRsc: false, tree: 'true', action: false, expected: false },
    { enableRsc: true, tree: '1', action: false, expected: false },
    { enableRsc: true, tree: '', action: false, expected: false },
    { enableRsc: true, tree: 'false', action: false, expected: false },
    { enableRsc: true, tree: undefined, action: true, expected: false },
  ])(
    'sets Flight MIME only for native tree navigation: $enableRsc/$tree/$action',
    async ({ enableRsc, tree, action, expected }) => {
      rstest
        .spyOn(runtimeContext, 'getGlobalEnableRsc')
        .mockReturnValue(enableRsc);
      const headers = new Headers();
      if (tree !== undefined) headers.set('x-rsc-tree', tree);
      if (action) headers.set('x-rsc-action', 'compiled-action');
      const { context, setHeader, responseProxy } = createServerContext('/', {
        headers,
        method: action ? 'POST' : 'GET',
      });
      const beforeRender = collectBeforeRender(() => [
        { id: 'root', path: '/', Component: () => null },
      ]);

      await storage.run({ responseProxy }, () =>
        beforeRender(context, value => value),
      );

      if (expected) {
        expect(setHeader).toHaveBeenCalledExactlyOnceWith(
          'Content-Type',
          'text/x-component',
        );
      } else {
        expect(setHeader).not.toHaveBeenCalled();
      }
      await getRouterRuntimeState(context)?.cleanup?.();
    },
  );

  test('preserves native RSC redirects without declaring a Flight body', async () => {
    rstest.spyOn(runtimeContext, 'getGlobalEnableRsc').mockReturnValue(true);
    const beforeRender = collectBeforeRender(() => [
      {
        id: 'root',
        path: '/',
        Component: () => null,
        children: [
          {
            id: 'redirect',
            path: 'redirect',
            loader: () => {
              throw redirect({
                to: '/target',
                statusCode: 307,
                headers: { 'X-Route-Header': 'kept' },
              });
            },
            Component: () => null,
          },
          { id: 'target', path: 'target', Component: () => null },
        ],
      },
    ]);
    const { context, setHeader, responseProxy } = createServerContext(
      '/redirect',
      { headers: { 'x-rsc-tree': 'true' } },
    );
    const response = await storage.run({ responseProxy }, () =>
      beforeRender(context, value => value),
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(307);
    expect((response as Response).headers.get('X-Modernjs-Redirect')).toBe(
      '/target',
    );
    expect((response as Response).headers.get('X-Route-Header')).toBe('kept');
    expect((response as Response).headers.has('Content-Type')).toBe(false);
    expect(setHeader).not.toHaveBeenCalled();
    await getRouterRuntimeState(context)?.cleanup?.();
  });

  test.each(['eof', 'cancel'] as const)(
    'native finalization preserves Flight headers, status and streamed %s',
    async terminal => {
      rstest.spyOn(runtimeContext, 'getGlobalEnableRsc').mockReturnValue(true);
      const beforeRender = collectBeforeRender(() => [
        { id: 'root', path: '/', Component: () => null },
      ]);
      const { context, responseProxy } = createServerContext('/', {
        headers: { 'x-rsc-tree': 'true' },
      });
      await storage.run({ responseProxy }, () =>
        beforeRender(context, value => value),
      );
      const router = getRouterRuntimeState(context)!.instance as AnyRouter;
      const cleanup = rstest.spyOn(router.serverSsr!, 'cleanup');
      const onError = rstest.fn();
      const cancel = rstest.fn();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
        cancel,
      });
      context.ssrContext!.response.setHeader('X-Consumer-Header', 'kept');
      context.ssrContext!.response.status(202);
      const { createRequestLifecycle, finalizeRenderResponse } = await import(
        '../../../plugin-runtime/src/core/server/requestHandler'
      );
      const response = await finalizeRenderResponse(
        new Response(body, {
          status: 200,
          headers: { 'Cache-Control': 'private, no-store' },
        }),
        responseProxy,
        { enableRsc: true, isRSCNavigation: true, basename: '/' },
        createRequestLifecycle(
          () => getRouterRuntimeState(context)?.cleanup?.(),
          onError,
        ),
      );

      expect(response.status).toBe(202);
      expect(response.headers.get('Content-Type')).toBe('text/x-component');
      expect(response.headers.get('X-Consumer-Header')).toBe('kept');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.bodyUsed).toBe(false);
      expect(cleanup).not.toHaveBeenCalled();
      const reader = response.body!.getReader();
      const first = new TextEncoder().encode('0:{"type":"render"}\n');
      controller.enqueue(first);
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: first,
      });
      expect(cleanup).not.toHaveBeenCalled();
      if (terminal === 'eof') {
        const tail = new TextEncoder().encode('1:"server tree"\n');
        controller.enqueue(tail);
        controller.close();
        await expect(reader.read()).resolves.toEqual({
          done: false,
          value: tail,
        });
        await expect(reader.read()).resolves.toEqual({
          done: true,
          value: undefined,
        });
        expect(cancel).not.toHaveBeenCalled();
      } else {
        await reader.cancel('client disconnected');
        expect(cancel).toHaveBeenCalledExactlyOnceWith('client disconnected');
      }
      expect(cleanup).toHaveBeenCalledTimes(1);
      await getRouterRuntimeState(context)?.cleanup?.();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    },
  );
});

describe('TanStack preparation resource lifetime', () => {
  test.each([
    'attach',
    'load',
    'result',
    'preload',
    'dehydrate',
    'abort',
    'clientRender',
    'afterCreate',
  ])('disposes exactly once when %s fails', async stage => {
    const failure = new Error(`${stage} failed`);
    const cleanup = rstest.fn();
    const controller = new AbortController();
    const { context } = createServerContext('/');
    context.ssrContext!.request.raw = new Request('http://localhost/', {
      signal: controller.signal,
    });
    const attach = ssrUtils.attachServerSsrUtils;
    rstest
      .spyOn(ssrUtils, 'attachServerSsrUtils')
      .mockImplementation(async router => {
        await attach(router);
        rstest.spyOn(router.serverSsr!, 'cleanup').mockImplementation(cleanup);
        if (stage === 'attach') throw failure;
        if (stage === 'load')
          rstest.spyOn(router, 'load').mockRejectedValue(failure);
        if (stage === 'result')
          rstest.spyOn(router, 'load').mockResolvedValue(undefined);
        if (stage === 'dehydrate')
          rstest
            .spyOn(router.serverSsr!, 'dehydrate')
            .mockRejectedValue(failure);
        if (stage === 'abort') controller.abort(failure);
      });
    if (stage === 'clientRender') {
      context.ssrContext!.loaderFailureMode = 'clientRender';
      rstest
        .spyOn(ssrUtils, 'collectRouterErrors')
        .mockReturnValue({ root: failure });
    }
    if (stage === 'afterCreate')
      rstest
        .spyOn(routerProviderRegistryHooks.onAfterCreateRouter, 'call')
        .mockImplementation(() => {
          throw failure;
        });
    if (stage === 'preload')
      rstest
        .spyOn(ssrPreload, 'preloadMatchedRouteComponents')
        .mockRejectedValue(failure);
    const beforeRender = collectBeforeRender(() => [
      { id: 'root', path: '/', Component: () => null },
    ]);
    await expect(beforeRender(context, value => value)).rejects.toThrow(
      stage === 'result' ? 'without a server result' : failure.message,
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    await getRouterRuntimeState(context)?.cleanup?.();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test.each(['string', 'stream'] as const)(
    'retains %s router resources for response termination',
    async mode => {
      const { context } = createServerContext('/products/shoe?q=1#detail');
      context.ssrContext!.mode = mode;
      const beforeRender = collectBeforeRender(() => [
        { id: 'product', path: '/products/:id', Component: () => null },
      ]);
      await beforeRender(context, value => value);
      const state = getRouterRuntimeState(context)!;
      const router = state.instance as AnyRouter;
      const cleanup = rstest.spyOn(router.serverSsr!, 'cleanup');
      const navigation = state.navigation!;
      expect(navigation.getSnapshot()).toMatchObject({
        location: {
          pathname: '/products/shoe',
          search: '?q=1',
          hash: '#detail',
        },
        params: { id: 'shoe' },
      });
      expect(navigation.getSnapshot()).toBe(navigation.getSnapshot());
      expect(navigation.Link).toBe(context.router?.Link);
      expect(
        navigation.createLinkProps!({
          pathname: '/products/shoe',
          href: '/products/shoe?q=2#detail',
          search: { q: '2' },
          hash: 'detail',
          hashScrollIntoView: false,
          prefetch: 'none',
        }),
      ).toEqual({
        to: '/products/shoe',
        search: { q: '2' },
        hash: 'detail',
        hashScrollIntoView: false,
        preload: false,
      });
      expect(cleanup).not.toHaveBeenCalled();
      await state.cleanup?.();
      await state.cleanup?.();
      expect(cleanup).toHaveBeenCalledTimes(1);
    },
  );
});

test('incoming abort reaches an active Modern loader and disposes its router', async () => {
  const incoming = new AbortController();
  let started!: () => void;
  const loading = new Promise<void>(resolve => {
    started = resolve;
  });
  const { context } = createServerContext('/');
  context.ssrContext!.request.raw = new Request('http://localhost/', {
    signal: incoming.signal,
  });
  const failure = new Error('client disconnected during loader');
  const beforeRender = collectBeforeRender(() => [
    {
      id: 'root',
      path: '/',
      Component: () => null,
      loader: ({ request }: { request: Request }) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          );
          started();
        }),
    },
  ]);
  const pending = beforeRender(context, value => value);
  await loading;
  const router = getRouterRuntimeState(context)!.instance as AnyRouter;
  const cleanup = rstest.spyOn(router.serverSsr!, 'cleanup');
  incoming.abort(failure);
  await expect(pending).rejects.toBe(failure);
  expect(cleanup).toHaveBeenCalledTimes(1);
  await getRouterRuntimeState(context)?.cleanup?.();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

describe('TanStack provider with the native request handler', () => {
  test.each([
    {
      label: 'plain provider completion',
      ultraPolicy: false,
      terminal: 'complete',
    },
    {
      label: 'plain provider cancellation',
      ultraPolicy: false,
      terminal: 'cancelled',
    },
    {
      label: 'Ultra observer completion',
      ultraPolicy: true,
      terminal: 'complete',
    },
    {
      label: 'Ultra observer cancellation',
      ultraPolicy: true,
      terminal: 'cancelled',
    },
  ] as const)(
    'preserves loader reporting and disposes once for $label',
    async ({ ultraPolicy, terminal }) => {
      const failure = new Error('TanStack loader failed');
      let loaderRequest: Request | undefined;
      const provider = tanstackRouterPlugin({
        createRoutes: () => [
          {
            id: 'root',
            path: '/',
            Component: () => null,
            children: [
              {
                id: 'error',
                path: 'error',
                Component: () => null,
                loader: ({ request }: { request: Request }) => {
                  loaderRequest = request;
                  throw failure;
                },
              },
            ],
          },
        ],
      });
      const { runtimeContext } = runtime.run({
        config: { router: { framework: 'tanstack' } },
        plugins: ultraPolicy ? [routerStatePlugin(), provider] : [provider],
      });
      setGlobalContext({
        entryName: 'main',
        App: () => null,
        enableRsc: false,
      });
      setGlobalInternalRuntimeContext(runtimeContext as any);
      const request = new Request('http://localhost/error');
      const removeAbortListener = rstest.spyOn(
        request.signal,
        'removeEventListener',
      );
      const onError = rstest.fn();
      const observer = rstest.fn();
      runtimeContext.hooks.onRequestEnd.tap(observer);
      let state: ReturnType<typeof getRouterRuntimeState>;
      let cleanup: ReturnType<typeof rstest.fn> | undefined;
      let serverCleanup: ReturnType<typeof rstest.spyOn> | undefined;
      let releaseTail = () => {};
      const tailReleased = new Promise<void>(resolve => {
        releaseTail = resolve;
      });
      const encoder = new TextEncoder();
      const { createRequestHandler } = await import(
        '../../../plugin-runtime/src/core/server/requestHandler'
      );
      const handler = await createRequestHandler(
        async (_request, _Root, options) => {
          state = getRouterRuntimeState(options.runtimeContext);
          if (!state?.cleanup)
            throw new Error('TanStack did not register request resources');
          cleanup = rstest.fn(state.cleanup);
          state.cleanup = cleanup;
          const router = state.instance as AnyRouter;
          serverCleanup = rstest.spyOn(router.serverSsr!, 'cleanup');
          const snapshot = getRouterServerSnapshot(options.runtimeContext);
          expect(snapshot).toMatchObject({
            framework: 'tanstack',
            statusCode: 500,
          });
          expect(Object.values(snapshot?.errors ?? {})).toContain(failure);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('<shell>'));
              },
              async pull(controller) {
                if (terminal === 'cancelled') return;
                await tailReleased;
                controller.enqueue(encoder.encode('<tail>'));
                controller.close();
              },
            }),
          );
        },
      );

      const response = await handler(request, {
        resource: {
          entryName: 'main',
          route: { urlPath: '/' },
          htmlTemplate: '<html><head></head><body></body></html>',
        },
        config: { ssr: { mode: 'stream' } },
        params: {},
        locals: {},
        loaderContext: {},
        onTiming: () => {},
        onError,
      } as any);

      expect(response.status).toBe(500);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(failure, SSRErrors.LOADER_ERROR);
      expect(state?.framework).toBe('tanstack');
      expect(cleanup).not.toHaveBeenCalled();
      expect(serverCleanup).not.toHaveBeenCalled();
      expect(observer).not.toHaveBeenCalled();
      expect(removeAbortListener).not.toHaveBeenCalled();
      expect(loaderRequest?.signal.aborted).toBe(false);

      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        '<shell>',
      );
      if (terminal === 'cancelled') {
        await reader.cancel('client disconnected');
      } else {
        releaseTail();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(
          '<tail>',
        );
        expect((await reader.read()).done).toBe(true);
      }
      reader.releaseLock();

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(serverCleanup).toHaveBeenCalledTimes(1);
      expect(removeAbortListener).toHaveBeenCalledTimes(1);
      expect(removeAbortListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );
      expect(loaderRequest?.signal.aborted).toBe(true);
      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer.mock.calls[0]?.[0]).toMatchObject({
        terminal:
          terminal === 'complete'
            ? { status: 'complete' }
            : { status: 'cancelled', reason: 'client disconnected' },
      });
      expect(onError).toHaveBeenCalledTimes(1);
      await state?.cleanup?.();
      expect(serverCleanup).toHaveBeenCalledTimes(1);
      expect(removeAbortListener).toHaveBeenCalledTimes(1);
    },
  );
});

describe('native TanStack response serialization', () => {
  async function prepare() {
    let release!: (value: string) => void;
    const late = new Promise<string>(resolve => {
      release = resolve;
    });
    const beforeRender = collectBeforeRender(() => [
      {
        id: 'root',
        path: '/',
        loader: () => ({ late }),
        Component: () => null,
      },
    ]);
    const { context } = createServerContext('/');
    context.ssrContext!.mode = 'stream';
    await beforeRender(context, value => value);
    const router = getRouterRuntimeState(context)?.instance as AnyRouter;
    const request = context.ssrContext!.request.raw as Request;
    return { context, router, request, release };
  }

  test('streams native promise settlements after the body boundary and complete renderer scripts', async () => {
    const { context, router, request, release } = await prepare();
    const extension = createTanstackSsrStreamExtender(router, request);
    const head = getRouterServerSnapshot(context)!.hydrationScripts!.join('');
    const shell = extension.completedBody!('<main>pending</main>', {
      phase: 'shell',
    });
    expect(head).not.toContain('$tsr-stream-boundary');
    expect(shell).toContain('$tsr-stream-boundary');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const output = extension.processResponseStream!(source);
    const result = new Response(output).text();
    controller.enqueue(
      encoder.encode(
        `<html><head>${head}</head><body>${shell}<script>window.renderer = `,
      ),
    );
    release('native-settlement-ready');
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.enqueue(encoder.encode('true;</script></body></html>'));
    controller.close();
    const html = await result;
    expect(html).toContain('native-settlement-ready');
    expect(html).toContain('$_TSR.e()');
    expect(html).toContain('<script>window.renderer = true;</script>');
    expect(html.indexOf('native-settlement-ready')).toBeGreaterThan(
      html.indexOf('$tsr-stream-boundary'),
    );
    expect(html.endsWith('</body></html>')).toBe(true);
  });

  test('cancels the document producer and native serialization owner together', async () => {
    const { router, request } = await prepare();
    const cleanup = rstest.spyOn(router.serverSsr!, 'cleanup');
    const cancel = rstest.fn();
    const extension = createTanstackSsrStreamExtender(router, request);
    const shell = extension.completedBody!('<main>pending</main>', {
      phase: 'shell',
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`<body>${shell}`));
      },
      cancel,
    });
    const reader = extension.processResponseStream!(source).getReader();
    await reader.read();
    await reader.cancel('client left');
    expect(cancel).toHaveBeenCalledWith('client left');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
