import type {
  Middleware,
  ServerEnv,
  ServerPlugin,
} from '@modern-js/server-core';

import { isProd } from '@modern-js/utils';

import {
  createModuleFederationCssCollector,
  DEFAULT_REMOTE_CSS_CACHE_TTL_MS,
} from './collector';

export type ModuleFederationCssPluginOptions = {
  /**
   * TTL for the cached remote CSS collection in production.
   *
   * @default 30000 in production, 0 (no caching) otherwise
   */
  remoteCssCacheTtlMs?: number;
};

/**
 * Enriches the request-scoped server manifest with CSS assets collected from
 * direct module federation remotes, so SSR/CSR-RSC rendering can inline
 * `<link>` tags for remote CSS.
 *
 * In production the collection is cached with a TTL (default 30s) instead of
 * being pinned at boot: remote manifests change on every remote redeploy, and
 * fetch failures must not pin an empty/partial list for the process lifetime.
 *
 * Existing plugin ordering places this after the native resource plugin.
 * Lazy loading keeps enrichment in the page-only resource prefix, before
 * configured render middleware.
 */
export const injectModuleFederationCssPlugin = (
  options: ModuleFederationCssPluginOptions = {},
): ServerPlugin => ({
  name: '@modern-js/inject-module-federation-css',
  pre: ['@modern-js/plugin-inject-resource'],
  post: ['@modern-js/plugin-inject-rsc-manifest'],

  setup(api) {
    api.onPrepare(() => {
      const {
        middlewares,
        renderMiddlewares,
        renderResources,
        distDirectory: pwd,
      } = api.getServerContext();

      if (!pwd) {
        return;
      }

      const ttlMs = Math.max(
        0,
        options.remoteCssCacheTtlMs ??
          (isProd() ? DEFAULT_REMOTE_CSS_CACHE_TTL_MS : 0),
      );
      const collector = createModuleFederationCssCollector(pwd, { ttlMs });

      if (isProd()) {
        // Warm up the remote manifest fetch at prepare time, mirroring the
        // server manifest warmup of injectResourcePlugin, so the first
        // request does not pay the collection latency. Failures are retried
        // on the next request instead of failing startup.
        collector.collect().catch(() => {});
      }

      const handler: Middleware<ServerEnv> = async (c, next) => {
        const serverManifest = c.get('serverManifest');

        if (serverManifest && !serverManifest.moduleFederationCssAssets) {
          const monitors = c.get('monitors');
          const moduleFederationCssAssets = await collector.collect(monitors);

          c.set('serverManifest', {
            ...serverManifest,
            moduleFederationCssAssets,
          });
        }

        await next();
      };

      const middleware = {
        name: 'inject-module-federation-css',
        handler,
      };
      if (isProd() && renderResources?.loading === 'lazy') {
        // Native resource injection runs first and prepends this template
        // handler. Enrich immediately after it, before application consumers.
        const templates = renderMiddlewares.findIndex(
          middleware => middleware.name === 'inject-html',
        );
        renderMiddlewares.splice(templates + 1, 0, middleware);
      } else {
        middlewares.push(middleware);
      }
    });
  },
});
