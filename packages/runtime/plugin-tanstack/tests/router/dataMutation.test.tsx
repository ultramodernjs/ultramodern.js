import { redirect } from '@tanstack/router-core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { act } from 'react';
import type { Fetcher } from '../../src/runtime/dataMutation';
import { Form, useFetcher } from '../../src/runtime/dataMutation';
import { createFormDataFromSubmit } from '../../src/runtime/formData';

type RouteHandler = (args: {
  request: Request;
  params: Record<string, string>;
  context?: unknown;
}) => Promise<unknown> | unknown;

let currentRouter: any;

rstest.mock('@tanstack/react-router', () => ({
  useRouter: () => currentRouter,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

function createRouter(handler: {
  action?: RouteHandler;
  loader?: RouteHandler;
  invalidate?: () => Promise<void>;
  params?: Record<string, string>;
}) {
  return {
    buildLocation: ({ to }: { to?: string }) => {
      const href = typeof to === 'string' ? to : '/';
      const url = new URL(href, 'http://localhost');
      return {
        href: `${url.pathname}${url.search}${url.hash}`,
        pathname: url.pathname,
      };
    },
    getMatchedRoutes: () => [
      [],
      handler.params || {},
      {
        options: {
          staticData: {
            modernRouteAction: handler.action,
            modernRouteLoader: handler.loader,
          },
        },
      },
    ],
    navigate: rstest.fn(async () => undefined),
    invalidate: rstest.fn(handler.invalidate || (async () => undefined)),
  };
}

function formatFetcherError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error == null) {
    return '';
  }
  return JSON.stringify(error);
}

describe('tanstack data mutation fetcher', () => {
  let latestFetcher: Fetcher | undefined;
  const states: string[] = [];

  function FetcherHarness() {
    const fetcher = useFetcher();
    latestFetcher = fetcher;

    React.useEffect(() => {
      states.push(fetcher.state);
    }, [fetcher.state]);

    return (
      <div>
        <div data-testid="state">{fetcher.state}</div>
        <div data-testid="data">
          {fetcher.data === undefined
            ? 'undefined'
            : JSON.stringify(fetcher.data)}
        </div>
        <div data-testid="error">{formatFetcherError(fetcher.error)}</div>
      </div>
    );
  }

  beforeEach(() => {
    latestFetcher = undefined;
    states.length = 0;
  });

  test.each([
    { amount: 2, count: 2, method: 'post' as const, name: 'explicit method' },
    { amount: 1, count: 1, method: undefined, name: 'default method' },
  ])(
    'tracks submitting/loading phases with the $name',
    async ({ amount, count, method }) => {
      const actionResult = createDeferred<Response>();
      const invalidateResult = createDeferred<void>();
      const action = rstest.fn(async () => actionResult.promise);
      const loader = rstest.fn(async () => ({ count: 0 }));

      currentRouter = createRouter({
        action,
        loader,
        invalidate: async () => invalidateResult.promise,
      });

      render(<FetcherHarness />);
      expect(screen.getByTestId('state').textContent).toBe('idle');

      let submitPromise: Promise<void> | undefined;
      act(() => {
        submitPromise = latestFetcher!.submit(
          { amount },
          {
            ...(method === undefined ? {} : { method }),
            action: '/mutation',
          },
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('state').textContent).toBe('submitting');
      });
      expect(action).toHaveBeenCalledTimes(1);
      expect(loader).not.toHaveBeenCalled();

      actionResult.resolve(
        new Response(JSON.stringify({ count }), {
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );

      await waitFor(() => {
        expect(screen.getByTestId('state').textContent).toBe('loading');
      });

      invalidateResult.resolve();

      await act(async () => {
        await submitPromise;
      });

      expect(screen.getByTestId('state').textContent).toBe('idle');
      expect(screen.getByTestId('data').textContent).toBe(
        JSON.stringify({ count }),
      );
      expect(states).toEqual(['idle', 'submitting', 'loading', 'idle']);
    },
  );

  test('passes built href and matched route params to mutation actions', async () => {
    const action = rstest.fn(
      async ({ request, params }: Parameters<RouteHandler>[0]) => ({
        params,
        requestUrl: request.url,
      }),
    );
    currentRouter = createRouter({
      action,
      params: { userId: '42' },
    });

    render(<FetcherHarness />);

    await act(async () => {
      await latestFetcher!.submit(
        { amount: 2 },
        {
          method: 'post',
          action: '/users/42?tab=edit#details',
        },
      );
    });

    expect(action).toHaveBeenCalledTimes(1);
    const actionArgs = action.mock.calls[0][0];
    const expectedRequestUrl = `${window.location.origin}/users/42?tab=edit#details`;
    expect(actionArgs.params).toEqual({ userId: '42' });
    expect(actionArgs.request.url).toBe(expectedRequestUrl);
    expect(latestFetcher?.data).toEqual({
      params: { userId: '42' },
      requestUrl: expectedRequestUrl,
    });
    expect(currentRouter.invalidate).toHaveBeenCalledTimes(1);
  });

  describe.each([
    { outcome: 'returned', thrown: false },
    { outcome: 'thrown', thrown: true },
  ])('$outcome action redirects', ({ thrown }) => {
    test.each([301, 302, 303, 307, 308])(
      'navigates for HTTP %s without invalidating the previous route',
      async status => {
        const response = new Response(null, {
          status,
          headers: {
            Location: '/about',
            'X-Action': 'saved',
          },
        });
        currentRouter = createRouter({
          action: () => {
            if (thrown) throw response;
            return response;
          },
        });
        render(<FetcherHarness />);

        let submissionError: unknown;
        await act(async () => {
          try {
            await latestFetcher!.submit(
              { name: 'Grace', intent: 'redirect' },
              { method: 'post', action: '/' },
            );
          } catch (error) {
            submissionError = error;
          }
        });

        expect(currentRouter.navigate).toHaveBeenCalledExactlyOnceWith({
          to: '/about',
        });
        expect(submissionError).toBeUndefined();
        expect(currentRouter.invalidate).not.toHaveBeenCalled();
        expect(latestFetcher?.state).toBe('idle');
        expect(latestFetcher?.error).toBeUndefined();
        expect(latestFetcher?.data).toBe('');
        expect(response.headers.get('Location')).toBe('/about');
        expect(response.headers.get('X-Action')).toBe('saved');
      },
    );
  });

  test('prefers the Modern redirect header on a returned transport response', async () => {
    currentRouter = createRouter({
      action: () =>
        new Response(null, {
          status: 204,
          headers: {
            'X-Modernjs-Redirect': '/about',
            Location: '/other',
          },
        }),
    });
    render(<FetcherHarness />);

    await act(async () => {
      await latestFetcher!.submit(
        { name: 'Grace' },
        { method: 'post', action: '/' },
      );
    });

    expect(currentRouter.navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/about',
    });
    expect(currentRouter.invalidate).not.toHaveBeenCalled();
    expect(latestFetcher?.data).toBeNull();
  });

  test.each([
    {
      name: 'native TanStack redirect',
      error: () => redirect({ to: '/about', replace: true }),
    },
    {
      name: 'validation Response',
      error: () =>
        Response.json({ fieldErrors: { name: 'Required' } }, { status: 422 }),
    },
    {
      name: 'nonredirect Response with a Location header',
      error: () =>
        new Response(null, { status: 200, headers: { Location: '/about' } }),
    },
    { name: 'ordinary error', error: () => new Error('Native action failure') },
  ])('preserves a thrown $name without navigating', async ({ error }) => {
    const failure = error();
    currentRouter = createRouter({
      action: async () => {
        throw failure;
      },
    });
    render(<FetcherHarness />);

    await act(async () => {
      await expect(
        latestFetcher!.submit({ name: '' }, { method: 'post', action: '/' }),
      ).rejects.toBe(failure);
    });

    expect(currentRouter.navigate).not.toHaveBeenCalled();
    expect(currentRouter.invalidate).not.toHaveBeenCalled();
    expect(latestFetcher?.error).toBe(failure);
    expect(latestFetcher?.state).toBe('idle');
    if (failure instanceof Response) expect(failure.bodyUsed).toBe(false);
  });

  test('surfaces non-2xx action responses as fetcher errors', async () => {
    const actionResult = createDeferred<Response>();
    currentRouter = createRouter({
      action: async () => actionResult.promise,
    });

    render(<FetcherHarness />);

    let thrownError: unknown;
    let submitPromise: Promise<void> | undefined;
    act(() => {
      submitPromise = latestFetcher!.submit(
        { amount: 'not-a-number' },
        { method: 'post', action: '/mutation' },
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('submitting');
    });

    actionResult.resolve(
      new Response(JSON.stringify({ message: 'invalid amount' }), {
        status: 422,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    await act(async () => {
      try {
        await submitPromise;
      } catch (error) {
        thrownError = error;
      }
    });

    expect(thrownError).toBeInstanceOf(Error);
    expect(screen.getByTestId('state').textContent).toBe('idle');
    expect(screen.getByTestId('error').textContent).toContain('422');
    expect(currentRouter.invalidate).not.toHaveBeenCalled();
    expect(states).toEqual(['idle', 'submitting', 'idle']);
  });

  test('uses loading state for loader fetches', async () => {
    const loaderResult = createDeferred<{ count: number }>();

    currentRouter = createRouter({
      loader: async () => loaderResult.promise,
    });

    render(<FetcherHarness />);

    let submitPromise: Promise<void> | undefined;
    act(() => {
      submitPromise = latestFetcher!.submit(
        {},
        { method: 'get', action: '/mutation' },
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('loading');
    });

    loaderResult.resolve({ count: 7 });

    await act(async () => {
      await submitPromise;
    });

    expect(screen.getByTestId('state').textContent).toBe('idle');
    expect(screen.getByTestId('data').textContent).toBe('{"count":7}');
    expect(currentRouter.invalidate).not.toHaveBeenCalled();
    expect(states).toEqual(['idle', 'loading', 'idle']);
  });

  test('GET Form navigation replaces action query before hash', async () => {
    currentRouter = createRouter({});

    render(
      <Form method="get" action="/products?sort=old#results">
        <input name="q" defaultValue="boots" />
        <button type="submit">Search</button>
      </Form>,
    );

    const form = document.querySelector('form');
    expect(form).toBeTruthy();

    await act(async () => {
      fireEvent.submit(form!);
    });

    expect(currentRouter.navigate).toHaveBeenCalledWith({
      href: '/products?q=boots#results',
    });
  });

  test('keeps non-idle state while overlapping mutation submits are still active', async () => {
    const actionResults = [
      createDeferred<Response>(),
      createDeferred<Response>(),
    ];
    const invalidateResults = [createDeferred<void>(), createDeferred<void>()];
    let actionCallIndex = 0;
    let invalidateCallIndex = 0;

    currentRouter = createRouter({
      action: async () => {
        const current = actionResults[actionCallIndex];
        actionCallIndex += 1;
        return current.promise;
      },
      invalidate: async () => {
        const current = invalidateResults[invalidateCallIndex];
        invalidateCallIndex += 1;
        return current.promise;
      },
    });

    render(<FetcherHarness />);

    let firstSubmit: Promise<void> | undefined;
    let secondSubmit: Promise<void> | undefined;

    act(() => {
      firstSubmit = latestFetcher!.submit(
        { amount: 1 },
        { method: 'post', action: '/mutation' },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('submitting');
    });

    act(() => {
      secondSubmit = latestFetcher!.submit(
        { amount: 2 },
        { method: 'post', action: '/mutation' },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('submitting');
    });

    actionResults[0].resolve(
      new Response(JSON.stringify({ count: 1 }), {
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    await waitFor(() => {
      expect(currentRouter.invalidate).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('state').textContent).toBe('submitting');
    });

    invalidateResults[0].resolve();
    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('submitting');
    });

    actionResults[1].resolve(
      new Response(JSON.stringify({ count: 3 }), {
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    await waitFor(() => {
      expect(currentRouter.invalidate).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('state').textContent).toBe('loading');
    });

    invalidateResults[1].resolve();
    await act(async () => {
      await Promise.all([firstSubmit, secondSubmit]);
    });

    expect(screen.getByTestId('state').textContent).toBe('idle');
    expect(screen.getByTestId('data').textContent).toBe('{"count":3}');
  });

  test('preserves submitter name value when FormData submitter overload is unavailable', () => {
    const NativeFormData = globalThis.FormData;

    class SingleArgumentFormData extends NativeFormData {
      constructor(form?: HTMLFormElement, submitter?: HTMLElement) {
        if (submitter) {
          throw new TypeError('FormData submitter overload unavailable');
        }
        super(form);
      }
    }

    globalThis.FormData = SingleArgumentFormData as typeof FormData;

    try {
      const form = document.createElement('form');
      form.innerHTML = `
        <input name="amount" value="2" />
        <button type="submit" name="intent" value="save">Save</button>
      `;

      const submitter = form.querySelector('button');
      expect(submitter).toBeInstanceOf(HTMLButtonElement);

      const formData = createFormDataFromSubmit({
        form,
        submitter,
      });

      expect(formData.get('amount')).toBe('2');
      expect(formData.get('intent')).toBe('save');
    } finally {
      globalThis.FormData = NativeFormData;
    }
  });
});
