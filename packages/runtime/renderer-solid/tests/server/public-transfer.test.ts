import type {
  DataOutcome,
  FileSystemRouteIR,
} from '@modern-js/renderer-core/data';
import { createRequestSession } from '@modern-js/renderer-core/session';
import { renderToStream, ssr } from '@solidjs/web';
import { createComponent, createMemo, Loading, NoHydration } from 'solid-js';
import {
  type AnyRoute,
  ApplicationRouter,
  createApplicationRouter,
  createFileSystemRouteTree,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type FileSystemRouteModule,
  getApplicationStatus,
  Outlet,
  type RouteContextOptions,
  RouterProvider,
  useLoaderData,
  useRouteContext,
} from '../../src/router';
import { preparePublicLoaderData } from '../../src/router-binding/publicMatchData';
import {
  MATCH_KEY_PREFIX,
  serializeMatchTransfer,
} from '../../src/router-binding/registryTransfer';
import { renderDocumentApplication } from '../../src/server';

const privateMarker = 'ULTRA_PRIVATE_AUTH_TOKEN_784';
const publicMarker = 'public-critical-only-in-loader';

function createSession(bindings: Record<string, unknown> = {}) {
  const session = createRequestSession({
    request: new Request('https://shop.test/item'),
    identity: {
      renderer: 'solid',
      appId: 'public-transfer',
      entryName: 'main',
      protocolVersion: 1,
      buildId: 'build-a',
    },
    platform: { kind: 'node', bindings },
  });
  session.resolveResponse({
    kind: 'document',
    status: 200,
    headers: [['content-type', 'text/html; charset=utf-8']],
    cache: { mode: 'public', maxAgeSeconds: 30 },
  });
  return session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createDataRouter(
  session: ReturnType<typeof createSession>,
  loader: () => unknown | Promise<unknown>,
  beforeLoad: () => Record<string, unknown> = () => ({
    publicBeforeLoad: 'native-public-before-load',
  }),
  component?: FileSystemRouteModule['component'],
  context?: FileSystemRouteModule['context'],
) {
  const serverOnly = {
    token: privateMarker,
    authenticatedRequest: new Request('https://internal.test/', {
      headers: { authorization: privateMarker },
    }),
  };
  const routes: FileSystemRouteIR[] = [
    {
      id: 'layout',
      isRoot: true,
      children: [
        {
          id: 'item',
          path: 'item',
          modules: { data: '/item.data.ts' },
          children: [],
        },
      ],
    },
  ];
  const routeTree = createFileSystemRouteTree(
    routes,
    {
      layout: { beforeLoad, context },
      item: { component },
    },
    {
      request: session.request,
      session,
      context: serverOnly,
      loadRoute: async () => ({
        kind: 'success',
        value: await loader(),
        response: {
          status: 200,
          statusText: 'OK',
          headers: [],
          cachePolicy: 'public',
        },
      }),
    },
  );
  return createApplicationRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/item'] }),
    context: { publicOptions: 'native-public-options' },
    isServer: true,
  });
}

async function loadedRouter(
  session: ReturnType<typeof createSession>,
  value: unknown,
) {
  const router = createDataRouter(session, () => value);
  await router.load();
  return router;
}

function renderTransfer(
  session: ReturnType<typeof createSession>,
  router: ReturnType<typeof createDataRouter>,
) {
  return renderDocumentApplication({
    session,
    view: () => {
      serializeMatchTransfer(router);
      return ssr('<main>stream shell</main>');
    },
  });
}

async function consume(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix = '',
) {
  let html = prefix;
  let error: unknown;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      html += new TextDecoder().decode(chunk.value);
    }
  } catch (cause) {
    error = cause;
  }
  return { html, error };
}

const forbidden: Array<readonly [string, () => unknown]> = [
  [
    'Request',
    () =>
      new Request('https://internal.test/', {
        headers: { authorization: privateMarker },
      }),
  ],
  ['Headers', () => new Headers({ authorization: privateMarker })],
  ['request session', () => createSession()],
  ['function', () => () => privateMarker],
];

const mutableContainers: Array<readonly [string, () => unknown]> = [
  ['Date', () => new Date('2026-10-02T12:00:00.000Z')],
  ['RegExp', () => /public-data/],
  ['Map', () => new Map([['public', 'value']])],
  ['Set', () => new Set(['public-value'])],
];

