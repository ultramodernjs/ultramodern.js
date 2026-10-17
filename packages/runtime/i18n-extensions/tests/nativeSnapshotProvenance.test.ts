import { expect, test } from '@rstest/core';
import i18next from 'i18next';
import {
  createNativeI18n,
  createNativeI18nInstance,
  getNativeI18nRewriteSnapshot,
  getNativeI18nSnapshotSeed,
  invalidateNativeI18nSnapshot,
} from '../src/native';

const bundled = {
  lng: 'cs',
  fallbackLng: 'en',
  resources: {
    en: { translation: { fallback: 'English', number: '{{value, number}}' } },
    cs: { translation: { hello: 'Ahoj {{name}}' } },
  },
};

test('later plugin registration preserves native behavior and invalidates default provenance', () => {
  const instance = createNativeI18nInstance(bundled);
  const keys = Object.keys(instance.modules);
  const result = instance.use({
    type: 'postProcessor',
    name: 'native-provenance-later-plugin',
    process(value: string) {
      return `Processed: ${value}`;
    },
  });
  expect(result).toBe(instance);
  expect(Object.keys(instance.modules)).toEqual(keys);
  expect(
    instance.t('fallback', { postProcess: 'native-provenance-later-plugin' }),
  ).toBe('Processed: English');
  expect(() => getNativeI18nSnapshotSeed(instance)).toThrow(
    'explicit Worker profile',
  );
});

test('retiring the owning request invalidates only its native provenance', () => {
  const retired = createNativeI18nInstance(bundled);
  const live = createNativeI18nInstance(bundled);
  invalidateNativeI18nSnapshot(retired);
  invalidateNativeI18nSnapshot(retired);
  expect(() => getNativeI18nSnapshotSeed(retired)).toThrow(
    'explicit Worker profile',
  );
  expect(getNativeI18nSnapshotSeed(live).fallbackLng).toBe('en');
});

test('native provenance retains authored option presence and detached effective inputs', () => {
  const instance = createNativeI18nInstance(bundled);
  expect(instance.t('hello', { name: '<Ada>' })).toBe('Ahoj <Ada>');
  const seed = getNativeI18nSnapshotSeed(instance);
  expect(seed.keySeparator).toBeUndefined();
  expect(seed.interpolation?.escapeValue).toBe(false);
  expect(seed.initAsync).toBe(false);
  seed.interpolation = { escapeValue: true };
  expect(getNativeI18nSnapshotSeed(instance).interpolation?.escapeValue).toBe(
    false,
  );
});

test('ordinary translation, warmed caches, resource loading and settled language changes keep provenance', async () => {
  const instance = createNativeI18nInstance(bundled);
  instance.t('number', { value: 1234 });
  instance.t('hello', {
    name: 'Ada',
    interpolation: { prefix: '[[', suffix: ']]' },
  });
  await instance.changeLanguage('en');
  await new Promise<void>((resolve, reject) => {
    instance.loadResources(error => (error ? reject(error) : resolve()));
  });
  instance.addResourceBundle('de', 'translation', { extra: 'Zusatz' });
  expect(getNativeI18nSnapshotSeed(instance).fallbackLng).toBe('en');
});

test('unenrolled genuine instances and clones require an explicit profile', async () => {
  const raw = i18next.createInstance();
  await raw.init({ ...bundled, initAsync: false });
  expect(() => getNativeI18nSnapshotSeed(raw)).toThrow(
    'explicit Worker profile',
  );
  const instance = createNativeI18nInstance(bundled);
  expect(() => getNativeI18nSnapshotSeed(instance.cloneInstance())).toThrow(
    'explicit Worker profile',
  );
});

