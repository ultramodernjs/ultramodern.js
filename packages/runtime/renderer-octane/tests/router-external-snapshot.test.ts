import {
  createNativeI18n,
  createNativeI18nInstance,
} from '@modern-js/i18n-runtime-extensions/native';
import {
  createNativeRouter,
  type NativeLocationRewrite,
  type NativeRoutedApplication,
} from '@modern-js/renderer-core/router';
import {
  type AnyRouter,
  associateRouterRenderProfile,
  createRouterRenderRouteTree,
  disposeRouterRenderSnapshot,
  getRouterRenderProfile,
  matchContext,
  registerRouterRenderProfile,
  restoreRouterRenderSnapshot,
  routerContext,
} from '@octanejs/tanstack-router';
import * as nativeHistory from '@octanejs/tanstack-router/history';
import { afterEach, describe, expect, rs, test } from '@rstest/core';
import {
  createElement,
  type ExternalSnapshotRequest,
  externalSnapshotBoundary,
  prepareExternalSnapshotRequest,
  releasePreparedExternalSnapshotRequest,
  renderExternalSnapshot,
  renderToStaticMarkup,
  Suspense,
  serializeExternalSnapshotRequest,
  useContext,
} from 'octane/server';
import { prerender } from 'octane/static';
import { octaneRouterFactory } from '../src/entry-application';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { registerOctaneI18nWorkerContexts } from '../src/i18n-external-snapshot';
import { useApplicationIdentity } from '../src/router';
import {
  captureOctaneRouterSnapshot,
  OCTANE_FILE_ROUTE_SNAPSHOT_PROFILE,
  registerOctaneRouterWorkerContexts,
} from '../src/router-external-snapshot';
import {
  OCTANE_WORKER_CONTEXT_KEYS,
  useOctaneWorkerContextKeys,
} from '../src/worker-federation-contexts';

const identity = {
  renderer: 'octane',
  appId: 'catalog-host',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'host-logical-build',
} as const;
const publicContext = { ultramodern: { rendererIdentity: identity } };
const hosts = new Set<AnyRouter>();
const restoredRouters = new Set<AnyRouter>();
const releases: Array<() => void> = [];
let profileSequence = 0;

afterEach(() => {
  for (const router of restoredRouters) disposeRouterRenderSnapshot(router);
  for (const router of hosts) {
    router.cancelMatches();
    router.history.destroy();
  }
  for (const release of releases.splice(0).reverse()) release();
  hosts.clear();
  restoredRouters.clear();
  rs.restoreAllMocks();
});

function fixture(
  options: {
    path?: string;
    rewrite?: NativeLocationRewrite;
    validateSearch?: (
      search: Record<string, unknown>,
    ) => Record<string, unknown>;
  } = {},
) {
  const privateContext = { credential: 'HOST_PRIVATE_CREDENTIAL' };
  const loaderInputs: Array<{
    routeId: string;
    context: unknown;
    url: string;
  }> = [];
  const application: NativeRoutedApplication = {
    basePath: '/app',
    routeIR: [
      {
        id: 'product',
        path: 'products/:id',
        modules: { data: 'product.data.ts' },
        children: [],
      },
      { id: 'about', path: 'about', children: [] },
    ],
    routeModules: options.validateSearch
      ? { product: { search: { validateSearch: options.validateSearch } } }
      : {},
    dataModules: {},
  };
  const router = createNativeRouter(
    application,
    {
      identity,
      request: new Request(
        `https://catalog.test${options.path ?? '/app/products/7?sort=price#details'}`,
      ),
      context: privateContext,
      ...(options.rewrite ? { rewrite: options.rewrite } : {}),
      async loadRoute(route, input) {
        loaderInputs.push({
          routeId: route.id,
          context: input.context,
          url: input.request.url,
        });
        return {
          kind: 'success',
          value: { id: input.params.id, title: 'Actual host loader data' },
          response: {
            status: 200,
            statusText: 'OK',
            headers: [],
            cachePolicy: 'no-store',
          },
        };
      },
    },
    octaneRouterFactory,
  );
  hosts.add(router);
  return { router, privateContext, loaderInputs };
}

async function restore(value: unknown) {
  const router = await restoreRouterRenderSnapshot(value);
  restoredRouters.add(router);
  return router;
}

function matches(router: AnyRouter) {
  return router.state.matches.map(
    ({ id, routeId, params, search, loaderData }) => ({
      id,
      routeId,
      params,
      search,
      loaderData,
    }),
  );
}

