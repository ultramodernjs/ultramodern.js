import { getInitialContext } from '@modern-js/runtime/context';
import i18next from 'i18next';
import { setupI18nBeforeRender } from '../src/runtime/pluginSetup';

test('registers the React integration once on a shared i18n instance', async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
  });
  const integration = { type: '3rdParty', init: rstest.fn() };
  const use = rstest.spyOn(instance, 'use');
  const setup = () =>
    setupI18nBeforeRender(getInitialContext(false), {
      api: { getRuntimeConfig: () => ({}) },
      userI18nInstance: instance,
      backendEnabled: false,
      i18nextDetector: false,
      localePathRedirect: false,
      languages: ['en'],
      fallbackLanguage: 'en',
      resolveReactI18nextIntegration: async () => ({
        initReactI18next: integration,
        I18nextProvider: null,
      }),
      setI18nextProvider: () => {},
    });
  try {
    await setup();
    await setup();
    expect(
      use.mock.calls.filter(([plugin]) => plugin === integration),
    ).toHaveLength(1);
  } finally {
    use.mockRestore();
  }
});
