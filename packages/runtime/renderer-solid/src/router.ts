import type {
  DataOutcome,
  FileSystemRouteIR,
  PublicDataOutcome,
} from '@modern-js/renderer-core/data';
import { DataProtocolError } from '@modern-js/renderer-core/data';
import type { FileSystemRouteOptions } from '@modern-js/renderer-core/router';
import {
  loadFileSystemRoute,
  type NativeLoaderMatch,
  nativeRoutePath,
  resolveRouteData as resolveNativeRouteData,
  splitFileSystemRoutes,
  untilAborted,
} from '@modern-js/renderer-core/router';
import {
  createRouteCompletionScope,
  registerRouteCompletionScope,
} from './route-completion';
import { restoreRouteDataError } from './route-data-error';
import type {
  AnyRoute,
  AnyRouter,
  ErrorRouteComponent,
  NotFoundRouteComponent,
  RouteComponent,
} from './router-binding/index';
import {
  createRootRoute,
  createRoute,
  isNotFound,
  isRedirect,
  notFound,
  Outlet,
  preparePublicContextData,
  preparePublicLoaderData,
  preparePublicMatchError,
  redirect,
} from './router-binding/index';

export type {
  DataHandler,
  DataHandlerInput,
  DataOutcome,
  DecodedDataOutcome,
  PublicDataOutcome,
} from '@modern-js/renderer-core/data';
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
export type {
  ActionFormProps,
  RouteAction,
  RouteActionOptions,
} from './actions';
export {
  ActionForm,
  createRouteAction,
  RouteActionError,
  useRouteAction,
} from './actions';
export { ApplicationRouter } from './application-router';
// Native TanStack owns matching, transitions, cancellation and route context.
// Keep this entry separate from other renderer adapters and their type programs.
export { createApplicationRouter } from './route-completion';
export * from './router-binding/index';

export interface FileSystemRouteModule {
  component?: RouteComponent;
  pendingComponent?: RouteComponent;
  errorComponent?: ErrorRouteComponent;
  notFoundComponent?: NotFoundRouteComponent;
  head?: NonNullable<AnyRoute['options']['head']>;
  /** Explicit returned context becomes immutable public native route context. */
  beforeLoad?: NonNullable<AnyRoute['options']['beforeLoad']>;
  /** Native synchronous context contributions are checked before composition. */
  context?: NonNullable<AnyRoute['options']['context']>;
  validateSearch?: (search: Record<string, unknown>) => Record<string, unknown>;
}

function isPublicRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Resolve location through the native router before committing HTTP headers. */
export function resolveApplicationRedirect(
  router: AnyRouter,
): Response | undefined {
  const result = router._serverResult;
  const value = result?.type === 'redirect' ? result.redirect : undefined;
  return isRedirect(value) ? router.resolveRedirect(value) : undefined;
}

/** The native server load resolves status independently from rendered UI. */
export function getApplicationStatus(router: AnyRouter): number {
  const result = router._serverResult;
  if (!result)
    throw new Error(
      'Load the native Solid router before resolving HTTP status',
    );
  return result.type === 'render' ? result.status : result.redirect.status;
}

/** Throw outcomes into the native Solid redirect, not-found and error boundaries. */
export function resolveRouteData(
  routeId: string,
  outcome: DataOutcome | PublicDataOutcome,
  project?: (value: unknown) => unknown,
): unknown {
  return resolveNativeRouteData(
    { redirect, notFound },
    routeId,
    outcome,
    project,
  );
}