function provideRouter(router: AnyRouter, child: unknown, nearest = false) {
  const match = router.state.matches.at(-1);
  if (!match) throw new Error('Expected a genuinely loaded native route');
  return createElement(routerContext, {
    value: router,
    children: nearest
      ? createElement(matchContext, { value: match.id, children: child })
      : child,
  });
}

function IdentityConsumer() {
  const logical = useApplicationIdentity();
  return createElement('p', {
    children: `${logical.appId}:${logical.entryName}:${logical.buildId}`,
  });
}

function selectedKeys(
  router?: AnyRouter,
  nearest = false,
  explicit: readonly string[] = [],
) {
  let result: readonly string[] | undefined;
  function Consumer() {
    result = useOctaneWorkerContextKeys(explicit);
    return createElement('p', { children: result.join('|') });
  }
  const child = createElement(Consumer);
  renderToStaticMarkup(() =>
    router ? provideRouter(router, child, nearest) : child,
  );
  if (!result) throw new Error('The native consumer did not render');
  return result;
}

function nativeI18n() {
  return createNativeI18n(
    {
      languages: ['en', 'cs'],
      fallbackLanguage: 'en',
      localisedUrls: {
        '/products/:id': { en: '/products/:id', cs: '/produkty/:id' },
      },
    },
    {},
  );
}

