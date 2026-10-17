import {
  isNativeBrowserDevCommitError,
  type NativeBrowserDevHost,
} from '../../src/module-federation/native-browser-dev-refresh';
import {
  createNativeBrowserDevRuntimePlugin,
  hasNativeBrowserDevPublisher,
  NATIVE_BROWSER_DEV_BOUNDARY,
  readNativeBrowserDevPublication,
  replaceNativeBrowserDevRemote,
} from '../../src/module-federation/native-browser-dev-runtime-plugin';
import {
  RENDERER_FEDERATION_SCHEMA,
  RENDERER_FEDERATION_SCHEMA_VERSION,
} from '../../src/module-federation/renderer-contract';

const revision = 'b'.repeat(64);
const remote = {
  name: 'runtime-proof',
  alias: 'runtime-proof',
  entry: 'https://remote.example/assets/mf-manifest.json',
};
const immutable =
  'https://remote.example/assets/__ultramodern_mf__/aabbcc/mf-manifest.json';
const manifest = (buildId = 'fresh-build') => ({
  metaData: {
    ultramodernRenderer: {
      schema: RENDERER_FEDERATION_SCHEMA,
      schemaVersion: RENDERER_FEDERATION_SCHEMA_VERSION,
      profile: {
        renderer: 'react',
        protocolVersion: 1,
        compiler: { name: '@rsbuild/plugin-react', version: '2.1.1' },
        hydration: { name: 'react-dom', version: '19.3.0' },
        router: {
          name: 'react-router',
          version: '7.18.4',
          coreName: 'react-router',
          coreVersion: '7.18.4',
        },
      },
      runtime: { name: 'react', version: '19.3.0' },
      bootstrap: { name: '@modern-js/runtime', version: '3.9.0' },
      identities: {
        main: {
          renderer: 'react',
          protocolVersion: 1,
          appId: 'remote',
          entryName: 'main',
          buildId,
        },
      },
    },
  },
});

function fixture() {
  const shares = {
    default: { react: { '19.3.0': { loaded: true, lib: () => singleton } } },
  };
  const singleton = {};
  const loads: string[] = [];
  const prepared: object[] = [];
  let factories = 0;
  let released = 0;
  let failFactory: ((id: string) => boolean) | undefined;
  let request: (...args: unknown[]) => Promise<unknown> = async () =>
    new Response(JSON.stringify(manifest()), {
      headers: {
        link: `<${immutable}>; rel="ultramodern-completed-graph"`,
        'x-revision': revision,
      },
    });
  const makeHost = (name: string): NativeBrowserDevHost => ({
    name,
    options: {},
    shareScopeMap: shares,
    moduleCache: new Map(),
    initShareScopeMap() {
      throw new Error('Working host must remain untouched');
    },
    async loadRemote() {
      throw new Error('Working host must remain untouched');
    },
    loaderHook: {
      lifecycle: { fetch: { emit: (...args) => request(...args) } },
    },
  });
  const hosts = [makeHost('first'), makeHost('second')];
  const plugin = createNativeBrowserDevRuntimePlugin({
    remotes: [remote],
    prepareReplacement(actual) {
      prepared.push(actual);
      return {
        commitStarted: false,
        execute<T>(factory: () => T) {
          return factory();
        },
      };
    },
    createHost(options) {
      const host: NativeBrowserDevHost = {
        name: String(options.name),
        options,
        shareScopeMap: {},
        moduleCache: new Map(),
        initShareScopeMap(name, scope) {
          this.shareScopeMap[name] = scope;
        },
        async loadRemote<T>(id: string) {
          loads.push(String(options.name));
          return (() => {
            factories++;
            if (failFactory?.(id)) throw new Error('second expose refused');
            return { singleton };
          }) as T;
        },
      };
      return {
        host,
        release() {
          released++;
        },
      };
    },
  });
  for (const host of hosts) plugin.beforeInit({ origin: host });
  const source = {};
  const bind = (index: number, boundary: object, expose = 'Widget') =>
    Reflect.get(hosts[index]!, NATIVE_BROWSER_DEV_BOUNDARY)(
      `${remote.alias}/${expose}`,
      source,
      boundary,
    ) as () => void;
  return {
    hosts,
    loads,
    prepared,
    bind,
    counts: () => ({ factories, released }),
    setRequest(next: typeof request) {
      request = next;
    },
    failFactoryWhen(next: (id: string) => boolean) {
      failFactory = next;
    },
  };
}

test('one actual exposed source executes once for sibling mounted boundaries and follows its remaining host', async () => {
  const h = fixture();
  const first = {};
  const second = {};
  const releaseFirst = h.bind(0, first);
  const releaseSecond = h.bind(1, second);
  try {
    expect(
      await replaceNativeBrowserDevRemote({
        revision,
        remote: { ...remote, entry: immutable },
      }),
    ).toBe(1);
    expect(h.counts()).toEqual({ factories: 1, released: 0 });
    expect(h.prepared).toEqual([first]);
    releaseFirst();
    expect(hasNativeBrowserDevPublisher(remote.name)).toBe(true);
    await replaceNativeBrowserDevRemote({
      revision: 'c'.repeat(64),
      remote: { ...remote, entry: immutable },
    });
    expect(h.prepared).toEqual([first, second]);
    expect(h.loads[1]).toContain('second:native-dev:');
    expect(h.counts()).toEqual({ factories: 2, released: 1 });
  } finally {
    releaseFirst();
    releaseSecond();
  }
  expect(hasNativeBrowserDevPublisher(remote.name)).toBe(false);
  expect(h.counts()).toEqual({ factories: 2, released: 2 });
});

