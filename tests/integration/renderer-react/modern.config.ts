import fs from 'node:fs/promises';
import path from 'node:path';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { defineConfig } from '@modern-js/ultramodern-app-tools';
import type { RsbuildPlugin } from '@rsbuild/core';

// Compilation evidence, not an alias or runtime override: real React on both
// targets must not accidentally satisfy the hydration assertions.
const moduleInventory: RsbuildPlugin = {
  name: 'redact-acceptance-module-inventory',
  setup(api) {
    api.onAfterBuild(async ({ stats }) => {
      if (!stats) throw new Error('Redact compilation stats are missing');
      const compilations = 'stats' in stats ? stats.stats : [stats];
      await fs.writeFile(
        path.join(api.context.distPath, 'redact-modules.json'),
        JSON.stringify(
          compilations.map(compilation => ({
            name: compilation.compilation.name,
            ...compilation.toJson({
              all: false,
              modules: true,
              nestedModules: true,
              cachedModules: true,
              orphanModules: true,
            }),
          })),
        ),
      );
    });
  },
};

export default defineConfig({
  renderer: 'react',
  // An explicit control lane; ordinary builds still exercise the default.
  redact: process.env.REDACT_ACCEPTANCE_OPTOUT === 'true' ? false : undefined,
  plugins: [tanstackRouterPlugin()],
  server: { ssr: { mode: 'stream' } },
  html: { favicon: './src/favicon.svg' },
  builderPlugins: [moduleInventory],
  ...(process.env.MODERNJS_DEPLOY === 'cloudflare'
    ? {
        deploy: {
          worker: {
            compatibilityDate: '2026-06-02',
            name: 'modernjs-redact-acceptance',
            ssr: true,
          },
        },
      }
    : {}),
});
