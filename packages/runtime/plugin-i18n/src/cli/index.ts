import fs from 'node:fs';
import path from 'node:path';
import type { AppTools, AppUserConfig, CliPlugin } from '@modern-js/app-tools';
import { getPublicDirRoutePrefixes } from '@modern-js/server-core';
import type { Entrypoint } from '@modern-js/types';
import { logger } from '@modern-js/utils';
import type { BackendOptions, LocaleDetectionOptions } from '../shared/type';
import { isUnusableI18nUrlStrategy } from '../shared/urlStrategy';
import { getBackendOptions, getLocaleDetectionOptions } from '../shared/utils';
import { applyDetectedBackendPaths, detectLocalesDirectory } from './locales';
import { applyLocalisedRoutes } from './localisedRoutes';
import '../runtime/types';

type BundlerChain = NonNullable<AppUserConfig['tools']>['bundlerChain'];

// Before the first render the runtime loads react-i18next with a dynamic import.
// Bundle that module eagerly so it doesn't become an extra async request. Only
// runtime/i18n/react-i18next is matched: the i18next fallback import in
// runtime/i18n/instance stays lazy, so apps that pass their own instance don't
// get an unused copy of i18next in the initial chunk.
const eagerReactI18next: BundlerChain = chain => {
  chain.module
    .rule('plugin-i18n-react-i18next')
    .test(
      /[\\/]plugin-i18n[\\/]dist[\\/][^\\/]+[\\/]runtime[\\/]i18n[\\/]react-i18next\.m?js$/,
    )
    .parser({ dynamicImportMode: 'eager' });
};

export type TransformRuntimeConfigFn = (
  extendedConfig: Record<string, any>,
  entrypoint: Entrypoint,
) => Record<string, any>;

export interface I18nPluginOptions {
  localeDetection?: LocaleDetectionOptions;
  backend?: BackendOptions;
  transformRuntimeConfig?: TransformRuntimeConfigFn;
  customPlugin?: {
    runtime?: {
      name?: string;
      path?: string;
    };
    server?: {
      name?: string;
    };
  };
  [key: string]: any;
}

