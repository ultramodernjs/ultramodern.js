import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  type AppNormalizedConfig,
  type AppTools,
  appTools,
  type CliPlugin,
} from '@modern-js/app-tools';
import {
  type RendererBuildIdentities,
  rendererProfileKey,
} from '@modern-js/app-tools-extensions/renderer-build-identity';
import { validateRendererRouterBindings } from '@modern-js/backend-federation-contracts';
import { type CLIPluginAPI, createPluginManager } from '@modern-js/plugin';
import {
  createContext,
  initAppContext,
  initPluginAPI,
} from '@modern-js/plugin/cli';
import type { BffRuntimeBuildIdentityProvider } from '@modern-js/plugin-bff-build-extensions';
import { createServerBase, type ServerEnv } from '@modern-js/server-core';
import type { Entrypoint } from '@modern-js/types';
import {
  createRsbuild,
  type ModifyHTMLTagsFn,
  type RsbuildPlugin,
  type Rspack,
} from '@rsbuild/core';
import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import { tanstackRouterPlugin } from '../../../../runtime/plugin-tanstack/src/cli';
import { withEntryMetadataRead } from '../../src/native-composition/config-read-context';
import {
  RENDERER_BUILD_MANIFEST_FILE,
  RENDERER_DEVELOPMENT_DIRECTORY,
} from '../../src/native-composition/native-build-manifest';
import { createPresetUltramodernConfig } from '../../src/native-composition/preset';
import { createRendererBuildOutputResolver } from '../../src/native-composition/renderer-build-output';
import {
  resolveCandidateRendererProfile,
  resolveRendererProfile,
} from '../../src/native-composition/renderer-profile';
import {
  REACT_RENDERER_IDENTITY_ELEMENT_ID,
  type ReactBuildMetadataOptions,
  reactRendererBuildMetadataPlugin,
} from '../../src/renderers/react/build-metadata';
import reactBuildMetadataServerPlugin, {
  REACT_RENDERER_IDENTITY_HEADER,
} from '../../src/renderers/react/build-metadata-server';
import { composeReactRenderer } from '../../src/renderers/react/composition';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-react-metadata-'));
  fixtureRoots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const name of ['ssr', 'csr', 'dashboard', 'extra', 'unknown'])
    fs.writeFileSync(
      path.join(root, 'src', `${name}.js`),
      'globalThis.selected = 1;\n',
    );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'react-metadata-proof', private: true }),
  );
  return root;
}

function buildIdentities(
  entryNames = ['ssr', 'csr'],
  options: Partial<RendererBuildIdentities> = {},
): RendererBuildIdentities {
  const buildMarker = options.buildId ?? 'a'.repeat(64);
  const identities =
    options.identities ??
    Object.fromEntries(
      entryNames.map(entryName => [
        entryName,
        {
          renderer: 'react' as const,
          appId: 'react-metadata-proof',
          entryName,
          protocolVersion: 1 as const,
          buildId: buildMarker,
        },
      ]),
    );
  const provider = {
    ...resolveRendererProfile('react').router,
    framework: 'react-router' as const,
  };
  return {
    identities,
    buildId: buildMarker,
    profileKey: 'b'.repeat(64),
    sourceRevision: 'workspace',
    ...options,
    routerBindings:
      options.routerBindings ??
      Object.fromEntries(
        Object.keys(identities).map(entryName => [
          entryName,
          {
            owner: '@modern-js/plugin-router',
            evidence: 'owned-default' as const,
            defaultProvider: { ...provider },
            providers: [{ ...provider }] as const,
          },
        ]),
      ),
  };
}

function builtManifest(
  identities: RendererBuildIdentities = buildIdentities(),
  renderer: 'react' | 'solid' = 'react',
) {
  return {
    schema: 'ultramodern-renderer-build',
    version: 2,
    renderer,
    profile: resolveRendererProfile(renderer),
    worker: {
      nativeDocuments: renderer !== 'react',
      rsc: renderer === 'react',
    },
    routerBindings: identities.routerBindings,
    buildId: identities.buildId,
    sourceRevision: identities.sourceRevision,
    entries: identities.identities,
  };
}

async function initializeMetadata(
  root: string,
  options: ReactBuildMetadataOptions,
  command: 'build' | 'dev' = 'build',
  configOverrides: Record<string, unknown> = {},
) {
  const manager = createPluginManager<CLIPluginAPI<AppTools>>();
  manager.addPlugins([
    appTools({ rendererExtensions: false, serverExtensions: false }),
    reactRendererBuildMetadataPlugin(options) as unknown as CliPlugin<AppTools>,
  ]);
  const plugins = manager.getPlugins();
  const config = {
    renderer: 'react',
    source: { entriesDir: './src', mainEntryName: 'ssr' },
    server: { ssr: true, ssrByEntries: { ssr: true, csr: false } },
    output: { cleanDistPath: false },
    ...configOverrides,
  };
  const context = await createContext<AppTools>({
    appContext: initAppContext({
      packageName: 'react-metadata-proof',
      configFile: false,
      command,
      appDirectory: root,
      metaName: 'modern-js',
      plugins,
    }),
    config,
    normalizedConfig: config as unknown as AppNormalizedConfig,
  });
  const api = initPluginAPI({ context, pluginManager: manager });
  context.pluginAPI = api;
  for (const plugin of plugins)
    await plugin.setup?.(api as CLIPluginAPI<AppTools>);
  api.updateAppContext({
    distDirectory: path.join(root, 'dist'),
    internalDirectory: path.join(root, 'internal'),
  });
  return { api, context };
}

