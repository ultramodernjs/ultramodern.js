import { loadFederatedModule } from '@modern-js/renderer-core/federation';
import { isServer, type JSX } from '@solidjs/web';
import * as solid from 'solid-js';
import {
  type Component,
  createComponent,
  createSignal,
  Errored,
  isHydrating,
  Loading,
  lazy,
  onCleanup,
  useContext,
} from 'solid-js';
import {
  FederationContext,
  type SolidFederationScope,
} from './federation-context';
import { captureFederatedServerAssets } from './federation-ssr';

/** The module shape a same-renderer Module Federation remote exposes. */
export interface FederatedModule<P extends object> {
  readonly default: Component<P>;
}

export interface FederatedComponentOptions {
  /** Rendered while the remote loads, and on the server when it cannot load. */
  readonly fallback?: () => JSX.Element;
  /**
   * Milliseconds a remote load may take before it fails. Defaults to 3000 on
   * the server, so an unavailable remote cannot hold the document; the
   * browser waits without a limit unless one is given.
   */
  readonly timeout?: number;
}

const DEFAULT_SERVER_TIMEOUT = 3000;

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
    // A pending remote must not keep a server process alive.
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
 * Run once the document has hydrated. A retry inside a hydration pass would
 * look for server data the failed render never produced.
 */
function afterHydration(callback: () => void): void {
  // The hydration runtime installs this hook on Solid's shared config.
  const { sharedConfig } = solid as unknown as {
    sharedConfig?: { onHydrationEnd?: (callback: () => void) => void };
  };
  const onHydrationEnd = sharedConfig?.onHydrationEnd;
  if (onHydrationEnd) onHydrationEnd(callback);
  else queueMicrotask(callback);
}

/**
 * Render a Solid component exposed by a Module Federation remote, by its
 * `remote/Expose` id or a custom loader.
 *
 * A remote id loads through the federation instance of the application that
 * renders it, so co-located hosts keep their own remotes. On the server it
 * renders into the document with the remote's stylesheets and module
 * preloads; the browser loads the same remote before hydrating it.
 * A remote that fails or exceeds its timeout on the server renders the
 * fallback, and the browser retries it after hydration. Custom loaders render
 * in the browser only. Browser load and renderer-admission failures throw to
 * the nearest `Errored` boundary.
 */
export function federatedComponent<P extends object = Record<string, never>>(
  remote: string | (() => Promise<FederatedModule<P>>),
  options: FederatedComponentOptions = {},
): Component<P> {
  if (
    typeof remote === 'string'
      ? !/^[^/]+\/.+/u.test(remote)
      : typeof remote !== 'function'
  )
    throw new TypeError(
      "federatedComponent requires a remote id such as 'remote/Widget' or a loader",
    );
  if (
    options.timeout !== undefined &&
    (!Number.isFinite(options.timeout) || options.timeout <= 0)
  )
    throw new TypeError(
      'federatedComponent timeout must be a positive number of milliseconds',
    );
  const id = typeof remote === 'string' ? remote : undefined;
  const timeout =
    options.timeout ?? (isServer ? DEFAULT_SERVER_TIMEOUT : undefined);
  const load = (scope: SolidFederationScope): Component<P> =>
    lazy(async () => {
      if (isServer && !id)
        throw new Error(
          'A federatedComponent loader renders in the browser only; use a remote id to server-render it',
        );
      const { module, assets } = await withTimeout(
        Promise.resolve().then(() =>
          id
            ? loadFederatedModule<FederatedModule<P>>(scope.instance, id)
            : (remote as () => Promise<FederatedModule<P>>)().then(module => ({
                module,
                assets: undefined,
              })),
        ),
        timeout,
        id ?? 'loader',
      );
      const component = module?.default;
      if (typeof component !== 'function')
        throw new TypeError(
          'A federated Solid module must default-export a component',
        );
      if (!isServer || !id) return { default: component };
      const assetKey = captureFederatedServerAssets(scope, id, assets);
      if (!assetKey)
        throw new Error(
          `Cannot server-render ${id}: the host has no server federation state for its browser assets`,
        );
      // Solid resolves a loaded module's $$moduleUrl through the response's
      // asset resolver: stylesheets, preloads and the hydration module.
      return { default: component, $$moduleUrl: assetKey };
    }) as Component<P>;
  // Solid's lazy caches its module. Scope the cache to one application or
  // response, so two hosts rendering this component never share a remote.
  const remotes = new WeakMap<SolidFederationScope, Component<P>>();
  const fallback = (): JSX.Element => options.fallback?.();

  return (props: P): JSX.Element => {
    const scope = useContext(FederationContext);
    const Remote = remotes.get(scope) ?? load(scope);
    remotes.set(scope, Remote);
    const remoteView = () => createComponent(Remote, props);
    // After a server failure, the browser renders the remote afresh: like a
    // client-only mount, its failures reach the application's boundaries.
    const [retried, retry] = createSignal(false);
    const recover = (error: () => unknown): JSX.Element => {
      // A server failure renders the fallback and serializes the failure;
      // hydration claims that fallback, then the browser retries the remote.
      if (isServer) return fallback();
      if (isHydrating()) {
        let active = true;
        onCleanup(() => {
          active = false;
        });
        afterHydration(() => {
          if (active) retry(true);
        });
        return fallback();
      }
      throw error();
    };
    // Loading owns the pending load. On the first render Errored sits inside
    // it, so a load that fails after suspending still reaches it on the server.
    return createComponent(Loading, {
      get fallback() {
        return fallback();
      },
      get children() {
        return retried()
          ? remoteView()
          : createComponent(Errored, {
              fallback: recover,
              get children() {
                return remoteView();
              },
            });
      },
    });
  };
}
