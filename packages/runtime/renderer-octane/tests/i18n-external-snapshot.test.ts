import {
  createNativeI18n,
  createNativeI18nInstance,
  getNativeI18nSnapshotSeed,
} from '@modern-js/i18n-runtime-extensions/native';
import { expect, test } from '@rstest/core';
import i18next from 'i18next';
import type { I18nContextValue } from '../src/i18n/types';
import {
  associateOctaneI18nSnapshotProfile,
  captureOctaneI18nRewriteSnapshot,
  captureOctaneI18nSnapshot,
  disposeOctaneI18nSnapshot,
  registerOctaneI18nSnapshotProfile,
  restoreOctaneI18nRewriteSnapshot,
  restoreOctaneI18nSnapshot,
} from '../src/i18n-external-snapshot';

function context(): I18nContextValue {
  return {
    language: 'cs',
    languages: ['en', 'cs'],
    localisedUrls: {
      '/products/:id': { en: '/products/:id', cs: '/produkty/:id' },
    },
    instance: createNativeI18nInstance({
      lng: 'cs',
      fallbackLng: ['en'],
      ns: ['translation', 'common'],
      defaultNS: 'translation',
      resources: {
        cs: {
          translation: {
            hello: 'Ahoj {{name}}',
            item_one: '{{count}} věc',
            item_few: '{{count}} věci',
            item_other: '{{count}} věcí',
            'Text: with punctuation.': 'Doslovný text',
          },
        },
        en: {
          translation: { fallback: 'English fallback' },
          common: { common: 'Shared fallback' },
        },
        de: { extra: { unused: 'Auch geladen' } },
      },
    }),
  };
}

test('default contexts remain portable across two publisher hops until each lease ends', async () => {
  const host = context();
  const first = await restoreOctaneI18nSnapshot(
    captureOctaneI18nSnapshot(host),
  );
  const recaptured = captureOctaneI18nSnapshot(first);
  expect(recaptured.profile).toEqual({
    key: 'ultramodern.i18next',
    version: '1',
  });
  const second = await restoreOctaneI18nSnapshot(recaptured);
  expect(second.instance.t('hello', { name: 'Ada' })).toBe('Ahoj Ada');
  expect(second.instance.t('fallback')).toBe('English fallback');
  expect(second.instance).not.toBe(first.instance);
  disposeOctaneI18nSnapshot(first);
  expect(() => captureOctaneI18nSnapshot(first)).toThrow('disposed');
  expect(() => captureOctaneI18nSnapshot({ ...first })).toThrow('disposed');
  expect(() => getNativeI18nSnapshotSeed(first.instance)).toThrow(
    'explicit Worker profile',
  );
  expect(second.instance.t('item', { count: 2 })).toBe('2 věci');
  expect(captureOctaneI18nSnapshot(host).language).toBe('cs');
  disposeOctaneI18nSnapshot(second);
  expect(() => captureOctaneI18nSnapshot(second)).toThrow('disposed');
});

test('the known native rewrite restores actual mapped URL behavior', () => {
  const native = createNativeI18n(
    {
      languages: ['en', 'cs'],
      fallbackLanguage: 'en',
      localisedUrls: {
        '/products/:id': { en: '/products/:id', cs: '/produkty/:id' },
      },
    },
    {},
  );
  const snapshot = captureOctaneI18nRewriteSnapshot(native.rewrite(() => 'cs'));
  const rewrite = restoreOctaneI18nRewriteSnapshot(snapshot);
  expect(captureOctaneI18nRewriteSnapshot(rewrite)).toEqual(snapshot);
  const secondRewrite = restoreOctaneI18nRewriteSnapshot(
    captureOctaneI18nRewriteSnapshot(rewrite),
  );
  const incoming = new URL('https://store.test/cs/produkty/7?sort=price');
  rewrite.input?.({ url: incoming });
  expect(incoming.href).toBe('https://store.test/products/7?sort=price');
  const outgoing = new URL('https://store.test/products/7');
  rewrite.output?.({ url: outgoing });
  expect(outgoing.href).toBe('https://store.test/cs/produkty/7');
  const secondOutgoing = new URL('https://store.test/products/7');
  secondRewrite.output?.({ url: secondOutgoing });
  expect(secondOutgoing.href).toBe(outgoing.href);
  expect(() => captureOctaneI18nRewriteSnapshot({})).toThrow('Unknown');
  expect(() =>
    restoreOctaneI18nRewriteSnapshot({ ...snapshot, extra: true }),
  ).toThrow('Unknown');
});

