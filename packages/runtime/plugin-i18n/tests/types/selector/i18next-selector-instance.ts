import i18next from 'i18next';
import { useModernI18n } from '../../../src/runtime/context';
import type { I18nInstance } from '../../../src/runtime/i18n/instance';

declare module 'i18next' {
  interface CustomTypeOptions {
    enableSelector: true;
    resources: {
      translation: { title: string; greeting: string };
    };
  }
}

// Application augmentation and the selector API reach `I18nInstance['t']`.
export const instance: I18nInstance = i18next;
export const title: string = instance.t($ => $.title);
// @ts-expect-error An unknown resource key is rejected by the selector.
instance.t($ => $.missing);

export function ModernTitle() {
  const { t } = useModernI18n<I18nInstance>();
  // @ts-expect-error The hook's `t` follows the same selector augmentation.
  t($ => $.missing);
  // @ts-expect-error Without the type argument the instance may be a wrapper.
  useModernI18n().t($ => $.greeting);
  return t($ => $.greeting);
}
