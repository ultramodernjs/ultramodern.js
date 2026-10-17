import type { ComponentProps, JSX, ValidComponent } from '@solidjs/web';
import { Dynamic } from '@solidjs/web';
import type {
  AnyRouter,
  Constrain,
  LinkOptions,
  ParsedLocation,
  RegisteredRouter,
  RoutePaths,
} from '@tanstack/router-core';
import {
  deepEqual,
  exactPathTest,
  functionalUpdate,
  getUrlScheme,
  hasKeys,
  isDangerousProtocol,
  preloadWarning,
  removeTrailingSlash,
} from '@tanstack/router-core';
import { isServer } from '@tanstack/router-core/isServer';
import * as Solid from 'solid-js';

import { useHydrated } from './ClientOnly';
import type {
  ValidateLinkOptions,
  ValidateLinkOptionsArray,
} from './typePrimitives';
import { useRouter } from './useRouter';
import { useIntersectionObserver } from './utils';

function mergeRefs<T>(...refs: Array<unknown>): (el: T) => void {
  const setRef = (ref: unknown, el: T) => {
    if (typeof ref === 'function') {
      ref(el);
    } else if (Array.isArray(ref)) {
      for (const nestedRef of ref) {
        setRef(nestedRef, el);
      }
    }
  };

  return (el: T) => {
    for (const ref of refs) {
      setRef(ref, el);
    }
  };
}

function splitProps<T extends Record<string, any>, TKey extends keyof T>(
  props: T,
  keys: ReadonlyArray<TKey>,
): [Pick<T, TKey>, Omit<T, TKey>] {
  const _local = {} as Pick<T, TKey>;
  const _rest = {} as Omit<T, TKey>;

  // A safe way to polyfill splitProps if native getter copy is too complex
  // is just to return [props, Solid.omit(props, keys)] but it modifies typing.
  // Actually, Solid.omit exists!
  // Note: Solid.omit uses rest params (...keys), so we must spread the array.
  return [props as any, Solid.omit(props, ...(keys as any)) as any];
}
const timeoutMap = new WeakMap<object, ReturnType<typeof setTimeout>>();
const cancelPreload = (eventTarget: object) => {
  clearTimeout(timeoutMap.get(eventTarget));
  timeoutMap.delete(eventTarget);
};

export function useLinkProps<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends RoutePaths<TRouter['routeTree']> | string = string,
  TTo extends string = '',
  TMaskFrom extends RoutePaths<TRouter['routeTree']> | string = TFrom,
  TMaskTo extends string = '',
