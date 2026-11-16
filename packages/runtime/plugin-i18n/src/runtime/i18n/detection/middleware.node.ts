import { LanguageDetector } from 'i18next-http-middleware';
import { detectLanguageFromRequest } from '../../../shared/detection.js';
import type { I18nRuntimeInstance, LanguageDetectorOptions } from '../instance';

type HttpDetectorInit = (
  services: NonNullable<I18nRuntimeInstance['services']>,
  options?: unknown,
  allOptions?: unknown,
) => void;

type HttpDetectorDetect = (
  request: unknown,
  response: unknown,
  detectionOrder?: unknown,
) => string | string[] | undefined;

type DetectionRequest = Parameters<typeof detectLanguageFromRequest>[0];

const isDetectionRequest = (request: unknown): request is DetectionRequest => {
  if (!request || typeof request !== 'object') {
    return false;
  }

  const { url, headers } = request as {
    url?: unknown;
    headers?: unknown;
  };
  return typeof url === 'string' && !!headers && typeof headers === 'object';
};

export const cacheUserLanguage = (
  _i18nInstance: I18nRuntimeInstance,
  _language: string,
  _detectionOptions?: unknown,
): void => {
  return;
};

export const readLanguageFromStorage = (
  detectionOptions?: LanguageDetectorOptions,
  request?: unknown,
  languages: string[] = [],
): string | undefined => {
  if (!isDetectionRequest(request)) {
    return undefined;
  }

  return (
    detectLanguageFromRequest(request, languages, detectionOptions) ?? undefined
  );
};
/**
 * Register LanguageDetector plugin to i18n instance
 * Must be called before init() to properly register the detector
 */
export const useI18nextLanguageDetector = (
  i18nInstance: I18nRuntimeInstance,
) => {
  if (!i18nInstance.isInitialized) {
    return i18nInstance.use(LanguageDetector);
  }
  return i18nInstance;
};

/**
 * Detect language using i18next-http-middleware LanguageDetector
 * For initialized instances without detector in services, manually create a detector instance
 */
export const detectLanguage = (
  i18nInstance: I18nRuntimeInstance,
  request?: unknown,
  detectionOptions?: LanguageDetectorOptions,
): string | undefined => {
  if (!request) {
    return undefined;
  }

  try {
    const detector = i18nInstance.services?.languageDetector;
    if (detector && typeof detector.detect === 'function') {
      const result = detector.detect(request, {});
      if (typeof result === 'string') {
        return result;
      }
      if (Array.isArray(result) && result.length > 0) {
        return result[0];
      }
      return undefined;
    }

    if (
      i18nInstance.isInitialized &&
      i18nInstance.services &&
      i18nInstance.options
    ) {
      const manualDetector = new LanguageDetector();
      const optionsToUse = detectionOptions
        ? { ...i18nInstance.options, detection: detectionOptions }
        : i18nInstance.options;
      (manualDetector.init as unknown as HttpDetectorInit)(
        i18nInstance.services,
        optionsToUse,
      );

      const result = (manualDetector.detect as unknown as HttpDetectorDetect)(
        request,
        {},
        undefined,
      );
      if (typeof result === 'string') {
        return result;
      }
      if (Array.isArray(result) && result.length > 0) {
        return result[0];
      }
      return undefined;
    }
  } catch (error) {
    return undefined;
  }

  return undefined;
};
