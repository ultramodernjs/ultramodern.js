import type {
  NativeEntryI18n,
  NativeI18nResources,
} from '@modern-js/renderer-core/entry-server';
import type { LocalisedUrlsOption } from '@modern-js/runtime-extensions/localised-urls';
import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type InitOptions,
  type Module,
  type NewableModule,
} from 'i18next';
import { createLatestLanguageSyncBinding } from './language-sync/controller';
import {
  createRequestLanguageRedirect,
  languageFromPathname,
  type ResolveRequestLanguageOptions,
  resolveRequestLanguage,
} from './requestLanguage';
import {
  createI18nSsrHandoffInlineData,
  readI18nSsrHandoff,
} from './ssrLanguageHandoff';
import { createI18nUrlRewrite } from './urlRewrite';

export type { I18nInstance };

interface NativeSnapshotOrigin {
  instance: I18nInstance;
  original: InitOptions;
  seed: InitOptions;
  unchanged(): boolean;
}

const nativeSnapshotOrigins = new WeakMap<object, NativeSnapshotOrigin>();

/** Retire the native proof when its owning request or plugin contract ends. */
export function invalidateNativeI18nSnapshot(instance: unknown): void {
  if (typeof instance === 'object' && instance !== null)
    nativeSnapshotOrigins.delete(instance);
}

export interface NativeI18nRewriteSnapshot {
  language: string;
  languages: readonly string[];
  localisedUrls?: LocalisedUrlsOption;
}

const nativeRewriteOrigins = new WeakMap<
  object,
  () => NativeI18nRewriteSnapshot
>();

/** Only rewrites created by the native entry have a portable routing profile. */
export function getNativeI18nRewriteSnapshot(
  rewrite: unknown,
): NativeI18nRewriteSnapshot | undefined {
  return typeof rewrite === 'object' && rewrite !== null
    ? nativeRewriteOrigins.get(rewrite)?.()
    : undefined;
}

function detachLocalisedUrls(
  value: LocalisedUrlsOption | undefined,
): LocalisedUrlsOption | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  return Object.fromEntries(
    Object.entries(value).map(([path, languages]) => [
      path,
      Object.fromEntries(Object.entries(languages)),
    ]),
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/** Detach authored options without executing accessors or copying class state. */
function detachOption(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (
    ancestors.has(value) ||
    (Array.isArray(value)
      ? Object.getPrototypeOf(value) !== Array.prototype
      : !plainRecord(value))
  )
    throw new Error('Native i18n snapshot options must be plain acyclic data');
  ancestors.add(value);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
      throw new Error('Native i18n snapshot options cannot contain accessors');
    Object.defineProperty(copy, key, {
      value: detachOption(descriptor.value, ancestors),
      enumerable: descriptor.enumerable,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(value);
  return copy;
}

function detachInitOptions(options: InitOptions): InitOptions {
  const copy = detachOption(options);
  if (!plainRecord(copy)) throw new Error('Invalid native i18n options');
  return copy;
}

/** Compare descriptors, including native default functions, without calling them. */
function descriptorProof(
  object: object,
  ignore: ReadonlySet<string> = new Set(),
  ancestors = new Set<object>(),
): () => boolean {
  if (ancestors.has(object)) return () => true;
  ancestors.add(object);
  const keys = Reflect.ownKeys(object).filter(
    key => typeof key !== 'string' || !ignore.has(key),
  );
  const proofs = keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor))
      throw new Error(
        'Native i18n snapshot provenance cannot contain accessors',
      );
    const value: unknown = descriptor.value;
    const nested =
      Array.isArray(value) || plainRecord(value)
        ? descriptorProof(value, new Set(), ancestors)
        : () => true;
    return () => {
      const current = Object.getOwnPropertyDescriptor(object, key);
      return (
        current !== undefined &&
        'value' in current &&
        current.value === value &&
        current.enumerable === descriptor.enumerable &&
        current.configurable === descriptor.configurable &&
        current.writable === descriptor.writable &&
        nested()
      );
    };
  });
  ancestors.delete(object);
  return () => {
    const currentKeys = Reflect.ownKeys(object).filter(
      key => typeof key !== 'string' || !ignore.has(key),
    );
    return (
      currentKeys.length === keys.length &&
      currentKeys.every((key, index) => key === keys[index]) &&
      proofs.every(proof => proof())
    );
  };
}

