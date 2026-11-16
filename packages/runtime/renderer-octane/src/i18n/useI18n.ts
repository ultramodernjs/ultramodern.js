import {
  configuredLanguage,
  localizePath,
} from '@modern-js/i18n-runtime-extensions/paths';
import { languageFromPathname } from '@modern-js/i18n-runtime-extensions/request-language';
import { useContext } from 'octane';
import { useRouter } from '../router';
import { I18nContext } from './context';
import type { I18nInstanceLike } from './types';

export interface UseI18nReturn {
  t: I18nInstanceLike['t'];
  /** Current language. Re-renders the calling component on `languageChanged`. */
  language: string;
  languages: readonly string[];
  /** The raw per-request instance, for advanced use (namespaces, `exists`, ...). */
  instance: I18nInstanceLike;
  /**
   * Switches the i18next instance's language. With a router, also navigates to
   * the localized path so the URL and active language stay aligned.
   */
  changeLanguage: (language: string) => Promise<void>;
}

/**
 * Language switches per instance run one at a time: a switch that a newer
 * one has superseded before it starts is skipped, so no two switches ever
 * interleave their language loads and navigations.
 */
const languageSwitches = new WeakMap<
  object,
  { latest: number; queue: Promise<void> }
>();

/**
 * Must render under `I18nProvider`; throws rather than silently reading a
 * fallback instance when no provider is mounted (Octane's `createContext`
 * requires a default value, so `I18nContext`'s default is `null` and this
 * hook turns that into a loud error instead of a shared singleton).
 */
export function useI18n(): UseI18nReturn {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error(
      '[renderer-octane] useI18n() was called outside of an I18nProvider.',
    );
  }
  const { instance, languages, localisedUrls, language } = context;

  const t = instance.t.bind(instance);

  const router = useRouter({ warn: false });

  const changeLanguage = (requested: string): Promise<void> => {
    // i18next would fall back silently and the URL would gain an unknown
    // segment. An unsupported request is rejected before it supersedes any
    // queued switch.
    let nextLanguage: string;
    try {
      nextLanguage = configuredLanguage(requested, languages);
    } catch (error) {
      return Promise.reject(error);
    }
    const state = languageSwitches.get(instance) ?? {
      latest: 0,
      queue: Promise.resolve(),
    };
    languageSwitches.set(instance, state);
    const generation = ++state.latest;
    const run = state.queue.then(async () => {
      if (state.latest !== generation) return;
      // Earlier switches have settled, so this is the language the current
      // URL was committed with.
      const committed = instance.language;
      // The public URL carries the locale. Under the i18n URL rewrite the
      // router's own location is canonical and has none.
      const publicLanguage = () =>
        router
          ? languageFromPathname(
              new URL(router.state.location.publicHref, 'http://localhost')
                .pathname,
              languages,
              router.options.basepath,
            )
          : undefined;
      // A failed, blocked or redirected switch leaves the page on some URL;
      // the language follows that URL's locale, or the committed language on
      // a URL without one.
      const reconcile = async () => {
        const language = publicLanguage() ?? committed;
        if (instance.language !== language)
          await instance.changeLanguage?.(language);
      };
      try {
        await instance.changeLanguage?.(nextLanguage);
      } catch (error) {
        await reconcile();
        throw error;
      }
      if (!router) return;
      // The full href keeps the query and fragment across the language switch.
      const href = localizePath(router.state.location.href, nextLanguage, {
        languages: [...languages],
        localisedUrls,
      });
      try {
        await router.navigate({ to: '.', href, replace: true });
      } catch (error) {
        await reconcile();
        throw error;
      }
      if (publicLanguage() !== nextLanguage) await reconcile();
    });
    state.queue = run.catch(() => {});
    return run;
  };

  return { t, language, languages, instance, changeLanguage };
}
