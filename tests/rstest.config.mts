import { defineConfig } from '@rstest/core';

const generatorFiles = {
  'generator-workspace':
    'integration/create-ultramodern-workspace/tests/*.test.ts',
  'generator-bff': 'integration/create-bff-runtime/tests/*.test.ts',
} as const;

function resolveFrameworkFiles() {
  const suite = process.env.MODERN_TEST_FRAMEWORK_SUITE ?? 'full';
  const include = ['integration/**/*.(spec|test).[jt]s?(x)'];
  // Linux owns fresh generated-workspace installs and app runtime semantics.
  // Windows retains packed-CLI generation, all core framework builds and
  // the real bff-effect runtime fixture.
  const exclude = [
    'integration/rstest/**',
    ...(process.platform === 'win32'
      ? [
          'integration/create-bff-runtime/tests/runtime.test.ts',
          'integration/create-ultramodern-workspace/tests/runtime.test.ts',
        ]
      : []),
  ];

  if (suite === 'full') return { include, exclude };
  if (suite === 'core') {
    return { include, exclude: [...exclude, ...Object.values(generatorFiles)] };
  }
  if (suite === 'generator-workspace' || suite === 'generator-bff') {
    return { include: [generatorFiles[suite]], exclude };
  }
  throw new Error(`Unknown MODERN_TEST_FRAMEWORK_SUITE: ${suite}`);
}

/**
 * Integration worker count.
 *
 * `INTEGRATION_MAX_WORKERS` lets a runner profile change be tried without a code
 * change; otherwise CI gets a fixed 2 and local runs keep full parallelism.
 */
function resolveMaxWorkers(): number | string {
  const override = process.env.INTEGRATION_MAX_WORKERS;
  if (override) {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
    return override;
  }

  return process.env.CI === 'true' ? 2 : '100%';
}

export default defineConfig({
  root: __dirname,
  ...resolveFrameworkFiles(),
  globals: true,
  env: { MODERN_SERVER_LOG_LEVEL: 'info' },
  // Heavy fixtures keep up to three dev servers and a browser alive (4-5 GB).
  // Two test-file workers fit within the CI runner's 16 GB memory budget.
  pool: {
    maxWorkers: resolveMaxWorkers(),
  },
  testTimeout: 60_000,
  hookTimeout: 60_000,
  // Peak heap per test file, so a future OOM is diagnosable from the log rather
  // than only visible as an abrupt termination.
  logHeapUsage: process.env.CI === 'true',
});
