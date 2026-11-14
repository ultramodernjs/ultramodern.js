import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppTools } from '@modern-js/app-tools';
import { createPluginManager } from '@modern-js/plugin';
import { createContext, initPluginAPI } from '@modern-js/plugin/cli';
import { fs } from '@modern-js/utils';
import { bffPlugin as nativeBffPlugin } from '../../plugin-bff/src/cli';
import nativeLoader from '../../plugin-bff/src/loader';
import { bffPlugin } from '../src';
import { resolveSelfModule } from '../src/self-module';

rstest.mock('@modern-js/plugin-bff', () => ({
  bffPlugin: nativeBffPlugin,
  default: nativeBffPlugin,
}));

// Hono-only consumers do not install the optional Effect peers; loading any of
// these during the Hono CLI lifecycle fails the suite below.
rstest.mock('effect', () => {
  throw new Error('optional Effect peer was loaded by the Hono CLI path');
});
rstest.mock('@effect/opentelemetry', () => {
  throw new Error('optional Effect telemetry was loaded by the Hono CLI path');
});
rstest.mock('@modern-js/plugin-bff-extensions/client-generator', () => {
  throw new Error('Effect codegen was loaded by the Hono CLI path');
});

async function createFixture(
  runtimeFramework: 'hono' | 'effect' = 'hono',
  useFork = true,
) {
  const appDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bff-composition-'),
  );
  const apiDirectory = path.join(appDirectory, 'api');
  await fs.ensureDir(apiDirectory);
  await fs.outputFile(
    path.join(appDirectory, 'shared/value.ts'),
    'export const value: number = 1;',
  );
  await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      moduleResolution: 'Node',
      declaration: true,
    },
    include: ['api', 'shared'],
  });
  await fs.outputJSON(path.join(appDirectory, 'package.json'), {
    name: 'producer',
    dependencies: {
      '@modern-js/plugin-bff-build-extensions': '3.8.3',
      '@modern-js/plugin-bff-extensions': '3.8.3',
    },
  });
  const manager = createPluginManager();
  manager.addPlugins([useFork ? bffPlugin() : nativeBffPlugin()]);
  const plugins = manager.getPlugins();
  const config = {
    tools: {},
    bff: { runtimeFramework, crossProject: true },
    source: {},
    resolve: {},
    output: { distPath: { root: 'dist' } },
    server: {},
  };
  const context = await createContext<AppTools>({
    appContext: {
      appDirectory,
      apiDirectory,
      lambdaDirectory: path.join(apiDirectory, 'lambda'),
      sharedDirectory: path.join(appDirectory, 'shared'),
      distDirectory: path.join(appDirectory, 'dist'),
      moduleType: 'commonjs',
      plugins,
    } as never,
    config: config as never,
    normalizedConfig: config as never,
  });
  const api = initPluginAPI<AppTools>({ context, pluginManager: manager });
  for (const plugin of plugins) await plugin.setup?.(api);
  return { appDirectory, api, plugins, config };
}

afterEach(() => rstest.clearAllMocks());

test('native composition owns each build, dev and watch compilation once', async () => {
  const { appDirectory, api } = await createFixture();
  try {
    expect(api.getAppContext().bffRuntimeFramework).toBe('hono');
    const compile = rstest.fn();
    api.onBeforeBffCompile(compile);
    await api.getHooks().onBeforeDev.call();
    expect(compile).toHaveBeenCalledTimes(1);
    await api.getHooks().onAfterBuild.call({} as never);
    expect(compile).toHaveBeenCalledTimes(2);
    await api.getHooks().onFileChanged.call({
      filename: 'api/handler.ts',
      eventType: 'change',
      isPrivate: false,
    } as never);
    expect(compile).toHaveBeenCalledTimes(3);
    await api.getHooks().onFileChanged.call({
      filename: 'api/handler.js.map',
      eventType: 'change',
      isPrivate: false,
    } as never);
    expect(compile).toHaveBeenCalledTimes(3);
  } finally {
    await fs.remove(appDirectory);
  }
});

test('missing native hooks reject setup instead of silently dropping taps', async () => {
  await expect(
    Promise.resolve().then(() =>
      bffPlugin().setup!({ getHooks: () => ({}) } as never),
    ),
  ).rejects.toThrow('Native BFF build hook onBeforeBffCompile is unavailable');
});

test('selects direct Effect server plugin and native Hono server plugin', async () => {
  for (const runtimeFramework of ['effect', 'hono'] as const) {
    const { appDirectory, api } = await createFixture(runtimeFramework);
    try {
      const registered = await api
        .getHooks()
        ._internalServerPlugins.call({ plugins: [] });
      expect(registered.plugins).toHaveLength(1);
      if (runtimeFramework === 'effect') {
        expect(registered.plugins[0]?.name).toBe(
          '@modern-js/plugin-bff-extensions/effect-server',
        );
        expect(registered.plugins[0]?.includeEntries).toBeUndefined();
      } else {
        expect(registered.plugins[0]?.name).toBe(
          '@modern-js/plugin-bff/server-plugin',
        );
        expect(registered.plugins[0]?.includeEntries).toEqual([
          '@modern-js/plugin-bff-extensions/hono/node',
        ]);
      }
    } finally {
      await fs.remove(appDirectory);
    }
  }
});

