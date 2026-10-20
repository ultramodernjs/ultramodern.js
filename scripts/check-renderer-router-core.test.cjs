const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  assertRendererRouterCore,
} = require('./check-renderer-router-core.cjs');

const nativeCore =
  'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz';
const usage = (pathRelative, version) => ({
  versions: [{ version, packages: [{ pathRelative }] }],
});

test('keeps the accepted native Core separate from the registry bindings', () => {
  assert.doesNotThrow(() =>
    assertRendererRouterCore(
      usage('packages\\runtime\\renderer-octane', nativeCore),
    ),
  );
  for (const path of [
    'packages/runtime/renderer-octane',
    'packages/runtime/renderer-solid',
    'tests/integration/renderer-octane',
  ]) {
    assert.doesNotThrow(() =>
      assertRendererRouterCore(usage(path, nativeCore)),
    );
    assert.throws(() => assertRendererRouterCore(usage(path, '1.171.38')));
    assert.throws(() => assertRendererRouterCore(usage(path, '1.171.37')));
  }
  for (const path of [
    'packages/runtime/plugin-tanstack',
    'packages/new-consumer',
  ]) {
    assert.doesNotThrow(() =>
      assertRendererRouterCore(usage(path, '1.171.37')),
    );
    assert.throws(() => assertRendererRouterCore(usage(path, nativeCore)));
    assert.throws(() => assertRendererRouterCore(usage(path, '1.171.38')));
  }
});
