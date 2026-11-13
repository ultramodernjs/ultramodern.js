import type React from 'react';
import type { ServerPayload } from './serverPayload/index';

export type RuntimeRoute = {
  children?: RuntimeRoute[];
  routes?: RuntimeRoute[];
  [key: string]: any;
};

type RuntimeHookCaller = {
  call: (...args: any[]) => any;
  [key: string]: unknown;
};

type RuntimeHooks = Record<string, RuntimeHookCaller>;

type RuntimePluginAPI = {
  updateRuntimeContext?: (context: unknown) => unknown;
  [key: string]: any;
};

type InternalRuntimeContextLike = {
  hooks: RuntimeHooks;
  pluginAPI?: RuntimePluginAPI;
  [key: string]: any;
};

// Native router hooks and context identities are shared across router plugins.
export { DefaultNotFound } from '../../router/runtime/DefaultNotFound';
export {
  modifyRoutes,
  onAfterCreateRouter,
  onAfterHydrateRouter,
  onBeforeCreateRouter,
  onBeforeCreateRoutes,
  onBeforeHydrateRouter,
  type RouterExtendsHooks,
  type RouterLifecycleContext,
  routerProviderRegistryHooks,
} from '../../router/runtime/hooks';
export type { LinkPrefetchPolicy } from '../../router/runtime/PrefetchLink';
export type {
  LoaderFunction,
  LoaderFunctionArgs,
  ModernRoute,
} from '../../router/runtime/types';
// Every other runtime module imports these through `@modern-js/runtime/context`
// so Module Federation shares one copy of them.
export {
  getInitialContext,
  InternalRuntimeContext,
  ReactRuntimeContext,
  type RequestContext,
  RuntimeComponentResolverContext,
  RuntimeContext,
  type TInternalRuntimeContext,
  type TRuntimeContext,
  useRuntimeContext,
} from './runtime';

export type { PayloadRoute, ServerPayload } from './serverPayload/index';

interface GlobalContext {
  entryName?: string;
  /**
   * App.tsx export default component
   */
  App?: React.ComponentType;
  /**
   * nest router and page router config
   */
  routes?: RuntimeRoute[];
  /**
   * nest router init function
   */
  appInit?: () => Promise<unknown>;
  /**
   * page router _app.tsx export layout app
   */
  layoutApp?: React.ComponentType;
  /**
   * Entry basename for routing
   */
  basename?: string;

  internalRuntimeContext?: InternalRuntimeContextLike;
  /**
   * RSCRoot
   */
  RSCRoot?: React.ComponentType;
  isRscClient?: boolean;
  serverPayload?: ServerPayload;
  enableRsc?: boolean;
}

const globalContext: GlobalContext = {};

export { getServerPayload, setServerPayload } from './serverPayload/index';

export function getGlobalIsRscClient() {
  return globalContext.isRscClient;
}

export function getGlobalEnableRsc() {
  return globalContext.enableRsc;
}

export function setGlobalContext(
  context: Omit<GlobalContext, 'internalRuntimeContext'>,
) {
  globalContext.entryName = context.entryName;
  globalContext.App = context.App;
  globalContext.routes = context.routes;
  globalContext.appInit = context.appInit;
  globalContext.layoutApp = context.layoutApp;
  globalContext.basename = context.basename;
  globalContext.RSCRoot = context.RSCRoot;
  globalContext.isRscClient = context.isRscClient;
  globalContext.enableRsc = context.enableRsc;
}

export function getCurrentEntryName() {
  return globalContext.entryName;
}

export function getGlobalRSCRoot() {
  return globalContext.RSCRoot;
}

export function setGlobalInternalRuntimeContext(
  context: InternalRuntimeContextLike,
) {
  globalContext.internalRuntimeContext = context;
}

export function getGlobalInternalRuntimeContext() {
  return globalContext.internalRuntimeContext!;
}

export function getGlobalApp() {
  return globalContext.App;
}

export function getGlobalRoutes(): undefined | RuntimeRoute[] {
  return globalContext.routes;
}

export function getGlobalLayoutApp() {
  return globalContext.layoutApp;
}

export function getGlobalBasename() {
  return globalContext.basename;
}
