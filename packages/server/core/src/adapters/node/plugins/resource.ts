import { fileReader } from '@modern-js/runtime-utils/fileReader';
import type { Monitors, ServerRoute } from '@modern-js/types';
import {
  compatibleRequire,
  fs,
  isProd,
  LOADABLE_STATS_FILE,
  MAIN_ENTRY_NAME,
  NESTED_ROUTE_SPEC_FILE,
  ROUTE_MANIFEST_FILE,
  SERVER_BUNDLE_DIRECTORY,
} from '@modern-js/utils';
import path from 'path';
import type {
  Middleware,
  MiddlewareHandler,
  ServerEnv,
  ServerManifest,
  ServerPlugin,
} from '../../../types';
import { uniqueKeyByRoute } from '../../../utils';

/** A server bundle import that is about to start. */
export type RenderBundleLoad = {
  filepath: string;
  /** The request that triggered the import; absent during production warmup. */
  requestPath?: string;
};

/** Render resource loading, configured by trusted server plugins during setup. */
export type ServerRenderResourceOptions = {
  /**
   * Production only. `eager` (default) imports server bundles while preparing
   * and injects them before every middleware. `lazy` injects them with the
   * render middlewares and imports them once, on the first render request.
   */
  loading?: 'eager' | 'lazy';
  /**
   * Called before each bundle import. The returned callback receives its
   * outcome; it is not called when an optional bundle turns out to be absent.
   */
  onBundleLoad?: (
    bundle: RenderBundleLoad,
  ) => ((outcome: 'loaded' | 'failed') => void) | undefined;
};

type ResourceInjection = Pick<ServerRenderResourceOptions, 'onBundleLoad'> & {
  /** Share the first request's load with every later request. */
  lazy?: boolean;
};

export async function getHtmlTemplates(pwd: string, routes: ServerRoute[]) {
  // Only process routes with entryName, which are HTML template routes.
  // Public static file routes don't have entryName and shouldn't be processed here.
  const htmlRoutes = routes.filter(route => route.entryName);

  const htmls = await Promise.all(
    htmlRoutes.map(async route => {
      let html: string | undefined;
      try {
        const htmlPath = path.join(pwd, route.entryPath);
        html = (await fileReader.readFile(htmlPath, 'utf-8'))?.toString();
      } catch (e) {
        // ignore error
      }
      return [uniqueKeyByRoute(route), html];
    }) || [],
  );

  const templates: Record<string, string> = Object.fromEntries(htmls);

  return templates;
}

export function injectTemplates(
  pwd: string,
  routes?: ServerRoute[],
  htmlTemplatePromise?: ReturnType<typeof getHtmlTemplates>,
  { lazy = false }: ResourceInjection = {},
): Middleware<ServerEnv> {
  return async (c, next) => {
    if (routes && !c.get('templates')) {
      if (lazy) {
        htmlTemplatePromise ||= getHtmlTemplates(pwd, routes);
      }
      const templates = await (htmlTemplatePromise ||
        getHtmlTemplates(pwd, routes));
      c.set('templates', templates);
    }

    await next();
  };
}

function reportBundleError(
  filepath: string,
  error: unknown,
  monitors?: Monitors,
) {
  const detail = error instanceof Error ? error.stack || error.message : error;
  if (monitors) {
    monitors.error(`Load ${filepath} bundle failed, error = %s`, detail);
  } else {
    console.error(`Load ${filepath} bundle failed, error = ${detail}`);
  }
}

const loadBundle = async (
  filepath: string,
  monitors?: Monitors,
  { required = false, failOnError = false } = {},
  onLoad?: () => ((outcome: 'loaded' | 'failed') => void) | undefined,
) => {
  // Required bundles go through the module loader even when absent, preserving
  // its original error code, message and stack. Optional bundles may be absent.
  if (!required && !failOnError && !(await fs.pathExists(filepath))) {
    return undefined;
  }

  let done: ((outcome: 'loaded' | 'failed') => void) | undefined;
  let module: any;
  try {
    done = onLoad?.();
    if (!required && failOnError) {
      try {
        await fs.access(filepath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return undefined;
        }
        // pathExists also returns false for access errors. In strict warmup,
        // only actual absence is optional, not permissions or other I/O errors.
        throw e;
      }
    }
    module = await compatibleRequire(filepath, false);
  } catch (e) {
    done?.('failed');
    reportBundleError(filepath, e, monitors);
    if (failOnError) {
      throw e;
    }
    return undefined;
  }
  done?.('loaded');
  return module;
};