test.each([
  [
    'translation method',
    (instance: ReturnType<typeof createNativeI18nInstance>) =>
      Reflect.set(instance, 't', () => 'changed'),
  ],
  [
    'nested option',
    (instance: ReturnType<typeof createNativeI18nInstance>) => {
      Reflect.set(instance.options.interpolation ?? {}, 'escapeValue', true);
    },
  ],
  [
    'formatter registry',
    (instance: ReturnType<typeof createNativeI18nInstance>) => {
      instance.services.formatter?.add('number', () => 'changed');
    },
  ],
  [
    'formatter registry identity',
    (instance: ReturnType<typeof createNativeI18nInstance>) => {
      if (instance.services.formatter)
        Reflect.set(instance.services.formatter, 'formats', {
          number: () => 'changed',
        });
    },
  ],
  [
    'root resource store identity',
    (instance: ReturnType<typeof createNativeI18nInstance>) => {
      Reflect.set(instance, 'store', createNativeI18nInstance(bundled).store);
    },
  ],
  [
    'translator language',
    (instance: ReturnType<typeof createNativeI18nInstance>) => {
      const translator: unknown = Reflect.get(instance, 'translator');
      if (typeof translator === 'object' && translator !== null)
        Reflect.set(translator, 'language', 'en');
    },
  ],
  [
    'interpolator behavior',
    (instance: ReturnType<typeof createNativeI18nInstance>) => {
      Reflect.set(instance.services.interpolator, 'escapeValue', true);
    },
  ],
  [
    'plural prefix',
    (instance: ReturnType<typeof createNativeI18nInstance>) => {
      const options: unknown = Reflect.get(
        instance.services.pluralResolver,
        'options',
      );
      if (typeof options === 'object' && options !== null)
        Reflect.set(options, 'prepend', '-');
    },
  ],
])('changed %s invalidates the default proof', (_name, change) => {
  const instance = createNativeI18nInstance(bundled);
  change(instance);
  expect(() => getNativeI18nSnapshotSeed(instance)).toThrow(
    'explicit Worker profile',
  );
});

test('native async loader instances capture effective fallback, namespaces and supported languages', async () => {
  const native = createNativeI18n(
    { languages: ['en', 'cs'], fallbackLanguage: 'en' },
    {
      en: { common: async () => ({ fallback: 'English' }) },
      cs: { common: async () => ({ hello: 'Ahoj' }) },
    },
  );
  const instance = await native.create('cs');
  const seed = getNativeI18nSnapshotSeed(instance);
  expect(seed.fallbackLng).toBe('en');
  expect(seed.supportedLngs).toEqual(['en', 'cs']);
  expect(seed.ns).toEqual(['common']);
  expect(seed.defaultNS).toBe('common');
});

test('a background native resource reload must settle before capture', async () => {
  let finish: (() => void) | undefined;
  let reloading = false;
  const native = createNativeI18n(
    { languages: ['en'], fallbackLanguage: 'en' },
    {
      en: {
        translation: async () => {
          if (reloading)
            await new Promise<void>(resolve => {
              finish = resolve;
            });
          return { greeting: 'Hello' };
        },
      },
    },
  );
  const instance = await native.create('en');
  reloading = true;
  const pending = instance.reloadResources(['en'], ['translation']);
  expect(() => getNativeI18nSnapshotSeed(instance)).toThrow(
    'explicit Worker profile',
  );
  if (!finish) throw new Error('The native backend was not invoked');
  finish();
  await pending;
  expect(getNativeI18nSnapshotSeed(instance).fallbackLng).toBe('en');
});

test('only intact native rewrites expose their detached routing configuration', () => {
  const languages = ['en', 'cs'];
  const native = createNativeI18n(
    { languages, fallbackLanguage: 'en', localisedUrls: false },
    {},
  );
  let current = 'en';
  const rewrite = native.rewrite(() => current);
  languages.push('de');
  expect(getNativeI18nRewriteSnapshot(rewrite)).toEqual({
    language: 'en',
    languages: ['en', 'cs'],
    localisedUrls: false,
  });
  current = 'cs';
  expect(getNativeI18nRewriteSnapshot(rewrite)?.language).toBe('cs');
  expect(getNativeI18nRewriteSnapshot({})).toBeUndefined();
  Reflect.set(rewrite, 'input', () => new URL('https://changed.test/'));
  expect(() => getNativeI18nRewriteSnapshot(rewrite)).toThrow('modified');
});
