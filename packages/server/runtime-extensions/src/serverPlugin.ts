import './serverConfig';
import type { ServerPlugin } from '@modern-js/server-core';
import { injectErrorResponsePlugin } from './errorResponsePlugin';
import { injectLocalisedLoaderPlugin } from './localisedLoaderPlugin';
import { injectMfAssetCacheHeadersPlugin } from './mfCache';
import { injectModuleFederationCssPlugin } from './module-federation-css/plugin';
import { injectRenderResourcesPlugin } from './render-resources/plugin';
import { disposeServerRuntime } from './runtimeLifecycle';
import { injectStaticServingPlugin } from './static-serving/plugin';
import { injectTelemetryPlugin } from './telemetry/plugin';

/** Compose fork server policies through the native ServerPlugin extension. */
export const ultramodernServerPlugin = (): ServerPlugin => ({
  name: '@modern-js/ultramodern-server',
  usePlugins: [
    injectLocalisedLoaderPlugin(),
    injectErrorResponsePlugin(),
    injectTelemetryPlugin(),
    injectModuleFederationCssPlugin(),
    injectMfAssetCacheHeadersPlugin(),
    injectStaticServingPlugin(),
    injectRenderResourcesPlugin(),
    {
      name: '@modern-js/server-runtime-lifecycle',
      // Native disposal reverses registration: Effect resources close before
      // the telemetry lane flushes their final events.
      pre: ['@modern-js/inject-telemetry'],
      setup(api) {
        api.onDispose(() => {
          const { serverBase } = api.getServerContext();
          if (serverBase) {
            return disposeServerRuntime(serverBase);
          }
        });
      },
    },
  ],
});

export default ultramodernServerPlugin;
