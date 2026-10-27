import path from 'node:path';
import type { AppTools, CliPlugin } from '@modern-js/app-tools';
import {
  configureUltramodernTypeChecker,
  resolveNativeTypeCheckerCommand,
} from '@modern-js/app-tools-extensions/native-type-checker';
import type { Renderer } from '@modern-js/renderer-core';
import { resolveCandidateRendererProfile } from './renderer-profile';

export const rendererTypeCheckerOptions = (renderer: Renderer) => ({
  typescript: {
    configOverwrite: {
      compilerOptions: {
        jsxImportSource:
          resolveCandidateRendererProfile(renderer).jsxImportSource,
      },
    },
  },
});

/** The selected SDK composition owns checker defaults, before user options. */
export const rendererTypeCheckerPlugin = (
  renderer: Renderer,
): CliPlugin<AppTools> => ({
  name: '@modern-js/ultramodern-type-checker',
  pre: ['@modern-js/plugin-initialize'],
  setup(api) {
    api.config(() => ({
      tools: {
        tsChecker: rendererTypeCheckerOptions(renderer),
        bundlerChain(chain, utils) {
          const pluginId = utils.CHAIN_ID.PLUGIN.TS_CHECKER;
          if (!chain.plugins.has(pluginId)) return;
          const options = chain.plugin(pluginId).get('args')?.[0];
          if (options?.typescript?.tsgo === false) {
            throw new Error(
              'unsupported-type-checker: UltraModern requires an Effect-enabled native compiler; typescript.tsgo cannot be false',
            );
          }
          const { appDirectory } = api.getAppContext();
          // typescriptPath may point into pnpm's store or another installation.
          // Native selection belongs to the app, not that package's realpath.
          configureUltramodernTypeChecker(chain, pluginId, () =>
            resolveNativeTypeCheckerCommand(
              path.join(appDirectory, 'package.json'),
            ),
          );
        },
      },
    }));
  },
});
