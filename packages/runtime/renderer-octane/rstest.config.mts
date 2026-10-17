import { OctaneRspackPlugin } from '@octanejs/rspack-plugin';
import { withTestPreset } from '@scripts/rstest-config';

export default withTestPreset({
  root: __dirname,
  globals: true,
  projects: [
    {
      name: 'octane-browser',
      root: __dirname,
      globals: true,
      include: [
        'tests/client.test.ts',
        'tests/federation-client.test.ts',
        'tests/worker-federation-contexts.test.ts',
        'tests/route-completion-browser.test.ts',
      ],
      testEnvironment: 'happy-dom',
      resolve: {
        conditionNames: ['modern:source', 'browser', 'import', 'default'],
      },
      tools: {
        rspack: {
          plugins: [
            new OctaneRspackPlugin({
              root: __dirname,
              environment: 'client',
              transpile: false,
              parallel: false,
            }),
          ],
        },
      },
    },
    {
      name: 'octane-router-lifecycle',
      root: __dirname,
      globals: true,
      include: [
        'tests/native-router-lifecycle.test.ts',
        'tests/entry-client.test.ts',
        'tests/i18n.test.ts',
        'tests/component-i18n-client.test.ts',
      ],
      testEnvironment: 'happy-dom',
      resolve: {
        conditionNames: [
          'modern:source',
          'development',
          'browser',
          'import',
          'default',
        ],
      },
      tools: {
        rspack: {
          plugins: [
            new OctaneRspackPlugin({
              root: __dirname,
              environment: 'client',
              transpile: false,
              parallel: false,
            }),
          ],
        },
      },
    },
    {
      name: 'octane-server',
      root: __dirname,
      globals: true,
      include: [
        'tests/server.test.ts',
        'tests/federation-server.test.ts',
        'tests/worker-federation-server.test.ts',
        'tests/component-i18n-server.test.ts',
        'tests/routes.test.ts',
        'tests/router-external-snapshot.test.ts',
        'tests/i18n-external-snapshot.test.ts',
        'tests/manifest.test.ts',
        'tests/router-handler.test.ts',
        'tests/action-redirect.test.ts',
        'tests/router-{client,server-snapshot}.test.ts',
      ],
      testEnvironment: 'node',
      output: {
        bundleDependencies: true,
      },
      resolve: {
        conditionNames: [
          'modern:source',
          'node',
          'development',
          'import',
          'default',
        ],
      },
      tools: {
        rspack: {
          plugins: [
            new OctaneRspackPlugin({
              root: __dirname,
              environment: 'server',
              transpile: false,
              parallel: false,
            }),
          ],
        },
      },
    },
  ],
});
