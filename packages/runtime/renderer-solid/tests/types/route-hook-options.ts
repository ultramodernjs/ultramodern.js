import {
  createRootRoute,
  createRoute,
  createRouter,
  useLoaderData,
  useParams,
  useSearch,
} from '../../src/router';

const root = createRootRoute();
const item = createRoute({
  getParentRoute: () => root,
  path: '/items/$itemId',
  loader: () => ({ title: 'Item' }),
  head: () => ({
    styles: [{ children: 42 }, { children: ['a', 'b'] }],
    scripts: [{ children: 42 }, { children: ['a', 'b'] }],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    page: typeof search.page === 'number' ? search.page : 1,
  }),
});
const router = createRouter({ routeTree: root.addChildren([item]) });
type AppRouter = typeof router;

// Omitted optional selectors and flags retain the route's inferred data.
export function readItem() {
  const params = useParams<AppRouter, '/items/$itemId'>({
    from: '/items/$itemId',
  });
  const data = useLoaderData<AppRouter, '/items/$itemId'>({
    from: '/items/$itemId',
  });
  const search = useSearch<AppRouter, '/items/$itemId'>({
    from: '/items/$itemId',
  });
  const id: string = params().itemId;
  const title: string = data().title;
  const page: number = search().page;
  return { id, title, page };
}

// Non-throwing nearest-match hooks preserve the possibly absent result.
export function readOptionalMatch() {
  const params = useParams<AppRouter, undefined, false, false>({
    strict: false,
    shouldThrow: false,
  });
  const search = useSearch<AppRouter, undefined, false, false>({
    strict: false,
    shouldThrow: false,
  });
  const id: string | undefined = params()?.itemId;
  const page: number | undefined = search()?.page;
  return { id, page };
}

export function readSelectedLoaderData() {
  const length = item.useLoaderData({
    select: data => data.title.length,
  });
  const selected: number = length();
  return selected;
}
