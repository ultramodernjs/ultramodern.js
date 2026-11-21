import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { NativeCompilerArtifacts } from '@modern-js/renderer-core/adapter';
import {
  collectDocumentAssets,
  type DocumentAsset,
} from '@modern-js/renderer-core/document';
import type {
  Renderer,
  RendererIdentity,
} from '@modern-js/renderer-core/identity';
import {
  assertRendererIdentity,
  identityCacheKey,
  RENDERER_IDENTITY_HEADER,
  serializeRendererIdentityHeader,
} from '@modern-js/renderer-core/identity';
import {
  dispatchNativeNodeRequest,
  type NativeDocumentCache,
  type NativeRequestContext,
  type NativeServerManifest,
  rejectNativeRscRequest,
  validateNativeClientAssetManifest,
} from '@modern-js/renderer-core/server';
import { fileReader } from '@modern-js/runtime-utils/fileReader';
import type {
  Context,
  Next,
  Render,
  RenderOptions,
  ServerConfig,
  ServerManifest,
  ServerPlugin,
} from '@modern-js/server-core';
import { injectMfAssetCacheHeadersPlugin } from '@modern-js/server-runtime-extensions';
import { injectRenderResourcesPlugin } from '@modern-js/server-runtime-extensions/render-resources';
import { injectStaticServingPlugin } from '@modern-js/server-runtime-extensions/static-serving/node';
import type { ServerRoute } from '@modern-js/types/server';
import { getEntryOptions } from '@modern-js/utils';
import { cutNameByHyphen } from '@modern-js/utils/universal';

export interface NativeNodeBindings {
  readonly loaderContext: Map<string, unknown>;
  readonly nodeRequest?: unknown;
  readonly locals?: Readonly<Record<string, unknown>>;
}

/** One completed compiler generation, retained for the entire request. */
export interface NativeDevelopmentSnapshot {
  readonly manifest: NativeServerManifest<NativeNodeBindings>;
  readonly assets: readonly DocumentAsset[];
  readonly nativeManifest: unknown;
  readonly hydrationBuildId?: string;
}

export interface NativeServerPluginOptions {
  readonly renderer: Exclude<Renderer, 'react'>;
  /**
   * The renderer's runtime `./manifest` module, which exports its
   * `compilerArtifacts`. Never the build-only `./plugin`, so a deployed
   * server traces and loads only runtime code.
   */
  readonly manifestModule?: string;
  /** In-process artifacts, instead of `manifestModule`. */
  readonly compilerArtifacts?: NativeCompilerArtifacts;
  readonly entries: Readonly<Record<string, RendererIdentity>>;
  readonly cache?: NativeDocumentCache;
  readonly cacheAllowed?: boolean;
  readonly maxCacheBytes?: number;
  /** Compiler-produced asset paths relative to the application's output root. */
  readonly assetManifestFile?: string;
  readonly nativeManifestFiles?: Readonly<Record<string, string>>;
  /** Owning dev composition supplies this; production uses emitted files. */
  readonly resolveDevelopmentSnapshot?: (
    identity: RendererIdentity,
    signal: AbortSignal,
  ) => Promise<NativeDevelopmentSnapshot>;
  readonly resolveManifest?: (
    manifest: ServerManifest,
    identity: RendererIdentity,
  ) =>
    | NativeServerManifest<NativeNodeBindings>
    | Promise<NativeServerManifest<NativeNodeBindings>>;
  readonly onError?: (
    error: unknown,
    request: Request,
    context: NativeRequestContext<NativeNodeBindings>,
  ) => Response | Promise<Response>;
}

