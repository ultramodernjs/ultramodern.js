import { isBrowser } from '@modern-js/runtime';
import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { I18nUrlStrategy } from '../shared/urlStrategy';
import {
  cacheI18nLanguage,
  changeI18nInstanceLanguage,
} from './contextHelpers';
import type { I18nRuntimeInstance } from './i18n';
import {
  getI18nSdkBackendId,
  I18N_SDK_RESOURCES_LOADED_EVENT,
  type I18nSdkResourcesLoadedEventDetail,
} from './i18n/backend/sdk-event';
import { useI18nRouterAdapter } from './routerAdapter';
import {
  buildLocalizedUrl,
  detectLanguageFromPath,
  getEntryPath,
  shouldIgnoreRedirect,
} from './utils';

type WindowWithSSRData = Window & {
  _SSR_DATA?: unknown;
};

type ResourceStoreWithEvents = NonNullable<I18nRuntimeInstance['store']> & {
  emit?: (event: string, ...args: unknown[]) => void;
};

export function createContextValue(
  lang: string,
  i18nInstance: I18nRuntimeInstance,
  entryName: string | undefined,
  languages: string[],
  localePathRedirect: boolean,
  ignoreRedirectRoutes: string[] | ((pathname: string) => boolean) | undefined,
  setLang: (lang: string) => void,
  urlStrategy?: I18nUrlStrategy,
) {
  return {
    language: lang,
    i18nInstance,
    entryName,
    languages,
    localePathRedirect,
    ignoreRedirectRoutes,
    urlStrategy,
    updateLanguage: setLang,
  };
}

export function useSdkResourcesLoader(
  i18nInstance: I18nRuntimeInstance | undefined,
  setForceUpdate: React.Dispatch<React.SetStateAction<number>>,
) {
  useEffect(() => {
    if (!i18nInstance || !isBrowser()) {
      return;
    }

    const backendId =
      getI18nSdkBackendId(i18nInstance.services?.resourceStore) ||
      getI18nSdkBackendId(i18nInstance.services?.store) ||
      getI18nSdkBackendId(i18nInstance.store);

    if (!backendId) {
      return;
    }

    const handleSdkResourcesLoaded = (event: Event) => {
      const customEvent =
        event as CustomEvent<I18nSdkResourcesLoadedEventDetail>;
      const {
        language,
        namespace,
        backendId: eventBackendId,
      } = customEvent.detail || {};

      if (!language || !namespace) {
        return;
      }

      if (eventBackendId && eventBackendId !== backendId) {
        return;
      }

      const triggerUpdate = (retryCount = 0) => {
        const store = i18nInstance.store as ResourceStoreWithEvents | undefined;
        const hasResource = store?.data?.[language]?.[namespace];

        if (hasResource || retryCount >= 10) {
          if (store?.data?.[language]?.[namespace]) {
            if (typeof store.emit === 'function') {
              store.emit('added', language, namespace);
            }
          }

          if (typeof i18nInstance.emit === 'function') {
            i18nInstance.emit('loaded', { language, namespace });
            i18nInstance.emit('loaded', language, namespace);
          }

          if (typeof i18nInstance.reloadResources === 'function') {
            i18nInstance
              .reloadResources(language, namespace)
              .then(() => {
                if (typeof i18nInstance.emit === 'function') {
                  i18nInstance.emit('loaded', { language, namespace });
                }
                setForceUpdate(prev => prev + 1);
              })
              .catch(() => {
                // Ignore errors from reloadResources
              });
          }

          if (typeof i18nInstance.emit === 'function') {
            i18nInstance.emit('languageChanged', language);
          }

          setForceUpdate(prev => prev + 1);
        } else {
          setTimeout(() => triggerUpdate(retryCount + 1), 10);
        }
      };

      triggerUpdate();
    };

    window.addEventListener(
      I18N_SDK_RESOURCES_LOADED_EVENT,
      handleSdkResourcesLoaded,
    );

    return () => {
      window.removeEventListener(
        I18N_SDK_RESOURCES_LOADED_EVENT,
        handleSdkResourcesLoaded,
      );
    };
  }, [i18nInstance, setForceUpdate]);
}

/**
 * Hook to handle client-side redirect for locale path redirect in static deployments
 * This ensures that when users access paths without language prefix, they are redirected
 * to the localized version of the path
 *
 * Note: This hook only runs in CSR (Client-Side Rendering) scenarios.
 * In SSR/SSG scenarios, server-side middleware handles redirects, so this hook is skipped.
 * We use process.env.MODERN_TARGET to ensure this code is only included in browser bundles.
 */
