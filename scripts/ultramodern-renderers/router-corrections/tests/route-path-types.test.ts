import { createMemoryHistory } from '@tanstack/history';
import { describe, expect, test } from 'vitest';
import type { TrailingSlashOption } from '../src';
import {
  alwaysTargets,
  createGeneratedRouteTree,
  createSlashEdgeRouteTree,
  generatedFullPaths,
  generatedRouteIds,
  neverTargets,
  slashEdgeFullPaths,
  slashEdgeRouteIds,
  targetParams,
} from './routePathFixtures';
import { createTestRouter } from './routerTestUtils';

function setup(trailingSlash: TrailingSlashOption, initial = '/') {
  return createTestRouter({
    routeTree: createGeneratedRouteTree().routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
    trailingSlash,
    isServer: true,
  });
}

const unique = (values: Array<string>) => [...new Set(values)].sort();

describe('route ids and full paths the types advertise', () => {
  test('generated route tree', async () => {
    const router = setup('never', '/en');
    const routes = Object.values(router.routesById);
    expect(unique(Object.keys(router.routesById))).toEqual(
      unique([...generatedRouteIds]),
    );
    expect(unique(routes.map(route => route.fullPath))).toEqual(
      unique([...generatedFullPaths]),
    );
    expect(unique(routes.map(route => route.to))).toEqual(
      unique(Object.keys(neverTargets)),
    );
    expect(router.routesById).not.toHaveProperty(['/$lang']);
    await router.load();
    const home = router.state.matches.at(-1);
    expect(home?.routeId).toBe('/$lang/');
    expect(home?.loaderData).toEqual({ home: true });
  });

  test('leading, repeated and trailing slashes and a literal __root__', () => {
    const router = createTestRouter({
      routeTree: createSlashEdgeRouteTree().routeTree,
      history: createMemoryHistory(),
      isServer: true,
    });
    const routes = Object.values(router.routesById);
    expect(routes.map(route => route.id)).toEqual([...slashEdgeRouteIds]);
    expect(unique(routes.map(route => route.fullPath))).toEqual(
      unique([...slashEdgeFullPaths]),
    );
  });
});

describe.each([
  ['never', neverTargets, false],
  ['always', alwaysTargets, true],
  ['preserve', { ...neverTargets, ...alwaysTargets }, undefined],
] as const)('%s navigation targets', (trailingSlash, targets, slash) => {
  test.each(Object.entries(targets))('%s matches %s', (to, routeId) => {
    const router = setup(trailingSlash);
    const { pathname } = router.buildLocation({ to, params: targetParams });
    if (pathname !== '/')
      expect(pathname.endsWith('/')).toBe(slash ?? to.endsWith('/'));
    expect(router.matchRoutes(pathname).at(-1)?.routeId).toBe(routeId);
  });
});
