import { isBrowser } from '@modern-js/runtime';
import type { TInternalRuntimeContext } from '@modern-js/runtime/internal';
import { merge } from '@modern-js/runtime-utils/merge';
import type {
  BaseBackendOptions,
  BaseLocaleDetectionOptions,
} from '../shared/type';
import type { I18nInitOptions, I18nInstance } from './i18n';
import { mergeBackendOptions } from './i18n/backend';
import {
  detectLanguageWithPriority,
  exportServerLngToWindow,
  mergeDetectionOptions,
} from './i18n/detection';
import { useI18nextLanguageDetector } from './i18n/detection/middleware';
import { getI18nInstance } from './i18n/instance';
import type { ReactI18nextIntegration } from './reactI18next';
import { getPathname } from './utils';

type I18nLifecycleHelpers = {
  useI18nextBackend: typeof import('./i18n/backend/middleware')['useI18nextBackend'];
  changeI18nLanguage: typeof import('./i18n/utils')['changeI18nLanguage'];
  ensureLanguageMatch: typeof import('./i18n/utils')['ensureLanguageMatch'];
  initializeI18nInstance: typeof import('./i18n/utils')['initializeI18nInstance'];
  setupClonedInstance: typeof import('./i18n/utils')['setupClonedInstance'];
};

let i18nLifecycleHelpersPromise: Promise<I18nLifecycleHelpers> | undefined;

function loadI18nLifecycleHelpers(): Promise<I18nLifecycleHelpers> {
  i18nLifecycleHelpersPromise ??= Promise.all([
    import('./i18n/backend/middleware'),
    import('./i18n/utils'),
  ]).then(([backendMiddleware, utils]) => ({
    useI18nextBackend: backendMiddleware.useI18nextBackend,
    changeI18nLanguage: utils.changeI18nLanguage,
    ensureLanguageMatch: utils.ensureLanguageMatch,
    initializeI18nInstance: utils.initializeI18nInstance,
    setupClonedInstance: utils.setupClonedInstance,
  }));

  return i18nLifecycleHelpersPromise;
}

interface RuntimeConfigWithI18n {
  i18n?: {
    initOptions?: I18nInitOptions;
  };
}

interface I18nRuntimeApi {
  getRuntimeConfig: () => RuntimeConfigWithI18n;
}

export interface RuntimeContextWithI18n extends TInternalRuntimeContext {
  i18nInstance?: I18nInstance;
  changeLanguage?: (lang: string) => Promise<void>;
}

interface SetupI18nBeforeRenderOptions {
  api: I18nRuntimeApi;
  userI18nInstance?: I18nInstance;
  initOptions?: I18nInitOptions;
  backend?: BaseBackendOptions;
  backendEnabled: boolean;
  i18nextDetector: boolean;
  detection?: BaseLocaleDetectionOptions['detection'];
  localePathRedirect: boolean;
  languages: string[];
  fallbackLanguage: string;
  resolveReactI18nextIntegration: () => Promise<ReactI18nextIntegration | null>;
  setI18nextProvider: (
    provider: ReactI18nextIntegration['I18nextProvider'],
  ) => void;
}

export async function setupI18nBeforeRender(
  context: RuntimeContextWithI18n,
  options: SetupI18nBeforeRenderOptions,
): Promise<I18nInstance> {
  const {
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
    resolveReactI18nextIntegration,
    setI18nextProvider,
  } = options;
  const {
    useI18nextBackend,
    changeI18nLanguage,
    ensureLanguageMatch,
    initializeI18nInstance,
    setupClonedInstance,
  } = await loadI18nLifecycleHelpers();
  let i18nInstance = await getI18nInstance(userI18nInstance);
  const { i18n: otherConfig } = api.getRuntimeConfig();
  const { initOptions: otherInitOptions } = otherConfig || {};
  const userInitOptions = merge(otherInitOptions || {}, initOptions || {});

  const reactI18nextIntegration = await resolveReactI18nextIntegration();
  setI18nextProvider(reactI18nextIntegration?.I18nextProvider ?? null);
  if (reactI18nextIntegration?.initReactI18next) {
    i18nInstance.use(reactI18nextIntegration.initReactI18next);
  }

  const pathname = getPathname(context);
  if (i18nextDetector) {
    useI18nextLanguageDetector(i18nInstance);
  }

  const mergedDetection = mergeDetectionOptions(
    i18nextDetector,
    detection,
    localePathRedirect,
    userInitOptions,
  );
  const mergedBackend = mergeBackendOptions(backend, userInitOptions);

  // Register Backend BEFORE detectLanguageWithPriority because detection may init.
  const hasSdkConfig =
    typeof userInitOptions?.backend?.sdk === 'function' ||
    (mergedBackend?.sdk && typeof mergedBackend.sdk === 'function');
  if (mergedBackend && (backendEnabled || hasSdkConfig)) {
    useI18nextBackend(i18nInstance, mergedBackend);
  }

  const { finalLanguage } = await detectLanguageWithPriority(i18nInstance, {
    languages,
    fallbackLanguage,
    localePathRedirect,
    i18nextDetector,
    detection,
    userInitOptions,
    pathname,
    ssrContext: context.ssrContext,
  });

  await initializeI18nInstance(
    i18nInstance,
    finalLanguage,
    fallbackLanguage,
    languages,
    mergedDetection,
    mergedBackend,
    userInitOptions,
  );

  if (!isBrowser() && i18nInstance.cloneInstance) {
    i18nInstance = i18nInstance.cloneInstance();
    await setupClonedInstance(
      i18nInstance,
      finalLanguage,
      fallbackLanguage,
      languages,
      backendEnabled,
      backend,
      i18nextDetector,
      detection,
      localePathRedirect,
      userInitOptions,
    );
  }

  if (localePathRedirect) {
    await ensureLanguageMatch(i18nInstance, finalLanguage);
  }

  if (!isBrowser()) {
    exportServerLngToWindow(context, finalLanguage);
  }
  context.i18nInstance = i18nInstance;

  // Add changeLanguage method to context for other runtime plugins to use.
  context.changeLanguage = async (newLang: string) => {
    await changeI18nLanguage(i18nInstance, newLang, {
      detectionOptions: mergedDetection,
    });
  };

  return i18nInstance;
}