test('registration uses the browser plugin factory and cannot replace its native authority', async () => {
  const h = fixture();
  const boundary = {};
  const suppliedPrepare = rstest.fn(() => {
    throw new Error('registration supplied an untrusted native factory');
  });
  const release = Reflect.get(h.hosts[0]!, NATIVE_BROWSER_DEV_BOUNDARY)(
    `${remote.alias}/Widget`,
    {},
    boundary,
    suppliedPrepare,
  ) as () => void;
  try {
    expect(h.prepared).toEqual([]);
    await replaceNativeBrowserDevRemote({
      revision,
      remote: { ...remote, entry: immutable },
    });
    expect(h.prepared).toEqual([boundary]);
    expect(suppliedPrepare).not.toHaveBeenCalled();
    expect(h.counts()).toEqual({ factories: 1, released: 0 });
  } finally {
    release();
  }
});

test('a later exposed root failure preserves an earlier accepted root and reports partial native commit', async () => {
  const h = fixture();
  const releaseFirst = h.bind(0, {}, 'Widget');
  const releaseSecond = h.bind(0, {}, 'Sidebar');
  h.failFactoryWhen(id => id.endsWith('/Sidebar'));
  try {
    let failure: unknown;
    try {
      await replaceNativeBrowserDevRemote({
        revision,
        remote: { ...remote, entry: immutable },
      });
    } catch (error) {
      failure = error;
    }
    expect(isNativeBrowserDevCommitError(failure, revision)).toBe(true);
    expect((failure as Error).cause).toMatchObject({
      message: 'second expose refused',
    });
    expect(h.counts()).toEqual({ factories: 2, released: 1 });
    // Only the failed root's stage was released. The first root stays mounted
    // on its accepted runtime and a newer graph can repair the second root.
    expect(hasNativeBrowserDevPublisher(remote.name)).toBe(true);
    h.failFactoryWhen(() => false);
    await replaceNativeBrowserDevRemote({
      revision: 'd'.repeat(64),
      remote: { ...remote, entry: immutable },
    });
    expect(h.counts()).toEqual({ factories: 4, released: 2 });
  } finally {
    releaseFirst();
    releaseSecond();
  }
  expect(h.counts()).toEqual({ factories: 4, released: 4 });
});

test('completed discovery uses the mounted host transport and exact immutable coordinate', async () => {
  const h = fixture();
  const release = h.bind(0, {});
  const seen: unknown[][] = [];
  h.setRequest(async (...args) => {
    seen.push(args);
    return new Response(JSON.stringify(manifest()), {
      headers: {
        link: `<${immutable}>; rel="ultramodern-completed-graph"`,
        'x-revision': revision,
      },
    });
  });
  const signal = new AbortController().signal;
  try {
    await expect(
      readNativeBrowserDevPublication(remote.name, {
        signal,
        revisionHeader: 'x-revision',
      }),
    ).resolves.toEqual({
      revision,
      runtimeHash: 'aabbcc',
      buildId: 'fresh-build',
      remote: { ...remote, entry: immutable },
    });
    expect(seen).toEqual([
      [
        remote.entry,
        { cache: 'no-store', signal },
        remote,
        {
          initiator: 'loadRemote',
          id: `${remote.alias}/Widget`,
          resourceType: 'manifest',
          url: remote.entry,
        },
      ],
    ]);
  } finally {
    release();
  }
});

test.each([
  ['', revision],
  [
    `<${immutable}>; rel="ultramodern-completed-graph", <${immutable}>; rel="ultramodern-completed-graph"`,
    revision,
  ],
  [
    `<https://remote.example/latest.json>; rel="ultramodern-completed-graph"`,
    revision,
  ],
  [`<${immutable}>; rel="ultramodern-completed-graph"`, 'untrusted'],
])(
  'rejects missing, ambiguous or mutable completed graph evidence (%s)',
  async (link, value) => {
    const h = fixture();
    const release = h.bind(0, {});
    h.setRequest(
      async () =>
        new Response(JSON.stringify(manifest()), {
          headers: { link, 'x-revision': value },
        }),
    );
    try {
      await expect(
        readNativeBrowserDevPublication(remote.name, {
          signal: new AbortController().signal,
          revisionHeader: 'x-revision',
        }),
      ).rejects.toThrow();
      expect(h.counts().factories).toBe(0);
    } finally {
      release();
    }
  },
);

test('bounded abort settles discovery even when an authored transport ignores its signal', async () => {
  const h = fixture();
  const release = h.bind(0, {});
  let settle!: (response: Response) => void;
  h.setRequest(
    () =>
      new Promise(resolve => {
        settle = resolve;
      }),
  );
  const lifetime = new AbortController();
  const request = readNativeBrowserDevPublication(remote.name, {
    signal: lifetime.signal,
    revisionHeader: 'x-revision',
  });
  lifetime.abort(new Error('proof aborted'));
  try {
    await expect(request).rejects.toThrow('proof aborted');
    const response = new Response('late transport response');
    settle(response);
    await new Promise(resolve => setImmediate(resolve));
    expect(response.bodyUsed).toBe(true);
    expect(h.counts().factories).toBe(0);
  } finally {
    release();
  }
});