function awaitDevelopmentSnapshot(
  provider: NonNullable<
    NativeServerPluginOptions['resolveDevelopmentSnapshot']
  >,
  identity: RendererIdentity,
  signal: AbortSignal,
): Promise<NativeDevelopmentSnapshot> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => {
      signal.removeEventListener('abort', aborted);
      reject(error);
    };
    const aborted = () => fail(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    try {
      void provider(identity, signal).then(snapshot => {
        if (signal.aborted) return fail(signal.reason);
        signal.removeEventListener('abort', aborted);
        resolve(snapshot);
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function assertFinalCapabilities(config: ServerConfig): void {
  if (config.server?.rsc) {
    throw new Error(
      'unsupported-renderer-capability: RSC requires the React renderer.',
    );
  }
}

function nativeManifestFromBundle(
  value: unknown,
  expectedIdentity: RendererIdentity,
): NativeServerManifest<NativeNodeBindings> {
  // The Node resource loader retains a CJS bundle's ESM namespace. Its
  // default export is the emitted native manifest, including its own identity.
  const manifest =
    value &&
    typeof value === 'object' &&
    !('rendererIdentity' in value) &&
    'default' in value
      ? value.default
      : value;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    !('rendererIdentity' in manifest) ||
    !manifest.rendererIdentity ||
    typeof manifest.rendererIdentity !== 'object'
  ) {
    throw new Error(
      'Native server bundle requires its exported renderer identity.',
    );
  }
  assertNativeTransport(manifest);
  assertRendererIdentity(manifest.rendererIdentity, expectedIdentity);
  return manifest;
}

function assertNativeTransport(
  value: object,
): asserts value is NativeServerManifest<NativeNodeBindings> {
  if (
    !('nativeRequestHandler' in value) ||
    typeof value.nativeRequestHandler !== 'function' ||
    ('nativeCSRRequestHandler' in value &&
      value.nativeCSRRequestHandler !== undefined &&
      typeof value.nativeCSRRequestHandler !== 'function') ||
    ('nativeMatchRouteIds' in value &&
      value.nativeMatchRouteIds !== undefined &&
      typeof value.nativeMatchRouteIds !== 'function')
  ) {
    throw new Error(
      'Native server bundle has invalid native transport handlers.',
    );
  }
}

function loaderContext(context: Context): Map<string, unknown> {
  // Preserve the explicit Node binding installed by configured middleware.
  const requestContext = context as unknown as {
    get(name: 'loaderContext'): Map<string, unknown> | undefined;
    set(name: 'loaderContext', value: Map<string, unknown>): void;
  };
  let values = requestContext.get('loaderContext');
  if (!values) {
    values = new Map<string, unknown>();
    requestContext.set('loaderContext', values);
  }
  return values;
}

function makeRenderOptions(context: Context): RenderOptions {
  return {
    nodeReq: context.env?.node?.req,
    monitors: context.get('monitors'),
    templates: context.get('templates') || {},
    serverManifest: context.get('serverManifest') || {},
    loaderContext: loaderContext(context),
    serverContext: context,
    locals: context.get('locals'),
    matchPathname: context.get('matchPathname'),
    matchEntryName: context.get('matchEntryName'),
    contextForceCSR: context.get('forceCSR'),
    reporter: context.get('reporter'),
  };
}

/**
 * The server route a pathname renders through, as the React render matches
 * rewrites: the longest page route prefix, limited to `entryName` when given.
 */
export function matchNativeServerRoute(
  routes: readonly ServerRoute[],
  pathname: string,
  entryName?: string,
): ServerRoute | undefined {
  let best: ServerRoute | undefined;
  for (const route of routes) {
    if (route.isApi || !route.entryName) continue;
    if (entryName && route.entryName !== entryName) continue;
    const base = route.urlPath.replace(/\/$/u, '');
    if (base && pathname !== base && !pathname.startsWith(`${base}/`)) continue;
    if (!best || route.urlPath.length > best.urlPath.length) best = route;
  }
  return best;
}

const CSP_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'link',
  'server-timing',
]);

/**
 * Apply middleware or route-config fields to native response headers. The
 * applied source keeps precedence for singleton fields, so a middleware
 * private/no-store policy survives a public native response. CSP, Link and
 * Server-Timing fields are cumulative and `Vary` is a union, so both keep the native values
 * too. Middleware cookies merge separately; route-config cookies append.
 */
export function applyMiddlewareHeaders(
  prepared: Headers,
  native: Headers,
): void {
  prepared.forEach((value, name) => {
    // The renderer owns its body framing; another source's length, transfer
    // coding or content coding would describe different bytes.
    if (
      name === 'set-cookie' ||
      name === 'content-length' ||
      name === 'transfer-encoding' ||
      name === 'content-encoding'
    )
      return;
    if (CSP_HEADERS.has(name)) native.append(name, value);
    else if (name === 'vary') {
      const fields = new Map<string, string>();
      for (const field of `${native.get('vary') ?? ''},${value}`.split(',')) {
        const item = field.trim();
        if (item && !fields.has(item.toLowerCase()))
          fields.set(item.toLowerCase(), item);
      }
      native.set('vary', [...fields.values()].join(', '));
    } else if (name !== 'content-type' || !native.has(name))
      native.set(name, value);
  });
}

function bindContextResponse(context: Context, response: Response): Response {
  // Hono keeps pre-render context.header() fields in a prepared Response.
  // Merge them through its public context API without reducing cookies to a map.
  const prepared = context.res.headers;
  const nativeCookies = response.headers.getSetCookie();
  const preparedCookies = prepared.getSetCookie();
  applyMiddlewareHeaders(prepared, response.headers);
  response.headers.delete('set-cookie');
  for (const cookie of [...preparedCookies, ...nativeCookies]) {
    response.headers.append('set-cookie', cookie);
  }
  // The res setter retains existing context fields. Give it the complete
  // merged headers so it cannot overwrite the native cookie array.
  const preparedNames: string[] = [];
  prepared.forEach((_value, name) => preparedNames.push(name));
  for (const name of preparedNames) prepared.delete(name);
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') prepared.append(name, value);
  });
  for (const cookie of response.headers.getSetCookie()) {
    prepared.append('set-cookie', cookie);
  }
  context.res = response;
  return context.res;
}

