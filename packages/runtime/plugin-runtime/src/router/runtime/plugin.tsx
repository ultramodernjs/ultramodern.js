// @effect-diagnostics globalConsole:off strictBooleanExpressions:off unnecessaryArrowBlock:off
import type { RuntimePluginAPI } from '@modern-js/plugin/runtime';
import {
  getGlobalEnableRsc,
  getGlobalIsRscClient,
  getGlobalLayoutApp,
  getGlobalRoutes,
  InternalRuntimeContext,
} from '@modern-js/runtime/context';
import { merge } from '@modern-js/runtime-utils/merge';
import type { RouterSubscriber } from '@modern-js/runtime-utils/router';
import {
  createBrowserRouter,
  createHashRouter,
  createRoutesFromElements,
  type RouteObject,
  RouterProvider,
  type RouterProviderProps,
  useHref,
  useInRouterContext,
  useLocation,
  useMatches,
  useNavigate,
  useParams,
} from '@modern-js/runtime-utils/router';
import { normalizePathname } from '@modern-js/runtime-utils/url';
import * as React from 'react';
import { useContext, useEffect, useRef } from 'react';
import type { RuntimePlugin } from '../../common';
import type { TInternalRuntimeContext } from '../../core/context/runtime';
import type { RouterExtendsHooks, RouterLifecycleContext } from './hooks';
import { routerProviderRegistryHooks } from './hooks';
import { Link as PrefetchLink } from './PrefetchLink';
import { createClientRouterFromPayload } from './rsc-router';
import type { ModernRoute, RouterConfig, Routes } from './types';
import {
  createRouteObjectsFromConfig,
  deserializeErrors,
  renderRoutes,
  urlJoin,
} from './utils';

declare const __MODERN_ENABLE_RSC__: boolean;

export let finalRouteConfig: RouterConfig['routesConfig'] = {
  routes: [],
};
export let beforeCreateRouter = true;
// support csr only, it is not allowed to use in ssr app.
// inhouse private, will deprecated
export function modifyRoutes(modifyFunction: (routes: Routes) => Routes) {
  if (beforeCreateRouter) {
    const { routes: originRoutes } = finalRouteConfig;
    const newRoutes = modifyFunction(originRoutes);
    finalRouteConfig.routes = newRoutes;
  } else {
    console.error(
      'It is not allowed to modify routes config after create router.',
    );
  }
}

type RouterPluginAPI = RuntimePluginAPI<{
  extendHooks: RouterExtendsHooks;
}>;

interface UseRouterCreationOptions {
  api: RouterPluginAPI;
  cache: WeakMap<TInternalRuntimeContext, RouterCreationResult>;
  createRoutes?: RouterConfig['createRoutes'];
  supportHtml5History: boolean;
  selectBasePath: (pathname: string) => string;
  basename: string;
}

type RouterCreationResult = {
  router: RouterProviderProps['router'];
  routes: RouteObject[];
};