test('fork hono composition passes the same codegen module through native lambda loader and publication', async () => {
  const runtimeFramework = 'hono' as const;
  const { appDirectory, api, config } = await createFixture(runtimeFramework);
  try {
    const resourcePath = path.join(appDirectory, 'api/lambda/ping.ts');
    const source = 'export default async () => "pong";';
    await fs.outputFile(resourcePath, source);
    const configurations = await api.getHooks().config.call();
    const defaults = configurations.find(
      value => value?.bff?.clientCodegenPlugin,
    )?.bff;
    // Resolved next to this package rather than through its own public name,
    // which an isolated (pnpm) layout cannot resolve from here.
    expect(defaults?.clientCodegenPlugin).toBe(
      resolveSelfModule('hono-client-codegen'),
    );
    Object.assign(config.bff, defaults, {
      runtimeFramework,
      requestId: 'configured-composition-id',
    });
    let loaderOptions: any;
    const rule: any = {
      exclude: { add: () => rule },
      test: () => rule,
      use: () => ({
        loader: () => ({
          options: (options: unknown) => {
            loaderOptions = options;
            return rule;
          },
        }),
      }),
    };
    const nativeConfiguration = configurations.find(
      value => typeof value?.tools?.bundlerChain === 'function',
    );
    const bundlerChain = nativeConfiguration!.tools!.bundlerChain as (
      chain: unknown,
      context: unknown,
    ) => void;
    bundlerChain(
      { module: { rule: () => rule } },
      { CHAIN_ID: { RULE: { JS: 'js' } }, isServer: false },
    );
    expect(loaderOptions.clientCodegenPlugin).toBe(
      defaults?.clientCodegenPlugin,
    );
    const callback = rstest.fn();
    await nativeLoader.call(
      {
        resourcePath,
        cacheable: () => {},
        async: () => callback,
        getOptions: () => loaderOptions,
      } as never,
      source,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toBeUndefined();
    expect(callback.mock.calls[0]?.[1]).toContain('operationManifest');
    expect(callback.mock.calls[0]?.[1]).toContain(
      'requestId: "configured-composition-id"',
    );
    expect(callback.mock.calls[0]?.[1]).toContain(
      '@modern-js/runtime-extensions/request-policy',
    );
    if (runtimeFramework === 'hono') {
      await api.getHooks().onAfterBuild.call({} as never);
      const generated = await fs.readFile(
        path.join(appDirectory, 'dist/client/ping.js'),
        'utf8',
      );
      expect(generated).toContain('operationManifest');
      expect(generated).toContain('initProducerClient');
      expect(
        generated.match(/requestId: "configured-composition-id"/g)?.length,
      ).toBeGreaterThanOrEqual(2);
      expect(generated).toContain(
        '@modern-js/runtime-extensions/request-policy',
      );
      expect(
        await fs.readFile(
          path.join(appDirectory, 'dist/client/ping.d.ts'),
          'utf8',
        ),
      ).toContain('../api/lambda/ping.js');
      const runtimeFile = path.join(appDirectory, 'dist/runtime/index.js');
      expect(await fs.readFile(runtimeFile, 'utf8')).toContain(
        'requestId: "configured-composition-id"',
      );
      for (const [name, sourceDirectory] of [
        [
          'runtime-extensions',
          path.dirname(
            require.resolve('@modern-js/runtime-extensions/package.json'),
          ),
        ],
        [
          'plugin-bff-extensions',
          path.resolve(__dirname, '../../plugin-bff-extensions'),
        ],
      ]) {
        const target = path.join(
          appDirectory,
          'node_modules/@modern-js',
          name!,
        );
        await fs.ensureDir(path.dirname(target));
        await fs.symlink(
          sourceDirectory!,
          target,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      const runtime = await import(
        /* webpackIgnore: true */ pathToFileURL(runtimeFile).href
      );
      const client = await import(
        /* webpackIgnore: true */ pathToFileURL(
          path.join(appDirectory, 'dist/client/ping.js'),
        ).href
      );
      const request = rstest.fn(async () => ({ ok: true }));
      runtime.configure({
        setDomain: () => 'https://producer.example',
        request,
      });
      await client.default();
      expect(request).toHaveBeenCalledTimes(1);
    }
  } finally {
    await fs.remove(appDirectory);
  }
});

test('hono composition boots the CLI without loading optional Effect peers', async () => {
  const { appDirectory, api } = await createFixture('hono');
  try {
    await expect(api.getHooks().config.call()).resolves.toBeDefined();
    expect(api.getAppContext().bffRuntimeFramework).toBe('hono');
  } finally {
    await fs.remove(appDirectory);
  }
});