function methodProof(object: object): () => boolean {
  const prototype = Object.getPrototypeOf(object);
  const methods = new Map<PropertyKey, unknown>();
  for (
    let current: object | null = object;
    current && current !== Object.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor)) continue;
      if (typeof descriptor.value === 'function' && !methods.has(key))
        methods.set(key, descriptor.value);
    }
  }
  return () => {
    if (Object.getPrototypeOf(object) !== prototype) return false;
    for (const [key, method] of methods) {
      let current: object | null = object;
      while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) {
          if (!('value' in descriptor) || descriptor.value !== method)
            return false;
          break;
        }
        current = Object.getPrototypeOf(current);
      }
      if (!current) return false;
    }
    return true;
  };
}

function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !('value' in descriptor))
    throw new Error('Native i18n snapshot provenance cannot contain accessors');
  return descriptor?.value;
}

function semanticProof(
  object: object,
  fields: readonly string[],
): () => boolean {
  const proofs = fields.map(key => {
    const value = ownValue(object, key);
    const nested =
      Array.isArray(value) || plainRecord(value)
        ? descriptorProof(value, new Set(['resources']))
        : () => true;
    if (value instanceof RegExp) {
      const source = value.source;
      const flags = value.flags;
      return () => {
        const current = ownValue(object, key);
        return (
          current instanceof RegExp &&
          current.source === source &&
          current.flags === flags
        );
      };
    }
    return () => ownValue(object, key) === value && nested();
  });
  return () => proofs.every(proof => proof());
}

function recordNativeSnapshotOrigin(
  instance: I18nInstance,
  original: InitOptions,
  seed: InitOptions,
) {
  try {
    const useDescriptor = Object.getOwnPropertyDescriptor(instance, 'use');
    if (!useDescriptor || !('value' in useDescriptor))
      throw new Error('Native plugin registration requires an own method');
    const use = instance.use;
    Object.defineProperty(instance, 'use', {
      ...useDescriptor,
      value: function registerPlugin<T extends Module>(
        plugin: T | NewableModule<T>,
      ) {
        // Postprocessors register globally without appearing in `modules`.
        // Record the public registration call instead of reading that registry.
        invalidateNativeI18nSnapshot(instance);
        return use(plugin);
      },
    });
    const services: object = instance.services;
    const store = instance.store;
    const options = instance.options;
    const modules = instance.modules;
    const translator: unknown = Object.getOwnPropertyDescriptor(
      instance,
      'translator',
    )?.value;
    const formatter: unknown = instance.services.formatter;
    const formats: unknown =
      formatter && typeof formatter === 'object'
        ? Object.getOwnPropertyDescriptor(formatter, 'formats')?.value
        : undefined;
    const proofs = [
      descriptorProof(instance.options, new Set(['resources'])),
      descriptorProof(instance.modules),
      descriptorProof(services),
      methodProof(instance),
      methodProof(instance.store),
      ...Object.values(instance.services)
        .filter(value => typeof value === 'object' && value !== null)
        .map(value => methodProof(value)),
      ...(translator && typeof translator === 'object'
        ? [methodProof(translator)]
        : []),
      ...(formats && typeof formats === 'object'
        ? [descriptorProof(formats)]
        : []),
    ];
    const serviceFields: Record<string, readonly string[]> = {
      languageUtils: ['options', 'supportedLngs'],
      pluralResolver: ['languageUtils', 'options'],
      interpolator: [
        'options',
        'escape',
        'escapeValue',
        'useRawValueToEscape',
        'prefix',
        'suffix',
        'format',
        'formatSeparator',
        'unescapePrefix',
        'unescapeSuffix',
        'nestingPrefix',
        'nestingSuffix',
        'nestingOptionsSeparator',
        'maxReplaces',
        'alwaysFormat',
        'regexp',
        'regexpUnescape',
        'nestingRegexp',
      ],
      formatter: ['formatSeparator'],
      resourceStore: ['options'],
      backendConnector: ['backend', 'store', 'services', 'options'],
    };
    const links = Object.entries(instance.services).map(([key, value]) => {
      if (typeof value === 'object' && value !== null)
        proofs.push(semanticProof(value, serviceFields[key] ?? []));
      return () => ownValue(services, key) === value;
    });
    if (translator && typeof translator === 'object')
      proofs.push(
        semanticProof(translator, [
          'options',
          'resourceStore',
          'languageUtils',
          'pluralResolver',
          'interpolator',
          'backendConnector',
          'i18nFormat',
          'utils',
        ]),
      );
    nativeSnapshotOrigins.set(instance, {
      instance,
      original: detachInitOptions(original),
      seed: detachInitOptions(seed),
      unchanged: () =>
        ownValue(instance, 'services') === services &&
        ownValue(instance, 'store') === store &&
        ownValue(instance, 'options') === options &&
        ownValue(instance, 'modules') === modules &&
        ownValue(services, 'formatter') === formatter &&
        (formatter && typeof formatter === 'object'
          ? ownValue(formatter, 'formats') === formats
          : true) &&
        Object.getOwnPropertyDescriptor(instance, 'translator')?.value ===
          translator &&
        (translator && typeof translator === 'object'
          ? ownValue(translator, 'language') === ownValue(instance, 'language')
          : true) &&
        links.every(proof => proof()) &&
        proofs.every(proof => proof()),
    });
  } catch {
    // Existing native applications may use opaque options. They need a named
    // Worker profile, while ordinary rendering keeps its existing behavior.
  }
}