function confirmNodeDelivery(
  response: ServerResponse | undefined,
  signal: AbortSignal,
  capturedResponse: Response,
  finalResponse: () => Response | undefined,
): Promise<Headers | undefined> {
  if (!response) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const clear = () => {
      response.off('finish', finished);
      response.off('close', interrupted);
      response.off('error', interrupted);
      signal.removeEventListener('abort', interrupted);
    };
    const finished = () => {
      clear();
      const delivered = finalResponse();
      if (
        response.statusCode !== 200 ||
        delivered?.body !== capturedResponse.body ||
        delivered.statusText !== capturedResponse.statusText
      )
        return resolve(undefined);
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.getHeaders())) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const field of value) headers.append(name, field);
        } else headers.append(name, String(value));
      }
      resolve(headers);
    };
    const interrupted = () => {
      clear();
      resolve(undefined);
    };
    if (response.writableFinished) return finished();
    if (response.destroyed || signal.aborted) return interrupted();
    response.once('finish', finished);
    response.once('close', interrupted);
    response.once('error', interrupted);
    signal.addEventListener('abort', interrupted, { once: true });
  });
}

const requireManifest = createRequire(import.meta.url);

function loadCompilerArtifacts(
  specifier: string | undefined,
): NativeCompilerArtifacts {
  if (typeof specifier !== 'string' || !specifier)
    throw new Error(
      "Native server plugin requires its renderer's manifest module.",
    );
  const artifacts = requireManifest(specifier).compilerArtifacts as
    | NativeCompilerArtifacts
    | undefined;
  if (typeof artifacts?.validateClientManifest !== 'function')
    throw new Error(
      `Renderer manifest module ${specifier} exports no compilerArtifacts.`,
    );
  return artifacts;
}

