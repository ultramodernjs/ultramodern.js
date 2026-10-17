async function loadWorkerModule(workerPath) {
  const loader = WORKER_MODULE_LOADERS[workerPath];

  if (!loader) {
    return undefined;
  }

  if (!workerModulePromises.has(workerPath)) {
    workerModulePromises.set(workerPath, loader());
  }

  return workerModulePromises.get(workerPath);
}

function createWorkerRendererGuardResponse(request) {
  const deliveryUnit = MODERN_WORKER_MANIFEST.deliveryUnit;
  const surfaces = deliveryUnit?.surfaces;
  // API identity is universal. Only an explicit UI surface selects a renderer.
  if (!surfaces || !Object.hasOwn(surfaces, 'ui')) {
    return undefined;
  }

  const ui = surfaces.ui;
  const identity = ui?.rendererIdentity;
  const profile = ui?.rendererProfile;
  // The built renderer's adapter decides whether documents are native.
  const builtRenderer = MODERN_WORKER_MANIFEST.renderer;
  const isNative =
    builtRenderer?.nativeDocuments === true &&
    [identity?.renderer, profile?.renderer].includes(builtRenderer.name);
  if (
    isNative &&
    (request.headers.has('x-rsc-tree') || request.headers.has('x-rsc-action'))
  ) {
    return Response.json(
      { code: 'unsupported-renderer-capability', capability: 'rsc' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const isRecord = value =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const isCanonicalString = value =>
    typeof value === 'string' && value.length > 0 && value.trim() === value;
  const hasExactFields = (value, fields) =>
    isRecord(value) &&
    Object.keys(value).every(field => fields.includes(field)) &&
    fields.every(field => Object.hasOwn(value, field));
  const exactVersion =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
  const isPackageIdentity = (value, router = false, hydration = false) => {
    const fields = router
      ? ['name', 'version', 'coreName', 'coreVersion']
      : ['name', 'version'];
    return (
      hasExactFields(value, fields) &&
      isCanonicalString(value.name) &&
      (!router || isCanonicalString(value.coreName)) &&
      (router ? ['version', 'coreVersion'] : ['version']).every(
        field =>
          isCanonicalString(value[field]) &&
          (exactVersion.test(value[field]) ||
            (hydration && /^[1-9]\d*$/u.test(value[field]))),
      )
    );
  };
  const validMetadata =
    isRecord(ui) &&
    ui.surface === 'ui' &&
    hasExactFields(identity, [
      'renderer',
      'appId',
      'entryName',
      'protocolVersion',
      'buildId',
    ]) &&
    identity.renderer === builtRenderer?.name &&
    identity.protocolVersion === 1 &&
    ['appId', 'entryName', 'buildId'].every(field =>
      isCanonicalString(identity[field]),
    ) &&
    identity.appId === ui.appId &&
    ui.appId === deliveryUnit.appId &&
    identity.buildId === ui.buildMarker &&
    ui.buildMarker === deliveryUnit.buildMarker &&
    hasExactFields(profile, [
      'renderer',
      'protocolVersion',
      'compiler',
      'hydration',
      'router',
    ]) &&
    profile.renderer === identity.renderer &&
    profile.protocolVersion === identity.protocolVersion &&
    isPackageIdentity(profile.compiler) &&
    isPackageIdentity(profile.hydration, false, true) &&
    isPackageIdentity(profile.router, true);

  if (!validMetadata) {
    return Response.json(
      { code: 'invalid-renderer-metadata' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (isNative && !hasNativeWorkerRenderer(identity.renderer)) {
    return Response.json(
      {
        code: 'unsupported-renderer-capability',
        capability: 'cloudflare-worker',
        renderer: identity.renderer,
      },
      { status: 501, headers: { 'cache-control': 'no-store' } },
    );
  }
  return undefined;
}

function getRuntimeModule(workerModule) {
  const defaultExport = workerModule.default;
  const nestedDefaultExport =
    defaultExport && typeof defaultExport === 'object'
      ? defaultExport.default
      : undefined;

  return defaultExport && typeof defaultExport === 'object'
    ? {
        ...workerModule,
        ...defaultExport,
        ...(nestedDefaultExport && typeof nestedDefaultExport === 'object'
          ? nestedDefaultExport
          : {}),
      }
    : workerModule;
}

function getFetchHandler(workerModule) {
  const defaultExport = workerModule.default;
  const runtime = getRuntimeModule(workerModule);

  return (
    (typeof runtime.fetch === 'function' && runtime.fetch.bind(runtime)) ||
    (typeof defaultExport === 'function' &&
      defaultExport.fetch?.bind?.(defaultExport))
  );
}

async function getRequestHandler(workerModule) {
  const defaultExport = workerModule.default;
  const runtime = getRuntimeModule(workerModule);

  return (
    (await workerModule.requestHandler) ||
    (await runtime.requestHandler) ||
    (typeof defaultExport === 'function' ? defaultExport : undefined)
  );
}

function hasNativeWorkerRenderer(renderer) {
  return MODERN_WORKER_MANIFEST.nativeRenderer?.renderer === renderer;
}

function getNativeRouteIdentity(route) {
  const identities = MODERN_WORKER_MANIFEST.rendererIdentities;
  const identity =
    identities && Object.hasOwn(identities, route.entryName)
      ? identities[route.entryName]
      : undefined;
  // The built native-document renderer, or one that shipped native resources.
  const builtRenderer = MODERN_WORKER_MANIFEST.renderer;
  return identity &&
    ((builtRenderer?.nativeDocuments === true &&
      identity.renderer === builtRenderer.name) ||
      hasNativeWorkerRenderer(identity.renderer))
    ? identity
    : undefined;
}

const ROUTE_DATA_REQUEST_PARAM = '__loader';

// Route data requests (`?__loader=`) are answered by the entry's route data
// worker, like the Node server's data handler. Without a match the request
// falls through to page rendering, as it does on Node.
async function dispatchRouteDataRequest(route, request) {
  const routeDataWorkerPath = route.routeDataWorker;
  // Native entries answer their own data protocol through the native
  // dispatcher; the legacy route-data worker speaks the React encoding.
  if (
    !routeDataWorkerPath ||
    getNativeRouteIdentity(route) ||
    !new URL(request.url).searchParams.has(ROUTE_DATA_REQUEST_PARAM)
  ) {
    return undefined;
  }

  const routeDataWorkerModule = await loadWorkerModule(routeDataWorkerPath);
  const handleRouteDataRequest = routeDataWorkerModule
    ? getRuntimeModule(routeDataWorkerModule).handleRouteDataRequest
    : undefined;

  if (typeof handleRouteDataRequest !== 'function') {
    return new Response(
      `Route data worker bundle has no handleRouteDataRequest export: ${routeDataWorkerPath}`,
      {
        status: 500,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-modern-js-route-data-worker': routeDataWorkerPath,
        },
      },
    );
  }

  return handleRouteDataRequest({
    request,
    serverRoutes: MODERN_WORKER_MANIFEST.routeSpec.routes,
    context: {
      loaderContext: new Map(),
      monitors: createNoopMonitors(),
      reporter: {
        reportTiming: () => {},
      },
    },
    onTiming() {},
  });
}

async function dispatchRouteWorker(route, request, env, ctx) {
  const rendererRejection = createWorkerRendererGuardResponse(request);
  if (rendererRejection) return rendererRejection;

  const nativeIdentity = getNativeRouteIdentity(route);
  return withWorkerRendererIdentity(
    nativeIdentity
      ? applyRouteResponseHeaders(
          await invokeNativeRouteWorker(
            route,
            nativeIdentity,
            request,
            env,
            ctx,
          ),
          route,
        )
      : await invokeRouteWorker(route, request, env, ctx),
    route,
  );
}

const CUMULATIVE_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'link',
  'server-timing',
  'set-cookie',
]);

/**
 * Merge a route's configured `responseHeaders` into a native response, as the
 * Node host does: CSP, Link, Server-Timing and cookies append, `Vary` unions, the
 * renderer's Content-Type stays, and other fields take the configured value.
 */
function applyRouteResponseHeaders(response, route) {
  const configured = Object.entries(route.responseHeaders ?? {});
  if (configured.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [rawName, rawValue] of configured) {
    const name = rawName.toLowerCase();
    const value = String(rawValue);
    // The renderer owns its body framing and content coding.
    if (
      name === 'content-length' ||
      name === 'transfer-encoding' ||
      name === 'content-encoding'
    )
      continue;
    if (CUMULATIVE_RESPONSE_HEADERS.has(name)) headers.append(name, value);
    else if (name === 'vary') {
      const fields = new Map();
      for (const field of `${headers.get('vary') ?? ''},${value}`.split(',')) {
        const item = field.trim();
        if (item && !fields.has(item.toLowerCase()))
          fields.set(item.toLowerCase(), item);
      }
      headers.set('vary', [...fields.values()].join(', '));
    } else if (name !== 'content-type' || !headers.has(name))
      headers.set(name, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function createWorkerRendererErrorResponse(code, entryName) {
  return Response.json(
    { code, entryName: String(entryName) },
    { status: 500, headers: { 'cache-control': 'no-store' } },
  );
}

// Native-document renderers bundle their server handler with the renderer-core
// worker dispatcher. Build-validated document inputs come from the manifest.
async function invokeNativeRouteWorker(route, identity, request, env, ctx) {
  const nativeRenderer = MODERN_WORKER_MANIFEST.nativeRenderer;
  const resources =
    nativeRenderer?.renderer === identity.renderer &&
    Object.hasOwn(nativeRenderer.entries, route.entryName)
      ? {
          ...nativeRenderer.entries[route.entryName],
          ...(Object.hasOwn(nativeRenderer, 'workerFederation')
            ? { workerFederation: nativeRenderer.workerFederation }
            : {}),
          ...(Object.hasOwn(nativeRenderer, 'workerFederationManifestUrl')
            ? {
                workerFederationManifestUrl:
                  nativeRenderer.workerFederationManifestUrl,
              }
            : {}),
          ...(Object.hasOwn(nativeRenderer, 'workerFederationServices')
            ? {
                workerFederationServices:
                  nativeRenderer.workerFederationServices,
              }
            : {}),
        }
      : undefined;
  // Native renderers have no Flight transport. Reject before the bundle loads.
  if (
    request.headers.has('x-rsc-tree') ||
    request.headers.has('x-rsc-action')
  ) {
    return Response.json(
      { code: 'unsupported-renderer-capability', capability: 'rsc' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!resources) {
    return createWorkerRendererErrorResponse(
      'missing-native-renderer-resources',
      route.entryName,
    );
  }
  try {
    const workerModule = route.worker
      ? await loadWorkerModule(route.worker)
      : undefined;
    if (
      !workerModule ||
      typeof workerModule.dispatchNativeWorkerRequest !== 'function'
    ) {
      return createWorkerRendererErrorResponse(
        'missing-native-worker-bundle',
        route.entryName,
      );
    }
    return await workerModule.dispatchNativeWorkerRequest(request, {
      identity,
      bundle: workerModule,
      resources,
      bindings: env,
      executionContext: ctx,
    });
  } catch (error) {
    // A bundle evaluation or pre-commit native failure must not escape fetch.
    console.error(error);
    return createWorkerRendererErrorResponse(
      'native-render-failed',
      route.entryName,
    );
  }
}

/**
 * The Node host's ASCII-only identity header bytes: fixed field order and
 * non-ASCII code units escaped, since Fetch header values are ByteStrings.
 */
function serializeRendererIdentityHeader(identity) {
  return JSON.stringify({
    renderer: identity.renderer,
    appId: identity.appId,
    entryName: identity.entryName,
    protocolVersion: identity.protocolVersion,
    buildId: identity.buildId,
  }).replace(/[\u007f-\u{10ffff}]/gu, character =>
    Array.from(
      { length: character.length },
      (_, index) =>
        `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`,
    ).join(''),
  );
}

function withWorkerRendererIdentity(response, route) {
  const identities = MODERN_WORKER_MANIFEST.rendererIdentities;
  if (!identities) return response;
  if (!Object.hasOwn(identities, route.entryName)) {
    // Do not let a manifest/route mismatch escape fetch and fail the isolate.
    response.body?.cancel().catch(() => {});
    return createWorkerRendererErrorResponse(
      'missing-renderer-identity',
      route.entryName,
    );
  }
  const headers = new Headers(response.headers);
  headers.set(
    'x-ultramodern-renderer-identity',
    serializeRendererIdentityHeader(identities[route.entryName]),
  );
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function invokeRouteWorker(route, request, env, ctx) {
  const workerPath = route.worker;
  if (!workerPath) {
    return new Response('Worker bundle not configured for SSR route', {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  const workerModule = await loadWorkerModule(workerPath);

  if (!workerModule) {
    return new Response(`Worker bundle not found: ${workerPath}`, {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-modern-js-route-worker': workerPath,
      },
    });
  }

  const fetchHandler = getFetchHandler(workerModule);

  if (fetchHandler) {
    return fetchHandler(request, env, ctx);
  }

  const runtime = getRuntimeModule(workerModule);
  // Match the native server dispatcher: actions precede Flight trees, and
  // neither path may fall back to HTML rendering or rewrite the Request body.
  if (request.headers.get('x-rsc-action')) {
    const handleAction = await runtime.handleAction;
    if (typeof handleAction !== 'function') {
      return new Response('Cannot find server action handler', { status: 500 });
    }
    return handleAction(request);
  }

  if (request.headers.get('x-rsc-tree')) {
    const rscPayloadHandler = await runtime.rscPayloadHandler;
    if (typeof rscPayloadHandler !== 'function') {
      return new Response('Cannot find request handler for RSC', {
        status: 500,
      });
    }
    return rscPayloadHandler(
      request,
      await getRequestHandlerOptions(route, request, env, ctx, false),
    );
  }

  const requestHandler = await getRequestHandler(workerModule);

  if (typeof requestHandler === 'function') {
    const requestHandlerOptions = await getRequestHandlerOptions(
      route,
      request,
      env,
      ctx,
    );

    return withRouteCssLinks(
      await requestHandler(request, requestHandlerOptions),
      route,
      requestHandlerOptions.resource.routeManifest,
      request,
      env,
      undefined,
      requestHandlerOptions.locals[DISTRIBUTED_SSR_FRAGMENTS_LOCALS_KEY],
    );
  }

  return new Response(
    `Worker bundle has no fetch or requestHandler export: ${workerPath}`,
    {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-modern-js-route-worker': workerPath,
      },
    },
  );
}

// Worker Static Assets decode percent-encoded paths, so an encoded spelling
// of a mounted prefix (`/%70refix/...`, `/prefix%2F...`) would otherwise skip
// the BFF or service binding that owns the prefix and reach ASSETS directly.
// Resolve such spellings to the canonical pathname the owner sees; a
// backslash or undecodable spelling becomes a path the owner rejects.
function resolvePrefixPathname(pathname, prefix) {
  if (!prefix || prefix === '/') {
    return pathname;
  }

  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  let candidate = pathname;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (candidate === normalized || candidate.startsWith(`${normalized}/`)) {
      return candidate;
    }
    if (candidate.startsWith(`${normalized}\\`)) {
      return `${normalized}/__invalid_encoded_path__`;
    }

    let decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return candidate.toLowerCase().startsWith(normalized.toLowerCase())
        ? `${normalized}/__invalid_encoded_path__`
        : null;
    }
    if (decoded === candidate) {
      return null;
    }
    candidate = decoded;
  }

  return null;
}

function matchesPrefix(pathname, prefix) {
  return resolvePrefixPathname(pathname, prefix) !== null;
}

function createRequestForMountedPrefix(request, prefix) {
  if (!prefix || prefix === '/') {
    return request;
  }

  const url = new URL(request.url);
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const matchedPathname = resolvePrefixPathname(url.pathname, normalized);

  if (matchedPathname === null) {
    return request;
  }

  const nextPath = matchedPathname.slice(normalized.length) || '/';
  url.pathname = nextPath.startsWith('/') ? nextPath : `/${nextPath}`;

  return new Request(url, request);
}

function createEffectBffDispatcherErrorResponse(bff, error) {
  return new Response(
    `Effect BFF dispatcher initialization failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-modern-js-bff-dispatcher': String(bff.dispatcherExport || ''),
        'x-modern-js-bff-worker': bff.worker,
      },
    },
  );
}

// workerd binds every I/O object (sockets, timers, pending promises) to the request that
// created it, so an Effect runtime built while serving one request cannot serve the next: a
// pooled PostgreSQL connection or a cached in-flight effect from an earlier request never
// completes. Each BFF request therefore builds its own dispatcher and disposes it once the
// response body has been delivered; platform pools such as Hyperdrive keep connections warm.
async function createEffectBffDispatcher(bff, runtime) {
  if (
    typeof bff.dispatcherExport !== 'string' ||
    bff.dispatcherExport.length === 0
  ) {
    throw new Error('manifest does not declare dispatcherExport');
  }

  const effectDispatcherFactory = runtime[bff.dispatcherExport];

  if (typeof effectDispatcherFactory !== 'function') {
    throw new Error(`worker bundle does not export ${bff.dispatcherExport}`);
  }

  const effectConfig = bff.effect;
  if (
    !effectConfig ||
    typeof effectConfig !== 'object' ||
    Array.isArray(effectConfig)
  ) {
    throw new Error('manifest declares invalid Effect BFF runtime config');
  }
  const crossProjectPolicy = effectConfig.crossProjectPolicy;
  if (
    !crossProjectPolicy ||
    typeof crossProjectPolicy !== 'object' ||
    Array.isArray(crossProjectPolicy)
  ) {
    throw new Error(
      'manifest declares invalid Effect BFF cross-project policy',
    );
  }
  for (const field of [
    'enabled',
    'requireEnvelope',
    'requireOperationContext',
    'requireOperationContextDetails',
    'requireOperationSchemaHash',
    'requireOperationVersion',
    'allowUnknownOperations',
  ]) {
    if (typeof crossProjectPolicy[field] !== 'boolean') {
      throw new Error(
        `manifest Effect BFF cross-project policy requires boolean ${field}`,
      );
    }
  }
  if (
    !crossProjectPolicy.expectedOperationContracts ||
    typeof crossProjectPolicy.expectedOperationContracts !== 'object' ||
    Array.isArray(crossProjectPolicy.expectedOperationContracts)
  ) {
    throw new Error(
      'manifest Effect BFF cross-project policy requires expectedOperationContracts object',
    );
  }

  const effectDispatcher = await effectDispatcherFactory({
    prefix: bff.prefix,
    ...(effectConfig?.openapi === undefined
      ? {}
      : { openapi: effectConfig.openapi }),
    ...(effectConfig?.dataPlatform === undefined
      ? {}
      : { dataPlatform: effectConfig.dataPlatform }),
    ...(effectConfig?.crossProjectPolicy === undefined
      ? {}
      : { crossProjectPolicy }),
  });

  if (!effectDispatcher || typeof effectDispatcher.dispatch !== 'function') {
    try {
      await effectDispatcher?.dispose?.();
    } catch {}

    throw new Error(
      `worker export ${bff.dispatcherExport} did not return a dispatcher with a dispatch function`,
    );
  }

  return effectDispatcher;
}

function disposeEffectBffDispatcherAfterResponse(response, dispatcher, ctx) {
  if (response.body === null) {
    ctx.waitUntil(dispatcher.dispose());
    return response;
  }
  const { readable, writable } = new TransformStream();
  // The body pipe settles when the client has the whole body or the stream failed; a failure
  // already reached the client through `readable`, so it only has to release the runtime here.
  ctx.waitUntil(
    response.body
      .pipeTo(writable)
      .catch(() => undefined)
      .then(() => dispatcher.dispose()),
  );
  return new Response(readable, response);
}

async function dispatchBffRequest(request, env, ctx) {
  const rendererRejection = createWorkerRendererGuardResponse(request);
  if (rendererRejection) return rendererRejection;
  const bff = MODERN_WORKER_MANIFEST.bff;

  const requestUrl = new URL(request.url);
  const matchedPathname = resolvePrefixPathname(
    requestUrl.pathname,
    bff?.prefix,
  );
  if (!bff?.worker || matchedPathname === null) {
    return null;
  }
  const canonicalRequest =
    matchedPathname === requestUrl.pathname
      ? request
      : new Request(
          Object.assign(requestUrl, { pathname: matchedPathname }),
          request,
        );
  if (bff.runtimeFramework !== 'effect') {
    return createEffectBffDispatcherErrorResponse(
      bff,
      new Error('manifest must declare runtimeFramework "effect"'),
    );
  }

  const workerModule = await loadWorkerModule(bff.worker);

  if (!workerModule) {
    return new Response(`BFF worker bundle not found: ${bff.worker}`, {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-modern-js-bff-worker': bff.worker,
      },
    });
  }

  const mountedRequest = createRequestForMountedPrefix(request, bff.prefix);
  const defaultExport = workerModule.default;
  const runtime = getRuntimeModule(workerModule);

  if (bff.runtimeFramework === 'effect') {
    let effectDispatcher;

    try {
      effectDispatcher = await createEffectBffDispatcher(bff, runtime);
    } catch (error) {
      return createEffectBffDispatcherErrorResponse(bff, error);
    }

    let response;
    try {
      response = await effectDispatcher.dispatch(canonicalRequest, { env });
    } catch (error) {
      ctx.waitUntil(effectDispatcher.dispose());
      throw error;
    }
    return disposeEffectBffDispatcherAfterResponse(
      response,
      effectDispatcher,
      ctx,
    );
  }

  const directHandler =
    (typeof runtime.handler === 'function' && runtime.handler) ||
    (typeof defaultExport === 'function' && defaultExport);
  const createdHandler =
    typeof runtime.createHandler === 'function'
      ? runtime.createHandler().handler
      : undefined;
  const handler = directHandler || createdHandler;

  if (typeof handler !== 'function') {
    return new Response(
      `BFF worker bundle has no handler export: ${bff.worker}`,
      {
        status: 500,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-modern-js-bff-worker': bff.worker,
        },
      },
    );
  }

  const effectContext = {
    request: mountedRequest,
    env: env || {},
    path: new URL(request.url).pathname,
    method: request.method,
    operationContext: {
      request: mountedRequest,
      env: env || {},
      path: new URL(request.url).pathname,
      method: request.method,
    },
  };

  return handler(mountedRequest, effectContext);
}

const MICROVERTICAL_SERVER_FALLBACK_EVENT =
  'modernjs:microvertical-server-fallback';

// Typed degraded event for an unavailable service binding. Mirrors the shape
// of the runtime MF fallback telemetry payload (schemaVersion 1) under the
// server-side event name, so shell-level consumers see one degraded contract
// across platforms.
function createServiceBindingDegradedEvent(binding, pathname) {
  return {
    appName: 'modern-js-cloudflare-worker',
    eventName: MICROVERTICAL_SERVER_FALLBACK_EVENT,
    phase: 'discovery',
    reason: 'remote-unavailable',
    schemaVersion: 1,
    metadata: {
      classification: 'remote-unavailable',
      pathname,
      platform: 'cloudflare-service-binding',
      prefix: binding.prefix,
      remote: binding.binding,
      serviceBinding: binding.binding,
      status: 'degraded',
    },
  };
}

async function dispatchServiceBindingRequest(request, env) {
  const serviceBindings = MODERN_WORKER_MANIFEST.serviceBindings;

  if (!Array.isArray(serviceBindings) || serviceBindings.length === 0) {
    return null;
  }

  const pathname = new URL(request.url).pathname;

  for (const binding of serviceBindings) {
    if (!binding?.binding || !binding?.prefix) {
      continue;
    }

    if (!matchesPrefix(pathname, binding.prefix)) {
      continue;
    }

    const service = env?.[binding.binding];

    if (!service || typeof service.fetch !== 'function') {
      const degradedEvent = createServiceBindingDegradedEvent(
        binding,
        pathname,
      );

      // Telemetry emission: workers surface structured logs via tail/analytics.
      // The degraded path must never fail because a log sink did.
      try {
        console.error(JSON.stringify(degradedEvent));
      } catch {}

      return new Response(
        `Cloudflare service binding not available: ${binding.binding}`,
        {
          status: 502,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'x-modern-js-service-binding': binding.binding,
            'x-modern-js-degraded': degradedEvent.metadata.classification,
            'x-modern-js-telemetry-event': degradedEvent.eventName,
          },
        },
      );
    }

    return service.fetch(request);
  }

  return null;
}
