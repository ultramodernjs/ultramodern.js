import type { NestedRoute } from '@modern-js/types';
import {
  handleRequest,
  type LoaderRouteIdResolver,
  setLoaderRouteIdResolver,
} from '../src/runtime';

const routes: NestedRoute[] = [
  {
    type: 'nested',
    id: 'item',
    path: 'items/:id',
    loader: ({ params }) => Response.json({ id: params.id }),
  },
  {
    type: 'nested',
    id: 'other',
    path: 'other',
    loader: () => Response.json({ other: true }),
  },
];

function load(routeId: string, loaderContext = new Map<string, unknown>()) {
  const url = new URL('https://example.test/base/items/a%2Fb');
  url.searchParams.set('__loader', routeId);
  return handleRequest({
    request: new Request(url),
    routes,
    serverRoutes: [
      {
        urlPath: '/base',
        entryName: 'main',
        entryPath: 'index.html',
        isSSR: true,
      },
    ],
    context: {
      reporter: {},
      loaderContext,
      monitors: { timing() {} },
    } as Parameters<typeof handleRequest>[0]['context'],
  });
}

test('uses the requested route ID when no resolver is registered', async () => {
  expect(await (await load('item'))?.json()).toEqual({ id: 'a/b' });
  expect((await load('alias'))?.status).toBe(403);
});

test('provides source routes and matched IDs to the request resolver', async () => {
  const loaderContext = new Map<string, unknown>();
  const resolver = rstest.fn<LoaderRouteIdResolver>(
    (requestedRouteId, options) => {
      expect(requestedRouteId).toBe('alias');
      expect(options.routes).toBe(routes);
      expect(options.matchedRouteIds).toEqual(['item']);
      return 'item';
    },
  );
  setLoaderRouteIdResolver(loaderContext, resolver);

  expect(await (await load('alias', loaderContext))?.json()).toEqual({
    id: 'a/b',
  });
  expect(resolver).toHaveBeenCalledTimes(1);
});

test('keeps native route authorization after resolving an ID', async () => {
  const loaderContext = new Map<string, unknown>();
  setLoaderRouteIdResolver(loaderContext, () => 'other');

  expect((await load('alias', loaderContext))?.status).toBe(403);
});

test('isolates resolver registrations across concurrent request contexts', async () => {
  const first = new Map<string, unknown>();
  const second = new Map<string, unknown>();
  setLoaderRouteIdResolver(first, () => 'item');
  setLoaderRouteIdResolver(second, () => 'other');

  const responses = await Promise.all([
    load('alias', first),
    load('alias', second),
    load('alias'),
  ]);
  expect(responses.map(response => response?.status)).toEqual([200, 403, 403]);
});

test('propagates resolver failures without dispatching another route', async () => {
  const failure = new Error('route resolution failed');
  const loaderContext = new Map<string, unknown>();
  setLoaderRouteIdResolver(loaderContext, () => {
    throw failure;
  });

  await expect(load('alias', loaderContext)).rejects.toBe(failure);
});

test('keeps cached handlers separate for request-transformed route arrays', async () => {
  const createTransformedRoutes = (locale: string): NestedRoute[] => [
    {
      type: 'nested',
      id: `item-${locale}`,
      path: 'items/:id',
      loader: () => Response.json({ locale }),
    },
  ];
  const firstRoutes = createTransformedRoutes('cs');
  const secondRoutes = createTransformedRoutes('en');
  const first = new Map<string, unknown>();
  const second = new Map<string, unknown>();
  setLoaderRouteIdResolver(
    first,
    () => 'item-cs',
    sourceRoutes => {
      expect(sourceRoutes).toBe(routes);
      return firstRoutes;
    },
  );
  setLoaderRouteIdResolver(
    second,
    () => 'item-en',
    () => secondRoutes,
  );

  const responses = await Promise.all([
    load('alias', first),
    load('alias', second),
    load('alias', first),
  ]);
  expect(
    await Promise.all(responses.map(response => response?.json())),
  ).toEqual([{ locale: 'cs' }, { locale: 'en' }, { locale: 'cs' }]);
});