describe('generated Octane router Worker snapshots', () => {
  test('restores host logical identity and public loader data without private handler input or loader replay', async () => {
    const host = fixture();
    await host.router.load();
    expect(host.loaderInputs).toEqual([
      {
        routeId: 'product',
        context: host.privateContext,
        url: 'https://catalog.test/app/products/7?sort=price#details',
      },
    ]);
    const snapshot = captureOctaneRouterSnapshot(host.router);
    expect(snapshot.profile).toEqual(OCTANE_FILE_ROUTE_SNAPSHOT_PROFILE);
    expect(snapshot.publicContext).toEqual(publicContext);
    expect(JSON.stringify(snapshot)).not.toContain('HOST_PRIVATE_CREDENTIAL');
    const restored = await restore(JSON.parse(JSON.stringify(snapshot)));
    expect(matches(restored)).toEqual(matches(host.router));
    expect(restored.state.matches.at(-1)?.loaderData).toEqual({
      id: '7',
      title: 'Actual host loader data',
    });
    expect(restored.options.context).toEqual(publicContext);
    expect(restored.state.location.publicHref).toBe(
      host.router.state.location.publicHref,
    );
    const html = renderToStaticMarkup(() =>
      provideRouter(restored, createElement(IdentityConsumer)),
    ).html;
    expect(html).toContain('catalog-host:main:host-logical-build');
    expect(host.loaderInputs).toHaveLength(1);
  });

  test('native publisher authority stays separate from the consumer host logical identity', async () => {
    releases.push(registerOctaneRouterWorkerContexts());
    const host = fixture();
    await host.router.load();
    const authority = {
      publisherBuildId: 'remote-native-producer-build',
      runtimeABI: 1,
    } as const;
    const sent: ExternalSnapshotRequest[] = [];
    const observed: Array<{ appId: string; buildId: string; matchId: string }> =
      [];
    function RemoteConsumer() {
      const logical = useApplicationIdentity();
      const router = useContext(routerContext);
      const matchId = useContext(matchContext);
      if (!router || !matchId)
        throw new Error('Missing actual native contexts');
      observed.push({
        appId: logical.appId,
        buildId: logical.buildId,
        matchId,
      });
      expect(router.options.context).toEqual(publicContext);
      expect(router.state.matches.at(-1)?.loaderData).toEqual({
        id: '7',
        title: 'Actual host loader data',
      });
      return createElement(IdentityConsumer);
    }
    const Remote = externalSnapshotBoundary({
      authority,
      component: RemoteConsumer,
      contextKeys: [
        OCTANE_WORKER_CONTEXT_KEYS.router,
        OCTANE_WORKER_CONTEXT_KEYS.match,
      ],
      snapshot(request, signal) {
        sent.push(request);
        return renderExternalSnapshot(RemoteConsumer, request, {
          authority,
          signal,
        });
      },
    });
    const result = await prerender(
      () =>
        provideRouter(
          host.router,
          createElement(Suspense, {
            fallback: createElement('p', { children: 'remote pending' }),
            children: createElement(Remote),
          }),
          true,
        ),
      {},
      { externalSnapshots: { documentId: 'logical-host-document' } },
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.authority).toEqual(authority);
      expect(request.contexts.map(({ key }) => key)).toEqual([
        OCTANE_WORKER_CONTEXT_KEYS.router,
        OCTANE_WORKER_CONTEXT_KEYS.match,
      ]);
    }
    expect(observed.length).toBeGreaterThan(0);
    for (const value of observed)
      expect(value).toEqual({
        appId: identity.appId,
        buildId: identity.buildId,
        matchId: host.router.state.matches.at(-1)?.id,
      });
    expect(result.html).toContain('catalog-host:main:host-logical-build');
    expect(host.loaderInputs).toHaveLength(1);
  });

  test('rejects generated identity replaced with a producer identity through public router.update', async () => {
    const host = fixture();
    await host.router.load();
    host.router.update({
      context: {
        ultramodern: {
          rendererIdentity: {
            ...identity,
            buildId: 'remote-native-producer-build',
          },
        },
      },
    });
    expect(() => captureOctaneRouterSnapshot(host.router)).toThrow(
      'Generated Worker router origin changed',
    );
  });

  test('does not admit extra metadata into the default public identity', async () => {
    const host = fixture();
    await host.router.load();
    host.router.update({
      context: { ...publicContext, sessionToken: 'PRIVATE_TOKEN' },
    });
    expect(() => captureOctaneRouterSnapshot(host.router)).toThrow(
      'Unknown Worker router context field',
    );
  });

  test('requires a named profile for authored search validation after ordinary construction and load', async () => {
    const host = fixture({
      path: '/app/products/7?page=3',
      validateSearch: search => ({ page: Number(search.page ?? 1) }),
    });
    await host.router.load();
    expect(host.router.state.matches.at(-1)?.search).toEqual({ page: 3 });
    expect(host.loaderInputs).toHaveLength(1);
    expect(() => captureOctaneRouterSnapshot(host.router)).toThrow(
      'authored route behavior requires an exact local profile',
    );
  });

  test('keeps an explicitly associated native profile for custom routing instead of reassociating the default', async () => {
    const rewrite: NativeLocationRewrite = {
      input({ url }) {
        url.pathname = url.pathname.replace('/public/', '/products/');
      },
      output({ url }) {
        url.pathname = url.pathname.replace('/products/', '/public/');
      },
    };
    const host = fixture({ path: '/app/public/7?sort=price', rewrite });
    await host.router.load();
    expect(host.router.state.matches.at(-1)?.params).toEqual({ id: '7' });
    expect(() => captureOctaneRouterSnapshot(host.router)).toThrow(
      'Custom router rewrite requires an exact Worker profile',
    );
    const profile = {
      key: `test.modern.custom-routing.${++profileSequence}`,
      version: '1',
    };
    releases.push(
      registerRouterRenderProfile({
        id: profile,
        assertHost(router) {
          if (router.options.rewrite !== rewrite)
            throw new TypeError('Custom rewrite changed');
        },
        createRoutingTree: snapshot =>
          createRouterRenderRouteTree(snapshot.routes),
        routingOptions: () => ({ rewrite }),
      }),
    );
    associateRouterRenderProfile(host.router, { id: profile, publicContext });
    const snapshot = captureOctaneRouterSnapshot(host.router);
    expect(snapshot.profile).toEqual(profile);
    expect(getRouterRenderProfile(host.router)).toEqual(profile);
    const restored = await restore(snapshot);
    expect(matches(restored)).toEqual(matches(host.router));
    expect(
      restored.buildLocation({ to: '/products/$id', params: { id: '9' } })
        .publicHref,
    ).toBe('/app/public/9');
    expect(host.loaderInputs).toHaveLength(1);
  });

  test('rejects default restoration with unknown logical metadata', async () => {
    const host = fixture();
    await host.router.load();
    const snapshot = captureOctaneRouterSnapshot(host.router);
    await expect(
      restore({
        ...snapshot,
        publicContext: { ...publicContext, privateSession: 'UNEXPECTED' },
      }),
    ).rejects.toThrow('Unknown Worker router context field');
  });
});

