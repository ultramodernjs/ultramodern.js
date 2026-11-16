import type {
  RouterRenderProfile,
  RouterRenderSnapshot,
} from '@octanejs/tanstack-router';
import {
  assertDefaultRouterRenderHost,
  associateRouterRenderProfile,
  captureRouterRenderSnapshot,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouteMask,
  createRouter,
  createRouterRenderRouteTree,
  disposeRouterRenderSnapshot,
  getRouterRenderProfile,
  Router,
  redirect,
  registerRouterRenderProfile,
  restoreRouterRenderSnapshot,
} from '@octanejs/tanstack-router';
import * as nativeHistory from '@octanejs/tanstack-router/history';
import { parseHref } from '@tanstack/history';
import type { AnyRoute, AnyRouter } from '@tanstack/router-core';
import {
  createControlledPromise,
  defaultParseSearch,
  defaultStringifySearch,
} from '@tanstack/router-core';
import {
  createRequestHandler,
  getSsrStatus,
} from '@tanstack/router-core/ssr/server';
import { renderToStaticMarkup } from 'octane/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouterRenderSnapshotSurface } from './router-render-snapshot.tsrx';

const hosts = new Set<AnyRouter>();
const restoredRouters = new Set<AnyRouter>();
const unregisterProfiles: Array<() => void> = [];
let profileSequence = 0;

afterEach(() => {
  for (const router of restoredRouters) disposeRouterRenderSnapshot(router);
  for (const router of hosts) {
    for (const match of router.state.matches) match.abortController.abort();
    router.history.destroy();
  }
  for (const unregister of unregisterProfiles) unregister();
  hosts.clear();
  restoredRouters.clear();
  unregisterProfiles.length = 0;
  vi.restoreAllMocks();
});

function defaultProfile(overrides: Partial<RouterRenderProfile> = {}) {
  const profile = {
    id: { key: `test.router-render.${++profileSequence}`, version: '1' },
    assertHost: (router: AnyRouter) => assertDefaultRouterRenderHost(router),
    createRoutingTree: (snapshot: RouterRenderSnapshot) =>
      createRouterRenderRouteTree(snapshot.routes),
    routingOptions: () => ({}),
    ...overrides,
  };
  const unregister = registerRouterRenderProfile(profile);
  unregisterProfiles.push(unregister);
  return { profile, unregister };
}

const publicContext = {
  ultramodern: {
    rendererIdentity: {
      renderer: 'octane',
      applicationName: 'catalog',
      shell: true,
    },
  },
};

function makeHost(initial: string, loaderCalls: string[] = []) {
  const root = createRootRoute({ staticData: { ultramodernRouteId: 'root' } });
  const shell = createRoute({ getParentRoute: () => root, id: '_shell' });
  const project = createRoute({
    getParentRoute: () => shell,
    path: 'projects/$project',
  });
  const projectIndex = createRoute({
    getParentRoute: () => project,
    path: '/',
  });
  const task = createRoute({
    getParentRoute: () => project,
    path: 'tasks/$task',
    staticData: { ultramodernRouteId: 'task' },
    loader: ({ params }) => {
      loaderCalls.push(params.task);
      return {
        title: 'Observed task',
        task: params.task,
        optional: null,
        tags: ['server', { completed: false }],
      };
    },
  });
  const files = createRoute({ getParentRoute: () => root, path: 'files/$' });
  const about = createRoute({ getParentRoute: () => root, path: 'about' });
  const index = createRoute({ getParentRoute: () => root, path: '/' });
  const history = createMemoryHistory({ initialEntries: [initial] });
  history.replace(initial, {
    request: 'request-42',
    preferences: { compact: false },
  });
  const router = createRouter({
    routeTree: root.addChildren([
      shell.addChildren([project.addChildren([projectIndex, task])]),
      files,
      about,
      index,
    ]),
    history,
    origin: 'https://catalog.example',
    basepath: '/app',
    isServer: true,
    context: {
      ...publicContext,
      privateSession: { token: 'host-only-secret' },
    },
  });
  hosts.add(router);
  return router;
}

async function loadedSnapshot(
  initial = '/app/projects/alpha/tasks/42?sort=desc#detail',
) {
  const { profile } = defaultProfile();
  const router = makeHost(initial);
  associateRouterRenderProfile(router, { id: profile.id, publicContext });
  await router.load();
  return { router, snapshot: captureRouterRenderSnapshot(router), profile };
}

async function restore(value: unknown, options?: { signal?: AbortSignal }) {
  const router = await restoreRouterRenderSnapshot(value, options);
  restoredRouters.add(router);
  return router;
}

function wireCopy(snapshot: RouterRenderSnapshot): RouterRenderSnapshot {
  return JSON.parse(JSON.stringify(snapshot));
}

function publicMatches(router: AnyRouter) {
  return router.state.matches.map(
    ({ id, routeId, params, search, loaderData, loaderDeps }) => ({
      id,
      routeId,
      params,
      search,
      loaderData,
      loaderDeps,
    }),
  );
}

