import {
  createNativeI18n,
  createNativeI18nInstance,
  getNativeI18nRewriteSnapshot,
  getNativeI18nSnapshotSeed,
  invalidateNativeI18nSnapshot,
  type NativeI18nRewriteSnapshot,
} from '@modern-js/i18n-runtime-extensions/native';
import type { LocalisedUrlsOption } from '@modern-js/i18n-runtime-extensions/paths';
import type { NativeLocationRewrite } from '@modern-js/renderer-core/router';
import i18next, { type i18n as I18nInstance, type Resource } from 'i18next';
import { I18nContext } from './i18n/context';
import type { I18nContextValue, I18nInstanceLike } from './i18n/types';
import {
  OCTANE_WORKER_CONTEXT_KEYS,
  registerOctaneWorkerContext,
  registerOctaneWorkerRouterRewrite,
} from './worker-federation-contexts';

export type I18nSnapshotJson =
  | null
  | boolean
  | number
  | string
  | I18nSnapshotJson[]
  | I18nSnapshotOptions;

export interface I18nSnapshotOptions {
  [key: string]: I18nSnapshotJson;
}

export interface OctaneI18nProfileId {
  key: string;
  version: string;
}

export interface OctaneI18nSnapshot {
  version: 1;
  profile: OctaneI18nProfileId;
  language: string;
  languages: string[];
  localisedUrls?: LocalisedUrlsOption;
  options: I18nSnapshotOptions;
  resources: Resource;
}

/** Named profiles install their custom translation functions locally. */
export interface OctaneI18nSnapshotProfile extends OctaneI18nProfileId {
  captureOptions(instance: I18nInstanceLike): Readonly<I18nSnapshotOptions>;
  validateOptions(options: Readonly<I18nSnapshotOptions>): void;
  create(input: {
    language: string;
    options: Readonly<I18nSnapshotOptions>;
    resources: Resource;
    signal?: AbortSignal;
  }): I18nInstance | Promise<I18nInstance>;
  dispose?(instance: I18nInstance): void;
}

const defaultProfile: OctaneI18nProfileId = {
  key: 'ultramodern.i18next',
  version: '1',
};
const profiles = new Map<string, OctaneI18nSnapshotProfile>();
const associations = new WeakMap<
  object,
  {
    id: OctaneI18nProfileId;
    profile: OctaneI18nSnapshotProfile;
  }
>();
const restored = new WeakSet<object>();
const disposals = new WeakMap<object, () => void>();
const disposedContexts = new WeakSet<object>();
const retiredInstances = new WeakSet<object>();

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 32;
const MAX_OPTIONS_BYTES = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/** Validate before copying, without invoking a publisher-supplied accessor. */
function copyJson(value: unknown, maxBytes = MAX_BYTES): I18nSnapshotJson {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const charge = (value: string, quoted = true) => {
    if (value.length > maxBytes)
      throw new Error('i18n snapshot exceeds its budget');
    bytes += new TextEncoder().encode(
      quoted ? JSON.stringify(value) : value,
    ).byteLength;
    if (bytes > maxBytes) throw new Error('i18n snapshot exceeds its budget');
  };
  const visit = (input: unknown, depth: number): I18nSnapshotJson => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH)
      throw new Error('i18n snapshot exceeds its structural budget');
    if (input === null || typeof input === 'boolean') {
      charge(String(input), false);
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input))
        throw new Error('i18n snapshot numbers must be finite');
      charge(String(input), false);
      return input;
    }
    if (typeof input === 'string') {
      charge(input);
      return input;
    }
    if (
      typeof input !== 'object' ||
      input === null ||
      (Array.isArray(input)
        ? Object.getPrototypeOf(input) !== Array.prototype
        : !record(input))
    )
      throw new Error('i18n snapshots contain only plain JSON data');
    if (ancestors.has(input))
      throw new Error('i18n snapshots cannot contain cycles');
    ancestors.add(input);
    const result: I18nSnapshotOptions | I18nSnapshotJson[] = Array.isArray(
      input,
    )
      ? []
      : {};
    const keys = Reflect.ownKeys(input);
    if (
      Array.isArray(input) &&
      (input.length > MAX_NODES ||
        keys.length !== input.length + 1 ||
        keys.slice(0, -1).some((key, index) => key !== String(index)))
    )
      throw new Error('i18n snapshot arrays must be dense');
    charge(Array.isArray(input) ? '[]' : '{}', false);
    let entries = 0;
    for (const key of keys) {
      if (Array.isArray(input) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        typeof key !== 'string' ||
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor' ||
        !descriptor ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        throw new Error(
          'i18n snapshots cannot contain special properties or accessors',
        );
      if (entries++) charge(',', false);
      if (!Array.isArray(input)) {
        charge(key);
        charge(':', false);
      }
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    ancestors.delete(input);
    return result;
  };
  return visit(value, 0);
}

