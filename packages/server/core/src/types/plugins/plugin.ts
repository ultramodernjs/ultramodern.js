import type {
  AsyncPipelineHook,
  ServerContext as BaseServerContext,
  ServerPlugin as BaseServerPlugin,
  ServerPluginAPI as BaseServerPluginAPI,
  ServerPluginExtends as BaseServerPluginExtends,
} from '@modern-js/plugin';
import type { Hooks } from '@modern-js/plugin/server';
import type {
  AfterMatchContext,
  AfterRenderContext,
  AfterStreamingRenderContext,
} from '@modern-js/types';
import type { Context, MiddlewareHandler } from 'hono';
import type { ServerRenderResourceOptions } from '../../adapters/node/plugins/resource';
import type { ServerStaticPluginOptions } from '../../adapters/node/plugins/static';
import type {
  APIServerStartInput,
  MiddlewareObj,
  ServerConfig,
  WebAdapter,
  WebServerStartInput,
} from './base';

export type PrepareWebServerFn = (
  input: WebServerStartInput,
) => Promise<WebAdapter | null>;
export type PrepareApiServerFn = (
  input: APIServerStartInput,
) => Promise<MiddlewareHandler>;
export type AfterMatchFn = (ctx: AfterMatchContext) => Promise<any>;
export type AfterRenderFn = (ctx: AfterRenderContext) => Promise<any>;
export type AfterStreamingRenderContextFn = (
  ctx: AfterStreamingRenderContext,
) => Promise<AfterStreamingRenderContext>;

export interface HandleErrorInput {
  error: Error;
  context: Context;
  response?: Response;
}

export type HandleErrorFn = (
  input: HandleErrorInput,
  next?: (input: HandleErrorInput) => void,
) => Promise<HandleErrorInput>;

export interface ServerPluginExtends extends BaseServerPluginExtends {
  config: ServerConfig;
  extendApi: {
    /** Release an instance resource on shutdown or failed initialization. */
    onDispose: (disposer: () => void | Promise<void>) => () => void;
  };
  extendContext: {
    /** Node static response extensions registered during plugin setup. */
    staticAssetResponders?: ServerStaticPluginOptions;
    /** Node render resource loading registered during plugin setup. */
    renderResources?: ServerRenderResourceOptions;
    middlewares: MiddlewareObj[];
    renderMiddlewares: MiddlewareObj[];
    [key: string]: any;
  };
  extendHooks: {
    handleError: AsyncPipelineHook<HandleErrorFn>;
    prepareWebServer: AsyncPipelineHook<PrepareWebServerFn>;
    prepareApiServer: AsyncPipelineHook<PrepareApiServerFn>;
    afterMatch: AsyncPipelineHook<AfterMatchFn>;
    afterRender: AsyncPipelineHook<AfterRenderFn>;
    afterStreamingRender: AsyncPipelineHook<AfterStreamingRenderContextFn>;
  };
}
export type ServerPlugin = BaseServerPlugin<ServerPluginExtends>;

export type ServerContext = BaseServerContext<ServerPluginExtends> &
  ServerPluginExtends['extendContext'];

export type ServerPluginHooks = Hooks<ServerPluginExtends> &
  ServerPluginExtends['extendHooks'];

export type ServerPluginAPI = BaseServerPluginAPI<ServerPluginExtends> &
  ServerPluginExtends['extendApi'];