function authoredEntries(root: string): Entrypoint[] {
  return ['ssr', 'csr'].map(entryName => ({
    entryName,
    isMainEntry: entryName === 'ssr',
    entry: path.join(root, 'src', entryName, 'App.tsx'),
    internalEntry: path.join(root, 'existing-runtime', `${entryName}.tsx`),
  }));
}

async function analyzeFinalEntries(
  api: Awaited<ReturnType<typeof initializeMetadata>>['api'],
  entrypoints: Entrypoint[],
) {
  const result = await api.getHooks().modifyEntrypoints.call({ entrypoints });
  api.updateAppContext({
    entrypoints: result.entrypoints,
    checkedEntries: result.entrypoints.map(entry => entry.entryName),
  });
  await api.getHooks().generateEntryCode.call(result);
  return result;
}

async function compileMetadata(
  api: Awaited<ReturnType<typeof initializeMetadata>>['api'],
  options: {
    entryNames?: string[];
    /** Builder plugins the merged app config contributes before metadata. */
    configuredPlugins?: RsbuildPlugin[];
    rsbuildConfig?: NonNullable<
      Parameters<typeof createRsbuild>[0]
    >['rsbuildConfig'];
  } = {},
) {
  const root = api.getAppContext().appDirectory;
  const { builderPlugins } = await api.getHooks().modifyResolvedConfig.call({
    ...api.getNormalizedConfig(),
    builderPlugins: [],
  } as AppNormalizedConfig);
  const htmlPaths: Record<string, string> = {};
  let compiler: Rspack.Compiler | Rspack.MultiCompiler | undefined;
  const rsbuild = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      mode: 'production',
      plugins: [
        {
          name: 'test-native-metadata-completion',
          setup(rsbuildApi) {
            rsbuildApi.onAfterCreateCompiler(({ compiler: created }) => {
              compiler = created;
            });
            rsbuildApi.modifyHTMLTags((tags, { environment }) => {
              if (environment.name === 'client')
                Object.assign(htmlPaths, environment.htmlPaths);
              return tags;
            });
            rsbuildApi.onAfterBuild(async ({ stats }) => {
              await api.getHooks().onAfterBuild.call(afterBuildInput(stats));
            });
          },
        },
        ...(options.configuredPlugins ?? []),
        ...(builderPlugins as RsbuildPlugin[]),
      ],
      output: {
        cleanDistPath: false,
        distPath: { root: path.join(root, 'dist') },
      },
      performance: { printFileSize: false },
      environments: {
        client: {
          source: {
            entry: Object.fromEntries(
              (options.entryNames ?? ['ssr', 'csr']).map(name => [
                name,
                path.join(root, 'src', `${name}.js`),
              ]),
            ),
          },
        },
      },
      ...options.rsbuildConfig,
    },
  });
  let result: Awaited<ReturnType<typeof rsbuild.build>> | undefined;
  try {
    result = await rsbuild.build();
    return { htmlPaths, stats: result.stats };
  } finally {
    if (result) await result.close();
    else if (compiler)
      await new Promise<void>((resolve, reject) =>
        compiler!.close(error => (error ? reject(error) : resolve())),
      );
  }
}

async function htmlHook(
  api: Awaited<ReturnType<typeof initializeMetadata>>['api'],
) {
  const { builderPlugins } = await api.getHooks().modifyResolvedConfig.call({
    ...api.getNormalizedConfig(),
    builderPlugins: [],
  } as AppNormalizedConfig);
  const plugin = builderPlugins!.find(
    candidate =>
      (candidate as RsbuildPlugin).name === 'ultramodern:react:build-metadata',
  ) as RsbuildPlugin;
  let hook: ModifyHTMLTagsFn | undefined;
  const rsbuild = await createRsbuild({
    cwd: api.getAppContext().appDirectory,
    rsbuildConfig: {
      mode: 'production',
      source: {
        entry: {
          ssr: path.join(api.getAppContext().appDirectory, 'src/ssr.js'),
        },
      },
      plugins: [
        {
          ...plugin,
          setup(rsbuildApi) {
            return plugin.setup({
              ...rsbuildApi,
              modifyHTMLTags(callback) {
                hook = callback;
                return rsbuildApi.modifyHTMLTags(callback);
              },
            });
          },
        },
      ],
    },
  });
  await rsbuild.initConfigs();
  if (!hook) throw new Error('React metadata HTML hook was not registered');
  return hook;
}

