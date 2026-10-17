import { loadFederatedModule } from '@modern-js/renderer-core/federation';
import {
  type ComponentBody,
  createElement,
  decodeExternalSnapshot,
  externalSnapshotBoundary,
  hookSlots,
  lazy,
  type OctaneNode,
  preinit,
  publisherBoundary,
  Suspense,
  serializeExternalSnapshotRequest,
  useContext,
  useEffect,
} from 'octane';
import {
  FederationContext,
  type OctaneFederationScope,
} from './federation-context';

import { I18nContext } from './i18n/context';
import {
  type OctaneWorkerFederationScope,
  WorkerFederationContext,
} from './worker-federation-context';
import { useOctaneWorkerContextKeys } from './worker-federation-contexts';

/** The native component shape exposed by a same-renderer Octane remote. */
export interface FederatedModule<P extends object> {
  readonly default: ComponentBody<P>;
}

export interface FederatedComponentOptions {
  /** Native content shown while loading, or after a failed server load. */
  readonly fallback?: () => OctaneNode;
  /** A positive load limit; the server defaults to 3000ms. */
  readonly timeout?: number;
  /** Explicit registered server projections required by an application remote. */
  readonly contextKeys?: readonly string[];
}

function withTimeout<T>(
  promise: Promise<T>,
  timeout: number | undefined,
  label: string,
): Promise<T> {
  if (timeout === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Remote module ${label} did not load within ${timeout}ms`),
        ),
      timeout,
    );
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// This library wrapper is published as plain JavaScript, outside app compilation.
const publisherRegistrationEffectSlot = Symbol(hookSlots(1));

/**
 * Render a native Octane remote by its `remote/Expose` id or a browser loader.
 * Native Suspense owns server fallbacks, streamed styles and hydration adoption;
 * browser failures reach the nearest native ErrorBoundary. A loader function is
 * browser-only; use an id to render through the host's server federation runtime.
 */
export function federatedComponent<P extends object = Record<string, never>>(
  remote: string | (() => Promise<FederatedModule<P>>),
  options: FederatedComponentOptions = {},
): ComponentBody<P> {
  if (
    typeof remote === 'string'
      ? !/^[^/]+\/.+/u.test(remote)
      : typeof remote !== 'function'
  ) {
    throw new TypeError(
      "federatedComponent requires a remote id such as 'remote/Widget' or a loader",
    );
  }
  if (
    options.timeout !== undefined &&
    (!Number.isFinite(options.timeout) || options.timeout <= 0)
  ) {
    throw new TypeError(
      'federatedComponent timeout must be a positive number of milliseconds',
    );
  }
  const id = typeof remote === 'string' ? remote : undefined;
  const standalone: OctaneFederationScope = {
    instance: undefined,
    server: typeof document === 'undefined',
  };
  // Native lazy caches its module. Scope the cache to one application/response,
  // so two hosts using the same component definition cannot share a remote.
  const components = new WeakMap<object, ComponentBody<P>>();
  const workerOwners = new WeakMap<
    OctaneFederationScope,
    WeakMap<OctaneWorkerFederationScope, Map<string, object>>
  >();

  return props => {
    const context = useContext(FederationContext) ?? standalone;
    const worker = useContext(WorkerFederationContext);
    const language = worker
      ? (useContext(I18nContext)?.language ?? worker.locale)
      : undefined;
    const contextKeys = worker
      ? useOctaneWorkerContextKeys(options.contextKeys)
      : undefined;
    let owner: object = context;
    if (worker) {
      let scopes = workerOwners.get(context);
      if (!scopes) workerOwners.set(context, (scopes = new WeakMap()));
      let variants = scopes.get(worker);
      if (!variants) scopes.set(worker, (variants = new Map()));
      const key = JSON.stringify([language, contextKeys]);
      let variant = variants.get(key);
      if (!variant) variants.set(key, (variant = {}));
      owner = variant;
    }
    let Remote = components.get(owner);
    if (!Remote) {
      Remote = lazy(async () => {
        try {
          if (context.server && !id) {
            throw new Error(
              'A federatedComponent loader renders in the browser only; use a remote id to server-render it',
            );
          }
          if (worker) {
            if (!id || !language) {
              throw new Error(
                'Worker federation requires a remote id and the owning entry locale',
              );
            }
            const separator = id.indexOf('/');
            const remoteName = id.slice(0, separator);
            const expose = `./${id.slice(separator + 1)}`;
            const controller = new AbortController();
            const signal = worker.signal
              ? AbortSignal.any([worker.signal, controller.signal])
              : controller.signal;
            const timeout =
              options.timeout ?? (context.server ? 3000 : undefined);
            let admitted;
            try {
              admitted = await withTimeout(
                worker.transport.admit({
                  remote: remoteName,
                  expose,
                  locale: language,
                  signal,
                }),
                timeout,
                id,
              );
            } finally {
              // Release this admission waiter, including after its own deadline.
              controller.abort();
            }
            const BrowserRemote = lazy(async () => {
              const { module, assets } = await loadFederatedModule<
                FederatedModule<P>
              >(context.instance, id);
              if (typeof module?.default !== 'function') {
                throw new TypeError(
                  'A federated Octane module must default-export a native component',
                );
              }
              const component = module.default;
              const Loaded: ComponentBody<P> = (props, scope, extra) => {
                for (const href of assets?.css ?? []) {
                  preinit(href, {
                    as: 'style',
                    precedence: 'federated',
                    ...(context.nonce === undefined
                      ? {}
                      : { nonce: context.nonce }),
                  });
                }
                return component(props, scope, extra);
              };
              return { default: Loaded };
            });
            return {
              default: externalSnapshotBoundary({
                authority: admitted.coordinate.native,
                component: BrowserRemote,
                contextKeys,
                timeoutMs: timeout,
                async snapshot(request, signal) {
                  const response = await worker.transport.request({
                    remote: remoteName,
                    expose,
                    locale: language,
                    payload: serializeExternalSnapshotRequest(request),
                    signal,
                  });
                  return decodeExternalSnapshot(response.payload);
                },
              }),
            };
          }
          const { module, assets } = await withTimeout(
            Promise.resolve().then(() =>
              id
                ? loadFederatedModule<FederatedModule<P>>(context.instance, id)
                : (remote as () => Promise<FederatedModule<P>>)().then(
                    module => ({ module, assets: undefined }),
                  ),
            ),
            options.timeout ?? (context.server ? 3000 : undefined),
            id ?? 'loader',
          );
          if (typeof module?.default !== 'function') {
            throw new TypeError(
              'A federated Octane module must default-export a native component',
            );
          }
          if (context.server && !assets) {
            throw new Error(
              `Cannot server-render ${id}: the host has no browser assets for this remote`,
            );
          }
          // Native publisher ownership admits this exact compiled component's
          // signal generations. Keep the boundary in the context-scoped lazy
          // cache so props and compatible hot updates retain its live owner.
          const component = publisherBoundary(module.default, {
            publisherKey: id ?? 'ultramodern:browser-loader',
          });
          const Loaded: ComponentBody<P> = props => {
            // A development runtime installs this hook on the actual owning
            // host. Registration follows the native mounted lifetime; routing
            // alone grants no replacement authority to a remote name.
            useEffect(
              () => {
                if (context.server || !id || !context.instance) return;
                const register = Reflect.get(
                  context.instance,
                  Symbol.for('ultramodern.federation.browser-dev-boundary.v1'),
                );
                if (typeof register !== 'function') return;
                return register(id, module.default, component);
              },
              [],
              publisherRegistrationEffectSlot,
            );
            // Resource APIs require an active native render. Late styles travel
            // in Octane's resource carrier ahead of the remote's HTML segment.
            for (const href of assets?.css ?? []) {
              preinit(href, {
                as: 'style',
                precedence: 'federated',
                ...(context.nonce === undefined
                  ? {}
                  : { nonce: context.nonce }),
              });
            }
            return createElement(component, props);
          };
          return { default: Loaded };
        } catch (error) {
          // A later mount or ErrorBoundary reset may retry a failed load.
          if (!context.server) components.delete(owner);
          throw error;
        }
      });
      components.set(owner, Remote);
    }
    return createElement(Suspense, {
      fallback: options.fallback,
      children: createElement(Remote, props),
    });
  };
}
