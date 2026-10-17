import { AsyncLocalStorage } from 'node:async_hooks';

interface ManifestRemote {
  readonly name: string;
  readonly alias: string;
  readonly entry: string;
}

interface RemoteInfo {
  readonly name: string;
  readonly entry: string;
}

interface NativeHost {
  readonly options?: unknown;
  readonly shareScopeMap?: Record<
    string,
    Record<
      string,
      Record<string, { loaded?: boolean; loading?: unknown; lib?: unknown }>
    >
  >;
  loadShare?(pkgName: string): Promise<unknown>;
  loadRemote<T>(id: string, options?: unknown): Promise<T | null>;
  registerRemotes(remotes: ManifestRemote[], options: { force: true }): void;
  readonly loaderHook: {
    readonly lifecycle: {
      readonly fetch: {
        emit(
          url: string,
          init: RequestInit,
          remoteInfo: RemoteInfo,
          context: {
            initiator: 'loadRemote';
            id: string;
            resourceType: 'remoteEntry';
            url: string;
            expose?: string;
          },
        ): Promise<Response | false | void>;
      };
    };
  };
  [LOAD_WITH_CAPTURE]?: <T, Captured>(
    id: string,
    capture: (module: T | null, resolution?: LoadResolution) => Captured,
  ) => Promise<{ module: T | null; captured: Captured | undefined }>;
}

const LOAD_WITH_CAPTURE = Symbol.for(
  'ultramodern.federation.load-with-capture',
);

interface RemoteLane {
  readonly remote: ManifestRemote;
  readonly active: Set<Promise<unknown>>;
  info?: RemoteInfo;
  revision?: string | null;
  candidate?: string | null;
  transition?: Promise<unknown>;
  probe?: Promise<string | null>;
  snapshot?: unknown;
}

interface LoadLease {
  readonly host: NativeHost;
  readonly parent?: LoadLease;
  lane?: RemoteLane;
  admitted?: boolean;
  active?: boolean;
  snapshot?: unknown;
  resolution?: LoadResolution;
  release?: (success: boolean) => void;
}

interface LoadResolution {
  readonly remoteSnapshot: unknown;
  readonly expose: string;
}

export interface NativeDevRefreshOptions {
  readonly remotes: readonly ManifestRemote[];
  readonly revisionHeader: string;
  readonly requestTimeout: number;
  /** Exact and prefix singleton keys owned by the selected native adapter. */
  readonly shared?: readonly string[];
}

/**
 * Retain the host and its shared factories while refreshing one completed
 * development remote. Production remotes without a revision keep native MF's
 * ordinary cache. The compiler registers this plugin only on Node dev hosts.
 */
