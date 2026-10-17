import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppTools, CliPlugin } from '@modern-js/app-tools';
import { type CLIPluginAPI, createPluginManager } from '@modern-js/plugin';
import {
  createContext,
  createLoadedConfig,
  initAppContext,
  initPluginAPI,
} from '@modern-js/plugin/cli';
import type { Renderer } from '@modern-js/renderer-core';
import {
  createRsbuild,
  type RsbuildPlugin,
  type RsbuildPlugins,
} from '@rsbuild/core';
import { describe, expect, it, rstest } from '@rstest/core';
import { pluginRuntimeChunk } from '../../../../cli/builder/src/plugins/runtimeChunk';
import {
  createDefineConfig,
  resolveUltramodernConfig,
} from '../../src/native-composition/config';
import { withEntryMetadataRead } from '../../src/native-composition/config-read-context';
import {
  assertRendererCompilerOwnership,
  attachRendererCompilerClaim,
  nativeRendererIsolationPlugin,
  type RendererCompilerClaim,
  rendererSelectionGuard,
  resolveRendererBuilderPlugins,
  ULTRAMODERN_BASE_PLUGIN,
} from '../../src/native-composition/renderer-selection';
import type { UltramodernAppUserConfig } from '../../src/native-composition/types';

function compiler(renderer: 'solid' | 'octane', name = `fixture:${renderer}`) {
  return attachRendererCompilerClaim(
    { name, setup() {} },
    {
      renderer,
      sourceExtensions: ['.tsx'],
      transform: 'native',
      refresh: 'native',
      svg: 'url',
    },
  );
}