export const i18nPlugin = (
  options: I18nPluginOptions = {},
): CliPlugin<AppTools> => ({
  name: '@modern-js/plugin-i18n',
  setup: api => {
    const {
      localeDetection,
      backend,
      transformRuntimeConfig,
      customPlugin,
      ...restOptions
    } = options;

    api.config(() => ({ tools: { bundlerChain: eagerReactI18next } }));

    api._internalRuntimePlugins(({ entrypoint, plugins }) => {
      const localeDetectionOptions = localeDetection
        ? getLocaleDetectionOptions(entrypoint.entryName, localeDetection)
        : undefined;

      // Auto-detect locales directory and enable backend if:
      // 1. User didn't explicitly set backend.enabled to false
      // 2. Locales directory exists with JSON files
      // 3. If user configured loadPath or addPath, auto-enable backend
      let backendOptions: BackendOptions | undefined;
      const { appDirectory } = api.getAppContext();
      const normalizedConfig = api.getNormalizedConfig();
      const detectedLocales = detectLocalesDirectory(
        appDirectory,
        normalizedConfig,
      );

      if (backend) {
        const entryBackendOptions = getBackendOptions(
          entrypoint.entryName,
          backend,
        );
        // If user explicitly set enabled to false, don't auto-detect
        if (entryBackendOptions?.enabled === false) {
          backendOptions = entryBackendOptions;
        } else {
          if (detectedLocales) {
            backendOptions = applyDetectedBackendPaths(
              entryBackendOptions,
              detectedLocales,
            );
          } else if (
            entryBackendOptions?.loadPath ||
            entryBackendOptions?.addPath
          ) {
            // If user configured loadPath or addPath, auto-enable backend even
            // when no local locales directory is detected.
            backendOptions = {
              ...entryBackendOptions,
              enabled: true,
            };
          } else {
            backendOptions = entryBackendOptions;
          }
        }
      } else {
        // No backend config provided, try auto-detection
        if (detectedLocales) {
          // Auto-enable backend if locales directory is detected
          backendOptions = applyDetectedBackendPaths(
            getBackendOptions(entrypoint.entryName, {
              enabled: true,
            }),
            detectedLocales,
          );
        }
      }

      const { metaName } = api.getAppContext();

      // Transform extended config if transform function is provided
      let extendedConfig = restOptions;
      if (transformRuntimeConfig) {
        extendedConfig = transformRuntimeConfig(
          restOptions,
          entrypoint as Entrypoint,
        );
      }

      // Build final config with base config and transformed extended config
      const config: Record<string, unknown> = {
        entryName: entrypoint.entryName,
        localeDetection: localeDetectionOptions,
        backend: backendOptions,
        ...extendedConfig,
      };

      // This config is written into the generated runtime registration as
      // JSON, so an object carrying functions arrives at the runtime with none
      // of them. Drop it rather than shipping a broken `{}` that every call
      // site would then have to survive, and say what to configure instead.
      if (isUnusableI18nUrlStrategy(config.urlStrategy)) {
        delete config.urlStrategy;
        logger.warn(
          '[i18n] `urlStrategy` cannot be passed through `modern.config.ts`: ' +
            'the generated runtime registration carries plugin options as ' +
            'JSON, which drops its methods. Configure ' +
            '`localeDetection.localisedUrls` instead — the runtime and the ' +
            'server both derive the URL policy from it — or register a ' +
            'runtime plugin that supplies the strategy directly.',
        );
      }
      const { reactI18next } = extendedConfig as { reactI18next?: boolean };
      const runtimePluginPath =
        customPlugin?.runtime?.path ||
        (reactI18next === false
          ? `@${metaName}/plugin-i18n/runtime/no-react-i18next`
          : `@${metaName}/plugin-i18n/runtime`);

      plugins.push({
        name: customPlugin?.runtime?.name || 'i18n',
        path: runtimePluginPath,
        config,
      });
      return {
        entrypoint,
        plugins,
      };
    });

    // Mapped locale URLs are a property of `localeDetection.localisedUrls`, not
    // of any particular app-tools composition, so the route expansion lives
    // here rather than in an opt-in fork plugin. A bare `appTools()` consumer
    // that declares the map gets `/cs/obchodni-podminky` generated alongside
    // `/cs/terms-of-service`; without this the localized path 404s under SSR.
    //
    // This is deliberately not registered from `@modern-js/i18n-integration`:
    // that package peer-depends on `@modern-js/runtime`, and pulling it into
    // the default app-tools path closes an Nx cycle
    // (app-tools -> app-tools-extensions -> i18n-integration -> runtime -> app-tools).
    // `@modern-js/i18n-runtime-extensions` is already a direct dependency here,
    // so nothing new is added to the graph.
    api.modifyFileSystemRoutes(({ entrypoint, routes }) => ({
      entrypoint,
      routes: applyLocalisedRoutes(
        routes as any,
        localeDetection
          ? getLocaleDetectionOptions(entrypoint.entryName, localeDetection)
          : undefined,
        entrypoint,
      ) as typeof routes,
    }));

    api._internalServerPlugins(({ plugins }) => {
      const { serverRoutes, metaName } = api.getAppContext();
      const normalizedConfig = api.getNormalizedConfig();

      let staticRoutePrefixes: string[] = [];
      if (serverRoutes && Array.isArray(serverRoutes)) {
        // Get static route prefixes from 'public' directories
        // 'public' routes are handled by static plugin
        staticRoutePrefixes = serverRoutes
          .filter(
            route => !route.entryName && route.entryPath.startsWith('public'),
          )
          .map(route => route.urlPath)
          .filter(Boolean);
      }

      // Also include publicDir configuration paths
      // publicDir files are copied to dist/{dir}/ and should be treated as static resources
      const publicDirPrefixes = getPublicDirRoutePrefixes(
        normalizedConfig?.server?.publicDir,
      );
      publicDirPrefixes.forEach(prefix => {
        if (!staticRoutePrefixes.includes(prefix)) {
          staticRoutePrefixes.push(prefix);
        }
      });

      plugins.push({
        name: customPlugin?.server?.name || `@${metaName}/plugin-i18n/server`,
        options: {
          localeDetection,
          staticRoutePrefixes,
        },
      });
      return { plugins };
    });
  },
});

export default i18nPlugin;