export default function nativeDevRefreshRuntimePlugin(
  options: NativeDevRefreshOptions,
) {
  if (
    !options.revisionHeader ||
    !Number.isSafeInteger(options.requestTimeout) ||
    options.requestTimeout <= 0
  )
    throw new TypeError(
      'Native federation dev refresh requires a bounded revision probe.',
    );
  const hosts = new WeakMap<NativeHost, Map<string, RemoteLane>>();
  const calls = new AsyncLocalStorage<LoadLease>();

  const probe = (
    host: NativeHost,
    lane: RemoteLane,
    expose?: string,
  ): Promise<string | null> => {
    if (lane.probe) return lane.probe;
    const info = lane.info;
    if (!info)
      throw new Error('Native federation dev remote has no admitted entry.');
    const pending = (async () => {
      const init: RequestInit = {
        method: 'HEAD',
        cache: 'no-store',
        signal: AbortSignal.timeout(options.requestTimeout),
      };
      // Use the same native fetch lifecycle as entry loading, including any
      // authored authentication hooks and the shared bounded Node transport.
      let clearDeadline!: () => void;
      const signal = init.signal!;
      const deadline = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        clearDeadline = () => signal.removeEventListener('abort', abort);
      });
      const request = (async () => {
        const hooked = await host.loaderHook.lifecycle.fetch.emit(
          info.entry,
          init,
          info,
          {
            initiator: 'loadRemote',
            id:
              expose && expose !== '.'
                ? `${info.name}/${expose.replace(/^\.\//u, '')}`
                : info.name,
            resourceType: 'remoteEntry',
            url: info.entry,
            expose,
          },
        );
        const response =
          hooked instanceof Response
            ? hooked
            : await globalThis.fetch(info.entry, init);
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw signal.reason;
        }
        return response;
      })();
      let response: Response;
      try {
        // Authored hooks must receive the native transport context, but a
        // hook ignoring the signal must not hold this remote's gate forever.
        response = await Promise.race([request, deadline]);
      } finally {
        clearDeadline();
      }
      void response.body?.cancel().catch(() => {});
      if (!response.ok)
        throw Object.assign(
          new Error(
            `Native federation dev revision request failed: ${response.status} ${info.entry}`,
          ),
          {
            status: response.status,
          },
        );
      const revision = response.headers.get(options.revisionHeader);
      if (revision !== null && !/^[a-f0-9]{64}$/u.test(revision))
        throw new Error(
          'Native federation dev remote returned an invalid graph revision.',
        );
      if (revision === null && typeof lane.revision === 'string')
        throw new Error(
          'Native federation dev remote lost its completed graph revision.',
        );
      return revision;
    })();
    lane.probe = pending;
    const clear = () => {
      if (lane.probe === pending) lane.probe = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  };

  return {
    name: 'ultramodern-native-federation-dev-refresh',
    beforeInit<T extends { origin: NativeHost }>(args: T): T {
      const host = args.origin;
      if (hosts.has(host)) return args;
      const lanes = new Map<string, RemoteLane>(
        options.remotes.map(remote => [
          remote.name,
          {
            remote: { ...remote },
            active: new Set<Promise<unknown>>(),
          } satisfies RemoteLane,
        ]),
      );
      hosts.set(host, lanes);
      const load = host.loadRemote.bind(host);
      const loadWithCapture = async <Module, Captured>(
        id: string,
        loadOptions?: unknown,
        capture?: (
          module: Module | null,
          resolution?: LoadResolution,
        ) => Captured,
      ): Promise<{ module: Module | null; captured: Captured | undefined }> => {
        const parent = calls.getStore();
        const lease: LoadLease = {
          host,
          ...(parent?.host === host ? { parent } : {}),
        };
        return calls.run(lease, async () => {
          let success = false;
          try {
            const module = await load<Module>(id, loadOptions);
            // Capture this container's admitted assets before releasing its
            // lease, even when native hooks rewrite the requested module ID.
            const captured = capture?.(module, lease.resolution);
            success = module !== null && lease.admitted === true;
            return { module, captured };
          } finally {
            lease.active = false;
            lease.release?.(success);
          }
        });
      };
      host.loadRemote = async <Module>(id: string, loadOptions?: unknown) =>
        (await loadWithCapture<Module, never>(id, loadOptions)).module;
      host[LOAD_WITH_CAPTURE] = <Module, Captured>(
        id: string,
        capture: (
          module: Module | null,
          resolution?: LoadResolution,
        ) => Captured,
      ) => loadWithCapture(id, undefined, capture);
      return args;
    },
    async beforeRequest<T extends { origin: NativeHost; id: string }>(
      args: T,
    ): Promise<T> {
      const lease = calls.getStore();
      if (!lease || lease.host !== args.origin) return args;
      // Authored beforeRequest hooks have already rewritten the ID. Discover
      // its actual remote here without executing those hooks a second time.
      const lane = [...(hosts.get(args.origin)?.values() ?? [])].find(
        ({ remote }) =>
          [remote.alias, remote.name].some(
            name => args.id === name || args.id.startsWith(`${name}/`),
          ),
      );
      if (!lane || lease.lane) return args;
      lease.lane = lane;
      const prefix = [lane.remote.alias, lane.remote.name].find(
        name => args.id === name || args.id.startsWith(`${name}/`),
      )!;
      const expose =
        args.id === prefix ? '.' : `./${args.id.slice(prefix.length + 1)}`;
      for (let ancestor = lease.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.lane === lane && ancestor.active) {
          // An authored native hook may await another expose on this host.
          // Its ancestor already fences this remote's generation; borrowing
          // that lease avoids waiting for or draining the current call itself.
          // Track the child as well: a hook may start it without awaiting it,
          // and a later refresh must still wait for that older native load.
          let release!: () => void;
          const finished = new Promise<void>(resolve => {
            release = resolve;
          });
          lane.active.add(finished);
          lease.active = true;
          lease.snapshot = ancestor.snapshot;
          lease.release = () => {
            lane.active.delete(finished);
            release();
          };
          return args;
        }
      }
      for (;;) {
        if (lane.transition) {
          await lane.transition;
          continue;
        }
        const revision =
          lane.revision === undefined
            ? undefined
            : lane.revision === null
              ? null
              : await probe(args.origin, lane, expose);
        if (lane.transition) {
          await lane.transition;
          continue;
        }
        let finish!: () => void;
        const finished = new Promise<void>(resolve => {
          finish = resolve;
        });
        if (lane.revision === undefined || revision !== lane.revision) {
          lane.transition = finished;
          lease.release = success => {
            if (success) lane.revision = lane.candidate ?? null;
            if (lane.transition === finished) lane.transition = undefined;
            finish();
          };
          // Finish older native loads, including their asset capture, before
          // evicting this remote. New calls wait for this admission to finish.
          while (lane.active.size) await Promise.allSettled([...lane.active]);
          lane.candidate = revision;
          if (lane.revision !== undefined) {
            // Authored share hooks may load another expose while we retain
            // providers. Let those calls borrow the still-current generation,
            // then drain any child they started before evicting its container.
            lease.active = true;
            lease.snapshot = lane.snapshot;
            // Native force-registration removes remote-origin providers that
            // only the remote explicitly consumed. The host can still retain
            // their private state through another shared renderer export.
            // Record those loaded providers as host uses through the ordinary
            // share lifecycle before native eviction; do not reload unused
            // providers or mutate native factory/cache records ourselves.
            const retained = new Set<string>();
            for (const scope of Object.values(args.origin.shareScopeMap ?? {}))
              for (const [pkgName, versions] of Object.entries(scope))
                if (
                  options.shared?.some(
                    key =>
                      key === pkgName ||
                      (key.endsWith('/') && pkgName.startsWith(key)),
                  ) &&
                  Object.values(versions).some(
                    shared => shared.loaded || shared.loading || shared.lib,
                  )
                )
                  retained.add(pkgName);
            for (const pkgName of retained) {
              if (!args.origin.loadShare)
                throw new TypeError(
                  'Native federation dev refresh requires the host share lifecycle.',
                );
              await args.origin.loadShare(pkgName);
            }
            while (lane.active.size) await Promise.allSettled([...lane.active]);
            args.origin.registerRemotes([{ ...lane.remote }], { force: true });
            lease.snapshot = undefined;
          }
        } else {
          lane.active.add(finished);
          lease.release = () => {
            lane.active.delete(finished);
            finish();
          };
        }
        lease.active = true;
        return args;
      }
    },
    loadSnapshot<
      T extends {
        options: unknown;
        moduleInfo: { name: string };
        remoteSnapshot?: unknown;
      },
    >(args: T): T {
      const lease = calls.getStore();
      if (
        !lease ||
        args.options !== lease.host.options ||
        args.moduleInfo.name !== lease.lane?.remote.name
      )
        return args;
      // A borrowed load uses its active ancestor's generation, even when a
      // different host has replaced the process-global snapshot meanwhile.
      // Native snapshot and renderer admission still validate this selection.
      if (lease.snapshot !== undefined)
        return { ...args, remoteSnapshot: lease.snapshot };
      lease.snapshot = args.remoteSnapshot;
      return args;
    },
    afterLoadSnapshot<
      T extends {
        host: NativeHost;
        moduleInfo: { name: string };
        remoteSnapshot: unknown;
      },
    >(args: T): T {
      const lease = calls.getStore();
      if (
        lease?.host === args.host &&
        args.moduleInfo.name === lease.lane?.remote.name
      )
        // Initial manifest loads have no snapshot at loadSnapshot. Retain the
        // resolved snapshot before authored afterResolve hooks can nest loads.
        lease.snapshot = args.remoteSnapshot;
      return args;
    },
    async afterResolve<
      T extends {
        origin: NativeHost;
        remote: { name: string };
        remoteInfo: RemoteInfo;
        remoteSnapshot: unknown;
        expose: string;
      },
    >(args: T): Promise<T> {
      const lane = hosts.get(args.origin)?.get(args.remote.name);
      const lease = calls.getStore();
      if (
        !lane ||
        lease?.host !== args.origin ||
        lease.lane !== lane ||
        !lease.active
      )
        return args;
      // Preloads and direct remote-handler resolutions have no load lease.
      // They must not change the entry or candidate a guarded refresh commits.
      if (lane.info?.entry !== args.remoteInfo.entry)
        lane.candidate = undefined;
      lane.info = args.remoteInfo;
      if (lane.candidate === undefined)
        lane.candidate = await probe(args.origin, lane, args.expose);
      lease.admitted = true;
      lane.snapshot = args.remoteSnapshot;
      // Native force-registration evicts a process-global snapshot. Retain
      // the snapshot this particular host/load admitted, so another host's
      // refresh cannot change its later CSS and hydration asset capture.
      lease.resolution = {
        remoteSnapshot: args.remoteSnapshot,
        expose: args.expose,
      };
      return args;
    },
  };
}
