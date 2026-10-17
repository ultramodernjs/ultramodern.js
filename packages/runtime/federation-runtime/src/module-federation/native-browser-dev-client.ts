import { isNativeBrowserDevCommitError } from './native-browser-dev-refresh';
import {
  hasNativeBrowserDevPublisher,
  type NativeBrowserDevPublication,
  readNativeBrowserDevPublication,
  replaceNativeBrowserDevRemote,
} from './native-browser-dev-runtime-plugin';

interface HotRuntime {
  status(): string;
  check(apply: true): Promise<readonly unknown[] | null>;
}
interface Overlay {
  create(title: string, body: string): void;
  clear(): void;
}
interface Client {
  arm(): void;
  lease(): () => void;
  releaseStandby(): void;
  start(): void;
  stop(): void;
}
interface Clients {
  active?: Client;
  failure?: { readonly runtimeHash: string; readonly error: unknown };
  readonly candidates: Map<string, WeakRef<Client>>;
}
const CLIENTS = Symbol.for('ultramodern.federation.browser-dev-clients.v1');
const clients = (): Map<string, Clients> => {
  const root = globalThis as typeof globalThis & {
    [CLIENTS]?: Map<string, Clients>;
  };
  if (!root[CLIENTS])
    Object.defineProperty(root, CLIENTS, { value: new Map() });
  return root[CLIENTS]!;
};

/** Called only after the native synchronous factory transaction has accepted. */
function commitClient(
  remoteName: string,
  graph: NativeBrowserDevPublication,
): void {
  const state = clients().get(remoteName);
  const next = state?.candidates.get(graph.runtimeHash)?.deref();
  if (!state || !next)
    throw new Error('Accepted native graph has no matching fresh HMR runtime.');
  if (state.active === next) return;
  state.active?.stop();
  state.active = next;
  next.start();
}

/** Rearm only a loaded standby runtime before its exposed factory executes. */
export function prepareNativeBrowserDevClient(
  remoteName: string,
  manifest: string,
): () => void {
  const hash = /\/__ultramodern_mf__\/([a-f0-9]+)\//u.exec(
    new URL(manifest).pathname,
  )?.[1];
  const candidate =
    hash && clients().get(remoteName)?.candidates.get(hash)?.deref();
  if (!candidate)
    throw new Error('Native graph has no loaded standby HMR runtime.');
  return candidate.lease();
}

/** Release attempt-owned activity without evicting any working shared owner. */
export function releaseNativeBrowserDevClient(
  remoteName: string,
  manifest: string,
): void {
  const hash = /\/__ultramodern_mf__\/([a-f0-9]+)\//u.exec(
    new URL(manifest).pathname,
  )?.[1];
  if (!hash) return;
  const state = clients().get(remoteName);
  const candidate = state?.candidates.get(hash)?.deref();
  if (!state || !candidate) return;
  candidate.releaseStandby();
  // A failed asynchronous chunk load can retry the same unexecuted factory.
  // Weak routing retains no transport resources and permits its cached runtime
  // to start after a later successful native transaction.
}