test('Worker projection restores real fallback, namespaces, natural keys, interpolation and plurals', async () => {
  const host = context();
  const snapshot = captureOctaneI18nSnapshot(host);
  const worker = await restoreOctaneI18nSnapshot(
    JSON.parse(JSON.stringify(snapshot)),
  );
  expect(Object.getPrototypeOf(worker.instance)).toBe(
    Object.getPrototypeOf(i18next),
  );
  expect(worker.instance).not.toBe(host.instance);
  for (const [key, options] of [
    ['fallback', {}],
    ['common:common', {}],
    ['hello', { name: '<Ada>' }],
    ['item', { count: 2 }],
    ['item', { count: 5 }],
    ['Text: with punctuation.', {}],
  ]) {
    if (typeof key !== 'string' || typeof options !== 'object')
      throw new Error('Invalid test case');
    expect(worker.instance.t(key, options)).toBe(host.instance.t(key, options));
  }
  expect(snapshot.resources.de).toEqual({ extra: { unused: 'Auch geladen' } });
  expect(snapshot.options).not.toHaveProperty('keySeparator');
  expect(snapshot.options).not.toHaveProperty('nsSeparator');
  expect(worker.localisedUrls).toEqual(host.localisedUrls);
  disposeOctaneI18nSnapshot(worker);
});

test('simultaneous request projections isolate their stores and language', async () => {
  const snapshot = captureOctaneI18nSnapshot(context());
  const first = await restoreOctaneI18nSnapshot(snapshot);
  const second = await restoreOctaneI18nSnapshot(snapshot);
  if (
    !('addResourceBundle' in first.instance) ||
    typeof first.instance.addResourceBundle !== 'function'
  )
    throw new Error('Expected genuine i18next');
  first.instance.addResourceBundle(
    'cs',
    'translation',
    { hello: 'Změněno' },
    true,
    true,
  );
  await first.instance.changeLanguage?.('en');
  expect(second.instance.language).toBe('cs');
  expect(second.instance.t('hello', { name: 'Ada' })).toBe('Ahoj Ada');
  disposeOctaneI18nSnapshot(first);
  disposeOctaneI18nSnapshot(second);
});

test('native loader projection includes every loaded fallback bundle', async () => {
  const native = createNativeI18n(
    { languages: ['en', 'cs'], fallbackLanguage: 'en' },
    {
      en: { translation: async () => ({ fallback: 'English' }) },
      cs: { translation: async () => ({ hello: 'Ahoj' }) },
    },
  );
  const instance = await native.create('cs');
  const worker = await restoreOctaneI18nSnapshot(
    captureOctaneI18nSnapshot({
      instance,
      language: 'cs',
      languages: native.languages,
    }),
  );
  expect(worker.instance.t('fallback')).toBe('English');
  disposeOctaneI18nSnapshot(worker);
});

test('default projection rejects shaped/raw instances, callbacks and changed formatters', async () => {
  const shaped = context();
  shaped.instance = { language: 'cs', t: () => 'fake' };
  expect(() => captureOctaneI18nSnapshot(shaped)).toThrow('genuine');
  const raw = i18next.createInstance();
  await raw.init({
    lng: 'cs',
    resources: { cs: { translation: {} } },
    initAsync: false,
  });
  expect(() =>
    captureOctaneI18nSnapshot({ ...context(), instance: raw }),
  ).toThrow('explicit Worker profile');
  const callback = createNativeI18nInstance({
    lng: 'cs',
    resources: {},
    fallbackLng: () => 'en',
  });
  expect(() =>
    captureOctaneI18nSnapshot({ ...context(), instance: callback }),
  ).toThrow();
  const changed = createNativeI18nInstance({ lng: 'cs', resources: {} });
  changed.services.formatter?.add('number', () => 'custom');
  expect(() =>
    captureOctaneI18nSnapshot({ ...context(), instance: changed }),
  ).toThrow('explicit Worker profile');
});

