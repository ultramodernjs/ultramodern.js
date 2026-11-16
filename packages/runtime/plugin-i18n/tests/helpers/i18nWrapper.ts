import i18next, {
  type CloneOptions,
  type InitOptions,
  type i18n,
} from 'i18next';
import { testResources } from './i18nInstance';

/**
 * A custom instance in the shape the plugin supports: it owns a native
 * i18next instance at `i18nInstance.instance`, and its own `t` stays disabled
 * until the wrapper itself is initialised, even if the native instance is.
 * Its `t` transforms the native translation through `this`, so a caller that
 * bypasses the wrapper or drops its receiver renders something else.
 */
export class TestI18nWrapper {
  readonly i18nInstance: { instance: i18n; init: boolean };

  constructor(
    instance = i18next.createInstance({
      resources: testResources,
      fallbackLng: 'en',
    }),
  ) {
    this.i18nInstance = { instance, init: false };
  }

  get language() {
    return this.i18nInstance.instance.language;
  }

  use(plugin: Parameters<i18n['use']>[0]) {
    this.i18nInstance.instance.use(plugin);
    return this;
  }

  async init(options: InitOptions = {}) {
    await this.i18nInstance.instance.init(options);
    this.i18nInstance.init = true;
  }

  readonly quote = (text: string) => `«${text}»`;

  t(key: string): string {
    return this.i18nInstance.init
      ? this.quote(this.i18nInstance.instance.t(key))
      : key;
  }

  async setLang(language: string) {
    await this.i18nInstance.instance.changeLanguage(language);
  }

  cloneInstance(options?: CloneOptions) {
    const clone = new TestI18nWrapper(
      this.i18nInstance.instance.cloneInstance(options),
    );
    clone.i18nInstance.init = this.i18nInstance.init;
    return clone;
  }
}