describe('native compiler ownership', () => {
  it('resolves promised and nested plugins in order, skips disabled values, and preserves the native claim', async () => {
    const first: RsbuildPlugin = { name: 'fixture:first', setup() {} };
    const native = compiler('solid');
    const last: RsbuildPlugin = { name: 'fixture:last', setup() {} };
    const plugins: RsbuildPlugins = [
      first,
      false,
      Promise.resolve([undefined, [Promise.resolve(native), null]]),
      [false, Promise.resolve(last)],
    ];
    const resolved = await resolveRendererBuilderPlugins(plugins);
    expect(resolved).toEqual([first, native, last]);
    expect(resolved[1]).toBe(native);
    expect(assertRendererCompilerOwnership('solid', resolved)?.renderer).toBe(
      'solid',
    );
  });

  it('propagates a rejected promised plugin', async () => {
    await expect(
      resolveRendererBuilderPlugins([
        Promise.reject(new Error('Compiler plugin failed to load')),
      ]),
    ).rejects.toThrow('Compiler plugin failed to load');
  });
  it.each(['solid', 'octane'] as const)(
    'accepts one complete %s ownership claim',
    renderer => {
      const plugin = compiler(renderer);
      const claim = assertRendererCompilerOwnership(renderer, [plugin]);
      expect(claim).toEqual({
        renderer,
        sourceExtensions: ['.tsx'],
        transform: 'native',
        refresh: 'native',
        svg: 'url',
      });
      expect(Object.isFrozen(claim)).toBe(true);
      expect(Object.isFrozen(claim?.sourceExtensions)).toBe(true);
    },
  );

  it.each(['solid', 'octane'] as const)(
    'rejects missing, duplicate, and mismatched owners for %s',
    renderer => {
      const other = renderer === 'solid' ? 'octane' : 'solid';
      const expected = `Renderer ${renderer} requires exactly one matching native compiler owner`;
      expect(() => assertRendererCompilerOwnership(renderer, [])).toThrow(
        expected,
      );
      expect(() =>
        assertRendererCompilerOwnership(renderer, [compiler(other)]),
      ).toThrow(expected);
      expect(() =>
        assertRendererCompilerOwnership(renderer, [
          compiler(renderer, 'first'),
          compiler(renderer, 'second'),
        ]),
      ).toThrow(expected);
    },
  );

  it('rejects native owners in React configuration and a second claim on one plugin', () => {
    const plugin = compiler('solid');
    expect(
      assertRendererCompilerOwnership('react', [
        { name: 'fixture:ordinary', setup() {} },
      ]),
    ).toBeUndefined();
    expect(() => assertRendererCompilerOwnership('react', [plugin])).toThrow(
      'React configuration contains a native compiler owner',
    );
    expect(() =>
      attachRendererCompilerClaim(plugin, {
        renderer: 'solid',
        sourceExtensions: ['.jsx'],
        transform: 'native',
        refresh: 'native',
        svg: 'url',
      }),
    ).toThrow('already owns a source transform');
  });

  it.each([
    { renderer: 'react' },
    { transform: 'react' },
    { refresh: 'none' },
    { svg: 'react' },
    { sourceExtensions: [] },
    { sourceExtensions: ['tsx'] },
  ])('rejects incomplete or incompatible claims: %j', invalid => {
    const claim = {
      renderer: 'solid',
      sourceExtensions: ['.tsx'],
      transform: 'native',
      refresh: 'native',
      svg: 'url',
      ...invalid,
    };
    expect(() =>
      attachRendererCompilerClaim(
        { name: 'fixture:invalid', setup() {} },
        claim as RendererCompilerClaim,
      ),
    ).toThrow('Invalid native renderer compiler ownership claim');
  });

  it.each(['solid', 'octane'] as const)(
    'removes global React transforms before %s Rsbuild plugin setup',
    async renderer => {
      const isolation: RsbuildPlugin = nativeRendererIsolationPlugin(renderer);
      const forbiddenSetup = rstest.fn(() => {
        throw new Error('A removed React transform reached setup');
      });
      const nativeSetup = rstest.fn();
      const native = attachRendererCompilerClaim(
        { name: `fixture:${renderer}:compiler`, setup: nativeSetup },
        {
          renderer,
          sourceExtensions: ['.tsx'],
          transform: 'native',
          refresh: 'native',
          svg: 'url',
        },
      );
      const rsbuild = await createRsbuild({
        cwd: __dirname,
        rsbuildConfig: {
          source: { entry: { main: './plain-owning-host.js' } },
          tools: { htmlPlugin: false },
          plugins: [
            { name: 'rsbuild:react', setup: forbiddenSetup },
            { name: 'rsbuild:svgr', setup: forbiddenSetup },
            {
              name: 'builder-plugin-adapter-modern-ssr',
              setup: forbiddenSetup,
            },
            isolation,
            native,
          ],
        },
      });
      await rsbuild.initConfigs();
      expect(forbiddenSetup).not.toHaveBeenCalled();
      expect(nativeSetup).toHaveBeenCalledTimes(1);
    },
  );
});

