// @effect-diagnostics asyncFunction:off extendsNativeError:off strictBooleanExpressions:off
import type { AnyRouter } from '@tanstack/react-router';
import type { SubmitOptions, SubmitTarget } from './formData';
import {
  formDataToTextPlain,
  formDataToUrlSearchParams,
  toFormData,
} from './formData';
import { isRedirectResponse } from './loaderBridge';

export class RouteActionResponseError<TData = unknown> extends Error {
  readonly response: Response;
  readonly data: TData;

  constructor(response: Response, data: TData) {
    super(`Route action failed with status ${response.status}`);
    this.name = 'RouteActionResponseError';
    this.response = response;
    this.data = data;
  }
}

type RouteAction = (args: {
  request: Request;
  params: Record<string, string>;
  context?: unknown;
}) => Promise<unknown> | unknown;

type RouteLoader = (args: {
  request: Request;
  params: Record<string, string>;
  context?: unknown;
}) => Promise<unknown> | unknown;

type RouterBuildLocationOptions = Parameters<AnyRouter['buildLocation']>[0];
type RouterNavigateOptions = Parameters<AnyRouter['navigate']>[0];

function resolveRouteHandlers(router: AnyRouter, actionTo: string) {
  const builtLocation = router.buildLocation({
    to: actionTo,
  } as RouterBuildLocationOptions);
  const [, routeParams, foundRoute] = router.getMatchedRoutes(
    builtLocation.pathname,
  );
  const routeStaticData = foundRoute?.options?.staticData as
    | Record<string, unknown>
    | undefined;
  const action = routeStaticData?.modernRouteAction as RouteAction | undefined;
  const loader = routeStaticData?.modernRouteLoader as RouteLoader | undefined;

  return {
    action,
    loader,
    href: builtLocation.href,
    params: routeParams,
  };
}

async function parseResponseData(response: Response) {
  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function parseResponseResultOrThrow(response: Response) {
  const parsed = await parseResponseData(response);
  if (!response.ok) {
    throw new RouteActionResponseError(response, parsed);
  }
  return parsed;
}

export async function submitRouteAction({
  router,
  target,
  options = {},
  isFetcher = false,
  onInvalidateStart,
}: {
  router: AnyRouter;
  target: SubmitTarget;
  options?: SubmitOptions;
  isFetcher?: boolean;
  onInvalidateStart?: () => void;
}) {
  const method = (options.method || 'post').toLowerCase();
  const encType = options.encType || 'application/x-www-form-urlencoded';
  const actionTo = options.action || '.';
  const formData = toFormData(target);
  const resolved = resolveRouteHandlers(router, actionTo);

  if (method === 'get') {
    const search = formDataToUrlSearchParams(formData).toString();
    const requestUrl = new URL(resolved.href, window.location.origin);
    requestUrl.search = search;

    if (isFetcher && resolved.loader) {
      const result = await resolved.loader({
        request: new Request(requestUrl, {
          method: 'GET',
        }),
        params: resolved.params,
      });

      if (result instanceof Response) {
        const redirectTo =
          result.headers.get('X-Modernjs-Redirect') ||
          result.headers.get('Location');
        if (redirectTo || isRedirectResponse(result)) {
          await router.navigate({
            to: redirectTo || '/',
          } as RouterNavigateOptions);
          return parseResponseData(result);
        }
        return parseResponseResultOrThrow(result);
      }

      return result;
    }

    await router.navigate({
      href: `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`,
    } as RouterNavigateOptions);
    return;
  }

  if (!resolved.action) {
    throw new Error(`No route action found for "${actionTo}"`);
  }

  const headers = new Headers();
  let body: BodyInit | null = null;
  if (encType.includes('application/json')) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(
      Object.fromEntries(formDataToUrlSearchParams(formData).entries()),
    );
  } else if (encType.includes('text/plain')) {
    headers.set('Content-Type', 'text/plain;charset=UTF-8');
    body = formDataToTextPlain(formData);
  } else if (encType.includes('application/x-www-form-urlencoded')) {
    headers.set(
      'Content-Type',
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
    body = formDataToUrlSearchParams(formData);
  } else {
    body = formData;
  }

  const request = new Request(new URL(resolved.href, window.location.origin), {
    method: method.toUpperCase(),
    headers,
    body,
  });

  let result: unknown;
  try {
    result = await resolved.action({
      request,
      params: resolved.params,
    });
  } catch (error) {
    if (!(error instanceof Response) || !isRedirectResponse(error)) {
      throw error;
    }
    result = error;
  }

  if (result instanceof Response) {
    const redirectTo =
      result.headers.get('X-Modernjs-Redirect') ||
      result.headers.get('Location');
    if (redirectTo || isRedirectResponse(result)) {
      await router.navigate({
        to: redirectTo || '/',
      } as RouterNavigateOptions);
      return parseResponseData(result);
    }

    const parsed = isFetcher
      ? await parseResponseResultOrThrow(result)
      : await parseResponseData(result);
    onInvalidateStart?.();
    await router.invalidate();
    return parsed;
  }

  onInvalidateStart?.();
  await router.invalidate();
  return result;
}
