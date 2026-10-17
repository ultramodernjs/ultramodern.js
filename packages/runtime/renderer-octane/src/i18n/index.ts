export {
  createRequestLanguageRedirect,
  detectRequestLanguage,
  languageFromPathname,
  type RequestLanguageDetection,
  type ResolvedRequestLanguage,
  type ResolveRequestLanguageOptions,
  resolveRequestLanguage,
} from '@modern-js/i18n-runtime-extensions/request-language';
export {
  createI18nSsrHandoffInlineData,
  I18N_SSR_HANDOFF_ELEMENT_ID,
  type I18nSsrHandoffPayload,
  type I18nSsrHandoffResources,
  readI18nSsrHandoff,
} from '@modern-js/i18n-runtime-extensions/ssrLanguageHandoff';
// Renderer-neutral pieces an application entry composes with these bindings.
export {
  type CreateI18nUrlRewriteOptions,
  createI18nUrlRewrite,
  type I18nLocationRewrite,
} from '@modern-js/i18n-runtime-extensions/urlRewrite';
export { I18nContext } from './context';
export { I18nProvider, type I18nProviderProps } from './I18nProvider';
export { LocalizedLink, type LocalizedLinkProps } from './LocalizedLink';
export {
  type OctaneLatestLanguageSyncOptions,
  useLatestLanguageSync,
} from './languageSync';
export type { I18nContextValue, I18nInstanceLike } from './types';
export { type UseI18nReturn, useI18n } from './useI18n';
