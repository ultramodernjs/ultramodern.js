import type {
  DataOutcome,
  FileSystemRouteIR,
  PublicDataOutcome,
} from '@modern-js/renderer-core/data';
import {
  type FileSystemRouteOptions,
  loadFileSystemRoute,
  type NativeLoaderMatch,
  nativeRoutePath,
  resolveRouteData as resolveNativeRouteData,
  splitFileSystemRoutes,
} from '@modern-js/renderer-core/router';
import {
  type AnyRoute,
  type AnyRouteMatch,
  type AnyRouter,
  createRootRoute,
  createRoute,
  ErrorComponent,
  type ErrorRouteComponent,
  HeadContent,
  type NotFoundRouteComponent,
  notFound,
  Outlet,
  type RouteComponent,
  redirect,
  Scripts,
} from '@octanejs/tanstack-router';
import { createElement, Fragment } from 'octane';

const fileRouteHeads = new WeakMap<AnyRoute, AnyRoute['options']['head']>();

/** Head callbacks execute on the host; only the factory's original binding is admitted. */
export function hasUnchangedOctaneFileRouteHead(route: AnyRoute): boolean {
  return fileRouteHeads.get(route) === route.options.head;
}

export type {
  FileSystemDataModule,
  FileSystemRouteOptions,
} from '@modern-js/renderer-core/router';
export {
  matchApplicationRouteIds,
  matchApplicationRoutes,
  RouteDataError,
  selectApplicationDataRoute,
} from '@modern-js/renderer-core/router';

/** Generated imports contain native view bindings, keyed by the structural id. */
export interface FileSystemRouteModule {
  component?: RouteComponent;
  pendingComponent?: RouteComponent;
  errorComponent?: ErrorRouteComponent;
  notFoundComponent?: NotFoundRouteComponent;
  validateSearch?: (search: Record<string, unknown>) => Record<string, unknown>;
  head?: AnyRoute['options']['head'];
}

/** Native route boundaries decide how redirects, missing data and errors render. */
export function resolveRouteData(
  routeId: string,
  outcome: DataOutcome | PublicDataOutcome,
): unknown {
  return resolveNativeRouteData({ redirect, notFound }, routeId, outcome);
}

interface ReactiveNativeMatch {
  get(): AnyRouteMatch | undefined;
  subscribe(callback: () => void): { unsubscribe(): void };
}

function isReactiveNativeMatch(value: unknown): value is ReactiveNativeMatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'get') === 'function' &&
    typeof Reflect.get(value, 'subscribe') === 'function'
  );
}

