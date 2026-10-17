import fs from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from '@modern-js/ultramodern-app-tools';

// The csr specs build the same app without SSR.
export default defineConfig({
  renderer: 'solid',
  server: { ssr: process.env.RENDERER_CSR !== 'true' },
  // Standard build diagnostics used by installed-consumer acceptance. The
  // diagnostic does not change compilation, resolution or runtime behavior.
  builderPlugins:
    process.env.SOLID_CONSUMER_STATS === 'true'
      ? [
          {
            name: 'solid-consumer-module-inventory',
            setup(api) {
              api.onAfterBuild(async ({ stats }) => {
                if (!stats)
                  throw new Error(
                    'Solid consumer compilation stats are missing',
                  );
                const compilations = 'stats' in stats ? stats.stats : [stats];
                const inventory = compilations.map(compilation => ({
                  name: compilation.compilation.name,
                  ...compilation.toJson({
                    all: false,
                    modules: true,
                    nestedModules: true,
                    cachedModules: true,
                    orphanModules: true,
                  }),
                }));
                await fs.writeFile(
                  path.join(
                    api.context.distPath,
                    'solid-consumer-modules.json',
                  ),
                  JSON.stringify({ schema: 1, compilations: inventory }),
                );
              });
            },
          },
        ]
      : [],
});
