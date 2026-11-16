import { createMemoryHistory } from '@tanstack/history';
import { expect, test, vi } from 'vitest';
import {
  BaseRootRoute,
  BaseRoute,
  createControlledPromise,
  redirect,
} from '../src';
import { attachRouterServerSsrUtils } from '../src/ssr/ssr-server';
import { createTestRouter } from './routerTestUtils';

// Core-level port of 9d36235ff3's Start regressions: the publisher callback is
// the SSR extension point used by early hints, without a Start/app shim.
test.each(
  (['sync', 'microtask', 'await'] as const).flatMap(start =>
    (['render', 'redirect', 'failure'] as const).map(outcome => ({
      start,
      outcome,
    })),
  ),
)(
  'drains $start hook loads with $outcome while the custom hook waits',
  async ({ start, outcome }) => {
    const entered = createControlledPromise<void>();
    const hookStart = createControlledPromise<void>();
    const loadStarted = createControlledPromise<void>();
    const loadGate = createControlledPromise<void>();
    const hookGate = createControlledPromise<{ custom: string }>();
    const reason = new Error('hook load lifecycle failure');
    let calls = 0;
    let nested: Promise<void> | undefined;
    const root = new BaseRootRoute({});
    const page = new BaseRoute({
      getParentRoute: () => root,
      path: '/',
      loader: async () => {
        if (++calls > 1) {
          loadStarted.resolve();
          await loadGate;
          if (outcome === 'redirect')
            throw redirect({ href: '/target', statusCode: 307 });
        }
        return calls === 1 ? 'initial' : 'final';
      },
      onStay: () => {
        if (outcome === 'failure') throw reason;
      },
    });
    const router = createTestRouter({
      routeTree: root.addChildren([page]),
      history: createMemoryHistory(),
      isServer: true,
    });
    attachRouterServerSsrUtils({ router, manifest: undefined });
    await router.load();
    const hook = vi.fn(() => {
      entered.resolve();
      const begin = () => {
        nested = router.load();
        void nested.catch(() => {});
        return hookGate;
      };
      return start === 'sync'
        ? begin()
        : (start === 'microtask' ? Promise.resolve() : hookStart).then(begin);
    });
    router.update({ dehydrate: hook });
    const published: unknown[] = [];
    const dehydration = router.serverSsr!.dehydrate({
      onBeforeDehydrate: () => {
        published.push(router.state.matches.at(-1)?.loaderData);
      },
    });
    const settled = vi.fn();
    void dehydration.then(
      () => settled('done'),
      error => settled(error),
    );
    try {
      await entered;
      hookStart.resolve();
      await loadStarted;
      expect(router.state).toMatchObject({
        status: 'pending',
        isLoading: true,
      });
      expect(settled).not.toHaveBeenCalled();
      loadGate.resolve();
      await Promise.allSettled([nested!]);
      if (outcome === 'render') {
        await vi.waitFor(() => expect(published).toEqual(['initial', 'final']));
        expect(settled).not.toHaveBeenCalled();
        hookGate.resolve({ custom: 'retained' });
        await dehydration;
      } else {
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
        if (outcome === 'failure')
          await expect(dehydration).rejects.toBe(reason);
        else {
          await dehydration;
          expect(router._serverResult).toMatchObject({
            type: 'redirect',
            redirect: { status: 307 },
          });
        }
        hookGate.reject(new Error('late hook rejection is observed'));
      }
      expect(hook).toHaveBeenCalledOnce();
    } finally {
      hookStart.resolve();
      loadGate.resolve();
      hookGate.resolve({ custom: 'cleanup' });
      await Promise.allSettled([dehydration, ...(nested ? [nested] : [])]);
      router.serverSsr?.cleanup();
      router.history.destroy();
    }
  },
);

test.each(['render', 'redirect', 'failure'] as const)(
  'drains an early-hints publisher load before invoking the custom hook: %s',
  async outcome => {
    const started = createControlledPromise<void>();
    const gate = createControlledPromise<void>();
    const reason = new Error('publisher load lifecycle failure');
    let calls = 0;
    let nested: Promise<void> | undefined;
    const root = new BaseRootRoute({});
    const page = new BaseRoute({
      getParentRoute: () => root,
      path: '/',
      loader: async () => {
        if (++calls > 1) {
          started.resolve();
          await gate;
          if (outcome === 'redirect') throw redirect({ href: '/target' });
        }
        return calls;
      },
      onStay: () => {
        if (outcome === 'failure') throw reason;
      },
    });
    const hook = vi.fn(() => ({ custom: 'ready' }));
    const router = createTestRouter({
      routeTree: root.addChildren([page]),
      history: createMemoryHistory(),
      isServer: true,
      dehydrate: hook,
    });
    attachRouterServerSsrUtils({ router, manifest: undefined });
    await router.load();
    const publications: number[] = [];
    const dehydration = router.serverSsr!.dehydrate({
      onBeforeDehydrate: () => {
        publications.push(calls);
        if (!nested) {
          nested = router.load();
          void nested.catch(() => {});
        }
      },
    });
    void dehydration.catch(() => {});
    try {
      await started;
      expect(hook).not.toHaveBeenCalled();
      gate.resolve();
      if (outcome === 'failure') await expect(dehydration).rejects.toBe(reason);
      else await dehydration;
      expect(hook).toHaveBeenCalledTimes(outcome === 'render' ? 1 : 0);
      expect(publications).toEqual(outcome === 'render' ? [1, 2] : [1]);
    } finally {
      gate.resolve();
      await Promise.allSettled([dehydration, ...(nested ? [nested] : [])]);
      router.serverSsr?.cleanup();
      router.history.destroy();
    }
  },
);
