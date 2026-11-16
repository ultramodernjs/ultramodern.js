import i18next from 'i18next';
import type { I18nInstance } from '../../src/runtime/i18n';

export const testResources = {
  en: { translation: { greeting: 'Hello' } },
  cs: { translation: { greeting: 'Ahoj' } },
};

/**
 * A genuine, synchronously initialised i18next instance. Language changes are
 * recorded instead of applied unless the caller restores `changeLanguage`.
 */
export function createI18nInstance(language = 'en'): I18nInstance {
  const instance: I18nInstance = i18next.createInstance();
  instance.init({
    lng: language,
    fallbackLng: language,
    resources: testResources,
    initAsync: false,
  });
  instance.setLang = rstest.fn(async (next: string) => {
    void next;
  });
  instance.changeLanguage = rstest.fn(async () => undefined);
  return instance;
}