describe('actual native Worker provider selection', () => {
  test('selects only present physical router and match providers and does not leak them into a later SSR root', async () => {
    releases.push(registerOctaneRouterWorkerContexts());
    const host = fixture();
    await host.router.load();
    expect(selectedKeys()).toEqual([]);
    expect(selectedKeys(host.router)).toEqual([
      OCTANE_WORKER_CONTEXT_KEYS.router,
    ]);
    expect(selectedKeys(host.router, true)).toEqual([
      OCTANE_WORKER_CONTEXT_KEYS.router,
      OCTANE_WORKER_CONTEXT_KEYS.match,
    ]);
    expect(selectedKeys()).toEqual([]);
  });

  test('preserves explicit required keys and duplicates for native admission', async () => {
    releases.push(registerOctaneRouterWorkerContexts());
    const host = fixture();
    await host.router.load();
    const explicit = ['application.theme', OCTANE_WORKER_CONTEXT_KEYS.router];
    expect(selectedKeys(host.router, true, explicit)).toEqual([
      OCTANE_WORKER_CONTEXT_KEYS.match,
      ...explicit,
    ]);
    const duplicate = [
      OCTANE_WORKER_CONTEXT_KEYS.router,
      OCTANE_WORKER_CONTEXT_KEYS.router,
    ];
    expect(selectedKeys(host.router, true, duplicate)).toEqual([
      OCTANE_WORKER_CONTEXT_KEYS.match,
      ...duplicate,
    ]);
    expect(selectedKeys(undefined, false, ['missing.required'])).toEqual([
      'missing.required',
    ]);
  });

  test('selects i18n only through its actual native provider with a genuine instance', async () => {
    releases.push(registerOctaneRouterWorkerContexts());
    releases.push(registerOctaneI18nWorkerContexts());
    const host = fixture();
    await host.router.load();
    const instance = createNativeI18nInstance({
      lng: 'cs',
      resources: { cs: { translation: { hello: 'Ahoj' } } },
    });
    let selected: readonly string[] | undefined;
    function Consumer() {
      selected = useOctaneWorkerContextKeys();
      return createElement('p', { children: instance.t('hello') });
    }
    const result = renderToStaticMarkup(() =>
      provideRouter(
        host.router,
        createElement(I18nProvider, {
          instance,
          languages: ['en', 'cs'],
          children: createElement(Consumer),
        }),
        true,
      ),
    );
    expect(result.html).toContain('Ahoj');
    expect(selected).toEqual([
      OCTANE_WORKER_CONTEXT_KEYS.router,
      OCTANE_WORKER_CONTEXT_KEYS.match,
      OCTANE_WORKER_CONTEXT_KEYS.i18n,
    ]);
    expect(selectedKeys(host.router, true)).toEqual([
      OCTANE_WORKER_CONTEXT_KEYS.router,
      OCTANE_WORKER_CONTEXT_KEYS.match,
    ]);
  });
});

describe('native selected match admission before expose loading', () => {
  test.each([
    { kind: 'unknown selected match', router: true, match: true, valid: false },
    {
      kind: 'selected match without router',
      router: false,
      match: true,
      valid: false,
    },
    { kind: 'selected router only', router: true, match: false, valid: true },
    { kind: 'real selected match', router: true, match: true, valid: true },
  ])('$kind', async scenario => {
    releases.push(registerOctaneRouterWorkerContexts());
    const host = fixture();
    await host.router.load();
    const hostMatch = host.router.state.matches.at(-1);
    if (!hostMatch) throw new Error('Expected a genuinely loaded native match');
    const matchId =
      scenario.kind === 'unknown selected match'
        ? 'UNKNOWN_NATIVE_MATCH'
        : hostMatch.id;
    const keys = [
      ...(scenario.router ? [OCTANE_WORKER_CONTEXT_KEYS.router] : []),
      ...(scenario.match ? [OCTANE_WORKER_CONTEXT_KEYS.match] : []),
    ];
    const authority = {
      publisherBuildId: 'selected-context-publisher',
      runtimeABI: 1,
    } as const;
    const admitted: ExternalSnapshotRequest[] = [];
    const failures: unknown[] = [];
    const diagnostics: unknown[] = [];
    const historyDisposals: Array<() => number> = [];
    const actualCreateHistory = nativeHistory.createMemoryHistory;
    rs.spyOn(nativeHistory, 'createMemoryHistory').mockImplementation(
      options => {
        const history = actualCreateHistory(options);
        const destroy = rs.spyOn(history, 'destroy');
        historyDisposals.push(() => destroy.mock.calls.length);
        return history;
      },
    );
    function Exposed() {
      const router = useContext(routerContext);
      if (!router)
        throw new Error('Missing actual reconstructed native router');
      expect(matches(router)).toEqual(matches(host.router));
      if (scenario.match) expect(useContext(matchContext)).toBe(hostMatch.id);
      return createElement(IdentityConsumer);
    }
    const expose = {
      async load() {
        // This real module import belongs after native request admission.
        await import('../src/router');
        return { default: Exposed };
      },
    };
    const load = rs.spyOn(expose, 'load');
    const Remote = externalSnapshotBoundary({
      authority,
      component: Exposed,
      contextKeys: keys,
      async snapshot(request, signal) {
        admitted.push(request);
        try {
          const prepared = await prepareExternalSnapshotRequest(
            serializeExternalSnapshotRequest(request),
            { authority, signal },
          );
          try {
            const module = await expose.load();
            return await renderExternalSnapshot(module.default, prepared);
          } finally {
            await releasePreparedExternalSnapshotRequest(prepared);
          }
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
    });
    const result = await prerender(
      () => {
        let child = createElement(Suspense, {
          fallback: createElement('p', {
            children: 'native admission rejected',
          }),
          children: createElement(Remote),
        });
        if (scenario.match)
          child = createElement(matchContext, {
            value: matchId,
            children: child,
          });
        if (scenario.router)
          child = createElement(routerContext, {
            value: host.router,
            children: child,
          });
        return child;
      },
      {},
      {
        externalSnapshots: { documentId: `admission-${scenario.kind}` },
        onError: error => diagnostics.push(error),
      },
    );
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.contexts.map(({ key }) => key)).toEqual(keys);
    if (scenario.valid) {
      expect(failures).toEqual([]);
      expect(diagnostics).toEqual([]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(result.html).toContain('catalog-host:main:host-logical-build');
    } else {
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        message:
          'Worker match context requires its selected native router and a current match',
      });
      expect(load).not.toHaveBeenCalled();
      expect(result.html).toContain('native admission rejected');
    }
    expect(historyDisposals).toHaveLength(scenario.router ? 1 : 0);
    for (const countDisposals of historyDisposals)
      expect(countDisposals()).toBe(1);
    expect(host.loaderInputs).toHaveLength(1);
  });
});

