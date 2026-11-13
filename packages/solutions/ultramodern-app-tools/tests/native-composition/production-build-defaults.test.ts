import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  createPresetUltramodernConfig,
  presetUltramodern,
} from '@modern-js/ultramodern-app-tools';
import { createRsbuild, type RsbuildConfig, rspack } from '@rsbuild/core';
import { ULTRAMODERN_SERVER_MINIFY } from '../../src/native-composition/server-minify';

type BuilderPlugin = NonNullable<RsbuildConfig['plugins']>[number];

const serverMinifyPlugin = (minify?: unknown) => {
  const plugin = presetUltramodern(
    minify === undefined ? {} : { output: { minify: minify as never } },
  ).builderPlugins?.find(
    candidate =>
      (candidate as { name?: string }).name === 'ultramodern:server-minify',
  );
  expect(plugin).toBeDefined();
  return plugin as BuilderPlugin;
};

const resolveMinimize = async (
  config: RsbuildConfig,
  plugin: BuilderPlugin,
) => {
  const rsbuild = await createRsbuild({
    cwd: os.tmpdir(),
    rsbuildConfig: { ...config, mode: 'production', plugins: [plugin] },
  });
  const configs = await rsbuild.initConfigs();
  return Object.fromEntries(
    configs.map(config => [
      config.name,
      {
        minimize: config.optimization?.minimize,
        minimizer: (config.optimization?.minimizer ?? []).map(
          minimizer => (minimizer as { _args?: unknown })._args,
        ),
      },
    ]),
  );
};

const environments = {
  client: { output: { target: 'web' as const } },
  server: { output: { target: 'node' as const } },
};

const isStrict = (source: string) => {
  try {
    new vm.Script(`${source}\n;with({}){}`);
    return false;
  } catch (error) {
    if (error instanceof SyntaxError) return true;
    throw error;
  }
};

describe('UltraModern production build defaults', () => {
  it('minifies node environments with names kept and leaves web defaults alone', async () => {
    const resolved = await resolveMinimize(
      { environments },
      serverMinifyPlugin(),
    );

    expect(resolved.server.minimize).toBe(true);
    expect(JSON.stringify(resolved.server.minimizer)).toContain(
      '"keep_fnames":true',
    );
    expect(resolved.client.minimize).toBe(true);
    expect(JSON.stringify(resolved.client.minimizer)).not.toContain(
      'keep_fnames',
    );
  });

  it('keeps an explicit app or environment minify choice', async () => {
    const appOptOut = await resolveMinimize(
      { environments, output: { minify: false } },
      serverMinifyPlugin(false),
    );
    expect(appOptOut.server.minimize).toBe(false);

    const environmentOptOut = await resolveMinimize(
      {
        environments: {
          ...environments,
          server: { output: { target: 'node', minify: false } },
        },
      },
      serverMinifyPlugin(),
    );
    expect(environmentOptOut.server.minimize).toBe(false);
  });

  it('exports names-preserving server minifier options', () => {
    expect(ULTRAMODERN_SERVER_MINIFY.jsOptions.minimizerOptions).toEqual({
      compress: { keep_classnames: true, keep_fnames: true },
      mangle: { keep_classnames: true, keep_fnames: true },
    });
  });

  it('keeps "use strict" in force after the release identity banner', async () => {
    const previous = process.env.ULTRAMODERN_SOURCE_REVISION;
    const workspaceRoot = fs.realpathSync(
      fs.mkdtempSync(
        path.join(
          process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
          'um-banner-strict-',
        ),
      ),
    );
    process.env.ULTRAMODERN_SOURCE_REVISION = 'c'.repeat(40);
    try {
      const entry = path.join(workspaceRoot, 'entry.js');
      fs.writeFileSync(
        entry,
        'export const strictThis = function () { return this; };\n' +
          'export const load = () => import("./lazy.js");\n',
      );
      fs.writeFileSync(
        path.join(workspaceRoot, 'lazy.js'),
        'export const strictThis = function () { return this; };\n',
      );
      const preset = createPresetUltramodernConfig({
        deliveryUnit: {
          buildMarker: '3333333333333333',
          unitId: 'acme/catalog',
          version: '1.2.3',
          workspaceRoot,
        },
      });
      const rspackConfig = { plugins: [] as unknown[] };
      const banner = preset.builderPlugins?.find(
        candidate =>
          (candidate as { name?: string }).name ===
          'ultramodern:release-identity-banner',
      ) as { setup(api: unknown): void } | undefined;
      expect(banner).toBeDefined();
      banner!.setup({
        modifyRspackConfig: (handler: (config: typeof rspackConfig) => void) =>
          handler(rspackConfig),
      });

      const build = (outputPath: string, plugins: unknown[]) =>
        new Promise<void>((resolve, reject) => {
          rspack.rspack(
            {
              context: workspaceRoot,
              entry,
              mode: 'production',
              target: 'node',
              optimization: { minimize: true },
              output: {
                path: outputPath,
                chunkFormat: 'commonjs',
                // Keep the exported lazy import reachable under tree shaking.
                library: { type: 'commonjs2' },
              },
              plugins: plugins as never,
            },
            (error, stats) =>
              error || !stats || stats.hasErrors()
                ? reject(error ?? new Error(stats?.toString()))
                : resolve(),
          );
        });
      const plain = path.join(workspaceRoot, 'plain');
      const stamped = path.join(workspaceRoot, 'stamped');
      await build(plain, []);
      await build(stamped, rspackConfig.plugins);

      const chunks = fs
        .readdirSync(stamped)
        .filter(file => file.endsWith('.js'));
      expect(chunks.length).toBeGreaterThan(1);

      const require = createRequire(entry);
      for (const outputPath of [plain, stamped]) {
        const { strictThis, load } = require(path.join(outputPath, 'main.js'));
        expect(strictThis()).toBeUndefined();
        const { strictThis: lazyStrictThis } = await load();
        expect(lazyStrictThis()).toBeUndefined();
      }

      for (const chunk of chunks) {
        const before = fs.readFileSync(path.join(plain, chunk), 'utf8');
        const after = fs.readFileSync(path.join(stamped, chunk), 'utf8');
        expect(after.startsWith('"')).toBe(true);
        expect(after).toContain('"1.2.3";');
        expect(isStrict(after)).toBe(isStrict(before));
      }
      expect(
        chunks.some(chunk =>
          isStrict(fs.readFileSync(path.join(stamped, chunk), 'utf8')),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      if (previous === undefined) {
        delete process.env.ULTRAMODERN_SOURCE_REVISION;
      } else {
        process.env.ULTRAMODERN_SOURCE_REVISION = previous;
      }
    }
  });
});