/** A real fully bundled instance for request-local synchronous providers. */
export function createNativeI18nInstance(
  initOptions: InitOptions,
): I18nInstance {
  const original = detachInitOptions(initOptions);
  const seed: InitOptions = {
    ...detachInitOptions(original),
    initAsync: false,
    partialBundledLanguages: false,
    interpolation: { escapeValue: false, ...original.interpolation },
  };
  const instance = i18next.createInstance();
  void instance.init(detachInitOptions(seed));
  if (!instance.isInitialized || instance.isInitializing)
    throw new Error('Native i18n instances require complete bundled resources');
  recordNativeSnapshotOrigin(instance, original, seed);
  return instance;
}

/** The original effective seed, only while the initialized native proof holds. */
export function getNativeI18nSnapshotSeed(instance: unknown): InitOptions {
  const origin =
    typeof instance === 'object' && instance !== null
      ? nativeSnapshotOrigins.get(instance)
      : undefined;
  const services = origin ? ownValue(origin.instance, 'services') : undefined;
  const connector =
    services && typeof services === 'object'
      ? ownValue(services, 'backendConnector')
      : undefined;
  const state =
    connector && typeof connector === 'object'
      ? ownValue(connector, 'state')
      : undefined;
  const pending =
    plainRecord(state) &&
    Object.values(Object.getOwnPropertyDescriptors(state)).some(
      descriptor => !('value' in descriptor) || descriptor.value === 1,
    );
  if (
    !origin ||
    ownValue(origin.instance, 'isInitialized') !== true ||
    ownValue(origin.instance, 'isInitializing') === true ||
    ownValue(origin.instance, 'isLanguageChangingTo') ||
    pending ||
    !origin.unchanged()
  )
    throw new Error('This i18n instance requires an explicit Worker profile');
  return detachInitOptions(origin.seed);
}

export interface NativeI18nOptions extends ResolveRequestLanguageOptions {
  /**
   * JSON-serializable i18next `init` options. `lng`, `fallbackLng`,
   * `supportedLngs`, `resources` and `ns` are owned by the native entry.
   */
  initOptions?: InitOptions;
}

/** language -> namespace -> lazily imported translation bundle. */
export type NativeI18nLoaders = Readonly<
  Record<string, Readonly<Record<string, () => Promise<unknown>>>>
>;

export type NativeI18n = NativeEntryI18n<I18nInstance, LocalisedUrlsOption>;

function unwrapResource(module: unknown): Record<string, unknown> {
  const resource =
    typeof module === 'object' && module !== null && 'default' in module
      ? module.default
      : module;
  return resource as Record<string, unknown>;
}

/**
 * The localized routing and per-request i18next instances of a native
 * Solid or Octane entry. Each language's bundles load on demand; an instance
 * is never a module singleton.
 */
