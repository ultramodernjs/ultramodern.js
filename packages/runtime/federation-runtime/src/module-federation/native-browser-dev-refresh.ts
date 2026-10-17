/** The normal MF instance surface used by a browser development replacement. */
export interface NativeBrowserDevHost {
  readonly name: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly shareScopeMap: Record<
    string,
    Record<string, Record<string, Shared>>
  >;
  readonly moduleCache: Map<string, unknown>;
  readonly loaderHook?: {
    readonly lifecycle: {
      readonly fetch: {
        emit(
          url: string,
          init: RequestInit,
          remote: unknown,
          context: {
            readonly initiator: 'loadRemote';
            readonly id: string;
            readonly resourceType: 'manifest';
            readonly url: string;
          },
        ): Promise<unknown>;
      };
    };
  };
  initShareScopeMap(
    name: string,
    scope: Record<string, Record<string, Shared>>,
    options: { hostShareScopeMap: NativeBrowserDevHost['shareScopeMap'] },
  ): void;
  loadRemote<T>(id: string, options: { loadFactory: false }): Promise<T | null>;
}

interface Shared {
  readonly loaded?: boolean;
  readonly loading?: unknown;
  readonly lib?: unknown;
  readonly get?: unknown;
}

export interface NativeBrowserDevGraph {
  /** Existing completed graph revision, also used in immutable asset URLs. */
  readonly revision: string;
  /** Native JSON manifest whose entry AND chunks belong to this revision. */
  readonly remote: Readonly<{ name: string; alias: string; entry: string }>;
}

interface StagingHost {
  readonly host: NativeBrowserDevHost;
  /** Rearm cached, unexecuted runtime hot listeners without starting a socket. */
  prepareFactory?(): void;
  /** Retire only this attempt's transport/listeners; never shared providers. */
  release(): void;
}

interface PublisherReplacement {
  readonly commitStarted: boolean;
  execute<T>(factory: () => T): T;
}

const COMMIT_ERROR = Symbol.for(
  'ultramodern.federation.browser-dev-commit-error.v1',
);

/** Propagates an observed native mutation; it does not grant native authority. */
class NativeBrowserDevCommitError extends Error {
  readonly [COMMIT_ERROR] = true;
  declare readonly revision: string;

