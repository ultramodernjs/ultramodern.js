import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadFederatedModule,
  remoteBrowserAssets,
} from '../../../renderer-core/src/federation';
import { octaneProfile } from '../../../renderer-octane/src/plugin/profile';
import nativeDevRefreshRuntimePlugin from '../../src/module-federation/native-dev-refresh-runtime-plugin';
import {
  RENDERER_FEDERATION_METADATA_KEY,
  RENDERER_FEDERATION_SCHEMA,
  RENDERER_FEDERATION_SCHEMA_VERSION,
  type RendererFederationCompatibility,
} from '../../src/module-federation/renderer-contract';
import { createRendererFederationRuntimePlugin } from '../../src/module-federation/renderer-runtime-plugin';

// Follow the application integration's declared runtime owner, rather than
// selecting an arbitrary copy from the repository's package store.
const applicationRequire = createRequire(
  path.resolve(
    __dirname,
    '../../../../solutions/app-tools-extensions/package.json',
  ),
);
const integrationRequire = createRequire(
  applicationRequire.resolve('@module-federation/modern-js-v3'),
);
const enhancedRequire = createRequire(
  integrationRequire.resolve('@module-federation/enhanced'),
);
const runtimeRequire = createRequire(
  enhancedRequire.resolve('@module-federation/runtime'),
);
const { ModuleFederation } = runtimeRequire('@module-federation/runtime-core');

const compilerRequire = createRequire(
  path.resolve(
    __dirname,
    '../../../../solutions/ultramodern-app-tools/package.json',
  ),
);
const octaneRequire = createRequire(
  path.resolve(__dirname, '../../../renderer-octane/package.json'),
);

const tuple: RendererFederationCompatibility = {
  profile: {
    renderer: octaneProfile.renderer,
    protocolVersion: octaneProfile.protocolVersion,
    compiler: octaneProfile.compiler,
    hydration: octaneProfile.hydration,
    router: octaneProfile.router,
  },
  runtime: { name: 'octane', version: octaneProfile.hydration.version },
  bootstrap: { name: '@modern-js/renderer-octane', version: '3.8.3' },
};

