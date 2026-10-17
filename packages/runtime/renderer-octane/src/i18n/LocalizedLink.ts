import {
  configuredLanguage,
  localizePath,
} from '@modern-js/i18n-runtime-extensions/paths';
import { createElement, hookSlots, type OctaneNode, useContext } from 'octane';
import {
  type AnyRouter,
  Link,
  type LinkComponentProps,
  useLocation,
  useRouter,
} from '../router';
import { I18nContext } from './context';

// Plain TypeScript is not rewritten by the Octane compiler: router hooks take
// their stable slot explicitly.
const targetLocationSlot = Symbol(hookSlots(1));

export interface LocalizedLinkProps
  extends Omit<
    LinkComponentProps<'a', AnyRouter, string, string>,
    'to' | 'mask' | 'href' | 'publicHref' | '_fromLocation'
  > {
  /** A canonical, language-agnostic target, e.g. `/products/red-shoe`. */
  to: string;
  /** Localize for a specific language instead of the current one. */
  language?: string;
}

/**
 * The native router owns client navigation, preloading and active state. Its mask
 * keeps the canonical route while publishing the selected language URL;
 * the entry's i18n router subscription synchronizes the instance on navigation.
 */
export function LocalizedLink(props: LocalizedLinkProps): OctaneNode {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error(
      '[renderer-octane] LocalizedLink was used outside of an I18nProvider.',
    );
  }
  const router = useRouter();
  const location = useLocation(undefined, targetLocationSlot);
  const { language: requestedLanguage, to, children, ...options } = props;
  const language =
    requestedLanguage === undefined
      ? context.language
      : configuredLanguage(requestedLanguage, context.languages);
  const externalTarget = to.startsWith('//') || URL.canParse(to);
  const pathname = externalTarget
    ? to
    : localizePath(
        router.buildLocation({
          to,
          from: options.from,
          params: options.params,
          unsafeRelative: options.unsafeRelative,
          _fromLocation: location,
        }).pathname,
        language,
        {
          languages: [...context.languages],
          localisedUrls: context.localisedUrls,
        },
      );

  return createElement(
    Link<AnyRouter, string, string, string, string>,
    {
      ...options,
      to: router.options.rewrite ? to : pathname,
      ...(router.options.rewrite && !externalTarget
        ? {
            mask: {
              to: pathname,
              inheritSearch: true,
              hash: options.hash,
              state: options.state,
            },
          }
        : {}),
      ...(language === context.language ? {} : { hreflang: language }),
    },
    children,
  );
}