function jsonRecord(value: unknown, maxBytes = MAX_BYTES): I18nSnapshotOptions {
  const copied = copyJson(value, maxBytes);
  if (!record(copied)) throw new Error('i18n snapshot must contain an object');
  return copied;
}

function canonicalJson(value: I18nSnapshotJson): I18nSnapshotJson {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    const result: I18nSnapshotOptions = {};
    for (const key of Object.keys(value).sort())
      result[key] = canonicalJson(value[key]);
    return result;
  }
  return value;
}

function sameResourcesKey(value: Resource): string {
  return JSON.stringify(canonicalJson(copyJson(value)));
}

function exactKeys(value: object, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error('Unknown i18n snapshot field');
}

function language(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128)
    throw new Error('Invalid i18n snapshot language');
  return value;
}

function profileId(value: unknown): OctaneI18nProfileId {
  if (!record(value)) throw new Error('Invalid i18n snapshot profile');
  exactKeys(value, ['key', 'version']);
  const key = language(value.key);
  const version = language(value.version);
  return { key, version };
}

function profileKey(profile: OctaneI18nProfileId): string {
  return JSON.stringify([profile.key, profile.version]);
}

function genuineInstance(value: unknown): value is I18nInstance {
  if (typeof value !== 'object' || value === null) return false;
  for (const key of ['options', 'services', 'store', 'language']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return false;
  }
  const services: unknown = Object.getOwnPropertyDescriptor(
    value,
    'services',
  )?.value;
  const connector: unknown =
    services && typeof services === 'object'
      ? Object.getOwnPropertyDescriptor(services, 'backendConnector')?.value
      : undefined;
  const state: unknown =
    connector && typeof connector === 'object'
      ? Object.getOwnPropertyDescriptor(connector, 'state')?.value
      : undefined;
  const pending =
    record(state) &&
    Object.values(Object.getOwnPropertyDescriptors(state)).some(
      descriptor => !('value' in descriptor) || descriptor.value === 1,
    );
  return (
    Object.getPrototypeOf(value) === Object.getPrototypeOf(i18next) &&
    Object.getOwnPropertyDescriptor(value, 'isInitialized')?.value === true &&
    Object.getOwnPropertyDescriptor(value, 'isInitializing')?.value !== true &&
    !Object.getOwnPropertyDescriptor(value, 'isLanguageChangingTo')?.value &&
    typeof Object.getOwnPropertyDescriptor(value, 'language')?.value ===
      'string' &&
    !pending
  );
}

function stringList(value: unknown, allowFalse = false): boolean {
  return (
    (allowFalse && value === false) ||
    typeof value === 'string' ||
    (Array.isArray(value) && value.every(item => typeof item === 'string'))
  );
}

const booleanOptions = new Set([
  'debug',
  'nonExplicitSupportedLngs',
  'lowerCaseLng',
  'cleanCode',
  'ignoreJSONStructure',
  'returnNull',
  'returnEmptyString',
  'returnObjects',
  'returnDetails',
  'appendNamespaceToMissingKey',
  'appendNamespaceToCIMode',
  'cacheInBuiltFormats',
]);
const stringOptions = new Set(['pluralSeparator', 'contextSeparator']);
const interpolationBooleans = new Set([
  'alwaysFormat',
  'escapeValue',
  'useRawValueToEscape',
  'skipOnVariables',
]);
const interpolationStrings = new Set([
  'formatSeparator',
  'prefix',
  'suffix',
  'prefixEscaped',
  'suffixEscaped',
  'unescapeSuffix',
  'unescapePrefix',
  'nestingPrefix',
  'nestingSuffix',
  'nestingPrefixEscaped',
  'nestingSuffixEscaped',
  'nestingOptionsSeparator',
]);

