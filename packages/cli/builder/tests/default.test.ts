import { type RsbuildPlugin, rspack } from '@rsbuild/core';
import { afterEach, describe, expect, it, rs } from '@rstest/core';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { assertCreateRequireBundling } from '../../../../scripts/tests/fixture-builder-semantics';
import { createBuilder } from '../src';

const builderPath = join(__dirname, '..');

const compileRspack = async (config: any) => {
  const compiler = rspack(config);

  return new Promise<any>((resolve, reject) => {
    compiler.run((runError, stats) => {
      compiler.close(closeError => {
        const error = runError ?? closeError;
        if (error) {
          reject(error);
          return;
        }

        if (!stats || stats.hasErrors()) {
          reject(
            new Error(
              stats?.toString({ all: false, errors: true, warnings: true }) ??
                'Rspack did not return compilation stats.',
            ),
          );
          return;
        }

        resolve(stats);
      });
    });
  });
};

const getDataUrlEntry = (config: any): string => {
  const entries = Object.values(config.entry ?? {}).flatMap(value =>
    Array.isArray(value) ? value : [value],
  );
  const entry = entries.find(value => {
    if (typeof value !== 'string') {
      return false;
    }

    try {
      return new URL(value).protocol === 'data:';
    } catch {
      return false;
    }
  });

  if (typeof entry !== 'string') {
    throw new Error('Expected the browser entry to include a data URL module.');
  }

  return entry;
};

const executeDataUrlEntry = async (entry: string) => {
  const outputPath = await mkdtemp(join(tmpdir(), 'modern-builder-entry-'));

  try {
    await compileRspack({
      context: builderPath,
      entry,
      mode: 'development',
      output: {
        filename: 'entry.cjs',
        library: { type: 'commonjs2' },
        path: outputPath,
      },
      target: 'node',
    });

    await import(pathToFileURL(join(outputPath, 'entry.cjs')).href);
  } finally {
    await rm(outputPath, { force: true, recursive: true });
  }
};

const compileHtmlTemplate = async (config: any, entry: string) => {
  const htmlPlugin = config.plugins?.find(
    (plugin: any) => plugin?.constructor?.name === 'HtmlRspackPlugin',
  );
  if (!htmlPlugin) {
    throw new Error('Expected the browser config to include HtmlRspackPlugin.');
  }
  expect(htmlPlugin.options).toMatchObject({
    chunks: ['index'],
    compile: true,
    inject: 'head',
    meta: {
      charset: { charset: 'utf-8' },
      viewport: 'width=device-width, initial-scale=1.0',
    },
    scriptLoading: 'defer',
  });

  const outputPath = await mkdtemp(join(tmpdir(), 'modern-builder-html-'));

  try {
    const stats = await compileRspack({
      context: builderPath,
      entry: { index: entry },
      mode: 'development',
      optimization: { minimize: false },
      output: {
        filename: 'static/js/[name].js',
        path: outputPath,
      },
      plugins: [htmlPlugin],
      target: 'web',
    });
    const assets = stats
      .toJson({ all: false, assets: true })
      .assets?.map((asset: any) => asset.name);

    expect(assets).toContain('html/index/index.html');
  } finally {
    await rm(outputPath, { force: true, recursive: true });
  }
};

const collectSwcLoaderOptions = (value: unknown): any[] => {
  const matches: any[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    if (
      'loader' in item &&
      (item as { loader?: unknown }).loader === 'builtin:swc-loader'
    ) {
      matches.push((item as { options?: unknown }).options);
    }

    for (const child of Object.values(item)) {
      if (Array.isArray(child)) {
        child.forEach(visit);
      } else {
        visit(child);
      }
    }
  };

  visit(value);
  return matches;
};

const collectSvgrLoaders = (value: unknown): any[] => {
  const matches: any[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    if (
      'loader' in item &&
      typeof (item as { loader?: unknown }).loader === 'string' &&
      /@rsbuild[\\/]plugin-svgr[\\/]dist[\\/]loader\.mjs/u.test(
        (item as { loader: string }).loader,
      )
    ) {
      matches.push(item);
    }

    for (const child of Object.values(item)) {
      if (Array.isArray(child)) {
        child.forEach(visit);
      } else {
        visit(child);
      }
    }
  };

  visit(value);
  return matches;
};

