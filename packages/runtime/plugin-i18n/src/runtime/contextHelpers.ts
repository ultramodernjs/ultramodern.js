import { isBrowser } from '@modern-js/runtime';
import type { I18nUrlStrategy } from '../shared/urlStrategy';
import type { I18nRuntimeInstance } from './i18n';
import type { SdkBackend } from './i18n/backend/sdk-backend';
import { cacheUserLanguage } from './i18n/detection';
import {
  buildLocalizedUrl,
  detectLanguageFromPath,
  getEntryPath,
  shouldIgnoreRedirect,
} from './utils';

type Navigate = (
  url: string,
  options?: {
    replace?: boolean;
  },
) => Promise<void> | void;

type LocationLike = {
  pathname: string;
  search: string;
  hash: string;
};

export function getPathLanguage(
  pathname: string | undefined,
  languages: string[] | undefined,
  localePathRedirect: boolean | undefined,
): string | undefined {
  if (!localePathRedirect || !pathname) {
    return undefined;
  }

  const detected = detectLanguageFromPath(
    pathname,
    languages || [],
    localePathRedirect,
  );
  return detected.detected ? detected.language : undefined;
}

export function cacheI18nLanguage(
  i18nInstance: I18nRuntimeInstance,
  language: string,
) {
  if (isBrowser()) {
    const detectionOptions = i18nInstance.options?.detection;
    cacheUserLanguage(i18nInstance, language, detectionOptions);
  }
}

export async function changeI18nInstanceLanguage(
  i18nInstance: I18nRuntimeInstance,
  language: string,
): Promise<void> {
  if (i18nInstance.setLang) {
    await i18nInstance.setLang(language);
  } else {
    await i18nInstance.changeLanguage?.(language);
  }
}

interface ChangeModernI18nLanguageOptions {
  i18nInstance: I18nRuntimeInstance;
  updateLanguage?: (newLang: string) => void;
  localePathRedirect?: boolean;
  ignoreRedirectRoutes?: string[] | ((pathname: string) => boolean);
  urlStrategy?: I18nUrlStrategy;
  languages?: string[];
  hasRouter: boolean;
  navigate?: Navigate | null;
  location?: LocationLike | null;
}

export async function changeModernI18nLanguage(
  newLang: string,
  options: ChangeModernI18nLanguageOptions,
): Promise<void> {
  const {
    i18nInstance,
    updateLanguage,
    localePathRedirect,
    ignoreRedirectRoutes,
    urlStrategy,
    languages,
    hasRouter,
    navigate,
    location,
  } = options;

  try {
    if (!newLang || typeof newLang !== 'string') {
      throw new Error('Language must be non-empty string');
    }

    await changeI18nInstanceLanguage(i18nInstance, newLang);
    cacheI18nLanguage(i18nInstance, newLang);

    if (
      localePathRedirect &&
      isBrowser() &&
      hasRouter &&
      navigate &&
      location
    ) {
      const currentPath = location.pathname;
      const entryPath = getEntryPath();
      const relativePath = currentPath.replace(entryPath, '');
      const pathLanguage = detectLanguageFromPath(
        currentPath,
        languages || [],
        localePathRedirect,
      );

      if (pathLanguage.detected && pathLanguage.language === newLang) {
        updateLanguage?.(newLang);
        return;
      }

      if (
        !shouldIgnoreRedirect(
          relativePath,
          languages || [],
          ignoreRedirectRoutes,
          urlStrategy,
        )
      ) {
        const newPath = buildLocalizedUrl(
          relativePath,
          newLang,
          languages || [],
          urlStrategy,
        );
        const newUrl = entryPath + newPath + location.search + location.hash;

        await navigate(newUrl, { replace: true });
      }
    } else if (localePathRedirect && isBrowser() && !hasRouter) {
      const currentPath = window.location.pathname;
      const entryPath = getEntryPath();
      const relativePath = currentPath.replace(entryPath, '');
      const pathLanguage = detectLanguageFromPath(
        currentPath,
        languages || [],
        localePathRedirect,
      );

      if (pathLanguage.detected && pathLanguage.language === newLang) {
        updateLanguage?.(newLang);
        return;
      }

      if (
        !shouldIgnoreRedirect(
          relativePath,
          languages || [],
          ignoreRedirectRoutes,
          urlStrategy,
        )
      ) {
        const newPath = buildLocalizedUrl(
          relativePath,
          newLang,
          languages || [],
          urlStrategy,
        );
        const newUrl =
          entryPath + newPath + window.location.search + window.location.hash;

        window.history.pushState(null, '', newUrl);
      }
    }

    if (updateLanguage) {
      updateLanguage(newLang);
    }
  } catch (error) {
    console.error('Failed change language:', error);
    throw error;
  }
}

export function isI18nLanguageSupported(
  languages: string[] | undefined,
  lang: string,
): boolean {
  return languages?.includes(lang) || false;
}

export function isI18nResourcesReady(
  i18nInstance: I18nRuntimeInstance,
  currentLanguage: string,
): boolean {
  if (!i18nInstance?.isInitialized) {
    return false;
  }

  const backend = i18nInstance?.services?.backend as SdkBackend | undefined;
  if (backend && typeof backend.isLoading === 'function') {
    const loadingResources = backend.getLoadingResources();
    const isCurrentLanguageLoading = loadingResources.some(
      ({ language }) => language === currentLanguage,
    );
    if (isCurrentLanguageLoading) {
      return false;
    }
  }

  const store = i18nInstance.store;
  if (!store?.data) {
    return false;
  }

  const langData = store.data[currentLanguage];
  if (!langData || typeof langData !== 'object') {
    return false;
  }

  const options = i18nInstance.options;
  const namespaces = options?.ns || options?.defaultNS || ['translation'];
  const requiredNamespaces = Array.isArray(namespaces)
    ? namespaces
    : [namespaces];

  return requiredNamespaces.every(ns => {
    const nsData = langData[ns];
    return (
      nsData && typeof nsData === 'object' && Object.keys(nsData).length > 0
    );
  });
}
