import { createMemoryStorage } from '@modern-js/runtime-utils/storer';
import type {
  CacheControl,
  CacheOption,
  CacheOptionProvider,
  Container,
} from '@modern-js/types';
import type { NodeRequest } from '@modern-js/types/server';
import { X_RENDER_CACHE } from '../../constants';
import type {
  RequestHandler,
  RequestHandlerOptions,
} from '../../types/requestHandler';
import { createTransformStream, getPathname } from '../../utils';

interface CacheStruct {
  val: string;
  cursor: number;
  headers: Record<string, string>;
}

const preventsSharedCaching = (headers: Headers): boolean =>
  /(?:^|,)\s*(?:private|no-store|no-cache)\s*(?:[=,]|$)/i.test(
    headers.get('cache-control') || '',
  );

const isCacheableResponse = (response: Response): boolean =>
  response.status === 200 &&
  !preventsSharedCaching(response.headers) &&
  !response.headers.has('set-cookie') &&
  !response.headers.get('vary');

const removeTailSlash = (s: string): string => s.replace(/\/+$/, '');
const ZERO_RENDER_LEVEL = /"renderLevel":0/;
const NO_SSR_CACHE = /<meta\s+[^>]*name=["']no-ssr-cache["'][^>]*>/i;

export type CacheStatus = 'hit' | 'stale' | 'expired' | 'miss';

async function processCache({
  request,
  key,
  requestHandler,
  requestHandlerOptions,
  ttl,
  container,
  cacheStatus,
}: {
  request: Request;
  key: string;
  requestHandler: RequestHandler;
  requestHandlerOptions: RequestHandlerOptions;
  ttl: number;
  container: Container;
  cacheStatus?: CacheStatus;
}) {
  const response = await requestHandler(request, requestHandlerOptions);
  const { onError } = requestHandlerOptions;
  const deleteCache = async () => {
    try {
      await container.delete(key);
    } catch {
      (onError || console.error)('[render-cache] delete cache failed');
    }
  };

  if (!isCacheableResponse(response) || !response.body) {
    // A refresh can change a previously public response into a private one.
    await deleteCache();
    return response;
  }
  const headers = Object.fromEntries(response.headers);

  const decoder: TextDecoder = new TextDecoder();

  if (response.body) {
    const stream = createTransformStream();

    const reader = response.body.getReader();
    const writer = stream.writable.getWriter();

    let html = '';
    let cancelled = false;
    const cancel = async (reason: unknown) => {
      cancelled = true;
      await reader.cancel(reason);
    };
    // A disconnected consumer may leave the producer waiting in reader.read().
    void writer.closed.catch(cancel).catch(() => {});
    const onAbort = () => {
      void Promise.allSettled([
        cancel(request.signal.reason),
        writer.abort(request.signal.reason),
      ]);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    const pumping = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) break;
          html += decoder.decode(value, { stream: true });
          await writer.write(value);
        }
        html += decoder.decode();
        // Finish the response without waiting for the cache backend.
        await writer.close();
        if (cancelled) return;
        if (ZERO_RENDER_LEVEL.test(html) || NO_SSR_CACHE.test(html)) {
          await deleteCache();
          return;
        }
        const cache: CacheStruct = {
          val: html,
          cursor: Date.now(),
          headers,
        };
        try {
          await container.set(key, JSON.stringify(cache), { ttl });
        } catch (error) {
          (onError || console.error)('[render-cache] set cache failed');
        }
      } catch (error) {
        await Promise.allSettled([cancel(error), writer.abort(error)]);
        if (cacheStatus) {
          try {
            (onError || console.error)('[render-cache] response stream failed');
          } catch {
            // Error reporting must not reject an unawaited background task.
          }
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
      }
    })();
    void pumping.catch(() => {});

    cacheStatus && response.headers.set(X_RENDER_CACHE, cacheStatus);

    return new Response(stream.readable, {
      status: response.status,
      headers: response.headers,
    });
  }

  return response;
}

const CACHE_NAMESPACE = '__ssr__cache';

const storage = createMemoryStorage<string>(CACHE_NAMESPACE);

function computedKey(req: Request, cacheControl: CacheControl): string {
  const pathname = getPathname(req);
  const { customKey } = cacheControl;

  // we use `pathname.replace(/\/+$/, '')` to remove the '/' with end.
  // examples:
  // pathname1: '/api', pathname2: '/api/'
  // pathname1 as same as pathname2
  const defaultKey = pathname === '/' ? pathname : removeTailSlash(pathname);

  if (customKey) {
    if (typeof customKey === 'string') {
      return customKey;
    } else {
      return customKey(defaultKey);
    }
  } else {
    const url = new URL(req.url);
    return `${url.origin}${defaultKey}${url.search}`;
  }
}

