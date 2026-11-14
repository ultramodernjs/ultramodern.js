import { fileReader } from '@modern-js/runtime-utils/fileReader';
import type { ServerRoute } from '@modern-js/types';
import { fs } from '@modern-js/utils';
import { getMimeType } from 'hono/utils/mime';
import path from 'path';
import type {
  HonoRequest,
  HtmlNormalizedConfig,
  Middleware,
  OutputNormalizedConfig,
  ServerNormalizedConfig,
  ServerPlugin,
} from '../../../types';
import { sortRoutes } from '../../../utils';
import { getPublicDirPatterns } from '../../../utils/publicDir';
import {
  createHashedAssetMatcher,
  type ResolvedStaticCacheControl,
  resolveStaticCacheControl,
  setStaticFileHeaders,
} from './staticCache';

/** A selected file and the native response conventions to use for it. */
export type StaticAsset = {
  filename: string;
  kind: 'static' | 'public';
  /** An alternate representation retains the original resource's MIME type. */
  mimeFilename?: string;
  responseHeaders?: ServerRoute['responseHeaders'];
  /** Controls whether to include the served byte length. */
  contentLength?: boolean;
  cacheControl?: string;
  /** Disable conditional responses when an extension will rewrite the body. */
  revalidate?: boolean;
  /** Optional lexical containment boundary. Use real paths to contain symlinks. */
  root?: string;
  /** Resolve symlinks before checking root. Implies a regular file is required. */
  realpath?: boolean;
};

export type StaticAssetRequest = { root: string; pathPrefix: string };

/** Native serving of the selected file, optionally choosing another representation. */
export type ServeStaticAsset = (
  representation?: Partial<
    Pick<StaticAsset, 'filename' | 'contentLength' | 'revalidate'>
  >,
) => Promise<Response | null>;

/**
 * Trusted server extension. Undefined uses the native file; null skips it.
 * A returned response is final. Exceptions use the normal server error handler.
 */
export type StaticAssetResponder = (
  context: Parameters<Middleware>[0],
  asset: StaticAsset,
  serve: ServeStaticAsset,
  request: StaticAssetRequest,
) => Response | null | undefined | Promise<Response | null | undefined>;

/**
 * Handles requests outside the native static pattern. The continuation only
 * tries native public routes; it returns null on a miss and never calls the next
 * middleware. Returning null from this hook continues the middleware chain.
 */
export type StaticPublicFallbackResponder = (
  context: Parameters<Middleware>[0],
  respondPublic: () => Promise<Response | null>,
  request: StaticAssetRequest,
) => Response | null | Promise<Response | null>;

// Retained from the native static middleware; extensions need not copy it.
const isPathInside = (target: string, root: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
};

/** Read a selected file using native readers, MIME, headers and body conversion. */
export async function serveStaticAsset(
  context: Parameters<Middleware>[0],
  asset: StaticAsset,
  respond?: (
    asset: StaticAsset,
    serve: ServeStaticAsset,
  ) => Promise<Response | null>,
): Promise<Response | null> {
  let { filename } = asset;
  const { kind } = asset;
  if (asset.root && !isPathInside(filename, asset.root)) {
    return null;
  }
  if (asset.realpath) {
    try {
      const [realFilename, realRoot, stat] = await Promise.all([
        fs.realpath(filename),
        asset.root ? fs.realpath(asset.root) : Promise.resolve(undefined),
        fs.stat(filename),
      ]);
      if (
        !stat.isFile() ||
        (realRoot && !isPathInside(realFilename, realRoot))
      ) {
        return null;
      }
      filename = realFilename;
      asset = { ...asset, filename, root: realRoot };
    } catch {
      return null;
    }
  }
  if (kind === 'static' && !asset.realpath) {
    const stat = await fs.stat(filename).catch(() => null);
    if (!stat?.isFile()) {
      return null;
    }
  }
  if (respond) {
    return respond(asset, representation =>
      serveStaticAsset(context, {
        ...asset,
        ...representation,
        filename: representation?.filename ?? asset.filename,
        mimeFilename: asset.mimeFilename ?? filename,
      }),
    );
  }
  const data =
    kind === 'static'
      ? await fileReader.readFileFromSystem(filename, 'buffer')
      : await fileReader.readFile(filename, 'buffer');
  if (data === null) {
    return null;
  }
  const mimeType = getMimeType(asset.mimeFilename ?? filename);
  if (mimeType) {
    context.header('Content-Type', mimeType);
  }
  Object.entries(asset.responseHeaders || {}).forEach(([key, value]) => {
    context.header(key, value as string);
  });
  const notModified = setStaticFileHeaders(context, data, asset.cacheControl);
  if (notModified && asset.revalidate !== false) {
    return context.body(null, 304);
  }
  if (asset.contentLength ?? kind === 'static') {
    context.header('Content-Length', String(data.byteLength));
  }
  // Hono does not accept Buffer<ArrayBufferLike>; retain native view conversion.
  const body = new Uint8Array(
    data.buffer as ArrayBuffer,
    data.byteOffset,
    data.byteLength,
  );
  return context.body(body, 200);
}

