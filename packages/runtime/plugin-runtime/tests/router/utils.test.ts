import {
  createRoutesFromElements,
  createStaticHandler,
  UNSAFE_ErrorResponseImpl as ErrorResponseImpl,
} from '@modern-js/runtime-utils/router';
import { Children, type ReactElement, type ReactNode } from 'react';
import { toErrorInfo } from '../../src/core/server/stream/deferredScript';
import { serializeErrors as serializeServerErrors } from '../../src/core/server/utils';
import {
  createRouteObjectsFromConfig,
  deserializeErrors,
  getLocation,
  renderRoutes,
  serializeErrors as serializeRouterErrors,
  standardSlash,
  urlJoin,
} from '../../src/router/runtime/utils';

function withNodeEnv<T>(nodeEnv: string | undefined, callback: () => T): T {
  const previousNodeEnv = process.env.NODE_ENV;
  if (nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = nodeEnv;
  }
  try {
    return callback();
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

describe('test runtime router utils', () => {
  it('should get location correctly', () => {
    const loc = getLocation({
      request: {
        pathname: '/a',
        url: '/a/b',
      },
    });
    expect(loc).toBe('/a/b');

    const loc1 = getLocation({
      request: {
        pathname: '/b',
        url: '/a/b',
      },
    });
    expect(loc1).toBe('/b');

    const loc2 = getLocation({
      request: {
        pathname: '/c',
        url: '/a/b',
      },
    });
    expect(loc2).toBe('/c');
  });

  it('should standard url slash', () => {
    expect(standardSlash('/a')).toBe('/a');
    expect(standardSlash('/a/')).toBe('/a');
    expect(standardSlash('//')).toBe('/');
    expect(standardSlash('/')).toBe('/');
    expect(standardSlash('./')).toBe('/');
    expect(standardSlash('a')).toBe('/a');
    expect(standardSlash(1 as any)).toBe(1);
  });

  it('should join url correctly', () => {
    expect(urlJoin('', '')).toBe('/');
    expect(urlJoin('/', '')).toBe('/');
    expect(urlJoin('/', '/')).toBe('/');
    expect(urlJoin('/', null as any)).toBe('/');
    expect(urlJoin('/', undefined as any)).toBe('/');
    expect(urlJoin('/a', '')).toBe('/a');
    expect(urlJoin('/a', '/')).toBe('/a');
    expect(urlJoin('/a', '/b')).toBe('/a/b');
    expect(urlJoin('/a', '/b/')).toBe('/a/b');
    expect(urlJoin('', '/b')).toBe('/b');
    expect(urlJoin('a', '/b')).toBe('/a/b');
  });

  it('adds a 404 loader to object-route catch-all routes', async () => {
    const routes = createRouteObjectsFromConfig({
      routesConfig: {
        routes: [
          {
            type: 'nested',
            origin: 'config',
            id: 'root',
            isRoot: true,
            path: '/',
          },
        ],
      },
    });

    const { query } = createStaticHandler(routes || []);
    const context = await query(new Request('http://localhost/missing'));

    expect(context).not.toBeInstanceOf(Response);
    expect((context as { statusCode: number }).statusCode).toBe(404);
  });

  it('adds a 404 loader to JSX catch-all routes', async () => {
    const routes = renderRoutes({
      routesConfig: {
        routes: [
          {
            type: 'nested',
            origin: 'config',
            id: 'root',
            isRoot: true,
            path: '/',
          },
        ],
      },
    });

    const catchAllRoute = routes?.at(-1) as
      | { props?: { loader?: () => Response; path?: string } }
      | undefined;
    const response = catchAllRoute?.props?.loader?.();

    expect(catchAllRoute?.props?.path).toBe('*');
    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(404);
  });

  it('lets React Router infer error boundaries from rendered error elements', async () => {
    function ErrorPage() {
      return null;
    }

    const routesConfig = {
      routes: [
        {
          type: 'nested' as const,
          origin: 'config' as const,
          id: 'root',
          isRoot: true,
          path: '/',
          hasErrorBoundary: true,
          children: [
            {
              type: 'nested' as const,
              origin: 'config' as const,
              id: 'child',
              path: 'child',
              hasErrorBoundary: true,
              error: ErrorPage,
              loader: () => {
                throw new Error('child loader failed');
              },
            },
          ],
        },
      ],
    };

    const objectRoutes = createRouteObjectsFromConfig({
      routesConfig,
    });
    const objectRoot = objectRoutes?.[0];
    const objectChild = objectRoot?.children?.[0];

    expect(objectRoot).not.toHaveProperty('hasErrorBoundary');
    expect(objectChild).not.toHaveProperty('hasErrorBoundary');
    expect(objectChild?.errorElement).toBeDefined();

    const jsxRoutes = renderRoutes({
      routesConfig,
    });
    const jsxRoot = jsxRoutes?.[0] as ReactElement<{
      children?: ReactNode;
    }>;
    const jsxChild = Children.toArray(jsxRoot.props.children)[0] as
      | ReactElement<Record<string, unknown>>
      | undefined;

    expect(jsxRoot.props).not.toHaveProperty('hasErrorBoundary');
    expect(jsxChild?.props).not.toHaveProperty('hasErrorBoundary');
    expect(jsxChild?.props.errorElement).toBeDefined();

    for (const routes of [
      objectRoutes ?? [],
      createRoutesFromElements(jsxRoutes),
    ]) {
      const { query } = createStaticHandler(routes);
      const context = await query(new Request('http://localhost/child'));
      if (context instanceof Response) {
        throw new Error('Expected a static router error context');
      }
      expect(context.statusCode).toBe(500);
      expect(context.errors).toEqual({
        child: expect.objectContaining({ message: 'child loader failed' }),
      });
    }
  });

  it('keeps object-route loader failures at HTTP 500', async () => {
    const routes = createRouteObjectsFromConfig({
      routesConfig: {
        routes: [
          {
            type: 'nested',
            origin: 'config',
            id: 'root',
            isRoot: true,
            path: '/',
            children: [
              {
                type: 'nested',
                origin: 'config',
                id: 'broken',
                path: 'broken',
                loader: () => {
                  throw new Error('loader failed');
                },
              },
            ],
          },
        ],
      },
    });

    const { query } = createStaticHandler(routes || []);
    const context = await query(new Request('http://localhost/broken'));

    expect(context).not.toBeInstanceOf(Response);
    expect((context as { statusCode: number }).statusCode).toBe(500);
  });

  it('redacts production route error messages and stacks for router hydration', () => {
    const secretError = new Error('database password leaked');
    secretError.stack = 'secret stack';
    const routeError = new ErrorResponseImpl(
      500,
      'secret status text',
      'secret response body',
      true,
    );

    const routerSerialized = withNodeEnv('production', () =>
      serializeRouterErrors({
        root: secretError,
        route: routeError,
      } as any),
    ) as Record<string, any>;
    const serverSerialized = withNodeEnv('production', () =>
      serializeServerErrors({
        root: secretError,
        route: routeError,
      } as any),
    ) as Record<string, any>;

    for (const serialized of [routerSerialized, serverSerialized]) {
      expect(serialized.root).toMatchObject({
        message: 'Unexpected Server Error',
        stack: undefined,
        __type: 'Error',
      });
      expect(serialized.route).toMatchObject({
        status: 500,
        statusText: 'Internal Server Error',
        data: 'Unexpected Server Error',
        internal: true,
        __type: 'RouteErrorResponse',
      });
      expect(JSON.stringify(serialized)).not.toContain('database password');
      expect(JSON.stringify(serialized)).not.toContain('secret stack');
      expect(JSON.stringify(serialized)).not.toContain('secret response body');
      expect(JSON.stringify(serialized)).not.toContain('secret status text');
    }
  });

  it('round-trips route error internal identity through both serializers', () => {
    const routeErrors = {
      internal: new ErrorResponseImpl(500, 'Internal', 'secret', true),
      external: new ErrorResponseImpl(404, 'Not Found', 'missing', false),
    };

    for (const serialize of [serializeRouterErrors, serializeServerErrors]) {
      const serialized = withNodeEnv('production', () =>
        serialize(routeErrors as any),
      );
      const deserialized = deserializeErrors(serialized as any) as Record<
        string,
        ErrorResponseImpl
      >;

      expect(deserialized.internal).toBeInstanceOf(ErrorResponseImpl);
      expect(deserialized.internal.internal).toBe(true);
      expect(deserialized.external).toBeInstanceOf(ErrorResponseImpl);
      expect(deserialized.external.internal).toBe(false);
    }
  });

  it('redacts production streaming deferred error messages and stacks', () => {
    const error = new Error('deferred stream secret');
    error.stack = 'deferred stack secret';

    const serialized = withNodeEnv('production', () => toErrorInfo(error));

    expect(serialized).toEqual({
      message: 'Unexpected Server Error',
    });
    expect(JSON.stringify(serialized)).not.toContain('deferred stream secret');
    expect(JSON.stringify(serialized)).not.toContain('deferred stack secret');
  });

  it.each([undefined, 'staging'])(
    'fails closed for streaming deferred errors when NODE_ENV is %s',
    nodeEnv => {
      const error = new Error('deferred stream secret');
      error.stack = 'deferred stack secret';

      const serialized = withNodeEnv(nodeEnv, () => toErrorInfo(error));

      expect(serialized).toEqual({
        message: 'Unexpected Server Error',
      });
      expect(JSON.stringify(serialized)).not.toContain(
        'deferred stream secret',
      );
      expect(JSON.stringify(serialized)).not.toContain('deferred stack secret');
    },
  );

  it('preserves development route error diagnostics', () => {
    const error = new Error('development detail');
    error.stack = 'development stack';

    const serialized = withNodeEnv('development', () =>
      serializeRouterErrors({ root: error } as any),
    ) as Record<string, any>;

    expect(serialized.root).toMatchObject({
      message: 'development detail',
      stack: 'development stack',
      __type: 'Error',
    });
  });
});