>(
  options: UseLinkPropsOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>,
): ComponentProps<'a'> {
  const router = useRouter();
  const shouldHydrateHash = !isServer && !!router.options.ssr;
  const hasHydrated = useHydrated();

  let hasRenderFetched = false;

  // Defaults are resolved through accessors at the use sites instead of
  // merging them into the props. Every merge/omit proxy layered here gets
  // re-enumerated by spread() on each navigation, and V8 dispatches proxy
  // traps in native runtime code — keeping this path proxy-free is what
  // keeps Link updates cheap.
  const local = options;
  const activeProps = () => local.activeProps ?? STATIC_ACTIVE_PROPS_GET;
  const inactiveProps = () => local.inactiveProps ?? STATIC_INACTIVE_PROPS_GET;

  const propsSafeToSpread = Solid.omit(
    options as Record<string, any>,
    'activeProps',
    'inactiveProps',
    'activeOptions',
    'to',
    'preload',
    'preloadDelay',
    'preloadIntentProximity',
    'hashScrollIntoView',
    'replace',
    'startTransition',
    'resetScroll',
    'viewTransition',
    'target',
    'disabled',
    'style',
    'class',
    'onClick',
    'onBlur',
    'onFocus',
    'onMouseEnter',
    'onMouseLeave',
    'onMouseOver',
    'onMouseOut',
    'onTouchStart',
    'ignoreBlocker',
    'params',
    'search',
    'hash',
    'state',
    'mask',
    'reloadDocument',
    'unsafeRelative',
    'from',
  );

  const currentLocation = Solid.createMemo(() => router.stores.location.get(), {
    equals: (prev, next) => prev.href === next.href,
  });

  const _options = () => options;

  const next = Solid.createMemo(
    () => {
      // Rebuild when inherited search/hash or the current route context changes.
      const _fromLocation = currentLocation();
      const options = { _fromLocation, ..._options() } as any;
      // untrack because router-core will also access stores, which are signals in solid
      return Solid.untrack(() => router.buildLocation(options));
    },
    {
      lazy: true,
      // Navigations usually leave most links' built locations unchanged;
      // comparing hrefs lets downstream memos (href, isActive) skip work.
      equals: (prev, next) =>
        prev.href === next.href &&
        prev.external === next.external &&
        prev.maskedLocation?.href === next.maskedLocation?.href,
    },
  );

  // A `to` with a URL scheme skips route resolution: the URL itself when the
  // router allows its protocol, `null` when it is blocked, `undefined` for a
  // route path. Read through the accessor so a reactive `to` can move between
  // the three states after setup.
  const directExternalLink = Solid.createMemo(
    () => resolveExternalLink(_options().to, router.protocolAllowlist),
    { lazy: true },
  );

  // The rendered href. `undefined` means disabled or blocked; neither renders
  // an href, so the browser cannot follow it either.
  const hrefOption = Solid.createMemo(
    () => {
      if (_options().disabled) return undefined;
      const direct = directExternalLink();
      if (direct !== undefined) return direct ?? undefined;
      return getHrefOption(next(), router);
    },
    { lazy: true },
  );

  const externalLink = Solid.createMemo(
    () => {
      const direct = directExternalLink();
      if (direct !== undefined) return direct ?? undefined;
      const href = hrefOption();
      return href && getUrlScheme(href) ? href : undefined;
    },
    { lazy: true },
  );

  // Disabled and blocked links render without an href, do not preload and do
  // not navigate. Enabled external links stay plain anchors.
  const linkDisabled = Solid.createMemo(
    () => !!local.disabled || (!externalLink() && hrefOption() === undefined),
    { lazy: true },
  );
  const blockedLink = () => linkDisabled() && !local.disabled;

  const preload = Solid.createMemo(
    () => {
      if (_options().reloadDocument || externalLink() || linkDisabled()) {
        return false;
      }
      return local.preload ?? router.options.defaultPreload;
    },
    { lazy: true },
  );
  const preloadDelay = () =>
    local.preloadDelay ?? router.options.defaultPreloadDelay ?? 0;

  const isActive = Solid.createMemo(
    () => {
      if (externalLink() || blockedLink()) return false;
      const activeOptions = local.activeOptions;
      const current = currentLocation();
      const nextLocation = next();

      if (activeOptions?.exact) {
        const testExact = exactPathTest(
          current.pathname,
          nextLocation.pathname,
          router.basepath,
        );
        if (!testExact) {
          return false;
        }
      } else {
        const currentPath = removeTrailingSlash(
          current.pathname,
          router.basepath,
        );
        const nextPath = removeTrailingSlash(
          nextLocation.pathname,
          router.basepath,
        );

        const pathIsFuzzyEqual =
          currentPath.startsWith(nextPath) &&
          (currentPath.length === nextPath.length ||
            currentPath[nextPath.length] === '/');
        if (!pathIsFuzzyEqual) {
          return false;
        }
      }

      if (activeOptions?.includeSearch ?? true) {
        const searchTest = deepEqual(
          current.search,
          nextLocation.search,
          !activeOptions?.exact,
          activeOptions?.explicitUndefined,
        );
        if (!searchTest) {
          return false;
        }
      }

      if (activeOptions?.includeHash) {
        const currentHash =
          shouldHydrateHash && !hasHydrated() ? '' : current.hash;
        return currentHash === nextLocation.hash;
      }
      return true;
    },
    { lazy: true },
  );

  const doPreload = () =>
    router
      .preloadRoute({ ...options, _builtLocation: next() } as any)
      .catch((err: any) => {
        console.warn(err);
        console.warn(preloadWarning);
      });

  const [ref, setRefSignal] = Solid.createSignal<Element | null>(null);

  const setRef = (el: Element | null) => {
    Solid.runWithOwner(null, () => {
      setRefSignal(el);
    });
  };

  const enqueuePreload = (
    e?: MouseEvent | FocusEvent | IntersectionObserverEntry,
  ) => {
    if (!e) {
      cancelPreload(ref);
      return;
    }

    if (
      !(
        (e as IntersectionObserverEntry).isIntersecting ??
        preload() === 'intent'
      )
    ) {
      if ((e as IntersectionObserverEntry).isIntersecting === false) {
        cancelPreload(ref);
      }
      return;
    }

    if (!preloadDelay()) {
      doPreload();
      return;
    }

    if (!timeoutMap.has(ref)) {
      timeoutMap.set(
        ref,
        setTimeout(() => {
          timeoutMap.delete(ref);
          doPreload();
        }, preloadDelay()),
      );
    }
  };

  useIntersectionObserver(ref, enqueuePreload, () => preload() !== 'viewport');

  Solid.createEffect(preload, preloadValue => {
    if (hasRenderFetched) {
      return;
    }
    if (preloadValue === 'render') {
      Solid.untrack(() => doPreload());
      hasRenderFetched = true;
    }
  });

  // External and internal links share one props object whose getters follow
  // `externalLink()`, so a reactive `to` can switch between the two kinds.

  // The click handler
  const handleClick = (e: MouseEvent) => {
    // The browser follows external hrefs; blocked links have none to follow.
    if (externalLink() || linkDisabled()) return;
    const element = e.currentTarget as HTMLAnchorElement | SVGAElement;
    // A download link fetches its resource; the browser handles that click.
    if (element.hasAttribute('download')) return;
    // Check actual element's target attribute as fallback
    const elementTarget = element.getAttribute('target');
    const effectiveTarget = resolvedTarget() ?? elementTarget;

    if (
      !isCtrlEvent(e) &&
      !e.defaultPrevented &&
      (!effectiveTarget || effectiveTarget === '_self') &&
      e.button === 0
    ) {
      e.preventDefault();

      // All is well? Navigate!
      // N.B. we don't call `router.commitLocation(next) here because we want to run `validateSearch` before committing
      router.navigate({
        ...options,
        replace: local.replace,
        resetScroll: local.resetScroll,
        hashScrollIntoView: local.hashScrollIntoView,
        startTransition: local.startTransition,
        viewTransition: local.viewTransition,
        ignoreBlocker: local.ignoreBlocker,
      });
    }
  };

  const handleTouchStart = () => {
    if (preload() !== 'intent') return;
    doPreload();
  };

  const handleLeave = () => {
    if (preload() === 'intent') {
      cancelPreload(ref);
    }
  };

  const simpleStyling = Solid.createMemo(
    () =>
      activeProps() === STATIC_ACTIVE_PROPS_GET &&
      inactiveProps() === STATIC_INACTIVE_PROPS_GET &&
      local.class === undefined &&
      local.style === undefined,
    { lazy: true },
  );

  // activeProps/inactiveProps may supply event handlers too. Each runs after
  // the caller's own and, like it, can prevent the Link's behavior.
  const stateHandler =
    (key: string) => (): JSX.EventHandlerUnion<any, any> | undefined =>
      (resolvedStateProps() as Record<string, any>)[key];
  const handlers = (key: keyof typeof local & string) => [
    () => local[key] as JSX.EventHandlerUnion<any, any> | undefined,
    stateHandler(key),
  ];
  const onClick = createComposedHandler(handlers('onClick'), handleClick);
  const onBlur = createComposedHandler(handlers('onBlur'), handleLeave);
  const onFocus = createComposedHandler(handlers('onFocus'), enqueuePreload);
  const onMouseEnter = createComposedHandler(
    handlers('onMouseEnter'),
    enqueuePreload,
  );
  const onMouseOver = createComposedHandler(
    handlers('onMouseOver'),
    enqueuePreload,
  );
  const onMouseLeave = createComposedHandler(
    handlers('onMouseLeave'),
    handleLeave,
  );
  const onMouseOut = createComposedHandler(handlers('onMouseOut'), handleLeave);
  const onTouchStart = createComposedHandler(
    handlers('onTouchStart'),
    handleTouchStart,
  );

  type ResolvedLinkStateProps = Omit<ComponentProps<'a'>, 'style'> & {
    style?: JSX.CSSProperties;
  };

  // External links keep the caller's props as given, without state props.
  const resolvedStateProps = Solid.createMemo(
    (): ResolvedLinkStateProps => {
      const stateProps: ResolvedLinkStateProps = externalLink()
        ? EMPTY_OBJECT
        : ((isActive()
            ? functionalUpdate(activeProps() as any, {})
            : functionalUpdate(inactiveProps(), {})) ?? EMPTY_OBJECT);
      if (process.env.NODE_ENV !== 'production')
        warnUnknownStateKeys(stateProps, extraStateKeys);
      return stateProps;
    },
    { lazy: true },
  );

  // State props override the base props, target included: a `_blank` from
  // activeProps opens a new browsing context instead of navigating in place.
  const resolvedTarget = () => {
    const target = (resolvedStateProps() as { target?: string }).target;
    return target !== undefined ? target : local.target;
  };
  const stateOrBase = (key: string): unknown => {
    const state = (resolvedStateProps() as Record<string, unknown>)[key];
    return state !== undefined
      ? state
      : (propsSafeToSpread as Record<string, unknown>)[key];
  };

  const resolvedClass = Solid.createMemo(
    () => {
      if (simpleStyling()) return isActive() ? 'active' : undefined;
      return (
        [local.class, resolvedStateProps().class].filter(Boolean).join(' ') ||
        undefined
      );
    },
    { lazy: true },
  );

  const resolvedStyle = Solid.createMemo(
    () => {
      if (simpleStyling()) return local.style;
      const style = { ...local.style, ...resolvedStateProps().style };
      return hasKeys(style) ? style : undefined;
    },
    { lazy: true },
  );

  // The returned object must be a plain object with a stable key set so the
  // consuming spread() never enumerates through proxy traps. Reactivity lives
  // in the property getters; values that no longer apply resolve to undefined,
  // which spread()/assign() treats as attribute removal. Keys returned by
  // activeProps/inactiveProps are discovered once at setup: their values stay
  // reactive, but a key first returned later is not applied, and development
  // builds warn about it.
  const extraStateKeys = new Set<string>();
  Solid.untrack(() => {
    for (const stateProps of [
      functionalUpdate(activeProps() as any, {}),
      functionalUpdate(inactiveProps(), {}),
    ]) {
      if (stateProps) {
        for (const key of Object.keys(stateProps)) {
          if (key !== 'class' && key !== 'style') extraStateKeys.add(key);
        }
      }
    }
  });

  const composedRef = mergeRefs(setRef, (el: Element) => {
    const r = _options().ref as any;
    if (typeof r === 'function') r(el);
  });

  const linkProps: Record<string, any> = {};
  for (const key of Object.keys(propsSafeToSpread)) {
    Object.defineProperty(
      linkProps,
      key,
      Object.getOwnPropertyDescriptor(propsSafeToSpread, key)!,
    );
  }
  for (const key of extraStateKeys) {
    Object.defineProperty(linkProps, key, {
      get: () => (resolvedStateProps() as Record<string, any>)[key],
      enumerable: true,
      configurable: true,
    });
  }

  const defineGetters = (getters: Record<string, () => any>) => {
    for (const [key, get] of Object.entries(getters)) {
      Object.defineProperty(linkProps, key, {
        get,
        enumerable: true,
        configurable: true,
      });
    }
  };

  // The Link owns ref and onClick. Define them over any getter a state prop
  // installed above; a plain assignment to a getter-only key throws.
  for (const [key, value] of [
    ['ref', composedRef],
    ['onClick', onClick],
  ] as const)
    Object.defineProperty(linkProps, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });

  // Intent preloading is the only thing these handlers do, and each of them
  // already bails at a `preload() !== 'intent'` gate. Handing them out anyway
  // is not free: Solid does not delegate mouseenter/mouseleave/focus/blur, so
  // every anchor installs four real listeners that exist only to return. On a
  // list view — a table of rows, a calendar of spans — that is four listeners
  // per row for no behaviour at all.
  //
  // So when intent preloading is off, the property resolves to whatever the
  // user passed (or undefined), and spread()/assign() installs nothing. The
  // getters keep this reactive: flipping `preload` back to 'intent' re-runs
  // the consuming spread, which attaches the composed handler then.
  // Without intent preloading only the caller's and state handlers remain, so
  // nothing is installed unless one of them exists.
  const onIntent = (composed: (event: any) => void, key: string) => {
    const passthrough = createComposedHandler(handlers(key as never));
    return () =>
      preload() === 'intent'
        ? composed
        : (local as Record<string, unknown>)[key] || stateHandler(key)()
          ? passthrough
          : undefined;
  };

  defineGetters({
    onBlur: onIntent(onBlur, 'onBlur'),
    onFocus: onIntent(onFocus, 'onFocus'),
    onMouseEnter: onIntent(onMouseEnter, 'onMouseEnter'),
    onMouseOver: onIntent(onMouseOver, 'onMouseOver'),
    onMouseLeave: onIntent(onMouseLeave, 'onMouseLeave'),
    onMouseOut: onIntent(onMouseOut, 'onMouseOut'),
    onTouchStart: onIntent(onTouchStart, 'onTouchStart'),
  });

  defineGetters({
    href: hrefOption,
    disabled: () => !!local.disabled || linkDisabled(),
    target: resolvedTarget,
    // The Link owns these only while disabled or active, as upstream Links
    // do; otherwise a value from the state props, then the base props, wins.
    role: () => (linkDisabled() ? 'link' : stateOrBase('role')),
    'aria-disabled': () =>
      linkDisabled() ? 'true' : stateOrBase('aria-disabled'),
    'data-status': () => (isActive() ? 'active' : stateOrBase('data-status')),
    'aria-current': () => (isActive() ? 'page' : stateOrBase('aria-current')),
    class: resolvedClass,
    style: resolvedStyle,
  });

  return linkProps as any;
}

