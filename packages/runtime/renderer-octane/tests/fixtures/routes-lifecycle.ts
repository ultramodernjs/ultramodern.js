import assert from 'node:assert/strict';
import {
  createDataResponse,
  type DataOutcome,
  type DecodedDataOutcome,
  type FileSystemRouteIR,
} from '@modern-js/renderer-core/data';
import { createRequestSession } from '@modern-js/renderer-core/session';
import {
  createMemoryHistory,
  createRouter,
  type ErrorRouteComponent,
  isNotFound,
  isRedirect,
  Outlet,
  RouterProvider,
} from '@octanejs/tanstack-router';
import { hydrate } from '@octanejs/tanstack-router/ssr/client';
import {
  attachRouterServerSsrUtils,
  createRequestHandler,
  createSsrStreamResponse,
  getSsrStatus,
  RouterServer,
} from '@octanejs/tanstack-router/ssr/server';
import { rs } from '@rstest/core';
import { createElement, flushSync } from 'octane';
import { ssrHtml } from 'octane/server';
import { mountOctaneApplication } from '../../src/client';
import { createOctaneRouteAction } from '../../src/router';
import {
  createFileSystemRouteTree,
  matchApplicationRoutes,
  RouteDataError,
  resolveRouteData,
  selectApplicationDataRoute,
} from '../../src/routes';
import { renderOctaneApplication } from '../../src/server';
import { RouteActionOwner, routeActionOwner } from './route-action-owner';

