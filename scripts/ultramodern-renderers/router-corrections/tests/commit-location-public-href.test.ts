import { createMemoryHistory } from '@tanstack/history';
import { describe, expect, test, vi } from 'vitest';
import type { LocationRewrite, TrailingSlashOption } from '../src';
import { BaseRootRoute, BaseRoute } from '../src';
import { createTestRouter } from './routerTestUtils';

function setup(
  initial: string,
  options: {
    rewrite?: LocationRewrite;
    trailingSlash?: TrailingSlashOption;
  } = {},
) {
  const root = new BaseRootRoute({});
  const routeTree = root.addChildren(
    ['/', '/page', '/real', '/pretty'].map(
      path => new BaseRoute({ getParentRoute: () => root, path }),
    ),
  );
  const history = createMemoryHistory({ initialEntries: [initial] });
  history.replace(initial, { draft: 'keep' });
  const router = createTestRouter({
    routeTree,
    history,
    isServer: false,
    scrollRestoration: false,
    ...options,
  });
  return { router, history };
}

describe('committing the displayed URL', () => {
  test.each(['', '?view=full#top'])(
    'replaces a rewritten root while retaining search, hash and application state (%s)',
    async suffix => {
      const { router, history } = setup('/en/' + suffix, {
        rewrite: {
          input: ({ url }) => {
            const next = new URL(url);
            next.pathname = next.pathname.replace(/^\/en(?=\/|$)/, '') || '/';
            return next;
          },
          output: ({ url }) => {
            const next = new URL(url);
            next.pathname =
              '/en' + (next.pathname === '/' ? '' : next.pathname);
            return next;
          },
        },
      });
      const replace = vi.spyOn(history, 'replace');
      try {
        await router.load();
        const canonical = router.buildLocation({
          to: router.latestLocation.pathname,
          search: true,
          params: true,
          hash: true,
          state: true,
        });
        await router.commitLocation({ ...canonical, replace: true });
        expect(history.location.href).toBe('/en' + suffix);
        expect(router.state.location.publicHref).toBe('/en' + suffix);
        expect(router.state.location.state).toMatchObject({ draft: 'keep' });
        expect(router.state.status).toBe('idle');
        expect(replace).toHaveBeenCalledOnce();

        await router.commitLocation({ ...canonical, replace: true });
        expect(replace).toHaveBeenCalledOnce();
      } finally {
        replace.mockRestore();
        history.destroy();
      }
    },
  );

  test.each([
    {
      trailingSlash: 'preserve',
      initial: '/page/',
      expected: '/page/',
      replaces: 0,
    },
    {
      trailingSlash: 'preserve',
      initial: '/page',
      expected: '/page',
      replaces: 0,
    },
    {
      trailingSlash: 'always',
      initial: '/page',
      expected: '/page/',
      replaces: 1,
    },
    {
      trailingSlash: 'never',
      initial: '/page/',
      expected: '/page',
      replaces: 1,
    },
  ] as const)(
    'commits the $trailingSlash slash policy for $initial',
    async ({ trailingSlash, initial, expected, replaces }) => {
      const { router, history } = setup(initial, { trailingSlash });
      const replace = vi.spyOn(history, 'replace');
      try {
        await router.load();
        const canonical = router.buildLocation({
          to: router.latestLocation.pathname,
          state: true,
        });
        await router.commitLocation({ ...canonical, replace: true });
        expect(history.location.href).toBe(expected);
        expect(router.state.location.publicHref).toBe(expected);
        expect(router.state.location.state).toMatchObject({ draft: 'keep' });
        expect(replace).toHaveBeenCalledTimes(replaces);
      } finally {
        replace.mockRestore();
        history.destroy();
      }
    },
  );

  test.each([
    { nextMask: '/pretty', expected: '/pretty', replaces: 1 },
    { nextMask: '/pretty/', expected: '/pretty/', replaces: 0 },
  ])(
    'compares the displayed mask when replacing it with $nextMask',
    async ({ nextMask, expected, replaces }) => {
      const { router, history } = setup('/', { trailingSlash: 'preserve' });
      try {
        await router.load();
        await router.navigate({
          to: '/real',
          state: true,
          mask: { to: '/pretty/' },
        });
        expect(history.location.href).toBe('/pretty/');
        const replace = vi.spyOn(history, 'replace');
        try {
          await router.navigate({
            to: '/real',
            state: true,
            mask: { to: nextMask },
            replace: true,
          });
          expect(history.location.href).toBe(expected);
          expect(router.state.location.pathname).toBe('/real');
          expect(router.state.location.maskedLocation?.publicHref).toBe(
            expected,
          );
          expect(router.state.location.state).toMatchObject({ draft: 'keep' });
          expect(replace).toHaveBeenCalledTimes(replaces);
        } finally {
          replace.mockRestore();
        }
      } finally {
        history.destroy();
      }
    },
  );
});
