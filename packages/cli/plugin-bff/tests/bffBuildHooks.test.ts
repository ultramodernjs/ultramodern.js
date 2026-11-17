import os from 'node:os';
import path from 'node:path';
import * as actualServerUtils from '@modern-js/server-utils' with {
  rstest: 'importActual',
};
import { fs } from '@modern-js/utils';
import serverBuildPlugin from '../../../solutions/app-tools/src/plugins/serverBuild';
import { bffPlugin } from '../src/cli';
import { createBffGenerator } from '../src/cli/generator';

type Compile = typeof actualServerUtils.compile;
const compileCalls: Parameters<Compile>[] = [];
let compileImplementation: Compile = actualServerUtils.compile;

rstest.mock('@modern-js/server-utils', () => ({
  ...actualServerUtils,
  compile: (...args: Parameters<Compile>) => {
    compileCalls.push(args);
    return compileImplementation(...args);
  },
}));

beforeEach(() => {
  compileCalls.length = 0;
  compileImplementation = actualServerUtils.compile;
});

async function fixture(
  source = 'export const value: number = 1;',
  sourceMap?: boolean,
) {
  const appDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'native-bff-hooks-')),
  );
  const apiDirectory = path.join(appDirectory, 'api');
  await fs.outputFile(path.join(apiDirectory, 'index.ts'), source);
  await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      moduleResolution: 'Node',
      noEmitOnError: true,
    },
    include: ['api'],
  });
  await fs.outputJSON(path.join(appDirectory, 'package.json'), {
    name: 'native-hooks',
  });
  const hooks = bffPlugin().registryHooks!;
  const context = {
    appDirectory,
    apiDirectory,
    lambdaDirectory: path.join(apiDirectory, 'lambda'),
    distDirectory: path.join(appDirectory, 'dist'),
    sharedDirectory: path.join(appDirectory, 'shared'),
    moduleType: 'commonjs',
    serverCompileExcludedFiles: [] as string[],
  };
  const api = {
    getAppContext: () => context,
    getHooks: () => hooks,
    getNormalizedConfig: () => ({
      source: {},
      resolve: {},
      server: {},
      tools: {},
      output: { sourceMap },
      bff: {},
    }),
  };
  return { appDirectory, context, hooks, ...createBffGenerator(api as never) };
}

test('forwards disabled source maps to the BFF compiler', async () => {
  const { appDirectory, compileApi } = await fixture(undefined, false);
  try {
    await compileApi('build');
    const output = path.join(appDirectory, 'dist/api/index.js');
    expect(require(output).value).toBe(1);
    expect(fs.existsSync(`${output}.map`)).toBe(false);
    expect(await fs.readFile(output, 'utf8')).not.toContain(
      'sourceMappingURL=',
    );
  } finally {
    await fs.remove(appDirectory);
  }
});

test('runs before and after around actual compilation with the same context', async () => {
  const { appDirectory, hooks, compileApi } = await fixture();
  const seen: unknown[] = [];
  const results: { emittedFiles: readonly string[] }[] = [];
  const output = path.join(appDirectory, 'dist/api/index.js');
  try {
    hooks.onBeforeBffCompile.tap(context => {
      expect(fs.existsSync(output)).toBe(false);
      seen.push(context);
    });
    hooks.onAfterBffCompile.tap((context, result) => {
      expect(fs.existsSync(output)).toBe(true);
      seen.push(context);
      results.push(result);
    });
    await compileApi('build');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toMatchObject({
      appDirectory,
      sourceDirectories: [path.join(appDirectory, 'api')],
    });
    expect(results).toHaveLength(1);
    expect(results[0].emittedFiles.map(file => path.normalize(file))).toContain(
      output,
    );
  } finally {
    await fs.remove(appDirectory);
  }
});

test('before hook failures prevent writes and compiler failures do not run after hooks', async () => {
  const first = await fixture();
  try {
    first.hooks.onBeforeBffCompile.tap(() => {
      throw new Error('before rejected');
    });
    await expect(first.compileApi('build')).rejects.toThrow('before rejected');
    expect(fs.existsSync(path.join(first.appDirectory, 'dist'))).toBe(false);
  } finally {
    await fs.remove(first.appDirectory);
  }
  const broken = await fixture('export const value: number = "invalid";');
  try {
    const after = rstest.fn();
    broken.hooks.onAfterBffCompile.tap(after);
    await expect(broken.compileApi('build')).rejects.toThrow();
    expect(after).not.toHaveBeenCalled();
  } finally {
    await fs.remove(broken.appDirectory);
  }
});