const STATIC_ACTIVE_PROPS = { class: 'active' };
const STATIC_ACTIVE_PROPS_GET = () => STATIC_ACTIVE_PROPS;
const EMPTY_OBJECT = {};
const STATIC_INACTIVE_PROPS_GET = () => EMPTY_OBJECT;

/** Call a JSX.EventHandlerUnion with the event. */
function callHandler<T, TEvent extends Event>(
  event: TEvent & { currentTarget: T; target: Element },
  handler: JSX.EventHandlerUnion<T, TEvent>,
) {
  if (typeof handler === 'function') {
    handler(event);
  } else {
    handler[0](handler[1], event);
  }
  return event.defaultPrevented;
}

/** Run each handler in order; one that prevents default skips the rest. */
function createComposedHandler<T, TEvent extends Event>(
  getHandlers: readonly (() => JSX.EventHandlerUnion<T, TEvent> | undefined)[],
  fallback?: (event: TEvent) => void,
) {
  return (event: TEvent & { currentTarget: T; target: Element }) => {
    for (const getHandler of getHandlers) {
      const handler = getHandler();
      if (handler && callHandler(event, handler)) return;
    }
    fallback?.(event);
  };
}

export type UseLinkPropsOptions<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends RoutePaths<TRouter['routeTree']> | string = string,
  TTo extends string | undefined = '.',
  TMaskFrom extends RoutePaths<TRouter['routeTree']> | string = TFrom,
  TMaskTo extends string = '.',
