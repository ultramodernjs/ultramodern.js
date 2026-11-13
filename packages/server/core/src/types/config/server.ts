import type { SSRMode } from '@modern-js/types/common';
import type { WatchOptions } from '@modern-js/utils/watch-options';

type Route =
  | string
  | string[]
  | {
      route?: string | string[];
      disableSpa?: boolean;
      resHeaders?: Record<string, unknown>;
    };
export type Routes = Record<string, Route>;

export type SSR =
  | boolean
  | {
      forceCSR?: boolean;
      mode?: SSRMode;
      preload?: boolean | SSRPreload;
      inlineScript?: boolean;
      disablePrerender?: boolean;
      /**
       * Additional request header names removed from SSR payload serialization.
       * Sensitive headers are denylisted by default.
       */
      unsafeHeaders?: string[];
      loaderFailureMode?: 'clientRender' | 'errorBoundary';
      /**
       * Enable app-level Module Federation SSR bridge path.
       * This flag should be enabled in both host and remote applications.
       * @default false
       */
      moduleFederationAppSSR?: boolean;
    };

export type SSRByEntries = Record<string, SSR>;

type SSRPreload = Record<string, unknown>;

export type StaticCacheControlOptions = {
  /**
   * @description `Cache-Control` of build assets with a content hash in the file name
   * @default 'public, max-age=31536000, immutable'
   */
  hashed?: string;
  /**
   * @description `Cache-Control` of other static files, such as files in `config/public` and `config/upload`
   * @default 'no-cache'
   */
  unhashed?: string;
};

export interface ServerUserConfig {
  publicDir?: string | string[];
  routes?: Routes;
  /**
   * Experimenal, it is not recommended to use it now
   */
  ssrByRouteIds?: string[];
  publicRoutes?: Record<string, string>;
  ssr?: SSR;
  ssrByEntries?: SSRByEntries;
  rsc?:
    | boolean
    | {
        environments?: {
          server?: string;
          client?: string;
        };
      };
  baseUrl?: string | string[];
  port?: number;
  watchOptions?: WatchOptions;
  compiler?: 'typescript';
  /**
   * @description use json script tag instead of inline script
   * @default false
   */
  useJsonScript?: boolean;
  logger?: boolean | Record<string, unknown>;
  /**
   * @description set `Cache-Control` for static files served by the production server
   * @default true
   */
  staticCacheControl?: boolean | StaticCacheControlOptions;
  /**
   * @description disable hook middleware for performance
   * @default false
   */
  disableHook?: boolean;
  /**
   * Path to the tsconfig used by all server-side TypeScript stages:
   * BFF/api compile, custom server compile, runtime TypeScript register,
   * and downstream runtimes.
   *
   * @default <appDirectory>/tsconfig.json
   */
  tsconfigPath?: string;
}

export type ServerNormalizedConfig = ServerUserConfig;
