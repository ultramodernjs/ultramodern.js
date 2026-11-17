import type { CloneOptions, InitOptions, i18n } from 'i18next';
import type { BaseBackendOptions } from '../../shared/type';

interface I18nResourceStore {
  data?: {
    [language: string]: {
      [namespace: string]: ResourceValue;
    };
  };
  addResourceBundle?: (
    language: string,
    namespace: string,
    resources: Record<string, string>,
    deep?: boolean,
    overwrite?: boolean,
  ) => void;
}

export function isI18nWrapperInstance(
  obj: unknown,
): obj is I18nWrapperInstance {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const candidate = obj as {
    i18nInstance?: unknown;
    init?: unknown;
    use?: unknown;
  };
  if (!candidate.i18nInstance || typeof candidate.i18nInstance !== 'object') {
    return false;
  }
  const wrapper = candidate.i18nInstance as { instance?: unknown };
  if (!wrapper.instance) {
    return false;
  }
  if (
    typeof candidate.init !== 'function' ||
    typeof candidate.use !== 'function'
  ) {
    return false;
  }
  return true;
}

/** The i18next instance that owns resources, detection and translation. */
export function getActualI18nextInstance(
  instance: I18nRuntimeInstance,
): I18nInstance {
  return isI18nWrapperInstance(instance)
    ? instance.i18nInstance.instance
    : instance;
}

// i18next's own `t`, so keys, overloads, selectors and the application's
// `CustomTypeOptions` augmentation follow the installed i18next release. A
// hand-written signature drifts on every i18next release (27 replaced the
// overloads with a rest-tuple union) and rejects strict-key and selector apps.
export type TranslateFn = i18n['t'];

// FORK: intentionally diverges from upstream @modern-js/plugin-i18n. Upstream
// declares a top-level `[key: string]: any` and overloaded call-signature
// properties; both make i18next's `i18n` structurally unassignable to this
// type, so the documented `i18nInstance: i18next` usage does not typecheck.
// Do NOT restore upstream's shape when resolving a sync merge.
export interface I18nInstance {
  language: string;
  isInitialized?: boolean;
  // Single non-overloaded method signatures. Method syntax is required for
  // bivariant parameter checking; a SINGLE signature is required because
  // overload bivariance is order-dependent across program compositions.
  init(options?: any, callback?: any): Promise<any>;
  changeLanguage?(lng?: string, callback?: any): Promise<any>;
  setLang?: (lang: string) => void | Promise<void>;
  use(plugin: any): unknown;
  t: TranslateFn;
  exists?: (
    key: string | string[],
    options?: Record<string, unknown>,
  ) => boolean;
  getFixedT?: i18n['getFixedT'];
  hasLoadedNamespace?: (
    ns: string | readonly string[],
    options?: Record<string, unknown>,
  ) => boolean;
  dir?: (lng?: string) => string;
  format?: (
    value: unknown,
    format?: string,
    lng?: string,
    options?: Record<string, unknown>,
  ) => string;
  // readonly: i18next declares `languages: readonly string[]`.
  languages?: readonly string[];
  resolvedLanguage?: string;
  loadNamespaces?: (
    ns: string | readonly string[],
    callback?: (...args: any[]) => void,
  ) => Promise<void>;
  loadLanguages?: (
    lngs: string | readonly string[],
    callback?: (...args: any[]) => void,
  ) => Promise<void>;
  addResourceBundle?: (
    lng: string,
    ns: string,
    resources: Record<string, unknown>,
    deep?: boolean,
    overwrite?: boolean,
  ) => unknown;
  getResourceBundle?: (lng: string, ns: string) => unknown;
  getDataByLanguage?: (
    lng: string,
  ) => Record<string, Record<string, string>> | undefined;
  createInstance?(options?: any, callback?: any): I18nInstance;
  cloneInstance?(options?: any, callback?: any): I18nInstance; // ssr need
  // i18next store (may not be in the type definition but exists at runtime)
  store?: I18nResourceStore;
  // i18next's own event API.
  on?: i18n['on'];
  off?: i18n['off'];
  emit?(event: string, ...args: any[]): unknown;
  reloadResources?(
    language?: any,
    namespace?: any,
    callback?: any,
  ): Promise<void>;
  removeResourceBundle?(language: string, namespace: string): I18nInstance;
  // No nested index signature: i18next's `Services` is an interface and would
  // fail "Index signature for type 'string' is missing".
  services?: {
    store?: unknown;
    languageDetector?: any;
    resourceStore?: I18nResourceStore;
    backend?: unknown; // Backend instance (e.g. SdkBackend)
  };
  // i18next instance options (available after initialization)
  options?: {
    detection?: any;
    backend?: any;
    ns?: any;
    defaultNS?: any;
  };
  // NO `[key: string]: unknown`. TypeScript never grants an interface an
  // implicit index signature, so any index signature here makes i18next's
  // `i18n` permanently unassignable. BREAKING for consumers that read
  // undeclared properties off I18nInstance.
}

