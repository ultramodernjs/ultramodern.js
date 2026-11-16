import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMemoryHistory } = require('@tanstack/history');
const format = process.argv[2];
for (const [identity, corrected] of [
  ['vanilla-router-core', false],
  ['@tanstack/router-core', true],
]) {
  const core = format === 'cjs' ? require(identity) : await import(identity);
  const started = core.createControlledPromise();
  const gate = core.createControlledPromise();
  const root = new core.BaseRootRoute({});
  const page = new core.BaseRoute({
    getParentRoute: () => root,
    path: '/',
    loader: () => {
      started.resolve();
      return gate;
    },
  });
  const item = new core.BaseRoute({
    getParentRoute: () => root,
    path: '/items',
  });
  const router = new core.RouterCore(
    {
      routeTree: root.addChildren([page, item]),
      history: createMemoryHistory(),
      isServer: true,
    },
    () => ({
      createMutableStore: core.createNonReactiveMutableStore,
      createReadonlyStore: core.createNonReactiveReadonlyStore,
      batch: fn => fn(),
    }),
  );
  const loading = router.load();
  try {
    await started;
    assert.equal(router.state.status, corrected ? 'pending' : 'idle');
    assert.equal(router.state.isLoading, corrected);
    const location = router.buildLocation({
      to: '/items',
      search: { q: 'localized' },
      mask: { to: '/en/items', inheritSearch: true },
    });
    assert.equal(
      location.maskedLocation.searchStr,
      corrected ? '?q=localized' : '',
    );
  } finally {
    gate.resolve('done');
    await loading;
    router.history.destroy();
  }
}
console.log(
  `COUNTEREXAMPLES_PASS ${format}: pristine npm reproduces both defects; corrected npm fixes both`,
);