export function createNativeI18n(
  options: NativeI18nOptions,
  loaders: NativeI18nLoaders,
): NativeI18n {
  const { initOptions = {}, ...routing } = options;
  const namespaces = [
    ...new Set(Object.values(loaders).flatMap(Object.keys)),
  ].sort();
  const defaultNamespace =
    typeof initOptions.defaultNS === 'string'
      ? initOptions.defaultNS
      : namespaces.includes('translation')
        ? 'translation'
        : (namespaces[0] ?? 'translation');
  const cookie = routing.detection?.lookupCookie ?? 'i18next';
  const backend: BackendModule = {
    type: 'backend',
    init() {},
    read(language, namespace, callback) {
      // Own keys only: `constructor` or `__proto__` never reaches Object.
      const bundles = Object.hasOwn(loaders, language)
        ? loaders[language]
        : undefined;
      const load =
        bundles && Object.hasOwn(bundles, namespace)
          ? bundles[namespace]
          : undefined;
      if (!load) {
        callback(null, {});
        return;
      }
      load().then(
        module => callback(null, unwrapResource(module)),
        error => callback(error as Error, false),
      );
    },
  };
  const currentLanguage = () =>
    languageFromPathname(
      window.location.pathname,
      routing.languages,
      routing.basePath,
    );

  return {
    languages: routing.languages,
    ...(routing.localisedUrls === undefined
      ? {}
      : { localisedUrls: routing.localisedUrls }),
    resolveRequest: request => resolveRequestLanguage(request, routing),
    redirect: createRequestLanguageRedirect,
    async create(language, resources) {
      // The default export resolves under both i18next module formats.
      const instance = i18next.createInstance();
      instance.use(backend);
      const seed: InitOptions = {
        ...initOptions,
        lng: language,
        fallbackLng: routing.fallbackLanguage,
        supportedLngs: [...routing.languages],
        ns: namespaces,
        defaultNS: defaultNamespace,
        partialBundledLanguages: true,
        resources: resources ? { [language]: resources } : {},
        interpolation: { escapeValue: false, ...initOptions.interpolation },
      };
      let original: InitOptions | undefined;
      let detachedSeed: InitOptions | undefined;
      try {
        original = detachInitOptions(initOptions);
        detachedSeed = detachInitOptions(seed);
      } catch {
        // Opaque custom options remain supported by normal native rendering.
      }
      await instance.init(seed);
      if (original && detachedSeed)
        recordNativeSnapshotOrigin(instance, original, detachedSeed);
      return instance;
    },
    rewrite: getLanguage => {
      const languages = [...routing.languages];
      const localisedUrls = detachLocalisedUrls(routing.localisedUrls);
      const rewrite = createI18nUrlRewrite({
        languages,
        getLanguage,
        localisedUrls,
      });
      const unchanged = descriptorProof(rewrite);
      nativeRewriteOrigins.set(rewrite, () => {
        if (!unchanged()) throw new Error('Native i18n rewrite was modified');
        const language = getLanguage();
        if (!languages.includes(language))
          throw new Error('Native i18n rewrite language is unsupported');
        return {
          language,
          languages: [...languages],
          ...(localisedUrls === undefined
            ? {}
            : { localisedUrls: detachLocalisedUrls(localisedUrls) }),
        };
      });
      return rewrite;
    },
    handoff(language, instance) {
      return createI18nSsrHandoffInlineData({
        language,
        ...(instance
          ? {
              resources: Object.fromEntries(
                namespaces.map(namespace => [
                  namespace,
                  (instance.getResourceBundle(language, namespace) ??
                    {}) as Record<string, unknown>,
                ]),
              ) satisfies NativeI18nResources,
            }
          : {}),
      });
    },
    clientHandoff() {
      const handoff = readI18nSsrHandoff();
      if (handoff && routing.languages.includes(handoff.language))
        return handoff;
      return { language: currentLanguage() ?? routing.fallbackLanguage };
    },
    syncWithRouter(router, instance) {
      // Navigation to another language prefix switches the instance. A
      // masked location (LocalizedLink to another language) publishes its
      // language on the mask; the unmasked location stays canonical. Switches
      // run through the shared sync policy: the latest URL language wins and
      // rejected loads retry. When retries run out the router has already
      // committed the URL, so a reload lets the server render that language.
      const sync = createLatestLanguageSyncBinding<I18nInstance>();
      sync.updateCallbacks({
        changeLanguage: (target, language) => target.changeLanguage(language),
        commitLanguage() {},
        readLanguage: target => target.language,
        reportFailure: () => window.location.reload(),
      });
      sync.activate(instance);
      const unsubscribe = (router as LanguageRouter).subscribe(
        'onBeforeLoad',
        ({ toLocation }) => {
          const publicHref =
            toLocation.maskedLocation?.publicHref ?? toLocation.publicHref;
          const pathname = new URL(publicHref, window.location.origin).pathname;
          const language = languageFromPathname(
            pathname,
            routing.languages,
            routing.basePath,
          );
          if (language) sync.request(language);
        },
      );
      // A retired entry stops listening and retrying.
      return () => {
        unsubscribe();
        sync.deactivate();
      };
    },
    persist(instance) {
      // Every language change reaches the document and the server's
      // language detector, with or without a router.
      const persist = (language: string) => {
        document.documentElement.lang = language;
        // biome-ignore lint/suspicious/noDocumentCookie: the server's language detector reads this cookie; CookieStore is not in every browser.
        document.cookie = `${cookie}=${encodeURIComponent(language)}; path=/; max-age=31536000; samesite=lax`;
      };
      // The client starts in its URL's language, which a stale cookie from
      // an earlier visit may not match; persist it before any later change.
      if (instance.language) persist(instance.language);
      instance.on('languageChanged', persist);
      return () => instance.off('languageChanged', persist);
    },
  };
}

interface LanguageRouter {
  subscribe(
    event: 'onBeforeLoad',
    listener: (event: {
      toLocation: {
        publicHref: string;
        maskedLocation?: { publicHref: string };
      };
    }) => void,
  ): () => void;
}
