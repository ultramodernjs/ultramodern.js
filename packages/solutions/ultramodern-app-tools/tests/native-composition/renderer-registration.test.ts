import fs from 'node:fs';
import * as actualModule from 'node:module' with { rstest: 'importActual' };
import os from 'node:os';
import path from 'node:path';
import type { AppTools, CliPlugin } from '@modern-js/app-tools/cli-config';
import { createPluginManager } from '@modern-js/plugin';
import {
  createContext,
  initAppContext,
  initPluginAPI,
} from '@modern-js/plugin/cli';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import type { NativeRequestContext } from '@modern-js/renderer-core/server';
import { fileReader } from '@modern-js/runtime-utils/fileReader';
import type { Entrypoint } from '@modern-js/types/cli/base';
import { describe, expect, it, rstest } from '@rstest/core';
import {
  createServerBase,
  injectRenderHandlerPlugin,
  type Render,
  type RenderOptions,
  type ServerPlugin,
} from '../../../../server/core/src';
import { resolveUltramodernConfig } from '../../src/native-composition/config';
import { defineConfig } from '../../src/native-composition/index';
import { RENDERER_BUILD_MANIFEST_FILE } from '../../src/native-composition/native-build-manifest';
import { createNativeEntryGenerator } from '../../src/native-composition/native-entry';
import {
  type NativeNodeBindings,
  type NativeServerPluginOptions,
  nativeServerPlugin,
} from '../../src/native-composition/native-server-plugin';
import { resolveCandidateRendererProfile } from '../../src/native-composition/renderer-profile';
import {
  nativeInfrastructurePluginName,
  type RegisteredRenderer,
  registeredRenderers,
  resolveNativeRendererAdapter,
  resolveRendererAdapter,
} from '../../src/native-composition/renderer-registration';
import { resolveEntrypointRouterBindings } from '../../src/native-composition/renderer-router-resolution';
import {
  assertCapturedRenderer,
  assertRendererCompilerOwnership,
  resolveRendererBuilderPlugins,
} from '../../src/native-composition/renderer-selection';
import type { UltramodernAppUserConfig } from '../../src/native-composition/types';
import { createFourthAdapter } from './fourth-renderer-adapter';

// Replace the Solid package's adapter with a different native renderer. Every
// boundary below must follow the adapter's data rather than Solid's own.
let fourthAdapter: ReturnType<typeof createFourthAdapter> | undefined;
rstest.mock('node:module', () => {
  const createRequire: typeof actualModule.createRequire = anchor => {
    const require = actualModule.createRequire(anchor);
    return Object.assign(
      (id: string) =>
        id === '@modern-js/renderer-solid/plugin'
          ? { rendererAdapter: (fourthAdapter ??= createFourthAdapter()) }
          : id === '@modern-js/renderer-solid/manifest'
            ? {
                compilerArtifacts: (fourthAdapter ??= createFourthAdapter())
                  .artifacts,
              }
            : require(id),
      require,
    ) as NodeJS.Require;
  };
  return {
    ...actualModule,
    createRequire,
    default: { ...actualModule, createRequire },
  };
});

const renderer: RegisteredRenderer = 'solid';
const infrastructurePluginName = nativeInfrastructurePluginName(renderer);

