import {
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from '../../src/router';

const root = createRootRoute();
const item = createRoute({
  getParentRoute: () => root,
  path: '/items/$itemId',
});
const router = createRouter({ routeTree: root.addChildren([item]) });
type AppRouter = typeof router;

export async function navigateFromItem() {
  const navigate = useNavigate<AppRouter, '/items/$itemId'>({
    from: '/items/$itemId',
  });

  await navigate<AppRouter, '../..'>({ to: '../..' });
  await navigate<AppRouter, '/items/$itemId', '/'>({
    from: '/',
    to: '/items/$itemId',
    params: { itemId: '7' },
  });

  // @ts-expect-error Explicit origins retain required destination params.
  await navigate<AppRouter, '/items/$itemId', '/'>({
    from: '/',
    to: '/items/$itemId',
  });
}

// @ts-expect-error Default origins must belong to this router's route tree.
useNavigate<AppRouter, '/missing'>({ from: '/missing' });