describe('optional owning native i18n rewrite bridge', () => {
  test('allows ordinary localized router construction without the Worker codec but rejects snapshot admission', async () => {
    const native = nativeI18n();
    const host = fixture({
      path: '/app/cs/produkty/7?sort=price',
      rewrite: native.rewrite(() => 'cs'),
    });
    await host.router.load();
    expect(host.router.state.matches.at(-1)?.params).toEqual({ id: '7' });
    expect(host.loaderInputs).toHaveLength(1);
    expect(() => captureOctaneRouterSnapshot(host.router)).toThrow(
      'Custom router rewrite requires an exact Worker profile',
    );
  });

  test('restores actual mapped routing only while its owning native i18n codec is registered', async () => {
    const unregister = registerOctaneI18nWorkerContexts();
    releases.push(unregister);
    const native = nativeI18n();
    const host = fixture({
      path: '/app/cs/produkty/7?sort=price#details',
      rewrite: native.rewrite(() => 'cs'),
    });
    await host.router.load();
    const snapshot = captureOctaneRouterSnapshot(host.router);
    expect(snapshot.i18n).toEqual({
      language: 'cs',
      languages: ['en', 'cs'],
      localisedUrls: native.localisedUrls,
    });
    const restored = await restore(snapshot);
    expect(matches(restored)).toEqual(matches(host.router));
    expect(restored.state.location.publicHref).toBe(
      '/app/cs/produkty/7?sort=price#details',
    );
    expect(
      restored.buildLocation({ to: '/products/$id', params: { id: '9' } })
        .publicHref,
    ).toBe('/app/cs/produkty/9');
    expect(host.loaderInputs).toHaveLength(1);
    unregister();
    await expect(restore(snapshot)).rejects.toThrow(
      'Missing owning Worker router i18n codec',
    );
  });

  test('captures the current language from genuine rewrite provenance on every admission', async () => {
    releases.push(registerOctaneI18nWorkerContexts());
    const native = nativeI18n();
    let language = 'cs';
    const host = fixture({
      path: '/app/cs/produkty/7',
      rewrite: native.rewrite(() => language),
    });
    await host.router.load();
    expect(captureOctaneRouterSnapshot(host.router).i18n?.language).toBe('cs');
    language = 'en';
    const snapshot = captureOctaneRouterSnapshot(host.router);
    expect(snapshot.i18n?.language).toBe('en');
    const restored = await restore(snapshot);
    expect(
      restored.buildLocation({ to: '/products/$id', params: { id: '9' } })
        .publicHref,
    ).toBe('/app/en/products/9');
    expect(host.loaderInputs).toHaveLength(1);
  });

  test('rejects replaced rewrite provenance through public router.update', async () => {
    releases.push(registerOctaneI18nWorkerContexts());
    const native = nativeI18n();
    const host = fixture({
      path: '/app/cs/produkty/7',
      rewrite: native.rewrite(() => 'cs'),
    });
    await host.router.load();
    host.router.update({ rewrite: native.rewrite(() => 'cs') });
    expect(() => captureOctaneRouterSnapshot(host.router)).toThrow(
      'Generated Worker router origin changed',
    );
  });
});