describe('builder rspack', () => {
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  it('creates an executable browser entry and a compilable HTML template', async () => {
    rs.stubEnv('NODE_ENV', 'development');

    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {
        plugins: [
          {
            name: 'user-plugin',
            setup: () => {},
          },
        ],
      },
      cwd: builderPath,
    });

    const {
      origin: { bundlerConfigs, rsbuildConfig },
    } = await rsbuild.inspectConfig();

    const config = bundlerConfigs[0];
    expect(config).toMatchObject({
      cache: {
        storage: { type: 'filesystem' },
        type: 'persistent',
        version: 'web-development',
      },
      devtool: 'cheap-module-source-map',
      experiments: { sourceImport: true },
      mode: 'development',
      name: 'web',
      output: {
        filename: 'static/js/[name].js',
        publicPath: '/',
      },
      target: [
        'web',
        'browserslist:chrome >= 144,edge >= 144,firefox >= 147,safari >= 27',
      ],
    });

    const dataUrlEntry = getDataUrlEntry(config);
    await executeDataUrlEntry(dataUrlEntry);
    await compileHtmlTemplate(config, dataUrlEntry);

    expect(rsbuildConfig.plugins?.map(p => (p as RsbuildPlugin)?.name)).toEqual(
      [
        'builder:global-vars',
        'builder:devtool',
        'builder:emit-route-file',
        'rsbuild:sass',
        'rsbuild:less',
        'builder:environment-defaults-plugin',
        'builder:plugin-html-minifier-terser',
        'rsbuild:type-check',
        'builder:runtime-chunk',
        'rsbuild:react',
        'rsbuild:svgr',
        'rsbuild:css-minimizer',
        'builder:postcss-plugins',
        'builder:rsc-client-browser-fallback',
        'user-plugin',
      ],
    );
  });

  it('creates a hashed, minimized production browser config', async () => {
    rs.stubEnv('NODE_ENV', 'production');

    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {},
      cwd: builderPath,
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    const config = bundlerConfigs[0];
    expect(config).toMatchObject({
      cache: {
        storage: { type: 'filesystem' },
        type: 'persistent',
        version: 'web-production',
      },
      mode: 'production',
      name: 'web',
      output: {
        chunkFilename: 'static/js/async/[name].[contenthash:10].js',
        filename: 'static/js/[name].[contenthash:10].js',
      },
    });
    expect(config.optimization?.minimize).toBe(true);
    expect(
      config.plugins?.some(
        (plugin: any) =>
          plugin?.constructor?.name === 'HtmlRspackPlugin' &&
          typeof plugin.options?.minify === 'function',
      ),
    ).toBe(true);
  });

  it('creates a CommonJS production server config', async () => {
    rs.stubEnv('NODE_ENV', 'production');

    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {
        environments: {
          server: {
            output: {
              target: 'node',
            },
          },
        },
      },
      cwd: builderPath,
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    expect(bundlerConfigs[0]).toMatchObject({
      cache: {
        storage: { type: 'filesystem' },
        type: 'persistent',
        version: 'server-production',
      },
      mode: 'production',
      name: 'server',
      output: {
        filename: '[name].js',
        library: { type: 'commonjs2' },
      },
      target: 'node',
    });
  });

  it('creates an isolated production web-worker config', async () => {
    rs.stubEnv('NODE_ENV', 'production');

    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {
        environments: {
          workerSSR: {
            output: {
              target: 'web-worker',
              externals: { react: 'MyReact' },
            },
          },
        },
      },
      cwd: builderPath,
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    const config = bundlerConfigs[0];
    expect(config).toMatchObject({
      cache: {
        storage: { type: 'filesystem' },
        type: 'persistent',
        version: 'workerSSR-production',
      },
      mode: 'production',
      name: 'workerSSR',
      output: {
        filename: '[name].js',
        library: { type: 'commonjs2' },
      },
      target: ['webworker', 'es5'],
    });
    expect(config.externals).toBeUndefined();
    expect(
      config.plugins?.some(
        (plugin: any) => plugin?.constructor?.name === 'HtmlRspackPlugin',
      ),
    ).toBe(false);
  });

  it('bundles createRequire dependencies by default and honors explicit opt-out', async () => {
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {},
      cwd: join(__dirname, '..'),
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    expect(bundlerConfigs[0].module.parser.javascript.createRequire).toBe(true);
    await assertCreateRequireBundling();
  });

  it('configures source phase imports through the native Rspack seam', async () => {
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {
        tools: {
          rspack(config) {
            config.experiments ??= {};
            config.experiments.sourceImport = false;
            return config;
          },
        },
      },
      cwd: join(__dirname, '..'),
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    expect(bundlerConfigs[0].experiments.sourceImport).toBe(false);
  });

  it('should forward React Compiler options to builtin SWC', async () => {
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {
        source: {
          reactCompiler: {
            target: '18',
          },
        },
      },
      cwd: join(__dirname, '..'),
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    expect(
      collectSwcLoaderOptions(bundlerConfigs[0]).some(
        options => options?.jsc?.transform?.reactCompiler?.target === '18',
      ),
    ).toBe(true);
  });

  it('should disable React Compiler in builtin SWC when configured', async () => {
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {
        source: {
          reactCompiler: false,
        },
      },
      cwd: join(__dirname, '..'),
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    expect(
      collectSwcLoaderOptions(bundlerConfigs[0]).some(
        options => options?.jsc?.transform?.reactCompiler === false,
      ),
    ).toBe(true);
  });

  it('should omit React Compiler in builtin SWC when disabled for the consuming tool', async () => {
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {},
      cwd: join(__dirname, '..'),
      disableReactCompiler: true,
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    expect(
      collectSwcLoaderOptions(bundlerConfigs[0]).some(options =>
        Object.prototype.hasOwnProperty.call(
          options?.jsc?.transform ?? {},
          'reactCompiler',
        ),
      ),
    ).toBe(false);
  });

  it('should run built-in SVGR loaders in parallel', async () => {
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {},
      cwd: join(__dirname, '..'),
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    const svgrLoaders = collectSvgrLoaders(bundlerConfigs[0]);

    expect(svgrLoaders.length).toBeGreaterThan(0);
    expect(svgrLoaders.every(loader => loader.parallel === true)).toBe(true);
  });
});
