import { isBrowser } from '@modern-js/runtime';
import type { BaseBackendOptions } from '../../shared/type';
import { mergeBackendOptions } from './backend';
import { HttpBackendWithSave, useI18nextBackend } from './backend/middleware';
import { SdkBackend } from './backend/sdk-backend';
import { cacheUserLanguage, mergeDetectionOptions } from './detection';
import type { I18nInitOptions, I18nRuntimeInstance } from './instance';
import {
  getActualI18nextInstance,
  isI18nInstance,
  isI18nWrapperInstance,
} from './instance';

type MergedBackendOptions = NonNullable<I18nInitOptions['backend']> & {
  _useChainedBackend?: boolean;
  _chainedBackendConfig?: {
    backendOptions: Array<Record<string, unknown>>;
  };
  backends?: unknown[];
  backendOptions?: unknown;
};

export function assertI18nInstance(
  obj: unknown,
): asserts obj is I18nRuntimeInstance {
  if (!isI18nInstance(obj)) {
    throw new Error('Object does not implement I18nRuntimeInstance interface');
  }
}

/**
 * Build initialization options for i18n instance
 */
export const buildInitOptions = async (
  finalLanguage: string,
  fallbackLanguage: string,
  languages: string[],
  mergedDetection: I18nInitOptions['detection'],
  mergedBackend: MergedBackendOptions | undefined,
  userInitOptions?: I18nInitOptions,
  useSuspense?: boolean,
  i18nInstance?: I18nRuntimeInstance,
): Promise<I18nInitOptions> => {
  const defaultUseSuspense =
    useSuspense !== undefined
      ? useSuspense
      : isBrowser()
        ? (userInitOptions?.react?.useSuspense ?? true)
        : false;

  // If backend is already configured via useI18nextBackend (has _useChainedBackend),
  // we need to pass the chained backend config to init() so it can initialize properly
  const isChainedBackend = !!mergedBackend?._useChainedBackend;

  // If using chained backend, we need to pass the backend config to init()
  // but exclude it from userInitOptions to avoid conflicts
  // For non-chained backend, we also exclude it to ensure mergedBackend is used
  const sanitizedUserInitOptions = userInitOptions
    ? { ...userInitOptions, backend: undefined }
    : undefined;

  // Build base initOptions first, excluding backend to set it separately
  const { backend: _removedBackend, ...userOptionsWithoutBackend } =
    sanitizedUserInitOptions || {};

  const initOptions: I18nInitOptions = {
    lng: finalLanguage,
    fallbackLng: fallbackLanguage,
    supportedLngs: languages,
    detection: mergedDetection,
    // Ensure resources are ready before first render unless user opts into async init.
    initImmediate: sanitizedUserInitOptions?.initImmediate ?? false,
    interpolation: {
      ...(sanitizedUserInitOptions?.interpolation || {}),
      escapeValue:
        sanitizedUserInitOptions?.interpolation?.escapeValue ?? false,
    },
    react: {
      ...(sanitizedUserInitOptions?.react || {}),
      useSuspense: defaultUseSuspense,
    },
    // Spread user options (without backend) to allow user options to override
    ...userOptionsWithoutBackend,
  };

  // For chained backend, we need to pass the backend config to init()
  // The backend classes (Backend, SdkBackend) are already set via useI18nextBackend
  // but we need to pass the complete chained backend config to init()
  // IMPORTANT: For i18next-chained-backend, we need to pass backends array in init() options
  // because ChainedBackend reads it from initOptions.backend.backends during initialization
  // IMPORTANT: For non-chained backend, we need to pass the backend config to init() so i18next
  // can load resources from the configured loadPath
  // IMPORTANT: Set backend config AFTER spreading user options to ensure it's not overridden
  if (mergedBackend) {
    if (isChainedBackend && mergedBackend._chainedBackendConfig) {
      // Try to get backend classes from i18nInstance.options.backend.backends first
      // This avoids importing fs-backend in browser environment
      let HttpBackend: unknown;
      let SdkBackendClass: unknown;

      if (
        i18nInstance?.options?.backend?.backends &&
        Array.isArray(i18nInstance.options.backend.backends) &&
        i18nInstance.options.backend.backends.length >= 2
      ) {
        // Use the backend classes already set by useI18nextBackend
        HttpBackend = i18nInstance.options.backend.backends[0];
        SdkBackendClass = i18nInstance.options.backend.backends[1];
      } else {
        // Fallback: use backend classes from middleware
        // Build tools will automatically select the correct file (.node.ts for Node.js, .ts for browser)
        // HttpBackendWithSave is exported from both middleware.ts (browser) and middleware.node.ts (Node.js)
        HttpBackend = HttpBackendWithSave;
        SdkBackendClass = SdkBackend;
      }

      // For chained backend, pass the complete chained backend config structure
      // Note: HttpBackend and SdkBackendClass are already wrapped
      // with save methods to ensure i18next-chained-backend's refresh logic is triggered
      initOptions.backend = {
        backends: [HttpBackend, SdkBackendClass],
        backendOptions: mergedBackend._chainedBackendConfig.backendOptions,
        cacheHitMode: mergedBackend.cacheHitMode || 'refreshAndUpdateStore',
      };
    } else {
      // For non-chained backend, pass the backend config directly
      // This ensures i18next can load resources from the configured loadPath
      // Remove internal properties (_useChainedBackend, _chainedBackendConfig) before passing to init()
      const { _useChainedBackend, _chainedBackendConfig, ...cleanBackend } =
        mergedBackend || {};
      initOptions.backend = cleanBackend;
    }
  }

  return initOptions;
};

