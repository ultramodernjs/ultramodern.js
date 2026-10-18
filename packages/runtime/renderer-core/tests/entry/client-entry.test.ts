import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import { RENDERER_BOOTSTRAP_ID } from '../../src/document';
import {
  type NativeClientAdapter,
  type NativeClientView,
  type NativeEntryI18n,
  startNativeClientEntry,
} from '../../src/entry-client';
import type { RendererIdentity } from '../../src/identity';
import type {
  NativeRoutedApplication,
  NativeRouterOptions,
} from '../../src/router';

const identity: RendererIdentity = {
  renderer: 'octane',
  appId: 'client-entry',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'client-entry-build',
};

const root = { id: 'root' } as unknown as HTMLElement;

function installDocument(bootstrap: boolean, mount = true, rootId = 'root') {
  Reflect.set(globalThis, 'document', {
    getElementById: (id: string) =>
      id === rootId && mount
        ? root
        : id === RENDERER_BOOTSTRAP_ID && bootstrap
          ? {}
          : null,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

interface Instance {
  readonly language: string;
}

interface Bootstrap {
  readonly identity: RendererIdentity;
  readonly documentId: string;
  readonly hydrating: boolean;
}

function recordingAdapter(expectedBootstrap = true) {
  const routers: {
    application: NativeRoutedApplication;
    options: NativeRouterOptions;
  }[] = [];
  const prepared: { hydrating: boolean; signal: AbortSignal }[] = [];
  const views: NativeClientView<object, Instance, never>[] = [];
  const disposed = rstest.fn();
  const disposeRouter = rstest.fn<(router: object) => void>();
  let started!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const adapter: NativeClientAdapter<Bootstrap, object, Instance, never> = {
    readBootstrap: (_document, expected) => ({
      identity: expected,
      documentId: 'document',
      hydrating: true,
    }),
    createRouter(application, options) {
      routers.push({ application, options });
      return { subscribe: () => () => {} };
    },
    disposeRouter,
    async prepareRouter(_router, hydrating, signal) {
      prepared.push({ hydrating, signal });
    },
    async start({ root: element, bootstrap, load }) {
      expect(element).toBe(root);
      expect(bootstrap?.documentId).toBe(
        expectedBootstrap ? 'document' : undefined,
      );
      views.push(await load());
      started();
      return disposed;
    },
  };
  return { adapter, routers, prepared, views, disposed, disposeRouter, ready };
}

const pageLoader = async () => ({ page: true });
const routed: NativeRoutedApplication = {
  basePath: '/',
  routeIR: [{ id: 'layout', isRoot: true, children: [] }],
  routeModules: {},
  dataModules: { page: { loader: pageLoader } },
  serverDataRoutes: ['layout'],
};

describe('generated native client entry', () => {
  it('requires the mount element', () => {
    installDocument(false, false);
    expect(() =>
      startNativeClientEntry(
        { identity, load: async () => ({ default: null }) },
        recordingAdapter().adapter,
      ),
    ).toThrow('The native application mount element is missing');
  });

  it('starts a localized router from the server handoff and hydrates it', async () => {
    installDocument(true);
    const { adapter, routers, prepared, views, ready } = recordingAdapter();
    const synced: unknown[] = [];
    const rewrite = { input: () => undefined };
    const i18n: NativeEntryI18n<Instance, never> = {
      languages: ['en', 'cs'],
      resolveRequest: () => ({ kind: 'language', language: 'cs' }),
      redirect: () => new Response(null),
      create: async (language, resources) => {
        expect(resources).toEqual({ translation: { title: 'Ahoj' } });
        return { language };
      },
      rewrite: getLanguage => {
        expect(getLanguage()).toBe('cs');
        return rewrite;
      },
      handoff: () => ({ id: 'handoff', payload: '{}' }),
      clientHandoff: () => ({
        language: 'cs',
        resources: { translation: { title: 'Ahoj' } },
      }),
      syncWithRouter: (router, instance) => {
        synced.push(router, instance);
        return () => {};
      },
    };
    startNativeClientEntry(
      { identity, load: async () => routed, i18n },
      adapter,
    );
    await ready;
    expect(routers[0].application).toBe(routed);
    expect(routers[0].options).toMatchObject({ identity, rewrite });
    expect(Object.isFrozen(routers[0].options.identity)).toBe(true);
    expect(prepared[0].hydrating).toBe(true);
    expect(synced).toEqual([
      expect.objectContaining({ subscribe: expect.any(Function) }),
      { language: 'cs' },
    ]);
    expect(views[0]).toMatchObject({
      kind: 'router',
      i18n: { instance: { language: 'cs' }, languages: ['en', 'cs'] },
    });
    // Client loaders run in the browser; server-only data has no loader here.
    const { loadRoute } = routers[0].options;
    const input = {
      request: new Request('https://example.test/'),
      routeId: 'page',
      params: {},
      context: undefined,
    };
    await expect(
      loadRoute({ id: 'page', children: [] }, input),
    ).resolves.toMatchObject({ kind: 'success', value: { page: true } });
    await expect(
      loadRoute({ id: 'other', children: [] }, input),
    ).resolves.toEqual({ kind: 'success', value: undefined, status: 200 });
  });

  it.each([true, false])(
    'localizes a component application from the document handoff when hydrating is %s',
    async hydrating => {
      installDocument(hydrating);
      const { adapter, routers, prepared, views, ready } =
        recordingAdapter(hydrating);
      const instance = { language: 'cs' };
      const resources = { translation: { title: 'Ahoj' } };
      const create = rstest.fn(async () => instance);
      const rewrite = rstest.fn(() => ({}));
      const syncWithRouter = rstest.fn();
      const i18n: NativeEntryI18n<Instance, never> = {
        languages: ['en', 'cs'],
        resolveRequest: () => ({ kind: 'language', language: 'cs' }),
        redirect: () => new Response(null),
        create,
        rewrite,
        handoff: () => ({ id: 'handoff', payload: '{}' }),
        clientHandoff: () => ({ language: 'cs', resources }),
        syncWithRouter,
      };
      const component = () => null;
      startNativeClientEntry(
        { identity, load: async () => ({ default: component }), i18n },
        adapter,
      );
      await ready;
      expect(create).toHaveBeenCalledExactlyOnceWith('cs', resources);
      expect(views[0]).toMatchObject({
        kind: 'component',
        component,
        i18n: { instance, languages: ['en', 'cs'] },
      });
      expect(views[0].i18n?.instance).toBe(instance);
      expect(routers).toEqual([]);
      expect(prepared).toEqual([]);
      expect(rewrite).not.toHaveBeenCalled();
      expect(syncWithRouter).not.toHaveBeenCalled();
    },
  );

  it('cancels startup and disposes the root when the entry is replaced', async () => {
    installDocument(false);
    const { adapter, disposed, prepared } = recordingAdapter();
    let dispose!: () => void;
    let release!: (application: NativeRoutedApplication) => void;
    startNativeClientEntry(
      {
        identity,
        load: () =>
          new Promise(resolve => {
            release = resolve;
          }),
        hot: { dispose: (callback: () => void) => (dispose = callback) },
      },
      {
        ...adapter,
        readBootstrap: () => {
          throw new Error('A CSR document has no bootstrap');
        },
        async start(input) {
          expect(input.bootstrap).toBeUndefined();
          const loading = input.load();
          dispose();
          expect(input.signal.aborted).toBe(true);
          release(routed);
          await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
          return disposed;
        },
      },
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(prepared).toEqual([]);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('releases a replaced entry whose application import never settles', async () => {
    installDocument(false);
    const { adapter, disposed } = recordingAdapter();
    let dispose!: () => void;
    let importing!: () => void;
    const importStarted = new Promise<void>(resolve => {
      importing = resolve;
    });
    let outcome: unknown;
    startNativeClientEntry(
      {
        identity,
        load: () => {
          importing();
          return new Promise(() => {});
        },
        hot: { dispose: (callback: () => void) => (dispose = callback) },
      },
      {
        ...adapter,
        readBootstrap: () => {
          throw new Error('A CSR document has no bootstrap');
        },
        async start(input) {
          outcome = await input.load().catch(error => error);
          return disposed;
        },
      },
    );
    await importStarted;
    dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(outcome).toMatchObject({ name: 'AbortError' });
  });

  it('releases a replaced entry whose initial router load ignores the signal', async () => {
    installDocument(false);
    const { adapter, disposed, disposeRouter } = recordingAdapter();
    let dispose!: () => void;
    let loading!: () => void;
    const loadStarted = new Promise<void>(resolve => {
      loading = resolve;
    });
    let outcome: unknown;
    startNativeClientEntry(
      {
        identity,
        load: async () => routed,
        hot: { dispose: (callback: () => void) => (dispose = callback) },
      },
      {
        ...adapter,
        readBootstrap: () => {
          throw new Error('A CSR document has no bootstrap');
        },
        prepareRouter: () => {
          loading();
          // A route loader that never settles and never observes the signal.
          return new Promise<void>(() => {});
        },
        async start(input) {
          outcome = await input.load().catch(error => error);
          return disposed;
        },
      },
    );
    await loadStarted;
    dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(disposeRouter).toHaveBeenCalledTimes(1);
  });

  it('releases its router when startup fails before mounting the root', async () => {
    installDocument(false);
    const { adapter, disposed, disposeRouter } = recordingAdapter(false);
    const router = {};
    const failure = new Error('The initial route could not load');
    const reported = Promise.withResolvers<() => void>();
    const queue = rstest
      .spyOn(globalThis, 'queueMicrotask')
      .mockImplementation(callback => reported.resolve(callback));
    try {
      startNativeClientEntry(
        { identity, load: async () => routed },
        {
          ...adapter,
          createRouter: () => router,
          async prepareRouter() {
            throw failure;
          },
        },
      );
      const report = await reported.promise;
      expect(disposeRouter).toHaveBeenCalledExactlyOnceWith(router);
      expect(disposed).not.toHaveBeenCalled();
      expect(report).toThrow(failure);
    } finally {
      queue.mockRestore();
    }
  });

  it('persists language changes for a component application until the entry is replaced', async () => {
    installDocument(false);
    const { adapter } = recordingAdapter(false);
    const stopPersist = rstest.fn();
    const persist = rstest.fn(() => stopPersist);
    let dispose!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    startNativeClientEntry(
      {
        identity,
        load: async () => ({ default: () => null }),
        hot: { dispose: (callback: () => void) => (dispose = callback) },
        i18n: {
          languages: ['en', 'cs'],
          resolveRequest: () => ({ kind: 'language', language: 'en' }),
          redirect: () => new Response(null),
          create: async language => ({ language }),
          rewrite: () => ({}),
          handoff: () => ({ id: 'handoff', payload: '{}' }),
          clientHandoff: () => ({ language: 'en' }),
          syncWithRouter: () => () => {},
          persist,
        },
      },
      {
        ...adapter,
        readBootstrap: () => {
          throw new Error('A CSR document has no bootstrap');
        },
        async start(input) {
          expect((await input.load()).kind).toBe('component');
          started();
          return () => {};
        },
      },
    );
    await ready;
    expect(persist).toHaveBeenCalledWith({ language: 'en' });
    expect(stopPersist).not.toHaveBeenCalled();
    dispose();
    expect(stopPersist).toHaveBeenCalledTimes(1);
  });

  it('stops i18n router sync when the entry is replaced', async () => {
    installDocument(false);
    const { adapter } = recordingAdapter();
    const stop = rstest.fn();
    let dispose!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    startNativeClientEntry(
      {
        identity,
        load: async () => routed,
        hot: { dispose: (callback: () => void) => (dispose = callback) },
        i18n: {
          languages: ['en', 'cs'],
          resolveRequest: () => ({ kind: 'language', language: 'en' }),
          redirect: () => new Response(null),
          create: async language => ({ language }),
          rewrite: () => ({}),
          handoff: () => ({ id: 'handoff', payload: '{}' }),
          clientHandoff: () => ({ language: 'en' }),
          syncWithRouter: () => stop,
        },
      },
      {
        ...adapter,
        readBootstrap: () => {
          throw new Error('A CSR document has no bootstrap');
        },
        async start(input) {
          await input.load();
          started();
          return () => {};
        },
      },
    );
    await ready;
    expect(stop).not.toHaveBeenCalled();
    dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('mounts into a configured root id', async () => {
    installDocument(false, true, 'application');
    const { adapter, ready } = recordingAdapter(false);
    expect(() =>
      startNativeClientEntry(
        { identity, load: async () => routed, rootId: 'application' },
        adapter,
      ),
    ).not.toThrow();
    await ready;
    expect(() =>
      startNativeClientEntry(
        { identity, load: async () => routed },
        recordingAdapter(false).adapter,
      ),
    ).toThrow('The native application mount element is missing');
  });
});
