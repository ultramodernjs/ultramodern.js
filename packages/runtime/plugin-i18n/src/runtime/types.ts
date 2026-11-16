import type { I18nInitOptions, I18nRuntimeInstance } from './i18n';

declare module '@modern-js/runtime' {
  interface RuntimeConfig {
    i18n?: {
      i18nInstance?: I18nRuntimeInstance;
      changeLanguage?: (lang: string) => void;
      setLang?: (lang: string) => void;
      initOptions?: I18nInitOptions;
    };
  }

  interface TRuntimeContext {
    i18nInstance?: I18nRuntimeInstance;
    changeLanguage?: (lang: string) => Promise<void>;
  }
}
