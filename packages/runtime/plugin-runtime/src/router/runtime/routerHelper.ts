// @effect-diagnostics globalConsole:off

import type { ShouldRevalidateFunction } from '@modern-js/runtime-utils/router';
import { ROUTE_MODULES } from '@modern-js/utils/universal/constants';
import type { ElementType } from 'react';

type RouteModule = Record<PropertyKey, unknown> & {
  Component?: unknown;
  default?: unknown;
  shouldRevalidate?: unknown;
};

type RouteModulesWindow = Window & {
  [ROUTE_MODULES]?: Record<string, unknown>;
};

export type ModernRouteErrorResponse = {
  status: number;
  statusText: string;
  internal: boolean;
  data: unknown;
};

export const isRouteErrorResponse = (
  error: unknown,
): error is ModernRouteErrorResponse =>
  error !== null &&
  typeof error === 'object' &&
  typeof (error as Partial<ModernRouteErrorResponse>).status === 'number' &&
  typeof (error as Partial<ModernRouteErrorResponse>).statusText === 'string' &&
  typeof (error as Partial<ModernRouteErrorResponse>).internal === 'boolean' &&
  'data' in error;

const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const isRouteComponent = (
  value: unknown,
): value is ElementType<Record<string, unknown>> =>
  typeof value === 'function' || (isObjectLike(value) && '$$typeof' in value);

const getRouteModules = () => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (window as RouteModulesWindow)[ROUTE_MODULES];
};

const storeRouteModule = (routeModule: unknown, routeId: string) => {
  if (typeof document === 'undefined') {
    return;
  }

  const routeModules = getRouteModules();
  if (routeModules !== undefined) {
    routeModules[routeId] = routeModule;
  }
};

const unwrapRspackAsyncModule = (routeModule: unknown): unknown => {
  if (!isObjectLike(routeModule)) {
    return routeModule;
  }

  const rspackExportsSymbol = Object.getOwnPropertySymbols(routeModule).find(
    symbol => symbol.description === 'rspack exports',
  );
  if (rspackExportsSymbol !== undefined) {
    return routeModule[rspackExportsSymbol];
  }

  if ('__webpack_exports__' in routeModule) {
    return routeModule.__webpack_exports__;
  }

  return routeModule;
};

export const createShouldRevalidate =
  (routeId: string): ShouldRevalidateFunction =>
  arg => {
    const routeModule = getRouteModules()?.[routeId];
    if (isObjectLike(routeModule)) {
      const shouldRevalidate = routeModule.shouldRevalidate;
      if (typeof shouldRevalidate === 'function') {
        return (shouldRevalidate as ShouldRevalidateFunction)(arg);
      }
    }

    return arg.defaultShouldRevalidate;
  };

const pickRouteModuleComponent = (
  routeModule: unknown,
  seen: Set<unknown> = new Set(),
): ElementType<Record<string, unknown>> | undefined => {
  const unwrappedRouteModule = unwrapRspackAsyncModule(routeModule);

  if (isRouteComponent(unwrappedRouteModule)) {
    return unwrappedRouteModule;
  }

  if (!isObjectLike(unwrappedRouteModule) || seen.has(unwrappedRouteModule)) {
    return undefined;
  }
  seen.add(unwrappedRouteModule);

  const componentModule = unwrappedRouteModule as RouteModule;
  for (const candidate of [
    componentModule.default,
    componentModule.Component,
  ]) {
    const component = pickRouteModuleComponent(candidate, seen);
    if (component !== undefined) {
      return component;
    }
  }

  return undefined;
};

export const resolveRouteComponent = (
  routeModule: unknown,
): ElementType<Record<string, unknown>> =>
  pickRouteModuleComponent(routeModule) ??
  (routeModule as ElementType<Record<string, unknown>>);

export const handleRouteModule = (routeModule: unknown, routeId: string) => {
  storeRouteModule(routeModule, routeId);
  const component = pickRouteModuleComponent(routeModule);
  return component !== undefined ? { default: component } : routeModule;
};

/**
 * @deprecated Generated routes no longer use this. Swallowing the import error
 * here replaced a `ChunkLoadError` with an unrelated `TypeError` by the time it
 * reached the route error boundary. Kept only for code that imports it directly.
 */
export const handleRouteModuleError = (error: Error) => {
  console.error(error);
  return null;
};