  constructor(revision: string, cause: unknown) {
    super(
      `Native browser refresh failed after ownership transfer began: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'NativeBrowserDevCommitError';
    Object.defineProperty(this, 'revision', {
      value: revision,
      enumerable: true,
    });
  }
}

/** A remote runtime can receive this error from a different host runtime copy. */
export function isNativeBrowserDevCommitError(
  error: unknown,
  revision: string,
): error is NativeBrowserDevCommitError {
  return (
    error instanceof Error &&
    Reflect.get(error, COMMIT_ERROR) === true &&
    Reflect.get(error, 'revision') === revision
  );
}

/** Trusted coordinators use this only after observing an actual native commit. */
export function nativeBrowserDevCommitFailure(
  revision: string,
  cause: unknown,
): Error {
  return new NativeBrowserDevCommitError(revision, cause);
}

interface SelectedShare {
  readonly scope: string;
  readonly name: string;
  readonly version: string;
  readonly provider: Shared;
  readonly lib: unknown;
  readonly get: unknown;
}

const selectedShares = (host: NativeBrowserDevHost): SelectedShare[] =>
  Object.entries(host.shareScopeMap).flatMap(([scope, packages]) =>
    Object.entries(packages).flatMap(([name, versions]) =>
      Object.entries(versions)
        .filter(([, provider]) => provider.loaded || provider.loading)
        .map(([version, provider]) => ({
          scope,
          name,
          version,
          provider,
          lib: provider.lib,
          get: provider.get,
        })),
    ),
  );

function assertSelectedShares(
  host: NativeBrowserDevHost,
  shares: readonly SelectedShare[],
): void {
  for (const share of shares) {
    const provider =
      host.shareScopeMap[share.scope]?.[share.name]?.[share.version];
    if (
      provider !== share.provider ||
      provider.lib !== share.lib ||
      provider.get !== share.get
    )
      throw new Error(
        `Native browser refresh changed the selected shared provider ${share.name}.`,
      );
  }
}

/**
 * Load a new container without evicting the working host. MF admission and async
 * chunk loading finish before Octane executes the synchronous exposed graph.
 * Native execution owns declaration rollback and retirement of the old graph.
 * It cannot undo arbitrary module side effects or the browser's ESM cache: a
 * consumed, failed graph needs a newer completed revision for another attempt.
 *
 * The compiler supplies a public ModuleFederation constructor adapter and an
 * attempt-owned transport release function. No global MF cache is deleted here.
 */
export function createNativeBrowserDevRefresh<Boundary>(options: {
  readonly host: NativeBrowserDevHost;
  readonly id: string;
  readonly boundary: Boundary;
  readonly prepareReplacement: (boundary: Boundary) => PublisherReplacement;
  readonly createHost: (
    options: Readonly<Record<string, unknown>>,
  ) => StagingHost;
}) {
  let active: StagingHost | undefined;
  let pending: Promise<unknown> | undefined;
  let disposed = false;
  const consumed = new Set<string>();
  const recovery = new Set<StagingHost>();
  const released = new WeakSet<StagingHost>();

  const release = (stage: StagingHost) => {
    if (released.has(stage)) return;
    released.add(stage);
    try {
      stage.release();
    } finally {
      stage.host.moduleCache.clear();
    }
  };

  return {
    replace<T>(graph: NativeBrowserDevGraph): Promise<T> {
      if (disposed)
        return Promise.reject(new Error('Native browser refresh is disposed.'));
      if (pending)
        return Promise.reject(
          new Error(
            'Native browser refresh already has an active replacement.',
          ),
        );
      if (!/^[a-f0-9]{64}$/u.test(graph.revision))
        return Promise.reject(
          new Error('Native browser graph revision is invalid.'),
        );
      if (consumed.has(graph.revision))
        return Promise.reject(
          new Error(
            'Native browser graph was already consumed; rebuild before retrying.',
          ),
        );
      // A cross-runtime outcome must come from this attempt's actual native
      // commit, never from arbitrary objects thrown by a factory or loader.
      const commitErrors = new WeakSet<Error>();
      const task = (async (): Promise<T> => {
        const host = options.host;
        const shares = selectedShares(host);
        // Prepare from the actual live boundary before async loading. execute
        // revalidates all captured native owners after that loading completes.
        const replacement = options.prepareReplacement(options.boundary);
        const stage = options.createHost({
          ...host.options,
          name: `${host.name}:native-dev:${graph.revision}`,
          id: `${host.name}:native-dev:${graph.revision}`,
          remotes: [{ ...graph.remote }],
          // Reuse actual initialized scopes, not reconstructed shared configs.
          shared: {},
        });
        if (stage.host === host || stage.host === active?.host)
          throw new Error(
            'Native browser refresh requires an isolated staging host.',
          );
        let accepted = false;
        let module!: T;
        let failed = false;
        let failure: unknown;
        try {
          for (const [name, scope] of Object.entries(host.shareScopeMap)) {
            stage.host.initShareScopeMap(name, scope, {
              hostShareScopeMap: host.shareScopeMap,
            });
            if (stage.host.shareScopeMap[name] !== scope)
              throw new Error(
                'Native browser refresh lost the actual shared scope.',
              );
          }
          const factory = await stage.host.loadRemote<() => T>(options.id, {
            loadFactory: false,
          });
          if (disposed)
            throw new Error(
              'Native browser refresh was disposed while loading.',
            );
          if (typeof factory !== 'function')
            throw new Error(
              'Native browser refresh did not receive an exposed factory.',
            );
          assertSelectedShares(host, shares);
          stage.prepareFactory?.();
          consumed.add(graph.revision);
          try {
            module = replacement.execute(factory);
          } catch (error) {
            if (replacement.commitStarted) {
              // Native callbacks can fail after the first irreversible owner
              // mutation. Retain both graphs for native recovery, surface the
              // failure, and never describe this as an old-owner rollback.
              if (active) recovery.add(active);
              active = stage;
              accepted = true;
            }
            throw error;
          }
          const previous = active;
          active = stage;
          accepted = true;
          // Native commit has completed. Never pretend later observer or
          // transport errors rolled that commit back or discard its owner.
          assertSelectedShares(host, shares);
          // A failed retirement must not release the newly accepted owner.
          const retired = new Set(recovery);
          recovery.clear();
          if (previous) retired.add(previous);
          const errors: unknown[] = [];
          for (const retained of retired) {
            try {
              release(retained);
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length)
            throw new AggregateError(
              errors,
              'Native browser refresh retirement failed.',
            );
        } catch (error) {
          failed = true;
          failure = error;
        }
        const retired = new Set<StagingHost>();
        if (disposed && active === stage) {
          active = undefined;
          for (const retained of recovery) retired.add(retained);
          recovery.clear();
          retired.add(stage);
        } else if (!accepted) retired.add(stage);
        const cleanupErrors: unknown[] = [];
        for (const retained of retired) {
          try {
            release(retained);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length) {
          failure = new AggregateError(
            failed ? [failure, ...cleanupErrors] : cleanupErrors,
            'Native browser refresh cleanup failed.',
          );
          failed = true;
        }
        if (failed) {
          if (accepted) {
            const committedFailure = nativeBrowserDevCommitFailure(
              graph.revision,
              failure,
            );
            commitErrors.add(committedFailure);
            throw committedFailure;
          }
          throw failure;
        }
        return module;
      })().catch(error => {
        if (
          error instanceof Error &&
          Reflect.get(error, COMMIT_ERROR) === true &&
          !commitErrors.has(error)
        )
          throw new Error(
            `Native browser graph failed before its own ownership transfer: ${error.message}`,
            { cause: error },
          );
        throw error;
      });
      pending = task;
      void task
        .finally(() => {
          if (pending === task) pending = undefined;
        })
        .catch(() => {});
      return task;
    },
    /** The original host remains untouched, including sibling remote loaders. */
    get activeHost(): NativeBrowserDevHost {
      return active?.host ?? options.host;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const previous = active;
      active = undefined;
      const retained = new Set(recovery);
      recovery.clear();
      if (previous) retained.add(previous);
      const errors: unknown[] = [];
      for (const stage of retained) {
        try {
          release(stage);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          'Native browser refresh cleanup failed.',
        );
    },
  };
}