> = ActiveLinkOptions<'a', TRouter, TFrom, TTo, TMaskFrom, TMaskTo> &
  Omit<ComponentProps<'a'>, 'style'> & { style?: JSX.CSSProperties };

export type ActiveLinkOptions<
  TComp = 'a',
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = '.',
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '.',
> = LinkOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> &
  ActiveLinkOptionProps<TComp>;

type ActiveLinkProps<TComp> = Partial<
  LinkComponentSolidProps<TComp> & {
    [key: `data-${string}`]: unknown;
  }
>;

export interface ActiveLinkOptionProps<TComp = 'a'> {
  /**
   * A function that returns additional props for the `active` state of this link.
   * These props override other props passed to the link (`style`'s are merged, `class`'s are concatenated)
   */
  activeProps?: ActiveLinkProps<TComp> | (() => ActiveLinkProps<TComp>);
  /**
   * A function that returns additional props for the `inactive` state of this link.
   * These props override other props passed to the link (`style`'s are merged, `class`'s are concatenated)
   */
  inactiveProps?: ActiveLinkProps<TComp> | (() => ActiveLinkProps<TComp>);
}

export type LinkProps<
  TComp = 'a',
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = '.',
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '.',
> = ActiveLinkOptions<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo> &
  LinkPropsChildren;