/** The selected native app retains Modern's Node host, static/API and middleware. */
export function nativeServerPlugin(
  options: NativeServerPluginOptions,
): ServerPlugin {
  if (!options)
    throw new Error('Native server plugin requires a selected renderer.');
  // Loaded on the first manifest, so API-only servers never need it.
  let compilerArtifacts = options.compilerArtifacts;
  if (options.resolveDevelopmentSnapshot && options.cacheAllowed === true) {
    throw new Error(
      'Native development snapshots cannot enable document cache.',
    );
  }
  const entries = Object.freeze(
    Object.fromEntries(
      Object.entries(options.entries).map(([entryName, identity]) => {
        identityCacheKey(identity);
        if (
          identity.renderer !== options.renderer ||
          identity.entryName !== entryName
        ) {
          throw new Error(
            'Native server entry identity conflicts with its selected renderer.',
          );
        }
        return [entryName, Object.freeze({ ...identity })];
      }),
    ),
  );
  let finalConfig: ServerConfig;
  let distDirectory: string;
  let fallbackHeader = 'x-modern-ssr-fallback';
  let serverRoutes: readonly ServerRoute[] = [];
  // Unchanged manifest bytes keep one parsed object, so renderer validators
  // check each build's manifest once instead of on every request.
  const parsedManifests = new Map<string, { source: string; value: unknown }>();
  const readManifest = async (file: string): Promise<unknown> => {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/u).includes('..')) {
      throw new Error(
        'Native asset manifests must live inside the application output.',
      );
    }
    const source = await fileReader.readFile(path.join(distDirectory, file));
    if (source === null)
      throw new Error(
        `Missing native manifest ${file}. Rebuild the application before serving.`,
      );
    const parsed = parsedManifests.get(file);
    if (parsed?.source === source) return parsed.value;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (cause) {
      throw new Error(
        `Invalid native manifest ${file}. Rebuild the application before serving.`,
        { cause },
      );
    }
    parsedManifests.set(file, { source, value });
    return value;
  };
  const dispatch: Render = async (request, requestOptions) => {
    const rejection = rejectNativeRscRequest(request);
    if (rejection) return rejection;
    const entryName = requestOptions.matchEntryName;
    const identity = entryName ? entries[entryName] : undefined;
    if (!identity)
      throw new Error(
        `Native server has no immutable identity for entry ${String(entryName)}.`,
      );
    const ssr = getEntryOptions(
      entryName!,
      false,
      finalConfig.server?.ssr,
      finalConfig.server?.ssrByEntries,
    );
    const query = new URL(request.url).searchParams;
    const fallbackAllowed = typeof ssr === 'object' && ssr.forceCSR;
    const forceCSR = Boolean(
      fallbackAllowed &&
        (query.get('csr') ||
          request.headers.get(fallbackHeader) ||
          requestOptions.contextForceCSR),
    );
    const snapshot = options.resolveDevelopmentSnapshot
      ? await awaitDevelopmentSnapshot(
          options.resolveDevelopmentSnapshot,
          identity,
          request.signal,
        )
      : undefined;
    let snapshotManifest: NativeServerManifest<NativeNodeBindings> | undefined;
    if (options.resolveDevelopmentSnapshot) {
      if (!snapshot?.manifest || !Array.isArray(snapshot.assets)) {
        throw new Error(
          'Native development requires a complete compiler snapshot.',
        );
      }
      assertRendererIdentity(snapshot.manifest.rendererIdentity, identity);
      snapshotManifest = Object.freeze({
        ...snapshot.manifest,
        rendererIdentity: Object.freeze({
          ...snapshot.manifest.rendererIdentity,
        }),
      });
    }
    const assets = snapshot
      ? collectDocumentAssets(snapshot.assets)
      : options.assetManifestFile
        ? validateNativeClientAssetManifest(
            await readManifest(options.assetManifestFile),
            identity,
          )
        : undefined;
    if (snapshot && !assets?.some(asset => asset.kind === 'script')) {
      throw new Error('Native development snapshot has no application script.');
    }
    const nativeManifestFile = options.nativeManifestFiles?.[entryName!];
    let nativeManifest = snapshot
      ? snapshot.nativeManifest
      : nativeManifestFile
        ? await readManifest(nativeManifestFile)
        : undefined;
    let hydrationBuildId = snapshot?.hydrationBuildId;
    if (snapshot && nativeManifest === undefined) {
      throw new Error('Native development snapshot has no compiler manifest.');
    }
    if (nativeManifest !== undefined) {
      compilerArtifacts ??= loadCompilerArtifacts(options.manifestModule);
      const validated = await compilerArtifacts.validateClientManifest(
        nativeManifest,
        identity,
        { hydrationBuildId, development: snapshot !== undefined },
      );
      nativeManifest = validated.nativeManifest;
      hydrationBuildId = validated.hydrationBuildId;
    }
    const response = await dispatchNativeNodeRequest(request, {
      identity,
      async loadManifest() {
        const manifest =
          snapshotManifest ??
          (options.resolveManifest
            ? await options.resolveManifest(
                requestOptions.serverManifest,
                identity,
              )
            : requestOptions.serverManifest.renderBundles?.[entryName!]);
        if (!manifest)
          throw new Error(
            `Native server manifest is missing entry ${entryName}.`,
          );
        return nativeManifestFromBundle(manifest, identity);
      },
      context: {
        assets,
        nativeManifest,
        bindings: {
          loaderContext:
            requestOptions.loaderContext ??
            (requestOptions.serverContext
              ? loaderContext(requestOptions.serverContext)
              : new Map<string, unknown>()),
          nodeRequest: requestOptions.nodeReq,
          locals: requestOptions.locals,
        },
        serverConfig: {
          ssr: !ssr
            ? false
            : typeof ssr === 'object' && ssr.mode === 'stream'
              ? 'stream'
              : true,
          forceCSR,
          ssrByRouteIds: finalConfig.server?.ssrByRouteIds,
        },
        nonce: finalConfig.security?.nonce,
      },
      cache: options.cacheAllowed === true ? options.cache : undefined,
      maxCacheBytes: options.maxCacheBytes,
      hydrationBuildId,
      confirmDelivery: capturedResponse =>
        confirmNodeDelivery(
          requestOptions.serverContext?.env?.node?.res,
          request.signal,
          capturedResponse,
          () => requestOptions.serverContext?.res,
        ),
      onError: options.onError,
    });
    // A middleware rewrite to another entry renders with that entry's route.
    const matchedRoute = requestOptions.serverContext?.get('route');
    const selectedRoute =
      (matchedRoute?.entryName === entryName
        ? serverRoutes.find(
            route =>
              route.entryName === entryName &&
              route.urlPath === matchedRoute.urlPath,
          )
        : undefined) ??
      matchNativeServerRoute(
        serverRoutes,
        requestOptions.matchPathname ?? new URL(request.url).pathname,
        entryName,
      );
    const routeHeaders = new Headers();
    for (const [name, value] of Object.entries(
      selectedRoute?.responseHeaders ?? {},
    ))
      routeHeaders.append(name, String(value));
    applyMiddlewareHeaders(routeHeaders, response.headers);
    for (const cookie of routeHeaders.getSetCookie())
      response.headers.append('set-cookie', cookie);
    // Like the React host and the worker, name the built entry that rendered.
    response.headers.set(
      RENDERER_IDENTITY_HEADER,
      serializeRendererIdentityHeader(identity),
    );
    return response;
  };

  return {
    name: '@modern-js/native-node-server',
    usePlugins: [
      injectRenderResourcesPlugin(),
      // Production publishes the emitted federation containers, manifests and
      // chunks with the React host's CORS and cache policy. Development
      // answers them from the live compiler instead.
      ...(options.resolveDevelopmentSnapshot
        ? []
        : [injectMfAssetCacheHeadersPlugin(), injectStaticServingPlugin()]),
      {
        name: '@modern-js/native-node-capabilities',
        post: [
          '@modern-js/plugin-inject-render',
          '@modern-js/plugin-inject-resource',
          '@modern-js/plugin-inject-rsc-manifest',
        ],
        setup(api) {
          api.onPrepare(() => {
            finalConfig = api.getServerConfig();
            assertFinalCapabilities(finalConfig);
            const {
              middlewares,
              routes,
              distDirectory: outputDirectory,
              metaName,
            } = api.getServerContext();
            serverRoutes = routes ?? [];
            distDirectory = outputDirectory ?? '';
            fallbackHeader = `x-${cutNameByHyphen(metaName || 'modern-js')}-ssr-fallback`;
            if (
              !options.resolveDevelopmentSnapshot &&
              (options.assetManifestFile || options.nativeManifestFiles) &&
              !distDirectory
            ) {
              throw new Error(
                'Native asset manifests require an application output directory.',
              );
            }
            for (const route of routes ?? []) {
              // Validate configured headers before any native stream commits.
              for (const [name, value] of Object.entries(
                route.responseHeaders ?? {},
              )) {
                new Headers([[name, String(value)]]);
              }
              if (
                !route.isApi &&
                route.entryName &&
                !entries[route.entryName]
              ) {
                throw new Error(
                  `Native server route has no selected identity: ${route.entryName}.`,
                );
              }
            }
            middlewares.unshift({
              name: 'native-node-rsc-guard',
              order: 'pre',
              handler: async (context: Context, next: Next) =>
                rejectNativeRscRequest(context.req.raw) || next(),
            });
          });
        },
      },
      {
        name: '@modern-js/native-node-dispatch',
        pre: [
          '@modern-js/plugin-inject-render',
          '@modern-js/plugin-inject-resource',
          '@modern-js/plugin-inject-config-middleware',
          '@modern-js/plugin-server-static',
          '@modern-js/plugin-favicon',
        ],
        post: ['@modern-js/plugin-render'],
        setup(api) {
          api.onPrepare(() => {
            const context = api.getServerContext();
            if (
              typeof context.render !== 'function' ||
              context.middlewares.some(
                middleware => middleware.name === 'render',
              )
            ) {
              throw new Error(
                'Native server dispatch was registered outside the admitted render seam.',
              );
            }
            api.updateServerContext({ render: dispatch });
          });
        },
      },
      {
        name: '@modern-js/native-node-terminal-responses',
        pre: ['@modern-js/plugin-render', '@modern-js/native-node-dispatch'],
        setup(api) {
          api.onPrepare(() => {
            const { middlewares } = api.getServerContext();
            // Replace each page handler in place. Its path and preceding
            // per-entry render middleware retain their exact original order.
            for (const middleware of middlewares) {
              if (middleware.name !== 'render') continue;
              middleware.handler = async (context: Context, next: Next) => {
                const route = context.get('route');
                const renderOptions = makeRenderOptions(context);
                // Keep a middleware rewrite (matchEntryName/matchPathname), as
                // the React render does; otherwise render the mounted entry.
                const entryName =
                  renderOptions.matchEntryName ??
                  (renderOptions.matchPathname
                    ? matchNativeServerRoute(
                        serverRoutes,
                        renderOptions.matchPathname,
                      )?.entryName
                    : undefined) ??
                  route?.entryName;
                if (!entryName || !entries[entryName]) return next();
                renderOptions.matchEntryName = entryName;
                return bindContextResponse(
                  context,
                  await dispatch(context.req.raw, renderOptions),
                );
              };
            }
          });
        },
      },
    ],
  };
}

export default nativeServerPlugin;
