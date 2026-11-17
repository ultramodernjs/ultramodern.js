import { describe, expectTypeOf, test } from 'vitest';
import type {
  AnyRouter,
  RouteById,
  RouteIds,
  RoutePaths,
  RouteToPath,
  ToPathOption,
  TrailingSlashOption,
} from '../src';
import {
  type alwaysTargets,
  createGeneratedRouteTree,
  createSlashEdgeRouteTree,
  type generatedFullPaths,
  type generatedRouteIds,
  type neverTargets,
  type slashEdgeFullPaths,
  type slashEdgeRouteIds,
} from './routePathFixtures';
import { createTestRouter } from './routerTestUtils';

const generated = createGeneratedRouteTree();
const edge = createSlashEdgeRouteTree();
type Tree = typeof generated.routeTree;
const routerFor = <TTrailingSlash extends TrailingSlashOption>(
  trailingSlash: TTrailingSlash,
) => createTestRouter({ routeTree: generated.routeTree, trailingSlash });
const never = routerFor('never');
const always = routerFor('always');
const preserve = routerFor('preserve');
// A Link/navigate `to` without `from`, as written in application code.
type LinkTo<TRouter extends AnyRouter, TTo extends string> = ToPathOption<
  TRouter,
  string,
  TTo
>;
type NeverTo = keyof typeof neverTargets;
type AlwaysTo = keyof typeof alwaysTargets;

describe('route ids and full paths follow BaseRoute.init', () => {
  test('a flat prefix index keeps its trailing slash', () => {
    expectTypeOf(generated.lang.id).toEqualTypeOf<'/$lang/'>();
    expectTypeOf(generated.lang.fullPath).toEqualTypeOf<'/$lang/'>();
    expectTypeOf(generated.lang.to).toEqualTypeOf<'/$lang'>();
    expectTypeOf(generated.products.id).toEqualTypeOf<'/shop/products/'>();
    expectTypeOf(generated.docsIndex.id).toEqualTypeOf<'/docs/'>();
    expectTypeOf(generated.account.id).toEqualTypeOf<'/_auth/account'>();
    expectTypeOf(generated.account.fullPath).toEqualTypeOf<'/account'>();
  });

  test('generated layout, dynamic, splat, nested and pathless routes', () => {
    expectTypeOf<RouteIds<Tree>>().toEqualTypeOf<
      (typeof generatedRouteIds)[number]
    >();
    expectTypeOf<RoutePaths<Tree>>().toEqualTypeOf<
      (typeof generatedFullPaths)[number]
    >();
    expectTypeOf<'/$lang'>().not.toExtend<RouteIds<Tree>>();
    expectTypeOf<
      RouteById<Tree, '/$lang/'>['types']['loaderData']
    >().toEqualTypeOf<{ home: true }>();
  });

  test('leading, repeated and trailing slashes and a literal __root__', () => {
    type EdgeTree = typeof edge.routeTree;
    expectTypeOf<RouteIds<EdgeTree>>().toEqualTypeOf<
      (typeof slashEdgeRouteIds)[number]
    >();
    expectTypeOf<RoutePaths<EdgeTree>>().toEqualTypeOf<
      (typeof slashEdgeFullPaths)[number]
    >();
    expectTypeOf(edge.literalRoot.to).toEqualTypeOf<'/edge/__root__/x'>();
    expectTypeOf(edge.leading.to).toEqualTypeOf<'/lead'>();
  });
});

describe('navigation targets follow the runtime route.to', () => {
  test('never accepts only the trimmed target', () => {
    expectTypeOf<RouteToPath<typeof never>>().toEqualTypeOf<NeverTo>();
    expectTypeOf<'/$lang'>().toExtend<LinkTo<typeof never, '/$lang'>>();
    expectTypeOf<'/$lang/'>().not.toExtend<LinkTo<typeof never, '/$lang/'>>();
  });

  test('always appends exactly one slash', () => {
    expectTypeOf<RouteToPath<typeof always>>().toEqualTypeOf<AlwaysTo>();
    expectTypeOf<'/$lang/'>().toExtend<LinkTo<typeof always, '/$lang/'>>();
    expectTypeOf<'/$lang'>().not.toExtend<LinkTo<typeof always, '/$lang'>>();
    expectTypeOf<'/$lang//'>().not.toExtend<
      LinkTo<typeof always, '/$lang//'>
    >();
  });

  test('preserve accepts both forms', () => {
    expectTypeOf<RouteToPath<typeof preserve>>().toEqualTypeOf<
      NeverTo | AlwaysTo
    >();
    expectTypeOf<'/$lang'>().toExtend<LinkTo<typeof preserve, '/$lang'>>();
    expectTypeOf<'/$lang/'>().toExtend<LinkTo<typeof preserve, '/$lang/'>>();
  });
});
