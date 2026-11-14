import path from 'node:path';
import type { ProjectConfig } from '@rstest/core';
import { withTestPreset } from '@scripts/rstest-config';

const commonConfig: ProjectConfig = {
  setupFiles: ['@scripts/rstest-config/setup.ts'],
  globals: true,
  tools: {
    swc: {
      jsc: {
        transform: {
          react: {
            runtime: 'automatic',
          },
        },
      },
    },
  },
};

export default {
  projects: [
    withTestPreset({
      name: 'plugin-runtime-node',
      testEnvironment: 'node',
      exclude: [
        'tests/ssr/serverRender/workerLifecycle.test.tsx',
        'tests/router/plugin.client.test.tsx',
        'tests/router/prefetch.test.tsx',
        'tests/router/prefetch-realm-isolation.test.tsx',
        'tests/router/useTransitions.test.tsx',
      ],
      extends: commonConfig,
      plugins: [
        {
          name: 'plugin-runtime-node',
          setup: api => {
            api.transform(
              { test: /document[\\/]+cli[\\/]+index\.ts$/ },
              ({ code }: { code: string }) => {
                return code.replace(
                  "require.resolve('../')",
                  `require.resolve('../index.ts', {
        paths: [__dirname],
      });`,
                );
              },
            );
          },
        },
      ],
    }),
    withTestPreset({
      name: 'plugin-runtime-worker-lifecycle',
      testEnvironment: 'node',
      extends: commonConfig,
      include: ['tests/ssr/serverRender/workerLifecycle.test.tsx'],
      resolve: {
        alias: {
          '@modern-js/render/ssr': path.join(
            __dirname,
            '../render/src/server/ssr/index.ts',
          ),
          'react-server-dom-rspack/client.browser': path.join(
            __dirname,
            'tests/fixtures/rsc-client.ts',
          ),
          'react-server-dom-rspack/client.edge': path.join(
            __dirname,
            'tests/fixtures/rsc-client.ts',
          ),
          '@modern-js/render/rsc': path.join(
            __dirname,
            'tests/fixtures/rsc-server.ts',
          ),
        },
      },
    }),
    withTestPreset({
      name: 'plugin-runtime-client',
      testEnvironment: 'happy-dom',
      include: [
        'tests/router/plugin.client.test.tsx',
        'tests/router/prefetch.test.tsx',
        'tests/router/prefetch-realm-isolation.test.tsx',
        'tests/router/useTransitions.test.tsx',
      ],
      extends: commonConfig,
      plugins: [
        {
          name: 'plugin-runtime-node',
          setup: api => {
            api.transform(
              { test: /PrefetchLink\.tsx$/ },
              ({
                code,
                resourcePath,
              }: {
                code: string;
                resourcePath: string;
              }) => {
                return code
                  .replace(
                    '__webpack_chunk_load__',
                    '__webpack_chunk_load_test__',
                  )
                  .replace(
                    '__webpack_public_path__',
                    '__webpack_public_path_test__',
                  );
              },
            );
          },
        },
      ],
      source: {
        define: {
          WEBPACK_CHUNK_LOAD: '__webpack_chunk_load_test__',
        },
      },
    }),
  ],
};
