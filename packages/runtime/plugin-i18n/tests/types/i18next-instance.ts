import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { useModernI18n } from '../../src/runtime/context';
import type { I18nInstance } from '../../src/runtime/i18n/instance';

// The documented `runtime: { i18n: { i18nInstance: i18next } }` usage.
export const defaultInstance: I18nInstance = i18next;
export const createdInstance: I18nInstance = i18next.createInstance();

export const plain: string = defaultInstance.t('title');
export const keys: string = defaultInstance.t(['missing', 'title']);
export const withDefault: string = defaultInstance.t('title', 'Title');
export const withOptions: string = defaultInstance.t('items', { count: 2 });
export const fixed: string = defaultInstance.getFixedT?.('cs')('title') ?? '';

// @ts-expect-error i18next's own `t` rejects a non-key argument.
defaultInstance.t(1);

export function ReactI18nextTitle() {
  const { t, i18n } = useTranslation();
  const instance: I18nInstance = i18n;
  return `${t('title')}${instance.t('title')}`;
}

export function ModernTitle() {
  // Without a type argument the provider may hold a wrapper, so `t` accepts
  // only what both i18next and a wrapper's `t(key)` accept.
  const { t: anyInstanceT } = useModernI18n();
  // @ts-expect-error A wrapper's `t` takes no i18next options.
  anyInstanceT('items', { count: 2 });
  // For i18next itself the hook hands out i18next's own `t` and overloads.
  const { t } = useModernI18n<I18nInstance>();
  const count: string = t('items', { count: 2 });
  // @ts-expect-error i18next's own `t` rejects a non-key argument.
  t(1);
  return `${anyInstanceT('title')}${t('title')}${count}`;
}