function validatePortableOptions(options: I18nSnapshotOptions) {
  for (const [key, value] of Object.entries(options)) {
    let valid = false;
    if (booleanOptions.has(key)) valid = typeof value === 'boolean';
    else if (stringOptions.has(key)) valid = typeof value === 'string';
    else if (['keySeparator', 'nsSeparator', 'joinArrays'].includes(key))
      valid = value === false || typeof value === 'string';
    else if (['ns', 'defaultNS', 'fallbackNS'].includes(key))
      valid = stringList(value, key !== 'ns');
    else if (key === 'preload')
      valid = value === false || (Array.isArray(value) && stringList(value));
    else if (key === 'supportedLngs')
      valid = value === false || (Array.isArray(value) && stringList(value));
    else if (key === 'fallbackLng')
      valid =
        stringList(value, true) ||
        (record(value) &&
          Object.values(value).every(
            item => Array.isArray(item) && stringList(item),
          ));
    else if (key === 'load')
      valid =
        typeof value === 'string' &&
        ['all', 'currentOnly', 'languageOnly'].includes(value);
    else if (key === 'enableSelector')
      valid =
        typeof value === 'boolean' ||
        value === 'optimize' ||
        value === 'strict';
    else if (key === 'compatibilityJSON') valid = value === 'v4';
    else if (key === 'postProcess')
      valid = value === false || (Array.isArray(value) && value.length === 0);
    else if (['saveMissing', 'updateMissing'].includes(key))
      valid = value === false;
    else if (key === 'interpolation' && record(value)) {
      valid = Object.entries(value).every(([name, field]) => {
        if (interpolationBooleans.has(name)) return typeof field === 'boolean';
        if (interpolationStrings.has(name)) return typeof field === 'string';
        if (name === 'defaultVariables') return record(field);
        return (
          name === 'maxReplaces' &&
          typeof field === 'number' &&
          Number.isSafeInteger(field) &&
          field >= 0 &&
          field <= 100_000
        );
      });
    }
    if (!valid)
      throw new Error(`i18n option ${key} requires an explicit Worker profile`);
  }
}

function resources(value: unknown): Resource {
  const copied = jsonRecord(value);
  if (Object.keys(copied).length > 64)
    throw new Error('Too many i18n snapshot languages');
  const result: Resource = {};
  for (const [lng, namespaces] of Object.entries(copied)) {
    language(lng);
    if (!record(namespaces) || Object.keys(namespaces).length > 256)
      throw new Error('Invalid i18n snapshot namespaces');
    const bundles: Resource[string] = {};
    for (const [namespace, bundle] of Object.entries(namespaces)) {
      language(namespace);
      if (typeof bundle !== 'string' && !record(bundle))
        throw new Error('Invalid i18n snapshot resource bundle');
      bundles[namespace] = bundle;
    }
    result[lng] = bundles;
  }
  return result;
}

function loadedResources(instance: I18nInstance): Resource {
  const result: Resource = {};
  const descriptor = Object.getOwnPropertyDescriptor(instance.store, 'data');
  if (!descriptor || !('value' in descriptor))
    throw new Error('Loaded i18n resources cannot use accessors');
  const loaded = jsonRecord(descriptor.value);
  // Enumerate all loaded languages, including configured preloads and fallbacks.
  for (const lng of Object.keys(loaded)) {
    const data = jsonRecord(instance.getDataByLanguage(lng));
    const bundles: Resource[string] = {};
    for (const namespace of Object.keys(data)) {
      const bundle: unknown = instance.getResourceBundle(lng, namespace);
      if (typeof bundle !== 'string' && !record(bundle))
        throw new Error('Invalid loaded i18n resource bundle');
      bundles[namespace] = bundle;
    }
    result[lng] = bundles;
  }
  return resources(result);
}

