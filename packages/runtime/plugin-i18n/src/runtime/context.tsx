import { RuntimeComponentResolverContext } from '@modern-js/runtime/context';
import type { ComponentType, FC, ReactNode } from 'react';
import { useCallback, useContext, useEffect, useMemo } from 'react';
import type { I18nUrlStrategy } from '../shared/urlStrategy';
import {
  changeModernI18nLanguage,
  getPathLanguage,
  isI18nLanguageSupported,
  isI18nResourcesReady,
} from './contextHelpers';
import type { I18nRuntimeInstance } from './i18n';
import { getActualI18nextInstance, type Resources } from './i18n/instance';

import { useI18nRouterAdapter } from './routerAdapter';
import {
  ModernI18nContext,
  ReactI18nextProviderContext,
} from './sharedContexts';

export { getActualI18nextInstance };

export interface ModernI18nContextValue {
  language: string;
  i18nInstance: I18nRuntimeInstance;
  // Plugin configuration for useModernI18n hook
  entryName?: string;
  languages?: string[];
  localePathRedirect?: boolean;
  ignoreRedirectRoutes?: string[] | ((pathname: string) => boolean);
  urlStrategy?: I18nUrlStrategy;
  // Callback to update language in context
  updateLanguage?: (newLang: string) => void;
  synchronizeLanguage?: (newLang: string) => void;
}

export { ModernI18nContext, ReactI18nextProviderContext };

export interface ModernI18nProviderProps {
  children: ReactNode;
  i18nextProvider?: ComponentType<any> | null;
  value: ModernI18nContextValue;
}

export const ModernI18nProvider: FC<ModernI18nProviderProps> = ({
  children,
  i18nextProvider,
  value,
}) => {
  const content = (
    <ModernI18nContext.Provider value={value}>
      {children}
    </ModernI18nContext.Provider>
  );
  return i18nextProvider === undefined ? (
    content
  ) : (
    <ReactI18nextProviderContext.Provider value={i18nextProvider}>
      {content}
    </ReactI18nextProviderContext.Provider>
  );
};

export interface FederatedI18nBoundaryProps {
  children: ReactNode;
  defaultNamespace: string;
  fallbackLanguage?: string;
  resources: Resources;
  supportedLanguages?: string[];
}

const MissingFederatedI18nBoundary: FC<FederatedI18nBoundaryProps> = () => {
  throw new Error(
    'FederatedI18nBoundary requires the @modern-js/i18n-integration runtime plugin',
  );
};

export const FederatedI18nBoundary: FC<FederatedI18nBoundaryProps> = props => {
  const resolveComponent = useContext(RuntimeComponentResolverContext);
  const Boundary =
    resolveComponent?.(MissingFederatedI18nBoundary, {
      name: 'i18n.FederatedI18nBoundary',
    }) ?? MissingFederatedI18nBoundary;
  if (Boundary === FederatedI18nBoundary) {
    throw new Error('FederatedI18nBoundary resolver returned its own wrapper');
  }
  return <Boundary {...props} />;
};

export interface UseModernI18nReturn<
  TInstance extends I18nRuntimeInstance = I18nRuntimeInstance,
> {
  language: string;
  changeLanguage: (newLang: string) => Promise<void>;
  /**
   * The configured instance's own `t`, bound to it: i18next's `t` for an
   * i18next instance, the wrapper's translate API for a wrapper.
   */
  t: OmitThisParameter<TInstance['t']>;
  i18nInstance: TInstance;
  supportedLanguages: string[];
  urlStrategy?: I18nUrlStrategy;
  isLanguageSupported: (lang: string) => boolean;
  // Indicates whether translation resources for current language are ready
  isResourcesReady: boolean;
}

/**
 * Hook for accessing i18n functionality in Modern.js applications.
 *
 * This hook provides:
 * - Current language from URL params or i18n context
 * - changeLanguage function that updates both i18n instance and URL
 * - Direct access to i18n instance
 * - List of supported languages
 * - Helper function to check if language is supported
 *
 * Without a type argument, `i18nInstance` and `t` are typed for whichever
 * instance the provider holds (`I18nRuntimeInstance`). The type argument
 * (e.g. `useModernI18n<I18nInstance>()` for i18next itself, or a wrapper
 * type) is a caller assertion that the overload records; it is not verified
 * at runtime. Pass it only when you know which instance the provider was given.
 * @returns Object containing i18n functionality and utilities
 */
export function useModernI18n(): UseModernI18nReturn;
export function useModernI18n<
  TInstance extends I18nRuntimeInstance,
>(): UseModernI18nReturn<TInstance>;
export function useModernI18n(): UseModernI18nReturn {
  const context = useContext(ModernI18nContext);
  if (!context) {
    throw new Error('useModernI18n must be used within ModernI18nProvider');
  }

  const {
    language: contextLanguage,
    i18nInstance,
    languages,
    localePathRedirect,
    ignoreRedirectRoutes,
    urlStrategy,
    updateLanguage,
    synchronizeLanguage,
  } = context;

  const { navigate, location, hasRouter } = useI18nRouterAdapter();

  const pathLanguage = useMemo(
    () => getPathLanguage(location?.pathname, languages, localePathRedirect),
    [languages, localePathRedirect, location?.pathname],
  );

  useEffect(() => {
    if (pathLanguage) {
      synchronizeLanguage?.(pathLanguage);
    }
  }, [pathLanguage, synchronizeLanguage]);

  const currentLanguage = contextLanguage;

  /**
   * Changes the current language and updates URL accordingly.
   *
   * This function:
   * 1. Updates i18n instance language
   * 2. Updates URL by replacing language prefix in the current path
   * 3. Triggers navigation to the new URL
   *
   * @param newLang - The new language code to switch to
   */
  const changeLanguage = useCallback(
    (newLang: string) =>
      changeModernI18nLanguage(newLang, {
        i18nInstance,
        updateLanguage,
        localePathRedirect,
        ignoreRedirectRoutes,
        urlStrategy,
        languages,
        hasRouter,
        navigate,
        location,
      }),
    [
      i18nInstance,
      updateLanguage,
      localePathRedirect,
      ignoreRedirectRoutes,
      urlStrategy,
      languages,
      hasRouter,
      navigate,
      location,
    ],
  );

  // The configured instance's own `t`, bound so a destructured `t` keeps its
  // receiver: a wrapper's translate API stays in charge of its output. A new
  // function per language lets memoized consumers re-render on switch.
  const t = useMemo(
    () => i18nInstance.t.bind(i18nInstance),
    [currentLanguage, i18nInstance],
  );

  // Helper function to check if language is supported
  const isLanguageSupported = useCallback(
    (lang: string) => isI18nLanguageSupported(languages, lang),
    [languages],
  );

  // Check if current language resources are ready
  // This checks if all required namespaces for current language are loaded
  const isResourcesReady = useMemo(
    () => isI18nResourcesReady(i18nInstance, currentLanguage),
    [currentLanguage, i18nInstance],
  );

  return {
    language: currentLanguage,
    changeLanguage,
    t,
    i18nInstance,
    supportedLanguages: languages || [],
    urlStrategy,
    isLanguageSupported,
    isResourcesReady,
  };
}