/**
 * Ensure i18n instance language matches the final detected language
 */
export const ensureLanguageMatch = async (
  i18nInstance: I18nRuntimeInstance,
  finalLanguage: string,
): Promise<void> => {
  if (i18nInstance.language !== finalLanguage) {
    await i18nInstance.setLang?.(finalLanguage);
    await i18nInstance.changeLanguage?.(finalLanguage);
  }
};

/**
 * Change language for i18n instance in onBeforeRender hook
 * This function can be used by other runtime plugins to change language
 * @param i18nInstance - The i18n instance
 * @param newLang - The new language code to switch to
 * @param options - Optional configuration
 */
export const changeI18nLanguage = async (
  i18nInstance: I18nRuntimeInstance,
  newLang: string,
  options?: {
    detectionOptions?: I18nInitOptions['detection'];
  },
): Promise<void> => {
  if (!newLang || typeof newLang !== 'string') {
    throw new Error('Language must be a non-empty string');
  }

  if (!i18nInstance) {
    throw new Error('i18nInstance is required');
  }

  // Update i18n instance language
  await i18nInstance.setLang?.(newLang);
  await i18nInstance.changeLanguage?.(newLang);

  // Cache language in browser environment
  if (isBrowser()) {
    const detectionOptions =
      options?.detectionOptions || i18nInstance.options?.detection;
    cacheUserLanguage(i18nInstance, newLang, detectionOptions);
  }
};

/**
 * Initialize i18n instance if not already initialized
 */