test('forwards the current exact generated declaration exclusions after before hooks', async () => {
  const { appDirectory, context, hooks, compileApi } = await fixture();
  try {
    const excluded = path.join(context.apiDirectory, 'register.gen.d.ts');
    await fs.outputFile(
      excluded,
      "import type { Missing } from 'unavailable-generated-client-module';",
    );
    hooks.onBeforeBffCompile.tap(() => {
      context.serverCompileExcludedFiles = [excluded];
    });
    await compileApi('build');
    expect(fs.existsSync(path.join(appDirectory, 'dist/api/index.js'))).toBe(
      true,
    );
  } finally {
    await fs.remove(appDirectory);
  }
});

async function listSources(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(entry => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return listSources(file);
      return /\.[cm]?[jt]s$/u.test(entry.name) ? [file] : [];
    }),
  );
  return nested.flat();
}

/** Emits one marker module per source root file and reports exactly those. */
const fakeCompile: Compile = async (appDirectory, _config, options) => {
  const sources = (await Promise.all(options.sourceDirs.map(listSources)))
    .flat()
    .sort();
  const emittedFiles: string[] = [];
  for (const file of sources) {
    const relative = path.relative(appDirectory, file).replace(/\.ts$/u, '.js');
    const output = path.join(options.distDir, relative);
    await fs.outputFile(
      output,
      `module.exports = ${JSON.stringify(relative)};`,
    );
    emittedFiles.push(output);
  }
  return { rootFiles: emittedFiles, emittedFiles };
};

type LifecycleOptions = {
  api?: boolean;
  shared?: boolean;
  server?: 'modern.server.ts' | 'cache.ts' | 'plain.ts';
  sharedDirectory?: string;
  apiOnly?: boolean;
  tsconfigPath?: string;
};

async function lifecycleApp(options: LifecycleOptions = {}) {
  const {
    api: hasApi = true,
    shared = true,
    server = 'modern.server.ts',
  } = options;
  const appDirectory = await fs.realpath(
    await fs.mkdtemp(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'bff-lifecycle-'),
    ),
  );
  if (hasApi)
    await fs.outputFile(
      path.join(appDirectory, 'api/index.ts'),
      'export default 1;',
    );
  if (shared)
    await fs.outputFile(
      path.join(appDirectory, 'shared/schema.ts'),
      'export {};',
    );
  if (options.sharedDirectory)
    await fs.outputFile(
      path.join(appDirectory, options.sharedDirectory, 'custom.ts'),
      'export {};',
    );
  await fs.outputFile(path.join(appDirectory, 'server', server), 'export {};');
  await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {});
  let context: Record<string, unknown> = {
    appDirectory,
    apiDirectory: path.join(appDirectory, 'api'),
    lambdaDirectory: path.join(appDirectory, 'api/lambda'),
    distDirectory: path.join(appDirectory, 'dist'),
    sharedDirectory: path.join(
      appDirectory,
      options.sharedDirectory ?? 'shared',
    ),
    metaName: 'modern-js',
    moduleType: 'commonjs',
    apiOnly: options.apiOnly ?? false,
  };
  const config = {
    source: { alias: { '@source': './src' } },
    resolve: { alias: { '@resolve': './src' } },
    server: { tsconfigPath: options.tsconfigPath },
    output: {},
    tools: {},
    bff: {},
  };
  const hooks = bffPlugin().registryHooks!;
  const afterBuild: (() => Promise<void>)[] = [];
  const api = new Proxy(
    {},
    {
      get: (_target, name) => {
        switch (name) {
          case 'getAppContext':
            return () => context;
          case 'updateAppContext':
            return (update: Record<string, unknown>) => {
              context = { ...context, ...update };
            };
          case 'getConfig':
          case 'getNormalizedConfig':
            return () => config;
          case 'getHooks':
            return () => hooks;
          case 'onAfterBuild':
            return (callback: () => Promise<void>) => afterBuild.push(callback);
          default:
            return () => undefined;
        }
      },
    },
  );
  return {
    appDirectory,
    api,
    hooks,
    afterBuild,
    context: () => context,
    remove: () => fs.remove(appDirectory),
  };
}

