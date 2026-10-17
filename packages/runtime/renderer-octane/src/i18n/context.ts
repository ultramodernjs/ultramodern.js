import { createContext } from 'octane';
import type { I18nContextValue } from './types';

export type { I18nContextValue, I18nInstanceLike } from './types';

/**
 * Octane's `createContext<T>(defaultValue: T)` requires a default (unlike
 * Solid 2's default-less form), so a missing provider is detected by
 * checking for `null` in `useI18n`/`LocalizedLink` instead — the same
 * guard shape `@modern-js/plugin-i18n`'s React `ModernI18nContext` uses.
 */
export const I18nContext = createContext<I18nContextValue | null>(null);
