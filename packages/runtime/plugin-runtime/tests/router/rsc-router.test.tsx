import { ElementsContext } from '@modern-js/render/client';
import type {
  RouteObject,
  StaticHandlerContext,
} from '@modern-js/runtime-utils/router';
import {
  Outlet,
  UNSAFE_DataRouterContext,
} from '@modern-js/runtime-utils/router';
import { describe, expect, it } from '@rstest/core';
import React from 'react';
import { renderToReadableStream } from 'react-dom/server';
import type { ServerPayload } from '../../src/core/context';

(
  globalThis as typeof globalThis & {
    __webpack_require__?: { u: (chunkId: unknown) => string };
  }
).__webpack_require__ = {
  u: chunkId => String(chunkId),
};

const ComponentRoute = ({ loaderData }: { loaderData?: string }) => (
  <div>{loaderData}</div>
);

describe('RSC router payload', () => {
  it('serializes React Router Component routes into payload elements', async () => {
    (
      globalThis as typeof globalThis & {
        __webpack_require__?: { u: (chunkId: unknown) => string };
      }
    ).__webpack_require__ = {
      u: chunkId => String(chunkId),
    };

    const { createServerPayload } = await import(
      '../../src/router/runtime/rsc-router'
    );
    const route: RouteObject = {
      id: 'root',
      path: '/',
      Component: ComponentRoute,
      loader: () => 'from-loader',
    };
    const routerContext = {
      actionData: null,
      errors: null,
      loaderData: {
        root: 'from-loader',
      },
      location: {
        pathname: '/',
        search: '',
        hash: '',
        state: null,
        key: 'default',
      },
      matches: [
        {
          params: {},
          pathname: '/',
          pathnameBase: '/',
          route,
        },
      ],
    } as unknown as StaticHandlerContext;

    const payload = createServerPayload(routerContext, [route]);
    const element = payload.routes[0]?.element;

    expect(React.isValidElement(element)).toBe(true);
    expect(
      (element as React.ReactElement<{ loaderData?: string }>).props.loaderData,
    ).toBe('from-loader');
  });
});

const MatchProbe = () => {
  const dataRouter = React.useContext(UNSAFE_DataRouterContext);
  const matches = dataRouter?.router.match('/app/items/2') ?? [];
  return (
    <output>
      {matches
        .map(match => `${match.route.id}:${match.params.id ?? ''}`)
        .join('|')}
    </output>
  );
};

describe('RSCStaticRouter', () => {
  it('matches other locations against the payload routes and basename', async () => {
    const { RSCStaticRouter } = await import(
      '../../src/router/runtime/rsc-router'
    );
    const payload: ServerPayload = {
      type: 'render',
      actionData: null,
      errors: null,
      loaderData: {},
      location: {
        pathname: '/app/items/1',
        search: '',
        hash: '',
        state: null,
        key: 'default',
      },
      routes: [
        {
          id: 'layout',
          path: '/',
          element: <Outlet />,
          hasAction: false,
          hasErrorBoundary: false,
          hasLoader: false,
          params: { id: '1' },
          pathname: '/',
          pathnameBase: '/',
        },
        {
          id: 'item',
          path: 'items/:id',
          element: <MatchProbe />,
          hasAction: false,
          hasErrorBoundary: false,
          hasLoader: false,
          params: { id: '1' },
          pathname: '/items/1',
          pathnameBase: '/items/1',
        },
      ],
    };
    // Production feeds the Flight-decoded payload through ElementsContext,
    // whose upstream type only describes server elements.
    const elements = Promise.resolve(payload) as unknown as Promise<
      React.ReactNode[]
    >;

    const stream = await renderToReadableStream(
      <ElementsContext.Provider value={elements}>
        <RSCStaticRouter basename="/app" />
      </ElementsContext.Provider>,
    );
    await stream.allReady;
    const html = await new Response(stream).text();

    expect(html).toContain('<output>layout:2|item:2</output>');
  });
});