describe('native router context across server render boundaries', () => {
  it('rebuilds interleaved route descriptors with their parent, order and static identity', () => {
    const tree = createRouterRenderRouteTree([
      {
        routeId: 'detail',
        parentRouteId: 'layout',
        path: 'detail',
        ultramodernRouteId: 'detail',
      },
      { routeId: 'about', parentRouteId: 'root', path: 'about' },
      { routeId: 'root', parentRouteId: null, ultramodernRouteId: 'root' },
      { routeId: 'index', parentRouteId: 'layout', path: '/' },
      { routeId: 'layout', parentRouteId: 'root', pathlessId: '_layout' },
    ]);
    const history = createMemoryHistory({ initialEntries: ['/detail'] });
    const router = createRouter({ routeTree: tree, history, isServer: true });
    hosts.add(router);
    const [about, layout] = tree.children ?? [];
    const [detail, index] = layout.children ?? [];

    expect(tree.options.staticData).toEqual({ ultramodernRouteId: 'root' });
    expect(about.path).toBe('about');
    expect(layout.id).toBe('/_layout');
    expect(layout.parentRoute).toBe(tree);
    expect(detail.path).toBe('detail');
    expect(detail.parentRoute).toBe(layout);
    expect(detail.options.staticData).toEqual({ ultramodernRouteId: 'detail' });
    expect(index.path).toBe('/');
    expect(index.parentRoute).toBe(layout);
  });

  it('rebuilds a 4096-route snapshot without dropping or reordering siblings', () => {
    const leaves = Array.from({ length: 4095 }, (_, index) => ({
      routeId: `route-${index}`,
      parentRouteId: 'root',
      path: `route-${index}`,
    }));
    const tree = createRouterRenderRouteTree([
      ...leaves,
      { routeId: 'root', parentRouteId: null },
    ]);

    expect(
      tree.children?.map((route: AnyRoute) =>
        'path' in route.options ? route.options.path : undefined,
      ),
    ).toEqual(leaves.map(route => route.path));
    expect(
      tree.children?.every(
        (route: AnyRoute) => route.options.getParentRoute?.() === tree,
      ),
    ).toBe(true);
  });

  it('restores native state, loader values, hooks and links without rerunning host loaders', async () => {
    const { profile } = defaultProfile();
    const calls: string[] = [];
    const host = makeHost(
      '/app/projects/alpha/tasks/42?sort=desc#detail',
      calls,
    );
    associateRouterRenderProfile(host, { id: profile.id, publicContext });
    await host.load();
    const snapshot = captureRouterRenderSnapshot(host);
    const beforeRestore = [...calls];
    const restored = await restore(wireCopy(snapshot));

    expect(restored).toBeInstanceOf(Router);
    expect(restored.isServer).toBe(true);
    expect(calls).toEqual(beforeRestore);
    expect(calls).toEqual(['42']);
    expect(publicMatches(restored)).toEqual(publicMatches(host));
    expect(restored.state.location).toMatchObject({
      pathname: host.state.location.pathname,
      search: { sort: 'desc' },
      searchStr: '?sort=desc',
      hash: 'detail',
      publicHref: snapshot.routing.publicHref,
      state: { request: 'request-42', preferences: { compact: false } },
    });
    expect(snapshot.routing.basepath).toBe('/app');
    expect(snapshot.routing.origin).toBe('https://catalog.example');
    expect(snapshot.publicContext).toEqual(publicContext);
    expect(JSON.stringify(snapshot)).not.toContain('host-only-secret');
    for (const match of restored.state.matches) {
      expect(match.context).toEqual(publicContext);
    }

    const hostHtml = renderToStaticMarkup(RouterRenderSnapshotSurface, {
      router: host,
      to: '/about',
    }).html;
    const restoredHtml = renderToStaticMarkup(RouterRenderSnapshotSurface, {
      router: restored,
      to: '/about',
    }).html;
    expect(restoredHtml).toBe(hostHtml);
    expect(restoredHtml).toContain('Observed task');
    expect(restoredHtml).toContain('data-loading="false"');
    expect(restoredHtml).toContain('href="/app/about"');
    expect(restoredHtml).toContain(
      `data-pathname="${host.state.location.pathname}"`,
    );
  });

  it('preserves native matches and loader values through a second server render boundary', async () => {
    const { profile } = defaultProfile();
    const loaderCalls: string[] = [];
    const host = makeHost(
      '/app/projects/alpha/tasks/42?sort=desc#detail',
      loaderCalls,
    );
    associateRouterRenderProfile(host, { id: profile.id, publicContext });
    await host.load();
    const snapshot = captureRouterRenderSnapshot(host);
    const first = await restore(wireCopy(snapshot));
    const recaptured = captureRouterRenderSnapshot(first);
    const second = await restore(wireCopy(recaptured));

    expect(recaptured).toEqual(snapshot);
    expect(publicMatches(first)).toEqual(publicMatches(host));
    expect(publicMatches(second)).toEqual(publicMatches(host));
    expect(second.state.matches.at(-1)).toMatchObject({
      id: host.state.matches.at(-1)?.id,
      routeId: host.state.matches.at(-1)?.routeId,
      params: { project: 'alpha', task: '42' },
      search: { sort: 'desc' },
      loaderData: {
        title: 'Observed task',
        task: '42',
        optional: null,
        tags: ['server', { completed: false }],
      },
    });
    expect(loaderCalls).toEqual(['42']);
    expect(
      renderToStaticMarkup(RouterRenderSnapshotSurface, {
        router: second,
        to: '/about',
      }).html,
    ).toBe(
      renderToStaticMarkup(RouterRenderSnapshotSurface, {
        router: host,
        to: '/about',
      }).html,
    );
  });

  it.each([
    ['/app/', {}],
    ['/app/projects/alpha', { project: 'alpha' }],
    ['/app/projects/alpha/tasks/42', { project: 'alpha', task: '42' }],
    ['/app/files/manuals/start.md', { _splat: 'manuals/start.md' }],
  ])(
    'preserves native root, pathless, index, parameter and splat matching at %s',
    async (initial, params) => {
      const { router: host, snapshot } = await loadedSnapshot(initial);
      const restored = await restore(wireCopy(snapshot));
      expect(publicMatches(restored)).toEqual(publicMatches(host));
      expect(restored.state.matches.at(-1)?.params).toMatchObject(params);
      expect(restored.buildLocation({ to: '/about' }).publicHref).toBe(
        host.buildLocation({ to: '/about' }).publicHref,
      );
    },
  );

  it('renders native active link state from the restored location', async () => {
    const { snapshot } = await loadedSnapshot('/app/about');
    const restored = await restore(wireCopy(snapshot));
    const { html } = renderToStaticMarkup(RouterRenderSnapshotSurface, {
      router: restored,
      to: '/about',
    });
    expect(html).toContain('href="/app/about"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-status="active"');
  });

  it('preserves the physical host and its declared profile across render and disposal', async () => {
    const {
      router: host,
      snapshot,
      profile,
    } = await loadedSnapshot('/app/about');
    const history = host.history;
    const tree = host.routeTree;
    const matches = [...host.state.matches];
    const restored = await restore(wireCopy(snapshot));
    expect(getRouterRenderProfile(host)).toEqual(profile.id);
    expect(getRouterRenderProfile(restored)).toEqual(profile.id);
    expect(restored).not.toBe(host);
    expect(restored.history).not.toBe(history);
    renderToStaticMarkup(RouterRenderSnapshotSurface, {
      router: restored,
      to: '/about',
    });
    disposeRouterRenderSnapshot(restored);
    expect(getRouterRenderProfile(restored)).toBeUndefined();
    expect(host.history).toBe(history);
    expect(host.routeTree).toBe(tree);
    expect(host.state.matches).toEqual(matches);
    for (let i = 0; i < matches.length; i++)
      expect(host.state.matches[i]).toBe(matches[i]);
    expect(captureRouterRenderSnapshot(host)).toEqual(snapshot);
  });

  it('restores the internal route behind a distinct public mask across nested render boundaries', async () => {
    const calls: string[] = [];
    const root = createRootRoute();
    const routeTree = root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/' }),
      createRoute({
        getParentRoute: () => root,
        path: 'items/$itemId',
        loader: ({ params }) => {
          calls.push(params.itemId);
          return { title: 'Private route contents' };
        },
      }),
      createRoute({ getParentRoute: () => root, path: 'preview/$itemId' }),
    ]);
    const routeMasks = [
      createRouteMask({
        routeTree,
        from: '/items/$itemId',
        to: '/preview/$itemId',
      }),
    ];
    const { profile } = defaultProfile({
      assertHost: router => expect(router.options.routeMasks).toBe(routeMasks),
      routingOptions: () => ({ routeMasks }),
    });
    const host = createRouter({
      routeTree,
      routeMasks,
      isServer: true,
      origin: 'https://catalog.example',
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    hosts.add(host);
    associateRouterRenderProfile(host, { id: profile.id, publicContext });
    const target = host.buildLocation({
      to: '/items/$itemId',
      params: { itemId: '42' },
      search: { view: 'full' },
      hash: 'detail',
      state: { request: 'masked-42' },
    });
    const masked = target.maskedLocation;
    if (!masked) throw new Error('Native route mask was not applied');
    host.history.replace(masked.publicHref, {
      ...masked.state,
      __tempLocation: {
        ...parseHref(target.publicHref, undefined),
        state: target.state,
      },
    });
    await host.load();
    expect(host.history.location.href).toBe('/preview/42');
    expect(host.state.location.pathname).toBe('/items/42');
    const snapshot = captureRouterRenderSnapshot(host);
    const first = await restore(wireCopy(snapshot));
    const second = await restore(wireCopy(captureRouterRenderSnapshot(first)));
    expect(snapshot.routing.publicHref).toBe('/preview/42');
    expect(snapshot.routing.unmaskedHref).toBe('/items/42?view=full#detail');
    for (const router of [first, second]) {
      expect(publicMatches(router)).toEqual(publicMatches(host));
      expect(router.history.location.href).toBe(host.history.location.href);
      expect(router.state.location).toMatchObject({
        pathname: '/items/42',
        search: { view: 'full' },
        hash: 'detail',
        state: { request: 'masked-42' },
        maskedLocation: { publicHref: snapshot.routing.publicHref },
      });
      expect(captureRouterRenderSnapshot(router)).toEqual(snapshot);
    }
    expect(calls).toEqual(['42']);
    for (const unmaskedHref of [
      undefined,
      '/preview/42',
      '/items/99?view=full#detail',
    ]) {
      await expect(
        restore(
          wireCopy({
            ...snapshot,
            routing: { ...snapshot.routing, unmaskedHref },
          }),
        ),
      ).rejects.toThrow(
        /restored native match identity, parameters or search differ/,
      );
    }
  });

  it('preserves a profile-owned localized URL rewrite through nested render boundaries', async () => {
    const descriptor = { language: 'fr', languages: ['en', 'fr'] };
    const rewrite = {
      input: ({ url }: { url: URL }) => {
        const next = new URL(url);
        next.pathname = next.pathname.replace(/^\/fr(?=\/|$)/, '') || '/';
        return next;
      },
      output: ({ url }: { url: URL }) => {
        const next = new URL(url);
        next.pathname = '/fr' + next.pathname;
        return next;
      },
    };
    const { profile } = defaultProfile({
      assertHost: (router, snapshot) => {
        assertDefaultRouterRenderHost(router, true);
        expect(router.options.rewrite).toBe(rewrite);
        expect(snapshot.i18n).toEqual(descriptor);
      },
      routingOptions: snapshot => {
        if (JSON.stringify(snapshot.i18n) !== JSON.stringify(descriptor))
          throw new TypeError('Unknown localized routing descriptor');
        return { rewrite };
      },
    });
    const root = createRootRoute();
    const host = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: 'about' }),
      ]),
      history: createMemoryHistory({ initialEntries: ['/fr/about?view=full'] }),
      origin: 'https://catalog.example',
      isServer: true,
      rewrite,
    });
    hosts.add(host);
    associateRouterRenderProfile(host, {
      id: profile.id,
      publicContext,
      i18n: descriptor,
    });
    await host.load();
    const snapshot = captureRouterRenderSnapshot(host);
    const first = await restore(wireCopy(snapshot));
    const second = await restore(wireCopy(captureRouterRenderSnapshot(first)));
    expect(snapshot.routing.publicHref).toBe('/fr/about?view=full');
    expect(captureRouterRenderSnapshot(second)).toEqual(snapshot);
    expect(publicMatches(second)).toEqual(publicMatches(host));
    const html = renderToStaticMarkup(RouterRenderSnapshotSurface, {
      router: second,
      to: '/about',
    }).html;
    expect(html).toContain('href="/fr/about"');
    expect(html).toContain('aria-current="page"');
  });

  it('uses a named local routing profile for parameter codecs, search and loader dependencies', async () => {
    const loaderCalls: number[] = [];
    const validateSearch = (search: Record<string, unknown>) => ({
      page: Number(search.page ?? 1),
    });
    const parse = (params: { itemId: string }) => ({
      itemId: Number(params.itemId),
    });
    const stringify = (params: { itemId: number }) => ({
      itemId: String(params.itemId),
    });
    const tree = (load: boolean) => {
      const root = createRootRoute();
      const item = createRoute({
        getParentRoute: () => root,
        path: 'item/$itemId',
        validateSearch,
        params: { parse, stringify },
        loaderDeps: ({ search }) => ({ page: search.page }),
        ...(load
          ? {
              loader: ({ params }: { params: { itemId: number } }) => {
                loaderCalls.push(params.itemId);
                return { item: params.itemId, source: 'host' };
              },
            }
          : {}),
      });
      return root.addChildren([item]);
    };
    const { profile } = defaultProfile({
      assertHost: router => {
        const item = router.routeTree.children?.[0];
        if (
          item?.options.validateSearch !== validateSearch ||
          item.options.params?.parse !== parse
        ) {
          throw new Error('The exact named routing contract is required');
        }
      },
      createRoutingTree: () => tree(false),
    });
    const host = createRouter({
      routeTree: tree(true),
      isServer: true,
      origin: 'https://catalog.example',
      history: createMemoryHistory({ initialEntries: ['/item/7?page=3'] }),
    });
    hosts.add(host);
    associateRouterRenderProfile(host, { id: profile.id, publicContext: {} });
    await host.load();
    const restored = await restore(wireCopy(captureRouterRenderSnapshot(host)));
    expect(loaderCalls).toEqual([7]);
    expect(publicMatches(restored)).toEqual(publicMatches(host));
    expect(restored.state.matches.at(-1)?.params).toEqual({ itemId: 7 });
    expect(restored.state.matches.at(-1)?.search).toEqual({ page: 3 });
    expect(restored.state.matches.at(-1)?.loaderDeps).toEqual({ page: 3 });
    expect(
      restored.buildLocation({
        to: '/item/$itemId',
        params: { itemId: 12 },
        search: { page: 2 },
      }).publicHref,
    ).toBe(
      host.buildLocation({
        to: '/item/$itemId',
        params: { itemId: 12 },
        search: { page: 2 },
      }).publicHref,
    );

    const recaptured = captureRouterRenderSnapshot(restored);
    const second = await restore(wireCopy(recaptured));
    expect(recaptured).toEqual(captureRouterRenderSnapshot(host));
    expect(publicMatches(second)).toEqual(publicMatches(host));
    expect(second.state.matches.at(-1)).toMatchObject({
      id: host.state.matches.at(-1)?.id,
      routeId: host.state.matches.at(-1)?.routeId,
      params: { itemId: 7 },
      search: { page: 3 },
      loaderData: { item: 7, source: 'host' },
      loaderDeps: { page: 3 },
    });
    expect(loaderCalls).toEqual([7]);
    expect(
      second.buildLocation({
        to: '/item/$itemId',
        params: { itemId: 12 },
        search: { page: 2 },
      }).publicHref,
    ).toBe(
      host.buildLocation({
        to: '/item/$itemId',
        params: { itemId: 12 },
        search: { page: 2 },
      }).publicHref,
    );
  });

  it.each([
    [
      'search validator',
      { validateSearch: (search: Record<string, unknown>) => search },
    ],
    [
      'parameter parser',
      { params: { parse: (params: Record<string, string>) => params } },
    ],
    [
      'parameter serializer',
      { params: { stringify: (params: Record<string, string>) => params } },
    ],
    [
      'search middleware',
      { search: { middlewares: [({ search, next }: any) => next(search)] } },
    ],
    ['loader dependencies', { loaderDeps: () => ({ page: 1 }) }],
    ['per-route case sensitivity', { caseSensitive: true }],
  ])(
    'requires an exact profile for an authored %s',
    async (_name, routeOptions) => {
      const { profile } = defaultProfile();
      const root = createRootRoute();
      const index = createRoute({
        getParentRoute: () => root,
        path: '/',
        ...routeOptions,
      });
      const host = createRouter({
        routeTree: root.addChildren([index]),
        isServer: true,
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });
      hosts.add(host);
      associateRouterRenderProfile(host, { id: profile.id, publicContext: {} });
      await host.load();
      expect(() => captureRouterRenderSnapshot(host)).toThrow(
        /exact local profile/,
      );
    },
  );

  it.each([
    [
      'search parser',
      { parseSearch: (value: string) => defaultParseSearch(value) },
    ],
    [
      'search serializer',
      {
        stringifySearch: (value: Record<string, unknown>) =>
          defaultStringifySearch(value),
      },
    ],
    [
      'URL rewrite',
      {
        rewrite: {
          input: (value: URL) => value,
          output: (value: URL) => value,
        },
      },
    ],
    ['route masks', { routeMasks: [{ from: '/', to: '/' }] }],
  ])(
    'requires an exact profile for an authored %s',
    async (_name, routerOptions) => {
      const { profile } = defaultProfile();
      const root = createRootRoute();
      const host = createRouter({
        routeTree: root.addChildren([
          createRoute({ getParentRoute: () => root, path: '/' }),
        ]),
        isServer: true,
        history: createMemoryHistory({ initialEntries: ['/'] }),
        ...routerOptions,
      });
      hosts.add(host);
      associateRouterRenderProfile(host, { id: profile.id, publicContext: {} });
      await host.load();
      expect(() => captureRouterRenderSnapshot(host)).toThrow(
        /exact local profile/,
      );
    },
  );

  it('captures immutable profile functions and rejects a withdrawn or unknown version', async () => {
    const id = {
      key: `test.router-render.mutable.${++profileSequence}`,
      version: '1',
    };
    const { profile, unregister } = defaultProfile({ id });
    const originalId = { ...profile.id };
    const host = makeHost('/app/about');
    associateRouterRenderProfile(host, { id: originalId, publicContext });
    await host.load();
    id.key = 'mutated-key';
    profile.assertHost = () => {
      throw new Error('mutated assertion');
    };
    profile.createRoutingTree = () => {
      throw new Error('mutated factory');
    };
    profile.routingOptions = () => {
      throw new Error('mutated options');
    };
    const snapshot = captureRouterRenderSnapshot(host);
    expect(snapshot.profile).toEqual(originalId);
    await restore(wireCopy(snapshot));
    await expect(
      restore({
        ...snapshot,
        profile: { ...originalId, version: 'unregistered' },
      }),
    ).rejects.toThrow(/unknown profile/);
    unregister();
    unregister();
    await expect(restore(snapshot)).rejects.toThrow(/unknown profile/);
    expect(() => captureRouterRenderSnapshot(host)).toThrow(/unknown profile/);
  });

  it('requires a declared genuine router and rejects duplicate profile identities', () => {
    const { profile } = defaultProfile();
    expect(() => registerRouterRenderProfile(profile)).toThrow(
      /duplicate profile/,
    );
    const host = makeHost('/app/about');
    expect(() => captureRouterRenderSnapshot(host)).toThrow(
      /declared render profile/,
    );
    expect(() =>
      associateRouterRenderProfile(host, {
        id: { key: 'unknown', version: '1' },
        publicContext: {},
      }),
    ).toThrow(/unknown profile/);
    expect(() =>
      associateRouterRenderProfile({} as AnyRouter, {
        id: profile.id,
        publicContext: {},
      }),
    ).toThrow(/genuine live Octane Router/);
  });

  it('rejects recapture when the named profile was withdrawn and registered again', async () => {
    const { profile, unregister } = defaultProfile();
    const host = makeHost('/app/about');
    associateRouterRenderProfile(host, { id: profile.id, publicContext });
    await host.load();
    const snapshot = captureRouterRenderSnapshot(host);
    const restored = await restore(wireCopy(snapshot));
    expect(captureRouterRenderSnapshot(restored)).toEqual(snapshot);

    unregister();
    expect(() => captureRouterRenderSnapshot(restored)).toThrow(
      /unknown profile/,
    );
    unregisterProfiles.push(registerRouterRenderProfile(profile));
    expect(() => captureRouterRenderSnapshot(restored)).toThrow(
      /provenance changed or expired/,
    );

    const fresh = await restore(wireCopy(snapshot));
    expect(captureRouterRenderSnapshot(fresh)).toEqual(snapshot);
    expect(publicMatches(fresh)).toEqual(publicMatches(host));
  });

  it('rejects failed and unfinished host routes', async () => {
    const { profile } = defaultProfile();
    const root = createRootRoute();
    const host = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: '/',
          loader: () => {
            throw new Error('host load failed');
          },
        }),
      ]),
      isServer: true,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    hosts.add(host);
    associateRouterRenderProfile(host, { id: profile.id, publicContext: {} });
    expect(() => captureRouterRenderSnapshot(host)).toThrow(
      /settled successful matches/,
    );
    await host.load();
    expect(getSsrStatus(host)).toBe(500);
    expect(() => captureRouterRenderSnapshot(host)).toThrow(
      /settled successful matches/,
    );
  });

  it('rejects a host redirect that retains matches from the previous successful load', async () => {
    const { router: host } = await loadedSnapshot('/app/about');
    const previousMatches = [...host.state.matches];
    const task = Object.values(host.routesById).find(
      route => route.options.path === 'tasks/$task',
    );
    if (!task) throw new Error('Expected the task route');
    task.update({
      loader: () => {
        throw redirect({ to: '/about' });
      },
    });
    host.history.replace('/app/projects/alpha/tasks/42');
    await host.load();
    expect(host.state.matches).toEqual(previousMatches);
    expect(() => captureRouterRenderSnapshot(host)).toThrow(
      /settled successful matches/,
    );
  });

  it('waits for real in-flight host loader values before permitting capture', async () => {
    let finish!: () => void;
    let begin!: () => void;
    const loading = new Promise<void>(resolve => {
      finish = resolve;
    });
    const started = new Promise<void>(resolve => {
      begin = resolve;
    });
    const { profile } = defaultProfile();
    const root = createRootRoute();
    const host = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: '/',
          loader: async () => {
            begin();
            await loading;
            return { ready: true };
          },
        }),
      ]),
      isServer: true,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    hosts.add(host);
    associateRouterRenderProfile(host, { id: profile.id, publicContext: {} });
    const pendingLoad = host.load();
    try {
      await started;
      expect(host.state.matches).toEqual([]);
      expect(() => captureRouterRenderSnapshot(host)).toThrow(
        /settled successful matches/,
      );
    } finally {
      finish();
      await pendingLoad;
    }
    expect(
      captureRouterRenderSnapshot(host).matches.at(-1)?.loaderData,
    ).toEqual({ ready: true });
  });

  it.each(['success', 'error'] as const)(
    'rejects capture during a same-URL reload ending in %s',
    async outcome => {
      const gate = createControlledPromise<{ revision: number }>();
      const started = createControlledPromise<void>();
      let calls = 0;
      const { profile } = defaultProfile();
      const root = createRootRoute();
      const route = createRoute({
        getParentRoute: () => root,
        path: '/',
        loader: () => {
          if (++calls !== 2) return { revision: calls };
          started.resolve();
          return gate;
        },
      });
      const host = createRouter({
        routeTree: root.addChildren([route]),
        isServer: true,
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });
      hosts.add(host);
      associateRouterRenderProfile(host, { id: profile.id, publicContext: {} });
      await host.load();
      expect(
        captureRouterRenderSnapshot(host).matches.at(-1)?.loaderData,
      ).toEqual({ revision: 1 });
      const reload = host.load();
      try {
        await started;
        expect(host.state.matches.at(-1)?.loaderData).toEqual({ revision: 1 });
        expect(() => captureRouterRenderSnapshot(host)).toThrow(
          /settled successful matches/,
        );
      } finally {
        if (outcome === 'error') gate.reject(new Error('reload failed'));
        else gate.resolve({ revision: 2 });
        await reload;
      }
      if (outcome === 'error') {
        expect(getSsrStatus(host)).toBe(500);
        expect(() => captureRouterRenderSnapshot(host)).toThrow(
          /settled successful matches/,
        );
      } else {
        expect(
          captureRouterRenderSnapshot(host).matches.at(-1)?.loaderData,
        ).toEqual({
          revision: 2,
        });
      }
      await host.load();
      expect(
        captureRouterRenderSnapshot(host).matches.at(-1)?.loaderData,
      ).toEqual({ revision: 3 });
    },
  );

  it.each([0, 1])(
    'rejects capture while either overlapping same-URL load remains pending when load %s finishes first',
    async first => {
      const gates = [
        createControlledPromise<{ revision: number }>(),
        createControlledPromise<{ revision: number }>(),
      ];
      const started = [
        createControlledPromise<void>(),
        createControlledPromise<void>(),
      ];
      let calls = 0;
      const { profile } = defaultProfile();
      const root = createRootRoute();
      const route = createRoute({
        getParentRoute: () => root,
        path: '/',
        loader: () => {
          const index = calls++ - 1;
          if (index < 0) return { revision: 0 };
          if (index >= gates.length) return { revision: 3 };
          started[index]!.resolve();
          return gates[index]!;
        },
      });
      const host = createRouter({
        routeTree: root.addChildren([route]),
        isServer: true,
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });
      hosts.add(host);
      associateRouterRenderProfile(host, { id: profile.id, publicContext: {} });
      await host.load();
      const loads = [host.load()];
      await started[0];
      loads.push(host.load());
      try {
        await started[1];
        gates[first]!.resolve({ revision: first + 1 });
        await loads[first];
        expect(host.state.matches.at(-1)?.loaderData).toEqual({
          revision: first + 1,
        });
        expect(() => captureRouterRenderSnapshot(host)).toThrow(
          /settled successful matches/,
        );
      } finally {
        gates[0]!.resolve({ revision: 1 });
        gates[1]!.resolve({ revision: 2 });
        await Promise.all(loads);
      }
      if (first === 1) {
        expect(() => captureRouterRenderSnapshot(host)).toThrow(
          /settled successful matches/,
        );
      } else {
        expect(
          captureRouterRenderSnapshot(host).matches.at(-1)?.loaderData,
        ).toEqual({
          revision: 2,
        });
      }
      await host.load();
      expect(
        captureRouterRenderSnapshot(host).matches.at(-1)?.loaderData,
      ).toEqual({ revision: 3 });
    },
  );

  it('rejects retained successful matches after a same-URL request is cancelled before publication', async () => {
    const gate = createControlledPromise<{ revision: number }>();
    const started = createControlledPromise<void>();
    let calls = 0;
    const { profile } = defaultProfile();
    const root = createRootRoute();
    const host = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: '/',
          loader: () => {
            if (++calls !== 2) return { revision: calls };
            started.resolve();
            return gate;
          },
        }),
      ]),
      isServer: true,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    hosts.add(host);
    associateRouterRenderProfile(host, { id: profile.id, publicContext: {} });
    await host.load();
    const controller = new AbortController();
    const reason = new Error('request disconnected');
    const loading = createRequestHandler({
      createRouter: () => host,
      request: new Request('http://localhost/', { signal: controller.signal }),
    })(() => new Response('ready'));
    const rejected = expect(loading).rejects.toBe(reason);
    try {
      await started;
    } finally {
      controller.abort(reason);
      await rejected;
      gate.resolve({ revision: 2 });
    }
    expect(host.state.matches.at(-1)?.loaderData).toEqual({ revision: 1 });
    expect(() => captureRouterRenderSnapshot(host)).toThrow(
      /settled successful matches/,
    );
    await host.load();
    expect(
      captureRouterRenderSnapshot(host).matches.at(-1)?.loaderData,
    ).toEqual({ revision: 3 });
  });

  it.each([
    'loader',
    'beforeLoad',
    'context',
    'onEnter',
    'onStay',
    'onLeave',
    'head',
    'scripts',
    'headers',
  ])(
    'rejects restoration factories containing %s before running authored code',
    async hook => {
      const authored = vi.fn(() => ({}));
      const { profile } = defaultProfile({
        createRoutingTree: () => {
          const root = createRootRoute();
          return root.addChildren([
            createRoute({
              getParentRoute: () => root,
              path: 'about',
              [hook]: authored,
            }),
          ]);
        },
      });
      const host = makeHost('/app/about');
      associateRouterRenderProfile(host, { id: profile.id, publicContext });
      await host.load();
      await expect(restore(captureRouterRenderSnapshot(host))).rejects.toThrow(
        /free of lifecycle hooks/,
      );
      expect(authored).not.toHaveBeenCalled();
    },
  );

  it.each([
    'component',
    'pendingComponent',
    'errorComponent',
    'notFoundComponent',
  ])(
    'rejects an authored %s preload before it can run during restoration',
    async field => {
      const preload = vi.fn(async () => {});
      const component = Object.assign(() => null, { preload });
      const { profile } = defaultProfile({
        createRoutingTree: snapshot => {
          const tree = createRouterRenderRouteTree(snapshot.routes);
          const about = tree.children?.find(
            route => route.options.path === 'about',
          );
          if (!about) throw new Error('Expected the authored about route');
          about.update({ [field]: component });
          return tree;
        },
      });
      const host = makeHost('/app/about');
      associateRouterRenderProfile(host, { id: profile.id, publicContext });
      await host.load();
      const error = await restore(captureRouterRenderSnapshot(host)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(preload).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        message: expect.stringMatching(/free of lifecycle hooks/),
      });
    },
  );

  it('releases genuine memory history when an invalid local tree fails native construction', async () => {
    const { profile } = defaultProfile({
      createRoutingTree: () => {
        const root = createRootRoute();
        return root.addChildren([
          createRoute({ getParentRoute: () => root, path: 'about' }),
          createRoute({ getParentRoute: () => root, path: 'about' }),
        ]);
      },
    });
    const host = makeHost('/app/about');
    associateRouterRenderProfile(host, { id: profile.id, publicContext });
    await host.load();
    const snapshot = captureRouterRenderSnapshot(host);
    const createGenuineHistory = nativeHistory.createMemoryHistory;
    const histories: Array<ReturnType<typeof createGenuineHistory>> = [];
    const destroyCounts: number[] = [];
    vi.spyOn(nativeHistory, 'createMemoryHistory').mockImplementation(
      options => {
        const history = createGenuineHistory(options);
        const index = histories.push(history) - 1;
        const destroy = history.destroy.bind(history);
        vi.spyOn(history, 'destroy').mockImplementation(() => {
          destroyCounts[index] = (destroyCounts[index] ?? 0) + 1;
          destroy();
        });
        return history;
      },
    );
    await expect(restore(snapshot)).rejects.toThrow(/duplicate routes/i);
    expect(histories).toHaveLength(1);
    expect(destroyCounts).toEqual([1]);
  });

  it('rejects tampered geometry, match identities, parameters and search', async () => {
    const { snapshot } = await loadedSnapshot();
    for (const value of [
      { ...snapshot, routes: [...snapshot.routes, snapshot.routes[0]] },
      {
        ...snapshot,
        routes: snapshot.routes.map((route, i) =>
          i === 1 ? { ...route, parentRouteId: 'missing' } : route,
        ),
      },
      { ...snapshot, matches: [...snapshot.matches, snapshot.matches[0]] },
      {
        ...snapshot,
        matches: snapshot.matches.map((match, i) =>
          i === 0 ? { ...match, routeId: 'missing' } : match,
        ),
      },
      {
        ...snapshot,
        matches: snapshot.matches.map((match, i) =>
          i === 0 ? { ...match, id: 'tampered' } : match,
        ),
      },
      {
        ...snapshot,
        matches: snapshot.matches.map((match, i) =>
          i === snapshot.matches.length - 1
            ? { ...match, params: { project: 'other', task: '42' } }
            : match,
        ),
      },
      {
        ...snapshot,
        matches: snapshot.matches.map((match, i) =>
          i === 0 ? { ...match, search: { sort: 'other' } } : match,
        ),
      },
    ]) {
      await expect(restore(value)).rejects.toThrow(/Router render snapshot/);
    }
  });

  it('rejects malformed records, hidden accessors, cycles and non-JSON values before invoking a profile', async () => {
    const createTree = vi.fn((snapshot: RouterRenderSnapshot) =>
      createRouterRenderRouteTree(snapshot.routes),
    );
    const { profile } = defaultProfile({ createRoutingTree: createTree });
    const host = makeHost('/app/about');
    associateRouterRenderProfile(host, { id: profile.id, publicContext });
    await host.load();
    const snapshot = captureRouterRenderSnapshot(host);
    let accessed = false;
    const accessor = { ...snapshot };
    Object.defineProperty(accessor, 'routing', {
      get: () => {
        accessed = true;
        return snapshot.routing;
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      { ...snapshot, extra: true },
      { ...snapshot, version: 2 },
      { ...snapshot, profile: { ...profile.id, extra: true } },
      { ...snapshot, routing: { ...snapshot.routing, extra: true } },
      {
        ...snapshot,
        routing: {
          ...snapshot.routing,
          origin: 'https://catalog.example/private',
        },
      },
      {
        ...snapshot,
        routing: { ...snapshot.routing, publicHref: '//foreign.example/about' },
      },
      {
        ...snapshot,
        routing: {
          ...snapshot.routing,
          publicHref: '/\\foreign.example/about',
        },
      },
      ...[
        null,
        1,
        '',
        'about',
        'https://foreign.example/about',
        '//foreign.example/about',
        '/\\foreign.example/about',
      ].map(unmaskedHref => ({
        ...snapshot,
        routing: { ...snapshot.routing, unmaskedHref },
      })),
      {
        ...snapshot,
        routing: { ...snapshot.routing, userState: { __TSR_index: 12 } },
      },
      { ...snapshot, publicContext: { value: undefined } },
      { ...snapshot, publicContext: { value: Number.NaN } },
      { ...snapshot, publicContext: { value: 1n } },
      { ...snapshot, publicContext: { value: new Date() } },
      { ...snapshot, publicContext: { value: () => 'application code' } },
      { ...snapshot, publicContext: cycle },
      accessor,
    ]) {
      await expect(restore(value)).rejects.toThrow(/Router render snapshot/);
    }
    expect(accessed).toBe(false);
    expect(createTree).not.toHaveBeenCalled();
  });

  it.each(['array subclass', 'overridden inherited iterator'])(
    'rejects an unknown public %s before invoking application code',
    async kind => {
      const createTree = vi.fn((snapshot: RouterRenderSnapshot) =>
        createRouterRenderRouteTree(snapshot.routes),
      );
      const { profile } = defaultProfile({ createRoutingTree: createTree });
      const host = makeHost('/app/about');
      associateRouterRenderProfile(host, { id: profile.id, publicContext });
      await host.load();
      const snapshot = captureRouterRenderSnapshot(host);
      let iteratorCalls = 0;
      class PublicArray extends Array<string> {}
      if (kind === 'overridden inherited iterator') {
        Object.defineProperty(PublicArray.prototype, Symbol.iterator, {
          value(this: string[]) {
            iteratorCalls++;
            return Array.prototype[Symbol.iterator].call(this);
          },
        });
      }
      const error = await restore({
        ...snapshot,
        publicContext: { items: new PublicArray('visible') },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(iteratorCalls).toBe(0);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        message: expect.stringMatching(/Router render snapshot/),
      });
      expect(createTree).not.toHaveBeenCalled();
    },
  );

  it('enforces depth, node, UTF-8 string, total string, route and match budgets', async () => {
    const createTree = vi.fn((snapshot: RouterRenderSnapshot) =>
      createRouterRenderRouteTree(snapshot.routes),
    );
    const { profile } = defaultProfile({ createRoutingTree: createTree });
    const host = makeHost('/app/about');
    associateRouterRenderProfile(host, { id: profile.id, publicContext });
    await host.load();
    const snapshot = captureRouterRenderSnapshot(host);
    const root = snapshot.routes.find(route => route.parentRouteId === null)!;
    const overRouteBudget = [
      ...snapshot.routes,
      ...Array.from({ length: 4097 - snapshot.routes.length }, (_, i) => ({
        routeId: `/budget-route-${i}`,
        parentRouteId: root.routeId,
        path: `budget-route-${i}`,
      })),
    ];
    const extraMatches = Array.from(
      { length: 129 - snapshot.matches.length },
      (_, i) => ({
        id: `/budget-match-${i}`,
        routeId: `/budget-match-${i}`,
        params: {},
        search: {},
      }),
    );
    const matchRoutes = extraMatches.map(match => ({
      routeId: match.routeId,
      parentRouteId: root.routeId,
      path: match.routeId.slice(1),
    }));
    let deep: unknown = null;
    for (let i = 0; i < 65; i++) deep = { child: deep };
    for (const value of [
      { ...snapshot, publicContext: { deep } },
      {
        ...snapshot,
        publicContext: {
          nodes: Array.from({ length: 40000 }, () => ({ value: null })),
        },
      },
      { ...snapshot, publicContext: { text: 'x'.repeat(1024 * 1024 + 1) } },
      { ...snapshot, publicContext: { text: 'é'.repeat(600000) } },
      {
        ...snapshot,
        publicContext: { chunks: Array(9).fill('x'.repeat(1024 * 1024)) },
      },
      { ...snapshot, routes: overRouteBudget },
      {
        ...snapshot,
        routes: [...snapshot.routes, ...matchRoutes],
        matches: [...snapshot.matches, ...extraMatches],
      },
    ]) {
      await expect(restore(value)).rejects.toThrow(/Router render snapshot/);
    }
    expect(createTree).not.toHaveBeenCalled();
  });

  it('rejects a pre-aborted request with the original cancellation reason', async () => {
    const { snapshot } = await loadedSnapshot('/app/about');
    const controller = new AbortController();
    const reason = new DOMException(
      'Publisher request cancelled',
      'AbortError',
    );
    controller.abort(reason);
    await expect(restore(snapshot, { signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it('cancels a genuine in-progress native restoration with the original request reason', async () => {
    const { snapshot } = await loadedSnapshot('/app/about');
    const controller = new AbortController();
    const reason = new DOMException(
      'Publisher request cancelled during routing',
      'AbortError',
    );
    const pendingRestore = restore(snapshot, { signal: controller.signal });
    controller.abort(reason);
    await expect(pendingRestore).rejects.toBe(reason);
  });

  it('releases native matches and history once when its request ends', async () => {
    const { snapshot } = await loadedSnapshot('/app/about');
    const restored = await restore(snapshot);
    const controllers = restored.state.matches.map(
      match => match.abortController,
    );
    const aborts = controllers.map(controller => vi.spyOn(controller, 'abort'));
    const destroy = vi.spyOn(restored.history, 'destroy');
    disposeRouterRenderSnapshot(restored);
    disposeRouterRenderSnapshot(restored);
    for (const abort of aborts) expect(abort).toHaveBeenCalledTimes(1);
    for (const controller of controllers)
      expect(controller.signal.aborted).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('releases a restored router when its request aborts after restoration', async () => {
    const { snapshot } = await loadedSnapshot('/app/about');
    const controller = new AbortController();
    const restored = await restore(snapshot, { signal: controller.signal });
    const destroy = vi.spyOn(restored.history, 'destroy');
    controller.abort(new DOMException('Response disconnected', 'AbortError'));
    expect(destroy).toHaveBeenCalledTimes(1);
    disposeRouterRenderSnapshot(restored);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(getRouterRenderProfile(restored)).toBeUndefined();
    expect(() => captureRouterRenderSnapshot(restored)).toThrow(
      /Router render snapshot/,
    );
  });

  it('rejects recapture after restored route options were modified', async () => {
    const { snapshot } = await loadedSnapshot('/app/about');
    const restored = await restore(snapshot);
    restored.routeTree.update({ validateSearch: () => ({ changed: true }) });
    expect(() => captureRouterRenderSnapshot(restored)).toThrow(
      /provenance changed or expired/,
    );
  });

  it('rejects another server render capture after the restored request has ended', async () => {
    const { snapshot } = await loadedSnapshot('/app/about');
    const restored = await restore(wireCopy(snapshot));
    expect(captureRouterRenderSnapshot(restored)).toEqual(snapshot);
    disposeRouterRenderSnapshot(restored);
    expect(() => captureRouterRenderSnapshot(restored)).toThrow(
      /Router render snapshot/,
    );
    expect(() =>
      associateRouterRenderProfile(restored, {
        id: snapshot.profile,
        publicContext: snapshot.publicContext,
      }),
    ).toThrow(/genuine live Octane Router/);
    expect(() => captureRouterRenderSnapshot(restored)).toThrow(
      /Router render snapshot/,
    );
  });
});