test.each([
  ['extra field', (wire: object) => Reflect.set(wire, 'unexpected', true)],
  ['wrong version', (wire: object) => Reflect.set(wire, 'version', 2)],
  [
    'nonfinite option',
    (wire: object) =>
      Reflect.set(wire, 'options', {
        interpolation: { maxReplaces: Infinity },
      }),
  ],
  [
    'accessor',
    (wire: object) =>
      Object.defineProperty(wire, 'language', {
        get: () => {
          throw new Error('getter executed');
        },
        enumerable: true,
      }),
  ],
  [
    'oversized resources',
    (wire: object) =>
      Reflect.set(wire, 'resources', {
        cs: { translation: { value: 'a'.repeat(4 * 1024 * 1024 + 1) } },
      }),
  ],
  [
    'unknown option',
    (wire: object) => Reflect.set(wire, 'options', { unknown: true }),
  ],
  [
    'active postprocessor',
    (wire: object) => Reflect.set(wire, 'options', { postProcess: ['custom'] }),
  ],
])('invalid %s fails before creating a context', async (_name, change) => {
  const wire = captureOctaneI18nSnapshot(context());
  change(wire);
  await expect(restoreOctaneI18nSnapshot(wire)).rejects.toThrow();
});

test('aborted context restoration stops before allocation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('request aborted'));
  await expect(
    restoreOctaneI18nSnapshot(
      captureOctaneI18nSnapshot(context()),
      controller.signal,
    ),
  ).rejects.toThrow('request aborted');
});

test('resource accessors are rejected without running the getter', () => {
  const instance = createNativeI18nInstance({
    lng: 'cs',
    resources: { cs: { translation: {} } },
  });
  let reads = 0;
  Object.defineProperty(instance.getDataByLanguage('cs'), 'translation', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('getter executed');
    },
  });
  expect(() =>
    captureOctaneI18nSnapshot({ instance, language: 'cs', languages: ['cs'] }),
  ).toThrow('accessors');
  expect(reads).toBe(0);
});

test('JSON escaping counts toward the complete wire budget', async () => {
  const wire = captureOctaneI18nSnapshot(context());
  wire.resources = {
    cs: { translation: { escaped: '\u0000'.repeat(800_000) } },
  };
  await expect(restoreOctaneI18nSnapshot(wire)).rejects.toThrow('budget');
});

test('a sparse array with an extra enumerable key is rejected', async () => {
  const wire = captureOctaneI18nSnapshot(context());
  const languages: string[] = [];
  languages.length = 1;
  Reflect.set(languages, 'extra', 'cs');
  wire.languages = languages;
  await expect(restoreOctaneI18nSnapshot(wire)).rejects.toThrow('dense');
});

test('arrays with authored prototypes are outside the closed JSON contract', async () => {
  const wire = captureOctaneI18nSnapshot(context());
  class LanguageList extends Array<string> {}
  wire.languages = new LanguageList('cs');
  await expect(restoreOctaneI18nSnapshot(wire)).rejects.toThrow('plain JSON');
});