export type ServerStaticPluginOptions = {
  respondAsset?: StaticAssetResponder;
  respondPublicFallback?: StaticPublicFallbackResponder;
};

export const serverStaticPlugin = (
  options: ServerStaticPluginOptions = {},
): ServerPlugin => ({
  name: '@modern-js/plugin-server-static',

  setup(api) {
    api.onPrepare(() => {
      const {
        middlewares,
        distDirectory: pwd,
        routes,
      } = api.getServerContext();

      const config = api.getServerConfig();

      const serverStaticMiddleware = createStaticMiddleware({
        pwd: pwd!,
        routes,
        output: config.output || {},
        html: config.html || {},
        server: config.server || {},
        ...api.getServerContext().staticAssetResponders,
        ...options,
      });

      middlewares.push({
        name: 'server-static',

        handler: serverStaticMiddleware,
      });
    });
  },
});

export type PublicMiddlewareOptions = {
  pwd: string;
  routes: ServerRoute[];
  pathPrefix?: string;
  cacheControl?: ResolvedStaticCacheControl;
} & ServerStaticPluginOptions;

export function createPublicMiddleware({
  pwd,
  routes,
  pathPrefix = '/',
  cacheControl,
  respondAsset,
  respondPublicFallback,
}: PublicMiddlewareOptions): Middleware {
  const publicRoutes = routes
    .filter(route => !route.isSSR && route.entryPath?.startsWith('public'))
    .sort(sortRoutes);

  return async (c, next) => {
    const respondPublic = async (): Promise<Response | null> => {
      const route = matchPublicRoute(c.req, publicRoutes);
      if (!route) {
        return null;
      }
      const asset: StaticAsset = {
        filename: path.join(pwd, route.entryPath),
        kind: 'public',
        cacheControl: cacheControl?.unhashed,
        responseHeaders: route.responseHeaders,
      };
      const serve: ServeStaticAsset = representation =>
        serveStaticAsset(c, {
          ...asset,
          ...representation,
          filename: representation?.filename ?? asset.filename,
          mimeFilename: asset.filename,
        });
      const response = respondAsset
        ? await respondAsset(c, asset, serve, { root: pwd, pathPrefix })
        : undefined;
      return response === undefined ? serve() : response;
    };
    const response = respondPublicFallback
      ? await respondPublicFallback(c, respondPublic, { root: pwd, pathPrefix })
      : await respondPublic();
    return response ?? next();
  };
}

function matchPublicRoute(req: HonoRequest, publicRoutes: ServerRoute[]) {
  return publicRoutes.find(route => req.path.startsWith(route.urlPath));
}

// Remove domain name from assetPrefix if it exists
const extractPathname = (url: string): string => {
  try {
    // Check if the URL contains a protocol
    if (url.includes('://')) {
      return new URL(url).pathname || '/';
    }
    // Handle protocol-relative URLs (starting with //)
    if (url.startsWith('//')) {
      return new URL(`http:${url}`).pathname || '/';
    }
    return url;
  } catch (e) {
    return url;
  }
};

export interface ServerStaticOptions extends ServerStaticPluginOptions {
  pwd: string;
  output: OutputNormalizedConfig;
  html: HtmlNormalizedConfig;
  server: ServerNormalizedConfig;
  routes?: ServerRoute[];
}

/**
 * This middleware is used to serve static assets
 * TODO: In next major version, only serve static assets in the `static` and `upload` directory.
 *
 * 1. In dev mode, the static assets generated by bundler will be served by the rsbuildDevMiddleware, and other file in `static` directory will be served by this middleware.
 * 2. In prod mode, all the static assets in `static` and `upload` directory will be served by this middleware.
 * 3. So some file not in `static` can be access in dev mode, but not in prod mode. Cause we can not serve all files in prod mode, as we should not expose server code in prod mode.
 * 4. Through Modern.js not serve this file in prod mode, you can upload the files to a CDN.
 */