/** Rsbuild's ordinary socket/check protocol, with an explicit native handoff. */
export function startNativeBrowserDevClient(options: {
  readonly remoteName: string;
  readonly buildId: string;
  readonly revisionHeader: string;
  readonly token: string;
  readonly config: {
    readonly host?: string;
    readonly port?: number | string;
    readonly protocol?: string;
    readonly path: string;
    readonly reconnect: number;
    readonly overlay?: boolean | { readonly errors?: boolean };
  };
  readonly serverHost: string;
  readonly serverPort: number;
  readonly serverBase: string;
  readonly liveReload: boolean;
  readonly browserLogs: boolean;
  readonly logLevel: string;
  readonly resolveWebSocketUrl?: (url: string) => string;
  readonly hot: HotRuntime | undefined;
  readonly hash: () => string;
  readonly overlay: () => Overlay | undefined;
  readonly installCustomListeners: (
    listeners: Map<string, ((value: unknown) => void)[]>,
  ) => () => void;
}): () => void {
  const state: Clients = clients().get(options.remoteName) ?? {
    candidates: new Map(),
  };
  clients().set(options.remoteName, state);
  const initialHash = options.hash();
  let socket: WebSocket | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let reconnectCount = 0;
  let lastHash: string | undefined;
  let running = false;
  let applying: Promise<void> | undefined;
  let lifetime: AbortController | undefined;
  let removeCustom: (() => void) | undefined;
  const custom = new Map<string, ((value: unknown) => void)[]>();
  const queued: unknown[] = [];
  const leases = new Set<object>();
  const base = options.serverBase.endsWith('/')
    ? options.serverBase
    : `${options.serverBase}/`;
  const report = (error: unknown) => {
    console.error(
      '[ultramodern] Native federation development update failed:',
      error,
    );
    if (
      options.config.overlay !== false &&
      (typeof options.config.overlay !== 'object' ||
        options.config.overlay.errors !== false)
    )
      options
        .overlay()
        ?.create('Native federation update failed', String(error));
  };
  const send = (message: unknown) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
    else queued.push(message);
  };
  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const onError = (event: ErrorEvent) =>
    send({
      type: 'client-error',
      id: crypto.randomUUID(),
      message: event.message,
      name: event.error?.name,
      stack: event.error?.stack,
    });
  const onRejected = (event: PromiseRejectionEvent) =>
    send({
      type: 'client-error',
      id: crypto.randomUUID(),
      message: `Uncaught (in promise) ${errorMessage(event.reason)}`,
      name: event.reason?.name,
      stack: event.reason?.stack,
    });
  const fullReload = (data?: { path?: string }) => {
    if (!options.liveReload) return;
    if (data?.path?.endsWith('.html')) {
      const pathname = decodeURI(location.pathname);
      const target = base + data.path.slice(1);
      if (
        pathname !== target &&
        pathname !== target.slice(0, -5) &&
        !(pathname.endsWith('/') && `${pathname}index.html` === target)
      )
        return;
    }
    location.reload();
  };
  const apply = (): void => {
    if (!running || applying || !lastHash || lastHash === options.hash())
      return;
    const signal = lifetime!.signal;
    const targetHash = lastHash;
    applying = (async () => {
      if (hasNativeBrowserDevPublisher(options.remoteName)) {
        const graph = await readNativeBrowserDevPublication(
          options.remoteName,
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
            revisionHeader: options.revisionHeader,
          },
        );
        if (signal.aborted) throw signal.reason;
        if (graph.buildId !== options.buildId) {
          // Never ask an obsolete process's runtime for a missing hot-update
          // chain. The normal manifest admission and native capability must
          // accept the fresh factory before its socket can replace this one.
          try {
            await replaceNativeBrowserDevRemote(graph);
          } catch (error) {
            if (
              running &&
              !signal.aborted &&
              hasNativeBrowserDevPublisher(options.remoteName) &&
              isNativeBrowserDevCommitError(error, graph.revision)
            ) {
              // Moving the socket aborts this old client's lifetime. Report
              // first so that abort cannot hide the native callback failure.
              state.failure = { runtimeHash: graph.runtimeHash, error };
              report(error);
              // The native owner already began an irreversible transfer. Keep
              // its fresh runtime available for recovery, then surface failure.
              commitClient(options.remoteName, graph);
            }
            throw error;
          }
          if (
            !running ||
            signal.aborted ||
            !hasNativeBrowserDevPublisher(options.remoteName)
          )
            return;
          commitClient(options.remoteName, graph);
          return;
        }
      }
      if (!options.hot) return fullReload();
      if (options.hot.status() !== 'idle') return;
      try {
        const updated = await options.hot.check(true);
        if (!updated) fullReload();
      } catch (error) {
        console.error(
          '[rsbuild] HMR update failed, performing full reload:',
          error,
        );
        fullReload();
      }
    })()
      .catch(error => {
        // No failed graph acknowledges a completed update. Precommit failures
        // retain the original owner; native commit failures keep recovery owners.
        // Surface the failure without aborting an obsolete runtime's hot check.
        if (!signal.aborted) report(error);
      })
      .finally(() => {
        applying = undefined;
        if (running && !signal.aborted && lastHash !== targetHash) apply();
      });
  };
  const clearOverlayForBuild = () => {
    if (state.failure) {
      // A fresh runtime's initial hash/ok handshake acknowledges the same
      // failed graph, not a repaired native owner. Keep that failure visible.
      if (!lastHash || lastHash === state.failure.runtimeHash) return;
      state.failure = undefined;
    }
    options.overlay()?.clear();
  };
  const message = (event: MessageEvent<string>) => {
    let value: { type: string; data?: any };
    try {
      value = JSON.parse(event.data);
    } catch (error) {
      report(error);
      return;
    }
    switch (value.type) {
      case 'hash':
        lastHash = value.data;
        break;
      case 'ok':
        clearOverlayForBuild();
        apply();
        break;
      case 'warnings':
        for (const warning of value.data?.text ?? []) console.warn(warning);
        clearOverlayForBuild();
        apply();
        break;
      case 'errors':
        for (const error of value.data?.text ?? []) console.error(error);
        if (value.data?.html)
          options.overlay()?.create('Build failed', value.data.html);
        break;
      case 'full-reload':
        fullReload(value.data);
        break;
      case 'static-changed':
        fullReload();
        break;
      case 'custom':
        for (const listener of custom.get(value.data?.event) ?? [])
          listener(value.data.data);
        break;
      case 'resolved-client-error':
        options
          .overlay()
          ?.create('Runtime errors', String(value.data?.message ?? ''));
        break;
    }
  };
  const socketUrl = (fallback: boolean) => {
    const url = new URL('http://localhost');
    url.hostname =
      (fallback ? options.serverHost : options.config.host) ||
      location.hostname;
    url.port = String(
      (fallback ? options.serverPort : options.config.port) || location.port,
    );
    url.protocol =
      options.config.protocol ||
      (location.protocol === 'https:' ? 'wss:' : 'ws:');
    url.pathname = options.config.path;
    url.searchParams.set('token', options.token);
    return options.resolveWebSocketUrl?.(url.href) ?? url.href;
  };
  const detachSocket = () => {
    clearInterval(ping);
    ping = undefined;
    const previous = socket;
    socket = undefined;
    if (!previous) return;
    previous.onopen =
      previous.onclose =
      previous.onmessage =
      previous.onerror =
        null;
    previous.close();
  };
  const connect = (fallback = false) => {
    if (!running) return;
    socket = new WebSocket(socketUrl(fallback));
    socket.onopen = () => {
      reconnectCount = 0;
      ping = setInterval(() => send({ type: 'ping' }), 30000);
      for (const item of queued.splice(0)) send(item);
    };
    socket.onmessage = message;
    socket.onclose = () => {
      detachSocket();
      if (!running || reconnectCount >= options.config.reconnect) return;
      reconnectCount++;
      reconnect = setTimeout(() => connect(), 1000 * 1.5 ** reconnectCount);
    };
    socket.onerror = () => {
      if (
        options.resolveWebSocketUrl ||
        fallback ||
        socketUrl(false) === socketUrl(true)
      )
        return;
      detachSocket();
      connect(true);
    };
  };
  const client: Client = {
    arm() {
      removeCustom ??= options.installCustomListeners(custom);
    },
    lease() {
      const lease = {};
      leases.add(lease);
      client.arm();
      return () => {
        if (!leases.delete(lease)) return;
        client.releaseStandby();
      };
    },
    releaseStandby() {
      // A live runtime remains the ordinary remote HMR owner even when its
      // final publisher unmounts. Another expose can also hold this candidate.
      if (state.active !== client && !leases.size) client.stop();
    },
    start() {
      if (running) return;
      running = true;
      lifetime = new AbortController();
      client.arm();
      if (options.browserLogs) {
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejected);
      }
      connect();
    },
    stop() {
      if (!running && !removeCustom) return;
      running = false;
      lifetime?.abort(new Error('Native browser HMR runtime retired.'));
      clearTimeout(reconnect);
      reconnect = undefined;
      detachSocket();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejected);
      removeCustom?.();
      removeCustom = undefined;
      custom.clear();
      queued.length = 0;
    },
  };
  // Standby runtimes need custom hot listeners before their exposed modules
  // execute, but have no socket/global error listeners until native acceptance.
  client.arm();
  state.candidates.set(initialHash, new WeakRef(client));
  if (!state.active) {
    state.active = client;
    client.start();
  }
  return () => {
    client.stop();
    if (state.active === client) state.active = undefined;
    if (state.candidates.get(initialHash)?.deref() === client)
      state.candidates.delete(initialHash);
    if (!state.active && !state.candidates.size)
      clients().delete(options.remoteName);
  };
}
