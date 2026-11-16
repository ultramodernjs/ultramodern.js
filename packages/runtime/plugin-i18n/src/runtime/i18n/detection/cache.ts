import type {
  I18nInitOptions,
  I18nRuntimeInstance,
  LanguageDetectorOptions,
} from '../instance';

interface DetectorCacheEntry {
  instance: I18nRuntimeInstance;
  isTemporary: boolean;
  configKey: string;
}

type DetectorCleanupInstance = I18nRuntimeInstance & {
  removeAllListeners?: () => void;
  off?: (event: string) => void;
  services?: I18nRuntimeInstance['services'] & {
    backendConnector?: {
      backend?: {
        stop?: () => void;
        close?: () => void;
      };
    };
  };
};

export const detectorInstanceCache = new WeakMap<
  I18nRuntimeInstance,
  DetectorCacheEntry
>();

const DETECTOR_SAFE_OPTION_KEYS: string[] = [
  'lowerCaseLng',
  'nonExplicitSupportedLngs',
  'load',
  'partialBundledLanguages',
  'returnNull',
  'returnEmptyString',
  'returnObjects',
  'joinArrays',
  'keySeparator',
  'nsSeparator',
  'pluralSeparator',
  'contextSeparator',
  'fallbackNS',
  'ns',
  'defaultNS',
  'debug',
];

/**
 * Stable stringify that sorts object keys to ensure consistent output
 * regardless of property order
 */
const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    // Arrays maintain their order
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  // For objects, sort keys and recursively stringify values
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const sortedEntries = sortedKeys.map(key => {
    const stringifiedValue = stableStringify(record[key]);
    return `${JSON.stringify(key)}:${stringifiedValue}`;
  });

  return `{${sortedEntries.join(',')}}`;
};

export const buildDetectorConfigKey = (
  languages: string[],
  fallbackLanguage: string,
  mergedDetection: LanguageDetectorOptions,
): string => {
  return stableStringify({
    languages,
    fallbackLanguage,
    detection: mergedDetection,
  });
};

export const pickSafeDetectionOptions = (
  userInitOptions?: I18nInitOptions,
): Partial<I18nInitOptions> & Record<string, unknown> => {
  if (!userInitOptions) {
    return {};
  }
  const safeOptions: Partial<I18nInitOptions> & Record<string, unknown> = {};
  for (const key of DETECTOR_SAFE_OPTION_KEYS) {
    const value = (userInitOptions as Record<string, unknown>)[key];
    if (value !== undefined) {
      safeOptions[key] = value;
    }
  }
  if (userInitOptions.interpolation) {
    safeOptions.interpolation = { ...userInitOptions.interpolation };
  }
  return safeOptions;
};

const cleanupDetectorCacheEntry = (entry?: DetectorCacheEntry) => {
  if (!entry || !entry.isTemporary) {
    return;
  }
  const instance = entry.instance as DetectorCleanupInstance;
  try {
    instance?.removeAllListeners?.();
  } catch (error) {
    void error;
  }
  try {
    instance?.off?.('*');
  } catch (error) {
    void error;
  }
  try {
    instance?.services?.backendConnector?.backend?.stop?.();
  } catch (error) {
    void error;
  }
  try {
    instance?.services?.backendConnector?.backend?.close?.();
  } catch (error) {
    void error;
  }
};

export const createDetectorInstance = (
  baseInstance: I18nRuntimeInstance,
  configKey: string,
): { instance: I18nRuntimeInstance; isTemporary: boolean } => {
  const cached = detectorInstanceCache.get(baseInstance);
  if (cached && cached.configKey === configKey) {
    return { instance: cached.instance, isTemporary: cached.isTemporary };
  }

  if (cached) {
    cleanupDetectorCacheEntry(cached);
    detectorInstanceCache.delete(baseInstance);
  }

  const createNewInstance = (): {
    instance: I18nRuntimeInstance;
    isTemporary: boolean;
  } => {
    if (typeof baseInstance.createInstance === 'function') {
      try {
        const created = baseInstance.createInstance();
        if (created) {
          return { instance: created, isTemporary: true };
        }
      } catch (error) {
        void error;
      }
    }

    if (typeof baseInstance.cloneInstance === 'function') {
      try {
        const cloned = baseInstance.cloneInstance();
        if (cloned) {
          return { instance: cloned, isTemporary: true };
        }
      } catch (error) {
        void error;
      }
    }

    return { instance: baseInstance, isTemporary: false };
  };

  const created = createNewInstance();
  if (created.isTemporary) {
    detectorInstanceCache.set(baseInstance, {
      instance: created.instance,
      isTemporary: true,
      configKey,
    });
  }
  return created;
};