export function createStaticMiddleware(
  options: ServerStaticOptions,
): Middleware {
  const { pwd, routes } = options;
  const cacheControl = resolveStaticCacheControl(
    options.server.staticCacheControl,
  );
  const prefix = options.output.assetPrefix || '/';
  const pathPrefix = extractPathname(prefix);

  const { distPath: { css: cssPath, js: jsPath, media: mediaPath } = {} } =
    options.output;
  const { favicon } = options.html;
  const { publicDir } = options.server;
  const favicons = prepareFavicons(favicon);
  const staticFiles = [cssPath, jsPath, mediaPath].filter(v => Boolean(v));

  // Handle custom publicDir: string | string[]
  // Convert publicDir paths to regex patterns for matching
  // e.g., './locales' or 'locales' -> 'locales/'
  const publicDirPatterns = getPublicDirPatterns(publicDir);
  const isHashedAsset = createHashedAssetMatcher(staticFiles as string[], [
    'public/',
    'upload/',
    ...publicDirPatterns,
  ]);

  // TODO: If possible, we should not use `...staticFiles` here, file should only be read in static and upload dir.
  const staticReg = [
    'static/',
    'upload/',
    ...staticFiles,
    ...publicDirPatterns,
  ];
  // TODO: Also remove iconReg
  const iconReg = ['favicon.ico', 'icon.png', ...favicons];
  const regPrefix = pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`;
  const staticPathRegExp = new RegExp(
    `^${regPrefix}(${[...staticReg, ...iconReg].join('|')})`,
  );

  const publicMiddleware = createPublicMiddleware({
    pwd,
    routes: routes || [],
    pathPrefix,
    cacheControl,
    respondAsset: options.respondAsset,
    respondPublicFallback: options.respondPublicFallback,
  });

  /**
   * The function is modified based on
   * https://github.com/honojs/node-server/blob/main/src/serve-static.ts
   *
   * MIT Licensed
   * https://github.com/honojs/node-server/tree/8cea466fd05e6d2e99c28011fc0e2c2d3f3397c9?tab=readme-ov-file#license
   * */
  return async (c, next) => {
    // If page route hit, we should skip static middleware for performance
    const pageRoute = c.get('route');
    const pathname = c.req.path;
    if (pageRoute && path.extname(pathname) === '') {
      return next();
    }

    // Check if path matches static resource pattern
    const hit = staticPathRegExp.test(pathname);

    // FIXME: shoudn't hit, when cssPath, jsPath, mediaPath as '.'
    if (hit) {
      const relativePath = pathname
        .replace(pathPrefix, () => '')
        .replace(/^\/+/, '');
      const filepath = path.join(pwd, relativePath);
      // Prevent path traversal: `pathname` is user-controlled and may contain
      // `../` sequences (Hono decodes `%2e%2e` in `c.req.path`), which
      // `path.join` resolves. Reject any resolved path that escapes `pwd`.
      if (!isPathInside(filepath, pwd)) {
        return next();
      }
      // Responders only select representations of an existing native asset.
      if (options.respondAsset) {
        const stat = await fs.stat(filepath).catch(() => null);
        if (!stat?.isFile()) {
          return next();
        }
      }
      const asset: StaticAsset = {
        filename: filepath,
        kind: 'static',
        cacheControl:
          cacheControl &&
          (isHashedAsset(relativePath)
            ? cacheControl.hashed
            : cacheControl.unhashed),
      };
      const serve: ServeStaticAsset = representation =>
        serveStaticAsset(c, {
          ...asset,
          ...representation,
          filename: representation?.filename ?? asset.filename,
          mimeFilename: filepath,
        });
      const response = options.respondAsset
        ? await options.respondAsset(c, asset, serve, { root: pwd, pathPrefix })
        : undefined;
      return (response === undefined ? await serve() : response) ?? next();
    } else {
      return publicMiddleware(c, next);
    }
  };
}

const prepareFavicons = (
  favicon?: string | ((o: { entryName: string; value: string }) => string),
) => {
  const faviconNames = [];

  // TODO: handle favicon as function.
  if (favicon && typeof favicon === 'string') {
    faviconNames.push(favicon.substring(favicon.lastIndexOf('/') + 1));
  }
  return faviconNames;
};
