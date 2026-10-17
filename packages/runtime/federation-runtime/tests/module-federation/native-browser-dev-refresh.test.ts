import {
  createNativeBrowserDevRefresh,
  isNativeBrowserDevCommitError,
  type NativeBrowserDevGraph,
  type NativeBrowserDevHost,
  nativeBrowserDevCommitFailure,
} from '../../src/module-federation/native-browser-dev-refresh';

const revision = (digit: string) => digit.repeat(64);
const graph = (digit: string): NativeBrowserDevGraph => ({
  revision: revision(digit),
  remote: {
    name: 'remote',
    alias: 'remote',
    entry: `https://remote.example/${revision(digit)}/mf-manifest.json`,
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness() {
  const provider = { loaded: true, lib: () => singleton, get: () => singleton };
  const singleton = {};
  const plugins = [{ name: 'normal-admission' }];
  const originalCache = new Map<string, unknown>([
    ['remote', {}],
    ['sibling', {}],
  ]);
  const host: NativeBrowserDevHost = {
    name: 'host',
    options: { plugins },
    shareScopeMap: { default: { octane: { '0.13.8': provider } } },
    moduleCache: originalCache,
    initShareScopeMap: () => {
      throw new Error('Original host must stay untouched.');
    },
    loadRemote: async () => {
      throw new Error('Original host must stay untouched.');
    },
  };
  const stages: {
    host: NativeBrowserDevHost;
    released: number;
    received: Readonly<Record<string, unknown>>;
  }[] = [];
  let load: () => Promise<(() => unknown) | null> = async () => () => ({
    singleton,
  });
  let factoryCalls = 0;
  let nativeCalls = 0;
  let commitFailure: Error | undefined;
  let releaseFailure: Error | undefined;
  let selectedBoundary: object | undefined;
  const boundary = {};
  const refresh = createNativeBrowserDevRefresh({
    host,
    id: 'remote/Widget',
    boundary,
    prepareReplacement(value) {
      selectedBoundary = value;
      let commitStarted = false;
      return {
        get commitStarted() {
          return commitStarted;
        },
        execute<T>(factory: () => T): T {
          nativeCalls++;
          factoryCalls++;
          const result = factory();
          if (result && typeof result === 'object' && 'then' in result)
            throw new Error(
              'Native capability rejects asynchronous factories.',
            );
          commitStarted = true;
          if (commitFailure) throw commitFailure;
          return result;
        },
      };
    },
    createHost(received) {
      const shareScopeMap: NativeBrowserDevHost['shareScopeMap'] = {};
      const stage = {
        received,
        released: 0,
        host: {
          name: String(received.name),
          options: received,
          shareScopeMap,
          moduleCache: new Map<string, unknown>([['candidate', {}]]),
          initShareScopeMap(name, scope) {
            this.shareScopeMap[name] = scope;
          },
          async loadRemote<T>(id: string, options: { loadFactory: false }) {
            expect(id).toBe('remote/Widget');
            expect(options).toEqual({ loadFactory: false });
            expect(factoryCalls).toBe(nativeCalls);
            return (await load()) as T | null;
          },
        } satisfies NativeBrowserDevHost,
      };
      stages.push(stage);
      return {
        host: stage.host,
        release() {
          stage.released++;
          if (releaseFailure) throw releaseFailure;
        },
      };
    },
  });
  return {
    refresh,
    host,
    stages,
    singleton,
    provider,
    plugins,
    boundary,
    setLoad(value: typeof load) {
      load = value;
    },
    setCommitFailure(value: Error | undefined) {
      commitFailure = value;
    },
    setReleaseFailure(value: Error | undefined) {
      releaseFailure = value;
    },
    counts: () => ({ factoryCalls, nativeCalls, selectedBoundary }),
  };
}

test('stages once with actual shared providers and normal admission before native execution', async () => {
  const h = harness();
  const module = await h.refresh.replace<{ singleton: object }>(graph('1'));
  expect(module.singleton).toBe(h.singleton);
  expect(h.stages[0]!.host.shareScopeMap.default).toBe(
    h.host.shareScopeMap.default,
  );
  expect(h.stages[0]!.received.plugins).toBe(h.plugins);
  expect(h.stages[0]!.received.shared).toEqual({});
  expect(h.counts()).toEqual({
    factoryCalls: 1,
    nativeCalls: 1,
    selectedBoundary: h.boundary,
  });
  expect(h.refresh.activeHost).toBe(h.stages[0]!.host);
  expect([...h.host.moduleCache.keys()]).toEqual(['remote', 'sibling']);
  expect(h.provider.lib()).toBe(h.singleton);
});

test('factory failure retains active owner and providers; newer graph can replace it', async () => {
  const h = harness();
  await h.refresh.replace(graph('1'));
  const working = h.refresh.activeHost;
  h.setLoad(async () => () => {
    throw new Error('expose failed');
  });
  await expect(h.refresh.replace(graph('2'))).rejects.toThrow('expose failed');
  expect(h.refresh.activeHost).toBe(working);
  expect(h.stages[0]!.released).toBe(0);
  expect(h.stages[1]!.released).toBe(1);
  expect(h.stages[1]!.host.moduleCache.size).toBe(0);
  expect(h.provider.lib()).toBe(h.singleton);
  await expect(h.refresh.replace(graph('2'))).rejects.toThrow(
    'already consumed',
  );
  h.setLoad(async () => () => ({ recovered: true }));
  await expect(h.refresh.replace(graph('3'))).resolves.toEqual({
    recovered: true,
  });
  expect(h.stages[0]!.released).toBe(1);
  expect(h.refresh.activeHost).toBe(h.stages[2]!.host);
});

test('failed async loading can retry without consuming a native graph', async () => {
  const h = harness();
  h.setLoad(async () => {
    throw new Error('remote unavailable');
  });
  await expect(h.refresh.replace(graph('1'))).rejects.toThrow(
    'remote unavailable',
  );
  expect(h.counts().nativeCalls).toBe(0);
  expect(h.refresh.activeHost).toBe(h.host);
  expect(h.stages[0]!.released).toBe(1);
  h.setLoad(async () => () => 'ready');
  await expect(h.refresh.replace(graph('1'))).resolves.toBe('ready');
});

test('dispose during loading prevents factory execution and releases only its stage', async () => {
  const h = harness();
  const loading = deferred<() => unknown>();
  h.setLoad(() => loading.promise);
  const replacement = h.refresh.replace(graph('1'));
  h.refresh.dispose();
  loading.resolve(() => 'must not execute');
  await expect(replacement).rejects.toThrow('disposed while loading');
  expect(h.counts().nativeCalls).toBe(0);
  expect(h.stages[0]!.released).toBe(1);
  expect(h.host.moduleCache.size).toBe(2);
  await expect(h.refresh.replace(graph('2'))).rejects.toThrow('disposed');
});

test('selected shared provider replacement is rejected before expose execution', async () => {
  const h = harness();
  h.setLoad(async () => {
    h.host.shareScopeMap.default!.octane!['0.13.8'] = {
      loaded: true,
      lib: () => ({}),
    };
    return () => 'must not execute';
  });
  await expect(h.refresh.replace(graph('1'))).rejects.toThrow(
    'changed the selected shared provider octane',
  );
  expect(h.counts().nativeCalls).toBe(0);
  expect(h.refresh.activeHost).toBe(h.host);
  expect(h.stages[0]!.released).toBe(1);
});

test('concurrent replacements cannot race native ownership', async () => {
  const h = harness();
  const loading = deferred<() => unknown>();
  h.setLoad(() => loading.promise);
  const first = h.refresh.replace(graph('1'));
  await expect(h.refresh.replace(graph('2'))).rejects.toThrow(
    'active replacement',
  );
  loading.resolve(() => 'first');
  await expect(first).resolves.toBe('first');
  h.refresh.dispose();
  h.refresh.dispose();
  expect(h.stages[0]!.released).toBe(1);
});

test('thenable rejection leaves the mounted owner available and consumes only the attempted revision', async () => {
  const h = harness();
  await h.refresh.replace(graph('1'));
  const working = h.refresh.activeHost;
  h.setLoad(async () => () => Promise.resolve('not synchronous'));
  await expect(h.refresh.replace(graph('2'))).rejects.toThrow(
    'asynchronous factories',
  );
  expect(h.refresh.activeHost).toBe(working);
  expect(h.stages[0]!.released).toBe(0);
  expect(h.stages[1]!.released).toBe(1);
  await expect(h.refresh.replace(graph('2'))).rejects.toThrow(
    'already consumed',
  );
});

test('irreversible native commit failures retain both stages for recovery instead of claiming rollback', async () => {
  const h = harness();
  await h.refresh.replace(graph('1'));
  h.setCommitFailure(new Error('native owner callback failed'));
  await expect(h.refresh.replace(graph('2'))).rejects.toThrow(
    'native owner callback failed',
  );
  expect(h.refresh.activeHost).toBe(h.stages[1]!.host);
  expect(h.stages.map(stage => stage.released)).toEqual([0, 0]);
  expect(h.stages.map(stage => stage.host.moduleCache.size)).toEqual([1, 1]);
  h.setCommitFailure(undefined);
  await h.refresh.replace(graph('3'));
  expect(h.stages.map(stage => stage.released)).toEqual([1, 1, 0]);
  h.refresh.dispose();
  h.refresh.dispose();
  expect(h.stages.map(stage => stage.released)).toEqual([1, 1, 1]);
  expect([...h.host.moduleCache.keys()]).toEqual(['remote', 'sibling']);
});

test('cleanup errors still retire every retained stage once and keep the newly committed owner', async () => {
  const h = harness();
  await h.refresh.replace(graph('1'));
  h.setCommitFailure(new Error('native callback failed'));
  await expect(h.refresh.replace(graph('2'))).rejects.toThrow(
    'native callback failed',
  );
  h.setCommitFailure(undefined);
  h.setReleaseFailure(new Error('transport close failed'));
  await expect(h.refresh.replace(graph('3'))).rejects.toThrow(
    'retirement failed',
  );
  expect(h.refresh.activeHost).toBe(h.stages[2]!.host);
  expect(h.stages.map(stage => stage.released)).toEqual([1, 1, 0]);
  expect(h.stages.map(stage => stage.host.moduleCache.size)).toEqual([0, 0, 1]);
  expect(() => h.refresh.dispose()).toThrow('cleanup failed');
  h.refresh.dispose();
  expect(h.stages.map(stage => stage.released)).toEqual([1, 1, 1]);
});

test.each(['loading', 'factory'] as const)(
  '%s failure preserves its cause alongside staging cleanup failure',
  async phase => {
    const h = harness();
    await h.refresh.replace(graph('1'));
    const working = h.refresh.activeHost;
    const primary = new Error(`${phase} failed`);
    const cleanup = new Error('staging transport close failed');
    h.setReleaseFailure(cleanup);
    h.setLoad(async () => {
      if (phase === 'loading') throw primary;
      return () => {
        throw primary;
      };
    });
    let failure: unknown;
    try {
      await h.refresh.replace(graph('2'));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
    expect(isNativeBrowserDevCommitError(failure, revision('2'))).toBe(false);
    expect(h.refresh.activeHost).toBe(working);
    expect(h.stages.map(stage => stage.released)).toEqual([0, 1]);
    expect(h.stages.map(stage => stage.host.moduleCache.size)).toEqual([1, 0]);
    h.setReleaseFailure(undefined);
    h.refresh.dispose();
    expect(h.stages.map(stage => stage.released)).toEqual([1, 1]);
  },
);

test.each([false, true])(
  'disposal cleanup retains native commit classification with callback failure %s',
  async callbackFails => {
    const h = harness();
    await h.refresh.replace(graph('1'));
    const primary = new Error('native callback failed');
    const cleanup = new Error('committed transport close failed');
    h.setCommitFailure(callbackFails ? primary : undefined);
    h.setLoad(async () => () => {
      h.refresh.dispose();
      h.setReleaseFailure(cleanup);
      return { committed: true };
    });
    let failure: unknown;
    try {
      await h.refresh.replace(graph('2'));
    } catch (error) {
      failure = error;
    }
    expect(isNativeBrowserDevCommitError(failure, revision('2'))).toBe(true);
    const cause = (failure as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual(
      callbackFails ? [primary, cleanup] : [cleanup],
    );
    expect(h.refresh.activeHost).toBe(h.host);
    expect(h.stages.map(stage => stage.released)).toEqual([1, 1]);
    expect(h.stages.map(stage => stage.host.moduleCache.size)).toEqual([0, 0]);
    h.refresh.dispose();
    expect(h.stages.map(stage => stage.released)).toEqual([1, 1]);
  },
);

test('only an observed native commit failure for the exact attempted revision authorizes recovery transport', async () => {
  const h = harness();
  h.setCommitFailure(new Error('native callback failed'));
  let failure: unknown;
  try {
    await h.refresh.replace(graph('1'));
  } catch (error) {
    failure = error;
  }
  expect(isNativeBrowserDevCommitError(failure, revision('1'))).toBe(true);
  expect(Reflect.set(failure as Error, 'revision', revision('2'))).toBe(false);
  expect(isNativeBrowserDevCommitError(failure, revision('1'))).toBe(true);
  expect(isNativeBrowserDevCommitError(failure, revision('2'))).toBe(false);
  expect(
    isNativeBrowserDevCommitError(
      Object.assign(new Error('foreign failure'), {
        revision: revision('1'),
        name: 'NativeBrowserDevCommitError',
      }),
      revision('1'),
    ),
  ).toBe(false);
  h.refresh.dispose();
});

test.each(['structural', 'helper'] as const)(
  'a factory cannot forge %s cross-runtime native commit evidence before its actual capability commits',
  async kind => {
    const h = harness();
    const forged =
      kind === 'helper'
        ? nativeBrowserDevCommitFailure(
            revision('1'),
            new Error('forged helper cause'),
          )
        : Object.assign(new Error('forged factory failure'), {
            [Symbol.for('ultramodern.federation.browser-dev-commit-error.v1')]:
              true,
            revision: revision('1'),
          });
    h.setLoad(async () => () => {
      throw forged;
    });
    let failure: unknown;
    try {
      await h.refresh.replace(graph('1'));
    } catch (error) {
      failure = error;
    }
    expect(isNativeBrowserDevCommitError(failure, revision('1'))).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(Reflect.get(failure as Error, 'cause')).toBe(forged);
    expect(h.refresh.activeHost).toBe(h.host);
    expect(h.stages[0]!.released).toBe(1);
    h.refresh.dispose();
  },
);
