import { afterEach, rstest } from '@rstest/core';
import {
  prepareNativeBrowserDevClient,
  releaseNativeBrowserDevClient,
  startNativeBrowserDevClient,
} from '../../src/module-federation/native-browser-dev-client';
import type { NativeBrowserDevHost } from '../../src/module-federation/native-browser-dev-refresh';
import {
  createNativeBrowserDevRuntimePlugin,
  NATIVE_BROWSER_DEV_BOUNDARY,
} from '../../src/module-federation/native-browser-dev-runtime-plugin';
import {
  RENDERER_FEDERATION_SCHEMA,
  RENDERER_FEDERATION_SCHEMA_VERSION,
} from '../../src/module-federation/renderer-contract';

class Socket {
  static readonly OPEN = 1;
  static readonly instances: Socket[] = [];
  readonly sent: string[] = [];
  readonly readyState = Socket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  message(type: string, data?: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}

const disposers: (() => void)[] = [];
afterEach(() => {
  try {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  } finally {
    rstest.unstubAllGlobals();
    rstest.restoreAllMocks();
    Socket.instances.length = 0;
  }
});
const settle = () => new Promise(resolve => setImmediate(resolve));
let sequence = 0;

function fixture() {
  const name = `socket-proof-${++sequence}`;
  const remote = {
    name,
    alias: name,
    entry: 'https://remote.example/assets/mf-manifest.json',
  };
  const reload = rstest.fn();
  rstest.stubGlobal('WebSocket', Socket);
  rstest.stubGlobal('window', new EventTarget());
  rstest.stubGlobal('location', {
    protocol: 'https:',
    hostname: 'host.example',
    port: '',
    pathname: '/',
    reload,
  });
  const errors = rstest.spyOn(console, 'error').mockImplementation(() => {});
  let buildId = 'old-process';
  let revision = 'b'.repeat(64);
  let hash = 'bb22';
  let failure: 'before' | 'after' | 'forged' | undefined;
  let gate: Promise<void> | undefined;
  let loadFailure = false;
  let failingExpose: string | undefined;
  const cachedRuntimes = new Set<string>();
  let checks = 0;
  let executions = 0;
  let customInstalled = 0;
  let customReleased = 0;
  const overlays: string[] = [];
  let activeOverlay: string | undefined;
  let overlayClears = 0;
  let duringNativeExecution: (() => void) | undefined;
  const makeClient = (runtimeHash: string, process: string) => {
    let actualHash = runtimeHash;
    const dispose = startNativeBrowserDevClient({
      remoteName: name,
      buildId: process,
      revisionHeader: 'x-revision',
      token: 'proof-token',
      config: { path: '/rsbuild-hmr', reconnect: 1, overlay: true },
      serverHost: 'remote.example',
      serverPort: 443,
      serverBase: '/',
      liveReload: true,
      browserLogs: true,
      logLevel: 'info',
      hot: {
        status: () => 'idle',
        async check() {
          checks++;
          actualHash = hash;
          return ['changed'];
        },
      },
      hash: () => actualHash,
      overlay: () => ({
        clear() {
          overlayClears++;
          activeOverlay = undefined;
        },
        create(_title, body) {
          overlays.push(body);
          activeOverlay = body;
        },
      }),
      installCustomListeners() {
        customInstalled++;
        return () => {
          customReleased++;
        };
      },
    });
    disposers.push(dispose);
    return dispose;
  };
  const oldClient = makeClient('aa11', 'old-process');
  const host: NativeBrowserDevHost = {
    name: 'mounted-host',
    options: {},
    shareScopeMap: {},
    moduleCache: new Map(),
    initShareScopeMap() {
      throw new Error('Working host stays untouched');
    },
    async loadRemote() {
      throw new Error('Working host stays untouched');
    },
    loaderHook: {
      lifecycle: {
        fetch: {
          async emit() {
            const contract = {
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
                  appId: name,
                  entryName: 'main',
                  buildId,
                },
              },
            };
            return new Response(
              JSON.stringify({ metaData: { ultramodernRenderer: contract } }),
              {
                headers: {
                  'x-revision': revision,
                  link: `<https://remote.example/assets/__ultramodern_mf__/${hash}/mf-manifest.json>; rel="ultramodern-completed-graph"`,
                },
              },
            );
          },
        },
      },
    },
  };
  const plugin = createNativeBrowserDevRuntimePlugin({
    remotes: [remote],
    prepareReplacement() {
      let nativeCommit = false;
      return {
        get commitStarted() {
          return nativeCommit;
        },
        execute<T>(factory: () => T) {
          const result = factory();
          duringNativeExecution?.();
          nativeCommit = true;
          if (failure === 'after') throw new Error('native callback failed');
          return result;
        },
      };
    },
    createHost(options) {
      let releaseLease: (() => void) | undefined;
      const stage: NativeBrowserDevHost = {
        name: String(options.name),
        options,
        shareScopeMap: {},
        moduleCache: new Map(),
        initShareScopeMap(scope, providers) {
          this.shareScopeMap[scope] = providers;
        },
        async loadRemote<T>(id: string) {
          const runtimeHash = hash;
          if (!cachedRuntimes.has(runtimeHash)) {
            makeClient(runtimeHash, buildId);
            cachedRuntimes.add(runtimeHash);
          }
          expect(Socket.instances).toHaveLength(1);
          await gate;
          if (loadFailure) throw new Error('async chunk unavailable');
          return (() => {
            // Both the old working runtime and the standby expose runtime must
            // have their real module.hot.on interceptor before source executes.
            expect(customInstalled - customReleased).toBe(2);
            executions++;
            if (failingExpose && id.endsWith(`/${failingExpose}`))
              throw new Error(`factory failed for ${failingExpose}`);
            if (failure === 'before') throw new Error('factory failed');
            if (failure === 'forged')
              throw Object.assign(new Error('forged factory failure'), {
                [Symbol.for(
                  'ultramodern.federation.browser-dev-commit-error.v1',
                )]: true,
                revision,
              });
            return { fresh: runtimeHash };
          }) as T;
        },
      };
      return {
        host: stage,
        prepareFactory() {
          const remote = (
            options.remotes as { name: string; entry: string }[]
          )[0]!;
          releaseLease = prepareNativeBrowserDevClient(
            remote.name,
            remote.entry,
          );
        },
        release() {
          // Test transport release is the real public candidate release path.
          const remote = (
            options.remotes as { name: string; entry: string }[]
          )[0]!;
          releaseLease?.();
          releaseNativeBrowserDevClient(remote.name, remote.entry);
        },
      };
    },
  });
  plugin.beforeInit({ origin: host });
  const bind = (expose: string): (() => void) => {
    const unbind = Reflect.get(host, NATIVE_BROWSER_DEV_BOUNDARY)(
      `${name}/${expose}`,
      {},
      {},
    ) as () => void;
    disposers.push(unbind);
    return unbind;
  };
  const unbind = bind('Widget');
  return {
    reload,
    errors,
    overlays,
    oldClient,
    unbind,
    bind,
    failExpose(expose: string) {
      failingExpose = expose;
    },
    setProcess(value: string) {
      buildId = value;
    },
    setGraph(nextHash: string, digit: string) {
      hash = nextHash;
      revision = digit.repeat(64);
    },
    setFailure(value: typeof failure) {
      failure = value;
    },
    setGate(value: Promise<void>) {
      gate = value;
    },
    setLoadFailure(value: boolean) {
      loadFailure = value;
    },
    setDuringNativeExecution(callback: () => void) {
      duringNativeExecution = callback;
    },
    overlay: () => ({ body: activeOverlay, clears: overlayClears }),
    update() {
      const socket = Socket.instances[0]!;
      socket.message('hash', hash);
      socket.message('ok');
    },
    counts: () => ({ checks, executions, customInstalled, customReleased }),
  };
}

