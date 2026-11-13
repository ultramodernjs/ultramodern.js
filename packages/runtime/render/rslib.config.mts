import { ts7DtsConfig } from '@modern-js/rslib';
import { defineConfig } from '@rslib/core';

const sharedConfig = {
  format: 'esm' as const,
  syntax: 'es2021' as const,
  bundle: true,
  dts: false,
  output: {
    distPath: {
      root: './dist/esm',
    },
    target: 'web' as const,
  },
};

export default defineConfig({
  source: {
    define: {
      // Leave the application RSC manifest for the downstream Rspack build.
      RSPACK_RSC_MANIFEST: '__rspack_rsc_manifest__',
    },
  },
  lib: [
    {
      ...sharedConfig,
      dts: ts7DtsConfig,
      output: {
        ...sharedConfig.output,
        externals: [
          {
            '@modern-js/render/rsc': 'module-import @modern-js/render/rsc',
          },
        ],
      },
      source: {
        entry: {
          ssr: './src/ssr.ts',
          client: './src/client.ts',
        },
      },
    },
    {
      ...sharedConfig,
      source: {
        entry: {
          rsc: './src/rsc.ts',
        },
      },
    },
    {
      ...sharedConfig,
      source: {
        entry: {
          'rsc.edge': './src/rsc.edge.ts',
        },
      },
    },
  ],
});
