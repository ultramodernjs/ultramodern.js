import { isBrowser } from '@modern-js/runtime';
import type { I18nInitOptions, I18nRuntimeInstance } from '../instance';

import {
  buildDetectorConfigKey,
  createDetectorInstance,
  detectorInstanceCache,
  pickSafeDetectionOptions,
} from './cache';

import { mergeDetectionOptions } from './initOptions';

import { getSupportedLanguage } from './language';

import { detectLanguage, useI18nextLanguageDetector } from './middleware';

import type {
  BaseLanguageDetectionOptions,
  LanguageDetectionSsrContext,
} from './types';

/**
 * Initialize i18n instance for detector if needed
 */
interface DetectorInitResult {
  detectorInstance: I18nRuntimeInstance;
  isTemporary: boolean;
}

type MutableDetectorInstanceState = Omit<I18nRuntimeInstance, 'language'> & {
  language?: string;
};

const initializeI18nForDetector = async (
  i18nInstance: I18nRuntimeInstance,
  options: BaseLanguageDetectionOptions,
): Promise<DetectorInitResult> => {
  const mergedDetection = mergeDetectionOptions(
    options.i18nextDetector,
    options.detection,
    options.localePathRedirect,
    options.userInitOptions,
  );

  const configKey = buildDetectorConfigKey(
    options.languages,
    options.fallbackLanguage,
    mergedDetection,
  );

  const { instance, isTemporary } = createDetectorInstance(
    i18nInstance,
    configKey,
  );

  const safeUserOptions = pickSafeDetectionOptions(options.userInitOptions);

  // Only initialize detection capability, don't load resources to avoid conflicts with subsequent backend initialization
  const initOptions: I18nInitOptions = {
    ...safeUserOptions,
    fallbackLng: options.fallbackLanguage,
    supportedLngs: options.languages,
    detection: mergedDetection,
    initImmediate: true,
    interpolation: {
      ...(safeUserOptions?.interpolation || {}),
      escapeValue: safeUserOptions?.interpolation?.escapeValue ?? false,
    },
    react: {
      useSuspense: false,
    },
  };

  // Ensure the detector instance has the language detection plugin loaded
  useI18nextLanguageDetector(instance);

  if (!instance.isInitialized) {
    await instance.init(initOptions);
  } else if (isTemporary) {
    await instance.init(initOptions);
  }

  return { detectorInstance: instance, isTemporary };
};

/**
 * Priority 3: Detect language using i18next detector
 */
export const detectLanguageFromI18nextDetector = async (
  i18nInstance: I18nRuntimeInstance,
  options: BaseLanguageDetectionOptions & {
    ssrContext?: LanguageDetectionSsrContext;
  },
): Promise<string | undefined> => {
  if (!options.i18nextDetector) {
    return undefined;
  }

  // Merge detection options to pass to detector
  const mergedDetection = mergeDetectionOptions(
    options.i18nextDetector,
    options.detection,
    options.localePathRedirect,
    options.userInitOptions,
  );

  const { detectorInstance, isTemporary } = await initializeI18nForDetector(
    i18nInstance,
    options,
  );

  try {
    const request = options.ssrContext?.request;
    if (!isBrowser() && !request) {
      return undefined;
    }

    const detectorLang = detectLanguage(
      detectorInstance,
      request,
      mergedDetection,
    );

    // Use getSupportedLanguage to get the matching supported language
    // This handles both exact match and base language code match (e.g., 'zh-CN' -> 'zh')
    if (detectorLang) {
      const supportedLang = getSupportedLanguage(
        detectorLang,
        options.languages,
      );
      if (supportedLang) {
        return supportedLang;
      }
    }

    // Fallback to instance's current language if detector didn't detect
    if (detectorInstance.isInitialized && detectorInstance.language) {
      const currentLang = detectorInstance.language;
      if (getSupportedLanguage(currentLang, options.languages)) {
        return currentLang;
      }
    }
  } catch (error) {
    // Silently ignore errors
  } finally {
    // Clean up temporary instance to avoid affecting subsequent formal initialization
    if (isTemporary && detectorInstance !== i18nInstance) {
      // Temporary instance is saved in cache for reuse
      detectorInstanceCache.set(i18nInstance, {
        instance: detectorInstance,
        isTemporary: true,
        configKey: buildDetectorConfigKey(
          options.languages,
          options.fallbackLanguage,
          mergedDetection,
        ),
      });
    } else if (detectorInstance === i18nInstance) {
      // As a fallback, prevent i18nInstance from being polluted by detector init
      i18nInstance.isInitialized = false;
      delete (i18nInstance as unknown as MutableDetectorInstanceState).language;
    }
  }

  return undefined;
};