test('same-process edits keep the ordinary hot-check protocol and dispose its listeners', async () => {
  const h = fixture();
  h.update();
  await settle();
  expect(h.counts()).toMatchObject({ checks: 1, executions: 0 });
  expect(Socket.instances).toHaveLength(1);
  expect(h.reload).not.toHaveBeenCalled();
  h.oldClient();
  expect(Socket.instances[0]!.closed).toBe(true);
  expect(h.counts().customInstalled).toBe(h.counts().customReleased);
});

test('a restarted admitted graph hands its one socket to the new native owner without old hot-check or reload', async () => {
  const h = fixture();
  h.setProcess('restarted-process');
  h.update();
  await settle();
  expect(h.counts()).toMatchObject({ checks: 0, executions: 1 });
  expect(Socket.instances).toHaveLength(2);
  expect(Socket.instances[0]!.closed).toBe(true);
  expect(Socket.instances[1]!.closed).toBe(false);
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.errors).not.toHaveBeenCalled();
});

test('precommit failure surfaces the error, keeps the old socket and can accept a newer graph', async () => {
  const h = fixture();
  h.setProcess('restarted-process');
  h.setFailure('before');
  h.update();
  await settle();
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0]!.closed).toBe(false);
  expect(h.errors).toHaveBeenCalled();
  expect(h.overlays.join('\n')).toContain('factory failed');
  expect(h.counts().checks).toBe(0);
  expect(h.reload).not.toHaveBeenCalled();
  h.setFailure(undefined);
  h.setGraph('cc33', 'c');
  h.update();
  await settle();
  expect(Socket.instances).toHaveLength(2);
  expect(Socket.instances[0]!.closed).toBe(true);
  expect(h.counts().executions).toBe(2);
});