/** Project route structure into native factories without matching any URL. */
export function createFileSystemRouteTree<Context = unknown>(
  routes: readonly FileSystemRouteIR[],
  modules: Readonly<Record<string, FileSystemRouteModule>>,
  options: FileSystemRouteOptions<Context> = {},
): AnyRoute {
  const { root: rootDescriptor, children } = splitFileSystemRoutes(routes);
  const privateRoots =
    options.context &&
    (typeof options.context === 'object' ||
      typeof options.context === 'function')
      ? [options.context]
      : [];
  const completionScope = createRouteCompletionScope(
    privateRoots,
    options.session,
  );
  const moduleFields = new Set([
    'component',
    'pendingComponent',
    'errorComponent',
    'notFoundComponent',
    'head',
    'beforeLoad',
    'context',
    'validateSearch',
  ]);

  function projectModuleContext(
    authored: unknown,
    source: 'search',
  ): Record<string, unknown>;
  function projectModuleContext(
    authored: unknown,
    source: 'context' | 'beforeLoad',
  ): unknown;
  function projectModuleContext(
    authored: unknown,
    source: 'context' | 'search' | 'beforeLoad',
  ): unknown {
    try {
      const value = preparePublicContextData(
        authored,
        options.session ?? completionScope.hydrationOwner,
        [options.context],
      );
      if (source === 'context' && value !== undefined && !isPublicRecord(value))
        throw new DataProtocolError(
          'Native Solid route context must return a synchronous public record',
        );
      if (source === 'search' && !isPublicRecord(value))
        throw new DataProtocolError(
          'Native Solid search validation must return a public record',
        );
      return value;
    } catch (error) {
      options.session?.fail(error);
      throw error;
    }
  }

  function routeModuleOptions(id: string): FileSystemRouteModule {
    const module = modules[id] ?? {};
    const prototype = Object.getPrototypeOf(module);
    if (prototype !== Object.prototype && prototype !== null)
      throw new DataProtocolError(
        'Native Solid filesystem route modules require plain option records',
      );
    for (const key of Reflect.ownKeys(module)) {
      const descriptor = Object.getOwnPropertyDescriptor(module, key)!;
      if (
        typeof key !== 'string' ||
        !moduleFields.has(key) ||
        descriptor.get ||
        descriptor.set
      )
        throw new DataProtocolError(
          'Unsupported native Solid filesystem route option; use the declared public route module contract',
        );
    }
    const beforeLoad = module.beforeLoad;
    const validateSearch = module.validateSearch;
    const context = module.context;
    const contextOptions = context
      ? {
          context(...args: Parameters<typeof context>) {
            return projectModuleContext(context(...args), 'context');
          },
        }
      : {};
    const searchOptions = validateSearch
      ? {
          validateSearch(search: Record<string, unknown>) {
            return projectModuleContext(validateSearch(search), 'search');
          },
        }
      : {};
    if (!beforeLoad) return { ...module, ...searchOptions, ...contextOptions };
    return {
      ...module,
      ...searchOptions,
      ...contextOptions,
      beforeLoad: async (...args: Parameters<typeof beforeLoad>) => {
        // An authored hook that ignores the match abort must not hold a
        // superseded navigation or a disconnected server request.
        const signal = (
          args[0] as { abortController?: AbortController } | undefined
        )?.abortController?.signal;
        let value: unknown;
        try {
          value = await (signal
            ? untilAborted(beforeLoad(...args), signal)
            : beforeLoad(...args));
        } catch (error) {
          if (signal?.aborted) throw error;
          if (isRedirect(error)) throw error;
          let projected: unknown;
          try {
            projected = isNotFound(error)
              ? preparePublicContextData(error, options.session, [
                  options.context,
                ])
              : preparePublicMatchError(error, options.session, [
                  options.context,
                ]);
          } catch (invalid) {
            options.session?.fail(invalid);
            throw invalid;
          }
          if (isNotFound(projected)) throw projected;
          if (
            projected &&
            typeof projected === 'object' &&
            Object.getOwnPropertyDescriptor(projected, 'kind')?.value ===
              'ultramodern-route-data-error'
          )
            throw Object.freeze(restoreRouteDataError(projected));
          const message =
            projected && typeof projected === 'object'
              ? Object.getOwnPropertyDescriptor(projected, 'message')?.value
              : undefined;
          const name =
            projected && typeof projected === 'object'
              ? Object.getOwnPropertyDescriptor(projected, 'name')?.value
              : undefined;
          const diagnostic = new Error(
            typeof message === 'string' ? message : 'Unexpected Server Error',
          );
          diagnostic.name = typeof name === 'string' ? name : 'Error';
          if (projected && typeof projected === 'object') {
            for (const key of ['cause', 'stack']) {
              const descriptor = Object.getOwnPropertyDescriptor(
                projected,
                key,
              );
              if (descriptor && !descriptor.get && !descriptor.set)
                Object.defineProperty(diagnostic, key, {
                  value: descriptor.value,
                  configurable: true,
                  writable: true,
                });
            }
          }
          throw Object.freeze(diagnostic);
        }
        return projectModuleContext(value, 'beforeLoad');
      },
    };
  }

  function loaderOptions(route: FileSystemRouteIR) {
    const loadRoute = options.loadRoute;
    if (!(route.modules?.data || route.modules?.clientData) || !loadRoute) {
      return {};
    }
    return {
      loader: async (match: NativeLoaderMatch) => {
        // The router's href omits its basepath; data URLs use the public path.
        const { outcome, request, signal } = await loadFileSystemRoute(
          route,
          loadRoute,
          options,
          match,
        );
        options.onOutcome?.(route.id, outcome);
        const generation = completionScope.begin(signal, () =>
          match.abortController.abort(),
        );
        const owner = options.session ?? generation.owner;
        const project = (value: unknown): unknown => {
          try {
            return preparePublicLoaderData(value, owner, [
              options.context,
              request,
            ]);
          } catch (error) {
            owner.fail(error);
            throw error;
          }
        };
        const value = resolveRouteData(route.id, outcome, project);
        generation.publish(
          value,
          'completion' in outcome ? outcome.completion : undefined,
        );
        return value;
      },
    };
  }

  const root = createRootRoute({
    ...routeModuleOptions(rootDescriptor?.id ?? ''),
    component: completionScope.component(
      modules[rootDescriptor?.id ?? '']?.component ?? Outlet,
    ),
    staticData: { ultramodernRouteId: rootDescriptor?.id },
    ...(rootDescriptor ? loaderOptions(rootDescriptor) : {}),
  });

  // Like a React Router error element, error.tsx covers its whole subtree.
  function bind(
    route: FileSystemRouteIR,
    parent: AnyRoute,
    inheritedErrorComponent?: ErrorRouteComponent,
  ): AnyRoute {
    const errorComponent =
      modules[route.id]?.errorComponent ?? inheritedErrorComponent;
    const native = createRoute({
      getParentRoute: () => parent,
      ...nativeRoutePath(route),
      ...routeModuleOptions(route.id),
      ...(errorComponent ? { errorComponent } : {}),
      component: completionScope.component(
        modules[route.id]?.component ?? Outlet,
      ),
      staticData: { ultramodernRouteId: route.id },
      ...loaderOptions(route),
    });
    return native.addChildren(
      route.children.map(child => bind(child, native, errorComponent)),
    );
  }

  const rootErrorComponent = modules[rootDescriptor?.id ?? '']?.errorComponent;
  const tree = root.addChildren(
    children.map(route => bind(route, root, rootErrorComponent)),
  );
  registerRouteCompletionScope(tree, completionScope);
  return tree;
}