function localizedUrls(value: unknown): LocalisedUrlsOption | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  if (!record(value)) throw new Error('Invalid i18n snapshot localized URLs');
  const result: Exclude<LocalisedUrlsOption, boolean> = {};
  for (const [path, map] of Object.entries(value)) {
    if (!record(map))
      throw new Error('Invalid i18n snapshot localized URL map');
    const paths: Record<string, string> = {};
    for (const [lng, target] of Object.entries(map)) {
      language(lng);
      if (typeof target !== 'string')
        throw new Error('Invalid localized URL target');
      paths[lng] = target;
    }
    result[path] = paths;
  }
  return result;
}

function rewriteSnapshot(value: unknown): NativeI18nRewriteSnapshot {
  const input = jsonRecord(value, MAX_OPTIONS_BYTES);
  exactKeys(input, ['language', 'languages', 'localisedUrls']);
  const lng = language(input.language);
  if (
    !Array.isArray(input.languages) ||
    !input.languages.length ||
    input.languages.length > 64
  )
    throw new Error('Invalid i18n rewrite languages');
  const languages = input.languages.map(language);
  if (new Set(languages).size !== languages.length || !languages.includes(lng))
    throw new Error('Invalid i18n rewrite language selection');
  const urls = localizedUrls(input.localisedUrls);
  return {
    language: lng,
    languages,
    ...(urls === undefined ? {} : { localisedUrls: urls }),
  };
}

export function captureOctaneI18nRewriteSnapshot(
  rewrite: NativeLocationRewrite,
): NativeI18nRewriteSnapshot {
  const snapshot = getNativeI18nRewriteSnapshot(rewrite);
  if (!snapshot)
    throw new Error('Unknown i18n router rewrite requires a named profile');
  return rewriteSnapshot(snapshot);
}

export function restoreOctaneI18nRewriteSnapshot(
  value: unknown,
): NativeLocationRewrite {
  const snapshot = rewriteSnapshot(value);
  return createNativeI18n(
    {
      languages: snapshot.languages,
      fallbackLanguage: snapshot.language,
      localisedUrls: snapshot.localisedUrls,
    },
    {},
  ).rewrite(() => snapshot.language);
}

export function registerOctaneI18nSnapshotProfile(
  profile: OctaneI18nSnapshotProfile,
): () => void {
  const id = profileId({ key: profile.key, version: profile.version });
  if (
    typeof profile.captureOptions !== 'function' ||
    typeof profile.validateOptions !== 'function' ||
    typeof profile.create !== 'function' ||
    (profile.dispose !== undefined && typeof profile.dispose !== 'function')
  )
    throw new Error('Invalid i18n Worker profile implementation');
  const key = profileKey(id);
  if (key === profileKey(defaultProfile) || profiles.has(key))
    throw new Error('Duplicate i18n Worker profile');
  const captured: OctaneI18nSnapshotProfile = Object.freeze({
    ...id,
    captureOptions: profile.captureOptions,
    validateOptions: profile.validateOptions,
    create: profile.create,
    ...(profile.dispose ? { dispose: profile.dispose } : {}),
  });
  profiles.set(key, captured);
  return () => {
    if (profiles.get(key) === captured) profiles.delete(key);
  };
}

export function associateOctaneI18nSnapshotProfile(
  instance: I18nInstanceLike,
  id: OctaneI18nProfileId,
) {
  const copied = profileId(jsonRecord(id));
  const profile = profiles.get(profileKey(copied));
  if (!genuineInstance(instance) || retiredInstances.has(instance))
    throw new Error('Profiles require a live genuine i18n instance');
  if (!profile)
    throw new Error('The exact i18n Worker profile must be registered locally');
  if (restored.has(instance)) {
    const association = associations.get(instance);
    if (
      association?.profile !== profile ||
      profileKey(association.id) !== profileKey(copied)
    )
      throw new Error('A restored i18n context retains its owning profile');
    return;
  }
  associations.set(instance, { id: copied, profile });
}

