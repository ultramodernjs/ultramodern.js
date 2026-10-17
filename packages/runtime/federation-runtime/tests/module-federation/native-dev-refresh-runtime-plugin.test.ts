import { createServer } from 'node:http';
import nativeDevRefreshRuntimePlugin from '../../src/module-federation/native-dev-refresh-runtime-plugin';

const header = 'x-ultramodern-mf-revision';
const v1 = '1'.repeat(64);
const v2 = '2'.repeat(64);
const remote = {
  name: 'catalog',
  alias: 'store',
  entry: 'https://catalog.example/mf-manifest.json',
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(shared?: readonly string[]) {
  const plugin = nativeDevRefreshRuntimePlugin({
    remotes: [remote],
    revisionHeader: header,
    requestTimeout: 50,
    shared,
  });
  let revision: string | null = v1;
  let status = 200;
  let failure: Error | undefined;
  let delay: Promise<void> | undefined;
  let onAdmitted: (() => void) | undefined;
  let probeDelay: Promise<void> | undefined;
  let admitted = 0;
  let factories = 0;
  let cached: { revision: string | null; singleton: object } | undefined;
  const singleton = {};
  const registrations: unknown[] = [];
  const requests: RequestInit[] = [];
  const host = {
    async loadRemote<T>(id: string, options?: unknown): Promise<T | null> {
      if (id === 'external/Widget') return options as T;
      await plugin.beforeRequest({ origin: host, id });
      await plugin.afterResolve({
        origin: host,
        remote: { name: remote.name },
        remoteInfo: {
          name: remote.name,
          entry: 'https://catalog.example/bundles/remoteEntry.js',
        },
        remoteSnapshot: { revision },
        expose: './Widget',
      });
      if (!cached) {
        admitted++;
        factories++;
        cached = { revision, singleton };
      }
      const current = cached;
      onAdmitted?.();
      await delay;
      if (failure) throw failure;
      return current as T;
    },
    registerRemotes(remotes: unknown[], options: unknown) {
      registrations.push({ remotes, options });
      cached = undefined;
    },
    loaderHook: {
      lifecycle: {
        fetch: {
          async emit(_url: string, init: RequestInit) {
            requests.push(init);
            await probeDelay;
            return new Response(null, {
              status,
              headers: revision === null ? {} : { [header]: revision },
            });
          },
        },
      },
    },
  };
  plugin.beforeInit({ origin: host });
  return {
    host,
    plugin,
    singleton,
    registrations,
    requests,
    counts: () => ({ admitted, factories }),
    change(value: string | null) {
      revision = value;
    },
    status(value: number) {
      status = value;
    },
    fail(value?: Error) {
      failure = value;
    },
    delay(value?: Promise<void>, admitted?: () => void) {
      delay = value;
      onAdmitted = admitted;
    },
    probeDelay(value?: Promise<void>) {
      probeDelay = value;
    },
  };
}

describe('native Node federation development refresh', () => {
  test('an authored share hook may await a same-remote load before refresh evicts its generation', async () => {
    const fixture = harness(['octane/']);
    let nested: unknown;
    Object.assign(fixture.host, {
      shareScopeMap: {
        default: { 'octane/server': { '0.7.1': { loaded: true } } },
      },
      async loadShare() {
        nested = await fixture.host.loadRemote('store/Other');
        return () => ({});
      },
    });
    await fixture.host.loadRemote('store/Widget');
    fixture.change(v2);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const refreshed = await Promise.race([
        fixture.host.loadRemote('store/Widget'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('share hook deadlock')),
            100,
          );
        }),
      ]);
      expect(nested).toMatchObject({ revision: v1 });
      expect(refreshed).toMatchObject({ revision: v2 });
      expect(fixture.registrations).toHaveLength(1);
    } finally {
      clearTimeout(timer);
    }
  });

  test('records loaded renderer providers as host uses before eviction and retries a failed retention', async () => {
    const fixture = harness([
      'octane/',
      '@modern-js/renderer-octane/federation',
    ]);
    const calls: string[] = [];
    const get = () => () => ({});
    let fail = true;
    Object.assign(fixture.host, {
      shareScopeMap: {
        default: {
          'octane/server': { '0.7.1': { loaded: true, lib: get } },
          'octane/internal/server': {
            '0.7.1': { loading: Promise.resolve(get) },
          },
          'octane/unused': { '0.7.1': { get } },
          '@modern-js/renderer-octane/federation': { '3.8.3': { lib: get } },
          'application-shared': { '1.0.0': { loaded: true, lib: get } },
        },
      },
      async loadShare(pkgName: string) {
        expect(fixture.registrations).toEqual([]);
        calls.push(pkgName);
        if (pkgName === 'octane/internal/server' && fail)
          throw new Error('provider retention failed');
        return get;
      },
    });
    await fixture.host.loadRemote('store/Widget');
    expect(calls).toEqual([]);
    fixture.change(v2);
    await expect(fixture.host.loadRemote('store/Widget')).rejects.toThrow(
      'provider retention failed',
    );
    expect(fixture.registrations).toEqual([]);
    expect(fixture.counts()).toEqual({ admitted: 1, factories: 1 });
    fail = false;
    expect(await fixture.host.loadRemote('store/Widget')).toMatchObject({
      revision: v2,
    });
    expect(calls).toEqual([
      'octane/server',
      'octane/internal/server',
      'octane/server',
      'octane/internal/server',
      '@modern-js/renderer-octane/federation',
    ]);
    expect(fixture.registrations).toHaveLength(1);
  });

  test('refreshes only a changed completed graph and preserves the native host singleton', async () => {
    const fixture = harness();
    const first = await fixture.host.loadRemote<{
      revision: string;
      singleton: object;
    }>('store/Widget');
    expect(first?.revision).toBe(v1);
    await fixture.host.loadRemote('catalog/Widget');
    expect(fixture.registrations).toEqual([]);
    expect(fixture.counts()).toEqual({ admitted: 1, factories: 1 });
    fixture.change(v2);
    const changed = await fixture.host.loadRemote<{
      revision: string;
      singleton: object;
    }>('store/Widget');
    expect(changed?.revision).toBe(v2);
    expect(changed?.singleton).toBe(first?.singleton);
    expect(fixture.registrations).toEqual([
      { remotes: [remote], options: { force: true } },
    ]);
    expect(fixture.counts()).toEqual({ admitted: 2, factories: 2 });
    expect(
      fixture.requests.every(
        request =>
          request.method === 'HEAD' &&
          request.signal &&
          request.cache === 'no-store',
      ),
    ).toBe(true);
  });

  test('unguarded resolutions cannot overwrite an in-flight refresh admission', async () => {
    const fixture = harness();
    await fixture.host.loadRemote('store/Widget');
    fixture.change(v2);
    const admitted = deferred();
    const finish = deferred();
    fixture.delay(finish.promise, () => admitted.resolve());
    const refresh = fixture.host.loadRemote('store/Widget');
    try {
      await admitted.promise;
      const probes = fixture.requests.length;
      fixture.change(v1);
      await fixture.plugin.afterResolve({
        origin: fixture.host,
        remote: { name: remote.name },
        remoteInfo: {
          name: remote.name,
          entry: 'https://catalog.example/unguarded/remoteEntry.js',
        },
        remoteSnapshot: { revision: v1 },
        expose: './Widget',
      });
      expect(fixture.requests).toHaveLength(probes);
    } finally {
      fixture.change(v2);
      fixture.delay();
      finish.resolve();
      await refresh;
    }
    expect(await fixture.host.loadRemote('store/Widget')).toMatchObject({
      revision: v2,
    });
    // The guarded v2 admission remains committed, so it is not evicted again.
    expect(fixture.registrations).toHaveLength(1);
    expect(fixture.counts()).toEqual({ admitted: 2, factories: 2 });
  });

  test('coalesces concurrent probes and admits a changed container once', async () => {
    const fixture = harness();
    await fixture.host.loadRemote('store/Widget');
    fixture.change(v2);
    const gate = deferred();
    fixture.probeDelay(gate.promise);
    const before = fixture.requests.length;
    const loads = ['Widget', 'Other', 'Widget'].map(name =>
      fixture.host.loadRemote<{ revision: string }>(`store/${name}`),
    );
    await Promise.resolve();
    expect(fixture.requests.length).toBe(before + 1);
    gate.resolve();
    expect((await Promise.all(loads)).map(value => value?.revision)).toEqual([
      v2,
      v2,
      v2,
    ]);
    expect(fixture.registrations).toHaveLength(1);
    expect(fixture.counts().admitted).toBe(2);
  });

  test('lets old native loads finish before evicting and blocks new loads at the transition', async () => {
    const fixture = harness();
    await fixture.host.loadRemote('store/Widget');
    const oldGate = deferred();
    fixture.delay(oldGate.promise);
    const old = fixture.host.loadRemote<{ revision: string }>('store/Widget');
    await new Promise<void>(resolve => setImmediate(resolve));
    fixture.change(v2);
    fixture.delay();
    const fresh = fixture.host.loadRemote<{ revision: string }>('store/Other');
    const concurrent = fixture.host.loadRemote<{ revision: string }>(
      'store/Widget',
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.registrations).toEqual([]);
    oldGate.resolve();
    expect((await old)?.revision).toBe(v1);
    expect((await fresh)?.revision).toBe(v2);
    expect((await concurrent)?.revision).toBe(v2);
    expect(fixture.registrations).toHaveLength(1);
  });

  test('captures admitted assets before releasing an old load for force registration', async () => {
    const fixture = harness();
    await fixture.host.loadRemote('store/Widget');
    const gate = deferred();
    fixture.delay(gate.promise);
    const method = Reflect.get(
      fixture.host,
      Symbol.for('ultramodern.federation.load-with-capture'),
    );
    const old = method('store/Widget', (module: { revision: string }) => {
      expect(fixture.registrations).toEqual([]);
      return `${module.revision}.css`;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    fixture.change(v2);
    fixture.delay();
    const refreshed = fixture.host.loadRemote('store/Widget');
    await new Promise<void>(resolve => setImmediate(resolve));
    gate.resolve();
    expect((await old).captured).toBe(`${v1}.css`);
    expect(await refreshed).toMatchObject({ revision: v2 });
  });

  test('keeps healthy cache during unavailable probes and retries failed refresh admission', async () => {
    const fixture = harness();
    await fixture.host.loadRemote('store/Widget');
    fixture.status(503);
    await expect(fixture.host.loadRemote('store/Widget')).rejects.toMatchObject(
      { status: 503 },
    );
    expect(fixture.registrations).toEqual([]);
    fixture.status(200);
    expect(await fixture.host.loadRemote('store/Widget')).toMatchObject({
      revision: v1,
    });
    expect(fixture.counts().factories).toBe(1);
    fixture.change(v2);
    fixture.fail(new Error('new renderer contract rejected'));
    await expect(fixture.host.loadRemote('store/Widget')).rejects.toThrow(
      'new renderer contract rejected',
    );
    fixture.fail();
    expect(await fixture.host.loadRemote('store/Widget')).toMatchObject({
      revision: v2,
    });
    expect(fixture.registrations).toHaveLength(2);
  });

  test('retires a revision probe even if an authored fetch hook ignores its signal', async () => {
    const fixture = harness();
    await fixture.host.loadRemote('store/Widget');
    const late = deferred();
    fixture.probeDelay(late.promise);
    await expect(fixture.host.loadRemote('store/Widget')).rejects.toMatchObject(
      { name: 'TimeoutError' },
    );
    fixture.probeDelay();
    late.resolve();
    expect(await fixture.host.loadRemote('store/Widget')).toMatchObject({
      revision: v1,
    });
    expect(fixture.registrations).toEqual([]);
  });

  test('cancels a late authored response body after the probe deadline without retaining its rejection', async () => {
    const fixture = harness();
    await fixture.host.loadRemote('store/Widget');
    const late = deferred<Response>();
    const nativeFetch = fixture.host.loaderHook.lifecycle.fetch.emit;
    fixture.host.loaderHook.lifecycle.fetch.emit = async () => late.promise;
    await expect(fixture.host.loadRemote('store/Widget')).rejects.toMatchObject(
      { name: 'TimeoutError' },
    );
    let canceled = false;
    late.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
        { headers: { [header]: v1 } },
      ),
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(canceled).toBe(true);
    fixture.host.loaderHook.lifecycle.fetch.emit = nativeFetch;
    expect(await fixture.host.loadRemote('store/Widget')).toMatchObject({
      revision: v1,
    });
  });

  test('keeps non-development remotes cached and rejects lost or malformed positive revisions', async () => {
    const production = harness();
    production.change(null);
    await production.host.loadRemote('store/Widget');
    const requests = production.requests.length;
    await production.host.loadRemote('store/Widget');
    expect(production.requests).toHaveLength(requests);
    expect(production.registrations).toEqual([]);
    const development = harness();
    await development.host.loadRemote('store/Widget');
    development.change(null);
    await expect(development.host.loadRemote('store/Widget')).rejects.toThrow(
      'lost its completed graph revision',
    );
    development.change('invalid');
    await expect(development.host.loadRemote('store/Widget')).rejects.toThrow(
      'invalid graph revision',
    );
    expect(development.registrations).toEqual([]);
  });

  test('forwards unconfigured remote calls and load options to the native runtime', async () => {
    const fixture = harness();
    const options = { loadFactory: false };
    expect(await fixture.host.loadRemote('external/Widget', options)).toBe(
      options,
    );
    expect(fixture.requests).toEqual([]);
    const host = fixture.host.loadRemote;
    fixture.plugin.beforeInit({ origin: fixture.host });
    expect(fixture.host.loadRemote).toBe(host);
  });

  test('bounds an unavailable revision response through the native fetch lifecycle', async () => {
    const server = createServer(() => {});
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing test address');
    const plugin = nativeDevRefreshRuntimePlugin({
      remotes: [remote],
      revisionHeader: header,
      requestTimeout: 50,
    });
    const host = {
      async loadRemote<T>(): Promise<T | null> {
        await plugin.beforeRequest({ origin: host, id: 'store/Widget' });
        await plugin.afterResolve({
          origin: host,
          remote,
          remoteInfo: {
            name: remote.name,
            entry: `http://127.0.0.1:${address.port}/entry.js`,
          },
          remoteSnapshot: {},
          expose: './Widget',
        });
        return null;
      },
      registerRemotes() {},
      loaderHook: {
        lifecycle: {
          fetch: {
            emit: async (url: string, init: RequestInit) =>
              globalThis.fetch(url, init),
          },
        },
      },
    };
    plugin.beforeInit({ origin: host });
    try {
      await expect(host.loadRemote('store/Widget')).rejects.toMatchObject({
        name: 'TimeoutError',
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});
