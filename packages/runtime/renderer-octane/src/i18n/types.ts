import type { LocalisedUrlsOption } from '@modern-js/i18n-runtime-extensions/paths';
import type { i18n } from 'i18next';

/**
 * The slice of an i18next-shaped instance this binding needs. Deliberately
 * not `@modern-js/plugin-i18n`'s `I18nInstance`: that type is intentionally
 * narrowed (no index signature, non-overloaded methods — see plugin-i18n's
 * fork notes) and, more importantly, the plugin package's peer dependencies
 * require React/ReactDOM, which an Octane-only application must never need
 * to install. `on`/`off` are real i18next `EventEmitter` methods this
 * interface adds back for the reactive `languageChanged` subscription.
 * `t` is i18next's own `TFunction`, so keys, overloads and selectors follow
 * the application's i18next type configuration.
 */
export interface I18nInstanceLike {
  language: string;
  t: i18n['t'];
  changeLanguage?(lng?: string): Promise<unknown> | unknown;
  on?(event: 'languageChanged', callback: (lng: string) => void): void;
  off?(event: 'languageChanged', callback: (lng: string) => void): void;
  /** SSR per-request isolation: the server clones a base instance per request. */
  cloneInstance?(options?: Record<string, unknown>): I18nInstanceLike;
}

export interface I18nContextValue {
  /** Per-request instance. Never a module-level singleton. */
  instance: I18nInstanceLike;
  languages: readonly string[];
  localisedUrls?: LocalisedUrlsOption;
  /**
   * Reactive current language, owned by `I18nProvider`'s own `useState` +
   * one `languageChanged` subscription. `instance.language` is a plain
   * mutable field, not itself reactive — Octane's context only re-renders
   * consumers when the Provider commits a *new* `value` object (its
   * `$$version` bumps), so every consumer reads this field off the context
   * value instead of reaching into `instance.language` directly.
   */
  language: string;
}