const identity = {
  renderer: 'octane',
  appId: 'native-router-test',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'native-build',
} as const;
const metadata = (status = 200) => ({
  status,
  statusText: '',
  headers: [] as [string, string][],
  cachePolicy: 'no-store' as const,
});
const success = (value: unknown): DataOutcome => ({
  kind: 'success',
  value,
  response: metadata(),
});
const descriptor = (
  id: string,
  properties: Partial<FileSystemRouteIR> = {},
): FileSystemRouteIR => ({ id, children: [], ...properties });
const requestSession = (request = new Request('https://native.test/')) =>
  createRequestSession({
    request,
    identity,
    platform: { kind: 'node', bindings: {} },
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForNativeRouter(assertion: () => void) {
  for (let turn = 0; ; turn++) {
    flushSync(() => {});
    try {
      assertion();
      return;
    } catch (error) {
      if (turn === 1000) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function mountNativeRouter(router: ReturnType<typeof createRouter>) {
  const container = document.createElement('div');
  document.body.append(container);
  try {
    const handle = await mountOctaneApplication({
      container,
      identity,
      nativeHydrationBuildId: 'native-router-fixture-client',
      load: async () => ({ default: RouterProvider, props: { router } }),
    });
    flushSync(() => {});
    return { container, handle };
  } catch (error) {
    container.remove();
    throw error;
  }
}

export async function nativeRouterPreloadAndInvalidationCounts() {
  const loads: string[] = [];
  const tree = createFileSystemRouteTree(
    [
      descriptor('home', { index: true, modules: { data: '/home.data.ts' } }),
      descriptor('item', {
        path: 'item/:id',
        modules: { data: '/item.data.ts' },
      }),
    ],
    { home: { component: () => null }, item: { component: () => null } },
    {
      loadRoute: async route => {
        loads.push(route.id);
        return success({ routeId: route.id, invocation: loads.length });
      },
    },
  );
  const router = createRouter({
    routeTree: tree,
    isServer: false,
    origin: 'https://native.test',
    history: createMemoryHistory({ initialEntries: ['/'] }),
    defaultStaleTime: Infinity,
    defaultPreloadStaleTime: Infinity,
  });
  const { container, handle } = await mountNativeRouter(router);
  try {
    await waitForNativeRouter(() => {
      assert.equal(router.stores.matches.get().at(-1)?.status, 'success');
      assert.deepEqual(loads, ['home']);
    });

    const preloadedMatches = await router.preloadRoute({ to: '/item/7' });
    assert.deepEqual(loads, ['home', 'item']);
    assert.equal(router.stores.location.get().pathname, '/');
    const preloaded = preloadedMatches!.at(-1)!;
    assert.deepEqual(preloaded.loaderData, {
      routeId: 'item',
      invocation: 2,
    });

    await router.navigate({ to: '/item/7' });
    await waitForNativeRouter(() => {
      const match = router.stores.matches.get().at(-1)!;
      assert.equal(router.stores.location.get().pathname, '/item/7');
      assert.equal(match.status, 'success');
      assert.equal(match.loaderData, preloaded.loaderData);
      assert.deepEqual(loads, ['home', 'item']);
    });

    await router.invalidate({ sync: true });
    await waitForNativeRouter(() => {
      assert.deepEqual(loads, ['home', 'item', 'item']);
      assert.equal(
        router.stores.matches.get().at(-1)?.loaderData.invocation,
        3,
      );
    });

    let outcome = success({ saved: true });
    let actions = 0;
    const action = createOctaneRouteAction({
      router,
      routeId: 'item',
      identity,
      fetch: async () => {
        actions++;
        return createDataResponse(outcome, identity, {
          routeId: 'item',
          operation: 'action',
        });
      },
    });
    const form = new FormData();
    form.set('sku', 'tractor');
    assert.equal((await action(undefined, form)).kind, 'success');
    assert.equal(actions, 1);
    await waitForNativeRouter(() => {
      assert.deepEqual(loads, ['home', 'item', 'item', 'item']);
      assert.equal(
        router.stores.matches.get().at(-1)?.loaderData.invocation,
        4,
      );
    });

    outcome = {
      kind: 'error',
      error: { name: 'ValidationError', message: 'Check SKU' },
      data: { sku: 'unknown' },
      thrown: false,
      response: metadata(422),
    };
    assert.equal((await action(undefined, form)).kind, 'error');
    assert.equal(actions, 2);
    assert.deepEqual(loads, ['home', 'item', 'item', 'item']);

    outcome = {
      kind: 'error',
      error: { name: 'Failure', message: 'Failed save' },
      thrown: true,
      response: metadata(500),
    };
    await assert.rejects(action(undefined, form), /Failed save/);
    assert.equal(actions, 3);
    assert.deepEqual(loads, ['home', 'item', 'item', 'item']);
  } finally {
    handle.dispose();
    container.remove();
    router.history.destroy();
  }
}

export async function nativeRouterActionRedirect(
  location: string,
  expectedHref: string,
  url?: string | (() => string),
  documentNavigation = false,
) {
  const tree = createFileSystemRouteTree(
    [
      descriptor('product', { path: 'products/:id' }),
      descriptor('account-complete', { path: 'account/complete' }),
      descriptor('complete', { path: 'complete' }),
      descriptor('save', { path: 'account/actions/save' }),
    ],
    {},
  );
  const router = createRouter({
    routeTree: tree,
    isServer: false,
    origin: 'https://native.test',
    history: createMemoryHistory({ initialEntries: ['/products/42'] }),
  });
  const { container, handle } = await mountNativeRouter(router);
  const documentLocation = rs
    .spyOn(window.location, 'href', 'set')
    .mockImplementation(() => {});
  try {
    await waitForNativeRouter(() => {
      assert.equal(router.stores.matches.get().at(-1)?.status, 'success');
      assert.equal(router.stores.location.get().pathname, '/products/42');
    });
    let submissions = 0;
    const action = createOctaneRouteAction({
      router,
      routeId: 'product',
      identity,
      url,
      fetch: async (input, init) => {
        const request = input as Request;
        const target = new URL(request.url);
        assert.equal(
          target.pathname,
          url ? '/account/actions/save' : '/products/42',
        );
        assert.equal(target.searchParams.get('__loader'), 'product');
        assert.equal(target.searchParams.get('__ssrDirect'), 'true');
        assert.equal(request.method, 'POST');
        assert.equal(init?.credentials, 'same-origin');
        assert.equal(init?.redirect, 'manual');
        assert.equal((await request.formData()).get('sku'), 'tractor');
        submissions++;
        return createDataResponse(
          { kind: 'redirect', location, response: metadata(303) },
          identity,
          { routeId: 'product', operation: 'action' },
        );
      },
    });
    const form = new FormData();
    form.set('sku', 'tractor');
    const result = await action(undefined, form);
    assert.equal(submissions, 1);
    assert.equal(result.kind, 'redirect');
    assert.equal(result.kind === 'redirect' && result.location, location);
    if (documentNavigation) {
      assert.deepEqual(documentLocation.mock.calls, [[expectedHref]]);
      assert.equal(router.stores.location.get().pathname, '/products/42');
    } else {
      assert.equal(documentLocation.mock.calls.length, 0);
      const expected = new URL(expectedHref);
      await waitForNativeRouter(() => {
        const actual = router.stores.location.get();
        assert.equal(actual.pathname, expected.pathname);
        assert.equal(actual.searchStr, expected.search);
        assert.equal(actual.hash, expected.hash.slice(1));
        assert.equal(router.stores.matches.get().at(-1)?.status, 'success');
      });
    }
  } finally {
    documentLocation.mockRestore();
    handle.dispose();
    container.remove();
    router.history.destroy();
  }
}

export async function nativeRouterActionOwnerDisposal() {
  const response = deferred<Response>();
  let fetchSignal: AbortSignal | null | undefined;
  routeActionOwner.fetch = async (_input, init) => {
    fetchSignal = init?.signal;
    return response.promise;
  };
  const tree = createFileSystemRouteTree(
    [
      descriptor('home', { index: true }),
      descriptor('other', { path: 'other' }),
      descriptor('complete', { path: 'complete' }),
    ],
    { home: { component: RouteActionOwner } },
  );
  const router = createRouter({
    routeTree: tree,
    isServer: false,
    origin: 'https://native.test',
    context: { ultramodern: { rendererIdentity: identity } },
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const { container, handle } = await mountNativeRouter(router);
  try {
    await waitForNativeRouter(() => {
      assert.ok(container.querySelector('[data-fixture="route-action-owner"]'));
    });
    const submitting = routeActionOwner.submit!(undefined, new FormData());
    const settled = submitting.then(
      () => assert.fail('A disposed owner must not apply its action outcome'),
      error => error,
    );
    await waitForNativeRouter(() => assert.ok(fetchSignal));
    await router.navigate({ to: '/other' });
    await waitForNativeRouter(() => {
      assert.equal(router.stores.location.get().pathname, '/other');
      assert.equal(
        container.querySelector('[data-fixture="route-action-owner"]'),
        null,
      );
    });
    assert.equal(fetchSignal!.aborted, true);
    assert.equal((await settled).name, 'AbortError');
    // The late result would have redirected; the user stays where they went.
    response.resolve(
      createDataResponse(
        { kind: 'redirect', location: '/complete', response: metadata(303) },
        identity,
        { routeId: 'home', operation: 'action' },
      ),
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(router.stores.location.get().pathname, '/other');
  } finally {
    routeActionOwner.fetch = undefined;
    routeActionOwner.submit = undefined;
    handle.dispose();
    container.remove();
    router.history.destroy();
  }
}

export async function nativeRouterReversedPendingNavigation() {
  const pending = new Map([
    ['first', deferred<DataOutcome>()],
    ['second', deferred<DataOutcome>()],
  ]);
  const calls: { id: string; request: Request }[] = [];
  const outcomes: string[] = [];
  const tree = createFileSystemRouteTree(
    [
      descriptor('home', { index: true }),
      descriptor('item', {
        path: 'item/:id',
        modules: { data: '/item.data.ts' },
      }),
    ],
    { home: { component: () => null }, item: { component: () => null } },
    {
      loadRoute: async (_route, input) => {
        const id = input.params.id!;
        calls.push({ id, request: input.request });
        return pending.get(id)!.promise;
      },
      onOutcome: (_routeId, outcome) => {
        if (outcome.kind === 'success') outcomes.push(String(outcome.value));
      },
    },
  );
  const router = createRouter({
    routeTree: tree,
    isServer: false,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    defaultStaleTime: Infinity,
  });
  const { container, handle } = await mountNativeRouter(router);
  try {
    await waitForNativeRouter(() =>
      assert.equal(router.stores.matches.get().at(-1)?.status, 'success'),
    );
    const first = router.navigate({ to: '/item/first' });
    await waitForNativeRouter(() => {
      assert.deepEqual(
        calls.map(call => call.id),
        ['first'],
      );
      assert.equal(calls[0]!.request.signal.aborted, false);
    });
    const second = router.navigate({ to: '/item/second' });
    await waitForNativeRouter(() => {
      assert.deepEqual(
        calls.map(call => call.id),
        ['first', 'second'],
      );
      assert.equal(calls[0]!.request.signal.aborted, true);
      assert.equal(calls[1]!.request.signal.aborted, false);
    });

    pending.get('second')!.resolve(success('second wins'));
    await second;
    await waitForNativeRouter(() => {
      assert.equal(router.stores.location.get().pathname, '/item/second');
      assert.equal(
        router.stores.matches.get().at(-1)?.loaderData,
        'second wins',
      );
      assert.deepEqual(outcomes, ['second wins']);
    });
    const winner = router.stores.matches.get().at(-1)!;
    pending.get('first')!.resolve(success('first completes too late'));
    await first;
    await waitForNativeRouter(() => {
      assert.equal(router.stores.location.get().pathname, '/item/second');
      assert.equal(router.stores.matches.get().at(-1)?.id, winner.id);
      assert.equal(
        router.stores.matches.get().at(-1)?.loaderData,
        'second wins',
      );
      assert.deepEqual(
        calls.map(call => call.id),
        ['first', 'second'],
      );
      assert.deepEqual(outcomes, ['second wins']);
    });
  } finally {
    for (const [id, value] of pending) value.resolve(success(id));
    handle.dispose();
    container.remove();
    router.history.destroy();
  }
}

export async function nativeRouterRouteChainHydration() {
  const routes = [
    descriptor('application', {
      isRoot: true,
      modules: { data: '/application.data.ts' },
      children: [
        descriptor('layout', {
          children: [
            descriptor('product', {
              path: 'products/:productId',
              modules: { data: '/product.data.ts' },
            }),
            descriptor('about', {
              path: 'about',
              modules: { data: '/about.data.ts' },
            }),
          ],
        }),
      ],
    }),
  ];
  const serverLoads: string[] = [];
  const clientLoads: string[] = [];
  const modules = {
    product: { component: () => null },
    about: { component: () => null },
  };
  const request = new Request('https://native.test/products/42');
  const serverRouter = createRouter({
    routeTree: createFileSystemRouteTree(routes, modules, {
      request,
      loadRoute: async route => {
        serverLoads.push(route.id);
        return success({ source: 'server', routeId: route.id });
      },
    }),
    isServer: true,
    history: createMemoryHistory({ initialEntries: ['/products/42'] }),
    defaultStaleTime: Infinity,
  });
  attachRouterServerSsrUtils({ router: serverRouter, manifest: undefined });
  await serverRouter.load();
  for (const match of serverRouter.stores.matches.get()) {
    assert.equal(match.status, 'success', String(match.error));
  }
  assert.equal(
    serverRouter.stores.matches.get().every(match => match.ssr === true),
    true,
    'The test resolver must admit native server loading before serialization',
  );
  const serverChain = serverRouter.stores.matches
    .get()
    .map(match => match.routeId);
  assert.deepEqual(
    serverChain.map(
      id => serverRouter.routesById[id]?.options.staticData?.ultramodernRouteId,
    ),
    ['application', 'layout', 'product'],
  );
  assert.deepEqual(serverLoads, ['application', 'product']);
  await serverRouter.serverSsr!.dehydrate();
  const serialized = serverRouter
    .serverSsr!.takeInitialHydrationScriptTags()!
    .before.map(tag => tag.children ?? '')
    .join('');
  assert.match(serialized, /\$_TSR\.router=/);
  serverRouter.serverSsr!.cleanup();

  const previousBootstrap = window.$_TSR;
  const serializationScript = document.createElement('script');
  document.head.append(serializationScript);
  const clientRouter = createRouter({
    routeTree: createFileSystemRouteTree(routes, modules, {
      loadRoute: async route => {
        clientLoads.push(route.id);
        return success({ source: 'client', routeId: route.id });
      },
    }),
    isServer: false,
    history: createMemoryHistory({ initialEntries: ['/products/42'] }),
    defaultStaleTime: Infinity,
  });
  let mounted: Awaited<ReturnType<typeof mountNativeRouter>> | undefined;
  try {
    delete window.$_TSR;
    // Run the released serializer's actual bootstrap and queued closures. The
    // browser supplies currentScript only during a script element's evaluation.
    new Function(
      'self',
      'serializationDocument',
      `with(self) { (function(document) { ${serialized} })(serializationDocument); }`,
    )(window, { currentScript: serializationScript });
    await hydrate(clientRouter);
    flushSync(() => {});
    assert.deepEqual(
      clientRouter.stores.matches.get().map(match => match.routeId),
      serverChain,
    );
    assert.deepEqual(clientLoads, []);
    assert.deepEqual(clientRouter.stores.matches.get().at(-1)?.loaderData, {
      source: 'server',
      routeId: 'product',
    });

    mounted = await mountNativeRouter(clientRouter);
    window.$_TSR?.h();
    await clientRouter.navigate({ to: '/about' });
    await waitForNativeRouter(() => {
      assert.equal(clientRouter.stores.location.get().pathname, '/about');
      assert.deepEqual(
        clientRouter.stores.matches
          .get()
          .map(
            match =>
              clientRouter.routesById[match.routeId]?.options.staticData
                ?.ultramodernRouteId,
          ),
        ['application', 'layout', 'about'],
      );
      assert.deepEqual(clientLoads, ['about']);
    });
    await clientRouter.navigate({ to: '/products/42' });
    await waitForNativeRouter(() => {
      assert.equal(clientRouter.stores.location.get().pathname, '/products/42');
      assert.deepEqual(
        clientRouter.stores.matches.get().map(match => match.routeId),
        serverChain,
      );
      assert.deepEqual(clientRouter.stores.matches.get().at(-1)?.loaderData, {
        source: 'server',
        routeId: 'product',
      });
      assert.deepEqual(clientLoads, ['about']);
      assert.deepEqual(serverLoads, ['application', 'product']);
    });
  } finally {
    mounted?.handle.dispose();
    mounted?.container.remove();
    serializationScript.remove();
    clientRouter.history.destroy();
    serverRouter.history.destroy();
    window.$_TSR = previousBootstrap;
  }
}

async function checkNativeDataCompletionFailure(
  timing: 'early' | 'late' | 'commit' | 'cancelled',
) {
  const terminal = deferred<void>();
  const failure = new Error(`Missing terminal data frame: ${timing}`);
  if (timing === 'early') terminal.reject(failure);
  void terminal.promise.catch(() => {});
  const late = deferred<string>();
  const preload = deferred<void>();
  const initial = deferred<void>();
  const hooks: string[] = [];
  const errorComponent = Object.assign(() => null, {
    preload: async () => {
      hooks.push('preload');
    },
  });
  let router!: ReturnType<typeof createRouter>;
  const tree = createFileSystemRouteTree(
    [
      descriptor('item', {
        path: 'item/:itemId',
        modules: { data: '/item.data.ts' },
      }),
    ],
    {
      item: {
        errorComponent,
        ...(timing === 'commit'
          ? {
              component: Object.assign(() => null, {
                preload: () => preload.promise,
              }),
            }
          : {}),
      },
    },
    {
      // Client factories use their browser URL and native loader signal.
      ...(timing === 'commit'
        ? {}
        : { request: new Request('https://native.test/item/7') }),
      getRouter: () => router,
      onOutcome: () => initial.resolve(),
      loadRoute: async (): Promise<DecodedDataOutcome> => ({
        kind: 'success',
        status: 200,
        value: { critical: 'early value', late: late.promise },
        completion: terminal.promise,
      }),
    },
  );
  tree.children[0].update({
    onError: () => {
      hooks.push('onError');
    },
  });
  router = createRouter({
    routeTree: tree,
    isServer: timing !== 'commit',
    history: createMemoryHistory({ initialEntries: ['/item/7'] }),
  });
  const loading = router.load();
  if (timing === 'commit') {
    await Promise.race([
      initial.promise,
      loading.then(() => {
        const failed = router.stores.matches
          .get()
          .find(match => match.status === 'error');
        if (failed) throw failed.error;
        throw new Error(
          'Native router finished before publishing critical data',
        );
      }),
    ]);
    terminal.reject(failure);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    preload.resolve();
  }
  await loading;
  const match = router.stores.matches.get().at(-1)!;
  if (timing === 'early' || timing === 'commit') {
    assert.equal(match.status, 'error');
    assert.equal(match.error, failure);
    assert.deepEqual(hooks.toSorted(), ['onError', 'preload']);
    return;
  }
  assert.equal(match.status, 'success');
  assert.equal(match.loaderData.critical, 'early value');
  assert.equal(match.loaderData.late, late.promise);
  assert.deepEqual(hooks, []);
  late.resolve('resolved before missing terminal frame');
  await late.promise;
  if (timing === 'cancelled') match.abortController.abort();
  terminal.reject(failure);
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1));
    if (router.stores.getMatchStore(match.routeId).get()?.status === 'error')
      break;
    if (timing === 'cancelled' && attempt > 2) break;
  }
  const completed = router.stores.getMatchStore(match.routeId).get()!;
  if (timing === 'cancelled') {
    assert.equal(completed.status, 'success');
    assert.deepEqual(hooks, []);
  } else {
    assert.equal(completed.status, 'error');
    assert.equal(completed.error, failure);
    assert.deepEqual(hooks, ['preload', 'onError']);
  }
}

export async function nativeDataCompletionFailure() {
  for (const timing of ['early', 'late', 'cancelled'] as const) {
    await checkNativeDataCompletionFailure(timing);
  }
}

/** Reactive native commits run in the owning browser environment. */
export async function nativeDataCompletionCommitFailure() {
  await checkNativeDataCompletionFailure('commit');
}

export async function nativeFileSystemRoutes() {
  const calls: {
    id: string;
    params: Readonly<Record<string, string>>;
    url: string;
  }[] = [];
  const request = new Request('https://native.test/products/42?sort=price', {
    headers: { 'x-request-owned': 'yes' },
  });
  const context = { tenant: 'tractor-store' };
  const root = descriptor('app-root', {
    isRoot: true,
    modules: { data: '/root.data.ts' },
    children: [
      descriptor('layout', {
        children: [
          descriptor('home', { index: true }),
          descriptor('product', {
            path: 'products/:productId',
            modules: { data: '/product.data.ts' },
          }),
          descriptor('locale', {
            path: 'locale/:lang?',
            children: [descriptor('locale-index', { index: true })],
          }),
          descriptor('files', { path: 'files/*' }),
          descriptor('feed', { path: 'feed.xml' }),
        ],
      }),
    ],
  });
  const pending = () => null;
  const error = () => null;
  const tree = createFileSystemRouteTree(
    [root],
    {
      product: {
        pendingComponent: pending,
        errorComponent: error,
        validateSearch: search => ({ sort: search.sort ?? 'name' }),
      },
    },
    {
      request,
      context,
      loadRoute: async (route, input) => {
        assert.equal(input.context, context);
        assert.equal(input.request.headers.get('x-request-owned'), 'yes');
        assert.equal(input.request.signal.aborted, false);
        calls.push({
          id: route.id,
          params: input.params,
          url: input.request.url,
        });
        return success({ loaded: route.id });
      },
    },
  );
  tree.update({
    beforeLoad: () => ({ authorization: 'native-route-context' }),
  });
  const router = createRouter({
    routeTree: tree,
    context: { ultramodern: { rendererIdentity: identity } },
    isServer: true,
    history: createMemoryHistory({
      initialEntries: ['/products/42?sort=price'],
    }),
  });
  await router.load();
  assert.deepEqual(
    calls.map(call => call.id),
    ['app-root', 'product'],
  );
  assert.equal(calls[1]?.params.productId, '42');
  assert.equal(calls[1]?.url, request.url);
  const matches = router.stores.matches.get();
  assert.deepEqual(
    matches.map(
      match =>
        router.routesById[match.routeId]?.options.staticData
          ?.ultramodernRouteId,
    ),
    ['app-root', 'layout', 'product'],
  );
  assert.deepEqual(matches.at(-1)?.loaderData, { loaded: 'product' });
  assert.deepEqual(matches.at(-1)?.search, { sort: 'price' });
  assert.deepEqual(matches.at(-1)?.context, {
    ultramodern: { rendererIdentity: identity },
    authorization: 'native-route-context',
  });
  assert.equal(
    router.routesById[matches.at(-1)!.routeId]?.options.pendingComponent,
    pending,
  );
  assert.equal(
    router.routesById[matches.at(-1)!.routeId]?.options.errorComponent,
    error,
  );
  assert.equal(typeof tree.options.component, 'function');
  assert.notEqual(tree.options.component, Outlet);
  for (const [pathname, expectedId] of [
    ['/', 'home'],
    ['/locale', 'locale-index'],
    ['/locale/en', 'locale-index'],
    ['/files/a/b', 'files'],
    ['/feed.xml', 'feed'],
  ] as const) {
    const match = router.matchRoutes(pathname).at(-1)!;
    assert.equal(
      router.routesById[match.routeId]?.options.staticData?.ultramodernRouteId,
      expectedId,
    );
    if (expectedId === 'files') assert.equal(match.params._splat, 'a/b');
  }
  const loader = () => ({ authorized: true });
  const handlers = { product: { loader }, 'app-root': { loader } };
  assert.equal(
    selectApplicationDataRoute(router, request, 'product', 'loader', handlers)
      ?.handler,
    loader,
  );
  assert.equal(
    selectApplicationDataRoute(router, request, 'product', 'loader', handlers)
      ?.params.productId,
    '42',
  );
  assert.equal(
    selectApplicationDataRoute(router, request, 'app-root', 'loader', handlers)
      ?.handler,
    loader,
  );
  assert.equal(
    selectApplicationDataRoute(
      router,
      new Request('https://native.test/feed.xml'),
      'product',
      'loader',
      handlers,
    ),
    undefined,
  );
  assert.equal(
    selectApplicationDataRoute(router, request, 'product', 'action', handlers),
    undefined,
  );
}

export async function nativeBasepathRoutes() {
  const loaderUrls: string[] = [];
  const request = new Request('https://native.test/app/products/42?sort=price');
  const tree = createFileSystemRouteTree(
    [
      descriptor('app-root', {
        isRoot: true,
        children: [
          descriptor('home', { index: true }),
          descriptor('product', {
            path: 'products/:productId',
            modules: { data: '/product.data.ts' },
          }),
        ],
      }),
    ],
    {},
    {
      request,
      loadRoute: async (_route, input) => {
        loaderUrls.push(input.request.url);
        return success({ loaded: true });
      },
    },
  );
  const router = createRouter({
    routeTree: tree,
    basepath: '/app',
    isServer: true,
    origin: 'https://native.test',
    history: createMemoryHistory({
      initialEntries: ['/app/products/42?sort=price'],
    }),
  });
  await router.load();
  // The loader request must carry the public URL the server serves, not the
  // router's basepath-stripped internal href.
  assert.deepEqual(loaderUrls, [
    'https://native.test/app/products/42?sort=price',
  ]);
  const ids = (url: string) =>
    matchApplicationRoutes(router, new URL(url)).map(
      match =>
        router.routesById[match.routeId]?.options.staticData
          ?.ultramodernRouteId,
    );
  assert.deepEqual(ids('https://native.test/app/products/42'), [
    'app-root',
    'product',
  ]);
  assert.deepEqual(ids('https://native.test/app'), ['app-root', 'home']);
  const loader = () => ({ authorized: true });
  const selected = selectApplicationDataRoute(
    router,
    new Request('https://native.test/app/products/42?__loader=product'),
    'product',
    'loader',
    { product: { loader } },
  );
  assert.equal(selected?.handler, loader);
  assert.equal(selected?.params.productId, '42');

  const requests: Request[] = [];
  const action = createOctaneRouteAction({
    router,
    routeId: 'product',
    identity,
    fetch: async input => {
      const actionRequest =
        input instanceof Request ? input : new Request(input);
      requests.push(actionRequest);
      return createDataResponse(success({ saved: true }), identity, {
        routeId: 'product',
        operation: 'action',
      });
    },
  });
  assert.equal((await action(undefined, new FormData())).kind, 'success');
  const actionUrl = new URL(requests[0]!.url);
  assert.equal(actionUrl.pathname, '/app/products/42');
  assert.equal(actionUrl.searchParams.get('sort'), 'price');
}

export async function nativeLoaderCancellation() {
  for (const source of ['request', 'native-router'] as const) {
    const controller = new AbortController();
    const request = new Request('https://native.test/item/7', {
      signal: controller.signal,
    });
    const pending = deferred<DataOutcome>();
    let loaderRequest: Request | undefined;
    let observed = 0;
    const tree = createFileSystemRouteTree(
      [
        descriptor('item', {
          path: 'item/:id',
          modules: { data: '/item.data.ts' },
        }),
      ],
      {},
      {
        request,
        loadRoute: async (_route, input) => {
          loaderRequest = input.request;
          return pending.promise;
        },
        onOutcome: () => {
          observed++;
        },
      },
    );
    const router = createRouter({
      routeTree: tree,
      isServer: true,
      history: createMemoryHistory({ initialEntries: ['/item/7'] }),
    });
    const nativeController = new AbortController();
    const loading = router.load({ _signal: nativeController.signal });
    for (let attempts = 0; !loaderRequest && attempts < 1000; attempts++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(
      loaderRequest,
      'The native router must start its matching loader',
    );
    if (source === 'request') {
      controller.abort(new DOMException('Connection closed', 'AbortError'));
    } else {
      nativeController.abort(
        new DOMException('Native load cancelled', 'AbortError'),
      );
    }
    assert.equal(loaderRequest.signal.aborted, true);
    pending.resolve(success('too late'));
    if (source === 'native-router')
      await assert.rejects(
        loading,
        error => error === nativeController.signal.reason,
      );
    else await loading;
    assert.equal(observed, 0);
    assert.notEqual(router.stores.matches.get().at(-1)?.loaderData, 'too late');
  }
}

export async function nativeOutcomeBoundaries() {
  assert.throws(
    () =>
      resolveRouteData('product', {
        kind: 'not-found',
        value: { missing: 'tractor' },
        thrown: true,
        status: 404,
      }),
    isNotFound,
  );
  try {
    resolveRouteData('product', {
      kind: 'redirect',
      location: '/sign-in',
      response: {
        ...metadata(303),
        headers: [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ],
      },
    });
    assert.fail('Expected a native redirect');
  } catch (error) {
    assert.equal(isRedirect(error), true);
    assert.equal((error as Response).status, 303);
    assert.deepEqual(
      new Headers((error as { headers: Headers }).headers).getSetCookie(),
      ['a=1', 'b=2'],
    );
  }
  assert.throws(
    () =>
      resolveRouteData('product', {
        kind: 'error',
        error: { name: 'ValidationError', message: 'Invalid product' },
        data: { field: 'sku' },
        thrown: true,
        status: 422,
      }),
    error =>
      error instanceof RouteDataError &&
      error.status === 422 &&
      error.routeId === 'product' &&
      error.name === 'ValidationError' &&
      (error.data as { field: string }).field === 'sku',
  );
  assert.throws(
    () =>
      createFileSystemRouteTree(
        [descriptor('a', { modules: { data: '/a.data.ts' } })],
        {},
      ),
    /requires its loader/,
  );
}

async function serializingRouter(late: Promise<unknown>) {
  const request = new Request('https://native.test/');
  const tree = createFileSystemRouteTree(
    [descriptor('home', { index: true, modules: { data: '/home.data.ts' } })],
    {},
    {
      request,
      loadRoute: async () => success({ late }),
    },
  );
  const router = createRouter({
    routeTree: tree,
    isServer: true,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  attachRouterServerSsrUtils({ router });
  await router.load();
  await router.serverSsr!.dehydrate();
  return { router, session: requestSession(request) };
}

async function renderSerializingRouter(
  router: Parameters<typeof renderOctaneApplication>[0]['router'],
  session: ReturnType<typeof requestSession>,
  timeoutMs?: number,
) {
  return renderOctaneApplication({
    session,
    router,
    routerSerializationTimeoutMs: timeoutMs,
    App: RouterServer,
    props: { router },
    document: {
      documentId: 'native-router-stream',
      nativeHydrationBuildId: 'native-router-fixture-client',
    },
  });
}

export async function nativeRouterStreamCompletion() {
  const late = deferred<string>();
  const { router, session } = await serializingRouter(late.promise);
  let cleanup = 0;
  router.serverSsr!.onCleanup(() => {
    cleanup++;
  });
  const response = await renderSerializingRouter(router, session);
  const html = response.text();
  late.resolve('late native value');
  assert.match(await html, /late native value/);
  await session.completion;
  assert.equal(cleanup, 1);
  assert.equal(router.serverSsr, undefined);
}

export async function nativeRouterStreamPublishesDeferredData() {
  const late = deferred<string>();
  const { router, session } = await serializingRouter(late.promise);
  const response = await renderSerializingRouter(router, session);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let html = '';
  while (!html.includes('$_TSR')) {
    const next = await reader.read();
    assert.equal(next.done, false);
    html += decoder.decode(next.value, { stream: true });
  }
  assert.ok(!html.includes('streamed after shell'));
  late.resolve('streamed after shell');
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    html += decoder.decode(next.value, { stream: true });
  }
  html += decoder.decode();
  assert.match(html, /streamed after shell/);
  await session.completion;
}

export async function nativeRouterStreamKeepsBootstrapForScripts() {
  const late = deferred<string>();
  const { router, session } = await serializingRouter(late.promise);
  const response = await renderSerializingRouter(router, session);
  late.resolve('settled');
  const html = await response.text();
  assert.match(html, /\$_TSR/);
  assert.match(html, /settled/);
  await session.completion;
}

export async function nativeRouterStreamTimeoutAndAbort() {
  const timeoutMs = 15;
  rs.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    for (const disposition of ['timeout', 'abort'] as const) {
      const { router, session } = await serializingRouter(
        new Promise(() => {}),
      );
      const rendered = deferred<void>();
      router.serverSsr!.onRenderFinished(() => rendered.resolve());
      let cleanup = 0;
      router.serverSsr!.onCleanup(() => {
        cleanup++;
      });
      const response = await renderSerializingRouter(
        router,
        session,
        timeoutMs,
      );
      const completion = response.text().then(
        () => assert.fail('Pending serialization completed'),
        error => error,
      );
      if (disposition === 'timeout') {
        // The lifetime timer starts at stream creation; the serialization
        // timer starts only at application EOF. Do not let scheduling decide
        // which timer wins on a loaded runner.
        await Promise.race([
          rendered.promise,
          completion.then(error => {
            throw error;
          }),
        ]);
        await rs.advanceTimersByTimeAsync(timeoutMs);
      } else {
        await session.abort(
          new DOMException('Client disconnected', 'AbortError'),
        );
      }
      assert.match(
        String(await completion),
        disposition === 'timeout' ? /timeout/i : /Client disconnected/,
      );
      assert.equal(
        (await session.completion).state,
        disposition === 'timeout' ? 'failed' : 'aborted',
      );
      await session.abort('again');
      assert.equal(cleanup, 1);
      assert.equal(router.serverSsr, undefined);
    }
  } finally {
    rs.useRealTimers();
  }
}

export async function nativeRouterDocumentStream() {
  const session = requestSession();
  const tree = createFileSystemRouteTree(
    [descriptor('home', { index: true })],
    {
      home: {
        component: () => ssrHtml('<main>Native filesystem application</main>'),
      },
    },
  );
  const router = createRouter({
    routeTree: tree,
    isServer: true,
    ssr: { nonce: 'router-nonce' },
  });
  let cleanup = 0;
  const response = await createRequestHandler({
    request: session.request,
    createRouter: () => router,
  })(async ({ router }) => {
    router.serverSsr!.onCleanup(() => {
      cleanup++;
    });
    const response = await renderOctaneApplication({
      session,
      App: RouterServer,
      props: { router },
      router,
      document: {
        documentId: 'router-document',
        nativeHydrationBuildId: 'native-router-fixture-client',
        nonce: 'router-nonce',
      },
    });
    const transferred = createSsrStreamResponse(router, response);
    assert.equal(transferred.response, response);
    assert.equal(transferred.response.body, response.body);
    return transferred;
  });
  assert.equal(cleanup, 0);
  const html = await response.text();
  assert.match(html, /Native filesystem application/);
  // The bootstrap renders in the root's barrier script, which the client
  // hydrates in place.
  assert.match(
    html,
    /<script\b[^>]*data-tsr-stream-part[^>]*>[^<]*\$_TSR\.router=/,
  );
  assert.equal(html.match(/<!doctype html>/gi)?.length, 1);
  assert.equal(html.match(/<html[\s>]/gi)?.length, 1);
  // Under a nonce CSP every executable script, including the $_TSR bootstrap
  // injected through router.options.ssr.nonce, must carry the request nonce.
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  assert.ok(scripts.length > 0);
  assert.match(
    html,
    /<script\b[^>]*nonce=["']router-nonce["'][^>]*>[^<]*\$_TSR/,
  );
  for (const tag of scripts) assert.match(tag, /nonce=["']router-nonce["']/);
  assert.equal((await session.completion).state, 'completed');
  assert.equal(cleanup, 1);
}

async function renderRouteErrorDocument(
  modules: Parameters<typeof createFileSystemRouteTree>[1],
) {
  const session = requestSession();
  const tree = createFileSystemRouteTree(
    [
      descriptor('layout', {
        isRoot: true,
        children: [
          descriptor('home', {
            index: true,
            modules: { data: '/home.data.ts' },
          }),
        ],
      }),
    ],
    {
      ...modules,
      layout: {
        ...modules.layout,
        component: () =>
          createElement('main', { 'data-layout': 'native' }, [
            createElement('nav', null, 'Native layout'),
            createElement(Outlet),
          ]),
      },
    },
    {
      request: session.request,
      loadRoute: async () => ({
        kind: 'error',
        error: { name: 'Error', message: 'Native loader failure' },
        response: metadata(500),
      }),
    },
  );
  const router = createRouter({ routeTree: tree, isServer: true });
  let statusCode: number | undefined;
  const response = await createRequestHandler({
    request: session.request,
    createRouter: () => router,
  })(async ({ router }) => {
    statusCode = getSsrStatus(router);
    return createSsrStreamResponse(
      router,
      await renderOctaneApplication({
        session,
        App: RouterServer,
        props: { router },
        router,
        document: {
          documentId: 'route-error-document',
          nativeHydrationBuildId: 'native-router-fixture-client',
        },
      }),
    );
  });
  const html = await response.text();
  await session.completion;
  return { html, statusCode };
}

export async function nativeRouteErrorDocument() {
  // Without an authored error.tsx the native error UI replaces only the failing
  // route; the layout stays server-rendered instead of a client-recovered hole.
  const fallback = await renderRouteErrorDocument({});
  assert.equal(fallback.statusCode, 500);
  assert.match(fallback.html, /data-layout="native">[\s\S]*Native layout/);
  assert.match(fallback.html, /Something went wrong!/);
  assert.match(fallback.html, /Native loader failure/);

  const authoredError: ErrorRouteComponent = ({ error }) =>
    createElement('section', { 'data-route-error': 'authored' }, error.message);
  const authored = await renderRouteErrorDocument({
    home: { errorComponent: authoredError },
  });
  assert.equal(authored.statusCode, 500);
  assert.match(
    authored.html,
    /Native layout<\/nav>[\s\S]*data-route-error="authored">[\s\S]*Native loader failure/,
  );
  assert.doesNotMatch(authored.html, /Something went wrong!/);

  // An ancestor error.tsx keeps owning its descendants' failures.
  const inherited = await renderRouteErrorDocument({
    layout: { errorComponent: authoredError },
  });
  assert.equal(inherited.statusCode, 500);
  assert.match(
    inherited.html,
    /Native layout<\/nav>[\s\S]*data-route-error="authored">[\s\S]*Native loader failure/,
  );
  assert.doesNotMatch(inherited.html, /Something went wrong!/);
}

export async function nativeRouteActionContracts() {
  let loads = 0;
  const tree = createFileSystemRouteTree(
    [
      descriptor('home', { index: true, modules: { data: '/home.data.ts' } }),
      descriptor('complete', { path: 'complete' }),
    ],
    {},
    {
      request: new Request('https://native.test/'),
      loadRoute: async () => {
        loads++;
        return success({ loads });
      },
    },
  );
  const router = createRouter({
    routeTree: tree,
    isServer: true,
    origin: 'https://native.test',
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  let outcome = success({ saved: true });
  const requests: Request[] = [];
  const action = createOctaneRouteAction({
    router,
    routeId: 'home',
    identity,
    fetch: async input => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      return createDataResponse(outcome, identity, {
        routeId: 'home',
        operation: 'action',
      });
    },
  });
  const form = new FormData();
  form.set('sku', 'tractor');
  assert.equal((await action(undefined, form)).kind, 'success');
  assert.equal(loads, 2);
  assert.equal(requests[0]?.method, 'POST');
  assert.equal((await requests[0]!.formData()).get('sku'), 'tractor');
  outcome = {
    kind: 'error',
    error: { name: 'ValidationError', message: 'Check SKU' },
    data: { sku: 'unknown' },
    thrown: false,
    response: metadata(422),
  };
  const validation = await action(undefined, form);
  assert.equal(validation.kind, 'error');
  assert.equal(validation.status, 422);
  const beforeThrown = loads;
  outcome = {
    kind: 'error',
    error: { name: 'Failure', message: 'Failed save' },
    thrown: true,
    response: metadata(500),
  };
  await assert.rejects(action(undefined, form), /Failed save/);
  assert.equal(loads, beforeThrown);
  outcome = {
    kind: 'redirect',
    location: '/complete',
    response: metadata(303),
  };
  const navigate = rs.spyOn(router, 'navigate').mockResolvedValue(undefined);
  assert.equal((await action(undefined, form)).kind, 'redirect');
  assert.equal(navigate.mock.calls[0]?.[0].href, '/complete');
  navigate.mockRestore();
}

export async function nativeRouterDocumentCancellation() {
  const session = requestSession();
  const request = new Request(session.request, { signal: session.signal });
  const late = deferred<string>();
  let producerAborted = false;
  const tree = createFileSystemRouteTree(
    [descriptor('home', { index: true, modules: { data: '/home.data.ts' } })],
    { home: { component: () => ssrHtml('<main>Early native shell</main>') } },
    {
      request,
      loadRoute: async (_route, input) => {
        input.request.signal.addEventListener(
          'abort',
          () => {
            producerAborted = true;
            late.resolve('aborted producer');
          },
          { once: true },
        );
        return {
          kind: 'deferred',
          critical: { early: 'available' },
          deferred: { late: late.promise },
          response: metadata(),
        };
      },
    },
  );
  const router = createRouter({ routeTree: tree, isServer: true });
  let cleanup = 0;
  const response = await createRequestHandler({
    request,
    createRouter: () => router,
  })(async ({ router }) => {
    router.serverSsr!.onCleanup(() => {
      cleanup++;
    });
    const response = await renderOctaneApplication({
      session,
      App: RouterServer,
      props: { router },
      router,
      document: {
        documentId: 'cancelled-router-document',
        nativeHydrationBuildId: 'native-router-fixture-client',
      },
    });
    return createSsrStreamResponse(router, response);
  });
  const reader = response.body!.getReader();
  await reader.read();
  const shell = new TextDecoder().decode((await reader.read()).value);
  assert.match(shell, /Early native shell/);
  assert.equal(producerAborted, false);
  await reader.cancel('Client disconnected');
  assert.equal(producerAborted, true);
  assert.equal(request.signal.aborted, true);
  assert.equal((await session.completion).state, 'aborted');
  assert.equal((await session.completion).cacheEligible, false);
  assert.equal(cleanup, 1);
}
