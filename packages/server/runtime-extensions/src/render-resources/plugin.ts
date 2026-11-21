import { performance } from 'node:perf_hooks';
import type { ServerPlugin } from '@modern-js/server-core';
import { parseServerRuntimeExtensionsEnv } from '../env';
import {
  type RenderBundleLoadEvent,
  renderBundleLoadChannel,
  type ServerRequestTrace,
  serverRequestChannel,
} from './channels';

export function injectRenderResourcesPlugin(): ServerPlugin {
  return {
    name: '@modern-js/server-render-resources',
    setup(api) {
      const distDirectory = api.getServerContext().distDirectory;
      api.updateServerContext({
        renderResources: {
          loading: parseServerRuntimeExtensionsEnv().renderResources,
          onBundleLoad({ filepath, requestPath }) {
            if (!renderBundleLoadChannel.hasSubscribers) {
              return undefined;
            }
            const started = performance.now();
            return outcome => {
              renderBundleLoadChannel.publish({
                distDirectory,
                filepath,
                durationMs: performance.now() - started,
                outcome,
                triggerPath: requestPath ?? '<startup>',
              } satisfies RenderBundleLoadEvent);
            };
          },
        },
      });
      api.onPrepare(() => {
        api.getServerContext().middlewares.unshift({
          name: 'trace-server-request',
          // Node returns next() directly while nothing subscribes.
          handler: (c, next) =>
            serverRequestChannel.tracePromise(next, {
              distDirectory,
              path: c.req.path,
            } satisfies ServerRequestTrace),
        });
      });
    },
  };
}

export default injectRenderResourcesPlugin;
