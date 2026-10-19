const nativeCore =
  'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz';
const nativeConsumers = new Set([
  'packages/runtime/renderer-octane',
  'tests/integration/renderer-octane',
]);

function assertRendererRouterCore(dependency) {
  for (const { version, packages } of dependency.versions) {
    for (const { pathRelative } of packages) {
      const expected = nativeConsumers.has(pathRelative)
        ? nativeCore
        : '1.171.37';
      if (version !== expected) {
        throw new Error(
          `${pathRelative}: @tanstack/router-core must resolve ${expected}, received ${version}`,
        );
      }
    }
  }
}

module.exports = { assertRendererRouterCore };