test('refreshing a native remote preserves Octane server hook providers retained indirectly by the host', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-mf-octane-shares-'));
  const { rspack } = compilerRequire('@rsbuild/core');
  const source = path.join(root, 'native.mjs');
  writeFileSync(
    source,
    `export * as server from 'octane/server';\nexport * as internal from 'octane/internal/server';\nexport * as signals from 'octane/signals/server';\n`,
  );
  const compiler = rspack({
    context: root,
    mode: 'none',
    devtool: false,
    target: 'node',
    entry: source,
    output: {
      path: root,
      filename: 'native.cjs',
      library: { type: 'commonjs2' },
    },
    resolve: {
      modules: [
        path.resolve(__dirname, '../../../renderer-octane/node_modules'),
        'node_modules',
      ],
      conditionNames: ['node', 'import', 'default'],
    },
  });
  let bundle: string;
  try {
    const stats = await new Promise<any>((resolve, reject) =>
      compiler.run((error: Error | null, stats: unknown) =>
        error ? reject(error) : resolve(stats),
      ),
    );
    expect(stats.toJson({ all: false, errors: true }).errors).toEqual([]);
    bundle = readFileSync(path.join(root, 'native.cjs'), 'utf8');
  } finally {
    await new Promise<void>((resolve, reject) =>
      compiler.close((error: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    rmSync(root, { recursive: true, force: true });
  }
  const name = `native_dev_octane_${process.pid}`;
  const header = 'x-ultramodern-mf-revision';
  let revision = '1'.repeat(64);
  let value = 'v1';
  let origin = '';
  let entries = 0;
  const version: string = JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../renderer-octane/node_modules/octane/package.json',
      ),
      'utf8',
    ),
  ).version;
  const nativeTuple = {
    ...tuple,
    runtime: { ...tuple.runtime, version },
    profile: {
      ...tuple.profile,
      hydration: { ...tuple.profile.hydration, version },
    },
  };
  const shared = [
    'octane/server',
    'octane/internal/server',
    'octane/signals/server',
  ];
  const server = createServer((request, response) => {
    if (request.url === '/mf-manifest.json') {
      return void response.setHeader('content-type', 'application/json').end(
        JSON.stringify({
          name,
          metaData: {
            globalName: name,
            buildInfo: { buildVersion: '' },
            publicPath: `${origin}/`,
            ssrPublicPath: `${origin}/`,
            remoteEntry: { name: 'browser.js', path: '', type: 'module' },
            ssrRemoteEntry: {
              name: 'server.js',
              path: '',
              type: 'commonjs-module',
            },
            [RENDERER_FEDERATION_METADATA_KEY]: {
              schema: RENDERER_FEDERATION_SCHEMA,
              schemaVersion: RENDERER_FEDERATION_SCHEMA_VERSION,
              ...nativeTuple,
              identities: {
                main: {
                  renderer: 'octane',
                  protocolVersion: 1,
                  appId: name,
                  entryName: 'main',
                  buildId: 'stable-dev-build',
                },
              },
            },
          },
          shared: [],
          remotes: [],
          exposes: [
            {
              name: 'Widget',
              path: './Widget',
              assets: {
                js: { sync: ['browser.js'], async: [] },
                css: { sync: [], async: [] },
              },
            },
          ],
        }),
      );
    }
    if (request.url === '/server.js') {
      response.setHeader(header, revision);
      if (request.method === 'HEAD') return void response.end();
      entries++;
      return void response.end(`${bundle}\n
        const native = module.exports;
        const {createInstance} = require(${JSON.stringify(runtimeRequire.resolve('@module-federation/runtime'))});
        let remote;
        module.exports = {
          init(scope) {
            remote = createInstance({ name: ${JSON.stringify(name)}, shareStrategy: 'loaded-first', shared: {
              'octane/server': { version: ${JSON.stringify(version)}, get: () => () => native.server },
              'octane/internal/server': { version: ${JSON.stringify(version)}, get: () => () => native.internal },
              'octane/signals/server': { version: ${JSON.stringify(version)}, get: () => () => native.signals }
            }});
            remote.initShareScopeMap('default', scope);
          },
          async get() {
            const server = (await remote.loadShare('octane/server'))();
            const internal = (await remote.loadShare('octane/internal/server'))();
            const signals = (await remote.loadShare('octane/signals/server'))();
            internal.enableServerSignalBindings();
            const slot = server.hookSlots(1);
            return () => ({server, internal, signals, default() {
              internal.beginNativeReadScope(undefined, 1);
              return signals.useSignal$(${JSON.stringify(value)}, slot).get();
            }});
          }
        };`);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing Octane server address');
  origin = `http://127.0.0.1:${address.port}`;
  const remote = { name, alias: 'store', entry: `${origin}/mf-manifest.json` };
  const host = new ModuleFederation({
    name: `native_dev_octane_host_${process.pid}`,
    shareStrategy: 'loaded-first',
    remotes: [remote],
    shared: Object.fromEntries(
      shared.map(key => [
        key,
        {
          version,
          get: async () => {
            const native = await import(
              pathToFileURL(octaneRequire.resolve(key)).href
            );
            return () => native;
          },
        },
      ]),
    ),
    plugins: [
      createRendererFederationRuntimePlugin(nativeTuple),
      nativeDevRefreshRuntimePlugin({
        remotes: [remote],
        revisionHeader: header,
        requestTimeout: 1000,
        shared: ['octane/'],
      }),
    ],
  });
  try {
    expect(host.version).toBe('2.9.2');
    const first = await host.loadRemote('store/Widget');
    const retainedRenderer = first.server;
    expect(retainedRenderer.version).toBe(version);
    expect(retainedRenderer.renderToString(first.default).html).toBe('v1');
    const providers = shared.map(
      key => host.shareScopeMap.default[key][version],
    );
    expect(
      providers.every(
        provider => provider.from === name && provider.useIn.includes(name),
      ),
    ).toBe(true);
    revision = '2'.repeat(64);
    value = 'v2';
    const refreshed = await host.loadRemote('store/Widget');
    expect(entries).toBe(2);
    expect(retainedRenderer.renderToString(refreshed.default).html).toBe('v2');
    expect(refreshed.server).toBe(retainedRenderer);
    expect(refreshed.internal).toBe(first.internal);
    expect(refreshed.signals).toBe(first.signals);
    for (const [index, key] of shared.entries()) {
      expect(host.shareScopeMap.default[key][version]).toBe(providers[index]);
      expect(providers[index].useIn).toContain(host.options.name);
    }
  } finally {
    host.registerRemotes([remote], { force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});

test('the same native CJS host reloads a lazy-only revision, reruns admission, and retains public load semantics', async () => {
  const name = `native_dev_remote_${process.pid}`;
  const header = 'x-ultramodern-mf-revision';
  let revision = '1'.repeat(64);
  let value = 'v1';
  let incompatible = false;
  let unavailable = false;
  let nestedValue: string | undefined;
  const counts = new Map<string, number>();
  let origin = '';
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    counts.set(
      `${request.method} ${url}`,
      (counts.get(`${request.method} ${url}`) ?? 0) + 1,
    );
    if (unavailable) return void response.writeHead(503).end();
    if (url === '/mf-manifest.json') {
      return void response.setHeader('content-type', 'application/json').end(
        JSON.stringify({
          name,
          metaData: {
            globalName: name,
            buildInfo: { buildVersion: '0.1.0' },
            publicPath: `${origin}/`,
            ssrPublicPath: `${origin}/`,
            remoteEntry: { name: 'browser.js', path: '', type: 'module' },
            ssrRemoteEntry: {
              name: 'server.js',
              path: '',
              type: 'commonjs-module',
            },
            [RENDERER_FEDERATION_METADATA_KEY]: {
              schema: RENDERER_FEDERATION_SCHEMA,
              schemaVersion: RENDERER_FEDERATION_SCHEMA_VERSION,
              ...tuple,
              runtime: {
                ...tuple.runtime,
                version: incompatible ? '0.8.0' : tuple.runtime.version,
              },
              identities: {
                main: {
                  renderer: 'octane',
                  protocolVersion: 1,
                  appId: name,
                  entryName: 'main',
                  buildId: 'stable-dev-build',
                },
              },
            },
          },
          shared: [],
          remotes: [],
          exposes: ['Widget', 'Other', 'Leaf', 'Detached'].map(expose => ({
            name: expose,
            path: `./${expose}`,
            assets: {
              js: { sync: ['browser.js'], async: [] },
              css: {
                sync: [
                  `${value}${expose === 'Widget' ? '' : `-${expose.toLowerCase()}`}.css`,
                ],
                async: [],
              },
            },
          })),
        }),
      );
    }
    if (url === '/server.js') {
      response.setHeader(header, revision);
      response.setHeader('content-type', 'application/javascript');
      // The entry bytes and published package/build versions remain identical
      // across revisions. Only the exposed lazy payload changes.
      return void response.end(`module.exports = {
        init(scope) { this.singleton = scope['dev-shared']['1.0.0'].lib; },
        async get(expose) {
          if (expose === './Recovered') throw new Error('remote exposure failed');
          const payload = await (this.payload ??= fetch(${JSON.stringify(`${origin}/lazy.json`)}).then(response => response.json()));
          const singleton = this.singleton;
          return () => ({value: payload.value, expose, singleton});
        }
      };`);
    }
    if (url === '/lazy.json')
      return void response
        .setHeader('content-type', 'application/json')
        .end(JSON.stringify({ value }));
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing native server address');
  origin = `http://127.0.0.1:${address.port}`;
  const remote = { name, alias: 'store', entry: `${origin}/mf-manifest.json` };
  const singleton = {};
  const host = new ModuleFederation({
    name: `native_dev_host_${process.pid}`,
    remotes: [remote],
    shared: { 'dev-shared': { version: '1.0.0', lib: () => singleton } },
    plugins: [
      createRendererFederationRuntimePlugin(tuple),
      {
        name: 'native-dev-fetch',
        fetch: (
          url: string,
          init: RequestInit,
          info: { name: string },
          context: {
            initiator: string;
            resourceType: string;
            id: string;
            url: string;
          },
        ) => {
          if (new URL(url).pathname === '/server.js') {
            expect(info.name).toBe(name);
            expect(context).toMatchObject({
              initiator: 'loadRemote',
              resourceType: 'remoteEntry',
              url,
            });
            expect(context.id).toMatch(new RegExp(`^${name}/`));
          }
          return fetch(url, {
            ...init,
            signal: init.signal ?? AbortSignal.timeout(1000),
          });
        },
        beforeRequest: (args: { id: string }) =>
          args.id === 'authored/Widget'
            ? { ...args, id: 'store/Widget' }
            : args,
        errorLoadRemote: (args: { id: string; lifecycle: string }) =>
          ['recover/Widget', 'store/Recovered'].includes(args.id) &&
          args.lifecycle === 'onLoad'
            ? { value: 'native recovery' }
            : undefined,
        onLoad: async (args: {
          id: string;
          origin: { loadRemote(id: string): Promise<{ value: string }> };
        }) => {
          if (args.id === 'store/Widget')
            nestedValue = (await args.origin.loadRemote('store/Other')).value;
        },
      },
      nativeDevRefreshRuntimePlugin({
        remotes: [remote],
        revisionHeader: header,
        requestTimeout: 1000,
      }),
    ],
  });
  let hostB: InstanceType<typeof ModuleFederation> | undefined;
  try {
    const initial = await host.loadRemote('store/Widget');
    expect(initial).toMatchObject({ value: 'v1', singleton });
    expect(nestedValue).toBe('v1');
    expect((await host.loadRemote('authored/Widget')).value).toBe('v1');
    expect(await host.loadRemote('recover/Widget')).toEqual({
      value: 'native recovery',
    });
    const requests = counts.get('GET /server.js');
    const manifestRequests = counts.get('GET /mf-manifest.json');
    await Promise.all([
      host.loadRemote('store/Widget'),
      host.loadRemote('store/Widget'),
    ]);
    expect(counts.get('GET /server.js')).toBe(requests);
    expect(counts.get('GET /mf-manifest.json')).toBe(manifestRequests);
    revision = '2'.repeat(64);
    value = 'v2';
    const updated = await Promise.all([
      host.loadRemote('store/Widget'),
      host.loadRemote('store/Widget'),
    ]);
    expect(updated.map(module => module.value)).toEqual(['v2', 'v2']);
    expect(nestedValue).toBe('v2');
    expect(updated[0].singleton).toBe(initial.singleton);
    expect(counts.get('GET /server.js')).toBe((requests ?? 0) + 1);
    expect(counts.get('GET /mf-manifest.json')).toBe(
      (manifestRequests ?? 0) + 1,
    );
    let releaseOld!: () => void;
    let reachedOld!: () => void;
    const oldGate = new Promise<void>(resolve => {
      releaseOld = resolve;
    });
    const oldReached = new Promise<void>(resolve => {
      reachedOld = resolve;
    });
    let nestedOld:
      | Awaited<ReturnType<typeof loadFederatedModule<{ value: string }>>>
      | undefined;
    let nestedLeaf: typeof nestedOld;
    let shareNested: typeof nestedOld;
    let shareNestedLoad: Promise<NonNullable<typeof nestedOld>> | undefined;
    let shareDetachedLoad: typeof shareNestedLoad;
    let retaining = false;
    let releaseShareOther!: () => void;
    let reachedShareOther!: () => void;
    const shareOtherGate = new Promise<void>(resolve => {
      releaseShareOther = resolve;
    });
    const shareOtherReached = new Promise<void>(resolve => {
      reachedShareOther = resolve;
    });
    let releaseShareDetached!: () => void;
    let reachedShareDetached!: () => void;
    const shareDetachedGate = new Promise<void>(resolve => {
      releaseShareDetached = resolve;
    });
    const shareDetachedReached = new Promise<void>(resolve => {
      reachedShareDetached = resolve;
    });
    let retainedShare!: () => void;
    const shareRetained = new Promise<void>(resolve => {
      retainedShare = resolve;
    });
    let detached: Promise<NonNullable<typeof nestedOld>> | undefined;
    let releaseDetached!: () => void;
    let reachedDetached!: () => void;
    const detachedGate = new Promise<void>(resolve => {
      releaseDetached = resolve;
    });
    const detachedReached = new Promise<void>(resolve => {
      reachedDetached = resolve;
    });
    let revisionProbed: (() => void) | undefined;
    let pauseOld = true;
    hostB = new ModuleFederation({
      name: `native_dev_host_b_${process.pid}`,
      remotes: [remote],
      shared: { 'dev-shared': { version: '1.0.0', lib: () => singleton } },
      plugins: [
        createRendererFederationRuntimePlugin(tuple),
        {
          name: 'second-host-bounded-fetch-and-pause',
          beforeLoadShare: async (args: {
            origin: InstanceType<typeof ModuleFederation>;
          }) => {
            retaining = true;
            shareNestedLoad = loadFederatedModule<{ value: string }>(
              args.origin,
              'store/Other',
            ).then(result => {
              shareNested = result;
              return result;
            });
            await shareOtherReached;
            return args;
          },
          fetch: async (url: string, init: RequestInit) => {
            const response = await fetch(url, {
              ...init,
              signal: init.signal ?? AbortSignal.timeout(1000),
            });
            if (init.method === 'HEAD') revisionProbed?.();
            return response;
          },
          afterResolve: async (args: {
            id: string;
            origin: InstanceType<typeof ModuleFederation>;
          }) => {
            if (args.id === 'store/Other')
              nestedLeaf = await loadFederatedModule<{ value: string }>(
                args.origin,
                'store/Leaf',
              );
            return args;
          },
          onLoad: async (args: {
            id: string;
            origin: InstanceType<typeof ModuleFederation>;
          }) => {
            if (retaining && args.id === 'store/Other') {
              reachedShareOther();
              await shareOtherGate;
              shareDetachedLoad = loadFederatedModule<{ value: string }>(
                args.origin,
                'store/Detached',
              );
              await shareDetachedReached;
              return;
            }
            if (retaining && args.id === 'store/Detached') {
              reachedShareDetached();
              await shareDetachedGate;
              return;
            }
            if (args.id === 'store/Detached') {
              reachedDetached();
              await detachedGate;
              return;
            }
            if (args.id !== 'store/Widget' || !pauseOld) return;
            pauseOld = false;
            reachedOld();
            await oldGate;
            nestedOld = await loadFederatedModule<{ value: string }>(
              args.origin,
              'store/Other',
            );
            detached = loadFederatedModule<{ value: string }>(
              args.origin,
              'store/Detached',
            );
            // The child borrows this lease but finishes after this hook/load.
            await detachedReached;
          },
        },
        nativeDevRefreshRuntimePlugin({
          remotes: [remote],
          shared: ['dev-shared'],
          revisionHeader: header,
          requestTimeout: 1000,
        }),
      ],
    });
    const oldLoad = loadFederatedModule<{ value: string }>(
      hostB,
      'store/Widget',
    );
    await oldReached;
    revision = '4'.repeat(64);
    value = 'authored-v2';
    expect((await host.loadRemote('authored/Widget')).value).toBe(
      'authored-v2',
    );
    releaseOld();
    const oldLoaded = await oldLoad;
    expect(oldLoaded.module.value).toBe('v2');
    expect(oldLoaded.assets?.css).toEqual([`${origin}/v2.css`]);
    expect(nestedOld?.module.value).toBe('v2');
    expect(nestedOld?.assets?.css).toEqual([`${origin}/v2-other.css`]);
    expect(nestedLeaf?.module.value).toBe('v2');
    expect(nestedLeaf?.assets?.css).toEqual([`${origin}/v2-leaf.css`]);
    expect(remoteBrowserAssets(hostB, 'store/Widget')?.css).toEqual([
      `${origin}/authored-v2.css`,
    ]);
    let refreshesB = 0;
    const loadShareB = hostB.loadShare.bind(hostB);
    hostB.loadShare = async (pkgName: string) => {
      const factory = await loadShareB(pkgName);
      retainedShare();
      return factory;
    };
    const registerB = hostB.registerRemotes.bind(hostB);
    hostB.registerRemotes = (
      remotes: (typeof remote)[],
      options?: { force?: boolean },
    ) => {
      refreshesB++;
      registerB(remotes, options);
    };
    const revisionSeen = new Promise<void>(resolve => {
      revisionProbed = resolve;
    });
    let freshFinished = false;
    const freshB = loadFederatedModule<{ value: string }>(
      hostB,
      'store/Widget',
    ).then(result => {
      freshFinished = true;
      return result;
    });
    await revisionSeen;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(refreshesB).toBe(0);
    expect(freshFinished).toBe(false);
    releaseDetached();
    const detachedLoaded = await detached;
    expect(detachedLoaded?.module.value).toBe('v2');
    expect(detachedLoaded?.assets?.css).toEqual([`${origin}/v2-detached.css`]);
    await shareOtherReached;
    await shareRetained;
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseShareOther();
    await shareDetachedReached;
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(refreshesB).toBe(0);
      expect(freshFinished).toBe(false);
    } finally {
      releaseShareDetached();
      await Promise.allSettled([freshB, shareNestedLoad, shareDetachedLoad]);
    }
    const freshLoaded = await freshB;
    expect(shareNested?.module.value).toBe('v2');
    expect(shareNested?.assets?.css).toEqual([`${origin}/v2-other.css`]);
    expect((await shareDetachedLoad)?.module.value).toBe('v2');
    expect((await shareDetachedLoad)?.assets?.css).toEqual([
      `${origin}/v2-detached.css`,
    ]);
    expect(freshLoaded.module.value).toBe('authored-v2');
    expect(freshLoaded.assets?.css).toEqual([`${origin}/authored-v2.css`]);
    expect(refreshesB).toBe(1);
    expect(await host.loadRemote('store/Recovered')).toEqual({
      value: 'native recovery',
    });
    expect(
      typeof (await host.loadRemote('store/Widget', { loadFactory: false })),
    ).toBe('function');
    unavailable = true;
    await expect(host.loadRemote('store/Widget')).rejects.toMatchObject({
      status: 503,
    });
    unavailable = false;
    expect((await host.loadRemote('store/Widget')).value).toBe('authored-v2');
    revision = '3'.repeat(64);
    incompatible = true;
    await expect(host.loadRemote('store/Widget')).rejects.toThrow('runtime');
    incompatible = false;
    value = 'v3';
    expect((await host.loadRemote('store/Widget')).value).toBe('v3');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    host.remoteHandler.removeRemote(remote);
    hostB?.remoteHandler.removeRemote(remote);
  }
});
