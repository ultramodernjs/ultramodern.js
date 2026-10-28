import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AppTools, CliPlugin } from '@modern-js/app-tools';
import type { RendererBuildIdentities } from '@modern-js/app-tools-extensions/renderer-build-identity';
import {
  RENDERER_FEDERATION_METADATA_KEY,
  RENDERER_FEDERATION_SCHEMA,
  RENDERER_FEDERATION_SCHEMA_VERSION,
  type RendererFederationCompatibility,
} from '@modern-js/federation-runtime/renderer-contract';
import { type CLIPluginAPI, createPluginManager } from '@modern-js/plugin';
import {
  createRsbuild,
  type RsbuildPlugin,
  type Rspack,
  type RspackChain,
  rspack,
} from '@rsbuild/core';
import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import { createRendererModuleFederationIntegration } from '../../src/native-composition/module-federation-renderer-plugin';
import { resolveReactFederationCompatibility } from '../../src/renderers/react/module-federation';

type ChainModifier = Parameters<
  CLIPluginAPI<AppTools>['modifyBundlerChain']
>[0];
type NativeConfig = Record<string, unknown> & {
  runtimePlugins?: unknown[];
  manifest?:
    | boolean
    | {
        additionalData?: (input: {
          stats: NativeStats;
          compilation: object;
        }) => NativeStats | void | Promise<NativeStats | void>;
        [key: string]: unknown;
      };
};
type NativeStats = {
  metaData: Record<string, unknown>;
  [key: string]: unknown;
};

const applicationRequire = createRequire(
  path.resolve(
    __dirname,
    '../../../../../tests/integration/routes-tanstack-mf/mf-remote/package.json',
  ),
);
const native = applicationRequire('@module-federation/modern-js-v3') as {
  moduleFederationPlugin(options: Record<string, unknown>): CliPlugin<AppTools>;
};
const nativeRequire = createRequire(
  applicationRequire.resolve('@module-federation/modern-js-v3/ssr-plugin'),
);
const nativeConstructors = nativeRequire('@module-federation/enhanced/rspack');
const runtimePlugin = '/owned/renderer-runtime-plugin.js';
const roots: string[] = [];
const compilers: Rspack.Compiler[] = [];
const priorSSREnvironment = process.env.MF_SSR_PRJ;
const compatibility: RendererFederationCompatibility = {
  profile: {
    renderer: 'react',
    protocolVersion: 1,
    compiler: { name: '@rsbuild/plugin-react', version: '2.1.1' },
    hydration: { name: 'react-dom', version: '19.3.0' },
    router: {
      name: 'react-router',
      version: '7.18.4',
      coreName: 'react-router',
      coreVersion: '7.18.4',
    },
  },
  runtime: { name: 'react', version: '19.3.0' },
  bootstrap: { name: '@modern-js/runtime', version: '3.9.0' },
};

afterEach(async () => {
  for (const compiler of compilers.splice(0))
    await new Promise<void>((resolve, reject) =>
      compiler.close(error => (error ? reject(error) : resolve())),
    );
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  if (priorSSREnvironment === undefined) delete process.env.MF_SSR_PRJ;
  else process.env.MF_SSR_PRJ = priorSSREnvironment;
});

function completedIdentities(): RendererBuildIdentities {
  const buildMarker = 'a'.repeat(64);
  return {
    identities: {
      main: {
        renderer: 'react',
        protocolVersion: 1,
        appId: 'native-remote',
        entryName: 'main',
        buildId: buildMarker,
      },
    },
    buildId: buildMarker,
    profileKey: 'c'.repeat(64),
    sourceRevision: 'workspace',
    routerBindings: {
      main: {
        owner: '@modern-js/plugin-router',
        evidence: 'owned-default',
        defaultProvider: {
          ...compatibility.profile.router,
          framework: 'react-router',
        },
        providers: [
          { ...compatibility.profile.router, framework: 'react-router' },
        ],
      },
    },
  };
}

