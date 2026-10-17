import { loadFederatedModule } from '@modern-js/renderer-core/federation';
import {
  type ComponentBody,
  createElement,
  lazy,
  type OctaneNode,
  preinit,
  publisherBoundary,
  Suspense,
  useContext,
} from 'octane';
import {
  FederationContext,
  type OctaneFederationScope,
} from './federation-context';

/** The native component shape exposed by a same-renderer Octane remote. */
export interface FederatedModule<P extends object> {
  readonly default: ComponentBody<P>;
}

export interface FederatedComponentOptions {
  /** Native content shown while loading, or after a failed server load. */
  readonly fallback?: () => OctaneNode;
  /** A positive load limit; the server defaults to 3000ms. */
  readonly timeout?: number;
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
  const components = new WeakMap<OctaneFederationScope, ComponentBody<P>>();

  return props => {
    const context = useContext(FederationContext) ?? standalone;
    let Remote = components.get(context);
    if (!Remote) {
      Remote = lazy(async () => {
        try {
          if (context.server && !id) {
            throw new Error(
              'A federatedComponent loader renders in the browser only; use a remote id to server-render it',
            );
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
          if (!context.server) components.delete(context);
          throw error;
        }
      });
      components.set(context, Remote);
    }
    return createElement(Suspense, {
      fallback: options.fallback,
      children: createElement(Remote, props),
    });
  };
}