describe('native public match transfer', () => {
  test('a caught application context override still fails before commitment', async () => {
    const session = createSession();
    const router = await loadedRouter(session, { critical: 'public value' });
    const originalContext = router.options.context;
    let reads = 0;
    const props = Object.defineProperty({ router }, 'context', {
      get() {
        reads++;
        return { private: privateMarker };
      },
    });
    await expect(
      renderDocumentApplication({
        session,
        view: () => {
          try {
            return createComponent(ApplicationRouter, props);
          } catch {
            return ssr('<main>caught context fallback</main>');
          }
        },
      }),
    ).rejects.toThrow(/ApplicationRouter context overrides are unsupported/);
    expect(reads).toBe(0);
    expect(router.options.context).toBe(originalContext);
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test('a caught adapter rejection still fails its owning request', async () => {
    const session = createSession();
    const router = await loadedRouter(session, { critical: 'public value' });
    Object.defineProperty(router.options, 'serializationAdapters', {
      value: [],
    });
    await expect(
      renderDocumentApplication({
        session,
        view: () => {
          try {
            serializeMatchTransfer(router);
          } catch {
            return ssr('<main>caught fallback</main>');
          }
          return ssr('<main>unexpected success</main>');
        },
      }),
    ).rejects.toThrow(/serializationAdapters.*unsupported/);
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test.each([
    ['native', createRouter],
    ['application', createApplicationRouter],
  ] as const)(
    '%s router rejects JavaScript serialization adapters during construction',
    (_name, factory) => {
      const options = { routeTree: createRootRoute(), isServer: true };
      Object.defineProperty(options, 'serializationAdapters', { value: [] });
      expect(() => factory(options)).toThrow(
        /serializationAdapters.*unsupported/,
      );
    },
  );

  test.each(['provider', 'mutated-router'] as const)(
    '%s rejects unused serialization adapters before document commitment',
    async entry => {
      const session = createSession();
      const router = await loadedRouter(session, {
        critical: 'valid public data',
      });
      let adapterCalls = 0;
      const adapters = [
        {
          key: 'custom',
          test: () => {
            adapterCalls += 1;
            return true;
          },
          toSerializable: () => 'custom',
          fromSerializable: () => 'custom',
        },
      ];
      const props = { router };
      Object.defineProperty(
        entry === 'provider' ? props : router.options,
        'serializationAdapters',
        { value: adapters, enumerable: true },
      );
      await expect(
        renderDocumentApplication({
          session,
          view: () => {
            if (entry === 'provider')
              return createComponent(ApplicationRouter, props);
            serializeMatchTransfer(router);
            return ssr('<main>valid public data</main>');
          },
        }),
      ).rejects.toThrow(/serializationAdapters.*unsupported/);
      expect(session.committedPolicy).toBeUndefined();
      expect((await session.completion).state).toBe('failed');
      expect(adapterCalls).toBe(0);
    },
  );

  test.each(['provider', 'writer'] as const)(
    'the native %s rejects an unmanaged raw router inside an UltraModern document request',
    async entry => {
      let loaderCalls = 0;
      let componentCalls = 0;
      const root = createRootRoute({ component: Outlet });
      const item = createRoute({
        getParentRoute: () => root,
        path: '/item',
        loader: () => {
          loaderCalls += 1;
          return { value: 'raw-native-public-value' };
        },
        component: () => {
          componentCalls += 1;
          return ssr('<main>raw native view</main>');
        },
      });
      const router = createRouter({
        routeTree: root.addChildren([item]),
        history: createMemoryHistory({ initialEntries: ['/item'] }),
        isServer: true,
      });
      await router.load();
      expect(loaderCalls).toBe(1);
      expect(router.state.matches.at(-1)?.status).toBe('success');
      const session = createSession();
      await expect(
        renderDocumentApplication({
          session,
          view: () => {
            if (entry === 'provider')
              return createComponent(RouterProvider, { router });
            serializeMatchTransfer(router);
            return ssr('<main>raw native writer</main>');
          },
        }),
      ).rejects.toThrow(
        /Custom native Solid routers are unsupported by UltraModern SSR/,
      );
      expect(componentCalls).toBe(0);
      expect(session.committedPolicy).toBeUndefined();
      expect((await session.completion).state).toBe('failed');
    },
  );

  test.each(forbidden)(
    '%s cannot cross the document commit boundary',
    async (_name, createValue) => {
      const session = createSession();
      const router = await loadedRouter(session, { payload: createValue() });
      let error: unknown;
      let emitted = '';
      try {
        emitted = await (await renderTransfer(session, router)).text();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(Error);
      expect(session.committedPolicy).toBeUndefined();
      expect(emitted).not.toContain(privateMarker);
      expect((await session.completion).state).toBe('failed');
    },
  );

  test('public validation does not invoke a loader-data getter', async () => {
    const session = createSession();
    let getterCalls = 0;
    const payload = Object.defineProperty({}, 'token', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return privateMarker;
      },
    });
    const router = await loadedRouter(session, payload);
    await expect(renderTransfer(session, router)).rejects.toThrow();
    expect(getterCalls).toBe(0);
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test('a rejected critical loader writes only a settled match with projected public diagnostics', async () => {
    const session = createSession();
    const authoredError = new Error(privateMarker);
    const router = createDataRouter(session, async () => {
      throw authoredError;
    });
    await router.load();
    const match = router.state.matches.at(-1);
    expect(match?.status).toBe('error');
    expect(getApplicationStatus(router)).toBe(500);
    session.resolveResponse({
      kind: 'document',
      status: getApplicationStatus(router),
      headers: [['content-type', 'text/html; charset=utf-8']],
      cache: { mode: 'no-store' },
    });
    const response = await renderTransfer(session, router);
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain('stream shell');
    expect(html).not.toContain(privateMarker);
    expect(html).toContain('Unexpected Server Error');
    const key = `${MATCH_KEY_PREFIX}${match?.id}`;
    const assignment = html
      .slice(html.indexOf(`_$HY.r[${JSON.stringify(key)}]=`))
      .split(';', 1)[0];
    expect(assignment).toContain(`_$HY.r[${JSON.stringify(key)}]=`);
    expect(assignment).toContain('status:"error"');
    expect(assignment).not.toMatch(/\bPromise\b/);
    expect(authoredError.message).toBe(privateMarker);
    expect(Object.isFrozen(authoredError)).toBe(false);
  });

  test('native transfer preserves explicit public beforeLoad values and omits private framework context', async () => {
    let loaderCalls = 0;
    const session = createSession();
    const router = createDataRouter(session, () => {
      loaderCalls += 1;
      return { greeting: publicMarker };
    });
    await router.load();
    const html = await (await renderTransfer(session, router)).text();
    expect(html).toContain(MATCH_KEY_PREFIX);
    expect(html).toContain(publicMarker);
    expect(html).toContain('native-public-before-load');
    expect(html).not.toContain(privateMarker);
    expect(html).not.toContain('authenticatedRequest');
    expect(loaderCalls).toBe(1);
    expect((await session.completion).cacheEligible).toBe(true);
  });

  test.each(forbidden)(
    'an explicitly returned beforeLoad %s is refused before the document commits',
    async (_name, createValue) => {
      const session = createSession();
      const router = createDataRouter(
        session,
        () => ({ greeting: publicMarker }),
        () => ({ payload: createValue() }),
      );
      await router.load();
      await expect(renderTransfer(session, router)).rejects.toThrow();
      expect(session.committedPolicy).toBeUndefined();
      expect((await session.completion).state).toBe('failed');
    },
  );

  test('returned beforeLoad context rejects getters without invoking them', async () => {
    const session = createSession();
    let getterCalls = 0;
    const context = Object.defineProperty({}, 'token', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return privateMarker;
      },
    });
    const router = createDataRouter(
      session,
      () => ({ greeting: publicMarker }),
      () => context,
    );
    await router.load();
    await expect(renderTransfer(session, router)).rejects.toThrow();
    expect(getterCalls).toBe(0);
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test('returned beforeLoad context cannot contain the current plain request bindings', async () => {
    const bindings = { authorization: privateMarker };
    const session = createSession(bindings);
    const router = createDataRouter(
      session,
      () => ({ greeting: publicMarker }),
      () => ({ bindings }),
    );
    await router.load();
    await expect(renderTransfer(session, router)).rejects.toThrow();
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test.each(forbidden)(
    'a synchronous module.context cannot return %s before document headers',
    async (_name, createValue) => {
      const session = createSession();
      let error: unknown;
      try {
        const router = createDataRouter(
          session,
          () => ({ ready: publicMarker }),
          undefined,
          undefined,
          () => ({ payload: createValue() }),
        );
        await router.load();
        await renderTransfer(session, router);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(Error);
      expect(session.committedPolicy).toBeUndefined();
      expect((await session.completion).state).toBe('failed');
    },
  );

  test('a synchronous module.context rejects a getter before native context composition reads it', async () => {
    const session = createSession();
    let getterCalls = 0;
    const authored = Object.defineProperty({}, 'token', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return privateMarker;
      },
    });
    let error: unknown;
    try {
      const router = createDataRouter(
        session,
        () => ({ ready: publicMarker }),
        undefined,
        undefined,
        () => authored,
      );
      await router.load();
      await renderTransfer(session, router);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect(getterCalls).toBe(0);
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
    expect(Object.isFrozen(authored)).toBe(false);
  });

  test('a synchronous module.context cannot relabel plain request bindings as public', async () => {
    const bindings = { authorization: privateMarker };
    const session = createSession(bindings);
    let error: unknown;
    try {
      const router = createDataRouter(
        session,
        () => ({ ready: publicMarker }),
        undefined,
        undefined,
        () => ({ bindings }),
      );
      await router.load();
      await renderTransfer(session, router);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
    expect(Object.isFrozen(bindings)).toBe(false);
  });

  test('native synchronous module.context preserves public aliases and native callback arguments before useRouteContext', async () => {
    const shared = {
      value: 'public-sync-context-alias',
      nested: ['public-sync-context-array'],
    };
    const authored = {
      publicRouteContext: 'public-sync-route-context',
      left: shared,
      right: shared,
    };
    const session = createSession();
    let contextCalls = 0;
    let selected: object | undefined;
    const router = createDataRouter(
      session,
      () => ({ ready: publicMarker, loaderAlias: shared }),
      () => ({ beforeLoadAlias: shared }),
      () => {
        const context = useRouteContext({ strict: false })();
        const data = useLoaderData({ strict: false })();
        selected = context;
        expect(Object.isFrozen(context)).toBe(true);
        const left = Object.getOwnPropertyDescriptor(context, 'left')?.value;
        expect(left).toBe(
          Object.getOwnPropertyDescriptor(context, 'right')?.value,
        );
        expect(left).toBe(
          Object.getOwnPropertyDescriptor(context, 'beforeLoadAlias')?.value,
        );
        expect(left).toBe(
          Object.getOwnPropertyDescriptor(data, 'loaderAlias')?.value,
        );
        expect(left === shared).toBe(false);
        expect(Object.isFrozen(left)).toBe(true);
        expect(
          Object.isFrozen(
            Object.getOwnPropertyDescriptor(left, 'nested')?.value,
          ),
        ).toBe(true);
        const memo = createMemo(async () => context);
        return createComponent(Loading, {
          fallback: ssr('<p>waiting sync route context</p>'),
          get children() {
            return ssr(['<p>', '</p>'], () => memo().publicRouteContext);
          },
        });
      },
      (
        args: RouteContextOptions<
          AnyRoute,
          Record<string, string>,
          Record<string, unknown>,
          Record<string, unknown>,
          string
        >,
      ) => {
        contextCalls += 1;
        expect(args.location.pathname).toBe('/item');
        expect(args.params).toEqual({});
        expect(args.context.publicOptions).toBe('native-public-options');
        return authored;
      },
    );
    await router.load();
    expect(router.state.matches.at(-1)?.error).toBeUndefined();
    const html = await (
      await renderDocumentApplication({
        session,
        view: () => createComponent(ApplicationRouter, { router }),
      })
    ).text();
    expect(contextCalls).toBeGreaterThan(0);
    expect(selected).toBe(router.state.matches.at(-1)?.context);
    expect(html).toContain('public-sync-route-context');
    expect(html).toContain('public-sync-context-alias');
    expect(html).toContain('public-sync-context-array');
    expect(html).not.toContain(privateMarker);
    expect(Object.isFrozen(authored)).toBe(false);
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(shared.nested)).toBe(false);
    expect(authored.left).toBe(shared);
    expect(authored.right).toBe(shared);
    expect((await session.completion).state).toBe('completed');
  });

  test.each(mutableContainers)(
    'managed native data rejects mutable %s before commit',
    async (_name, createValue) => {
      const session = createSession();
      const router = await loadedRouter(session, { payload: createValue() });
      await expect(renderTransfer(session, router)).rejects.toThrow();
      expect(session.committedPolicy).toBeUndefined();
      expect((await session.completion).state).toBe('failed');
    },
  );

  test.each(mutableContainers)(
    'managed beforeLoad rejects mutable %s before commit',
    async (_name, createValue) => {
      const session = createSession();
      const router = createDataRouter(
        session,
        () => ({ greeting: publicMarker }),
        () => ({ payload: createValue() }),
      );
      await router.load();
      await expect(renderTransfer(session, router)).rejects.toThrow();
      expect(session.committedPolicy).toBeUndefined();
      expect((await session.completion).state).toBe('failed');
    },
  );

  test('a prepared public record isolates critical mutation and owns a checked native deferred Promise', async () => {
    const source = deferred<unknown>();
    const original = {
      ready: publicMarker,
      details: { title: 'public-nested-critical' },
      later: source.promise,
    };
    const session = createSession();
    const router = await loadedRouter(session, original);
    let prepared: unknown;
    const response = await renderDocumentApplication({
      session,
      view: () => {
        prepared = preparePublicLoaderData(original);
        original.ready = privateMarker;
        original.details.title = privateMarker;
        serializeMatchTransfer(router);
        return ssr('<main>stream shell</main>');
      },
    });
    expect(prepared).toMatchObject({ ready: publicMarker });
    expect(prepared).not.toBe(original);
    if (!prepared || typeof prepared !== 'object')
      throw new Error('Expected a prepared loader record.');
    const slot = Object.getOwnPropertyDescriptor(prepared, 'later')?.value;
    expect(slot).toBeInstanceOf(Promise);
    expect(slot).not.toBe(source.promise);
    expect(router.state.matches.at(-1)?.loaderData).not.toBe(original);
    expect(original.later).toBe(source.promise);
    const reader = response.body!.getReader();
    const shell = await reader.read();
    const prefix = new TextDecoder().decode(shell.value);
    expect(prefix).toContain('stream shell');
    source.resolve({ value: 'public-later' });
    const result = await consume(reader, prefix);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain(publicMarker);
    expect(result.html).toContain('public-nested-critical');
    expect(result.html).toContain('public-later');
    expect(result.html).not.toContain(privateMarker);
    expect((await session.completion).state).toBe('completed');
  });

  test('managed snapshots preserve shared aliases across loader, beforeLoad and deferred values', async () => {
    const source = deferred<unknown>();
    const shared = {
      label: 'public-shared-alias',
      nested: ['public-alias-array'],
    };
    const authored = {
      left: shared,
      right: shared,
      first: source.promise,
      second: source.promise,
    };
    const session = createSession();
    const router = createDataRouter(
      session,
      () => authored,
      () => ({ contextAlias: shared }),
    );
    await router.load();
    const match = router.state.matches.at(-1);
    expect(match?.status).toBe('success');
    const data = match?.loaderData;
    if (!data || typeof data !== 'object')
      throw new Error('Expected managed alias data.');
    const left = Object.getOwnPropertyDescriptor(data, 'left')?.value;
    const right = Object.getOwnPropertyDescriptor(data, 'right')?.value;
    const first = Object.getOwnPropertyDescriptor(data, 'first')?.value;
    const second = Object.getOwnPropertyDescriptor(data, 'second')?.value;
    expect(left).toBe(right);
    expect(match?.context.contextAlias).toBe(left);
    expect(left).not.toBe(shared);
    expect(Object.isFrozen(left)).toBe(true);
    expect(
      Object.isFrozen(Object.getOwnPropertyDescriptor(left, 'nested')?.value),
    ).toBe(true);
    expect(first).toBe(second);
    expect(first).not.toBe(source.promise);
    const reader = (await renderTransfer(session, router)).body!.getReader();
    const prefix = new TextDecoder().decode((await reader.read()).value);
    source.resolve(shared);
    expect(await first).toBe(left);
    expect(await second).toBe(left);
    const result = await consume(reader, prefix);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('public-shared-alias');
    expect(result.html).toContain('public-alias-array');
    expect(Object.isFrozen(authored)).toBe(false);
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(shared.nested)).toBe(false);
    expect(authored.first).toBe(source.promise);
    expect(authored.second).toBe(source.promise);
  });

  test('native published route context is immutable before useRouteContext async memo hydration', async () => {
    const session = createSession();
    const authoredOptions = {
      publicOptions: 'native-public-options',
      optionsNested: { value: 'public-options-nested' },
    };
    const authoredBeforeLoad = {
      publicContext: 'native-public-before-load',
      nested: { value: 'public-before-load-nested' },
    };
    let getterCalls = 0;
    let selected: object | undefined;
    const routeTree = createFileSystemRouteTree(
      [
        {
          id: 'layout',
          isRoot: true,
          children: [{ id: 'item', path: 'item', children: [] }],
        },
      ],
      {
        layout: { beforeLoad: () => authoredBeforeLoad },
        item: {
          component: () => {
            const context = useRouteContext({ strict: false })();
            selected = context;
            expect(Object.isFrozen(context)).toBe(true);
            expect(
              Reflect.defineProperty(context, 'lateToken', {
                enumerable: true,
                get() {
                  getterCalls += 1;
                  return privateMarker;
                },
              }),
            ).toBe(false);
            const nested = Object.getOwnPropertyDescriptor(
              context,
              'nested',
            )?.value;
            expect(Object.isFrozen(nested)).toBe(true);
            expect(Reflect.set(nested, 'value', privateMarker)).toBe(false);
            const memo = createMemo(async () => context);
            return createComponent(Loading, {
              fallback: ssr('<p>waiting public context</p>'),
              get children() {
                return ssr(['<p>', '</p>'], () => memo().publicContext);
              },
            });
          },
        },
      },
      { request: session.request, session },
    );
    const router = createApplicationRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/item'] }),
      context: authoredOptions,
      isServer: true,
    });
    await router.load();
    expect(router.state.matches.at(-1)?.error).toBeUndefined();
    expect(Object.isFrozen(router.state.matches.at(-1)?.context)).toBe(true);
    const html = await (
      await renderDocumentApplication({
        session,
        view: () => createComponent(ApplicationRouter, { router }),
      })
    ).text();
    expect(selected).toBe(router.state.matches.at(-1)?.context);
    expect(getterCalls).toBe(0);
    expect(html).not.toContain(privateMarker);
    expect(html).toContain('native-public-before-load');
    expect(html).toContain('public-before-load-nested');
    expect(html).toContain('native-public-options');
    expect(html).toContain('public-options-nested');
    expect(router.options.context).not.toBe(authoredOptions);
    expect(Object.isFrozen(authoredOptions)).toBe(false);
    expect(Object.isFrozen(authoredOptions.optionsNested)).toBe(false);
    expect(Object.isFrozen(authoredBeforeLoad)).toBe(false);
    expect(Object.isFrozen(authoredBeforeLoad.nested)).toBe(false);
    expect(authoredOptions.optionsNested.value).toBe('public-options-nested');
    expect(authoredBeforeLoad.nested.value).toBe('public-before-load-nested');
    expect((await session.completion).state).toBe('completed');
  });

  test('the current request bindings cannot be relabeled as public loader data', async () => {
    const bindings = { authorization: privateMarker };
    const session = createSession(bindings);
    const router = await loadedRouter(session, { payload: bindings });
    await expect(renderTransfer(session, router)).rejects.toThrow();
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test('a nested promise outside the admitted deferred-slot contract rejects before commit', async () => {
    const session = createSession();
    const router = await loadedRouter(session, {
      nested: { later: Promise.resolve('public') },
    });
    await expect(renderTransfer(session, router)).rejects.toThrow();
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test('native deferred public values stream through Solid after the early shell', async () => {
    const source = deferred<unknown>();
    const session = createSession();
    const router = await loadedRouter(session, {
      ready: publicMarker,
      later: source.promise,
    });
    const reader = (await renderTransfer(session, router)).body!.getReader();
    const shell = await reader.read();
    const prefix = new TextDecoder().decode(shell.value);
    expect(prefix).toContain('stream shell');
    source.resolve({ value: 'native-public-later' });
    const result = await consume(reader, prefix);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain(publicMarker);
    expect(result.html).toContain('native-public-later');
    expect(result.html).not.toContain(privateMarker);
    expect((await session.completion).state).toBe('completed');
  });

  test.each(forbidden)(
    'deferred %s fulfillment never emits private bytes or enters the success cache',
    async (_name, createValue) => {
      const source = deferred<unknown>();
      const session = createSession();
      const router = await loadedRouter(session, {
        ready: publicMarker,
        later: source.promise,
      });
      const reader = (await renderTransfer(session, router)).body!.getReader();
      const shell = await reader.read();
      const prefix = new TextDecoder().decode(shell.value);
      expect(prefix).toContain('stream shell');
      source.resolve(createValue());
      const result = await consume(reader, prefix);
      expect(result.html).not.toContain(privateMarker);
      expect(result.error).toBeInstanceOf(Error);
      expect((await session.completion).state).toBe('failed');
      expect((await session.completion).cacheEligible).toBe(false);
      expect(session.committedPolicy?.status).toBe(200);
    },
  );

  test('a deferred accessor is rejected without evaluating it after the shell', async () => {
    const source = deferred<unknown>();
    const session = createSession();
    const router = await loadedRouter(session, {
      ready: publicMarker,
      later: source.promise,
    });
    let getterCalls = 0;
    const reader = (await renderTransfer(session, router)).body!.getReader();
    const prefix = new TextDecoder().decode((await reader.read()).value);
    source.resolve(
      Object.defineProperty({}, 'token', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return privateMarker;
        },
      }),
    );
    const result = await consume(reader, prefix);
    expect(getterCalls).toBe(0);
    expect(result.html).not.toContain(privateMarker);
    expect(result.error).toBeInstanceOf(Error);
    expect((await session.completion).state).toBe('failed');
    expect((await session.completion).cacheEligible).toBe(false);
  });

  test.each(mutableContainers)(
    'native deferred %s fails the immutable UI boundary after the shell',
    async (_name, createValue) => {
      const source = deferred<unknown>();
      const session = createSession();
      const router = await loadedRouter(session, {
        ready: publicMarker,
        later: source.promise,
      });
      const reader = (await renderTransfer(session, router)).body!.getReader();
      const prefix = new TextDecoder().decode((await reader.read()).value);
      expect(prefix).toContain('stream shell');
      source.resolve(createValue());
      const result = await consume(reader, prefix);
      expect(result.error).toBeInstanceOf(Error);
      expect((await session.completion).state).toBe('failed');
      expect((await session.completion).cacheEligible).toBe(false);
    },
  );

  test('an array accessor is refused before native hydration can read its index', async () => {
    let getterCalls = 0;
    const array = Object.defineProperty([], '0', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return privateMarker;
      },
    });
    const session = createSession();
    const router = await loadedRouter(session, { array });
    await expect(renderTransfer(session, router)).rejects.toThrow();
    expect(getterCalls).toBe(0);
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test('deferred validation cannot be bypassed by a later fulfillment callback mutating the original value', async () => {
    const source = deferred<unknown>();
    const original = { ready: publicMarker, later: source.promise };
    const session = createSession();
    const router = await loadedRouter(session, original);
    let getterCalls = 0;
    const response = await renderDocumentApplication({
      session,
      view: () => {
        preparePublicLoaderData(original);
        void source.promise.then(value => {
          if (!value || typeof value !== 'object') return;
          Object.defineProperty(value, 'token', {
            enumerable: true,
            get() {
              getterCalls += 1;
              return privateMarker;
            },
          });
        });
        serializeMatchTransfer(router);
        return ssr('<main>stream shell</main>');
      },
    });
    const reader = response.body!.getReader();
    const prefix = new TextDecoder().decode((await reader.read()).value);
    source.resolve({ value: 'public-before-mutation' });
    const result = await consume(reader, prefix);
    expect(getterCalls).toBe(0);
    expect(result.html).not.toContain(privateMarker);
  });

  test.each(forbidden)(
    'native Promise state rejects %s after the document shell',
    async (_name, createValue) => {
      const source = deferred<unknown>();
      const session = createSession();
      let handle: Promise<unknown> | undefined;
      const router = createDataRouter(
        session,
        () => ({ ready: publicMarker, later: source.promise }),
        undefined,
        () => {
          const data = useLoaderData({ strict: false })();
          handle = Object.getOwnPropertyDescriptor(data, 'later')?.value;
          const memo = createMemo(() => handle!);
          return createComponent(Loading, {
            fallback: ssr('<p>native-state shell</p>'),
            get children() {
              return ssr(['<p>', '</p>'], () => memo());
            },
          });
        },
      );
      await router.load();
      const reader = (
        await renderDocumentApplication({
          session,
          view: () => createComponent(ApplicationRouter, { router }),
        })
      ).body!.getReader();
      const prefix = new TextDecoder().decode((await reader.read()).value);
      expect(prefix).toContain('native-state shell');
      if (!handle) throw new Error('Expected a managed native Promise handle.');
      expect(Object.isSealed(handle)).toBe(true);
      Reflect.set(handle, 's', 1);
      expect(() => Reflect.set(handle!, 'v', createValue())).toThrow();
      const result = await consume(reader, prefix);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.html).not.toContain(privateMarker);
      expect((await session.completion).state).toBe('failed');
      expect((await session.completion).cacheEligible).toBe(false);
      expect(Reflect.ownKeys(source.promise)).toEqual([]);
      source.resolve({ value: 'late-public-fulfillment' });
    },
  );

  test('native Promise state rejects an accessor without evaluating it after the document shell', async () => {
    const source = deferred<unknown>();
    const session = createSession();
    let handle: Promise<unknown> | undefined;
    let getterCalls = 0;
    const router = createDataRouter(
      session,
      () => ({ later: source.promise }),
      undefined,
      () => {
        const data = useLoaderData({ strict: false })();
        handle = Object.getOwnPropertyDescriptor(data, 'later')?.value;
        const memo = createMemo(() => handle!);
        return createComponent(Loading, {
          fallback: ssr('<p>native-state shell</p>'),
          get children() {
            return ssr(['<p>', '</p>'], () => memo());
          },
        });
      },
    );
    await router.load();
    const reader = (
      await renderDocumentApplication({
        session,
        view: () => createComponent(ApplicationRouter, { router }),
      })
    ).body!.getReader();
    const prefix = new TextDecoder().decode((await reader.read()).value);
    if (!handle) throw new Error('Expected a managed native Promise handle.');
    expect(
      Reflect.defineProperty(handle, 'v', {
        get() {
          getterCalls += 1;
          return privateMarker;
        },
      }),
    ).toBe(false);
    Reflect.set(handle, 's', 1);
    const payload = Object.defineProperty({}, 'token', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return privateMarker;
      },
    });
    expect(() => Reflect.set(handle!, 'v', payload)).toThrow();
    const result = await consume(reader, prefix);
    expect(result.error).toBeInstanceOf(Error);
    expect(getterCalls).toBe(0);
    expect(result.html).not.toContain(privateMarker);
    expect((await session.completion).state).toBe('failed');
    expect(Reflect.ownKeys(source.promise)).toEqual([]);
    source.resolve({ value: 'late-public-fulfillment' });
  });

  test('native direct and async memo safely consume a canonical immutable Promise state value', async () => {
    const source = deferred<unknown>();
    const session = createSession();
    const authoredState = {
      value: 'native-public-state-value',
      nested: ['native-public-state-array'],
    };
    let getterCalls = 0;
    const router = createDataRouter(
      session,
      () => ({ later: source.promise }),
      undefined,
      () => {
        const data = useLoaderData({ strict: false })();
        const handle = Object.getOwnPropertyDescriptor(data, 'later')?.value;
        expect(Object.isSealed(handle)).toBe(true);
        expect(Reflect.set(handle, 's', 1)).toBe(true);
        expect(Reflect.set(handle, 'v', authoredState)).toBe(true);
        Object.defineProperty(authoredState, 'token', {
          enumerable: true,
          get() {
            getterCalls += 1;
            return privateMarker;
          },
        });
        const direct = createMemo(() => handle);
        const selected = direct();
        expect(selected === authoredState).toBe(false);
        expect(getterCalls).toBe(0);
        expect(Object.isFrozen(selected)).toBe(true);
        expect(
          Object.isFrozen(
            Object.getOwnPropertyDescriptor(selected, 'nested')?.value,
          ),
        ).toBe(true);
        const memo = createMemo(async () => direct());
        return createComponent(Loading, {
          fallback: ssr('<p>native-state shell</p>'),
          get children() {
            return ssr(['<p>', '</p>'], () => memo().value);
          },
        });
      },
    );
    await router.load();
    const reader = (
      await renderDocumentApplication({
        session,
        view: () => createComponent(ApplicationRouter, { router }),
      })
    ).body!.getReader();
    const prefix = new TextDecoder().decode((await reader.read()).value);
    source.resolve({ value: 'native-public-actual-fulfillment' });
    const result = await consume(reader, prefix);
    expect(result.error).toBeUndefined();
    expect(getterCalls).toBe(0);
    expect(result.html).toContain('native-public-state-value');
    expect(result.html).toContain('native-public-state-array');
    expect(result.html).toContain('native-public-actual-fulfillment');
    expect(result.html).not.toContain(privateMarker);
    expect(Object.isFrozen(authoredState)).toBe(false);
    expect(Object.isFrozen(authoredState.nested)).toBe(false);
    expect(Reflect.ownKeys(source.promise)).toEqual([]);
    expect((await session.completion).state).toBe('completed');
  });

  test('native Promise state fails closed for unsupported async iterable state', async () => {
    const source = deferred<unknown>();
    const session = createSession();
    const router = await loadedRouter(session, { later: source.promise });
    const data = router.state.matches.at(-1)?.loaderData;
    const handle = Object.getOwnPropertyDescriptor(data, 'later')?.value;
    expect(() => Reflect.set(handle, 's', 3)).toThrow(
      /AsyncIterable values are not supported/,
    );
    await expect(renderTransfer(session, router)).rejects.toThrow();
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
    expect(Reflect.ownKeys(source.promise)).toEqual([]);
    source.resolve({ value: 'late-public-fulfillment' });
  });

  test.each(['direct', 'await'] as const)(
    'an already fulfilled checked Promise supports native %s memo and match transfer',
    async memoKind => {
      const authored = {
        value: 'native-already-fulfilled-value',
        nested: ['native-already-fulfilled-array'],
      };
      const source = Promise.resolve(authored);
      const session = createSession();
      const router = createDataRouter(
        session,
        () => ({ ready: publicMarker, later: source }),
        undefined,
        () => {
          const data = useLoaderData({ strict: false })();
          const handle = Object.getOwnPropertyDescriptor(data, 'later')?.value;
          expect(Object.isSealed(handle)).toBe(true);
          expect(handle === source).toBe(false);
          const memo =
            memoKind === 'direct'
              ? createMemo(() => handle)
              : createMemo(async () => await handle);
          return createComponent(Loading, {
            fallback: ssr('<p>already fulfilled fallback</p>'),
            get children() {
              return ssr(['<p>', '</p>'], () => memo().value);
            },
          });
        },
      );
      await router.load();
      const html = await (
        await renderDocumentApplication({
          session,
          view: () => createComponent(ApplicationRouter, { router }),
        })
      ).text();
      expect(html).toContain(MATCH_KEY_PREFIX);
      expect(html).toContain(publicMarker);
      expect(html).toContain('native-already-fulfilled-value');
      expect(html).toContain('native-already-fulfilled-array');
      expect(Object.isFrozen(authored)).toBe(false);
      expect(Object.isFrozen(authored.nested)).toBe(false);
      expect(Reflect.ownKeys(source)).toEqual([]);
      expect((await session.completion).state).toBe('completed');
    },
  );

  test.each([
    ['authored', 'direct'],
    ['authored', 'await'],
    ['published', 'direct'],
    ['published', 'await'],
  ] as const)(
    'managed data blocks %s Promise mutation during native %s memo hydration',
    async (mutationTarget, memoKind) => {
      const source = deferred<{ value: string }>();
      const session = createSession();
      const critical = {
        ready: publicMarker,
        details: {
          title: 'public-managed-critical',
          tags: ['public-managed-array'],
        },
        nullRecord: Object.assign(Object.create(null), {
          tag: 'public-null-record',
        }),
      };
      const outcome: DataOutcome = {
        kind: 'deferred',
        critical,
        deferred: { later: source.promise },
        response: {
          status: 200,
          statusText: 'OK',
          headers: [],
          cachePolicy: 'public',
        },
      };
      const routes: FileSystemRouteIR[] = [
        {
          id: 'layout',
          isRoot: true,
          children: [
            {
              id: 'item',
              path: 'item',
              modules: { data: '/item.data.ts' },
              children: [],
            },
          ],
        },
      ];
      let getterCalls = 0;
      const routeTree = createFileSystemRouteTree(
        routes,
        {
          item: {
            component: () => {
              const data = useLoaderData({ strict: false })();
              if (!data || typeof data !== 'object')
                throw new Error('Expected managed native loader data.');
              expect(Object.isFrozen(data)).toBe(true);
              const details = Object.getOwnPropertyDescriptor(
                data,
                'details',
              )?.value;
              expect(Object.isFrozen(details)).toBe(true);
              const tags = Object.getOwnPropertyDescriptor(
                details,
                'tags',
              )?.value;
              expect(Array.isArray(tags)).toBe(true);
              expect(Object.isFrozen(tags)).toBe(true);
              expect(Reflect.set(tags, '0', privateMarker)).toBe(false);
              const nullRecord = Object.getOwnPropertyDescriptor(
                data,
                'nullRecord',
              )?.value;
              expect(Object.getPrototypeOf(nullRecord)).toBeNull();
              expect(Object.isFrozen(nullRecord)).toBe(true);
              const promise = Object.getOwnPropertyDescriptor(
                data,
                'later',
              )?.value;
              if (!(promise instanceof Promise))
                throw new Error('Expected a checked public view Promise.');
              expect(promise).not.toBe(source.promise);
              const mutationPromise =
                mutationTarget === 'authored' ? source.promise : promise;
              void mutationPromise
                .then((value: unknown) => {
                  if (!value || typeof value !== 'object') return;
                  Object.defineProperty(value, 'privateToken', {
                    enumerable: true,
                    get() {
                      getterCalls += 1;
                      return privateMarker;
                    },
                  });
                })
                .catch(() => {});
              const memo =
                memoKind === 'direct'
                  ? createMemo(() => promise)
                  : createMemo(async () => await promise);
              return createComponent(Loading, {
                fallback: ssr('<p>waiting native memo</p>'),
                get children() {
                  return ssr(['<p>', '</p>'], () => memo().value);
                },
              });
            },
          },
        },
        {
          request: session.request,
          session,
          loadRoute: async () => outcome,
        },
      );
      const router = createApplicationRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/item'] }),
        isServer: true,
      });
      await router.load();
      expect(router.state.matches.at(-1)?.error).toBeUndefined();
      critical.ready = privateMarker;
      critical.details.title = privateMarker;
      critical.details.tags.push(privateMarker);
      const response = await renderDocumentApplication({
        session,
        view: () => createComponent(ApplicationRouter, { router }),
      });
      const reader = response.body!.getReader();
      const prefix = new TextDecoder().decode((await reader.read()).value);
      expect(prefix).toContain('waiting native memo');
      const authored = { value: 'public-native-view' };
      source.resolve(authored);
      const result = await consume(reader, prefix);
      expect(getterCalls).toBe(0);
      expect(result.html).not.toContain(privateMarker);
      expect(result.html).toContain(publicMarker);
      expect(result.html).toContain('public-managed-critical');
      expect(result.html).toContain('public-managed-array');
      expect(result.html).toContain('public-null-record');
      expect(Object.isFrozen(critical)).toBe(false);
      expect(Object.isFrozen(critical.details)).toBe(false);
      expect(Object.isFrozen(critical.details.tags)).toBe(false);
      expect(Object.isFrozen(authored)).toBe(false);
      if (mutationTarget === 'authored') {
        expect(
          Object.getOwnPropertyDescriptor(authored, 'privateToken')?.get,
        ).toBeInstanceOf(Function);
        expect(result.error).toBeUndefined();
        expect(result.html).toContain('public-native-view');
        expect((await session.completion).state).toBe('completed');
      } else {
        expect(
          Object.getOwnPropertyDescriptor(authored, 'privateToken'),
        ).toBeUndefined();
        if (result.error)
          expect((await session.completion).cacheEligible).toBe(false);
        else expect(result.html).toContain('public-native-view');
      }
      expect(outcome.deferred.later).toBe(source.promise);
    },
  );

  test('NoHydration performs no match-state write or loader-value getter reads', async () => {
    let getterCalls = 0;
    const session = createSession();
    const authored = { value: publicMarker };
    const router = await loadedRouter(session, authored);
    Object.defineProperty(authored, 'token', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return privateMarker;
      },
    });
    const native = renderToStream(() =>
      createComponent(NoHydration, {
        get children() {
          serializeMatchTransfer(router);
          return ssr('<main>unhydrated</main>');
        },
      }),
    );
    const html = await new Response(native.readable).text();
    expect(html).toContain('unhydrated');
    expect(html).not.toContain(MATCH_KEY_PREFIX);
    expect(html).not.toContain(privateMarker);
    expect(getterCalls).toBe(0);
  });

  test('an unloaded native router produces no half-primed match transfer', async () => {
    let loaderCalls = 0;
    const session = createSession();
    const router = createDataRouter(session, () => {
      loaderCalls += 1;
      return { value: 'not loaded' };
    });
    const html = await (await renderTransfer(session, router)).text();
    expect(html).not.toContain(MATCH_KEY_PREFIX);
    expect(loaderCalls).toBe(0);
  });
});