/** Built-in translation behavior only. Custom per-call processors need a profile. */
export function captureOctaneI18nSnapshot(
  value: I18nContextValue,
): OctaneI18nSnapshot {
  const instance = value.instance;
  if (disposedContexts.has(value) || retiredInstances.has(instance))
    throw new Error('Cannot capture a disposed i18n Worker context');
  if (!genuineInstance(instance))
    throw new Error(
      'Worker i18n snapshots require a genuine settled i18next instance',
    );
  if (instance.language !== value.language)
    throw new Error('Worker i18n context language must be settled');
  const association = associations.get(instance);
  const selected = association?.id ?? defaultProfile;
  let options: I18nSnapshotOptions;
  if (profileKey(selected) === profileKey(defaultProfile)) {
    const seed = getNativeI18nSnapshotSeed(instance);
    const { lng, resources, initAsync, partialBundledLanguages, ...portable } =
      seed;
    options = jsonRecord(portable, MAX_OPTIONS_BYTES);
    validatePortableOptions(options);
  } else {
    const profile = profiles.get(profileKey(selected));
    if (!profile || association?.profile !== profile)
      throw new Error('Missing or changed exact i18n Worker profile');
    options = jsonRecord(profile.captureOptions(instance), MAX_OPTIONS_BYTES);
    profile.validateOptions(options);
  }
  return parseSnapshot({
    version: 1,
    profile: selected,
    language: value.language,
    languages: [...value.languages],
    ...(value.localisedUrls === undefined
      ? {}
      : { localisedUrls: value.localisedUrls }),
    options,
    resources: loadedResources(instance),
  });
}

function parseSnapshot(value: unknown): OctaneI18nSnapshot {
  const input = jsonRecord(value);
  exactKeys(input, [
    'version',
    'profile',
    'language',
    'languages',
    'localisedUrls',
    'options',
    'resources',
  ]);
  if (input.version !== 1) throw new Error('Unsupported i18n snapshot version');
  const lng = language(input.language);
  if (
    !Array.isArray(input.languages) ||
    !input.languages.length ||
    input.languages.length > 64
  )
    throw new Error('Invalid i18n snapshot supported languages');
  const languages = input.languages.map(language);
  if (new Set(languages).size !== languages.length || !languages.includes(lng))
    throw new Error('Invalid i18n snapshot language selection');
  const options = jsonRecord(input.options, MAX_OPTIONS_BYTES);
  const urls = localizedUrls(input.localisedUrls);
  return {
    version: 1,
    profile: profileId(input.profile),
    language: lng,
    languages,
    ...(urls === undefined ? {} : { localisedUrls: urls }),
    options,
    resources: resources(input.resources),
  };
}

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function disposeInstance(instance: I18nInstance) {
  for (const event of [
    'initialized',
    'loaded',
    'failedLoading',
    'languageChanging',
    'languageChanged',
    'missingKey',
    '*',
  ])
    instance.off(event);
  instance.store.off('added');
  instance.store.off('removed');
}

function retireInstance(instance: I18nInstance) {
  if (
    typeof instance !== 'object' ||
    instance === null ||
    Object.getPrototypeOf(instance) !== Object.getPrototypeOf(i18next)
  )
    return;
  retiredInstances.add(instance);
  associations.delete(instance);
  invalidateNativeI18nSnapshot(instance);
}

function cleanupFreshInstance(instance: I18nInstance, dispose?: () => void) {
  if (restored.has(instance)) return;
  retireInstance(instance);
  if (genuineInstance(instance)) disposeInstance(instance);
  dispose?.();
}

function createProfileInstance(
  profile: OctaneI18nSnapshotProfile,
  snapshot: OctaneI18nSnapshot,
  signal?: AbortSignal,
): Promise<I18nInstance> {
  // A profile owns partial allocations until it returns. If it returns after
  // cancellation, this codec disposes that completed instance immediately.
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('i18n restoration aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve()
      .then(() => {
        if (finished)
          throw signal?.reason ?? new Error('i18n restoration aborted');
        return profile.create({
          language: snapshot.language,
          options: snapshot.options,
          resources: resources(snapshot.resources),
          ...(signal ? { signal } : {}),
        });
      })
      .then(
        instance => {
          if (finished) {
            try {
              cleanupFreshInstance(instance, () => profile.dispose?.(instance));
            } catch {
              // The request already rejected; the local profile owns cleanup errors.
            }
            return;
          }
          finished = true;
          signal?.removeEventListener('abort', abort);
          resolve(instance);
        },
        error => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      );
  });
}