const sourceDirsOfOnlyCompile = (appDirectory: string) => {
  expect(compileCalls).toHaveLength(1);
  return compileCalls[0][2].sourceDirs.map(directory =>
    path.relative(appDirectory, directory).split(path.sep).join('/'),
  );
};

describe('one writer for BFF and server roots', () => {
  beforeEach(() => {
    compileImplementation = fakeCompile;
  });

  it.each(['server-build first', 'bff first'])(
    'compiles API, shared and server once when %s registers',
    async order => {
      const app = await lifecycleApp();
      try {
        const plugins = [serverBuildPlugin(), bffPlugin()];
        if (order === 'bff first') plugins.reverse();
        for (const plugin of plugins) await plugin.setup!(app.api as never);
        const results: { emittedFiles: readonly string[] }[] = [];
        app.hooks.onAfterBffCompile.tap((_context, result) => {
          results.push(result);
        });
        expect(app.context().serverCompileOwner).toBe('@modern-js/plugin-bff');
        for (const callback of app.afterBuild) await callback();

        expect(sourceDirsOfOnlyCompile(app.appDirectory)).toEqual([
          'api',
          'shared',
          'server',
        ]);
        // Server sources now see the same alias set as the BFF sources.
        expect(compileCalls[0][1].alias).toEqual([
          { '@source': './src' },
          { '@resolve': './src' },
        ]);
        expect(
          results.map(result =>
            result.emittedFiles.map(file =>
              path.relative(app.appDirectory, file).split(path.sep).join('/'),
            ),
          ),
        ).toEqual([
          [
            'dist/api/index.js',
            'dist/server/modern.server.js',
            'dist/shared/schema.js',
          ],
        ]);
      } finally {
        await app.remove();
      }
    },
  );

  it.each<[string, LifecycleOptions, string[]]>([
    ['BFF server-only', { api: false }, ['shared', 'server']],
    ['API-only', { apiOnly: true }, ['api', 'shared', 'server']],
    ['server cache', { server: 'cache.ts' }, ['api', 'shared', 'server']],
    ['ungated server folder', { server: 'plain.ts' }, ['api', 'shared']],
    [
      'custom shared',
      { sharedDirectory: 'common' },
      ['api', 'common', 'server', 'shared'],
    ],
  ])('keeps one compile for %s apps', async (_name, options, expected) => {
    const app = await lifecycleApp(options);
    try {
      for (const plugin of [bffPlugin(), serverBuildPlugin()])
        await plugin.setup!(app.api as never);
      for (const callback of app.afterBuild.reverse()) await callback();
      expect(sourceDirsOfOnlyCompile(app.appDirectory)).toEqual(expected);
    } finally {
      await app.remove();
    }
  });

  it('forwards the server tsconfig and current exclusions to the one compile', async () => {
    const app = await lifecycleApp({ tsconfigPath: './tsconfig.server.json' });
    try {
      for (const plugin of [serverBuildPlugin(), bffPlugin()])
        await plugin.setup!(app.api as never);
      const excluded = path.join(app.appDirectory, 'server/generated.d.ts');
      app.hooks.onBeforeBffCompile.tap(() => {
        (
          app.api as { updateAppContext: (update: object) => void }
        ).updateAppContext({ serverCompileExcludedFiles: [excluded] });
      });
      for (const callback of app.afterBuild) await callback();
      expect(compileCalls).toHaveLength(1);
      expect(compileCalls[0][2]).toMatchObject({
        tsconfigPath: path.join(app.appDirectory, 'tsconfig.server.json'),
        excludeFiles: [excluded],
      });
    } finally {
      await app.remove();
    }
  });

  it('keeps dev cross-project compilation to API and shared sources', async () => {
    const app = await lifecycleApp();
    try {
      for (const plugin of [serverBuildPlugin(), bffPlugin()])
        await plugin.setup!(app.api as never);
      await createBffGenerator(app.api as never).compileApi('dev');
      expect(sourceDirsOfOnlyCompile(app.appDirectory)).toEqual([
        'api',
        'shared',
      ]);
      expect(fs.existsSync(path.join(app.appDirectory, 'dist/server'))).toBe(
        false,
      );
    } finally {
      await app.remove();
    }
  });
});
