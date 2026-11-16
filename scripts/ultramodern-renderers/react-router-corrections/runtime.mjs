import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const format = process.argv[2];
const corrected = process.argv[3] === 'corrected';
const reactRouter =
  format === 'cjs'
    ? require('@tanstack/react-router')
    : await import('@tanstack/react-router');
const core =
  format === 'cjs'
    ? require('@tanstack/router-core')
    : await import('@tanstack/router-core');
const React = require('react');
const { renderToString } = require('react-dom/server');
const {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
  Link,
} = reactRouter;

let release;
let entered;
const gate = new Promise(resolve => {
  release = resolve;
});
const started = new Promise(resolve => {
  entered = resolve;
});
const events = [];
const root = createRootRoute({ component: Outlet });
const page = createRoute({
  getParentRoute: () => root,
  path: '/items/$id',
  validateSearch: search => ({ q: String(search.q ?? 'resolved') }),
  loader: async ({ params }) => {
    entered();
    await gate;
    return { title: `Tractor ${params.id}` };
  },
  onEnter: match => {
    events.push(`enter:${match.loaderData.title}`);
  },
  component: () => {
    const data = page.useLoaderData();
    return React.createElement(
      'main',
      null,
      React.createElement('h1', null, data.title),
      React.createElement(
        Link,
        {
          to: '/items/$id',
          params: { id: '43' },
          search: { q: 'resolved' },
          mask: {
            to: '/en/items/$id',
            params: { id: '43' },
            inheritSearch: true,
          },
        },
        'Next tractor',
      ),
    );
  },
});
const visible = createRoute({
  getParentRoute: () => root,
  path: '/en/items/$id',
});
const history = createMemoryHistory({
  initialEntries: ['/items/42?q=resolved'],
});
const router = createRouter({
  routeTree: root.addChildren([page, visible]),
  history,
  isServer: true,
});
assert.equal(
  router instanceof core.RouterCore,
  corrected,
  'Actual React core authority',
);
const loading = router.load();
try {
  await started;
  assert.equal(router.state.status, corrected ? 'pending' : 'idle');
  assert.equal(router.state.isLoading, corrected);
  const built = router.buildLocation({
    to: '/items/$id',
    params: { id: '43' },
    search: { q: 'resolved' },
    mask: { to: '/en/items/$id', params: { id: '43' }, inheritSearch: true },
  });
  assert.equal(built.maskedLocation.searchStr, corrected ? '?q=resolved' : '');
  release();
  await loading;
  assert.equal(router.state.matches.at(-1).loaderData.title, 'Tractor 42');
  assert.deepEqual(events, ['enter:Tractor 42']);
  const html = renderToString(React.createElement(RouterProvider, { router }));
  assert.match(html, /<h1>Tractor 42<\/h1>/);
  assert.match(
    html,
    corrected ? /href="\/en\/items\/43\?q=resolved"/ : /href="\/en\/items\/43"/,
  );
  assert.match(html, /Next tractor<\/a>/);
  assert.equal(router.state.status, 'idle');
  assert.equal(router.state.isLoading, false);
} finally {
  release();
  await loading;
  history.destroy();
}
console.log(
  `PUBLIC_ROUTING_PASS ${format} ${corrected ? 'corrected' : 'registry-counterexample'}: real React router, gated load, lifecycle, mask, loader hook, SSR Link`,
);