async function integration(selectedCompatibility = compatibility) {
  const result = createRendererModuleFederationIntegration('react', {
    resolveCompatibility: () => selectedCompatibility,
    resolveRuntimePlugin: () => runtimePlugin,
  });
  let modifier: ChainModifier | undefined;
  await result.plugin.setup?.({
    modifyBundlerChain: (callback: ChainModifier) => {
      modifier = callback;
    },
  } as unknown as CLIPluginAPI<AppTools>);
  if (!modifier) throw new Error('Renderer MF bundler hook was not registered');
  return { ...result, modifier };
}

async function nativeModifiers(
  secondary: boolean,
  shared: Record<string, unknown> = {},
) {
  const manager = createPluginManager<CLIPluginAPI<AppTools>>();
  manager.addPlugins([
    native.moduleFederationPlugin({
      config: {
        name: 'native-remote',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared,
        runtimePlugins: ['/consumer/runtime.js'],
        dts: false,
        dev: false,
      },
      ssr: true,
      secondarySharedTreeShaking: secondary,
    }),
  ]);
  const modifiers: ChainModifier[] = [];
  const api = {
    getConfig: () => ({
      server: { ssr: true },
      source: { enableAsyncEntry: true },
    }),
    modifyBundlerChain: (callback: ChainModifier) => modifiers.push(callback),
    _internalRuntimePlugins: rstest.fn(),
    _internalServerPlugins: rstest.fn(),
    config: rstest.fn(),
    onAfterBuild: rstest.fn(),
    onDevCompileDone: rstest.fn(),
  } as unknown as CLIPluginAPI<AppTools>;
  for (const plugin of manager.getPlugins()) await plugin.setup?.(api);
  return modifiers;
}

function nativeOptions(
  chain: RspackChain,
  target: 'web' | 'node',
): NativeConfig {
  const key =
    target === 'web'
      ? 'plugin-module-federation'
      : 'plugin-module-federation-server';
  const args = chain.plugin(key).get('args');
  return (args[0].mfConfig ?? args[0]) as NativeConfig;
}

async function actualChain(
  target: 'web' | 'node',
  modifiers: readonly ChainModifier[],
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-mf-renderer-contract-'),
  );
  roots.push(root);
  const entry = path.join(root, 'entry.js');
  fs.writeFileSync(entry, 'export const fixture = true;');
  let chain: RspackChain | undefined;
  const bridge: RsbuildPlugin = {
    name: 'test:actual-native-renderer-mf-chain',
    setup(api) {
      api.modifyBundlerChain(async (current, utils) => {
        for (const modifier of modifiers)
          await modifier(current, utils as never);
        chain = current;
      });
    },
  };
  const rsbuild = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      mode: 'production',
      source: { entry: { main: entry } },
      output: { target, distPath: { root: path.join(root, 'output') } },
      html: { htmlPlugin: false },
      plugins: [bridge],
    },
  });
  const configs = await rsbuild.initConfigs();
  if (!chain) throw new Error('Rsbuild did not supply its native Rspack chain');
  return { root, chain, configs };
}

function publicationCompiler(result: Awaited<ReturnType<typeof actualChain>>) {
  const publicationConstructor = result.chain
    .plugin('ultramodern-mf-renderer-publication')
    .get('plugin');
  const publication = result.configs[0].plugins!.find(
    plugin => plugin?.constructor === publicationConstructor,
  );
  if (!publication)
    throw new Error('Native publication plugin was not emitted');
  // Use the native hook implementation, without starting a compiler or replacing MF.
  const compiler = rspack({
    context: result.root,
    mode: 'production',
    entry: {},
    plugins: [publication],
  });
  compilers.push(compiler);
  return compiler;
}

/** A compilation that emits the named native MF publication assets. */
function publishing(...names: string[]): Rspack.Compilation {
  const published = names.length
    ? names
    : ['mf-manifest.json', 'mf-stats.json'];
  return {
    assets: Object.fromEntries(published.map(name => [name, {}])),
  } as unknown as Rspack.Compilation;
}

