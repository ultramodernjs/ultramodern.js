import type {
  NavigateOptions,
  RouterProps,
  ToMaskOptions,
} from '@tanstack/react-router';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from '@tanstack/react-router';
import type { FromPathOption } from '@tanstack/router-core';

const root = createRootRoute();
const item = createRoute({
  getParentRoute: () => root,
  path: '/items/$id',
  validateSearch: (input: Record<string, unknown>) => ({
    q: String(input.q ?? 'resolved'),
  }),
  loader: ({ params }) => ({ title: `Tractor ${params.id}` }),
});
const visible = createRoute({
  getParentRoute: () => root,
  path: '/en/items/$id',
  validateSearch: (input: { required: string }) => input,
});
const router = createRouter({
  routeTree: root.addChildren([item, visible]),
  history: createMemoryHistory(),
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const provider: RouterProps<typeof router> = { router };
const title: string = item.useLoaderData().title;
const validPath: FromPathOption<typeof router, string> = '/items/$id';
// @ts-expect-error Concrete route paths remain constrained.
const invalidPath: FromPathOption<typeof router, string> = '/not-a-route';
const mask: ToMaskOptions<typeof router, '/items/$id', '/en/items/$id'> = {
  to: '/en/items/$id',
  params: { id: '42' },
  inheritSearch: true,
};
// @ts-expect-error Inherited mask still requires path parameters.
const missingParams: ToMaskOptions<typeof router, '/', '/en/items/$id'> = {
  to: '/en/items/$id',
  inheritSearch: true,
};
// @ts-expect-error A mask cannot inherit and override search simultaneously.
const invalidMask: ToMaskOptions<typeof router, '/items/$id', '/en/items/$id'> =
  {
    to: '/en/items/$id',
    params: { id: '42' },
    inheritSearch: true,
    search: { required: 'conflict' },
  };
const options: NavigateOptions = {
  to: '/items/$id',
  params: { id: '42' },
  search: { q: 'typed' },
  mask: { to: '/en/items/$id', params: { id: '42' }, inheritSearch: true },
};
const promise: Promise<void> = router.navigate(options);
function navigationHook() {
  const navigate = useNavigate({ from: '/items/$id' });
  navigate({
    to: '/items/$id',
    params: { id: '43' },
    search: { q: 'hook' },
    mask,
  });
  // @ts-expect-error Route parameters cannot be numbers.
  navigate({ to: '/items/$id', params: { id: 43 }, search: { q: 'hook' } });
}
void provider;
void title;
void validPath;
void invalidPath;
void missingParams;
void invalidMask;
void promise;
void navigationHook;
