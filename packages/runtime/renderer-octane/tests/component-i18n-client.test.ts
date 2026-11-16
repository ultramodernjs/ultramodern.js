import { createNativeI18nInstance } from '@modern-js/i18n-runtime-extensions/native';
import { RENDERER_BOOTSTRAP_ID } from '@modern-js/renderer-core/document';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { expect, rstest, test } from '@rstest/core';
import { createElement } from 'octane';
import { startNativeClient } from '../src/entry-client';
import type { I18nInstanceLike } from '../src/i18n/types';
import { useI18n } from '../src/i18n/useI18n';

test('a component-only CSR document starts with the handed-off instance and changes language without a router', async () => {
  const identity: RendererIdentity = {
    renderer: 'octane',
    appId: 'component-store',
    entryName: 'main',
    protocolVersion: 1,
    buildId: 'component-build',
  };
  const resources = { translation: { greeting: 'Ahoj' } };
  const translator = createNativeI18nInstance({
    lng: 'cs',
    resources: { cs: resources, en: { translation: { greeting: 'Hello' } } },
  });
  const listeners = new Set<(language: string) => void>();
  const instance: I18nInstanceLike = {
    language: 'cs',
    get t() {
      return translator.getFixedT(instance.language);
    },
    changeLanguage: async language => {
      if (!language) return;
      instance.language = language;
      for (const listener of listeners) listener(language);
    },
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
  };
  const create = rstest.fn(async () => instance);
  const syncWithRouter = rstest.fn();
  let view: ReturnType<typeof useI18n> | undefined;
  let dispose: (() => void) | undefined;
  const root = document.createElement('div');
  root.id = 'root';
  const bootstrap = document.createElement('script');
  bootstrap.id = RENDERER_BOOTSTRAP_ID;
  bootstrap.type = 'application/json';
  bootstrap.textContent = JSON.stringify({
    identity,
    documentId: 'component-document',
    hydrating: false,
    nativeHydrationBuildId: 'native-component-build',
  });
  document.body.append(root, bootstrap);
  const originalUrl = window.location.href;

  try {
    startNativeClient({
      identity,
      nativeHydrationBuildId: 'native-component-build',
      load: async () => ({
        default: () => {
          view = useI18n();
          return createElement(
            'main',
            null,
            `${view.language}: ${view.t('greeting')}`,
          );
        },
      }),
      hot: {
        dispose: (callback: () => void) => {
          dispose = callback;
        },
      },
      i18n: {
        languages: ['en', 'cs'],
        resolveRequest: () => ({ kind: 'language', language: 'cs' }),
        redirect: location => Response.redirect(location),
        create,
        rewrite: () => ({}),
        handoff: () => ({ id: 'component-i18n', payload: '{}' }),
        clientHandoff: () => ({ language: 'cs', resources }),
        syncWithRouter,
      },
    });
    for (
      let attempt = 0;
      attempt < 100 && (!view || listeners.size === 0);
      attempt++
    )
      await new Promise(resolve => setTimeout(resolve, 10));

    expect(root.textContent).toBe('cs: Ahoj');
    expect(create).toHaveBeenCalledExactlyOnceWith('cs', resources);
    expect(view?.instance).toBe(instance);
    expect(view?.t('missing-key', 'Hello {{name}}', { name: 'Ada' })).toBe(
      'Hello Ada',
    );
    expect(listeners.size).toBe(1);
    await view?.changeLanguage('en');
    for (
      let attempt = 0;
      attempt < 100 && root.textContent !== 'en: Hello';
      attempt++
    )
      await new Promise(resolve => setTimeout(resolve, 10));

    expect(root.textContent).toBe('en: Hello');
    expect(view?.language).toBe('en');
    expect(window.location.href).toBe(originalUrl);
    expect(syncWithRouter).not.toHaveBeenCalled();
  } finally {
    dispose?.();
    root.remove();
    bootstrap.remove();
  }
  expect(listeners.size).toBe(0);
});