function htmlContext(
  filename: string,
  htmlPaths: Record<string, string>,
  name = 'client',
): Parameters<ModifyHTMLTagsFn>[1] {
  return { filename, environment: { name, htmlPaths } } as never;
}

function afterBuildInput(stats?: Rspack.Stats) {
  return { stats, isFirstCompile: true, isWatch: false, environments: {} };
}

const invalidHtmlOutputs: {
  htmlPaths: Record<string, string>;
  message: string;
}[] = [
  { htmlPaths: {}, message: 'no unambiguous analyzed entry' },
  {
    htmlPaths: { ssr: 'index.html', csr: 'index.html' },
    message: 'no unambiguous analyzed entry',
  },
];

function environmentConfigHook(plugin: RsbuildPlugin, action: 'dev' | 'build') {
  type Handler = (
    config: { tools: { htmlPlugin?: unknown } },
    context: { name: string },
  ) => unknown;
  let handler: Handler | undefined;
  const noop = () => {};
  plugin.setup({
    context: { action },
    modifyEnvironmentConfig(options: { handler: Handler }) {
      handler = options.handler;
    },
    modifyBundlerChain: noop,
    modifyRspackConfig: noop,
    modifyHTMLTags: noop,
  } as never);
  return handler;
}

async function metadataBuilderPlugin(
  api: Awaited<ReturnType<typeof initializeMetadata>>['api'],
) {
  const { builderPlugins } = await api.getHooks().modifyResolvedConfig.call({
    ...api.getNormalizedConfig(),
    builderPlugins: [],
  } as AppNormalizedConfig);
  return builderPlugins!.find(
    candidate =>
      (candidate as RsbuildPlugin).name === 'ultramodern:react:build-metadata',
  ) as RsbuildPlugin;
}