describe('native external script asset policy', () => {
  it.each(['solid', 'octane'] as const)(
    'keeps the %s runtime external through the owning config and builder hooks',
    async renderer => {
      const config = await selectHost(renderer, {
        name: 'fixture:selected-host',
      });
      const { api } = await initializeSelection(config);
      const resolved = await api.getHooks().modifyResolvedConfig.call(config);
      expect(resolved.output?.disableInlineRuntimeChunk).toBe(true);
      const rsbuild = await createRsbuild({
        cwd: __dirname,
        rsbuildConfig: {
          source: { entry: { main: './native-runtime-owning-host.js' } },
          tools: { htmlPlugin: false },
          output: { inlineScripts: resolved.output?.inlineScripts },
          plugins: [
            pluginRuntimeChunk(resolved.output?.disableInlineRuntimeChunk),
            nativeRendererIsolationPlugin(renderer),
          ],
        },
      });
      const [bundler] = await rsbuild.initConfigs();
      expect(rsbuild.getNormalizedConfig().output.inlineScripts).toBe(false);
      expect(bundler.optimization?.runtimeChunk).toEqual({
        name: 'builder-runtime',
      });
    },
  );

  it('preserves the upstream inline-runtime default for React', async () => {
    const config = await selectHost('react', { name: 'fixture:selected-host' });
    const { api } = await initializeSelection(config);
    const resolved = await api.getHooks().modifyResolvedConfig.call(config);
    expect(resolved.output?.disableInlineRuntimeChunk).toBeUndefined();
    const rsbuild = await createRsbuild({
      cwd: __dirname,
      rsbuildConfig: {
        source: { entry: { main: './react-runtime-owning-host.js' } },
        tools: { htmlPlugin: false },
        plugins: [pluginRuntimeChunk()],
      },
    });
    await rsbuild.initConfigs();
    const inlineScripts = rsbuild.getNormalizedConfig().output.inlineScripts;
    expect(inlineScripts).toBeInstanceOf(RegExp);
    expect(
      inlineScripts instanceof RegExp &&
        inlineScripts.test('builder-runtime.123.js'),
    ).toBe(true);
  });

  it.each([
    { disableInlineRuntimeChunk: false },
    { inlineScripts: true },
    { inlineScripts: /runtime/u },
    { inlineScripts: () => true },
    { inlineScripts: { test: /runtime/u } },
    { disableInlineRuntimeChunk: true, inlineScripts: true },
  ])(
    'rejects an explicit unsupported native inlining request: %j',
    async output => {
      const selectedSetup = rstest.fn();
      const config = await selectHost('solid', {
        name: 'fixture:selected-host',
        setup: selectedSetup,
      });
      await expect(initializeSelection({ ...config, output })).rejects.toThrow(
        'requires external script assets; script inlining is not supported by native documents',
      );
      expect(selectedSetup).not.toHaveBeenCalled();
    },
  );

  it.each([
    { inlineScripts: false },
    { disableInlineRuntimeChunk: true },
    { disableInlineRuntimeChunk: false, inlineScripts: false },
  ] as const)(
    'preserves an explicit supported external-script policy: %j',
    async output => {
      const config = await selectHost('solid', {
        name: 'fixture:selected-host',
      });
      const { api } = await initializeSelection({ ...config, output });
      const resolved = await api
        .getHooks()
        .modifyResolvedConfig.call({ ...config, output });
      expect(resolved.output).toEqual({
        ...output,
        disableInlineRuntimeChunk:
          ('disableInlineRuntimeChunk' in output
            ? output.disableInlineRuntimeChunk
            : undefined) ?? true,
      });
    },
  );

  it('rejects a later environment inlining request before compiler creation', async () => {
    const rsbuild = await createRsbuild({
      cwd: __dirname,
      rsbuildConfig: {
        source: { entry: { main: './native-runtime-owning-host.js' } },
        tools: { htmlPlugin: false },
        output: { inlineScripts: false },
        plugins: [
          nativeRendererIsolationPlugin('solid'),
          {
            name: 'fixture:late-environment-inlining',
            setup(api) {
              api.modifyEnvironmentConfig({
                order: 'post',
                handler(config) {
                  config.output.inlineScripts = true;
                },
              });
            },
          },
        ],
      },
    });
    await expect(rsbuild.initConfigs()).rejects.toThrow(
      'requires external script assets; script inlining is not supported by native documents',
    );
  });
});

async function initializeSelection(config: UltramodernAppUserConfig) {
  const pluginManager = createPluginManager();
  pluginManager.addPlugins(config.plugins ?? []);
  const plugins = pluginManager.getPlugins();
  const context = await createContext({
    appContext: initAppContext({
      packageName: 'renderer-selection-owning-host',
      configFile: false,
      command: 'build',
      appDirectory: __dirname,
      metaName: 'modern-js',
      plugins,
    }),
    config,
    normalizedConfig: config,
  });
  const api = initPluginAPI({ context, pluginManager });
  context.pluginAPI = api;
  for (const plugin of plugins)
    await plugin.setup?.(api as unknown as CLIPluginAPI<AppTools>);
  return { api, context, plugins };
}

