import { type I18nRuntimeInstance, isI18nWrapperInstance } from '../instance';

import { detectLanguageFromI18nextDetector } from './detector';

import { mergeDetectionOptions } from './initOptions';
import { readLanguageFromStorage } from './middleware';
import { detectLanguageFromPathPriority } from './path';
import { detectLanguageFromSSR } from './ssr';

import type {
  LanguageDetectionOptions,
  LanguageDetectionResult,
} from './types';

/**
 * Detect language with priority:
 * Priority 1: Path detection
 * Priority 2: SSR data (try window._SSR_DATA first, works for both SSR and CSR)
 * Priority 3: i18next detector (reads from cookie/localStorage)
 * Priority 4: User config language or fallback
 */
export const detectLanguageWithPriority = async (
  i18nInstance: I18nRuntimeInstance,
  options: LanguageDetectionOptions,
): Promise<LanguageDetectionResult> => {
  const {
    languages,
    fallbackLanguage,
    localePathRedirect,
    i18nextDetector,
    detection,
    userInitOptions,
    pathname,
    ssrContext,
  } = options;

  let detectedLanguage: string | undefined;

  // Priority 1: Path detection. Explicit URL locale must win over stale
  // hydration data after client-side navigation.
  detectedLanguage = detectLanguageFromPathPriority(
    pathname,
    languages,
    localePathRedirect,
  );

  // Priority 2: Try SSR data when the current path has no explicit locale.
  if (!detectedLanguage) {
    detectedLanguage = detectLanguageFromSSR(languages);
  }

  // Priority 3: i18next detector (reads from cookie/localStorage)
  if (!detectedLanguage && i18nextDetector) {
    if (isI18nWrapperInstance(i18nInstance)) {
      detectedLanguage = readLanguageFromStorage(
        mergeDetectionOptions(
          i18nextDetector,
          detection,
          localePathRedirect,
          userInitOptions,
        ),
        ssrContext?.request,
        languages,
      );
    } else {
      detectedLanguage = await detectLanguageFromI18nextDetector(i18nInstance, {
        languages,
        fallbackLanguage,
        localePathRedirect,
        i18nextDetector,
        detection,
        userInitOptions,
        ssrContext,
      });
    }
  }

  // Priority 4: Use user config language or fallback
  const finalLanguage =
    detectedLanguage || userInitOptions?.lng || fallbackLanguage;

  return { detectedLanguage, finalLanguage };
};