test('observed native commit failure transfers recovery transport but never reports success', async () => {
  const h = fixture();
  h.setProcess('restarted-process');
  h.setFailure('after');
  h.update();
  await settle();
  expect(Socket.instances).toHaveLength(2);
  expect(Socket.instances[0]!.closed).toBe(true);
  expect(Socket.instances[1]!.closed).toBe(false);
  expect(h.overlays.join('\n')).toContain('native callback failed');
  expect(h.errors).toHaveBeenCalled();
  expect(h.counts().checks).toBe(0);
  expect(h.reload).not.toHaveBeenCalled();
});

test('a forged matching native outcome from exposed code cannot transfer the working socket', async () => {
  const h = fixture();
  h.setProcess('restarted-process');
  h.setFailure('forged');
  h.update();
  await settle();
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0]!.closed).toBe(false);
  expect(h.overlays.join('\n')).toContain('forged factory failure');
  expect(h.errors).toHaveBeenCalled();
  expect(h.counts().checks).toBe(0);
  expect(h.reload).not.toHaveBeenCalled();
});

test('disposed loading cannot reactivate an old or candidate socket or execute the exposed graph', async () => {
  const h = fixture();
  let finish!: () => void;
  h.setGate(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  h.setProcess('restarted-process');
  h.update();
  await settle();
  h.oldClient();
  h.unbind();
  finish();
  await settle();
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0]!.closed).toBe(true);
  expect(h.counts().executions).toBe(0);
  expect(h.reload).not.toHaveBeenCalled();
});

test('retrying an unexecuted cached graph rearms custom hot registration before factory execution without a premature socket', async () => {
  const h = fixture();
  h.setProcess('restarted-process');
  h.setLoadFailure(true);
  h.update();
  await settle();
  expect(h.counts()).toMatchObject({
    executions: 0,
    customInstalled: 2,
    customReleased: 1,
  });
  expect(Socket.instances).toHaveLength(1);
  h.setLoadFailure(false);
  h.update();
  await settle();
  expect(h.counts()).toMatchObject({
    executions: 1,
    customInstalled: 3,
    customReleased: 2,
  });
  expect(Socket.instances).toHaveLength(2);
  expect(Socket.instances[0]!.closed).toBe(true);
  expect(Socket.instances[1]!.closed).toBe(false);
  expect(h.reload).not.toHaveBeenCalled();
});