describe('static renderer owner admission', () => {
  it('records the fourth router adapter owner and rejects a manufactured plugin name', async () => {
    const adapter = resolveNativeRendererAdapter(renderer);
    const entrypoints: Entrypoint[] = [
      {
        entryName: 'main',
        entry: '/fixture/src/App.tsx',
        isMainEntry: true,
      },
    ];
    const metadata = { profile: adapter.profile, frameworkPackages: [] };
    const bindings = await resolveEntrypointRouterBindings(
      renderer,
      entrypoints,
      [infrastructurePluginName],
      metadata,
    );
    expect(bindings.main.owner).toBe(infrastructurePluginName);
    expect(bindings.main.defaultProvider.framework).toBe('fourth-router');
    expect(bindings.main.providers[0].framework).toBe('fourth-router');
    await expect(
      resolveEntrypointRouterBindings(
        renderer,
        entrypoints,
        ['@fixture/fourth-native-infrastructure'],
        metadata,
      ),
    ).rejects.toThrow('The solid entry router owner is not registered');
  });

  it('selects the replacement owner through config, profile, entry and route boundaries', async () => {
    const config = await resolveUltramodernConfig(defineConfig({ renderer }), {
      env: 'test',
      command: 'build',
    });
    const adapter = resolveNativeRendererAdapter(renderer);
    expect(config.renderer).toBe(renderer);
    const selectedPlugins = config.plugins![0].usePlugins!;
    const stamp = selectedPlugins.find(
      plugin => plugin.name === '@modern-js/renderer-build-artifact-stamp',
    )!;
    expect(
      selectedPlugins.some(plugin => plugin.name === infrastructurePluginName),
    ).toBe(true);
    expect(stamp.pre).toEqual([infrastructurePluginName]);
    expect(stamp.required).toEqual([infrastructurePluginName]);
    expect(registeredRenderers).toContain(renderer);
    expect(resolveCandidateRendererProfile(renderer)).toEqual(adapter.profile);
    expect(adapter.profile.compiler.name).toBe('fourth-compiler');
    // Generated entries import the adapter's own runtime entry modules.
    const generator = createNativeEntryGenerator(renderer);
    expect(Object.keys(generator)).toEqual(['client', 'server', 'worker']);
  });

  it('compiles through the selected adapter and claims its compiler once', async () => {
    const config = await resolveUltramodernConfig(defineConfig({ renderer }), {
      env: 'test',
      command: 'build',
    });
    let transform:
      | ((
          config: UltramodernAppUserConfig,
        ) => Promise<UltramodernAppUserConfig>)
      | undefined;
    const base = config.plugins![0];
    await base.setup?.({
      modifyResolvedConfig(callback: typeof transform) {
        transform = callback;
      },
      _internalRuntimePlugins() {},
    } as unknown as Parameters<NonNullable<CliPlugin<AppTools>['setup']>>[0]);
    const selected = await transform!(config);
    const owned = await resolveRendererBuilderPlugins(
      selected.builderPlugins ?? [],
    );
    expect(assertRendererCompilerOwnership(renderer, owned)).toMatchObject({
      renderer,
      sourceExtensions: ['.tsx', '.ts'],
      svg: 'url',
    });
    expect(owned.map(plugin => plugin.name)).toContain(
      'fixture:fourth:compiler',
    );
    expect(() => assertRendererCompilerOwnership(renderer, [])).toThrow(
      'exactly one matching native compiler owner',
    );
    expect(() =>
      assertRendererCompilerOwnership(renderer, [
        ...owned,
        owned.find(plugin => plugin.name === 'fixture:fourth:compiler')!,
      ]),
    ).toThrow('exactly one matching native compiler owner');
  });

  it('consumes the registered fourth artifact owner from a production CLI server descriptor', async () => {
    const root = fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'um-fourth-server-'),
    );
    let runtime: ReturnType<typeof createServerBase> | undefined;
    const files = rstest
      .spyOn(fileReader, 'readFile')
      .mockImplementation(async filename => {
        try {
          if (!fs.statSync(filename).isFile()) return null;
          return fs.readFileSync(filename, 'utf8');
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          )
            return null;
          throw error;
        }
      });
    try {
      const sdkRoot = path.resolve(import.meta.dirname, '../..');
      const sdkName = JSON.parse(
        fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'),
      ).name as string;
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fourth-server-fixture',
          version: '1.0.0',
          dependencies: { [sdkName]: 'workspace:*' },
        }),
      );
      const sdkSlot = path.join(root, 'node_modules', sdkName);
      fs.mkdirSync(path.dirname(sdkSlot), { recursive: true });
      fs.symlinkSync(sdkRoot, sdkSlot, 'dir');
      const config = await resolveUltramodernConfig(
        defineConfig({ renderer }),
        { env: 'production', command: 'serve' },
      );
      const infrastructure = config.plugins![0].usePlugins!.find(
        plugin => plugin.name === infrastructurePluginName,
      )!;
      const identity: RendererIdentity = {
        renderer,
        appId: 'fourth-server-fixture',
        entryName: 'main',
        protocolVersion: 1,
        buildId: 'a'.repeat(64),
      };
      const entrypoints: Entrypoint[] = [
        {
          entryName: 'main',
          entry: path.join(root, 'src/App.tsx'),
          isMainEntry: true,
        },
      ];
      const routerBindings = await resolveEntrypointRouterBindings(
        renderer,
        entrypoints,
        [infrastructurePluginName],
      );
      const distDirectory = path.join(root, 'dist');
      fs.mkdirSync(distDirectory);
      fs.writeFileSync(
        path.join(distDirectory, RENDERER_BUILD_MANIFEST_FILE),
        JSON.stringify({
          schema: 'ultramodern-renderer-build',
          version: 2,
          renderer,
          profile: resolveCandidateRendererProfile(renderer),
          worker: { nativeDocuments: true, rsc: false },
          entries: { main: identity },
          routerBindings,
          buildId: identity.buildId,
          sourceRevision: 'workspace',
        }),
      );
      const manager = createPluginManager();
      manager.addPlugins([infrastructure]);
      const context = await createContext({
        appContext: initAppContext({
          packageName: 'fourth-server-fixture',
          configFile: false,
          command: 'serve',
          appDirectory: root,
          metaName: 'modern-js',
          plugins: manager.getPlugins(),
        }),
        config,
        normalizedConfig: config,
      });
      const api = initPluginAPI({ context, pluginManager: manager });
      context.pluginAPI = api;
      api.updateAppContext({ distDirectory, entrypoints });
      await infrastructure.setup?.(
        api as unknown as Parameters<
          NonNullable<CliPlugin<AppTools>['setup']>
        >[0],
      );
      const emitted = await api
        .getHooks()
        ._internalServerPlugins.call({ plugins: [] });
      const descriptor = emitted.plugins[0];
      expect(descriptor.name).toBe(`${sdkName}/native-server-plugin`);
      const options = descriptor.options as NativeServerPluginOptions;
      expect(options.renderer).toBe(renderer);
      expect(Object.hasOwn(options, 'compilerArtifacts')).toBe(false);
      // The server loads the runtime manifest module, never the adapter.
      const { manifest } = resolveNativeRendererAdapter(renderer).runtime;
      expect(options.manifestModule).toBe(manifest);
      expect(descriptor.includeEntries).toEqual([manifest]);
      expect(options.nativeManifestFiles).toEqual({
        main: 'compiled-artifacts/main.replacement.json',
      });
      const manifestFile = path.join(
        distDirectory,
        options.nativeManifestFiles!.main,
      );
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({
          abi: 'replacement-compiler/v1',
          build: { identity, hydrationBuildId: 'fourth-hydration' },
        }),
      );
      fs.writeFileSync(
        path.join(distDirectory, 'renderer-assets.json'),
        JSON.stringify({
          schema: 'ultramodern-renderer-assets',
          version: 1,
          renderer,
          entries: {
            main: {
              rendererIdentity: identity,
              assets: [
                { kind: 'script', href: '/assets/main.js', type: 'module' },
              ],
            },
          },
        }),
      );
      let render: Render | undefined;
      const capture: ServerPlugin = {
        name: 'fourth-server-capture',
        pre: [
          '@modern-js/native-node-dispatch',
          '@modern-js/native-node-terminal-responses',
        ],
        setup(serverApi) {
          serverApi.onPrepare(() => {
            render = serverApi.getServerContext().render;
          });
        },
      };
      runtime = createServerBase({
        pwd: distDirectory,
        appContext: { appDirectory: root },
        routes: [
          {
            urlPath: '/',
            entryName: 'main',
            entryPath: 'main.html',
            bundle: 'bundles/main.mjs',
            isSSR: true,
          },
        ],
        config: {
          html: {},
          output: { distPath: { root: 'dist' } },
          source: {},
          tools: {},
          server: { logger: false, ssr: true },
          bff: {},
          dev: {},
          security: {},
        },
      });
      runtime.addPlugins([
        injectRenderHandlerPlugin({}),
        nativeServerPlugin(options),
        capture,
      ]);
      await runtime.init();
      const handler = rstest.fn(
        (
          _request: Request,
          requestContext: NativeRequestContext<NativeNodeBindings>,
        ) => Response.json(requestContext.nativeManifest),
      );
      const requestOptions: RenderOptions = {
        monitors: {
          push() {},
          error() {},
          warn() {},
          debug() {},
          info() {},
          trace() {},
          timing() {},
          counter() {},
        },
        templates: {},
        serverManifest: {},
        matchEntryName: 'main',
        loaderContext: new Map(),
      };
      Object.defineProperty(requestOptions.serverManifest, 'renderBundles', {
        value: {
          main: { rendererIdentity: identity, nativeRequestHandler: handler },
        },
        enumerable: true,
      });
      const response = await render!(
        new Request('http://fourth.invalid/'),
        requestOptions,
      );
      expect(await response.json()).toEqual({
        abi: 'replacement-compiler/v1',
        build: { identity, hydrationBuildId: 'fourth-hydration' },
      });
      expect(files).toHaveBeenCalledWith(manifestFile);
      expect(handler).toHaveBeenCalledTimes(1);
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({
          abi: 'replacement-compiler/v1',
          build: {
            identity: { ...identity, buildId: 'foreign-build' },
            hydrationBuildId: 'fourth-hydration',
          },
        }),
      );
      await expect(
        render!(new Request('http://fourth.invalid/'), requestOptions),
      ).rejects.toThrow('conflicts with the application build');
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await runtime?.dispose();
      files.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the selected owner capabilities when admitting authored config', () => {
    expect(() =>
      assertCapturedRenderer(
        { renderer, i18n: { locale: 'en' } } as UltramodernAppUserConfig,
        renderer,
      ),
    ).not.toThrow();
    expect(() =>
      assertCapturedRenderer({ renderer, server: { rsc: true } }, renderer),
    ).toThrow('does not support React Server Components');
  });

  it.each(['fourth-native', 'vue', 'Solid', 'solid/native', ''])(
    'rejects unregistered or malformed %s before composition',
    value => {
      expect(() => resolveRendererAdapter(value)).toThrow(
        `Unsupported UltraModern renderer: ${value}`,
      );
      expect(() =>
        defineConfig({ renderer: value as RegisteredRenderer }),
      ).toThrow(`Unsupported UltraModern renderer: ${value}`);
    },
  );
});