describe('React metadata in the existing CLI build hooks', () => {
  it('keeps the full native React, TanStack, BFF and federation plugin graph acyclic', () => {
    const applicationRequire = createRequire(
      path.resolve(
        __dirname,
        '../../../../../tests/integration/routes-tanstack-mf/mf-host/package.json',
      ),
    );
    const { bffPlugin } = applicationRequire('@modern-js/plugin-bff') as {
      bffPlugin(): CliPlugin<AppTools>;
    };
    const { moduleFederationPlugin } = applicationRequire(
      '@module-federation/modern-js-v3',
    ) as { moduleFederationPlugin(): CliPlugin<AppTools> };
    const consumerPlugins = [
      tanstackRouterPlugin(),
      bffPlugin(),
      moduleFederationPlugin(),
    ];
    const manager = createPluginManager<CLIPluginAPI<AppTools>>();
    manager.addPlugins([
      composeReactRenderer({ consumerPlugins }),
      ...consumerPlugins,
    ]);
    const names = manager.getPlugins().map(plugin => plugin.name);
    expect(names).toEqual(
      expect.arrayContaining([
        '@modern-js/runtime',
        '@modern-js/plugin-router',
        '@modern-js/plugin-tanstack',
        '@modern-js/plugin-analyze',
        '@modern-js/plugin-module-federation-config',
        '@modern-js/renderer-react-build-metadata',
      ]),
    );
    expect(
      names.indexOf('@modern-js/renderer-react-build-metadata'),
    ).toBeLessThan(names.indexOf('@modern-js/plugin-analyze'));
    expect(
      names.indexOf('@modern-js/renderer-react-build-metadata'),
    ).toBeLessThan(names.indexOf('@modern-js/plugin-bff'));
  });

  it('resolves identities once from the analyzed entries and publishes them to HTML, bundles, manifest, BFF and server', async () => {
    const root = createFixture();
    fs.writeFileSync(
      path.join(root, 'src', 'ssr.js'),
      'globalThis.marker = ULTRAMODERN_BUILD_MARKER;\nglobalThis.revision = ULTRAMODERN_SOURCE_REVISION;\n',
    );
    const resolveBuildIdentities = rstest.fn<
      ReactBuildMetadataOptions['resolveBuildIdentities']
    >(async () => buildIdentities());
    const onBuildIdentities =
      rstest.fn<(completed: RendererBuildIdentities) => void>();
    const { api } = await initializeMetadata(root, {
      resolveBuildIdentities,
      onBuildIdentities,
    });
    const resolveBffRuntimeBuildIdentity =
      api.getAppContext().resolveBffRuntimeBuildIdentity;
    if (!resolveBffRuntimeBuildIdentity)
      throw new Error(
        'React BFF runtime identity provider was not registered.',
      );
    const bffCompilation: Parameters<BffRuntimeBuildIdentityProvider>[0] = {
      appDirectory: root,
      apiDirectory: path.join(root, 'api'),
      sourceDirectories: [path.join(root, 'api')],
      distDirectory: api.getAppContext().distDirectory,
      moduleType: 'module',
    };
    await expect(
      resolveBffRuntimeBuildIdentity(bffCompilation),
    ).rejects.toThrow('requires a completed renderer build');

    const entries = authoredEntries(root);
    const result = await analyzeFinalEntries(api, entries);
    expect(result.entrypoints).toEqual(entries);
    expect(resolveBuildIdentities).toHaveBeenCalledTimes(1);
    expect(onBuildIdentities).toHaveBeenCalledWith(buildIdentities());
    const [context] = resolveBuildIdentities.mock.calls[0];
    expect(context).toEqual(
      expect.objectContaining({
        appDirectory: root,
        packageName: 'react-metadata-proof',
        entrypoints: entries,
      }),
    );
    expect(context.entrypoints[0]).not.toBe(entries[0]);
    expect(context.mode).toBeUndefined();
    expect(context.pluginNames).toContain('@modern-js/plugin-analyze');

    const { htmlPaths } = await compileMetadata(api);
    expect(resolveBuildIdentities).toHaveBeenCalledTimes(1);
    const manifestFile = path.join(root, 'dist', RENDERER_BUILD_MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    expect(manifest).toEqual(builtManifest());
    expect(
      fs
        .readdirSync(path.dirname(manifestFile))
        .some(name => name.endsWith('.tmp')),
    ).toBe(false);
    for (const entryName of ['ssr', 'csr']) {
      const html = fs.readFileSync(
        path.join(root, 'dist', htmlPaths[entryName]),
        'utf8',
      );
      expect(html).toContain(JSON.stringify(manifest.entries[entryName]));
    }
    const scripts = fs
      .readdirSync(path.join(root, 'dist', 'static', 'js'))
      .filter(name => name.startsWith('ssr') && name.endsWith('.js'))
      .map(name =>
        fs.readFileSync(path.join(root, 'dist', 'static', 'js', name), 'utf8'),
      )
      .join('\n');
    expect(scripts).toContain(JSON.stringify(manifest.buildId));
    expect(scripts).not.toContain('ULTRAMODERN_BUILD_MARKER');
    expect(scripts).not.toContain('ULTRAMODERN_SOURCE_REVISION');

    const bffRuntimeIdentity =
      await resolveBffRuntimeBuildIdentity(bffCompilation);
    expect(bffRuntimeIdentity).toEqual({
      buildMarker: manifest.buildId,
      sourceRevision: manifest.sourceRevision,
    });
    expect(Object.isFrozen(bffRuntimeIdentity)).toBe(true);
    await expect(
      resolveBffRuntimeBuildIdentity({
        ...bffCompilation,
        appDirectory: path.join(root, 'another-app'),
      }),
    ).rejects.toThrow('requires its owning application compilation');

    const { plugins } = await api
      .getHooks()
      ._internalServerPlugins.call({ plugins: [] });
    const metadata = plugins.find(plugin =>
      plugin.name.endsWith(
        path.join('renderers', 'react', 'build-metadata-server.js'),
      ),
    );
    if (!metadata) throw new Error('React metadata server plugin is missing.');
    const serialized = JSON.parse(JSON.stringify(metadata.options));
    expect(serialized).toEqual({ entries: manifest.entries });
    const server = createServerBase<ServerEnv>({
      pwd: path.join(root, 'dist'),
      routes: [],
      appContext: { appDirectory: root, apiDirectory: '', lambdaDirectory: '' },
      config: {
        html: {},
        output: {},
        source: {},
        tools: {},
        server: { logger: false },
        bff: {},
        dev: {},
        security: {},
      },
    });
    server.addPlugins([
      reactBuildMetadataServerPlugin(serialized),
      {
        name: 'test-existing-react-response',
        setup(serverApi) {
          serverApi.onPrepare(() => {
            serverApi.getServerContext().middlewares.push({
              name: 'test-existing-react-response',
              order: 'post',
              handler(context) {
                context.set('renderRoute', {
                  entryName: 'ssr',
                  urlPath: '/ssr',
                  entryPath: htmlPaths.ssr,
                });
                return new Response('existing React response');
              },
            });
          });
        },
      },
    ]);
    try {
      await server.init();
      const response = await server.request('/ssr');
      expect(
        JSON.parse(response.headers.get(REACT_RENDERER_IDENTITY_HEADER)!),
      ).toEqual(manifest.entries.ssr);
      expect(await response.text()).toBe('existing React response');
    } finally {
      await server.dispose();
    }
  });

  it('replaces the preset release banner so every script names the one UI build marker', async () => {
    const root = createFixture();
    const generationBuildMarker = '3'.repeat(16);
    const preset = createPresetUltramodernConfig({
      deliveryUnit: {
        buildMarker: generationBuildMarker,
        unitId: 'acme/catalog',
        version: '9.8.7',
        workspaceRoot: root,
      },
    });
    const { api } = await initializeMetadata(root, {
      resolveBuildIdentities: async () => buildIdentities(),
    });
    await analyzeFinalEntries(api, authoredEntries(root));
    // Apply the preset as the builder does: its builder plugins and any
    // `tools.rspack`, which Rsbuild runs after every plugin hook.
    await compileMetadata(api, {
      configuredPlugins: (preset.builderPlugins ?? []) as RsbuildPlugin[],
      rsbuildConfig: preset.tools?.rspack
        ? { tools: { rspack: preset.tools.rspack as never } }
        : {},
    });
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(root, 'dist', RENDERER_BUILD_MANIFEST_FILE),
        'utf8',
      ),
    );
    const scriptsDirectory = path.join(root, 'dist', 'static', 'js');
    const scripts = fs
      .readdirSync(scriptsDirectory)
      .filter(name => name.endsWith('.js'))
      .map(name => fs.readFileSync(path.join(scriptsDirectory, name), 'utf8'));
    expect(scripts.length).toBeGreaterThan(0);
    const banner = `${JSON.stringify(manifest.buildId)};${JSON.stringify(manifest.sourceRevision)};`;
    for (const script of scripts) {
      expect(script.startsWith(banner)).toBe(true);
      expect(script).not.toContain(generationBuildMarker);
      expect(script).not.toContain('"9.8.7";');
    }
    // The release metadata projects the same marker the scripts carry.
    const finalized = await createRendererBuildOutputResolver('react')({
      appDirectory: root,
      distDirectory: path.join(root, 'dist'),
      entrypoints: authoredEntries(root),
    });
    expect(finalized.buildMarker).toBe(manifest.buildId);
    expect(finalized.ui.rendererIdentity.buildId).toBe(manifest.buildId);
  });

  it('keeps the first development identity, renders fresh HTML and writes no manifest', async () => {
    const root = createFixture();
    const resolveBuildIdentities = rstest.fn<
      ReactBuildMetadataOptions['resolveBuildIdentities']
    >(async () => buildIdentities());
    const { api } = await initializeMetadata(
      root,
      { resolveBuildIdentities },
      'dev',
    );
    const result = await analyzeFinalEntries(api, authoredEntries(root));
    await api.getHooks().generateEntryCode.call(result);
    expect(resolveBuildIdentities).toHaveBeenCalledTimes(1);
    expect(resolveBuildIdentities.mock.calls[0][0].mode).toBe('development');
    const { plugins } = await api
      .getHooks()
      ._internalServerPlugins.call({ plugins: [] });
    expect(plugins[0].options).toEqual({
      entries: buildIdentities().identities,
    });
    const plugin = await metadataBuilderPlugin(api);
    const devHandler = environmentConfigHook(plugin, 'dev')!;
    expect(
      devHandler({ tools: { htmlPlugin: undefined } }, { name: 'client' }),
    ).toEqual({ tools: { htmlPlugin: [{ cache: false }] } });
    expect(
      devHandler({ tools: { htmlPlugin: false } }, { name: 'client' }),
    ).toBeUndefined();
    expect(
      devHandler({ tools: { htmlPlugin: undefined } }, { name: 'server' }),
    ).toBeUndefined();
    expect(
      fs.existsSync(
        path.join(
          root,
          'dist',
          RENDERER_DEVELOPMENT_DIRECTORY,
          RENDERER_BUILD_MANIFEST_FILE,
        ),
      ),
    ).toBe(false);
  });

  it('leaves production HTML caching to the native builder', async () => {
    const root = createFixture();
    const { api } = await initializeMetadata(root, {
      resolveBuildIdentities: async () => buildIdentities(),
    });
    await analyzeFinalEntries(api, authoredEntries(root));
    expect(
      environmentConfigHook(await metadataBuilderPlugin(api), 'build'),
    ).toBeUndefined();
  });

  it.each(['rename', 'add', 'remove'] as const)(
    'captures final analyzed entries after a late consumer %s hook',
    async change => {
      const root = createFixture();
      const resolveBuildIdentities = rstest.fn<
        ReactBuildMetadataOptions['resolveBuildIdentities']
      >(async ({ entrypoints }) =>
        buildIdentities(entrypoints.map(entry => entry.entryName)),
      );
      const { api } = await initializeMetadata(root, {
        resolveBuildIdentities,
      });
      api.modifyEntrypoints(({ entrypoints }) => ({
        entrypoints:
          change === 'rename'
            ? entrypoints.map(entry =>
                entry.entryName === 'ssr'
                  ? { ...entry, entryName: 'dashboard' }
                  : entry,
              )
            : change === 'add'
              ? [
                  ...entrypoints,
                  { ...entrypoints[0], entryName: 'extra', isMainEntry: false },
                ]
              : entrypoints.filter(entry => entry.entryName !== 'csr'),
      }));
      const result = await api
        .getHooks()
        .modifyEntrypoints.call({ entrypoints: authoredEntries(root) });
      expect(resolveBuildIdentities).not.toHaveBeenCalled();
      const finalNames = result.entrypoints.map(entry => entry.entryName);
      api.updateAppContext({
        entrypoints: result.entrypoints,
        checkedEntries: finalNames,
      });
      await api.getHooks().generateEntryCode.call(result);
      expect(
        resolveBuildIdentities.mock.calls[0][0].entrypoints.map(
          entry => entry.entryName,
        ),
      ).toEqual(finalNames);
      const { htmlPaths } = await compileMetadata(api, {
        entryNames: finalNames,
      });
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(
            api.getAppContext().distDirectory,
            RENDERER_BUILD_MANIFEST_FILE,
          ),
          'utf8',
        ),
      );
      expect(Object.keys(manifest.entries)).toEqual(finalNames);
      for (const entryName of finalNames) {
        const html = fs.readFileSync(
          path.join(root, 'dist', htmlPaths[entryName]),
          'utf8',
        );
        expect(html).toContain(JSON.stringify(manifest.entries[entryName]));
      }
    },
  );

  it('uses exact Rsbuild HTML entry metadata for nested custom-template outputs and escapes inert JSON outside the root', async () => {
    const root = createFixture();
    const initial = buildIdentities();
    const identities = {
      ...initial,
      identities: {
        ...initial.identities,
        ssr: {
          ...initial.identities.ssr,
          appId: '</script><script>alert(1)</script>  ',
        },
      },
    };
    const template = path.join(root, 'template.html');
    fs.writeFileSync(
      template,
      '<!doctype html><html><head></head><body><div id="root">Custom template</div></body></html>',
    );
    const { api } = await initializeMetadata(root, {
      resolveBuildIdentities: async () => identities,
    });
    await analyzeFinalEntries(api, authoredEntries(root));
    const { htmlPaths } = await compileMetadata(api, {
      rsbuildConfig: { html: { template, outputStructure: 'nested' } },
    });
    expect(htmlPaths.ssr).toBe('ssr/index.html');
    const html = fs.readFileSync(
      path.join(root, 'dist', htmlPaths.ssr),
      'utf8',
    );
    const marker = html.match(
      new RegExp(
        `<script(?=[^>]*id="${REACT_RENDERER_IDENTITY_ELEMENT_ID}")(?=[^>]*type="application/json")[^>]*>(.*?)</script>`,
        'su',
      ),
    );
    expect(marker).not.toBeNull();
    expect(html.indexOf(marker![0])).toBeGreaterThan(
      html.indexOf('Custom template</div>'),
    );
    expect(marker![1]).not.toContain('</script>');
    expect(marker![1]).not.toContain(' ');
    expect(marker![1]).not.toContain(' ');
    expect(JSON.parse(marker![1])).toEqual(identities.identities.ssr);
  });

  it.each(invalidHtmlOutputs)(
    'rejects an HTML output with conflicting or absent analyzed identity: $message',
    async ({ htmlPaths, message }) => {
      const root = createFixture();
      const { api } = await initializeMetadata(root, {
        resolveBuildIdentities: async () => buildIdentities(),
      });
      await analyzeFinalEntries(api, authoredEntries(root));
      const modifyHTMLTags = await htmlHook(api);
      expect(() =>
        modifyHTMLTags(
          { headTags: [], bodyTags: [] },
          htmlContext('index.html', htmlPaths),
        ),
      ).toThrow(message);
    },
  );

  it('rejects an existing document marker and leaves non-client HTML untouched', async () => {
    const root = createFixture();
    const { api } = await initializeMetadata(root, {
      resolveBuildIdentities: async () => buildIdentities(),
    });
    await analyzeFinalEntries(api, authoredEntries(root));
    const modifyHTMLTags = await htmlHook(api);
    const tags = {
      headTags: [
        { tag: 'script', attrs: { id: REACT_RENDERER_IDENTITY_ELEMENT_ID } },
      ],
      bodyTags: [],
    };
    expect(() =>
      modifyHTMLTags(tags, htmlContext('index.html', { ssr: 'index.html' })),
    ).toThrow('Duplicate React document renderer identity');
    expect(
      await modifyHTMLTags(tags, htmlContext('index.html', {}, 'worker')),
    ).toBe(tags);
  });

  it.each([
    'missing',
    'profile',
    'identity',
    'solidRouter',
    'octaneRouter',
  ] as const)(
    'rejects invalid saved serve evidence before resolving a server plugin: %s',
    async failure => {
      const root = createFixture();
      const resolveBuildIdentities = rstest.fn(async () => buildIdentities());
      const { api } = await initializeMetadata(root, {
        resolveBuildIdentities,
      });
      api.updateAppContext({ command: 'serve' });
      if (failure !== 'missing') {
        const manifest: ReturnType<typeof builtManifest> = builtManifest(
          buildIdentities(),
          failure === 'profile' ? 'solid' : 'react',
        );
        if (failure === 'identity') {
          manifest.entries = {
            ssr: { ...manifest.entries.ssr, buildId: 'conflicting build' },
          };
          manifest.routerBindings = {
            ssr: manifest.routerBindings!.ssr,
          };
        }
        if (failure === 'solidRouter' || failure === 'octaneRouter') {
          const framework = failure === 'solidRouter' ? 'solid' : 'octane';
          const provider = {
            ...resolveCandidateRendererProfile(framework).router,
            framework,
          };
          manifest.routerBindings = Object.fromEntries(
            Object.keys(manifest.entries).map(entryName => [
              entryName,
              {
                owner: `@modern-js/renderer-${framework}`,
                evidence: 'owned-default' as const,
                defaultProvider: provider,
                providers: [provider] as const,
              },
            ]),
          );
          expect(
            validateRendererRouterBindings(
              manifest.routerBindings,
              Object.keys(manifest.entries),
            ).ok,
          ).toBe(true);
        }
        fs.mkdirSync(api.getAppContext().distDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(
            api.getAppContext().distDirectory,
            RENDERER_BUILD_MANIFEST_FILE,
          ),
          JSON.stringify(manifest),
        );
      }
      await expect(
        api.getHooks()._internalServerPlugins.call({ plugins: [] }),
      ).rejects.toThrow(
        failure === 'missing'
          ? 'build the application first'
          : failure === 'profile'
            ? 'made for the solid renderer, but the configuration selects react; rebuild'
            : failure === 'identity'
              ? 'conflicts with its build'
              : 'must be admitted by the selected router owner',
      );
      expect(resolveBuildIdentities).not.toHaveBeenCalled();
    },
  );

  it('accepts saved mixed React router providers before resolving a server plugin', async () => {
    const root = createFixture();
    const resolved = buildIdentities();
    const tanstack = {
      framework: 'tanstack',
      name: '@tanstack/react-router',
      version: '1.171.37',
      coreName: '@tanstack/router-core',
      coreVersion: '1.171.15',
    };
    const routerBindings = Object.fromEntries(
      Object.entries(resolved.routerBindings!).map(([entryName, binding]) => [
        entryName,
        {
          owner: '@modern-js/plugin-tanstack',
          evidence: 'provider-registry' as const,
          defaultProvider: binding.defaultProvider,
          providers: [binding.defaultProvider, tanstack],
        },
      ]),
    );
    const resolveBuildIdentities = rstest.fn(async () => resolved);
    const { api } = await initializeMetadata(root, { resolveBuildIdentities });
    api.updateAppContext({ command: 'serve' });
    fs.mkdirSync(api.getAppContext().distDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(
        api.getAppContext().distDirectory,
        RENDERER_BUILD_MANIFEST_FILE,
      ),
      JSON.stringify({ ...builtManifest(resolved), routerBindings }),
    );

    const { plugins } = await api
      .getHooks()
      ._internalServerPlugins.call({ plugins: [] });

    expect(plugins).toHaveLength(1);
    expect(plugins[0].options).toEqual({ entries: resolved.identities });
    expect(resolveBuildIdentities).not.toHaveBeenCalled();
  });

  it('retains existing builder plugins and keys the build cache by renderer and profile', async () => {
    const root = createFixture();
    const identities = buildIdentities(['ssr', 'csr'], {
      sourceRevision: 'f'.repeat(40),
    });
    const { api } = await initializeMetadata(root, {
      resolveBuildIdentities: async () => identities,
    });
    const existingPlugin: RsbuildPlugin = {
      name: 'existing-react-plugin',
      setup() {},
    };
    const modified = await api.getHooks().modifyResolvedConfig.call({
      ...api.getNormalizedConfig(),
      builderPlugins: [existingPlugin],
    } as AppNormalizedConfig);
    expect(modified.builderPlugins).toContain(existingPlugin);
    expect(
      modified.builderPlugins!.filter(
        plugin =>
          (plugin as RsbuildPlugin).name === 'ultramodern:react:build-metadata',
      ),
    ).toHaveLength(1);
    await analyzeFinalEntries(api, authoredEntries(root));
    const { environments } = await api
      .getHooks()
      .modifyBuilderEnvironments.call({
        environments: {
          client: {
            source: { entry: { ssr: '/authored/ssr.tsx' } },
            performance: {
              buildCache: {
                cacheDigest: ['existing'],
                cacheDirectory: '/existing/cache',
              },
            },
          },
          server: {
            performance: { buildCache: false },
            output: { target: 'node' },
          },
        },
      });
    expect(environments.client.source?.entry).toEqual({
      ssr: '/authored/ssr.tsx',
    });
    expect(environments.client.performance?.buildCache).toEqual({
      cacheDirectory: '/existing/cache',
      cacheDigest: [
        'existing',
        'react',
        rendererProfileKey(resolveRendererProfile('react')),
      ],
    });
    expect(environments.server.performance?.buildCache).toBe(false);
    expect(environments.server.output?.target).toBe('node');
  });

  it.each(['build', 'dev'] as const)(
    'resolves no persistent Rspack cache for a top-level %s opt-out',
    async command => {
      const root = createFixture();
      const { api } = await initializeMetadata(
        root,
        { resolveBuildIdentities: async () => buildIdentities() },
        command,
        { performance: { buildCache: false } },
      );
      await analyzeFinalEntries(api, authoredEntries(root));
      const { environments } = await api
        .getHooks()
        .modifyBuilderEnvironments.call({
          environments: {
            client: { source: { entry: { ssr: path.join(root, 'a.js') } } },
            server: {
              source: { entry: { ssr: path.join(root, 'a.js') } },
              output: { target: 'node' },
            },
          },
        });
      const rsbuild = await createRsbuild({
        cwd: root,
        rsbuildConfig: {
          mode: command === 'dev' ? 'development' : 'production',
          performance: { buildCache: false },
          environments,
        },
      });
      const rspackConfigs = await rsbuild.initConfigs();
      expect(rspackConfigs).toHaveLength(2);
      for (const config of rspackConfigs)
        expect(config.cache).not.toMatchObject({ type: 'persistent' });
    },
  );

  it.each(['build', 'dev'] as const)(
    'keeps the build cache for a dirty-tree %s',
    async command => {
      const root = createFixture();
      const { api } = await initializeMetadata(
        root,
        { resolveBuildIdentities: async () => buildIdentities() },
        command,
      );
      await analyzeFinalEntries(api, authoredEntries(root));
      const { environments } = await api
        .getHooks()
        .modifyBuilderEnvironments.call({
          environments: { client: {} },
        });
      expect(environments.client.performance?.buildCache).toEqual({
        cacheDigest: [
          'react',
          rendererProfileKey(resolveRendererProfile('react')),
        ],
      });
    },
  );

  it('does no build admission or metadata output for API-only apps', async () => {
    const root = createFixture();
    const resolveBuildIdentities = rstest.fn(async () => buildIdentities());
    const { api } = await initializeMetadata(root, { resolveBuildIdentities });
    api.updateAppContext({ apiOnly: true });
    const entries = authoredEntries(root);
    expect((await analyzeFinalEntries(api, entries)).entrypoints).toEqual(
      entries,
    );
    await api.getHooks().onAfterBuild.call(afterBuildInput());
    expect(resolveBuildIdentities).not.toHaveBeenCalled();
    expect(
      fs.existsSync(
        path.join(
          api.getAppContext().distDirectory,
          RENDERER_BUILD_MANIFEST_FILE,
        ),
      ),
    ).toBe(false);
  });

  it('registers no compilation or HTML metadata work during an entry-metadata read', async () => {
    const root = createFixture();
    const resolveBuildIdentities = rstest.fn(async () => buildIdentities());
    const { api } = await withEntryMetadataRead(() =>
      initializeMetadata(root, { resolveBuildIdentities }),
    );
    await analyzeFinalEntries(api, authoredEntries(root));
    const config = await api.getHooks().modifyResolvedConfig.call({
      ...api.getNormalizedConfig(),
      builderPlugins: [],
    } as AppNormalizedConfig);
    expect(
      config.builderPlugins!.some(
        plugin =>
          (plugin as RsbuildPlugin).name === 'ultramodern:react:build-metadata',
      ),
    ).toBe(false);
    await api.getHooks().onAfterBuild.call(afterBuildInput());
    expect(resolveBuildIdentities).not.toHaveBeenCalled();
  });

  it('rejects HTML for an entry outside the resolved identities', async () => {
    const root = createFixture();
    const { api } = await initializeMetadata(root, {
      resolveBuildIdentities: async () => buildIdentities(),
    });
    await analyzeFinalEntries(api, authoredEntries(root));
    await expect(
      compileMetadata(api, { entryNames: ['unknown'] }),
    ).rejects.toThrow('requires successful compiler stats');
    expect(
      fs.existsSync(path.join(root, 'dist', RENDERER_BUILD_MANIFEST_FILE)),
    ).toBe(false);
  });

  it('rejects a real compiler error without publishing renderer metadata', async () => {
    const root = createFixture();
    fs.writeFileSync(
      path.join(root, 'src', 'ssr.js'),
      'export const broken = ;',
    );
    const { api } = await initializeMetadata(root, {
      resolveBuildIdentities: async () => buildIdentities(),
    });
    await analyzeFinalEntries(api, authoredEntries(root));
    await expect(compileMetadata(api)).rejects.toThrow();
    expect(
      fs.existsSync(path.join(root, 'dist', RENDERER_BUILD_MANIFEST_FILE)),
    ).toBe(false);
  });
});
