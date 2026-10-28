import type { ProjectConfig } from '@rstest/core';
import { withTestPreset } from '@scripts/rstest-config';

const commonConfig: ProjectConfig = {
  root: __dirname,
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
  root: __dirname,
  projects: [
    withTestPreset({
      ...commonConfig,
      name: 'plugin-tanstack-node',
      testEnvironment: 'node',
      include: [
        'tests/router/cli.test.ts',
        'tests/router/flightSerialization.roundtrip.test.tsx',
        'tests/router/generateRouteArtifacts.test.ts',
        'tests/router/loaderBridge.test.ts',
        'tests/router/localisedIdentity.test.tsx',
        'tests/router/routeHooks.test.ts',
        'tests/router/routeMetadata.test.ts',
        'tests/router/rsc.test.tsx',
        'tests/router/rscRouteLayer.test.ts',
        'tests/router/slotUsageSanitizer.test.ts',
        'tests/router/ssrPreload.test.ts',
        'tests/router/tanstackTypes.test.ts',
        'tests/router/routeTree.test.ts',
      ],
    }),
    withTestPreset({
      ...commonConfig,
      name: 'plugin-tanstack-server-preparation',
      testEnvironment: 'node',
      include: ['tests/router/serverPlugin.test.ts'],
      output: {
        bundleDependencies: ['react-server-dom-rspack/server.node'],
      },
    }),
    withTestPreset({
      ...commonConfig,
      name: 'plugin-tanstack-client',
      testEnvironment: 'happy-dom',
      include: [
        'tests/router/clientHydration.test.tsx',
        'tests/router/dataMutation.test.tsx',
        'tests/router/prefetchLink.test.tsx',
        'tests/router/prefetchLinkPreload.test.tsx',
      ],
    }),
  ],
};
