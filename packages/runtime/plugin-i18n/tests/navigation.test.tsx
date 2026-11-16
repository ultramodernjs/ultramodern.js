import {
  InternalRuntimeContext,
  RuntimeContext,
} from '@modern-js/runtime/context';
import { applyRouterRuntimeState } from '@modern-js/runtime-extensions/router-state';
import i18next from 'i18next';
import type React from 'react';
import type { ComponentType, ReactNode } from 'react';
import { act, Component, memo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useModernI18n } from '../src/runtime/context';
import { createI18nPlugin } from '../src/runtime/core';
import type { I18nRuntimeInstance } from '../src/runtime/i18n';
import type { TranslateFn } from '../src/runtime/i18n/instance';
import { Link } from '../src/runtime/Link';
import { useIntegratedRouterAdapter } from '../src/runtime/navigation';
import { createI18nInstance, testResources } from './helpers/i18nInstance';
import { TestI18nWrapper } from './helpers/i18nWrapper';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const localisedUrls = {
  '/terms-of-service': {
    en: '/terms-of-service',
    cs: '/obchodni-podminky',
  },
};

/** A provider capability whose location can be republished. */
function createMutableTanstackRouter(pathname: string) {
  let snapshot = {
    location: { pathname, search: '', hash: '' },
    params: { lang: pathname.split('/')[1] ?? '' },
  };
  const listeners = new Set<() => void>();

  return {
    navigate: rstest.fn(async () => undefined),
    navigation: {
      getSnapshot: () => snapshot,
      Link: TanstackLink,
      navigate: rstest.fn(async () => undefined),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publishPathname(nextPathname: string) {
      snapshot = {
        location: { pathname: nextPathname, search: '', hash: '' },
        params: { lang: nextPathname.split('/')[1] ?? '' },
      };
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

const TanstackLink = ({ to, children, ...props }: any) => {
  const { prefetch: _prefetch, preload: _preload, ...anchorProps } = props;
  return (
    <a href={to} data-router-link="tanstack" {...anchorProps}>
      {children}
    </a>
  );
};

/**
 * A bare `appTools()` consumer: only `@modern-js/plugin-i18n` is registered, so
 * nothing supplies a `NavigationProvider`.
 */
function setupBareI18nRuntime(i18nInstance: I18nRuntimeInstance) {
  let wrapRoot: ((App: ComponentType<any>) => ComponentType<any>) | undefined;
  let beforeRender: ((context: any) => Promise<void>) | undefined;

  createI18nPlugin()({
    i18nInstance,
    reactI18next: false,
    localeDetection: {
      fallbackLanguage: 'en',
      i18nextDetector: false,
      languages: ['en', 'cs'],
      localePathRedirect: true,
      localisedUrls,
    },
  }).setup?.({
    getRuntimeConfig: () => ({}),
    resolveComponent: () => undefined,
    onBeforeRender: (callback: (context: any) => Promise<void>) => {
      beforeRender = callback;
    },
    wrapRoot: (callback: (App: ComponentType<any>) => ComponentType<any>) => {
      wrapRoot = callback;
    },
  } as any);

  if (!wrapRoot || !beforeRender) {
    throw new Error(
      'Expected the i18n runtime plugin to register wrapRoot and onBeforeRender',
    );
  }
  return { wrapRoot, beforeRender };
}

function createTanstackRuntimeContext(
  router: ReturnType<typeof createMutableTanstackRouter>,
) {
  const requestContext = { request: {}, response: {} };
  const runtimeContext: Record<string, unknown> = {
    isBrowser: true,
    requestContext,
    context: requestContext,
    router: { Link: TanstackLink },
  };
  applyRouterRuntimeState(runtimeContext, {
    framework: 'tanstack',
    instance: router,
    navigation: router.navigation,
  } as any);
  return runtimeContext;
}

/**
 * The CSR boot order: `plugin-tanstack`'s `onBeforeRender` publishes only the
 * hook API, and no router instance exists until `RouterWrapper` renders -
 * which is below anything that wraps the app, this provider included.
 */
function createTanstackCsrRuntimeContextWithoutRouter() {
  const requestContext = { request: {}, response: {} };
  return {
    isBrowser: true,
    requestContext,
    context: requestContext,
    router: {
      Link: TanstackLink,
      // `useRouter({ warn: false })` yields nothing before the instance exists.
      useRouter: () => null,
    },
  } as Record<string, unknown>;
}

async function renderBareRuntime(
  App: ComponentType<any>,
  runtimeContext: Record<string, unknown>,
  i18nInstance: I18nRuntimeInstance,
  // The context the plugin's `onBeforeRender` runs on; `null` renders the root
  // without its lifecycle. A nested Module Federation root
  // (`createNestedAppRenderer`) runs it on its own context before rendering.
  lifecycleContext: Record<string, unknown> | null = runtimeContext,
) {
  const { wrapRoot, beforeRender } = setupBareI18nRuntime(i18nInstance);
  // The runtime resolves the active instance in `onBeforeRender`; skipping it
  // leaves the provider without the language-synchronisation seam, which is
  // exactly the wiring these cases are about.
  if (lifecycleContext) {
    await beforeRender(lifecycleContext);
  }
  const Wrapped = wrapRoot(App);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InternalRuntimeContext.Provider value={runtimeContext as any}>
        <RuntimeContext.Provider value={runtimeContext as any}>
          <Wrapped />
        </RuntimeContext.Provider>
      </InternalRuntimeContext.Provider>,
    );
  });
  return { container, root };
}

function cleanup(rendered?: { container: HTMLElement; root: Root }) {
  if (!rendered) {
    return;
  }
  act(() => {
    rendered.root.unmount();
  });
  rendered.container.remove();
}

describe('bare plugin-i18n navigation adapter', () => {
  let rendered: { container: HTMLElement; root: Root } | undefined;

  afterEach(() => {
    cleanup(rendered);
    rendered = undefined;
    rstest.restoreAllMocks();
  });

  test('renders mapped locale URLs through the selected router Link', async () => {
    const router = createMutableTanstackRouter('/cs/obchodni-podminky');
    const App = () => (
      <Link to="/terms-of-service" data-testid="nav-terms">
        terms
      </Link>
    );

    rendered = await renderBareRuntime(
      App,
      createTanstackRuntimeContext(router),
      createI18nInstance('cs'),
    );

    const anchor = rendered.container.querySelector(
      '[data-testid="nav-terms"]',
    );
    // Without the adapter this is a plain `<a>`: no router link, no active state.
    expect(anchor?.getAttribute('data-router-link')).toBe('tanstack');
    expect(anchor?.getAttribute('href')).toBe('/cs/obchodni-podminky');
  });

  test('keeps active state language-invariant across mapped spellings', async () => {
    const App = () => (
      <Link to="/terms-of-service" data-testid="nav-terms">
        terms
      </Link>
    );

    for (const [language, pathname] of [
      ['en', '/en/terms-of-service'],
      ['cs', '/cs/obchodni-podminky'],
    ] as const) {
      const attempt = await renderBareRuntime(
        App,
        createTanstackRuntimeContext(createMutableTanstackRouter(pathname)),
        createI18nInstance(language),
      );
      try {
        const anchor = attempt.container.querySelector(
          '[data-testid="nav-terms"]',
        );
        expect(anchor?.getAttribute('data-status')).toBe('active');
        expect(anchor?.getAttribute('aria-current')).toBe('page');
      } finally {
        cleanup(attempt);
      }
    }
  });

  test('reports no router until the TanStack instance is installed', async () => {
    const runtimeContext = createTanstackCsrRuntimeContextWithoutRouter();
    const App = () => {
      const adapter = useIntegratedRouterAdapter();
      return <span data-testid="has-router">{String(adapter.hasRouter)}</span>;
    };

    rendered = await renderBareRuntime(
      App,
      runtimeContext,
      createI18nInstance('en'),
    );

    // The hook API is published but the instance is not, so claiming a router
    // here would hand `changeLanguage()` a `navigate` that only throws.
    expect(
      rendered.container.querySelector('[data-testid="has-router"]')
        ?.textContent,
    ).toBe('false');

    await act(async () => {
      applyRouterRuntimeState(runtimeContext, {
        framework: 'tanstack',
        navigation: createMutableTanstackRouter('/en/terms-of-service')
          .navigation,
      } as any);
    });

    // Installing the instance has to reach a provider that already rendered.
    expect(
      rendered.container.querySelector('[data-testid="has-router"]')
        ?.textContent,
    ).toBe('true');
  });

  test('reports no router for a framework the adapter cannot drive', async () => {
    // A custom provider may publish an instance under a name `navigate` has
    // no implementation for. Claiming a router then makes `changeLanguage()`
    // await a navigate that goes nowhere instead of the full-page fallback.
    const runtimeContext = createTanstackCsrRuntimeContextWithoutRouter();
    const App = () => {
      const adapter = useIntegratedRouterAdapter();
      return <span data-testid="has-router">{String(adapter.hasRouter)}</span>;
    };

    rendered = await renderBareRuntime(
      App,
      runtimeContext,
      createI18nInstance('en'),
    );
    await act(async () => {
      applyRouterRuntimeState(runtimeContext, {
        framework: 'custom-router',
        instance: { navigate: () => undefined, state: { location: {} } },
      } as any);
    });

    expect(
      rendered.container.querySelector('[data-testid="has-router"]')
        ?.textContent,
    ).toBe('false');
  });

  test('leaves links unrouted until the TanStack instance is installed', async () => {
    const runtimeContext = createTanstackCsrRuntimeContextWithoutRouter();
    const App = () => (
      <Link to="/terms-of-service" data-testid="nav-terms">
        terms
      </Link>
    );

    rendered = await renderBareRuntime(
      App,
      runtimeContext,
      createI18nInstance('en'),
    );
    const anchor = () =>
      rendered?.container.querySelector('[data-testid="nav-terms"]');
    expect(anchor()?.getAttribute('data-router-link')).toBeNull();

    await act(async () => {
      applyRouterRuntimeState(runtimeContext, {
        framework: 'tanstack',
        navigation: createMutableTanstackRouter('/cs/obchodni-podminky')
          .navigation,
      } as any);
    });

    expect(anchor()?.getAttribute('data-router-link')).toBe('tanstack');
  });

  test('replaces providers and stops observing the previous router', async () => {
    const first = createMutableTanstackRouter('/en/products/shoe');
    const second = createMutableTanstackRouter('/cs/produkty/bota');
    const runtimeContext = createTanstackRuntimeContext(first);
    const App = () => {
      const adapter = useIntegratedRouterAdapter();
      return <span data-testid="path">{adapter.location?.pathname}</span>;
    };
    rendered = await renderBareRuntime(
      App,
      runtimeContext,
      createI18nInstance('en'),
    );
    await act(async () => {
      applyRouterRuntimeState(runtimeContext, {
        framework: 'custom-provider',
        navigation: second.navigation,
      });
    });
    expect(
      rendered.container.querySelector('[data-testid="path"]')?.textContent,
    ).toBe('/cs/produkty/bota');
    await act(async () => first.publishPathname('/en/stale'));
    expect(
      rendered.container.querySelector('[data-testid="path"]')?.textContent,
    ).toBe('/cs/produkty/bota');
    await act(async () => second.publishPathname('/en/current'));
    expect(
      rendered.container.querySelector('[data-testid="path"]')?.textContent,
    ).toBe('/en/current');
  });

  test('follows the router location so the language tracks a client navigation', async () => {
    const router = createMutableTanstackRouter('/en/products/shoe');
    const App = () => {
      const { language } = useModernI18n();
      return <span data-testid="language">{language}</span>;
    };
    const i18nInstance = createI18nInstance('en');

    rendered = await renderBareRuntime(
      App,
      createTanstackRuntimeContext(router),
      i18nInstance,
    );
    expect(
      rendered.container.querySelector('[data-testid="language"]')?.textContent,
    ).toBe('en');

    await act(async () => {
      router.publishPathname('/cs/produkty/bota');
    });

    expect(
      rendered.container.querySelector('[data-testid="language"]')?.textContent,
    ).toBe('cs');
    expect(i18nInstance.setLang).toHaveBeenCalledWith('cs');
  });
});

class ErrorBoundary extends Component<
  { children: ReactNode },
  { message?: string }
> {
  state: { message?: string } = {};

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  render() {
    return this.state.message ?? this.props.children;
  }
}

describe('provider readiness across the runtime lifecycle', () => {
  let rendered: { container: HTMLElement; root: Root } | undefined;

  afterEach(() => {
    cleanup(rendered);
    rendered = undefined;
    rstest.restoreAllMocks();
  });

  // Memoised on `t` alone: it re-renders on a language switch only if `t`
  // changes identity with the language.
  const GreetingLabel = memo(({ translate }: { translate: TranslateFn }) => (
    <p data-testid="greeting">{translate('greeting')}</p>
  ));
  const Greeting = () => <GreetingLabel translate={useModernI18n().t} />;

  test('translates through the real instance and follows a language change', async () => {
    const router = createMutableTanstackRouter('/en/products/shoe');
    const i18nInstance = i18next.createInstance();
    i18nInstance.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: testResources,
      initAsync: false,
    });

    rendered = await renderBareRuntime(
      Greeting,
      createTanstackRuntimeContext(router),
      i18nInstance,
    );
    const greeting = () =>
      rendered?.container.querySelector('[data-testid="greeting"]')
        ?.textContent;
    expect(greeting()).toBe('Hello');

    await act(async () => {
      router.publishPathname('/cs/produkty/bota');
    });

    expect(i18nInstance.language).toBe('cs');
    expect(greeting()).toBe('Ahoj');
  });

  test('a nested root uses the instance its own lifecycle set up', async () => {
    const router = createMutableTanstackRouter('/cs/products/shoe');
    // A nested Module Federation root renders under a runtime context its
    // lifecycle did not write to, so the provider reads the plugin's instance.
    const renderContext = createTanstackRuntimeContext(router);

    rendered = await renderBareRuntime(
      Greeting,
      renderContext,
      createI18nInstance('cs'),
      createTanstackRuntimeContext(router),
    );

    expect(renderContext.i18nInstance).toBeUndefined();
    expect(rendered.container.textContent).toBe('Ahoj');
  });

  test('a root rendered outside its lifecycle renders and reports the missing provider', async () => {
    const router = createMutableTanstackRouter('/en/products/shoe');
    const App = () => (
      <>
        <h1>remote shell</h1>
        <ErrorBoundary>
          <Greeting />
        </ErrorBoundary>
      </>
    );
    rstest.spyOn(console, 'error').mockImplementation(() => {});

    rendered = await renderBareRuntime(
      App,
      createTanstackRuntimeContext(router),
      createI18nInstance('en'),
      null,
    );

    expect(rendered.container.querySelector('h1')?.textContent).toBe(
      'remote shell',
    );
    expect(rendered.container.textContent).toContain(
      'useModernI18n must be used within ModernI18nProvider',
    );
  });

  test('a custom wrapper keeps its own translate API, receiver and language reactivity', async () => {
    const router = createMutableTanstackRouter('/en/products/shoe');
    const wrapper = new TestI18nWrapper();
    let observed: I18nRuntimeInstance | undefined;
    const App = () => {
      const { i18nInstance, t } = useModernI18n();
      observed = i18nInstance;
      return (
        <p data-testid="greeting">{`${i18nInstance.t('greeting')}|${t('greeting')}`}</p>
      );
    };
    expect(wrapper.t('greeting')).toBe('greeting');

    rendered = await renderBareRuntime(
      App,
      createTanstackRuntimeContext(router),
      wrapper,
    );
    const greeting = () =>
      rendered?.container.querySelector('[data-testid="greeting"]')
        ?.textContent;

    expect(observed).toBe(wrapper);
    // Both go through the wrapper's own `t`, which reads `this`; the native
    // instance alone would render `Hello`.
    expect(greeting()).toBe('«Hello»|«Hello»');

    await act(async () => {
      router.publishPathname('/cs/produkty/bota');
    });

    expect(wrapper.i18nInstance.instance.language).toBe('cs');
    expect(greeting()).toBe('«Ahoj»|«Ahoj»');
  });
});