describe('renderer authority at the actual native MF publication boundary', () => {
  it.each(['web', 'node'] as const)(
    'publishes canonical Redact singletons and runtime identity in final %s MF options',
    async target => {
      const runtime = resolveReactFederationCompatibility();
      const selected = await integration(runtime);
      const result = await actualChain(target, [
        ...(await nativeModifiers(false)),
        selected.modifier,
      ]);
      const config = nativeOptions(result.chain, target);
      expect(config.runtimePlugins?.[0]).toEqual([runtimePlugin, runtime]);
      expect(config.shared).toMatchObject({
        react: {
          shareKey: '@tanstack/redact',
          version: '0.2.1',
          requiredVersion: '0.2.1',
          strictVersion: true,
          singleton: true,
        },
        'react-dom/client': {
          shareKey: '@tanstack/redact/dom-client',
          version: '0.2.1',
          requiredVersion: '0.2.1',
          strictVersion: true,
          singleton: true,
        },
        'react/jsx-runtime': {
          shareKey: '@tanstack/redact/jsx-runtime',
          version: '0.2.1',
          singleton: true,
        },
        '@tanstack/redact': {
          shareKey: '@tanstack/redact',
          version: '0.2.1',
          singleton: true,
        },
      });
    },
  );

  it('rejects an incompatible runtime share key during real builder initialization', async () => {
    const selected = await integration(resolveReactFederationCompatibility());
    await expect(
      actualChain('web', [
        ...(await nativeModifiers(false, {
          react: { shareKey: 'foreign-react' },
        })),
        selected.modifier,
      ]),
    ).rejects.toThrow('React and Redact containers cannot mix');
  });

  it.each([
    { target: 'web' as const, secondary: false },
    { target: 'web' as const, secondary: true },
    { target: 'node' as const, secondary: false },
    { target: 'node' as const, secondary: true },
  ])(
    'stamps finalized identities and registers the guard on $target with secondary=$secondary',
    async ({ target, secondary }) => {
      const selected = await integration();
      const completed = completedIdentities();
      const result = await actualChain(target, [
        ...(await nativeModifiers(secondary)),
        selected.modifier,
      ]);
      const nativeKey =
        target === 'web'
          ? 'plugin-module-federation'
          : 'plugin-module-federation-server';
      expect(result.chain.plugin(nativeKey).get('plugin')).toBe(
        secondary
          ? nativeConstructors.TreeShakingSharedPlugin
          : nativeConstructors.ModuleFederationPlugin,
      );
      const config = nativeOptions(result.chain, target);
      expect(config.runtimePlugins?.[0]).toEqual([
        runtimePlugin,
        compatibility,
      ]);
      expect(config.runtimePlugins).toContain('/consumer/runtime.js');
      expect(config.shared).toEqual(
        Object.fromEntries(
          [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
          ].map(request => [
            request,
            {
              version: compatibility.runtime.version,
              requiredVersion: compatibility.runtime.version,
              strictVersion: true,
              singleton: true,
              treeShaking: false,
            },
          ]),
        ),
      );
      const compiler = publicationCompiler(result);
      const compilation = publishing();
      const stats: NativeStats = { metaData: { name: 'native-remote' } };
      const manifest = config.manifest as Exclude<
        NativeConfig['manifest'],
        boolean
      >;
      expect(await manifest!.additionalData!({ stats, compilation })).toBe(
        stats,
      );
      expect(stats.metaData).not.toHaveProperty(
        RENDERER_FEDERATION_METADATA_KEY,
      );
      await expect(compiler.hooks.emit.promise(compilation)).rejects.toThrow(
        'lacks finalized renderer authority',
      );
      selected.controller.onBuildIdentities(completed);
      expect(await manifest!.additionalData!({ stats, compilation })).toBe(
        stats,
      );
      expect(stats.metaData[RENDERER_FEDERATION_METADATA_KEY]).toEqual({
        schema: RENDERER_FEDERATION_SCHEMA,
        schemaVersion: RENDERER_FEDERATION_SCHEMA_VERSION,
        ...compatibility,
        identities: completed.identities,
      });
      await expect(
        compiler.hooks.emit.promise(compilation),
      ).resolves.toBeUndefined();
      await expect(compiler.hooks.emit.promise(publishing())).rejects.toThrow(
        'lacks finalized renderer authority',
      );
    },
  );

  it.each([false, true])(
    'owns separate browser and worker snapshots with secondary=%s',
    async secondary => {
      const selected = await integration();
      selected.controller.onBuildIdentities(completedIdentities());
      const inputs: NativeConfig[] = [];
      const modifiers = [
        ...(await nativeModifiers(secondary)),
        (chain: RspackChain) => {
          inputs.push(nativeOptions(chain, 'web'));
        },
        selected.modifier,
      ];
      const browser = await actualChain('web', modifiers);
      const worker = await actualChain('web', modifiers);
      const browserConfig = nativeOptions(browser.chain, 'web');
      const workerConfig = nativeOptions(worker.chain, 'web');
      expect(inputs[1]).toBe(inputs[0]);
      expect(inputs[0].runtimePlugins).not.toContainEqual([
        runtimePlugin,
        compatibility,
      ]);
      expect(workerConfig).not.toBe(browserConfig);
      expect(workerConfig.manifest).not.toBe(browserConfig.manifest);
      for (const result of [browser, worker]) {
        const config = nativeOptions(result.chain, 'web');
        expect(config.runtimePlugins).toEqual([
          [runtimePlugin, compatibility],
          ...inputs[0].runtimePlugins!,
        ]);
        const manifest = config.manifest as Exclude<
          NativeConfig['manifest'],
          boolean
        >;
        const compilation = publishing();
        const stats: NativeStats = { metaData: { name: 'native-remote' } };
        await manifest!.additionalData!({ stats, compilation });
        expect(stats.metaData[RENDERER_FEDERATION_METADATA_KEY]).toMatchObject({
          ...compatibility,
          identities: completedIdentities().identities,
        });
        await expect(
          publicationCompiler(result).hooks.emit.promise(compilation),
        ).resolves.toBeUndefined();
      }
    },
  );

  it.each(['web', 'node'] as const)(
    'awaits prior additionalData and stamps its replacement on %s',
    async target => {
      const selected = await integration();
      selected.controller.onBuildIdentities(completedIdentities());
      const replacement: NativeStats = {
        metaData: { callerOwned: true },
        preserved: 123,
      };
      let release: ((value: NativeStats) => void) | undefined;
      const previous = rstest.fn(
        async () =>
          new Promise<NativeStats>(resolve => {
            release = resolve;
          }),
      );
      const result = await actualChain(target, [
        ...(await nativeModifiers(false)),
        chain => {
          nativeOptions(chain, target).manifest = {
            fileName: 'custom-manifest.json',
            disableAssetsAnalyze: true,
            additionalData: previous,
          };
        },
        selected.modifier,
      ]);
      const config = nativeOptions(result.chain, target);
      const manifest = config.manifest as Exclude<
        NativeConfig['manifest'],
        boolean
      >;
      expect(manifest).toMatchObject({
        fileName: 'custom-manifest.json',
        disableAssetsAnalyze: true,
      });
      const compiler = publicationCompiler(result);
      const input = {
        stats: { metaData: { original: true } },
        compilation: publishing('custom-manifest.json'),
      };
      const pending = manifest!.additionalData!(input);
      expect(replacement.metaData).not.toHaveProperty(
        RENDERER_FEDERATION_METADATA_KEY,
      );
      await expect(
        compiler.hooks.emit.promise(input.compilation),
      ).rejects.toThrow('lacks finalized renderer authority');
      if (!release)
        throw new Error('Prior native additionalData was not called');
      release(replacement);
      expect(await pending).toBe(replacement);
      expect(previous).toHaveBeenCalledTimes(1);
      expect(previous).toHaveBeenCalledWith(input);
      expect(input.stats.metaData).toEqual({ original: true });
      expect(replacement).toMatchObject({
        metaData: { callerOwned: true },
        preserved: 123,
      });
      expect(replacement.metaData).toHaveProperty(
        RENDERER_FEDERATION_METADATA_KEY,
      );
      await expect(
        compiler.hooks.emit.promise(input.compilation),
      ).resolves.toBeUndefined();
    },
  );

  it.each(['web', 'node'] as const)(
    'gates only compilations that publish the native manifest on %s',
    async target => {
      const selected = await integration();
      const result = await actualChain(target, [
        ...(await nativeModifiers(false)),
        chain => {
          nativeOptions(chain, target).manifest = {
            filePath: 'static',
            fileName: 'remote-manifest',
          };
        },
        selected.modifier,
      ]);
      const compiler = publicationCompiler(result);
      // A sibling environment (the Cloudflare workerSSR bundle) carries the
      // native plugin but emits no manifest, so there is nothing to stamp.
      await expect(
        compiler.hooks.emit.promise(
          publishing('routes-manifest.json', 'mf-manifest.json'),
        ),
      ).resolves.toBeUndefined();
      for (const published of [
        'static/remote-manifest.json',
        'static/remote-manifest-stats.json',
      ])
        await expect(
          compiler.hooks.emit.promise(publishing(published)),
        ).rejects.toThrow('lacks finalized renderer authority');
    },
  );

  it('rejects metadata owned by another publisher before accepting its compilation', async () => {
    const selected = await integration();
    selected.controller.onBuildIdentities(completedIdentities());
    const result = await actualChain('web', [
      ...(await nativeModifiers(false)),
      selected.modifier,
    ]);
    const config = nativeOptions(result.chain, 'web');
    const manifest = config.manifest as Exclude<
      NativeConfig['manifest'],
      boolean
    >;
    const compilation = publishing();
    const owned = { from: 'another-publisher' };
    const stats: NativeStats = {
      metaData: { [RENDERER_FEDERATION_METADATA_KEY]: owned },
    };
    await expect(
      manifest!.additionalData!({ stats, compilation }),
    ).rejects.toThrow('duplicate ownership');
    expect(stats.metaData[RENDERER_FEDERATION_METADATA_KEY]).toBe(owned);
    await expect(
      publicationCompiler(result).hooks.emit.promise(compilation),
    ).rejects.toThrow('lacks finalized renderer authority');
  });

  it.each([
    {
      label: 'disabled manifest',
      config: { manifest: false },
      error: 'require native manifest publication',
    },
    {
      label: 'duplicate string guard',
      config: { runtimePlugins: [runtimePlugin] },
      error: 'duplicate registration ownership',
    },
    {
      label: 'duplicate guard tuple',
      config: { runtimePlugins: [[runtimePlugin, {}]] },
      error: 'duplicate registration ownership',
    },
  ])('rejects $label in actual native options', async ({ config, error }) => {
    const selected = await integration();
    await expect(
      actualChain('node', [
        ...(await nativeModifiers(true)),
        chain => {
          Object.assign(nativeOptions(chain, 'node'), config);
        },
        selected.modifier,
      ]),
    ).rejects.toThrow(error);
  });

  it.each(['web', 'node'] as const)(
    'keeps optional dependencies lazy without native MF on %s',
    async target => {
      const resolveCompatibility = rstest.fn(() => {
        throw new Error('Optional renderer tuple accessed');
      });
      const resolveRuntimePlugin = rstest.fn(() => {
        throw new Error('Optional MF runtime accessed');
      });
      const selected = createRendererModuleFederationIntegration('react', {
        resolveCompatibility,
        resolveRuntimePlugin,
      });
      let modifier: ChainModifier | undefined;
      await selected.plugin.setup?.({
        modifyBundlerChain: (callback: ChainModifier) => {
          modifier = callback;
        },
      } as unknown as CLIPluginAPI<AppTools>);
      const result = await actualChain(target, [modifier!]);
      expect(
        result.chain.plugins.has('ultramodern-mf-renderer-publication'),
      ).toBe(false);
      expect(resolveCompatibility).not.toHaveBeenCalled();
      expect(resolveRuntimePlugin).not.toHaveBeenCalled();
    },
  );
});