export const routerPlugin = (
  userConfig: Partial<RouterConfig> = {},
): RuntimePlugin<{
  extendHooks: RouterExtendsHooks;
}> => {
  return {
    name: '@modern-js/plugin-router',
    registryHooks: routerProviderRegistryHooks,
    setup: api => {
      const routesContainer = {
        current: [] as RouteObject[],
      };

      api.onBeforeRender((context: TInternalRuntimeContext) => {
        // In some scenarios, the initial pathname and the current pathname do not match.
        // We add a configuration to support the page to reload.
        if (window._SSR_DATA && userConfig.unstable_reloadOnURLMismatch) {
          const { ssrContext } = context;
          const currentPathname = normalizePathname(window.location.pathname);
          const initialPathname =
            ssrContext?.request?.pathname &&
            normalizePathname(ssrContext.request.pathname);

          if (initialPathname && initialPathname !== currentPathname) {
            const errorMsg = `The initial URL ${initialPathname} and the URL ${currentPathname} to be hydrated do not match, reload.`;
            console.error(errorMsg);
            window.location.reload();
          }
        }

        // for garfish plugin to get basename,
        // why not let garfish plugin just import @modern-js/runtime/router
        // so the `router` has no type declare in RuntimeContext
        context.router = {
          Link: PrefetchLink,
          useMatches,
          useLocation,
          useHref,
          useInRouterContext,
          useNavigate,
          useParams,
        };

        // Prefetch Link will use routes for match next route
        Object.defineProperty(context, 'routes', {
          get() {
            return routesContainer.current;
          },
          enumerable: true,
        });
      });
      api.wrapRoot((App: React.ComponentType<any>) => {
        const mergedConfig = merge(
          api.getRuntimeConfig().router || {},
          userConfig,
        ) as RouterConfig;
        const {
          serverBase = [],
          supportHtml5History = true,
          basename = '',
          routesConfig,
          createRoutes,
          future,
        } = mergedConfig;
        const useTransitions =
          mergedConfig.useTransitions ?? future?.v7_startTransition;

        finalRouteConfig = {
          routes: getGlobalRoutes() as ModernRoute[] | undefined,
          globalApp: getGlobalLayoutApp(),
          ...routesConfig,
        };

        if (!finalRouteConfig.routes && !createRoutes) {
          return App;
        }

        const selectBasePath = (pathname: string) => {
          const match = serverBase.find(baseUrl =>
            isSegmentPrefix(pathname, baseUrl),
          );
          return match || '/';
        };

        // A recoverable hydration mismatch can restart this component before
        // its first commit. Keep the in-flight router scoped to the runtime
        // provider so the retry observes the same loader requests and state.
        const routerCache = new WeakMap<
          TInternalRuntimeContext,
          RouterCreationResult
        >();

        const RouterWrapper = (props: any) => {
          const routerResult = useRouterCreation(
            (
              typeof __MODERN_ENABLE_RSC__ !== 'undefined'
                ? __MODERN_ENABLE_RSC__
                : getGlobalEnableRsc() === true
            )
              ? {
                  ...props,
                  rscPayload: props?.rscPayload,
                }
              : props,
            {
              api: api as any,
              cache: routerCache,
              createRoutes,
              supportHtml5History,
              selectBasePath,
              basename,
            },
          );

          const { router, routes } = routerResult;

          routesContainer.current = routes;

          beforeCreateRouter = false;

          // To match the node tree about https://github.com/web-infra-dev/modern.js/blob/v2.59.0/packages/runtime/plugin-runtime/src/router/runtime/plugin.node.tsx#L150-L168
          // According to react [useId generation algorithm](https://github.com/facebook/react/pull/22644), `useId` will generate id with the react node react struct.
          // To void hydration failed, we must guarantee that the node tree when browser hydrate must have same struct with node tree when ssr render.
          const routerContent = (
            <>
              <RouterProvider router={router} useTransitions={useTransitions} />
              <EmptyComponent />
              <EmptyComponent />
            </>
          );

          return App ? <App>{routerContent}</App> : routerContent;
        };

        return RouterWrapper;
      });
    },
  };
};

const EmptyComponent = () => null;

const safeUse = (promise: Promise<unknown>) => {
  const useProp = 'use';
  const useHook = React && (React as any)[useProp];
  if (typeof useHook === 'function') {
    return useHook(promise);
  }
  return null;
};

function normalizeBase(b: string) {
  if (b.length > 1 && b.endsWith('/')) return b.slice(0, -1);
  return b || '/';
}

function isSegmentPrefix(pathname: string, base: string) {
  const b = normalizeBase(base);
  const p = pathname || '/';
  return p === b || p.startsWith(`${b}/`);
}

