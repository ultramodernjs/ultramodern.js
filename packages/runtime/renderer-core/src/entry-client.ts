import { createDataClient, invokeRouteData } from './data';
import { type DocumentBootstrap, RENDERER_BOOTSTRAP_ID } from './document';
import type { NativeFederationBinding } from './federation';
import type { RendererIdentity } from './identity';
import {
  type NativeEntryI18n,
  type NativeI18nInstance,
  type NativeI18nView,
  nativeI18nView,
} from './localization';
import {
  isRoutedApplication,
  type NativeApplicationModule,
  type NativeRoutedApplication,
  type NativeRouterOptions,
} from './router';

export type * from './localization';
export type {
  NativeApplicationModule,
  NativeRoutedApplication,
  NativeRouterOptions,
} from './router';

import { untilAborted } from './abort';

/** What a generated client entry passes to its renderer. */
export interface NativeClientEntryOptions<
  Instance extends NativeI18nInstance = NativeI18nInstance,
  LocalisedUrls = unknown,
> {
  readonly identity: RendererIdentity;
  readonly federation?: NativeFederationBinding;
  /** The generated application module, imported after startup begins. */
  readonly load: () => Promise<NativeApplicationModule>;
  readonly i18n?: NativeEntryI18n<Instance, LocalisedUrls>;
  /** The entry module's bundler HMR object, `import.meta.webpackHot`. */
  readonly hot?: unknown;
  /** The mount element id; must match the server entry's `rootId`. */
  readonly rootId?: string;
}

/** The application view a renderer mounts or hydrates. */
export type NativeClientView<Router, Instance, LocalisedUrls> = {
  readonly i18n?: NativeI18nView<Instance, LocalisedUrls>;
} & (
  | { readonly kind: 'component'; readonly component: unknown }
  | { readonly kind: 'router'; readonly router: Router }
);

export interface NativeClientStart<
  Bootstrap extends DocumentBootstrap,
  Router,
  Instance,
  LocalisedUrls,
> {
  readonly root: HTMLElement;
  readonly identity: Readonly<RendererIdentity>;
  readonly bootstrap: Bootstrap | undefined;
  /** Aborts when the entry is disposed during startup. */
  readonly signal: AbortSignal;
  /** Import the application and prepare its router for this document. */
  load(): Promise<NativeClientView<Router, Instance, LocalisedUrls>>;
}

/** The renderer's own document, router and root lifecycle. */
export interface NativeClientAdapter<
  Bootstrap extends DocumentBootstrap,
  Router extends object,
  Instance extends NativeI18nInstance,
  LocalisedUrls,
> {
  readBootstrap(
    document: Document,
    identity: Readonly<RendererIdentity>,
  ): Bootstrap;
  createRouter(
    application: NativeRoutedApplication,
    options: NativeRouterOptions,
  ): Router;
  /** Release the router and browser history created for this entry. */
  disposeRouter(router: Router): void;
  /** Load a fresh router, or adopt the server's matches when hydrating. */
  prepareRouter(
    router: Router,
    hydrating: boolean,
    signal: AbortSignal,
  ): Promise<void>;
  /** Mount or hydrate the root; resolves its disposal. */
  start(
    input: NativeClientStart<Bootstrap, Router, Instance, LocalisedUrls>,
  ): Promise<() => void>;
}

interface NativeEntryHot {
  dispose(callback: () => void): void;
}

function isNativeEntryHot(value: unknown): value is NativeEntryHot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof value.dispose === 'function'
  );
}

/** Browser route data: local client loaders, or the server's data endpoint. */
function clientRouteLoader(
  application: NativeRoutedApplication,
  identity: RendererIdentity,
): NativeRouterOptions['loadRoute'] {
  const serverDataRoutes = new Set(application.serverDataRoutes);
  return async (route, input) => {
    const loader = application.dataModules[route.id]?.loader;
    if (loader)
      return invokeRouteData(loader, input, {
        production: process.env.NODE_ENV === 'production',
      });
    if (!serverDataRoutes.has(route.id))
      return { kind: 'success', value: undefined, status: 200 };
    return createDataClient(route.id, identity).loader({
      request: input.request,
    });
  };
}

