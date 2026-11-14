import { describe, expect, test } from '@rstest/core';
import { i18nPlugin as i18nCliPlugin } from '../src/cli';
import {
  collectApiPrefixes,
  i18nServerPlugin,
  matchesApiPrefix,
} from '../src/server';

const createRequestContext = (pathname: string) =>
  ({
    req: {
      url: `http://localhost${pathname}`,
    },
  }) as any;

describe('cli modifyFileSystemRoutes', () => {
  test('uses the no-react runtime entry when reactI18next is disabled', () => {
    const configs: unknown[] = [];
    let runtimePlugin:
      | {
          path: string;
          config: Record<string, unknown>;
        }
      | undefined;

    i18nCliPlugin({ reactI18next: false }).setup({
      config: (getConfig: () => unknown) => configs.push(getConfig()),
      _internalRuntimePlugins: (fn: any) => {
        const plugins: Array<{
          path: string;
          config: Record<string, unknown>;
        }> = [];
        fn({
          entrypoint: { entryName: 'main' },
          plugins,
        });
        runtimePlugin = plugins[0];
      },
      modifyFileSystemRoutes: () => {},
      _internalServerPlugins: () => {},
      getAppContext: () => ({
        appDirectory: process.cwd(),
        metaName: 'modern-js',
      }),
      getNormalizedConfig: () => ({}),
    } as any);

    expect(runtimePlugin?.path).toBe(
      '@modern-js/plugin-i18n/runtime/no-react-i18next',
    );
    expect(runtimePlugin?.config.reactI18next).toBe(false);
    expect(configs).toEqual([
      { tools: { bundlerChain: expect.any(Function) } },
    ]);
  });

  test('upstream-style configs without a map keep routes untouched', async () => {
    const configs: unknown[] = [];
    // The hook is registered unconditionally now that route expansion is a
    // native feature; what matters is that a config with no `localisedUrls`
    // map gets its routes back byte-for-byte instead of a locale-expanded tree.
    let handler:
      | ((args: { entrypoint: unknown; routes: unknown[] }) => Promise<{
          routes: unknown[];
        }>)
      | undefined;

    i18nCliPlugin({
      localeDetection: { localePathRedirect: true, languages: ['en', 'cs'] },
    }).setup({
      config: (getConfig: () => unknown) => configs.push(getConfig()),
      _internalRuntimePlugins: () => {},
      _internalServerPlugins: () => {},
      modifyFileSystemRoutes: (fn: any) => {
        handler = fn;
      },
    } as any);

    const routes = [{ id: 'about', path: 'about', type: 'nested' }];
    const result = await handler?.({
      entrypoint: { entryName: 'main' },
      routes,
    });

    expect(result?.routes).toEqual(routes);
    expect(configs).toEqual([
      { tools: { bundlerChain: expect.any(Function) } },
    ]);
  });
});

describe('i18n server API prefix skips', () => {
  test('collects API route prefixes and normalized BFF config prefixes', () => {
    expect(
      collectApiPrefixes(
        [
          { entryName: 'main', isApi: false, urlPath: '/' },
          { isApi: true, urlPath: '/bff-api' },
          { isApi: true, urlPath: '/rpc/*' },
          { isApi: true, urlPath: '/' },
          { isApi: true },
        ],
        ['bff-api/', '/internal-api'],
      ),
    ).toEqual(['/bff-api', '/rpc', '/internal-api']);
  });

  test('matches API prefixes by exact path or slash-delimited segment', () => {
    const prefixes = ['/bff-api'];

    expect(matchesApiPrefix('/bff-api', prefixes)).toBe(true);
    expect(matchesApiPrefix('/bff-api/ping', prefixes)).toBe(true);
    expect(matchesApiPrefix('/bff-api-v2', prefixes)).toBe(false);
    expect(matchesApiPrefix('/bff-api-v2/ping', prefixes)).toBe(false);
  });

  test('skips language detector and redirect middleware for API routes', async () => {
    const middlewares: any[] = [];
    const routes = [
      { entryName: 'main', entryPath: '', urlPath: '/' },
      { entryPath: '', isApi: true, urlPath: '/bff-api' },
    ];
    let prepare: (() => void) | undefined;

    i18nServerPlugin({
      localeDetection: {
        fallbackLanguage: 'en',
        languages: ['en', 'cs'],
        localePathRedirect: true,
      },
      staticRoutePrefixes: [],
    }).setup({
      getServerConfig: () => ({}),
      getServerContext: () => ({ middlewares, routes }),
      onPrepare: fn => {
        prepare = fn;
      },
    } as any);

    prepare?.();

    const detectorMiddleware = middlewares.find(
      middleware => middleware.name === 'i18n-language-detector',
    );
    const redirectMiddleware = middlewares.find(
      middleware => middleware.name === 'i18n-server-middleware',
    );

    expect(detectorMiddleware).toBeDefined();
    expect(redirectMiddleware).toBeDefined();

    for (const middleware of [detectorMiddleware, redirectMiddleware]) {
      let nextCalls = 0;
      const response = await middleware.handler(
        createRequestContext('/bff-api/ping'),
        async () => {
          nextCalls++;
        },
      );

      expect(response).toBeUndefined();
      expect(nextCalls).toBe(1);
    }
  });

  test('uses /api as the BFF prefix when BFF config is present without prefix', async () => {
    const middlewares: any[] = [];
    const routes = [{ entryName: 'main', entryPath: '', urlPath: '/' }];
    let prepare: (() => void) | undefined;

    i18nServerPlugin({
      localeDetection: {
        fallbackLanguage: 'en',
        languages: ['en', 'cs'],
        localePathRedirect: true,
      },
      staticRoutePrefixes: [],
    }).setup({
      getServerConfig: () => ({ bff: {} }),
      getServerContext: () => ({ middlewares, routes }),
      onPrepare: fn => {
        prepare = fn;
      },
    } as any);

    prepare?.();

    const redirectMiddleware = middlewares.find(
      middleware => middleware.name === 'i18n-server-middleware',
    );

    let nextCalls = 0;
    const response = await redirectMiddleware.handler(
      createRequestContext('/api/ping'),
      async () => {
        nextCalls++;
      },
    );

    expect(response).toBeUndefined();
    expect(nextCalls).toBe(1);
  });
});
