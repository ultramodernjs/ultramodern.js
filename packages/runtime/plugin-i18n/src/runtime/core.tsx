import type { RuntimePlugin } from '@modern-js/runtime';
import type React from 'react';
import { resolveMappedUrlStrategy } from '../shared/mappedUrlStrategy';
import type {
  BaseBackendOptions,
  BaseLocaleDetectionOptions,
} from '../shared/type';
import { asI18nUrlStrategy, type I18nUrlStrategy } from '../shared/urlStrategy';
import type { I18nInitOptions, I18nRuntimeInstance } from './i18n';
import { I18nRouterNavigationProvider } from './navigation';
import {
  type RuntimeContextWithI18n,
  setupI18nBeforeRender,
} from './pluginSetup';
import {
  createI18nRootWrapper,
  type I18nLanguageSynchronizationProps,
} from './providerComposition';

export type { I18nLanguageSynchronizationProps } from './providerComposition';

import {
  type LoadReactI18nextIntegration,
  resolveReactI18nextIntegration,
} from './reactI18next';
import './types';

export type { I18nSdkLoader, I18nSdkLoadOptions } from '../shared/type';
export type { I18nUrlStrategy } from '../shared/urlStrategy';
export type {
  I18nInitOptions,
  I18nInstance,
  I18nRuntimeInstance,
  I18nWrapperInstance,
  Resources,
  TranslateFn,
} from './i18n/instance';
export {
  I18nRouterNavigationProvider,
  useIntegratedRouterAdapter,
} from './navigation';
export type {
  LoadReactI18nextIntegration,
  ReactI18nextIntegration,
} from './reactI18next';
export {
  I18nNavigationProvider,
  type I18nRouterAdapter,
  type I18nRouterLinkTarget,
  useI18nRouterAdapter,
  useNativeI18nRouterAdapter,
} from './routerAdapter';

export interface I18nPluginOptions {
  entryName?: string;
  localeDetection?: BaseLocaleDetectionOptions;
  backend?: BaseBackendOptions;
  i18nInstance?: I18nRuntimeInstance;
  changeLanguage?: (lang: string) => void;
  initOptions?: I18nInitOptions;
  htmlLangAttr?: boolean;
  reactI18next?: boolean;
  urlStrategy?: I18nUrlStrategy;
  NavigationProvider?: React.ComponentType<React.PropsWithChildren>;
  LanguageSynchronization?: React.ComponentType<I18nLanguageSynchronizationProps>;
  [key: string]: any;
}

export const createI18nPlugin =
  (
    loadReactI18nextIntegration?: LoadReactI18nextIntegration,
  ): ((options: I18nPluginOptions) => RuntimePlugin) =>
  (options: I18nPluginOptions): RuntimePlugin => ({
    name: '@modern-js/plugin-i18n',
    setup: api => {
      const {
        entryName,
        i18nInstance: userI18nInstance,
        initOptions,
        localeDetection,
        backend,
        htmlLangAttr = false,
        reactI18next = true,
        urlStrategy,
        NavigationProvider,
        LanguageSynchronization,
      } = options;
      const {
        localePathRedirect = false,
        i18nextDetector = true,
        languages = [],
        fallbackLanguage = 'en',
        detection,
        ignoreRedirectRoutes,
      } = localeDetection || {};
      const { enabled: backendEnabled = false } = backend || {};
      // A strategy configured in `modern.config.ts` reaches here through JSON,
      // which drops its methods. Anything unusable is treated as absent so the
      // built-in language-prefix behaviour applies instead of throwing.
      //
      // Falling back to `localeDetection.localisedUrls` makes mapped locale
      // URLs work for a bare `appTools()` consumer: the map is plain data, so
      // it survives the JSON boundary that a `urlStrategy` object does not.
      // The server already derives its policy from the same field, and the two
      // must agree — otherwise SSR renders `/cs/obchodni-podminky` and the
      // hydrated `<Link>` navigates to `/cs/terms-of-service`, which 404s.
      // An explicit, usable `urlStrategy` (supplied by a composing runtime
      // plugin) still wins.
      const resolvedUrlStrategy =
        asI18nUrlStrategy(urlStrategy) ??
        resolveMappedUrlStrategy(localeDetection);
      let latestI18nInstance: I18nRuntimeInstance | undefined;
      let I18nextProvider: React.ComponentType<any> | null;

      api.onBeforeRender(async (context: RuntimeContextWithI18n) => {
        latestI18nInstance = await setupI18nBeforeRender(context, {
          api,
          userI18nInstance,
          initOptions,
          backend,
          backendEnabled,
          i18nextDetector,
          detection,
          localePathRedirect,
          languages,
          fallbackLanguage,
          resolveReactI18nextIntegration: () =>
            resolveReactI18nextIntegration(
              reactI18next,
              loadReactI18nextIntegration,
            ),
          setI18nextProvider: provider => {
            I18nextProvider = provider;
          },
        });
      });

      api.wrapRoot(
        createI18nRootWrapper({
          entryName,
          htmlLangAttr,
          localePathRedirect,
          languages,
          fallbackLanguage,
          ignoreRedirectRoutes,
          urlStrategy: resolvedUrlStrategy,
          // The selected router, not react-router, is what a localized `<Link>`
          // has to navigate through, and the i18n language has to follow a
          // client-side navigation to a mapped URL. Both need the actual router
          // instance, so a bare `appTools()` consumer gets the integrated
          // adapter by default; a composing runtime plugin can still replace it.
          NavigationProvider:
            NavigationProvider ?? I18nRouterNavigationProvider,
          LanguageSynchronization,
          getLatestI18nInstance: () => latestI18nInstance,
          getI18nextProvider: () => I18nextProvider,
        }),
      );
    },
  });

export type {
  AllowedLinkTarget,
  CanonicalRoutePath,
  UltramodernCanonicalRoutes,
} from './canonicalRoutes';
export {
  FederatedI18nBoundary,
  type FederatedI18nBoundaryProps,
  type UseModernI18nReturn,
  useModernI18n,
} from './context';
export { I18nLink, type I18nLinkProps } from './I18nLink';
export {
  Link,
  type LinkActiveOptions,
  type LinkBaseProps,
  type LinkParams,
  type LinkProps,
} from './Link';
export {
  type LocalizedPathsConfig,
  type UseLocalizedLocationReturn,
  type UseLocalizedPathsReturn,
  useLocalizedLocation,
  useLocalizedPaths,
} from './localizedPaths';
export { splitUrlTarget } from './utils';
