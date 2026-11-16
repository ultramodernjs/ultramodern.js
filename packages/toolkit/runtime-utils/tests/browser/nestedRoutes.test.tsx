import { renderToString } from 'react-dom/server';
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
  useRouteError,
} from 'react-router';
import {
  renderNestedRoute,
  transformNestedRoutes,
} from '../../src/browser/nestedRoutes';

// A rejected promise whose rejection is only "handled" once something attaches
// a rejection handler to it; `.catch(fn)` goes through `.then(undefined, fn)`.
const createTrackedRejection = () => {
  const error = Object.assign(new Error('Loading chunk page failed.'), {
    name: 'ChunkLoadError',
  });
  const promise = Promise.reject(error);
  const state = { handled: false };
  const then = promise.then.bind(promise);
  // biome-ignore lint/suspicious/noThenProperty: Track rejection handlers on this real promise.
  promise.then = ((onFulfilled, onRejected) => {
    if (onRejected) {
      state.handled = true;
    }
    return then(onFulfilled, onRejected);
  }) as typeof promise.then;
  // Keep the test runner itself from reporting the rejection if the code under
  // test leaves it unhandled; the assertion below is what checks that.
  then(undefined, () => {});
  return { promise, state };
};

// Not `rs.fn`: mock functions attach their own handlers to returned promises
// to record settled results, which would mark the rejection as handled.
const createLazyImport = (promise: Promise<never>) => {
  const lazyImport = () => {
    lazyImport.calls += 1;
    return promise;
  };
  lazyImport.calls = 0;
  return lazyImport;
};

describe('renderNestedRoute loader preload', () => {
  it('handles a failed preload for a route without a loader', async () => {
    const { promise, state } = createTrackedRejection();
    const lazyImport = createLazyImport(promise);
    const element = renderNestedRoute({
      id: 'page',
      type: 'nested',
      lazyImport,
    });

    const result = await element.props.loader({});

    expect(lazyImport.calls).toBe(1);
    expect(result).toBeNull();
    expect(state.handled).toBe(true);
  });

  it('handles a failed preload for a route with a loader', async () => {
    const { promise, state } = createTrackedRejection();
    const lazyImport = createLazyImport(promise);
    const loader = rs.fn(async () => 'data');
    const element = renderNestedRoute({
      id: 'page',
      type: 'nested',
      lazyImport,
      loader,
    });

    const result = await element.props.loader({});

    expect(lazyImport.calls).toBe(1);
    expect(result).toBe('data');
    expect(state.handled).toBe(true);
  });
});

function ErrorBoundary() {
  const error = useRouteError();
  return <main>{error instanceof Error ? error.message : 'unexpected'}</main>;
}

test('native route errors use the declared error element without a private boundary flag', async () => {
  const routes = transformNestedRoutes([
    {
      id: 'page',
      type: 'nested',
      path: '/',
      hasErrorBoundary: false,
      error: ErrorBoundary,
      loader: () => {
        throw new Error('native route failure');
      },
    },
  ]);
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request('http://router.test/'));
  expect(context).not.toBeInstanceOf(Response);
  if (context instanceof Response) throw new Error('Unexpected redirect');
  const html = renderToString(
    <StaticRouterProvider
      router={createStaticRouter(handler.dataRoutes, context)}
      context={context}
    />,
  );
  expect(html).toContain('<main>native route failure</main>');
});