/**
 * A custom instance owning a native i18next one at `i18nInstance.instance`.
 * The plugin initialises, switches and clones the wrapper, whose own `t` is
 * `useModernI18n<Wrapper>().t`; resources and detection use the native one.
 */
export interface I18nWrapperInstance
  extends Omit<
    I18nInstance,
    't' | 'on' | 'off' | 'cloneInstance' | 'createInstance'
  > {
  i18nInstance: { instance: I18nInstance };
  /** The wrapper's own translate API; it may differ from i18next's `t`. */
  t(key: string): string;
  on?(...args: Parameters<i18n['on']>): unknown;
  off?(...args: Parameters<i18n['off']>): unknown;
  // SSR clones the wrapper per request; detection may create or clone one.
  createInstance?(options?: InitOptions): I18nWrapperInstance;
  cloneInstance?(options?: CloneOptions): I18nWrapperInstance;
}

/** The instance a Modern app configures: i18next itself, or a wrapper of it. */
export type I18nRuntimeInstance = I18nInstance | I18nWrapperInstance;

type LanguageDetectorOrder = string[];
type LanguageDetectorCaches = boolean | string[];
export interface LanguageDetectorOptions {
  order?: LanguageDetectorOrder;
  lookupQuerystring?: string;
  lookupCookie?: string;
  lookupLocalStorage?: string;
  lookupSession?: string;
  lookupFromPathIndex?: number;
  caches?: LanguageDetectorCaches;
  cookieExpirationDate?: Date;
  cookieDomain?: string;
  lookupHeader?: string;
}

export interface BackendOptions extends Omit<BaseBackendOptions, 'enabled'> {
  parse?: (data: string) => unknown;
  stringify?: (data: unknown) => string;
  [key: string]: any;
}

type ResourceValue = string | { [key: string]: ResourceValue };

export interface Resources {
  [lng: string]: {
    [source: string]: ResourceValue;
  };
}

export type I18nInitOptions = {
  lng?: string;
  fallbackLng?: string;
  supportedLngs?: string[];
  initImmediate?: boolean;
  detection?: LanguageDetectorOptions;
  backend?: BackendOptions;
  resources?: Resources;
  ns?: string | string[];
  defaultNS?: string | string[];
  interpolation?: {
    escapeValue?: boolean;
    [key: string]: unknown;
  };
  react?: {
    useSuspense?: boolean;
    [key: string]: unknown;
  };
  forkResourceStore?: boolean;
};

export function isI18nInstance(obj: unknown): obj is I18nRuntimeInstance {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  if (isI18nWrapperInstance(obj)) {
    return true;
  }

  const candidate = obj as { init?: unknown; use?: unknown };
  return (
    typeof candidate.init === 'function' && typeof candidate.use === 'function'
  );
}

async function tryImportI18next(): Promise<I18nInstance | null> {
  try {
    const i18next = await import('i18next');
    return i18next.default;
  } catch (error) {
    return null;
  }
}

async function createI18nextInstance(): Promise<I18nInstance | null> {
  try {
    const i18next = await tryImportI18next();
    if (!i18next) {
      return null;
    }
    return (
      i18next.createInstance?.({
        initImmediate: false,
      }) ?? null
    );
  } catch (error) {
    return null;
  }
}

export function getI18nextInstanceForProvider(
  instance: I18nRuntimeInstance,
  language?: string,
): I18nInstance {
  const providerInstance = getActualI18nextInstance(instance);

  if (!language || typeof Proxy === 'undefined') {
    return providerInstance;
  }

  return new Proxy(providerInstance, {
    get(target, property, receiver) {
      if (property === 'language' || property === 'resolvedLanguage') {
        return language;
      }
      if (property === 'languages') {
        const languages = Reflect.get(target, property, receiver);
        return Array.isArray(languages)
          ? [language, ...languages.filter(item => item !== language)]
          : [language];
      }
      if (property === 't' && typeof target.getFixedT === 'function') {
        return target.getFixedT(language);
      }
      if (
        property === 'hasLoadedNamespace' &&
        typeof target.hasLoadedNamespace === 'function'
      ) {
        const hasLoadedNamespace = target.hasLoadedNamespace as (
          this: I18nInstance,
          namespace: string,
          options?: Record<string, unknown>,
        ) => boolean;
        return (namespace: string, options?: Record<string, unknown>) =>
          hasLoadedNamespace.call(target, namespace, {
            ...options,
            lng: options?.lng || language,
          });
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export async function getI18nInstance(
  userInstance?: unknown,
): Promise<I18nRuntimeInstance> {
  if (userInstance) {
    if (isI18nInstance(userInstance)) {
      return userInstance;
    }
  }

  const i18nextInstance = await createI18nextInstance();
  if (i18nextInstance) {
    return i18nextInstance;
  }

  throw new Error('No i18n instance found');
}