export interface LinkPropsChildren {
  // If a function is passed as a child, it will be given the `isActive` boolean to aid in further styling on the element it returns
  children?: JSX.Element | ((state: { isActive: boolean }) => JSX.Element);
}

type LinkComponentSolidProps<TComp> = TComp extends ValidComponent
  ? Omit<ComponentProps<TComp>, keyof CreateLinkProps>
  : never;

export type LinkComponentProps<
  TComp = 'a',
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = '.',
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '.',
> = LinkComponentSolidProps<TComp> &
  LinkProps<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo>;

export type CreateLinkProps = LinkProps<
  any,
  any,
  string,
  string,
  string,
  string
>;

export type LinkComponent<
  in out TComp,
  in out TDefaultFrom extends string = string,
> = <
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = TDefaultFrom,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(
  props: LinkComponentProps<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo>,
) => JSX.Element;

export interface LinkComponentRoute<
  in out TDefaultFrom extends string = string,
> {
  defaultFrom: TDefaultFrom;
  <
    TRouter extends AnyRouter = RegisteredRouter,
    const TTo extends string | undefined = undefined,
    const TMaskTo extends string = '',
  >(
    props: LinkComponentProps<
      'a',
      TRouter,
      this['defaultFrom'],
      TTo,
      this['defaultFrom'],
      TMaskTo
    >,
  ): JSX.Element;
}