async function selectHost(
  renderer: Renderer,
  selected: CliPlugin<AppTools>,
  consumers: CliPlugin<AppTools>[] = [],
  verifyCompilerOwnership = false,
) {
  return resolveUltramodernConfig(
    createDefineConfig((captured, consumerPlugins) => ({
      name: ULTRAMODERN_BASE_PLUGIN,
      usePlugins: [
        selected,
        rendererSelectionGuard(
          captured,
          [selected],
          consumerPlugins,
          verifyCompilerOwnership,
        ),
      ],
    }))({ renderer, plugins: consumers }),
    { env: 'test', command: 'build' },
  );
}

describe('renderer guard in the owning plugin manager', () => {
  it('orders the guard before nested selected plugins and consumer setup', async () => {
    const events: string[] = [];
    const nested = {
      name: 'fixture:selected-nested',
      setup() {
        events.push('selected-nested');
      },
    };
    const selected = {
      name: 'fixture:selected-host',
      usePlugins: [nested],
      setup() {
        events.push('selected');
      },
    };
    const consumer = {
      name: 'fixture:consumer',
      setup() {
        events.push('consumer');
      },
    };
    const config = await selectHost('solid', selected, [consumer]);
    const { plugins } = await initializeSelection(config);
    const names = plugins.map(plugin => plugin.name);
    expect(
      names.indexOf('@modern-js/renderer-selection'),
    ).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('@modern-js/renderer-selection')).toBeLessThan(
      names.indexOf(nested.name),
    );
    expect(names.indexOf('@modern-js/renderer-selection')).toBeLessThan(
      names.indexOf(consumer.name),
    );
    expect(events).toEqual(['selected-nested', 'selected', 'consumer']);
  });

  it.each(['local', 'programmatic'] as const)(
    'rejects a raw %s renderer override before selected setup',
    async override => {
      const selectedSetup = rstest.fn();
      const selected = { name: 'fixture:selected-host', setup: selectedSetup };
      const original = await selectHost('solid', selected);
      const appDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'um-renderer-override-'),
      );
      try {
        fs.writeFileSync(
          path.join(appDirectory, 'package.json'),
          JSON.stringify({ name: 'renderer-override-host' }),
        );
        fs.writeFileSync(
          path.join(appDirectory, 'modern.config.js'),
          "module.exports = { renderer: 'solid' };\n",
        );
        if (override === 'local') {
          fs.writeFileSync(
            path.join(appDirectory, 'modern.config.local.js'),
            "module.exports = { renderer: 'octane' };\n",
          );
        }
        const loaded = await createLoadedConfig<UltramodernAppUserConfig>(
          appDirectory,
          path.join(appDirectory, 'modern.config.js'),
          override === 'programmatic' ? { renderer: 'octane' } : undefined,
          { env: 'development', command: 'dev' },
        );
        const merged = {
          ...original,
          ...loaded.config,
          plugins: original.plugins,
        };
        await expect(initializeSelection(merged)).rejects.toThrow(
          'Renderer changed from solid to octane after plugin selection',
        );
        expect(selectedSetup).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(appDirectory, { recursive: true, force: true });
      }
    },
  );

  it('rejects a late resolved renderer change before any selected output hook', async () => {
    const output = rstest.fn();
    const selected: CliPlugin<AppTools> = {
      name: 'fixture:selected-host',
      setup(api) {
        api.onPrepare(output);
      },
    };
    const consumer: CliPlugin<AppTools> = {
      name: 'fixture:late-consumer',
      setup(api) {
        api.modifyResolvedConfig(config => ({ ...config, renderer: 'octane' }));
      },
    };
    const config = await selectHost('solid', selected, [consumer]);
    const { api, context } = await initializeSelection(config);
    context.normalizedConfig = await api
      .getHooks()
      .modifyResolvedConfig.call(config);
    await expect(api.getHooks().onPrepare.call()).rejects.toThrow(
      'Renderer changed from solid to octane after plugin selection',
    );
    expect(output).not.toHaveBeenCalled();
  });

  it.each(['solid', 'octane'] as const)(
    'prepares compiler-free %s metadata without admitting compiler-free output',
    async renderer => {
      const prepared = rstest.fn();
      const config = await selectHost(
        renderer,
        {
          name: 'fixture:selected-host',
          setup(api) {
            api.onPrepare(prepared);
          },
        },
        [],
        true,
      );
      const { api } = await withEntryMetadataRead(async () => {
        const initialized = await initializeSelection(config);
        await initialized.api.getHooks().onPrepare.call();
        return initialized;
      });
      expect(prepared).toHaveBeenCalledTimes(1);
      await expect(api.getHooks().onPrepare.call()).rejects.toThrow(
        `Renderer ${renderer} requires exactly one matching native compiler owner`,
      );
      expect(prepared).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['solid', 'octane'] as const)(
    'still rejects a late renderer change during %s metadata preparation',
    async renderer => {
      const prepared = rstest.fn();
      const config = await selectHost(
        renderer,
        {
          name: 'fixture:selected-host',
          setup(api) {
            api.onPrepare(prepared);
          },
        },
        [],
        true,
      );
      await withEntryMetadataRead(async () => {
        const { api, context } = await initializeSelection(config);
        context.normalizedConfig = {
          ...config,
          renderer: renderer === 'solid' ? 'octane' : 'solid',
        };
        await expect(api.getHooks().onPrepare.call()).rejects.toThrow(
          `Renderer changed from ${renderer} to ${context.normalizedConfig.renderer} after plugin selection`,
        );
      });
      expect(prepared).not.toHaveBeenCalled();
    },
  );

  it.each([
    { renderer: 'solid', ownership: 'missing' },
    { renderer: 'solid', ownership: 'duplicate' },
    { renderer: 'solid', ownership: 'mismatch' },
    { renderer: 'octane', ownership: 'missing' },
    { renderer: 'octane', ownership: 'duplicate' },
    { renderer: 'octane', ownership: 'mismatch' },
  ] as const)(
    'rejects $ownership compiler ownership before $renderer output',
    async ({ renderer, ownership }) => {
      const output = rstest.fn();
      const config = await selectHost(
        renderer,
        {
          name: 'fixture:selected-host',
          setup(api) {
            api.onPrepare(output);
          },
        },
        [],
        true,
      );
      config.builderPlugins =
        ownership === 'missing'
          ? []
          : ownership === 'duplicate'
            ? [compiler(renderer, 'first'), compiler(renderer, 'second')]
            : [compiler(renderer === 'solid' ? 'octane' : 'solid')];
      const { api } = await initializeSelection(config);
      await expect(api.getHooks().onPrepare.call()).rejects.toThrow(
        `Renderer ${renderer} requires exactly one matching native compiler owner`,
      );
      expect(output).not.toHaveBeenCalled();
    },
  );

  it.each(['solid', 'octane'] as const)(
    'permits selected %s output with exactly one matching compiler owner',
    async renderer => {
      const output = rstest.fn();
      const config = await selectHost(
        renderer,
        {
          name: 'fixture:selected-host',
          setup(api) {
            api.onPrepare(output);
          },
        },
        [],
        true,
      );
      config.builderPlugins = [compiler(renderer)];
      const { api } = await initializeSelection(config);
      await api.getHooks().onPrepare.call();
      expect(output).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['solid', 'octane'] as const)(
    'resolves async nested %s ownership before selected output',
    async renderer => {
      const output = rstest.fn();
      const config = await selectHost(
        renderer,
        {
          name: 'fixture:selected-host',
          setup(api) {
            api.onPrepare(output);
          },
        },
        [],
        true,
      );
      config.builderPlugins = [
        false,
        Promise.resolve([
          undefined,
          [Promise.resolve(compiler(renderer)), null],
        ]),
      ];
      const { api } = await initializeSelection(config);
      await api.getHooks().onPrepare.call();
      expect(output).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['solid', 'octane'] as const)(
    'rejects duplicate async nested %s owners before output',
    async renderer => {
      const output = rstest.fn();
      const config = await selectHost(
        renderer,
        {
          name: 'fixture:selected-host',
          setup(api) {
            api.onPrepare(output);
          },
        },
        [],
        true,
      );
      config.builderPlugins = [
        Promise.resolve(compiler(renderer, 'first')),
        [false, Promise.resolve([compiler(renderer, 'second')])],
      ];
      const { api } = await initializeSelection(config);
      await expect(api.getHooks().onPrepare.call()).rejects.toThrow(
        `Renderer ${renderer} requires exactly one matching native compiler owner`,
      );
      expect(output).not.toHaveBeenCalled();
    },
  );

  it('rejects a second raw base even when the actual manager deduplicates its name', async () => {
    const selectedSetup = rstest.fn();
    const config = await selectHost('octane', {
      name: 'fixture:selected-host',
      setup: selectedSetup,
    });
    const warn = rstest.spyOn(console, 'warn').mockImplementation(() => {});
    config.plugins?.push({ name: ULTRAMODERN_BASE_PLUGIN });
    await expect(initializeSelection(config)).rejects.toThrow(
      'Exactly one UltraModern base composition is required',
    );
    expect(warn).toHaveBeenCalled();
    expect(selectedSetup).not.toHaveBeenCalled();
  });

  it('rejects a missing base before the selected host setup', async () => {
    const selectedSetup = rstest.fn();
    const config = await selectHost('solid', {
      name: 'fixture:selected-host',
      setup: selectedSetup,
    });
    config.plugins = config.plugins?.[0].usePlugins;
    await expect(initializeSelection(config)).rejects.toThrow(
      'Exactly one UltraModern base composition is required',
    );
    expect(selectedSetup).not.toHaveBeenCalled();
  });

  it.each(['solid', 'octane'] as const)(
    'rejects React-only app plugins in %s defineConfig before plugin resolution',
    async renderer => {
      const reactSetup = rstest.fn();
      const consumers: CliPlugin<AppTools>[] = [
        {
          name: '@modern-js/plugin-tanstack',
          required: ['@modern-js/runtime'],
          setup: reactSetup,
        },
        { name: '@modern-js/plugin-i18n', setup: reactSetup },
        {
          name: 'fixture:federation-wrapper',
          usePlugins: [
            { name: '@modern-js/plugin-module-federation', setup: reactSetup },
          ],
        },
        { name: 'fixture:portable', setup() {} },
      ];
      let failure: unknown;
      try {
        await selectHost(
          renderer,
          { name: 'fixture:selected-host', setup() {} },
          consumers,
        );
      } catch (error) {
        failure = error;
      }
      const message = (failure as Error).message;
      expect(message).toContain(
        `unsupported-renderer-plugin: renderer ${renderer} cannot use React-only plugins`,
      );
      expect(message).toContain(
        `@modern-js/plugin-tanstack: remove tanstackRouterPlugin(); the ${renderer} renderer routes src/routes through @modern-js/renderer-${renderer}/router`,
      );
      expect(message).toContain(
        '@modern-js/plugin-i18n: replace it with i18nPlugin() from @modern-js/ultramodern-app-tools',
      );
      expect(message).toContain(
        '@modern-js/plugin-module-federation: remove moduleFederationPlugin()',
      );
      expect(message).toContain("or keep renderer: 'react'");
      expect(message).not.toContain('fixture:portable');
      expect(reactSetup).not.toHaveBeenCalled();
    },
  );

  it('keeps React-only app plugins for the React renderer', async () => {
    const config = await selectHost(
      'react',
      { name: 'fixture:selected-host', setup() {} },
      [{ name: '@modern-js/plugin-tanstack' }],
    );
    expect(config.plugins?.map(plugin => plugin.name)).toEqual([
      ULTRAMODERN_BASE_PLUGIN,
      '@modern-js/plugin-tanstack',
    ]);
  });

  it.each(['solid', 'octane'] as const)(
    'rejects React CLI plugins added after %s selection before host setup',
    async renderer => {
      const selectedSetup = rstest.fn();
      const reactSetup = rstest.fn();
      const config = await selectHost(renderer, {
        name: 'fixture:selected-host',
        setup: selectedSetup,
      });
      config.plugins?.push({
        name: '@modern-js/plugin-ssr',
        setup: reactSetup,
      });
      await expect(initializeSelection(config)).rejects.toThrow(
        `unsupported-renderer-plugin: renderer ${renderer} cannot use React-only plugins`,
      );
      expect(selectedSetup).not.toHaveBeenCalled();
      expect(reactSetup).not.toHaveBeenCalled();
    },
  );

  it.each(['solid', 'octane'] as const)(
    'admits Cloudflare worker SSR before %s host setup',
    async renderer => {
      const selectedSetup = rstest.fn();
      const config = await selectHost(renderer, {
        name: 'fixture:selected-host',
        setup: selectedSetup,
      });
      config.deploy = { target: 'cloudflare', worker: { ssr: true } };
      await initializeSelection(config);
      expect(selectedSetup).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['solid', 'octane'] as const)(
    'rejects RSC config before %s host setup',
    async renderer => {
      const selectedSetup = rstest.fn();
      const config = await selectHost(renderer, {
        name: 'fixture:selected-host',
        setup: selectedSetup,
      });
      config.server = { rsc: true };
      await expect(initializeSelection(config)).rejects.toThrow(
        'unsupported-renderer-capability',
      );
      expect(selectedSetup).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['solid', 'octane'] as const).flatMap(renderer =>
      [
        { capability: 'SSG', supported: { output: { ssg: true } } },
        {
          capability: 'default SVG components',
          supported: { output: { svgDefaultExport: 'component' } },
        },
        {
          capability: 'entry SSG',
          supported: { output: { ssgByEntries: { main: true } } },
        },
      ].map(testCase => ({ renderer, ...testCase })),
    ),
  )(
    'admits $capability for $renderer host setup',
    async ({ renderer, supported }) => {
      const selectedSetup = rstest.fn();
      const config = await selectHost(renderer, {
        name: 'fixture:selected-host',
        setup: selectedSetup,
      });
      Object.assign(config, supported);
      await initializeSelection(config);
      expect(selectedSetup).toHaveBeenCalled();
    },
  );

  it.each(
    (['solid', 'octane'] as const).flatMap(renderer =>
      [
        {
          capability: 'source-adjacent CSS declarations',
          unsupported: { output: { enableCssModuleTSDeclaration: true } },
        },
        {
          capability: 'runtime i18n',
          unsupported: { runtime: { i18n: { locale: 'en' } } },
        },
        {
          capability: 'an unadmitted deployment provider',
          unsupported: { deploy: { target: 'vercel' } },
        },
        {
          capability: 'Cloudflare without its native worker',
          unsupported: { deploy: { target: 'cloudflare' } },
        },
        {
          capability: 'Module Federation',
          unsupported: { moduleFederation: { name: 'fixture' } },
        },
        {
          capability: 'Module Federation SSR',
          unsupported: { server: { ssr: { moduleFederationAppSSR: true } } },
        },
        {
          capability: 'React compiler',
          unsupported: { source: { reactCompiler: true } },
        },
      ].map(testCase => ({ renderer, ...testCase })),
    ),
  )(
    'rejects $capability before $renderer host setup',
    async ({ renderer, unsupported }) => {
      const selectedSetup = rstest.fn();
      const config = await selectHost(renderer, {
        name: 'fixture:selected-host',
        setup: selectedSetup,
      });
      Object.assign(config, unsupported);
      await expect(initializeSelection(config)).rejects.toThrow(
        'unsupported-renderer-capability',
      );
      expect(selectedSetup).not.toHaveBeenCalled();
    },
  );
});