function useRouterCreation(props: any, options: UseRouterCreationOptions) {
  const {
    api,
    cache,
    createRoutes,
    supportHtml5History,
    selectBasePath,
    basename,
  } = options;
  const runtimeContext = useContext(InternalRuntimeContext);

  const baseUrl = selectBasePath(location.pathname).replace(/^\/*/, '/');
  const _basename =
    baseUrl === '/'
      ? urlJoin(
          baseUrl,
          runtimeContext._internalRouterBaseName || basename || '',
        )
      : baseUrl;

  const { unstable_getBlockNavState: getBlockNavState } = runtimeContext;
  // Keep the compile-time flag inline at every RSC branch so Rspack can prune
  // RSC-only modules in non-RSC development and production bundles. Runtime
  // consumers without the builder define use the generated context fallback.
  const rscPayload =
    (typeof __MODERN_ENABLE_RSC__ !== 'undefined'
      ? __MODERN_ENABLE_RSC__
      : getGlobalEnableRsc() === true) && props?.rscPayload
      ? safeUse(props.rscPayload)
      : null;

  let hydrationData =
    typeof __MODERN_ENABLE_RSC__ !== 'undefined'
      ? __MODERN_ENABLE_RSC__
        ? window._ROUTER_DATA || rscPayload
        : window._ROUTER_DATA
      : getGlobalEnableRsc() === true
        ? window._ROUTER_DATA || rscPayload
        : window._ROUTER_DATA;

  // Creation and publication share the runtime provider's lifetime.
  const result = useRef<RouterCreationResult | null>(
    cache.get(runtimeContext) ?? null,
  );
  if (result.current === null) {
    if (hydrationData?.errors) {
      hydrationData = {
        ...hydrationData,
        errors: deserializeErrors(hydrationData.errors),
      };
    }

    let routes: RouteObject[] | null = null;
    if (
      (typeof __MODERN_ENABLE_RSC__ !== 'undefined'
        ? __MODERN_ENABLE_RSC__
        : getGlobalEnableRsc() === true) &&
      getGlobalIsRscClient()
    ) {
      routes = createRoutes
        ? createRoutes()
        : createRouteObjectsFromConfig({
            routesConfig: finalRouteConfig,
          });
    } else {
      routes = createRoutes
        ? createRoutes()
        : createRoutesFromElements(
            renderRoutes({
              routesConfig: finalRouteConfig,
              props,
            }),
          );
    }

    if (!routes) {
      routes = [];
    }

    const hooks = api.getHooks();

    if (
      (typeof __MODERN_ENABLE_RSC__ !== 'undefined'
        ? __MODERN_ENABLE_RSC__
        : getGlobalEnableRsc() === true) &&
      rscPayload
    ) {
      try {
        const router = createClientRouterFromPayload(
          rscPayload,
          routes,
          _basename,
        );

        result.current = {
          router,
          routes: router.routes || [],
        };
        cache.set(runtimeContext, result.current);
        return result.current;
      } catch (e) {
        console.error('Failed to create router from RSC payload:', e);
      }
    }

    const modifiedRoutes = hooks.modifyRoutes.call(routes);
    const routerLifecycleContext: RouterLifecycleContext = {
      framework: 'react-router',
      phase: 'client-create',
      routes: modifiedRoutes,
      runtimeContext,
      basename: _basename,
      hydrationData,
    };
    hooks.onBeforeCreateRouter.call(routerLifecycleContext);

    const router = supportHtml5History
      ? createBrowserRouter(modifiedRoutes, {
          basename: _basename,
          hydrationData,
        })
      : createHashRouter(modifiedRoutes, {
          basename: _basename,
          hydrationData,
        });
    hooks.onAfterCreateRouter.call({
      ...routerLifecycleContext,
      router,
      runtimeContext,
    });

    if (hydrationData) {
      hooks.onBeforeHydrateRouter.call({
        ...routerLifecycleContext,
        phase: 'hydrate',
        router,
        runtimeContext,
      });
      hooks.onAfterHydrateRouter.call({
        ...routerLifecycleContext,
        phase: 'hydrate',
        router,
        runtimeContext,
      });
    }

    const originSubscribe = router.subscribe;
    router.subscribe = (listener: RouterSubscriber) => {
      const wrappedListener: RouterSubscriber = (...args) => {
        const blockRoute = getBlockNavState ? getBlockNavState() : false;
        if (blockRoute) {
          return;
        }
        return listener(...args);
      };
      return originSubscribe(wrappedListener);
    };

    result.current = {
      router,
      routes: modifiedRoutes,
    };
    cache.set(runtimeContext, result.current);
  }
  return result.current;
}