/**
 * Start a generated browser entry: find the mount element, read the server
 * bootstrap, own HMR disposal and startup cancellation, and surface startup
 * failures. The renderer adapter owns its router and root.
 */
export function startNativeClientEntry<
  Bootstrap extends DocumentBootstrap,
  Router extends object,
  Instance extends NativeI18nInstance,
  LocalisedUrls,
>(
  options: NativeClientEntryOptions<Instance, LocalisedUrls>,
  adapter: NativeClientAdapter<Bootstrap, Router, Instance, LocalisedUrls>,
): void {
  const identity = Object.freeze({ ...options.identity });
  const root = document.getElementById(options.rootId ?? 'root');
  if (!root) throw new Error('The native application mount element is missing');
  const bootstrap = document.getElementById(RENDERER_BOOTSTRAP_ID)
    ? adapter.readBootstrap(document, identity)
    : undefined;
  const hydrating = bootstrap?.hydrating ?? false;
  const controller = new AbortController();
  const { signal } = controller;
  let disposed = false;
  let dispose: (() => void) | undefined;
  if (isNativeEntryHot(options.hot))
    options.hot.dispose(() => {
      disposed = true;
      controller.abort(
        new DOMException('The application entry was disposed', 'AbortError'),
      );
      dispose?.();
    });

  const load = async (): Promise<
    NativeClientView<Router, Instance, LocalisedUrls>
  > => {
    // Each startup stage races the signal, so a replaced entry is released
    // even while its application import or translations never settle.
    const application = await untilAborted(options.load(), signal);
    const { i18n } = options;
    let instance: Instance | undefined;
    if (i18n) {
      // The server's language and bundles arrive in the document: no flash, no refetch.
      const handoff = i18n.clientHandoff();
      instance = await untilAborted(
        i18n.create(handoff.language, handoff.resources),
        signal,
      );
      // Component-only and routed views both persist language changes; a
      // replaced or failed entry stops.
      const stopPersist = i18n.persist?.(instance);
      if (stopPersist)
        signal.addEventListener('abort', stopPersist, { once: true });
    }
    const current = instance;
    const localization =
      i18n && current ? { i18n: nativeI18nView(i18n, current) } : {};
    if (!isRoutedApplication(application))
      return {
        kind: 'component',
        component: application.default,
        ...localization,
      };
    const router = adapter.createRouter(application, {
      identity,
      loadRoute: clientRouteLoader(application, identity),
      // Disposal retires the router's route loads, including the initial
      // load the adapter is about to start.
      signal,
      ...(i18n && current
        ? { rewrite: i18n.rewrite(() => current.language) }
        : {}),
    });
    const releaseRouter = () => adapter.disposeRouter(router);
    if (signal.aborted) releaseRouter();
    else signal.addEventListener('abort', releaseRouter, { once: true });
    // HMR disposal aborts the signal; a failed start stops the sync too.
    const stopSync =
      i18n && current ? i18n.syncWithRouter(router, current) : undefined;
    if (stopSync) signal.addEventListener('abort', stopSync, { once: true });
    try {
      // An initial load whose loaders ignore the signal must not keep a
      // replaced entry and its router alive.
      await untilAborted(
        adapter.prepareRouter(router, hydrating, signal),
        signal,
      );
    } catch (error) {
      stopSync?.();
      throw error;
    }
    return {
      kind: 'router',
      router,
      ...localization,
    };
  };

  void adapter
    .start({ root, identity, bootstrap, signal, load })
    .then(release => {
      dispose = release;
      if (disposed) release();
    })
    .catch(error => {
      // Release what a failed start left attached, such as i18n sync.
      if (!signal.aborted) controller.abort(error);
      if (!disposed)
        queueMicrotask(() => {
          throw error;
        });
    });
}
