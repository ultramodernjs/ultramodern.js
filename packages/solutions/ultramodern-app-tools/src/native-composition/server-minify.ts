import type { RsbuildConfig, RsbuildPlugin } from '@rsbuild/core';

type MinifyConfig = NonNullable<NonNullable<RsbuildConfig['output']>['minify']>;

/**
 * Production minification for `node` environments.
 *
 * Rsbuild leaves server bundles unminified, so SSR and backend chunks ship
 * dead framework branches and whitespace that every cold start parses. Names
 * are kept: server logs, error classes and `constructor.name` checks read them,
 * and class static initializers must retain their original lexical binding.
 */
export const ULTRAMODERN_SERVER_MINIFY = {
  js: true,
  jsOptions: {
    minimizerOptions: {
      compress: { keep_classnames: true, keep_fnames: true },
      // SWC's keep_classnames mangling can move static self-references into TDZ.
      mangle: false,
    },
  },
} as const satisfies MinifyConfig;

/**
 * Minify `node` environments unless the application chose `output.minify`.
 *
 * Runs in `modifyRsbuildConfig`, before Rsbuild fills its `!isServer` default,
 * so an explicit app or environment value is still distinguishable and wins.
 */
export const builderPluginServerMinify = (
  appMinify: MinifyConfig | undefined,
): RsbuildPlugin => ({
  name: 'ultramodern:server-minify',
  setup(api) {
    if (appMinify !== undefined) return;
    api.modifyRsbuildConfig(config => {
      if (config.output?.minify !== undefined) return;
      for (const environment of Object.values(config.environments ?? {})) {
        const target = environment.output?.target ?? config.output?.target;
        if (target !== 'node' || environment.output?.minify !== undefined)
          continue;
        environment.output = {
          ...environment.output,
          minify: ULTRAMODERN_SERVER_MINIFY,
        };
      }
    });
  },
});
