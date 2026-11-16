import i18next, { type InitOptions, type i18n } from 'i18next';
import { useModernI18n } from '../../src/runtime/context';
import type { I18nPluginOptions } from '../../src/runtime/core';
import type {
  I18nInstance,
  I18nRuntimeInstance,
  I18nWrapperInstance,
} from '../../src/runtime/i18n/instance';

// The supported custom-wrapper shape: a native instance at
// `i18nInstance.instance` and the wrapper's own narrower `t`.
class CustomI18nInstance {
  readonly i18nInstance = { instance: i18next.createInstance(), init: false };
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
  t(key: string) {
    return this.i18nInstance.init ? this.i18nInstance.instance.t(key) : key;
  }
  on(...args: Parameters<i18n['on']>) {
    this.i18nInstance.instance.on(...args);
    return this;
  }
  off(...args: Parameters<i18n['off']>) {
    this.i18nInstance.instance.off(...args);
    return this;
  }
  cloneInstance() {
    return new CustomI18nInstance();
  }
}

export const wrapper: I18nWrapperInstance = new CustomI18nInstance();
export const configured: I18nPluginOptions = {
  i18nInstance: new CustomI18nInstance(),
};
export const native: I18nRuntimeInstance = i18next;
// @ts-expect-error A wrapper's own `t` is not i18next's `t`.
export const notNative: I18nInstance = new CustomI18nInstance();

export function WrapperConsumer() {
  // An app that configures a wrapper names it; the hook's `t` is its own `t`.
  const { i18nInstance, t } = useModernI18n<I18nWrapperInstance>();
  const update = () => {};
  i18nInstance.on?.('loaded', update);
  i18nInstance.off?.('languageChanged', update);
  const own: string = i18nInstance.t('key');
  const viaHook: string = t('key');
  const wrapperT: (key: string) => string = t;
  // @ts-expect-error A wrapper's `t` takes no i18next options.
  t('key', { count: 1 });
  return `${own}${viaHook}${wrapperT('key')}`;
}
