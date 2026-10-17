import {
  configuredLanguage,
  localizePath,
} from '@modern-js/i18n-runtime-extensions/paths';
import type { JSX } from '@solidjs/web';
import * as Solid from 'solid-js';
import {
  type AnyRouter,
  Link,
  type LinkComponentProps,
  useLocation,
  useRouter,
} from '../router';
import { I18nContext } from './context';

export interface LocalizedLinkProps
  extends Omit<
    LinkComponentProps<'a', AnyRouter, string, string>,
    'to' | 'mask' | 'href' | 'publicHref' | '_fromLocation'
  > {
  /** A canonical, language-agnostic target, e.g. `/products/red-shoe`. */
  to: string;
  /** Localize for a specific language instead of the current one. */
  language?: string;
  [key: `data-${string}`]: unknown;
}

/**
 * The native router owns navigation, preloading and active state. A route mask
 * publishes the selected language URL while keeping the canonical route;
 * the entry's router subscription synchronizes the i18next instance.
 */
export function LocalizedLink(props: LocalizedLinkProps): JSX.Element {
  const context = Solid.useContext(I18nContext);
  const router = useRouter();
  const location = useLocation();
  const options = Solid.omit(props, 'to', 'language', 'children');
  const targetLanguage = () =>
    props.language === undefined
      ? context.language()
      : configuredLanguage(props.language, context.languages);
  const externalTarget = () =>
    props.to.startsWith('//') || URL.canParse(props.to);
  const canonicalTarget = () => ({
    to: props.to,
    from: props.from,
    params: props.params,
    unsafeRelative: props.unsafeRelative,
  });
  const pathname = Solid.createMemo(() => {
    if (externalTarget()) return props.to;
    const target = router.buildLocation({
      ...canonicalTarget(),
      _fromLocation: location(),
    });
    return localizePath(target.pathname, targetLanguage(), {
      languages: [...context.languages],
      localisedUrls: context.localisedUrls,
    });
  });

  return (
    <Link<AnyRouter, string, string, string, string>
      {...options}
      to={router.options.rewrite ? props.to : pathname()}
      mask={
        router.options.rewrite && !externalTarget()
          ? {
              to: pathname(),
              inheritSearch: true,
              hash: props.hash,
              state: props.state,
            }
          : undefined
      }
      hreflang={
        targetLanguage() === context.language() ? undefined : targetLanguage()
      }
    >
      {props.children}
    </Link>
  );
}