export async function restoreOctaneI18nSnapshot(
  value: unknown,
  signal?: AbortSignal,
): Promise<I18nContextValue> {
  throwIfAborted(signal);
  const snapshot = parseSnapshot(value);
  const expectedResources = sameResourcesKey(snapshot.resources);
  let instance: I18nInstance;
  let dispose: (() => void) | undefined;
  let restoredProfile: OctaneI18nSnapshotProfile | undefined;
  if (profileKey(snapshot.profile) === profileKey(defaultProfile)) {
    validatePortableOptions(snapshot.options);
    instance = createNativeI18nInstance({
      ...snapshot.options,
      lng: snapshot.language,
      resources: resources(snapshot.resources),
      initAsync: false,
      partialBundledLanguages: false,
    });
  } else {
    const profile = profiles.get(profileKey(snapshot.profile));
    if (!profile) throw new Error('Missing exact i18n Worker profile');
    restoredProfile = profile;
    profile.validateOptions(snapshot.options);
    instance = await createProfileInstance(profile, snapshot, signal);
    if (profile.dispose) dispose = () => profile.dispose?.(instance);
  }
  try {
    throwIfAborted(signal);
    if (
      restoredProfile &&
      profiles.get(profileKey(snapshot.profile)) !== restoredProfile
    )
      throw new Error('The i18n Worker profile changed during restoration');
    if (
      !genuineInstance(instance) ||
      instance.language !== snapshot.language ||
      restored.has(instance)
    )
      throw new Error(
        'An i18n Worker profile must create a fresh settled instance',
      );
    const current = loadedResources(instance);
    if (sameResourcesKey(current) !== expectedResources)
      throw new Error(
        'An i18n Worker profile must restore every loaded resource',
      );
    restored.add(instance);
    if (restoredProfile)
      associations.set(instance, {
        id: { ...snapshot.profile },
        profile: restoredProfile,
      });
    const context: I18nContextValue = {
      instance,
      language: snapshot.language,
      languages: snapshot.languages,
      ...(snapshot.localisedUrls === undefined
        ? {}
        : { localisedUrls: snapshot.localisedUrls }),
    };
    let disposed = false;
    disposals.set(context, () => {
      if (disposed) return;
      disposed = true;
      disposedContexts.add(context);
      retireInstance(instance);
      disposeInstance(instance);
      dispose?.();
    });
    return context;
  } catch (error) {
    cleanupFreshInstance(instance, dispose);
    throw error;
  }
}

export function disposeOctaneI18nSnapshot(value: I18nContextValue) {
  const dispose = disposals.get(value);
  disposals.delete(value);
  dispose?.();
}

let registrations = 0;
let releaseContext: (() => void) | undefined;

export function registerOctaneI18nWorkerContexts(): () => void {
  if (!releaseContext) {
    const releaseRewrite = registerOctaneWorkerRouterRewrite({
      capture: captureOctaneI18nRewriteSnapshot,
      restore: restoreOctaneI18nRewriteSnapshot,
    });
    try {
      const unregisterContext = registerOctaneWorkerContext(I18nContext, {
        key: OCTANE_WORKER_CONTEXT_KEYS.i18n,
        encode: value => {
          if (value === null) throw new Error('Missing i18n context provider');
          return captureOctaneI18nSnapshot(value);
        },
        decode: restoreOctaneI18nSnapshot,
        dispose: value => {
          if (value !== null) disposeOctaneI18nSnapshot(value);
        },
        isProvided: value => value !== null,
      });
      releaseContext = () => {
        try {
          unregisterContext();
        } finally {
          releaseRewrite();
        }
      };
    } catch (error) {
      releaseRewrite();
      throw error;
    }
  }
  registrations++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--registrations === 0) {
      releaseContext?.();
      releaseContext = undefined;
    }
  };
}
