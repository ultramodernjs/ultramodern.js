import {
  InternalRuntimeContext,
  RuntimeContext,
} from '@modern-js/runtime/context';
import type React from 'react';
import type { PropsWithChildren } from 'react';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModernI18nProvider, useModernI18n } from '../src/runtime/context';
import type { I18nInstance } from '../src/runtime/i18n';
import { Link } from '../src/runtime/Link';
import {
  createI18nRootWrapper,
  type I18nLanguageSynchronizationProps,
} from '../src/runtime/providerComposition';
import {
  I18nNavigationProvider,
  useI18nRouterAdapter,
} from '../src/runtime/routerAdapter';
import { createI18nInstance } from './helpers/i18nInstance';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const requestContext = {
  request: {},
  response: {},
};

async function renderI18nRoot(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <RuntimeContext.Provider
        value={{
          isBrowser: true,
          requestContext,
          context: requestContext,
        }}
      >
        {node}
      </RuntimeContext.Provider>,
    );
  });

  return {
    container,
    root,
  };
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

describe('i18n runtime wrapRoot', () => {
  let rendered: { container: HTMLElement; root: Root } | undefined;

  afterEach(() => {
    cleanup(rendered);
    rendered = undefined;
    rstest.useRealTimers();
    rstest.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  test('keeps the optional i18next provider inside Modern i18n context', async () => {
    const i18nInstance = createI18nInstance('cs');
    const observedLanguages: string[] = [];
    const I18nextProvider = ({
      children,
      i18n,
    }: PropsWithChildren<{ i18n: I18nInstance }>) => {
      const { language } = useModernI18n();
      observedLanguages.push(`${language}:${i18n.language}`);

      return <section data-testid="i18next-provider">{children}</section>;
    };
    const App = () => <main>router content</main>;
    const I18nRoot = createI18nRootWrapper({
      htmlLangAttr: false,
      localePathRedirect: false,
      languages: ['en', 'cs'],
      fallbackLanguage: 'en',
      getLatestI18nInstance: () => i18nInstance,
      getI18nextProvider: () => I18nextProvider,
    })(App);

    rendered = await renderI18nRoot(<I18nRoot />);

    expect(observedLanguages).toEqual(['cs:cs']);
    expect(rendered.container.textContent).toContain('router content');
  });
});

describe('native navigation extension contract', () => {
  test('renders the supplied router primitive and exposes provider-scoped navigation', async () => {
    const navigate = rstest.fn();
    const RouterLink = ({ to, children }: any) => (
      <a href={to} data-native="yes">
        {children}
      </a>
    );
    function Consumer() {
      const adapter = useI18nRouterAdapter();
      expect(adapter.navigate).toBe(navigate);
      expect(adapter.params).toEqual({ lang: 'cs' });
      return <Link to="/products?tag=x#detail">Products</Link>;
    }
    const rendered = await renderI18nRoot(
      <I18nNavigationProvider
        value={{
          hasRouter: true,
          navigate,
          params: { lang: 'cs' },
          location: { pathname: '/cs/products', search: '', hash: '' },
          Link: RouterLink,
        }}
      >
        <ModernI18nProvider
          value={{
            language: 'cs',
            i18nInstance: createI18nInstance('cs'),
            languages: ['en', 'cs'],
            localePathRedirect: true,
          }}
        >
          <Consumer />
        </ModernI18nProvider>
      </I18nNavigationProvider>,
    );
    try {
      expect(rendered.container.querySelector('a')?.getAttribute('href')).toBe(
        '/cs/products?tag=x#detail',
      );
      expect(
        rendered.container.querySelector('a')?.getAttribute('data-native'),
      ).toBe('yes');
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      cleanup(rendered);
    }
  });
});

describe('native synchronization extension contract', () => {
  test('uses the supplied component callback and preserves its state across parent renders', async () => {
    const instance = createI18nInstance('en');
    const synchronize = rstest.fn();
    const mounts = rstest.fn();
    const observed: I18nLanguageSynchronizationProps[] = [];
    const Synchronization = (props: I18nLanguageSynchronizationProps) => {
      observed.push(props);
      useEffect(() => {
        mounts();
        props.setLang('cs');
      }, []);
      return props.children(synchronize);
    };
    const Root = createI18nRootWrapper({
      htmlLangAttr: false,
      localePathRedirect: true,
      languages: ['en', 'cs'],
      fallbackLanguage: 'en',
      getLatestI18nInstance: () => instance,
      getI18nextProvider: () => null,
      LanguageSynchronization: Synchronization,
    })(() => {
      const { language } = useModernI18n();
      return <main>{language}</main>;
    });
    window.history.replaceState(null, '', '/cs/products');
    const rendered = await renderI18nRoot(<Root />);
    try {
      expect(rendered.container.textContent).toBe('cs');
      expect(synchronize).toHaveBeenCalledWith('cs');
      expect(observed.at(-1)?.i18nInstance).toBe(instance);
      expect(observed.at(-1)?.pathname).toBe('/cs/products');
      expect(observed.at(-1)?.prevLangRef.current).toBe('cs');
      await act(async () => {
        rendered.root.render(
          <RuntimeContext.Provider
            value={{ isBrowser: true, requestContext, context: requestContext }}
          >
            <Root unrelated="updated" />
          </RuntimeContext.Provider>,
        );
      });
      expect(mounts).toHaveBeenCalledTimes(1);
      expect(rendered.container.textContent).toBe('cs');
      expect(instance.changeLanguage).not.toHaveBeenCalled();
    } finally {
      cleanup(rendered);
      window.history.replaceState(null, '', '/');
    }
  });
});
