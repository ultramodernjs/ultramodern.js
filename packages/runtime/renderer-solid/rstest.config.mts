import { fileURLToPath } from 'node:url';
import { defineConfig } from '@scripts/rstest-config';

function nativeCompiler(server: boolean) {
  return {
    rspack: {
      module: {
        rules: [
          {
            enforce: 'pre' as const,
            test: /\.[cm]?[jt]sx?$/,
            include: [
              fileURLToPath(new URL('./src', import.meta.url)),
              fileURLToPath(new URL('./tests', import.meta.url)),
            ],
            use: [
              {
                loader: fileURLToPath(
                  new URL('./native-loader.cjs', import.meta.url),
                ),
                options: { server },
              },
            ],
          },
        ],
      },
    },
  };
}

// The shared preset adds Node resolution conditions when arrays are merged.
// Native browser primitives must resolve without the Node condition.
export default defineConfig({
  testTimeout: 30_000,
  projects: [
    {
      name: 'client',
      root: __dirname,
      // Nested projects do not inherit the package-level timeout.
      testTimeout: 30_000,
      include: ['tests/client/**/*.test.{ts,tsx}'],
      exclude: ['tests/client/router-lifecycle.test.tsx'],
      testEnvironment: 'happy-dom',
      setupFiles: ['./tests/client/fetch-platform.ts'],
      globals: true,
      output: { bundleDependencies: true },
      tools: nativeCompiler(false),
      resolve: {
        conditionNames: ['modern:source', 'browser', 'import', 'default'],
      },
    },
    {
      name: 'router-lifecycle',
      root: __dirname,
      include: ['tests/client/router-lifecycle.test.tsx'],
      testEnvironment: 'happy-dom',
      setupFiles: ['./tests/client/fetch-platform.ts'],
      globals: true,
      output: { bundleDependencies: true },
      tools: nativeCompiler(false),
      resolve: {
        // The public development export admits both native router lanes;
        // each router's isServer option owns SSR or client evaluation here.
        conditionNames: [
          'modern:source',
          'development',
          'browser',
          'import',
          'default',
        ],
      },
    },
    {
      name: 'server',
      root: __dirname,
      include: ['tests/server/**/*.test.ts'],
      exclude: ['tests/server/dev-diagnostics.test.ts'],
      testEnvironment: 'node',
      globals: true,
      tools: nativeCompiler(true),
      resolve: {
        conditionNames: ['modern:source', 'node', 'import', 'default'],
      },
    },
    {
      // Solid's dev diagnostics (STRICT_READ_UNTRACKED, SERVER_WRITE, ...)
      // only exist in the `.dev.js` builds, which require the `development`
      // condition. The plain `server` project above resolves the silent
      // production build, so a regression there would never fail a test.
      name: 'server-diagnostics',
      root: __dirname,
      include: ['tests/server/dev-diagnostics.test.ts'],
      testEnvironment: 'node',
      globals: true,
      output: { bundleDependencies: true },
      tools: nativeCompiler(true),
      resolve: {
        // `node` must precede `development`: solid-js/@solidjs/web's export
        // maps list a top-level `development` key (browser dev build) ahead
        // of `node`'s own nested `development` key (server dev build), so
        // the consumer's condition order decides which one resolves here.
        conditionNames: [
          'modern:source',
          'node',
          'development',
          'import',
          'default',
        ],
      },
    },
  ],
});