type MaybeAsync<T> = Promise<T> | T;

/**
 * Check if a request should be processed through cache logic
 */
export function shouldUseCache(request: Request): boolean {
  const url = new URL(request.url);
  const hasRSCAction = request.headers.has('x-rsc-action');
  const hasRSCTree = request.headers.has('x-rsc-tree');
  const hasLoaderQuery = url.searchParams.has('__loader');

  // Skip cache for RSC requests or loader requests
  return !(hasRSCAction || hasRSCTree || hasLoaderQuery);
}

const cacheKeyRegExps = new Map<string, RegExp>();

function getCacheKeyRegExp(key: string): RegExp {
  let regExp = cacheKeyRegExps.get(key);
  if (!regExp) {
    regExp = new RegExp(key);
    cacheKeyRegExps.set(key, regExp);
  }
  return regExp;
}

export function matchCacheControl(
  cacheOption?: CacheOption,
  // TODO: remove nodeReq
  req?: NodeRequest,
): MaybeAsync<CacheControl | undefined | false> {
  if (!cacheOption || !req) {
    return undefined;
  } else if (isCacheControl(cacheOption)) {
    return cacheOption;
  } else if (isCacheOptionProvider(cacheOption)) {
    return cacheOption(req);
  } else {
    const url = req.url!;
    const options = Object.entries(cacheOption);

    for (const [key, option] of options) {
      if (key === '*' || getCacheKeyRegExp(key).test(url)) {
        if (typeof option === 'function') {
          return option(req);
        } else {
          return option;
        }
      }
    }

    return undefined;
  }

  function isCacheOptionProvider(
    option: CacheOption,
  ): option is CacheOptionProvider {
    return typeof option === 'function';
  }

  function isCacheControl(option: CacheOption): option is CacheControl {
    return typeof option === 'object' && option !== null && 'maxAge' in option;
  }
}

export interface GetCacheResultOptions {
  cacheControl: CacheControl;
  requestHandler: RequestHandler;
  requestHandlerOptions: RequestHandlerOptions;
  container?: Container;
}

export async function getCacheResult(
  request: Request,
  options: GetCacheResultOptions,
): Promise<Response> {
  const {
    cacheControl,
    container = storage,
    requestHandler,
    requestHandlerOptions,
  } = options;
  const { onError } = requestHandlerOptions;

  // A custom key is an explicit partitioning contract owned by the provider.
  const hasCredentials =
    request.headers.has('cookie') || request.headers.has('authorization');
  if (
    request.method !== 'GET' ||
    !shouldUseCache(request) ||
    preventsSharedCaching(request.headers) ||
    (hasCredentials && !cacheControl.customKey)
  ) {
    return requestHandler(request, requestHandlerOptions);
  }

  // Isolate entries written before response privacy checks, including custom stores.
  const key = `${CACHE_NAMESPACE}:v2:${computedKey(request, cacheControl)}`;

  let value: string | undefined;
  try {
    value = await container.get(key);
  } catch (_) {
    if (onError) {
      onError('[render-cache] get cache failed');
    } else {
      console.error('[render-cache] get cache failed');
    }
    value = undefined;
  }
  const { maxAge, staleWhileRevalidate } = cacheControl;
  const ttl = maxAge + staleWhileRevalidate;

  if (value) {
    // has cache
    const cache: CacheStruct = JSON.parse(value);
    const interval = Date.now() - cache.cursor;

    if (interval <= maxAge) {
      // the cache is validate
      const cacheStatus: CacheStatus = 'hit';
      return new Response(cache.val, {
        headers: {
          ...cache.headers,
          [X_RENDER_CACHE]: cacheStatus,
        },
      });
    } else if (interval <= staleWhileRevalidate + maxAge) {
      // the cache is stale while revalidate

      // we shouldn't await this promise.
      void processCache({
        key,
        request,
        requestHandler,
        requestHandlerOptions,
        ttl,
        container,
      })
        .then(async response => {
          // Consume the response so the cache can finish writing the stream.
          await response.text();
        })
        .catch(error => {
          try {
            (onError || console.error)('[render-cache] revalidation failed');
          } catch {
            // Error reporting must not reject an unawaited background task.
          }
        });

      const cacheStatus: CacheStatus = 'stale';
      return new Response(cache.val, {
        headers: {
          ...cache.headers,
          [X_RENDER_CACHE]: cacheStatus,
        },
      });
    } else {
      // the cache is invalidate
      return processCache({
        key,
        request,
        requestHandler,
        requestHandlerOptions,
        ttl,
        container,
        cacheStatus: 'expired',
      });
    }
  } else {
    return processCache({
      key,
      request,
      requestHandler,
      requestHandlerOptions,
      ttl,
      container,
      cacheStatus: 'miss',
    });
  }
}