export const initializeI18nInstance = async (
  i18nInstance: I18nRuntimeInstance,
  finalLanguage: string,
  fallbackLanguage: string,
  languages: string[],
  mergedDetection: I18nInitOptions['detection'],
  mergedBackend: MergedBackendOptions | undefined,
  userInitOptions?: I18nInitOptions,
  useSuspense?: boolean,
): Promise<void> => {
  if (!i18nInstance.isInitialized) {
    const initOptions = await buildInitOptions(
      finalLanguage,
      fallbackLanguage,
      languages,
      mergedDetection,
      mergedBackend,
      userInitOptions,
      useSuspense,
      i18nInstance,
    );

    // For i18next, backend configuration must be passed to init() via initOptions.backend
    // The backend class is already registered via useI18nextBackend, but the config (loadPath, etc.)
    // needs to be in initOptions.backend for init() to use it
    const actualInstance = getActualI18nextInstance(i18nInstance);
    const savedBackendConfig =
      actualInstance?.options?.backend || i18nInstance.options?.backend;
    const isChainedBackendFromSaved =
      savedBackendConfig?.backends &&
      Array.isArray(savedBackendConfig.backends);

    await i18nInstance.init(initOptions);

    if (mergedBackend) {
      if (isI18nWrapperInstance(i18nInstance) && actualInstance?.options) {
        if (isChainedBackendFromSaved && initOptions.backend) {
          actualInstance.options.backend = {
            ...initOptions.backend,
            backends: savedBackendConfig.backends,
          };
        } else if (initOptions.backend) {
          actualInstance.options.backend = {
            ...actualInstance.options.backend,
            ...initOptions.backend,
          };
        }
      }

      if (hasOptions(i18nInstance)) {
        if (isChainedBackendFromSaved && initOptions.backend) {
          i18nInstance.options.backend = {
            ...initOptions.backend,
            backends: savedBackendConfig.backends,
          };
        } else if (initOptions.backend) {
          i18nInstance.options.backend = {
            ...i18nInstance.options.backend,
            ...initOptions.backend,
          };
        }
      }
    }

    // i18next.init() is the synchronization boundary for the primary backend.
    // Chained SDK refreshes update the store through their own loaded events and
    // must not block SSR HTML, otherwise missing/edge-only resources add fixed
    // latency to every route render.
  }
};

/**
 * Type guard to check if i18n instance has options property
 */
function hasOptions(
  instance: I18nRuntimeInstance,
): instance is I18nRuntimeInstance & {
  options: NonNullable<I18nRuntimeInstance['options']>;
} {
  return instance.options !== undefined && instance.options !== null;
}

/**
 * Setup cloned instance for SSR with backend support
 */
export const setupClonedInstance = async (
  i18nInstance: I18nRuntimeInstance,
  finalLanguage: string,
  fallbackLanguage: string,
  languages: string[],
  backendEnabled: boolean,
  backend: BaseBackendOptions | undefined,
  i18nextDetector: boolean,
  detection: I18nInitOptions['detection'],
  localePathRedirect: boolean,
  userInitOptions: I18nInitOptions | undefined,
): Promise<void> => {
  const mergedBackend = mergeBackendOptions(backend, userInitOptions);
  // Check if SDK is configured (allows standalone SDK usage even without locales directory)
  const hasSdkConfig =
    typeof userInitOptions?.backend?.sdk === 'function' ||
    (mergedBackend?.sdk && typeof mergedBackend.sdk === 'function');

  if (backendEnabled || hasSdkConfig) {
    useI18nextBackend(i18nInstance, mergedBackend);
    if (mergedBackend && hasOptions(i18nInstance)) {
      i18nInstance.options.backend = {
        ...i18nInstance.options.backend,
        ...mergedBackend,
      };
    }

    if (i18nInstance.isInitialized) {
      await ensureLanguageMatch(i18nInstance, finalLanguage);
    } else {
      const mergedDetection = mergeDetectionOptions(
        i18nextDetector,
        detection,
        localePathRedirect,
        userInitOptions,
      );
      await initializeI18nInstance(
        i18nInstance,
        finalLanguage,
        fallbackLanguage,
        languages,
        mergedDetection,
        mergedBackend,
        userInitOptions,
        false, // SSR always uses false for useSuspense
      );
    }
  } else {
    if (!i18nInstance.isInitialized) {
      const mergedDetection = mergeDetectionOptions(
        i18nextDetector,
        detection,
        localePathRedirect,
        userInitOptions,
      );
      await initializeI18nInstance(
        i18nInstance,
        finalLanguage,
        fallbackLanguage,
        languages,
        mergedDetection,
        undefined,
        userInitOptions,
        false, // SSR always uses false for useSuspense
      );
    } else {
      await ensureLanguageMatch(i18nInstance, finalLanguage);
    }
  }
};
