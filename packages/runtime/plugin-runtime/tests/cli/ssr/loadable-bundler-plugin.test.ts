import LoadablePlugin from '../../../src/cli/ssr/loadable-bundler-plugin';

const createCompiler = (chunkLoadingGlobal?: string) => {
  const definitions: Array<Record<string, string>> = [];
  const definePluginApply = rstest.fn();
  let initialize: () => void = () => {};

  class DefinePlugin {
    constructor(value: Record<string, string>) {
      definitions.push(value);
    }

    apply = definePluginApply;
  }

  return {
    compiler: {
      options: {
        output: {
          chunkLoadingGlobal,
        },
      },
      webpack: {
        DefinePlugin,
      },
      hooks: {
        initialize: {
          tap: (_options: unknown, callback: () => void) => {
            initialize = callback;
          },
        },
      },
    },
    initialize: () => initialize(),
    definitions,
    definePluginApply,
  };
};

describe('LoadableBundlerPlugin chunk loading global', () => {
  test.each([
    {
      name: 'preserves a configured compiler output value',
      configured: '__REMOTE_INVENTORY_CHUNKS__',
      option: undefined,
      expected: '__REMOTE_INVENTORY_CHUNKS__',
    },
    {
      name: 'uses the legacy fallback when no value is configured',
      configured: undefined,
      option: undefined,
      expected: '__LOADABLE_LOADED_CHUNKS__',
    },
    {
      name: 'prefers the explicit plugin option over compiler output',
      configured: '__REMOTE_INVENTORY_CHUNKS__',
      option: '__EXPLICIT_CHUNKS__',
      expected: '__EXPLICIT_CHUNKS__',
    },
  ])('$name', ({ configured, option, expected }) => {
    const { compiler, definitions, definePluginApply, initialize } =
      createCompiler(configured);
    const plugin = new LoadablePlugin({
      filename: 'loadable-stats.json',
      outputAsset: false,
      ...(option === undefined ? {} : { chunkLoadingGlobal: option }),
    });

    plugin.apply(compiler as never);
    expect(definitions).toEqual([]);
    initialize();
    expect(compiler.options.output.chunkLoadingGlobal).toBe(
      option ?? configured,
    );
    expect(definitions).toEqual([
      {
        __MODERN_CHUNK_LOADING_GLOBAL__: JSON.stringify(expected),
      },
    ]);
    expect(definePluginApply).toHaveBeenCalledWith(compiler);
  });

  test('uses the final compiler value after other plugins apply', () => {
    const { compiler, definitions, initialize } = createCompiler('__INITIAL__');
    const plugin = new LoadablePlugin({
      filename: 'loadable-stats.json',
      outputAsset: false,
    });
    plugin.apply(compiler as never);
    compiler.options.output.chunkLoadingGlobal = '__FINAL__';
    initialize();
    expect(definitions).toEqual([
      { __MODERN_CHUNK_LOADING_GLOBAL__: JSON.stringify('__FINAL__') },
    ]);
  });
});

describe('LoadableBundlerPlugin stats', () => {
  const emitStats = (publicPath: string) => {
    const plugin = new LoadablePlugin({
      filename: 'loadable-stats.json',
      outputAsset: true,
    });
    const compilation = {
      getStats: () => ({
        toJson: () => ({
          publicPath,
          outputPath: '/dist',
          chunks: [{ id: '1', files: ['static/js/async/page.js'] }],
          entrypoints: {},
          namedChunkGroups: {
            page: {
              assets: [{ name: 'static/js/async/page.js' }],
              childAssets: {},
              chunks: ['1'],
            },
          },
        }),
      }),
    };
    const asset = plugin.handleEmit(compilation as never);
    return JSON.parse(String(asset?.source()));
  };

  test.each([
    ['auto', '/static/js/async/page.js'],
    ['auto/', '/static/js/async/page.js'],
    [
      'https://cdn.example/app/',
      'https://cdn.example/app/static/js/async/page.js',
    ],
  ])('lets @loadable/server resolve %s chunk URLs', async (publicPath, url) => {
    const { ChunkExtractor } = await import('@loadable/server');
    const extractor = new ChunkExtractor({
      stats: emitStats(publicPath),
      entrypoints: [],
    });
    extractor.addChunk('page');

    expect(extractor.getScriptTags()).toContain(`src="${url}"`);
  });
});