/** A transport failure belongs to the native generation that fetched it. */
function observeRouteCompletion(
  router: AnyRouter,
  routeId: string,
  controller: AbortController,
  signal: AbortSignal,
  completion: Promise<void>,
) {
  void completion.catch(error => {
    if (signal.aborted) return;
    const route = Object.values(router.routesById).find(
      candidate => candidate.options.staticData?.ultramodernRouteId === routeId,
    );
    if (!route) return;
    const store = router.stores.getMatchStore(route.id);
    let subscription: { unsubscribe(): void } | undefined;
    let settled = false;
    const cleanup = () => {
      subscription?.unsubscribe();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settled = true;
      cleanup();
    };
    const publish = async () => {
      if (settled) return;
      const current = store.get();
      if (!current) return;
      if (
        current.abortController !== controller ||
        signal.aborted ||
        (current.status !== 'pending' && current.status !== 'success')
      ) {
        onAbort();
        return;
      }
      // The initial loader can still be pending after its critical value returns.
      if (current.status !== 'success' || current.isFetching) return;
      settled = true;
      cleanup();
      const route = router.routesById[current.routeId];
      let failure = error;
      try {
        await route?.options.errorComponent?.preload?.();
        if (signal.aborted || store.get()?.abortController !== controller)
          return;
        route?.options.onError?.(failure);
      } catch (onErrorFailure) {
        failure = onErrorFailure;
      }
      // The error component is ready before publishing a late transport failure.
      if (signal.aborted) return;
      router.stores.setMatches(
        router.stores.matches.get().map(previous =>
          previous.routeId === route.id &&
          previous.abortController === controller &&
          previous.status === 'success' &&
          !previous.isFetching
            ? {
                ...previous,
                error: failure,
                status: 'error',
                isFetching: false,
              }
            : previous,
        ),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (isReactiveNativeMatch(store)) subscription = store.subscribe(publish);
    if (settled) subscription?.unsubscribe();
    else publish();
  });
}

/** Pass filesystem structure to native factories without matching any URL. */
export function createFileSystemRouteTree<Context = unknown>(
  routes: readonly FileSystemRouteIR[],
  modules: Readonly<Record<string, FileSystemRouteModule>>,
  options: FileSystemRouteOptions<Context, AnyRouter> = {},
): AnyRoute {
  const { root: rootDescriptor, children } = splitFileSystemRoutes(routes);

  function bindings(
    route: FileSystemRouteIR,
    errorComponent?: ErrorRouteComponent,
  ) {
    const needsData = Boolean(route.modules?.data || route.modules?.clientData);
    if (needsData && !options.loadRoute) {
      throw new Error(`An Octane data route requires its loader: ${route.id}`);
    }
    const loadRoute = options.loadRoute;
    const { head, ...module } = modules[route.id] ?? {};
    return {
      ...module,
      ...(head !== undefined ? { head } : {}),
      // Octane's server renders an uncaught match error through the root
      // outlet's Suspense, which defers it to a client retry that then
      // replaces the whole layout. Give every child match the nearest
      // error.tsx (or the native default) so the error renders in place.
      ...(errorComponent ? { errorComponent } : {}),
      component: module.component ?? Outlet,
      staticData: { ultramodernRouteId: route.id },
      ...(needsData && loadRoute
        ? {
            loader: async (match: NativeLoaderMatch) => {
              const { outcome, signal } = await loadFileSystemRoute(
                route,
                loadRoute,
                options,
                match,
              );
              if ('completion' in outcome && outcome.completion) {
                const router = options.getRouter?.();
                if (!router) {
                  throw new Error(
                    'An Octane streamed data route requires its native router',
                  );
                }
                let failed = false;
                let failure: unknown;
                void outcome.completion.catch(error => {
                  failed = true;
                  failure = error;
                });
                // Detect a terminal failure already received with the first frame.
                await Promise.resolve();
                signal.throwIfAborted();
                if (failed) throw failure;
                observeRouteCompletion(
                  router,
                  route.id,
                  match.abortController,
                  signal,
                  outcome.completion,
                );
              }
              options.onOutcome?.(route.id, outcome);
              return resolveRouteData(route.id, outcome);
            },
          }
        : {}),
    };
  }

  const rootBindings = rootDescriptor
    ? bindings(rootDescriptor)
    : { component: Outlet };
  const authoredRoot: RouteComponent = rootBindings.component;
  function OctaneDocumentRoot(props: Parameters<RouteComponent>[0]) {
    return createElement(
      Fragment,
      null,
      createElement(HeadContent),
      createElement(authoredRoot, props),
      createElement(Scripts),
    );
  }
  if (authoredRoot.preload !== undefined) {
    OctaneDocumentRoot.preload = authoredRoot.preload;
  }
  const rootErrorComponent =
    (rootDescriptor && modules[rootDescriptor.id]?.errorComponent) ||
    ErrorComponent;
  const root = createRootRoute({
    ...rootBindings,
    component: OctaneDocumentRoot,
  });
  fileRouteHeads.set(root, root.options.head);

  function bind(
    route: FileSystemRouteIR,
    parent: AnyRoute,
    inheritedErrorComponent: ErrorRouteComponent,
  ): AnyRoute {
    const errorComponent =
      modules[route.id]?.errorComponent ?? inheritedErrorComponent;
    const native = createRoute({
      getParentRoute: () => parent,
      ...nativeRoutePath(route),
      ...bindings(route, errorComponent),
    });
    fileRouteHeads.set(native, native.options.head);
    return native.addChildren(
      route.children.map(child => bind(child, native, errorComponent)),
    );
  }

  return root.addChildren(
    children.map(route => bind(route, root, rootErrorComponent)),
  );
}
