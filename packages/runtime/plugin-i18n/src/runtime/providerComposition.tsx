import { RuntimeContext } from '@modern-js/runtime';
import { Helmet } from '@modern-js/runtime/head';
import type React from 'react';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { BaseLocaleDetectionOptions } from '../shared/type';
import type { I18nUrlStrategy } from '../shared/urlStrategy';
import { ModernI18nProvider } from './context';
import {
  createContextValue,
  useClientSideRedirect,
  useLanguageSync,
  useSdkResourcesLoader,
} from './hooks';
import type { I18nRuntimeInstance } from './i18n';
import { getI18nextInstanceForProvider } from './i18n/instance';
import type { RuntimeContextWithI18n } from './pluginSetup';
import { useI18nRouterAdapter } from './routerAdapter';

export interface I18nLanguageSynchronizationProps {
  i18nInstance: I18nRuntimeInstance | undefined;
  localePathRedirect: boolean;
  languages: string[];
  pathname: string | undefined;
  prevLangRef: React.MutableRefObject<string>;
  setLang: (language: string) => void;
  children: (
    synchronizeLanguage: (language: string) => void,
  ) => React.ReactNode;
}

const NativeLanguageSynchronization = ({
  i18nInstance,
  localePathRedirect,
  languages,
  pathname,
  prevLangRef,
  setLang,
  children,
}: I18nLanguageSynchronizationProps) => {
  const synchronizeLanguage = useLanguageSync(
    i18nInstance,
    localePathRedirect,
    languages,
    pathname,
    prevLangRef,
    setLang,
  );
  return children(synchronizeLanguage);
};

interface I18nRootWrapperOptions {
  entryName?: string;
  htmlLangAttr: boolean;
  localePathRedirect: boolean;
  languages: string[];
  fallbackLanguage: string;
  ignoreRedirectRoutes?: BaseLocaleDetectionOptions['ignoreRedirectRoutes'];
  urlStrategy?: I18nUrlStrategy;
  NavigationProvider?: React.ComponentType<React.PropsWithChildren>;
  LanguageSynchronization?: React.ComponentType<I18nLanguageSynchronizationProps>;
  getLatestI18nInstance: () => I18nRuntimeInstance | undefined;
  getI18nextProvider: () => React.ComponentType<any> | null | undefined;
}

export const createI18nRootWrapper =
  (options: I18nRootWrapperOptions) => (App: React.ComponentType<any>) => {
    const LanguageSynchronization =
      options.LanguageSynchronization ?? NativeLanguageSynchronization;
    const I18nRoot = (props: Record<string, unknown>) => {
      const {
        entryName,
        htmlLangAttr,
        localePathRedirect,
        languages,
        fallbackLanguage,
        ignoreRedirectRoutes,
        urlStrategy,
        getLatestI18nInstance,
        getI18nextProvider,
      } = options;
      const runtimeContext = useContext(
        RuntimeContext,
      ) as RuntimeContextWithI18n;
      const i18nInstance =
        runtimeContext.i18nInstance || getLatestI18nInstance();
      const initialLang = useMemo(
        () => i18nInstance?.language || fallbackLanguage,
        [i18nInstance?.language, fallbackLanguage],
      );
      const [lang, setLang] = useState(initialLang);
      const [forceUpdate, setForceUpdate] = useState(0);
      const prevLangRef = useRef(lang);
      const { location } = useI18nRouterAdapter();

      useEffect(() => {
        if (i18nInstance?.language) {
          const translator = (i18nInstance as any).translator;
          if (translator) {
            translator.language = i18nInstance.language;
          }
        }
      }, [i18nInstance?.language]);

      useEffect(() => {
        prevLangRef.current = lang;
      }, [lang]);

      useSdkResourcesLoader(i18nInstance, setForceUpdate);
      // Handle client-side redirect for static deployments.
      useClientSideRedirect(
        i18nInstance,
        localePathRedirect,
        languages,
        fallbackLanguage,
        ignoreRedirectRoutes,
        urlStrategy,
      );

      // No instance means this root rendered outside the plugin's
      // onBeforeRender lifecycle. Modern i18n context is only provided for a
      // real instance, so `useModernI18n` reports the missing provider instead
      // of handing out a placeholder that has no translator.
      const contextValue = useMemo(
        () =>
          i18nInstance
            ? createContextValue(
                lang,
                i18nInstance,
                entryName,
                languages,
                localePathRedirect,
                ignoreRedirectRoutes,
                setLang,
                urlStrategy,
              )
            : undefined,
        [
          lang,
          i18nInstance,
          entryName,
          languages,
          localePathRedirect,
          ignoreRedirectRoutes,
          urlStrategy,
          forceUpdate,
        ],
      );
      const I18nextProvider = getI18nextProvider();
      const i18nextInstanceForProvider = useMemo(
        () =>
          i18nInstance
            ? getI18nextInstanceForProvider(i18nInstance, lang)
            : undefined,
        [i18nInstance, lang],
      );

      const children = (props as React.PropsWithChildren).children;
      let appContent: React.ReactNode = App ? (
        <App {...props}>{children}</App>
      ) : (
        children
      );

      if (I18nextProvider && i18nextInstanceForProvider) {
        appContent = (
          <I18nextProvider i18n={i18nextInstanceForProvider}>
            {appContent}
          </I18nextProvider>
        );
      }

      return (
        <>
          {Boolean(htmlLangAttr) && <Helmet htmlAttributes={{ lang }} />}
          <LanguageSynchronization
            i18nInstance={i18nInstance}
            localePathRedirect={localePathRedirect}
            languages={languages}
            pathname={location?.pathname}
            prevLangRef={prevLangRef}
            setLang={setLang}
          >
            {synchronizeLanguage =>
              contextValue ? (
                <ModernI18nProvider
                  i18nextProvider={I18nextProvider}
                  value={{ ...contextValue, synchronizeLanguage }}
                >
                  {appContent}
                </ModernI18nProvider>
              ) : (
                appContent
              )
            }
          </LanguageSynchronization>
        </>
      );
    };
    const { NavigationProvider } = options;
    if (!NavigationProvider) {
      return I18nRoot;
    }
    return function I18nRootWithNavigation(props: Record<string, unknown>) {
      return (
        <NavigationProvider>
          <I18nRoot {...props} />
        </NavigationProvider>
      );
    };
  };