export function createLink<const TComp>(
  Comp: Constrain<TComp, any, (props: CreateLinkProps) => JSX.Element>,
): LinkComponent<TComp> {
  return props => <Link {...props} _asChild={Comp} />;
}

export const Link: LinkComponent<'a'> = props => {
  const [local, rest] = splitProps(props as typeof props & { _asChild: any }, [
    '_asChild',
    'children',
  ]);
  const [_, linkProps] = splitProps(useLinkProps(rest as unknown as any), [
    'type',
  ]);

  // Resolve children once using Solid.children to avoid
  // re-accessing the children getter (which in Solid 2.0 would
  // re-invoke createComponent each time for JSX children).
  const resolvedChildren = Solid.children(() => local.children as JSX.Element);
  const children = () => {
    const ch = resolvedChildren();
    if (typeof ch === 'function') {
      return (ch as Function)({
        get isActive() {
          return (linkProps as any)['data-status'] === 'active';
        },
      });
    }

    return ch;
  };

  if (local._asChild === 'svg') {
    const [_, svgLinkProps] = splitProps(linkProps as any, ['class']);
    return (
      <svg>
        <a {...svgLinkProps}>{children()}</a>
      </svg>
    );
  }

  if (!local._asChild) {
    return <a {...linkProps}>{children()}</a>;
  }

  return (
    <Dynamic component={local._asChild as ValidComponent} {...linkProps}>
      {children()}
    </Dynamic>
  );
};

function isCtrlEvent(e: MouseEvent) {
  return !!(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey);
}

const warnedStateKeys = new Set<string>();

function warnUnknownStateKeys(
  stateProps: object,
  knownKeys: ReadonlySet<string>,
) {
  for (const key of Object.keys(stateProps)) {
    if (
      key === 'class' ||
      key === 'style' ||
      knownKeys.has(key) ||
      warnedStateKeys.has(key)
    )
      continue;
    warnedStateKeys.add(key);
    console.warn(
      `Link activeProps/inactiveProps returned "${key}" after the Link was created; return every key from the start (use undefined for "unset") so it can be applied.`,
    );
  }
}

function warnBlockedLink(href: string) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`Blocked Link with dangerous protocol: ${href}`);
  }
}

/**
 * Classifies a `to` by URL scheme, as upstream router Links do: the URL when
 * the router's protocol allowlist admits it, `null` when it is blocked, and
 * `undefined` for a route path that still needs route resolution.
 */
function resolveExternalLink(
  to: unknown,
  protocolAllowlist: AnyRouter['protocolAllowlist'],
): string | null | undefined {
  const scheme = typeof to === 'string' ? getUrlScheme(to) : undefined;
  if (!scheme) return undefined;
  if (!protocolAllowlist.has(scheme)) {
    warnBlockedLink(to as string);
    return null;
  }
  return to as string;
}

/**
 * The display href of a built location. publicHref is the full URL when a
 * rewrite changed the origin and the origin-stripped path otherwise, so no URL
 * is constructed in the hot path. A rewritten or history-formatted href with a
 * disallowed protocol resolves to `undefined` and the link renders blocked.
 */
function getHrefOption(
  next: ParsedLocation,
  router: AnyRouter,
): string | undefined {
  const location = next.maskedLocation ?? next;
  const href = location.external
    ? location.publicHref
    : router.history.createHref(location.publicHref) || '/';
  if (
    (location.external || href !== location.publicHref) &&
    isDangerousProtocol(href, router.protocolAllowlist)
  ) {
    warnBlockedLink(href);
    return undefined;
  }
  return href;
}

export type LinkOptionsFnOptions<
  TOptions,
  TComp,
  TRouter extends AnyRouter = RegisteredRouter,
> =
  TOptions extends ReadonlyArray<any>
    ? ValidateLinkOptionsArray<TRouter, TOptions, string, TComp>
    : ValidateLinkOptions<TRouter, TOptions, string, TComp>;

export type LinkOptionsFn<TComp> = <
  const TOptions,
  TRouter extends AnyRouter = RegisteredRouter,
>(
  options: LinkOptionsFnOptions<TOptions, TComp, TRouter>,
) => TOptions;

export const linkOptions: LinkOptionsFn<'a'> = options => {
  return options as any;
};
