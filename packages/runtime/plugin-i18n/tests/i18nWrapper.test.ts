import { getInitialContext } from '@modern-js/runtime/context';
import {
  getActualI18nextInstance,
  getI18nextInstanceForProvider,
  isI18nWrapperInstance,
} from '../src/runtime/i18n/instance';
import { setupI18nBeforeRender } from '../src/runtime/pluginSetup';
import { TestI18nWrapper } from './helpers/i18nWrapper';

const setup = (wrapper: TestI18nWrapper) =>
  setupI18nBeforeRender(getInitialContext(false), {
    api: { getRuntimeConfig: () => ({}) },
    userI18nInstance: wrapper,
    backendEnabled: false,
    i18nextDetector: false,
    localePathRedirect: false,
    languages: ['en', 'cs'],
    fallbackLanguage: 'en',
    resolveReactI18nextIntegration: async () => null,
    setI18nextProvider: () => {},
  });

test('selects the native instance a wrapper owns', () => {
  const wrapper = new TestI18nWrapper();
  const native = wrapper.i18nInstance.instance;

  expect(isI18nWrapperInstance(wrapper)).toBe(true);
  expect(isI18nWrapperInstance(native)).toBe(false);
  expect(getActualI18nextInstance(wrapper)).toBe(native);
  expect(getActualI18nextInstance(native)).toBe(native);
  expect(getI18nextInstanceForProvider(wrapper)).toBe(native);
});

test('keeps the wrapper deferred until the plugin initialises the wrapper itself', async () => {
  const wrapper = new TestI18nWrapper();
  await wrapper.i18nInstance.instance.init({ lng: 'en' });
  // Initialising only the native instance does not enable the wrapper's `t`.
  expect(wrapper.t('greeting')).toBe('greeting');

  await setup(wrapper);

  expect(wrapper.i18nInstance.init).toBe(true);
  expect(wrapper.t('greeting')).toBe('«Hello»');
});

test('clones the wrapper per server request around a cloned native instance', async () => {
  const wrapper = new TestI18nWrapper();

  const requestInstance = await setup(wrapper);

  expect(requestInstance).not.toBe(wrapper);
  expect(requestInstance).toBeInstanceOf(TestI18nWrapper);
  expect(isI18nWrapperInstance(requestInstance)).toBe(true);
  const requestNative = getActualI18nextInstance(requestInstance);
  expect(requestNative).not.toBe(wrapper.i18nInstance.instance);
  expect(requestInstance.t('greeting')).toBe('«Hello»');
  expect(requestNative.t('greeting')).toBe('Hello');
});