test('the accepted runtime keeps its ordinary socket after the final publisher unmounts', async () => {
  const h = fixture();
  h.setProcess('restarted-process');
  h.update();
  await settle();
  const acceptedSocket = Socket.instances[1]!;
  expect(acceptedSocket.closed).toBe(false);
  h.unbind();
  expect(acceptedSocket.closed).toBe(false);

  // A remote may remain loaded after its last mounted component disappears.
  // Its next ordinary edit still needs the accepted runtime's HMR transport.
  h.setGraph('cc33', 'c');
  acceptedSocket.message('hash', 'cc33');
  acceptedSocket.message('ok');
  await settle();
  expect(h.counts()).toMatchObject({ checks: 1, executions: 1 });
  expect(acceptedSocket.closed).toBe(false);
  expect(Socket.instances).toHaveLength(2);
  expect(h.reload).not.toHaveBeenCalled();
});

test('native commit failure stays visible through the accepted socket initial same-hash handshake', async () => {
  const h = fixture();
  h.setProcess('restarted-process');
  h.setFailure('after');
  h.update();
  await settle();
  const acceptedSocket = Socket.instances[1]!;
  const failedOverlay = h.overlay();
  expect(failedOverlay.body).toContain('native callback failed');

  acceptedSocket.message('hash', 'bb22');
  acceptedSocket.message('ok');
  await settle();
  expect(h.overlay()).toEqual(failedOverlay);
  expect(h.counts()).toMatchObject({ checks: 0, executions: 1 });
  expect(acceptedSocket.closed).toBe(false);

  h.setFailure(undefined);
  h.setGraph('cc33', 'c');
  acceptedSocket.message('hash', 'cc33');
  acceptedSocket.message('ok');
  await settle();
  expect(h.overlay().body).toBeUndefined();
  expect(h.overlay().clears).toBeGreaterThan(failedOverlay.clears);
  expect(h.counts()).toMatchObject({ checks: 1, executions: 1 });
  expect(h.reload).not.toHaveBeenCalled();
});

test.each([false, true])(
  'publisher disposal during native execution cannot activate the candidate socket (runtime disposed: %s)',
  async disposeRuntime => {
    const h = fixture();
    h.setProcess('restarted-process');
    h.setDuringNativeExecution(() => {
      h.unbind();
      if (disposeRuntime) h.oldClient();
    });
    h.update();
    await settle();
    expect(h.counts().executions).toBe(1);
    expect(Socket.instances).toHaveLength(1);
    expect(Socket.instances[0]!.closed).toBe(disposeRuntime);
    expect(h.counts().customInstalled - h.counts().customReleased).toBe(
      disposeRuntime ? 0 : 1,
    );
    expect(h.reload).not.toHaveBeenCalled();
  },
);

test('a later distinct exposed-root failure cannot retire the earlier accepted runtime lease', async () => {
  const h = fixture();
  const unbindOther = h.bind('Other');
  h.setProcess('restarted-process');
  h.failExpose('Other');
  h.update();
  await settle();

  // Widget committed into the fresh runtime before Other failed. The second
  // stage must release only its own lease, leaving Widget's interceptor alive.
  expect(h.counts()).toMatchObject({
    checks: 0,
    executions: 2,
    customInstalled: 2,
    customReleased: 1,
  });
  expect(Socket.instances).toHaveLength(2);
  expect(Socket.instances[0]!.closed).toBe(true);
  const recoverySocket = Socket.instances[1]!;
  expect(recoverySocket.closed).toBe(false);
  expect(h.overlay().body).toContain('factory failed for Other');
  expect(h.errors).toHaveBeenCalled();
  expect(h.reload).not.toHaveBeenCalled();

  // The fresh runtime remains the transport owner even when both publishers
  // later unmount; a module's real hot.dispose, not a stage, retires its socket.
  h.unbind();
  unbindOther();
  expect(recoverySocket.closed).toBe(false);
  expect(h.counts().customInstalled - h.counts().customReleased).toBe(1);
  h.setGraph('cc33', 'c');
  recoverySocket.message('hash', 'cc33');
  recoverySocket.message('ok');
  await settle();
  expect(h.counts()).toMatchObject({ checks: 1, executions: 2 });
  expect(h.reload).not.toHaveBeenCalled();
});