export async function getServerManifest(
  pwd: string,
  routes: ServerRoute[],
  monitors?: Monitors,
  {
    failOnError = false,
    onBundleLoad,
    requestPath,
  }: {
    failOnError?: boolean;
    requestPath?: string;
  } & Pick<ServerRenderResourceOptions, 'onBundleLoad'> = {},
): Promise<ServerManifest> {
  const loaderBundles: Record<string, any> = {};
  const renderBundles: Record<string, any> = {};

  await Promise.all(
    routes
      .filter(route => Boolean(route.bundle))
      .map(async route => {
        // SSG can attach a bundle path even to static-file routes. A declared
        // path alone does not make that route a required SSR render entry.
        const failOnBundleError = failOnError && Boolean(route.isSSR);
        const entryName = route.entryName || MAIN_ENTRY_NAME;
        const renderBundlePath = path.join(pwd, route.bundle || '');
        const loaderBundlePath = path.join(
          pwd,
          SERVER_BUNDLE_DIRECTORY,
          `${entryName}-server-loaders.js`,
        );

        const renderBundle = await loadBundle(
          renderBundlePath,
          monitors,
          { required: failOnBundleError, failOnError: failOnBundleError },
          onBundleLoad &&
            (() => onBundleLoad({ filepath: renderBundlePath, requestPath })),
        );
        const loaderBundle = await loadBundle(
          loaderBundlePath,
          monitors,
          { failOnError: failOnBundleError },
          onBundleLoad &&
            (() => onBundleLoad({ filepath: loaderBundlePath, requestPath })),
        );

        renderBundle && (renderBundles[entryName] = renderBundle);
        if (loaderBundle) {
          try {
            loaderBundles[entryName] = loaderBundle.loadModules
              ? await loaderBundle.loadModules()
              : loaderBundle;
          } catch (e) {
            if (failOnBundleError) {
              reportBundleError(loaderBundlePath, e, monitors);
            }
            throw e;
          }
        }
      }),
  );

  const loadableUri = path.join(pwd, LOADABLE_STATS_FILE);

  const loadableStats = await compatibleRequire(loadableUri).catch(_ => ({}));

  const routesManifestUri = path.join(pwd, ROUTE_MANIFEST_FILE);

  const routeManifest = await compatibleRequire(routesManifestUri).catch(
    _ => ({}),
  );

  const nestedRoutesJsonPath = path.join(pwd, NESTED_ROUTE_SPEC_FILE);

  const nestedRoutesJson = await compatibleRequire(nestedRoutesJsonPath).catch(
    _ => ({}),
  );

  return {
    loaderBundles,
    renderBundles,
    loadableStats,
    routeManifest,
    nestedRoutesJson,
  };
}

export function injectServerManifest(
  pwd: string,
  routes?: ServerRoute[],
  manifestPromise?: Promise<ServerManifest>,
  { lazy = false, onBundleLoad }: ResourceInjection = {},
): Middleware<ServerEnv> {
  return async (c, next) => {
    if (routes && !c.get('serverManifest')) {
      const monitors = c.get('monitors');
      const load = () =>
        getServerManifest(pwd, routes, monitors, {
          onBundleLoad,
          requestPath: c.req.path,
        });
      if (lazy) {
        manifestPromise ||= load();
      }
      const serverManifest = await (manifestPromise || load());

      c.set('serverManifest', serverManifest);
    }

    await next();
  };
}

export async function getRscServerManifest(pwd: string) {
  const rscServerManifest = await compatibleRequire(
    path.join(pwd, 'bundles', 'react-server-manifest.json'),
  ).catch(_ => undefined);
  return rscServerManifest;
}

export async function getClientManifest(pwd: string) {
  const rscClientManifest = await compatibleRequire(
    path.join(pwd, 'react-client-manifest.json'),
  ).catch(_ => undefined);
  return rscClientManifest;
}

export async function getRscSSRManifest(pwd: string) {
  const rscSSRManifest = await compatibleRequire(
    path.join(pwd, 'react-ssr-manifest.json'),
  ).catch(_ => undefined);
  return rscSSRManifest;
}

export const injectRscManifestPlugin = (enableRsc: boolean): ServerPlugin => ({
  name: '@modern-js/plugin-inject-rsc-manifest',
  setup(api) {
    api.onPrepare(() => {
      const { middlewares, distDirectory: pwd } = api.getServerContext();
      // only rsc project need inject rsc manifest
      if (!enableRsc) {
        return;
      }

      // TODO: should inject in prepare stage, not first request
      middlewares.push({
        name: 'inject-rsc-manifest',
        handler: (async (c, next) => {
          if (!c.get('rscServerManifest')) {
            const rscServerManifest = await getRscServerManifest(pwd!);
            c.set('rscServerManifest', rscServerManifest);
          }

          if (!c.get('rscClientManifest')) {
            const rscClientManifest = await getClientManifest(pwd!);
            c.set('rscClientManifest', rscClientManifest);
          }

          if (!c.get('rscSSRManifest')) {
            const rscSSRManifest = await getRscSSRManifest(pwd!);
            c.set('rscSSRManifest', rscSSRManifest);
          }

          await next();
        }) as MiddlewareHandler,
      });
    });
  },
});

export const injectResourcePlugin = (): ServerPlugin => ({
  name: '@modern-js/plugin-inject-resource',

  setup(api) {
    api.onPrepare(async () => {
      const {
        middlewares,
        renderMiddlewares,
        routes,
        distDirectory: pwd,
        renderResources: { loading, onBundleLoad } = {},
      } = api.getServerContext();
      const lazy = isProd() && loading === 'lazy';

      // In Production, should warmup server bundles on prepare.
      let htmlTemplatePromise: ReturnType<typeof getHtmlTemplates> | undefined;
      let manifestPromise: Promise<ServerManifest> | undefined;

      if (isProd() && !lazy) {
        const warmupRoutes = routes || [];
        // Keep CSR-only and RSC startup behavior unchanged. Only await the
        // existing classic SSR warmup; do not eagerly import lazy route modules.
        const failOnError =
          warmupRoutes.some(route => route.isSSR && route.bundle) &&
          !warmupRoutes.some(route => route.isRSC);
        manifestPromise = getServerManifest(pwd!, warmupRoutes, undefined, {
          failOnError,
          onBundleLoad,
        });
        htmlTemplatePromise = getHtmlTemplates(pwd!, routes || []);
        if (failOnError) {
          await manifestPromise;
        }
      }

      // Render middlewares are mounted only on page routes, after BFF and static.
      const resourceMiddlewares = lazy ? renderMiddlewares : middlewares;
      resourceMiddlewares.push({
        name: 'inject-server-manifest',

        handler: injectServerManifest(pwd!, routes, manifestPromise, {
          lazy,
          onBundleLoad,
        }),
      });

      resourceMiddlewares.push({
        name: 'inject-html',

        handler: injectTemplates(pwd!, routes, htmlTemplatePromise, { lazy }),
      });
    });
  },
});