export function useClientSideRedirect(
  i18nInstance: I18nRuntimeInstance | undefined,
  localePathRedirect: boolean,
  languages: string[],
  fallbackLanguage: string,
  ignoreRedirectRoutes?: string[] | ((pathname: string) => boolean),
  urlStrategy?: I18nUrlStrategy,
) {
  const urlRef = useRef('');
  const { navigate, location, hasRouter } = useI18nRouterAdapter();

  useEffect(() => {
    if (process.env.MODERN_TARGET !== 'browser') {
      return;
    }
    if (!localePathRedirect || !i18nInstance) {
      return;
    }

    try {
      const ssrData = (window as WindowWithSSRData)._SSR_DATA;
      if (ssrData) {
        return;
      }
    } catch {
      // Ignore errors when checking SSR data
    }

    if (urlRef.current === (location?.pathname || window.location.pathname)) {
      return;
    }

    if (!i18nInstance.isInitialized) {
      return;
    }

    // Use router location if available, otherwise fallback to window.location
    const currentPathname =
      hasRouter && location ? location.pathname : window.location.pathname;
    const currentSearch =
      hasRouter && location ? location.search : window.location.search;
    const currentHash =
      hasRouter && location ? location.hash : window.location.hash;

    const entryPath = getEntryPath();
    const relativePath = currentPathname.replace(entryPath, '');

    if (
      shouldIgnoreRedirect(
        relativePath,
        languages,
        ignoreRedirectRoutes,
        urlStrategy,
      )
    ) {
      return;
    }

    const pathDetection = detectLanguageFromPath(
      currentPathname,
      languages,
      localePathRedirect,
    );

    const targetLanguage =
      pathDetection.language ||
      i18nInstance.language ||
      fallbackLanguage ||
      languages[0] ||
      'en';

    const newPath = buildLocalizedUrl(
      relativePath,
      targetLanguage,
      languages,
      urlStrategy,
    );
    const newUrl = entryPath + newPath + currentSearch + currentHash;

    urlRef.current = currentPathname;
    if (newUrl !== currentPathname + currentSearch + currentHash) {
      // Use navigate if router is available (similar to changeLanguage implementation)
      if (hasRouter && navigate && location) {
        navigate(newUrl, { replace: true });
      } else {
        // Fallback to window.location.replace for non-router scenarios
        // This ensures the new URL is properly recognized and translations are reloaded
        window.location.replace(newUrl);
      }
    }
  }, [
    navigate,
    location,
    hasRouter,
    localePathRedirect,
    i18nInstance,
    languages,
    fallbackLanguage,
    ignoreRedirectRoutes,
    urlStrategy,
  ]);
}

export function useLanguageSync(
  i18nInstance: I18nRuntimeInstance | undefined,
  localePathRedirect: boolean,
  languages: string[],
  pathname: string | undefined,
  prevLangRef: React.MutableRefObject<string>,
  setLang: (lang: string) => void,
) {
  const latestRequestRef = useRef(0);
  const syncQueueRef = useRef(Promise.resolve());
  const isMountedRef = useRef(false);
  const desiredLanguageRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      latestRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    desiredLanguageRef.current = undefined;
    latestRequestRef.current += 1;
    syncQueueRef.current = Promise.resolve();
  }, [i18nInstance]);

  const synchronizeLanguage = useCallback(
    (currentLang: string) => {
      if (
        !i18nInstance ||
        !currentLang ||
        desiredLanguageRef.current === currentLang
      ) {
        return;
      }

      desiredLanguageRef.current = currentLang;
      const requestId = ++latestRequestRef.current;
      syncQueueRef.current = syncQueueRef.current.then(async () => {
        if (requestId !== latestRequestRef.current || !isMountedRef.current) {
          return;
        }

        try {
          if (i18nInstance.language !== currentLang) {
            await changeI18nInstanceLanguage(i18nInstance, currentLang);
          }

          if (requestId !== latestRequestRef.current || !isMountedRef.current) {
            return;
          }

          prevLangRef.current = currentLang;
          setLang(currentLang);
          cacheI18nLanguage(i18nInstance, currentLang);
        } catch (error) {
          if (requestId === latestRequestRef.current && isMountedRef.current) {
            desiredLanguageRef.current = undefined;
            console.error(
              `Failed to synchronize i18n language "${currentLang}".`,
              error,
            );
          }
        }
      });
    },
    [i18nInstance, prevLangRef, setLang],
  );

  useEffect(() => {
    if (!i18nInstance) {
      return;
    }

    if (localePathRedirect) {
      const pathDetection = detectLanguageFromPath(
        pathname || '',
        languages,
        localePathRedirect,
      );
      if (pathDetection.detected && pathDetection.language) {
        synchronizeLanguage(pathDetection.language);
      }
    } else {
      latestRequestRef.current += 1;
      const instanceLang = i18nInstance.language;
      if (instanceLang && instanceLang !== prevLangRef.current) {
        prevLangRef.current = instanceLang;
        setLang(instanceLang);
      }
    }
  }, [
    i18nInstance,
    localePathRedirect,
    languages,
    pathname,
    prevLangRef,
    setLang,
    synchronizeLanguage,
  ]);

  return synchronizeLanguage;
}