test('an aborted named factory settles promptly and disposes a late instance', async () => {
  let finish:
    | ((instance: ReturnType<typeof createNativeI18nInstance>) => void)
    | undefined;
  let disposed = 0;
  const release = registerOctaneI18nSnapshotProfile({
    key: 'app.slow',
    version: '1',
    captureOptions: () => ({}),
    validateOptions: () => {},
    create: () =>
      new Promise(resolve => {
        finish = resolve;
      }),
    dispose: () => {
      disposed++;
    },
  });
  try {
    const host = context();
    associateOctaneI18nSnapshotProfile(host.instance, {
      key: 'app.slow',
      version: '1',
    });
    const wire = captureOctaneI18nSnapshot(host);
    const controller = new AbortController();
    const pending = restoreOctaneI18nSnapshot(wire, controller.signal);
    await Promise.resolve();
    controller.abort(new Error('cancel slow factory'));
    await expect(pending).rejects.toThrow('cancel slow factory');
    if (!finish) throw new Error('Profile was not invoked');
    const late = createNativeI18nInstance({
      lng: wire.language,
      resources: wire.resources,
    });
    finish(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toBe(1);
    expect(() => getNativeI18nSnapshotSeed(late)).toThrow(
      'explicit Worker profile',
    );
    expect(() =>
      captureOctaneI18nSnapshot({
        instance: late,
        language: wire.language,
        languages: wire.languages,
      }),
    ).toThrow('disposed');
  } finally {
    release();
  }
});

test('validation-failure cleanup retires the returned genuine instance', async () => {
  const rejected = createNativeI18nInstance({
    lng: 'cs',
    resources: { cs: { translation: { wrong: 'Wrong resources' } } },
  });
  let disposed = 0;
  const release = registerOctaneI18nSnapshotProfile({
    key: 'app.invalid-resources',
    version: '1',
    captureOptions: () => ({}),
    validateOptions: () => {},
    create: () => rejected,
    dispose: () => {
      disposed++;
    },
  });
  try {
    const host = context();
    associateOctaneI18nSnapshotProfile(host.instance, {
      key: 'app.invalid-resources',
      version: '1',
    });
    await expect(
      restoreOctaneI18nSnapshot(captureOctaneI18nSnapshot(host)),
    ).rejects.toThrow('every loaded resource');
    expect(disposed).toBe(1);
    expect(() => getNativeI18nSnapshotSeed(rejected)).toThrow(
      'explicit Worker profile',
    );
    expect(() =>
      captureOctaneI18nSnapshot({
        instance: rejected,
        language: 'cs',
        languages: ['cs'],
      }),
    ).toThrow('disposed');
  } finally {
    release();
  }
});

test('a restored profile lease retains its original registration identity', async () => {
  const releaseFirst = registerOctaneI18nSnapshotProfile({
    key: 'app.registry-identity',
    version: '1',
    captureOptions: () => ({}),
    validateOptions: () => {},
    create: ({ language, resources }) =>
      createNativeI18nInstance({ lng: language, resources }),
  });
  let releaseSecond: (() => void) | undefined;
  let worker: I18nContextValue | undefined;
  let replacementCaptures = 0;
  try {
    const host = context();
    associateOctaneI18nSnapshotProfile(host.instance, {
      key: 'app.registry-identity',
      version: '1',
    });
    worker = await restoreOctaneI18nSnapshot(captureOctaneI18nSnapshot(host));
    expect(captureOctaneI18nSnapshot(worker).profile).toEqual({
      key: 'app.registry-identity',
      version: '1',
    });
    releaseFirst();
    releaseSecond = registerOctaneI18nSnapshotProfile({
      key: 'app.registry-identity',
      version: '1',
      captureOptions: () => {
        replacementCaptures++;
        return { changed: true };
      },
      validateOptions: () => {},
      create: ({ language, resources }) =>
        createNativeI18nInstance({ lng: language, resources }),
    });
    const retained = worker;
    expect(() => captureOctaneI18nSnapshot(retained)).toThrow('changed exact');
    expect(() =>
      associateOctaneI18nSnapshotProfile(retained.instance, {
        key: 'app.registry-identity',
        version: '1',
      }),
    ).toThrow('owning profile');
    expect(replacementCaptures).toBe(0);
    disposeOctaneI18nSnapshot(worker);
    expect(() =>
      associateOctaneI18nSnapshotProfile(retained.instance, {
        key: 'app.registry-identity',
        version: '1',
      }),
    ).toThrow('live genuine');
    expect(() => captureOctaneI18nSnapshot({ ...retained })).toThrow(
      'disposed',
    );
  } finally {
    if (worker) disposeOctaneI18nSnapshot(worker);
    releaseSecond?.();
    releaseFirst();
  }
});

test('rejecting a reused profile instance preserves its first live owner', async () => {
  let instance: ReturnType<typeof createNativeI18nInstance> | undefined;
  let disposed = 0;
  const release = registerOctaneI18nSnapshotProfile({
    key: 'app.invalid-singleton',
    version: '1',
    captureOptions: () => ({}),
    validateOptions: () => {},
    create: input => {
      instance ??= createNativeI18nInstance({
        lng: input.language,
        resources: input.resources,
      });
      return instance;
    },
    dispose: () => {
      disposed++;
    },
  });
  try {
    const host = context();
    associateOctaneI18nSnapshotProfile(host.instance, {
      key: 'app.invalid-singleton',
      version: '1',
    });
    const wire = captureOctaneI18nSnapshot(host);
    const first = await restoreOctaneI18nSnapshot(wire);
    await expect(restoreOctaneI18nSnapshot(wire)).rejects.toThrow('fresh');
    expect(disposed).toBe(0);
    expect(first.instance.t('hello', { name: 'Ada' })).toBe('Ahoj Ada');
    disposeOctaneI18nSnapshot(first);
    expect(disposed).toBe(1);
  } finally {
    release();
  }
});

test('an exact named local profile restores custom formatters and owns cleanup', async () => {
  let disposed = 0;
  const release = registerOctaneI18nSnapshotProfile({
    key: 'app.uppercase',
    version: 'v1',
    captureOptions: () => ({ formatter: 'uppercase' }),
    validateOptions: options => {
      if (
        Object.keys(options).length !== 1 ||
        options.formatter !== 'uppercase'
      )
        throw new Error('Invalid formatter profile');
    },
    create: ({ language, resources }) => {
      const instance = createNativeI18nInstance({
        lng: language,
        resources,
        fallbackLng: 'en',
      });
      instance.services.formatter?.add('uppercase', value =>
        String(value).toUpperCase(),
      );
      return instance;
    },
    dispose: () => {
      disposed++;
    },
  });
  try {
    const instance = createNativeI18nInstance({
      lng: 'cs',
      resources: { cs: { translation: { text: '{{value, uppercase}}' } } },
    });
    instance.services.formatter?.add('uppercase', value =>
      String(value).toUpperCase(),
    );
    associateOctaneI18nSnapshotProfile(instance, {
      key: 'app.uppercase',
      version: 'v1',
    });
    const wire = captureOctaneI18nSnapshot({
      instance,
      language: 'cs',
      languages: ['cs'],
    });
    const worker = await restoreOctaneI18nSnapshot(wire);
    expect(worker.instance.t('text', { value: 'hello' })).toBe('HELLO');
    const recaptured = captureOctaneI18nSnapshot(worker);
    expect(recaptured.profile).toEqual({ key: 'app.uppercase', version: 'v1' });
    expect(recaptured.options).toEqual({ formatter: 'uppercase' });
    const second = await restoreOctaneI18nSnapshot(recaptured);
    expect(second.instance.t('text', { value: 'again' })).toBe('AGAIN');
    expect(second.instance).not.toBe(worker.instance);
    disposeOctaneI18nSnapshot(worker);
    disposeOctaneI18nSnapshot(worker);
    expect(() => captureOctaneI18nSnapshot(worker)).toThrow('disposed');
    expect(() => captureOctaneI18nSnapshot({ ...worker })).toThrow('disposed');
    expect(disposed).toBe(1);
    disposeOctaneI18nSnapshot(second);
    expect(() => captureOctaneI18nSnapshot(second)).toThrow('disposed');
    expect(disposed).toBe(2);
    release();
    await expect(restoreOctaneI18nSnapshot(wire)).rejects.toThrow(
      'Missing exact',
    );
  } finally {
    release();
  }
});
