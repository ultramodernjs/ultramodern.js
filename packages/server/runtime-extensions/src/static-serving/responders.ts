import path from 'node:path';
import type { Middleware } from '@modern-js/server-core';
import {
  type ServerStaticPluginOptions,
  type ServeStaticAsset,
  type StaticAsset,
  serveStaticAsset,
} from '@modern-js/server-core/node';
import {
  applyModuleFederationAssetHeaders,
  getModuleFederationAssetList,
  getModuleFederationRequestPath,
  isBackendModuleFederationManifestRequest,
  isModuleFederationManifestRequest,
  type ModuleFederationServeAssets,
  patchModuleFederationManifestPublicPath,
  patchModuleFederationRemoteEntryPublicPath,
} from './staticModuleFederation';
import {
  applyPreCompressedAssetHeaders,
  resolvePreCompressedAsset,
} from './staticPrecompressed';

type Context = Parameters<Middleware>[0];

async function respondPrecompressedAsset(
  context: Context,
  asset: StaticAsset,
  serve: ServeStaticAsset,
) {
  const selected = await resolvePreCompressedAsset(context, asset.filename);
  const response = selected.acceptable
    ? await serve({
        filename: selected.selected?.filepath,
        contentLength: true,
      })
    : new Response(null, { status: 406 });
  if (response === null) {
    return null;
  }
  context.res = response;
  applyPreCompressedAssetHeaders(context, selected);
  if (path.extname(asset.filename).toLowerCase() === '.cjs') {
    context.res.headers.set('Content-Type', 'text/javascript; charset=UTF-8');
  }
  return context.res;
}

// Native core owns readers, containment and response conversion.
// This extension owns federation and compressed/generated asset selection.
export function createStaticExtensionResponders(): ServerStaticPluginOptions {
  const caches = new Map<
    string,
    {
      assets: ModuleFederationServeAssets | null;
      expires: number;
      pending: Promise<ModuleFederationServeAssets> | null;
    }
  >();
  const getAssets = (root: string) => {
    let cache = caches.get(root);
    if (!cache) {
      cache = { assets: null, expires: 0, pending: null };
      caches.set(root, cache);
    }
    if (cache.assets && Date.now() < cache.expires) {
      return Promise.resolve(cache.assets);
    }
    if (cache.pending) {
      return cache.pending;
    }
    const current = cache;
    const pending = getModuleFederationAssetList(root)
      .then(assets => {
        current.assets = assets;
        current.expires = Date.now() + 1_000;
        return assets;
      })
      .finally(() => {
        current.pending = null;
      });
    current.pending = pending;
    return pending;
  };

  async function serveFederated(
    context: Context,
    asset: StaticAsset,
    serve: ServeStaticAsset,
    requestPath: string,
    pathPrefix: string,
    remoteEntry: boolean,
  ) {
    applyModuleFederationAssetHeaders(context);
    const patchManifest =
      isModuleFederationManifestRequest(requestPath) &&
      !isBackendModuleFederationManifestRequest(requestPath);
    if (!patchManifest && !remoteEntry) {
      return respondPrecompressedAsset(context, asset, serve);
    }
    const response = await serve({ contentLength: true, revalidate: false });
    if (!response) {
      return null;
    }
    const { headers } = context.res;
    const bytes = Buffer.from(await response.arrayBuffer());
    const patched = patchManifest
      ? patchModuleFederationManifestPublicPath(context, bytes, pathPrefix)
      : patchModuleFederationRemoteEntryPublicPath(context, bytes, pathPrefix);
    // Native validators describe the original file, not the rewritten bytes.
    headers.delete('ETag');
    headers.set('Content-Length', String(patched.byteLength));
    if (path.extname(asset.filename).toLowerCase() === '.cjs') {
      headers.set('Content-Type', 'text/javascript; charset=UTF-8');
    }
    return new Response(Uint8Array.from(patched), {
      status: response.status,
      headers,
    });
  }

  async function serveGenerated(context: Context, root: string) {
    if (!['GET', 'HEAD'].includes(context.req.raw.method.toUpperCase())) {
      return null;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(context.req.path).replace(/\\/gu, '/');
    } catch {
      return null;
    }
    if (pathname.includes('\0') || pathname.split('/').includes('..')) {
      return null;
    }
    const publicRoot = path.join(root, 'public');
    const response = await serveStaticAsset(
      context,
      {
        filename: path.resolve(publicRoot, pathname.replace(/^\/+/, '')),
        kind: 'static',
        root: publicRoot,
        realpath: true,
      },
      (asset, serve) => respondPrecompressedAsset(context, asset, serve),
    );
    if (response && context.req.raw.method.toUpperCase() === 'HEAD') {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  }

  return {
    async respondAsset(context, asset, serve, { root, pathPrefix }) {
      const requestPath = getModuleFederationRequestPath(
        context.req.path,
        pathPrefix,
      );
      if (requestPath.includes('..')) {
        return null;
      }
      const assets = await getAssets(root);
      if (asset.kind === 'static' && assets.assets.has(requestPath)) {
        return serveFederated(
          context,
          asset,
          serve,
          requestPath,
          pathPrefix,
          assets.remoteEntries.has(requestPath),
        );
      }
      return respondPrecompressedAsset(context, asset, serve);
    },
    async respondPublicFallback(context, respondPublic, { root, pathPrefix }) {
      const requestPath = getModuleFederationRequestPath(
        context.req.path,
        pathPrefix,
      );
      if (requestPath.includes('..')) {
        return null;
      }
      const assets = await getAssets(root);
      if (assets.assets.has(requestPath)) {
        const response = await serveStaticAsset(
          context,
          {
            filename: path.join(root, requestPath),
            kind: 'static',
            root,
          },
          (asset, serve) =>
            serveFederated(
              context,
              asset,
              serve,
              requestPath,
              pathPrefix,
              assets.remoteEntries.has(requestPath),
            ),
        );
        if (response !== null) {
          return response;
        }
      }
      return (await respondPublic()) ?? serveGenerated(context, root);
    },
  };
}
