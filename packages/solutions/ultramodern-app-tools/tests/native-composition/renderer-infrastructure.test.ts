import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  type AppNormalizedConfig,
  type AppTools,
  appTools,
  type BffCompilation,
} from '@modern-js/app-tools';
import { SERVICE_WORKER_ENVIRONMENT_NAME } from '@modern-js/builder';
import { type CLIPluginAPI, createPluginManager } from '@modern-js/plugin';
import {
  createContext,
  initAppContext,
  initPluginAPI,
} from '@modern-js/plugin/cli';
import { bffPlugin as nativeBffPlugin } from '@modern-js/plugin-bff';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import type { Entrypoint } from '@modern-js/types';
import {
  createRsbuild,
  type EnvironmentConfig,
  type RsbuildPlugin,
  type Rspack,
  rspack,
} from '@rsbuild/core';
import { describe, expect, it, rstest } from '@rstest/core';
import { createDefaultConfig } from '../../../app-tools/src/config';
import { getBundleEntry } from '../../../app-tools/src/plugins/analyze/getBundleEntry';
import {
  defineConfig,
  resolveUltramodernConfig,
} from '../../src/native-composition/index';
import { nativeClientAssetsPlugin } from '../../src/native-composition/native-assets';
import {
  RENDERER_BUILD_MANIFEST_FILE,
  readRendererBuildManifest,
} from '../../src/native-composition/native-build-manifest';
import {
  type NativeEntryGenerator,
  type NativeInfrastructureOptions,
  nativeRendererInfrastructurePlugin,
} from '../../src/native-composition/native-infrastructure';
import {
  isUltramodernReleaseIdentityBannerPlugin,
  ultramodernReleaseIdentityBannerPlugin,
} from '../../src/native-composition/preset';
import {
  resolveCandidateRendererProfile,
  resolveRendererProfile,
} from '../../src/native-composition/renderer-profile';
import { nativeRendererIsolationPlugin } from '../../src/native-composition/renderer-selection';
import { createFourthAdapter } from './fourth-renderer-adapter';
import {
  createReplacementAdapter,
  createReplacementCompilerArtifacts,
} from './replacement-compiler-artifacts';

type NativeRenderer = 'solid' | 'octane' | 'replacement';

async function initializeInfrastructure(
  renderer: NativeRenderer,
  appDirectory: string,
  generator?: NativeEntryGenerator,
  ssr = true,
  options: NativeInfrastructureOptions = {},
  withBff = false,
  command: 'build' | 'dev' | 'serve' = 'build',
) {
  const config = {
    renderer,
    source: { entriesDir: './src', mainEntryName: 'main' },
    server: { ssr },
    output: { cleanDistPath: false },
  };
  const manager = createPluginManager();
  manager.addPlugins([
    appTools({ rendererExtensions: false, serverExtensions: false }),
    nativeRendererInfrastructurePlugin(renderer, generator, options),
    ...(withBff ? [nativeBffPlugin()] : []),
  ]);
  const plugins = manager.getPlugins();
  const context = await createContext<AppTools>({
    appContext: initAppContext({
      packageName: 'native-infrastructure-proof',
      configFile: false,
      command,
      appDirectory,
      metaName: 'modern-js',
      plugins,
    }),
    config,
    normalizedConfig: config as AppNormalizedConfig,
  });
  const api = initPluginAPI({ context, pluginManager: manager });
  context.pluginAPI = api;
  for (const plugin of plugins) {
    await plugin.setup?.(api as CLIPluginAPI<AppTools>);
  }
  return { api, context, plugins };
}

function createFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-native-infrastructure-'),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const sdkDirectory = path.resolve(import.meta.dirname, '../..');
  const sdkManifest = JSON.parse(
    fs.readFileSync(path.join(sdkDirectory, 'package.json'), 'utf8'),
  );
  const sdkSlot = path.join(root, 'node_modules', sdkManifest.name);
  fs.mkdirSync(path.dirname(sdkSlot), { recursive: true });
  fs.symlinkSync(sdkDirectory, sdkSlot, 'dir');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'native-infrastructure-proof',
      private: true,
      devDependencies: { [sdkManifest.name]: sdkManifest.version },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' } }),
  );
  return root;
}

describe('native infrastructure in the owning CLI hooks', () => {
  it.each(['build', 'dev'] as const)(
    'preserves environment output options while assigning owned %s paths',
    async command => {
      const root = createFixture();
      try {
        const adapter = createFourthAdapter();
        const { api } = await initializeInfrastructure(
          'solid',
          root,
          undefined,
          true,
          {
            adapter,
            profile: adapter.profile,
            async resolveBuildIdentities() {
              throw new Error(
                'Environment projection must not resolve identities',
              );
            },
          },
          false,
          command,
        );
        const distDirectory = path.join(root, 'dist');
        api.updateAppContext({ distDirectory });
        const authored = {
          client: {
            output: {
              filename: { css: 'client.css' },
              distPath: { root: path.join(root, 'client'), css: 'client-css' },
            },
          },
          server: {
            output: {
              filename: { css: 'server.css' },
              distPath: { root: path.join(root, 'server'), css: 'server-css' },
            },
          },
          auxiliary: {
            output: {
              filename: { css: 'auxiliary.css' },
              distPath: { root: path.join(root, 'auxiliary'), css: 'assets' },
            },
          },
        } satisfies Record<string, EnvironmentConfig>;
        const before = structuredClone(authored);
        const { environments } = await api
          .getHooks()
          .modifyBuilderEnvironments.call({ environments: authored });
        expect(authored).toEqual(before);
        expect(environments.server.output).toEqual({
          target: 'node',
          filename: { css: 'server.css', js: '[name].js' },
          distPath: {
            root: path.join(
              distDirectory,
              ...(command === 'dev' ? ['.ultramodern-dev'] : []),
              'bundles',
            ),
            js: '',
            jsAsync: '',
            css: '',
            cssAsync: '',
          },
        });
        for (const name of ['client', 'auxiliary'] as const)
          expect(environments[name].output).toEqual({
            ...before[name].output,
            distPath: {
              ...before[name].output?.distPath,
              root:
                command === 'dev'
                  ? path.join(distDirectory, '.ultramodern-dev', name)
                  : path.join(root, name),
            },
          });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['solid', 'octane'],
    ['octane', 'solid'],
  ] as const)(
    'rejects a %s serve over a build made for another renderer or profile',
    async (renderer, other) => {
      const root = createFixture();
      try {
        const { api } = await initializeInfrastructure(
          renderer,
          root,
          undefined,
          true,
          {
            async resolveBuildIdentities() {
              throw new Error('serve reuses the built identities');
            },
          },
          false,
          'serve',
        );
        const distDirectory = path.join(root, 'dist');
        fs.mkdirSync(distDirectory);
        api.updateAppContext({ distDirectory });
        const serveBuiltBy = (
          profile: ReturnType<typeof resolveRendererProfile>,
        ) => {
          fs.writeFileSync(
            path.join(distDirectory, RENDERER_BUILD_MANIFEST_FILE),
            JSON.stringify({
              schema: 'ultramodern-renderer-build',
              version: 2,
              renderer: profile.renderer,
              profile,
              routerBindings: {},
              buildId: 'a'.repeat(64),
              sourceRevision: 'workspace',
              entries: {},
            }),
          );
          return api.getHooks()._internalServerPlugins.call({ plugins: [] });
        };
        await expect(
          serveBuiltBy(resolveRendererProfile(other)),
        ).rejects.toThrow(
          `made for the ${other} renderer, but the configuration selects ${renderer}; rebuild`,
        );
        const installed = resolveRendererProfile(renderer);
        await expect(
          serveBuiltBy({
            ...installed,
            compiler: { ...installed.compiler, version: '0.0.0-stale' },
          }),
        ).rejects.toThrow(
          `different ${renderer} renderer profile than the installed one; rebuild`,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['solid', 'octane'] as const)(
    'binds final %s entries after consumer rename, addition and removal',
    async renderer => {
      const root = createFixture();
      try {
        const captured: string[][] = [];
        const emitted: string[] = [];
        const { api, plugins: cliPlugins } = await initializeInfrastructure(
          renderer,
          root,
          {
            client(context) {
              expect(context.rendererIdentity?.entryName).toBe(
                context.entrypoint.entryName,
              );
              emitted.push(context.entrypoint.entryName);
              return 'export const client = true;';
            },
            server: () =>
              'export const nativeRequestHandler = () => new Response();',
          },
          false,
          {
            async resolveBuildIdentities({ entrypoints }) {
              const names = entrypoints.map(entrypoint => entrypoint.entryName);
              captured.push(names);
              return {
                identities: Object.fromEntries(
                  names.map(entryName => [
                    entryName,
                    {
                      renderer,
                      appId: 'final-entry-transport-proof',
                      entryName,
                      protocolVersion: 1,
                      buildId: 'a'.repeat(64),
                    },
                  ]),
                ),
                buildId: 'a'.repeat(64),
                profileKey: 'b'.repeat(64),
                sourceRevision: 'workspace',
              };
            },
          },
          true,
        );
        const pluginNames = cliPlugins.map(plugin => plugin.name);
        const metadataIndex = pluginNames.indexOf(
          `@modern-js/renderer-${renderer}-infrastructure`,
        );
        const bffIndex = pluginNames.indexOf('@modern-js/plugin-bff');
        expect(metadataIndex).toBeGreaterThanOrEqual(0);
        expect(bffIndex).toBeGreaterThan(metadataIndex);
        const provider = api.getAppContext().resolveBffRuntimeBuildIdentity;
        expect(provider).toBeTypeOf('function');
        if (!provider) throw new Error('Missing native BFF identity provider');
        const compilation: BffCompilation = {
          appDirectory: root,
          apiDirectory: path.join(root, 'api'),
          sourceDirectories: [path.join(root, 'api')],
          distDirectory: path.join(root, 'dist'),
          moduleType: 'commonjs',
        };
        await expect(provider(compilation)).rejects.toThrow(
          'requires a completed renderer build',
        );
        await expect(
          provider({ ...compilation, appDirectory: path.join(root, 'other') }),
        ).rejects.toThrow('requires its owning application compilation');
        // This is a real later consumer tap in the same pipeline analyze awaits.
        api.modifyEntrypoints(({ entrypoints }) => ({
          entrypoints: [
            { ...entrypoints[0], entryName: 'renamed' },
            {
              entryName: 'added',
              entry: path.join(root, 'src', 'extra', 'App.tsx'),
            },
          ],
        }));
        const { entrypoints } = await api.getHooks().modifyEntrypoints.call({
          entrypoints: ['main', 'removed'].map(entryName => ({
            entryName,
            entry: path.join(root, 'src', entryName, 'App.tsx'),
          })),
        });
        expect(captured).toEqual([]);
        const { routes } = await api.getHooks().modifyServerRoutes.call({
          routes: entrypoints.map(({ entryName }) => ({
            entryName,
            entryPath: `${entryName}.html`,
            urlPath: `/${entryName}`,
            isSSR: false,
          })),
        });
        expect(routes).toEqual([
          expect.objectContaining({
            entryName: 'renamed',
            entryPath: 'renamed.html',
            urlPath: '/renamed',
            isSSR: false,
            bundle: 'bundles/renamed.js',
          }),
          expect.objectContaining({
            entryName: 'added',
            entryPath: 'added.html',
            urlPath: '/added',
            isSSR: false,
            bundle: 'bundles/added.js',
          }),
          {
            urlPath: '/api',
            isApi: true,
            entryPath: '',
            isSPA: false,
            isSSR: false,
          },
        ]);
        api.updateAppContext({
          entrypoints,
          serverRoutes: routes,
          checkedEntries: entrypoints.map(({ entryName }) => entryName),
        });
        await api.getHooks().generateEntryCode.call({ entrypoints });
        expect(captured).toEqual([['renamed', 'added']]);
        expect(emitted).toEqual(['renamed', 'added']);
        // Prepared entry identities are not a completed, validated native build.
        await expect(provider(compilation)).rejects.toThrow(
          'requires a completed renderer build',
        );
        const internal = api.getAppContext().internalDirectory;
        for (const name of ['main', 'removed'])
          expect(fs.existsSync(path.join(internal, renderer, name))).toBe(
            false,
          );
        for (const { entryName, internalEntry } of entrypoints)
          expect(internalEntry).toBe(
            path.join(internal, renderer, entryName, 'index.ts'),
          );
        const { environments } = await api
          .getHooks()
          .modifyBuilderEnvironments.call({ environments: { client: {} } });
        expect(environments.server.source?.entry).toEqual(
          Object.fromEntries(
            ['renamed', 'added'].map(name => [
              name,
              path.join(internal, renderer, name, 'index.server.ts'),
            ]),
          ),
        );
        const { plugins } = await api
          .getHooks()
          ._internalServerPlugins.call({ plugins: [] });
        expect(Object.keys(plugins[0].options?.entries ?? {})).toEqual([
          'renamed',
          'added',
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['solid', 'octane'] as const)(
    'retains %s Node transport for CSR using the analyzed route prefix',
    async renderer => {
      const root = createFixture();
      try {
        const contexts: string[] = [];
        const { api } = await initializeInfrastructure(
          renderer,
          root,
          {
            client: context => {
              contexts.push(context.basePath);
              return 'export const csr = true;';
            },
            server: () =>
              'export const nativeRequestHandler = () => new Response("data");',
          },
          false,
          {
            async resolveBuildIdentities({ entrypoints }) {
              return {
                identities: Object.fromEntries(
                  entrypoints.map(({ entryName }) => [
                    entryName,
                    {
                      renderer,
                      appId: 'plain-transport-proof',
                      entryName,
                      protocolVersion: 1,
                      buildId: 'a'.repeat(64),
                    },
                  ]),
                ),
                buildId: 'a'.repeat(64),
                profileKey: 'b'.repeat(64),
                sourceRevision: 'workspace',
              };
            },
          },
        );
        const { entrypoints } = await api.getHooks().modifyEntrypoints.call({
          entrypoints: [
            { entryName: 'main', entry: path.join(root, 'src', 'App.tsx') },
          ],
        });
        const { routes } = await api.getHooks().modifyServerRoutes.call({
          routes: [
            {
              entryName: 'main',
              urlPath: '/checkout',
              entryPath: 'main.html',
              isSSR: false,
              isSPA: true,
            },
          ],
        });
        expect(routes[0].bundle).toBe('bundles/main.js');
        expect(routes[0].isSSR).toBe(false);
        api.updateAppContext({
          entrypoints,
          serverRoutes: routes,
          checkedEntries: ['main'],
        });
        await api.getHooks().generateEntryCode.call({ entrypoints });
        expect(contexts).toEqual(['/checkout']);
        const { environments } = await api
          .getHooks()
          .modifyBuilderEnvironments.call({
            environments: {
              client: {
                source: { entry: { main: entrypoints[0].internalEntry! } },
              },
            },
          });
        expect(environments.server.output?.target).toBe('node');
        expect(environments.server.source?.entry).toEqual({
          main: path.join(
            path.dirname(entrypoints[0].internalEntry!),
            'index.server.ts',
          ),
        });
        expect(environments.server.performance?.buildCache).toEqual({
          cacheDigest: [renderer, expect.stringMatching(/^[a-f0-9]{64}$/u)],
        });
        const { plugins } = await api
          .getHooks()
          ._internalServerPlugins.call({ plugins: [] });
        expect(plugins[0].options).toEqual(
          expect.objectContaining({
            renderer,
            cacheAllowed: true,
            assetManifestFile: 'renderer-assets.json',
            nativeManifestFiles: {
              main: `${renderer}-module-manifest.main.json`,
            },
          }),
        );
        await expect(
          api.getHooks().onBeforeCreateCompiler.call({
            bundlerConfigs: [
              {
                name: 'server',
                output: {
                  path: path.join(api.getAppContext().distDirectory, 'bundles'),
                  filename: 'renamed.js',
                },
              },
            ],
          }),
        ).rejects.toThrow('registered bundles/[name].js');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('rejects multiple native public route aliases before generating any entry', async () => {
    const root = createFixture();
    try {
      const { api } = await initializeInfrastructure(
        'solid',
        root,
        {
          client: () => 'export const client = true;',
          server: () => 'export const server = true;',
        },
        true,
        {
          async resolveBuildIdentities() {
            return {
              identities: {
                main: {
                  renderer: 'solid',
                  appId: 'plain-proof',
                  entryName: 'main',
                  protocolVersion: 1,
                  buildId: 'a'.repeat(64),
                },
              },
              buildId: 'a'.repeat(64),
              profileKey: 'b'.repeat(64),
              sourceRevision: 'workspace',
            };
          },
        },
      );
      const { entrypoints } = await api.getHooks().modifyEntrypoints.call({
        entrypoints: ['main', 'admin'].map(entryName => ({
          entryName,
          entry: path.join(root, 'src', entryName, 'App.tsx'),
        })),
      });
      api.updateAppContext({
        serverRoutes: [
          { entryName: 'main', urlPath: '/', entryPath: 'main.html' },
          ...['/one', '/two'].map(urlPath => ({
            entryName: 'admin',
            urlPath,
            entryPath: 'admin.html',
          })),
        ],
      });
      await expect(
        api.getHooks().generateEntryCode.call({ entrypoints }),
      ).rejects.toThrow('exactly one analyzed public route prefix');
      for (const { internalEntry } of entrypoints)
        expect(fs.existsSync(internalEntry!)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { renderer: 'solid', source: 'App.tsx' },
    { renderer: 'solid', source: 'App.jsx' },
    { renderer: 'octane', source: 'App.tsx' },
    { renderer: 'octane', source: 'App.tsrx' },
  ] as const)(
    'discovers $renderer $source through checkEntryPoint before the ordinary fallback',
    async ({ renderer, source }) => {
      const root = createFixture();
      try {
        const app = path.join(root, 'src', source);
        fs.writeFileSync(
          app,
          'export default function App() { return "plain-infrastructure"; }\n',
        );
        if (renderer === 'octane')
          fs.writeFileSync(
            path.join(root, 'src', 'App.jsx'),
            'export default () => <main />;\n',
          );
        const { api, plugins } = await initializeInfrastructure(renderer, root);
        const observed: Array<string | false> = [];
        api.checkEntryPoint(input => {
          observed.push(input.entry);
          return input;
        });
        const entries = await getBundleEntry(
          api.getHooks(),
          api.getAppContext(),
          api.getNormalizedConfig(),
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].entry).toBe(app);
        expect(entries[0].entryName).toBe('main');
        expect(observed).toEqual([app, app]);
        expect(plugins.map(plugin => plugin.name)).not.toContain(
          '@modern-js/runtime',
        );
        expect(plugins.map(plugin => plugin.name)).not.toContain(
          '@modern-js/plugin-router',
        );
        expect(plugins.map(plugin => plugin.name)).not.toContain(
          '@modern-js/plugin-ssr',
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['App.jsx', 'index.jsx'])(
    'rejects unsupported Octane %s during automatic entry discovery',
    async source => {
      const root = createFixture();
      try {
        const filename = path.join(root, 'src', source);
        fs.writeFileSync(filename, 'export default () => <main />;\n');
        const { api } = await initializeInfrastructure('octane', root);
        await expect(
          getBundleEntry(
            api.getHooks(),
            api.getAppContext(),
            api.getNormalizedConfig(),
          ),
        ).rejects.toThrow(
          `unsupported-renderer-capability: Octane does not support .jsx source: ${filename}`,
        );
        expect(resolveRendererProfile('octane').sourceExtensions).toEqual([
          '.tsx',
          '.tsrx',
          '.ts',
          '.js',
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['explicit', 'late', 'server'] as const)(
    'rejects an unsupported Octane %s source before any entry emission',
    async kind => {
      const root = createFixture();
      try {
        const supported = path.join(root, 'src', 'App.tsx');
        const unsupported = path.join(
          root,
          'src',
          kind === 'server' ? 'index.server.jsx' : 'Other.jsx',
        );
        fs.writeFileSync(supported, 'export default () => <main />;\n');
        fs.writeFileSync(unsupported, 'export default () => <main />;\n');
        const generator: NativeEntryGenerator = {
          client: rstest.fn(() => 'export const client = true;'),
          server: rstest.fn(() => 'export const server = true;'),
        };
        const { api } = await initializeInfrastructure(
          'octane',
          root,
          generator,
        );
        let selected: Entrypoint[];
        if (kind === 'explicit') {
          const config = api.getNormalizedConfig();
          selected = await getBundleEntry(api.getHooks(), api.getAppContext(), {
            source: {
              ...config.source,
              disableDefaultEntries: true,
              entries: { main: unsupported },
            },
          });
        } else {
          selected = [
            { entryName: 'main', entry: supported },
            {
              entryName: 'other',
              entry: supported,
              ...(kind === 'server' ? { customServerEntry: unsupported } : {}),
            },
          ];
          if (kind === 'late')
            api.modifyEntrypoints(({ entrypoints }) => ({
              entrypoints: entrypoints.map(entrypoint =>
                entrypoint.entryName === 'other'
                  ? { ...entrypoint, entry: unsupported }
                  : entrypoint,
              ),
            }));
        }
        const { entrypoints } = await api
          .getHooks()
          .modifyEntrypoints.call({ entrypoints: selected });
        await expect(
          api.getHooks().generateEntryCode.call({ entrypoints }),
        ).rejects.toThrow(
          `unsupported-renderer-capability: Octane does not support .jsx source: ${unsupported}`,
        );
        expect(generator.client).not.toHaveBeenCalled();
        expect(generator.server).not.toHaveBeenCalled();
        for (const { internalEntry } of entrypoints)
          expect(fs.existsSync(internalEntry!)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('reports the route tree after downstream route modifiers', async () => {
    const root = createFixture();
    try {
      const entry = path.join(root, 'src', 'App.tsx');
      fs.writeFileSync(entry, 'export default () => <main />;\n');
      const reported: [string, readonly unknown[]][] = [];
      const generator: NativeEntryGenerator = {
        async client(context) {
          await context.modifyRoutes([
            { id: 'page', path: '/', file: 'routes/page.tsx', children: [] },
          ]);
          return 'export const client = true;';
        },
        server: () => 'export const server = true;',
      };
      const { api } = await initializeInfrastructure(
        'solid',
        root,
        generator,
        true,
        { onRoutes: (entryName, routes) => reported.push([entryName, routes]) },
      );
      api.modifyFileSystemRoutes(({ entrypoint, routes }) => ({
        entrypoint,
        routes: [
          ...routes,
          {
            id: 'added',
            path: 'added',
            file: 'routes/added/page.tsx',
            children: [],
          } as never,
        ],
      }));
      const { entrypoints } = await api.getHooks().modifyEntrypoints.call({
        entrypoints: [{ entryName: 'main', entry }],
      });
      await api.getHooks().generateEntryCode.call({ entrypoints });
      expect(reported).toHaveLength(1);
      expect(reported[0][0]).toBe('main');
      expect(
        (reported[0][1] as { id: string }[]).map(route => route.id),
      ).toEqual(['page', 'added']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['solid', 'octane'] as const)(
    'emits %s adapter-owned plain TypeScript and maps only server environments',
    async renderer => {
      const root = createFixture();
      try {
        const generator: NativeEntryGenerator = {
          client: rstest.fn(
            context =>
              `export const renderer = ${JSON.stringify(context.renderer)};\n`,
          ),
          server: rstest.fn(
            context =>
              `export default function handle(request: Request): Response { return new Response(${JSON.stringify(context.renderer)} + new URL(request.url).pathname); }\n`,
          ),
        };
        const { api } = await initializeInfrastructure(
          renderer,
          root,
          generator,
        );
        const original: Entrypoint[] = ['main', 'admin'].map(entryName => ({
          entryName,
          entry: path.join(root, 'src', entryName, 'App.tsx'),
          absoluteEntryDir: path.join(root, 'src', entryName),
        }));
        const { entrypoints } = await api
          .getHooks()
          .modifyEntrypoints.call({ entrypoints: original });
        expect(original.every(entry => entry.internalEntry === undefined)).toBe(
          true,
        );
        await api.getHooks().generateEntryCode.call({ entrypoints });
        for (const entrypoint of entrypoints) {
          const directory = path.join(
            api.getAppContext().internalDirectory,
            renderer,
            entrypoint.entryName,
          );
          expect(entrypoint.internalEntry).toBe(
            path.join(directory, 'index.ts'),
          );
          expect(entrypoint.customEntry).toBe(false);
          expect(entrypoint.isAutoMount).toBe(true);
          for (const file of ['index.ts', 'index.server.ts']) {
            const source = fs.readFileSync(path.join(directory, file), 'utf8');
            expect(source).not.toMatch(/react|ModernRoot|\.jsx|\.tsx/u);
          }
        }
        expect(generator.client).toHaveBeenCalledTimes(2);
        expect(generator.server).toHaveBeenCalledTimes(2);
        expect(generator.client).toHaveBeenCalledWith(
          expect.objectContaining({
            renderer,
            appDirectory: root,
            entrypoint: entrypoints[0],
          }),
        );

        api.updateAppContext({ checkedEntries: ['main'] });
        const client: EnvironmentConfig = {
          source: {
            entry: {
              main: entrypoints[0].internalEntry!,
              admin: entrypoints[1].internalEntry!,
            },
          },
        };
        const custom: EnvironmentConfig = {
          source: { entry: { analytics: path.join(root, 'analytics.ts') } },
          output: { target: 'node' },
        };
        const server: EnvironmentConfig = {
          source: {
            entry: { main: path.join(root, 'react-index.server.jsx') },
          },
          output: { target: 'node' },
        };
        const worker: EnvironmentConfig = {
          source: { entry: { main: path.join(root, 'react-worker.jsx') } },
          output: { target: 'web-worker' },
        };
        const { environments } = await api
          .getHooks()
          .modifyBuilderEnvironments.call({
            environments: {
              client,
              server,
              [SERVICE_WORKER_ENVIRONMENT_NAME]: worker,
              analytics: custom,
            },
          });
        const expected = {
          main: path.join(
            api.getAppContext().internalDirectory,
            renderer,
            'main',
            'index.server.ts',
          ),
        };
        expect(environments.client).toEqual(client);
        expect(environments.analytics).toEqual(custom);
        expect(environments.server.source?.entry).toEqual(expected);
        expect(
          environments[SERVICE_WORKER_ENVIRONMENT_NAME].source?.entry,
        ).toEqual(expected);
        expect(environments.server.output).toBe(server.output);
        expect(environments[SERVICE_WORKER_ENVIRONMENT_NAME].output).toBe(
          worker.output,
        );
        expect(server.source?.entry).toEqual({
          main: path.join(root, 'react-index.server.jsx'),
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['solid', 'octane'] as const)(
    'keeps authored %s custom TypeScript entries and Fetch handlers native',
    async renderer => {
      const root = createFixture();
      try {
        const entry = path.join(
          root,
          'src',
          renderer === 'octane' ? 'index.tsrx' : 'index.ts',
        );
        const server = path.join(
          root,
          'src',
          renderer === 'octane' ? 'index.server.tsrx' : 'index.server.ts',
        );
        fs.writeFileSync(entry, 'globalThis.__nativeInfrastructure = true;\n');
        fs.writeFileSync(
          server,
          'export const protocol = "fetch";\nexport default function handle() { return new Response("native"); }\n',
        );
        const { api } = await initializeInfrastructure(renderer, root);
        const discovered = await getBundleEntry(
          api.getHooks(),
          api.getAppContext(),
          api.getNormalizedConfig(),
        );
        const { entrypoints } = await api
          .getHooks()
          .modifyEntrypoints.call({ entrypoints: discovered });
        expect(entrypoints[0].customEntry).toBe(true);
        expect(entrypoints[0].isAutoMount).toBe(false);
        expect(entrypoints[0].customServerEntry).toBe(server);
        await api.getHooks().generateEntryCode.call({ entrypoints });
        expect(fs.readFileSync(entrypoints[0].internalEntry!, 'utf8')).toBe(
          `import ${JSON.stringify(entry)};\n`,
        );
        expect(
          fs.readFileSync(
            path.join(
              path.dirname(entrypoints[0].internalEntry!),
              'index.server.ts',
            ),
            'utf8',
          ),
        ).toBe(
          `export { default } from ${JSON.stringify(server)};\nexport * from ${JSON.stringify(server)};\n`,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('rejects a missing native SSR generator before writing a client entry', async () => {
    const root = createFixture();
    try {
      const { api } = await initializeInfrastructure('solid', root, {
        client: () => 'export const client = true;\n',
        server: () => '',
      });
      const { entrypoints } = await api.getHooks().modifyEntrypoints.call({
        entrypoints: [
          { entryName: 'main', entry: path.join(root, 'src', 'App.tsx') },
        ],
      });
      await expect(
        api.getHooks().generateEntryCode.call({ entrypoints }),
      ).rejects.toThrow(
        'Renderer solid requires a native server handler for main',
      );
      expect(fs.existsSync(entrypoints[0].internalEntry!)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows CSR generation without an unused server handler', async () => {
    const root = createFixture();
    try {
      const { api } = await initializeInfrastructure(
        'solid',
        root,
        { client: () => 'export const client = true;\n', server: () => '' },
        false,
      );
      const { entrypoints } = await api.getHooks().modifyEntrypoints.call({
        entrypoints: [
          { entryName: 'main', entry: path.join(root, 'src', 'App.tsx') },
        ],
      });
      await api.getHooks().generateEntryCode.call({ entrypoints });
      expect(fs.readFileSync(entrypoints[0].internalEntry!, 'utf8')).toContain(
        'export const client = true',
      );
      expect(
        fs.existsSync(
          path.join(
            path.dirname(entrypoints[0].internalEntry!),
            'index.server.ts',
          ),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('native infrastructure through the real Rsbuild and Rspack pipeline', () => {
  it('validates a selected replacement compiler artifact through the production build lifecycle', async () => {
    const root = createFixture();
    let compiler: Rspack.MultiCompiler | undefined;
    try {
      const profile = {
        ...resolveCandidateRendererProfile('solid'),
        renderer: 'replacement',
        compiler: { name: '@fixture/replacement-compiler', version: '1.0.0' },
        hydration: { name: '@fixture/replacement-runtime', version: '1.0.0' },
        router: {
          name: '@fixture/replacement-router',
          version: '1.0.0',
          coreName: '@fixture/replacement-router-core',
          coreVersion: '1.0.0',
        },
      };
      const identity: RendererIdentity = {
        renderer: 'replacement',
        appId: 'replacement-compiler-build',
        entryName: 'main',
        protocolVersion: 1,
        buildId: 'a'.repeat(64),
      };
      const routerProvider = { framework: 'replacement', ...profile.router };
      const build = {
        identities: { main: identity },
        buildId: identity.buildId,
        profileKey: 'b'.repeat(64),
        sourceRevision: 'workspace',
        routerBindings: {
          main: {
            owner: '@fixture/replacement-router-owner',
            evidence: 'file-routes' as const,
            defaultProvider: routerProvider,
            providers: [routerProvider],
          },
        },
      };
      const compilerArtifacts = createReplacementCompilerArtifacts();
      fs.writeFileSync(path.join(root, 'src', 'App.ts'), 'export {};\n');
      const { api } = await initializeInfrastructure(
        'replacement',
        root,
        {
          client: () => 'globalThis.replacementBuild = true;\n',
          server:
            () => `export const rendererIdentity = ${JSON.stringify(identity)};
export const nativeRequestHandler = () => new Response('replacement');
export const nativeCSRRequestHandler = nativeRequestHandler;
`,
        },
        true,
        {
          profile,
          adapter: createReplacementAdapter(profile, compilerArtifacts),
          resolveBuildIdentities: async () => build,
        },
      );
      const { entrypoints } = await api.getHooks().modifyEntrypoints.call({
        entrypoints: [
          { entryName: 'main', entry: path.join(root, 'src', 'App.ts') },
        ],
      });
      const distDirectory = path.join(root, 'dist');
      api.updateAppContext({
        distDirectory,
        entrypoints,
        serverRoutes: [
          {
            entryName: 'main',
            urlPath: '/',
            entryPath: 'main.html',
            isSSR: true,
          },
        ],
        checkedEntries: ['main'],
      });
      await api.getHooks().generateEntryCode.call({ entrypoints });
      const { environments } = await api
        .getHooks()
        .modifyBuilderEnvironments.call({
          environments: {
            client: {
              source: { entry: { main: entrypoints[0].internalEntry! } },
              output: {
                target: 'web',
                assetPrefix: '/assets/',
                distPath: { root: distDirectory },
              },
              tools: { htmlPlugin: false },
            },
          },
        });
      const producer: RsbuildPlugin = {
        name: 'replacement-compiler-artifact',
        setup(builder) {
          builder.modifyRspackConfig((config, { environment }) => {
            if (environment.name !== 'client') return;
            config.plugins ??= [];
            config.plugins.push({
              apply(selectedCompiler: Rspack.Compiler) {
                selectedCompiler.hooks.thisCompilation.tap(
                  'ReplacementCompilerArtifact',
                  compilation => {
                    compilation.hooks.processAssets.tap(
                      {
                        name: 'ReplacementCompilerArtifact',
                        stage: rspack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
                      },
                      () => {
                        if (!compilation.hash)
                          throw new Error(
                            'Replacement compiler requires its actual hash',
                          );
                        compilation.emitAsset(
                          compilerArtifacts.clientManifestFile('main'),
                          new rspack.sources.RawSource(
                            JSON.stringify({
                              abi: 'replacement-compiler/v1',
                              build: {
                                identity,
                                hydrationBuildId: compilation.hash,
                              },
                            }),
                          ),
                        );
                      },
                    );
                  },
                );
              },
            });
          });
        },
      };
      const rsbuild = await createRsbuild({
        cwd: root,
        rsbuildConfig: {
          mode: 'production',
          environments,
          plugins: [
            nativeClientAssetsPlugin(
              'replacement',
              () => build.identities,
              'renderer',
            ),
            producer,
          ],
          output: { minify: false, sourceMap: false, filenameHash: false },
          performance: { printFileSize: false },
        },
      });
      const configs = await rsbuild.initConfigs();
      await api
        .getHooks()
        .onBeforeCreateCompiler.call({ bundlerConfigs: configs });
      compiler = rspack.rspack(configs);
      const stats = await new Promise<Rspack.MultiStats>((resolve, reject) => {
        compiler!.run((error, result) => {
          if (error) reject(error);
          else if (!result || result.hasErrors())
            reject(
              new Error(
                result?.toString({ all: false, errors: true }) ??
                  'Missing replacement compilation',
              ),
            );
          else resolve(result);
        });
      });
      await api.getHooks().onAfterBuild.call({ stats });
      const clientHash = stats.stats.find(
        result => result.compilation.name === 'client',
      )!.compilation.hash!;
      expect(compilerArtifacts.validateClientManifest).toHaveBeenCalledTimes(1);
      expect(compilerArtifacts.validateClientManifest).toHaveBeenCalledWith(
        expect.objectContaining({ abi: 'replacement-compiler/v1' }),
        identity,
        { compilationHash: clientHash },
      );
      expect(
        (
          await readRendererBuildManifest(distDirectory, profile, {
            routerFrameworks: ['replacement'],
          })
        ).entries.main,
      ).toEqual(identity);
      const artifactFile = path.join(
        distDirectory,
        compilerArtifacts.clientManifestFile('main'),
      );
      const original = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
      for (const invalid of [
        {
          ...original,
          build: {
            ...original.build,
            identity: { ...identity, buildId: 'stale' },
          },
        },
        {
          ...original,
          build: { ...original.build, hydrationBuildId: 'other-compilation' },
        },
      ]) {
        fs.writeFileSync(artifactFile, JSON.stringify(invalid));
        await expect(
          api.getHooks().onAfterBuild.call({ stats }),
        ).rejects.toThrow();
      }
      expect(compilerArtifacts.validateClientManifest).toHaveBeenCalledTimes(3);
      // A failed compilation (e.g. a type-checker error) emits no native
      // manifest. Its diagnostics must stay the build failure instead of being
      // replaced by an ENOENT for the manifest the compiler deliberately skipped.
      fs.rmSync(artifactFile);
      fs.rmSync(path.join(distDirectory, 'renderer-assets.json'));
      const failed = Object.assign(Object.create(stats), {
        hasErrors: () => true,
      }) as Rspack.MultiStats;
      await api.getHooks().onAfterBuild.call({ stats: failed });
      expect(compilerArtifacts.validateClientManifest).toHaveBeenCalledTimes(3);
    } finally {
      try {
        if (compiler)
          await new Promise<void>((resolve, reject) =>
            compiler!.close(error => (error ? reject(error) : resolve())),
          );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it.each(['solid', 'octane'] as const)(
    'registers the full public %s SDK plugin graph without a dependency cycle',
    async renderer => {
      const config = await resolveUltramodernConfig(
        defineConfig({ renderer }),
        {
          env: 'test',
          command: 'dev',
        },
      );
      const manager = createPluginManager();
      manager.addPlugins(config.plugins ?? []);
      // Sorting the complete public composition throws on any ordering cycle.
      const pluginNames = manager.getPlugins().map(plugin => plugin.name);
      expect(pluginNames).toContain('@modern-js/ultramodern-app-tools');
      expect(pluginNames).toContain('@modern-js/plugin-initialize');
      expect(pluginNames).toContain(
        `@modern-js/renderer-${renderer}-infrastructure`,
      );
    },
  );

  it.each(['solid', 'octane'] as const)(
    'initializes %s dev compiler outputs after the real CLI resolves its application directory',
    async renderer => {
      const root = createFixture();
      try {
        const { api, context } = await initializeInfrastructure(
          renderer,
          root,
          {
            client: () => 'export const client = true;\n',
            server: () =>
              'export const nativeRequestHandler = () => new Response();\n',
          },
          true,
          {
            // These identities are synthetic for this config-only regression.
            // Rsbuild config generation and both CLI hooks are real.
            async resolveBuildIdentities({ entrypoints, mode }) {
              expect(mode).toBe('development');
              return {
                identities: Object.fromEntries(
                  entrypoints.map(({ entryName }) => [
                    entryName,
                    {
                      renderer,
                      appId: 'native-dev-output-config-proof',
                      entryName,
                      protocolVersion: 1,
                      buildId: 'a'.repeat(64),
                    },
                  ]),
                ),
                buildId: 'a'.repeat(64),
                profileKey: 'b'.repeat(64),
                sourceRevision: 'workspace',
              };
            },
          },
          false,
          'dev',
        );
        // Rsbuild setup must use the directory resolved by the real CLI hook.
        expect(api.getAppContext().distDirectory).toBe('');
        const defaults = createDefaultConfig(api.getAppContext());
        const config = api.getNormalizedConfig();
        const resolved = await api.getHooks().modifyResolvedConfig.call({
          ...defaults,
          ...config,
          source: { ...defaults.source, ...config.source },
          output: { ...defaults.output, ...config.output },
          server: { ...defaults.server, ...config.server },
        } as AppNormalizedConfig);
        context.normalizedConfig = resolved;
        const distDirectory = path.join(root, 'dist');
        expect(api.getAppContext().distDirectory).toBe(distDirectory);
        const builderPlugins = resolved.builderPlugins as RsbuildPlugin[];
        expect(builderPlugins.map(plugin => plugin.name)).toEqual(
          expect.arrayContaining([
            `ultramodern:${renderer}:development`,
            'ultramodern:renderer-release-identity',
          ]),
        );

        const { entrypoints } = await api.getHooks().modifyEntrypoints.call({
          entrypoints: [
            {
              entryName: 'main',
              entry: path.join(
                root,
                'src',
                renderer === 'octane' ? 'App.tsrx' : 'App.tsx',
              ),
            },
          ],
        });
        const { routes } = await api.getHooks().modifyServerRoutes.call({
          routes: [
            {
              entryName: 'main',
              urlPath: '/',
              entryPath: 'main.html',
              isSSR: true,
            },
          ],
        });
        api.updateAppContext({
          entrypoints,
          serverRoutes: routes,
          checkedEntries: ['main'],
        });
        await api.getHooks().generateEntryCode.call({ entrypoints });
        const { environments } = await api
          .getHooks()
          .modifyBuilderEnvironments.call({
            environments: {
              client: {
                source: { entry: { main: entrypoints[0].internalEntry! } },
                output: { target: 'web' },
                tools: { htmlPlugin: false },
              },
            },
          });
        const rsbuild = await createRsbuild({
          cwd: root,
          rsbuildConfig: {
            mode: 'development',
            plugins: [
              nativeRendererIsolationPlugin(renderer),
              // The workspace preset's delivery-unit release banner.
              ultramodernReleaseIdentityBannerPlugin([
                '1'.repeat(16),
                'workspace',
                '1.0.0',
              ]),
              ...builderPlugins,
            ],
            environments,
            performance: { printFileSize: false },
          },
        });
        const configs = await rsbuild.initConfigs({ action: 'dev' });
        const client = configs.find(config => config.name === 'client');
        const server = configs.find(config => config.name === 'server');
        // The UI unit's renderer buildId replaces the preset release banner.
        for (const config of [client, server]) {
          const banners = (config?.plugins ?? []).filter(
            plugin => plugin instanceof rspack.BannerPlugin,
          );
          expect(banners).toHaveLength(1);
          expect(isUltramodernReleaseIdentityBannerPlugin(banners[0])).toBe(
            false,
          );
        }
        expect(client?.output?.filename).toBe('[name].[contenthash].js');
        expect(client?.output?.path).toBe(
          path.join(distDirectory, '.ultramodern-dev', 'client'),
        );
        expect(server?.output?.filename).toBe('[name].js');
        expect(server?.output?.path).toBe(
          path.join(distDirectory, '.ultramodern-dev', 'bundles'),
        );
        await expect(
          api.getHooks().onBeforeCreateCompiler.call({
            bundlerConfigs: configs,
          }),
        ).resolves.toEqual({ bundlerConfigs: configs });

        for (const output of [
          { filename: 'renamed.js' },
          { path: path.join(distDirectory, 'bundles') },
        ]) {
          await expect(
            api.getHooks().onBeforeCreateCompiler.call({
              bundlerConfigs: configs.map(config =>
                config.name === 'server'
                  ? {
                      ...config,
                      output: { ...config.output, ...output },
                    }
                  : config,
              ),
            }),
          ).rejects.toThrow('registered bundles/[name].js');
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['solid', 'octane'] as const)(
    'builds emitted %s plain TS client and Fetch server after removing React owners before setup',
    async renderer => {
      const root = createFixture();
      let compiler: Rspack.MultiCompiler | undefined;
      try {
        const marker = `native-infrastructure-${renderer}`;
        fs.writeFileSync(
          path.join(root, 'src', 'index.ts'),
          `const marker: string = ${JSON.stringify(marker)};\n(globalThis as any).__nativeInfrastructure = marker;\n`,
        );
        fs.writeFileSync(
          path.join(root, 'src', 'index.server.ts'),
          `export default function handle(request: Request): Response { return new Response(${JSON.stringify(marker)} + new URL(request.url).pathname, { status: 207, headers: { "x-native-infrastructure": ${JSON.stringify(renderer)} } }); }\n`,
        );
        const { api } = await initializeInfrastructure(renderer, root);
        const discovered = await getBundleEntry(
          api.getHooks(),
          api.getAppContext(),
          api.getNormalizedConfig(),
        );
        const { entrypoints } = await api
          .getHooks()
          .modifyEntrypoints.call({ entrypoints: discovered });
        await api.getHooks().generateEntryCode.call({ entrypoints });
        api.updateAppContext({
          checkedEntries: entrypoints.map(entry => entry.entryName),
        });
        const { environments } = await api
          .getHooks()
          .modifyBuilderEnvironments.call({
            environments: {
              client: {
                source: { entry: { main: entrypoints[0].internalEntry! } },
                output: {
                  target: 'web',
                  distPath: { root: path.join(root, 'dist-client') },
                },
                tools: {
                  htmlPlugin: false,
                  rspack: { output: { filename: 'client.js' } },
                },
              },
              server: {
                source: { entry: { main: 'must-not-build-react-server.jsx' } },
                output: {
                  target: 'node',
                  distPath: { root: path.join(root, 'dist-server') },
                },
                tools: {
                  rspack: {
                    output: {
                      filename: 'handler.cjs',
                      library: { type: 'commonjs2' },
                    },
                  },
                },
              },
            },
          });
        const serverEntry = path.join(
          path.dirname(entrypoints[0].internalEntry!),
          'index.server.ts',
        );
        expect(environments.server.source?.entry).toEqual({
          main: serverEntry,
        });
        const setupEvents: string[] = [];
        const sentinels: RsbuildPlugin[] = [
          'rsbuild:react',
          'rsbuild:svgr',
          'builder-plugin-adapter-modern-ssr',
        ].map(name => ({
          name,
          setup() {
            setupEvents.push(name);
            throw new Error(`Removed plugin reached setup: ${name}`);
          },
        }));
        const rsbuild = await createRsbuild({
          cwd: root,
          rsbuildConfig: {
            mode: 'production',
            plugins: [...sentinels, nativeRendererIsolationPlugin(renderer)],
            environments,
            output: { minify: false, sourceMap: false, filenameHash: false },
            performance: { printFileSize: false },
          },
        });
        const configs = await rsbuild.initConfigs();
        expect(setupEvents).toEqual([]);
        expect(configs).toHaveLength(2);
        expect(configs.find(config => config.name === 'server')?.entry).toEqual(
          {
            main: [serverEntry],
          },
        );
        expect(
          configs
            .flatMap(config => config.plugins ?? [])
            .map(plugin => plugin?.constructor.name),
        ).not.toContain('ReactRefreshRspackPlugin');
        compiler = rspack.rspack(configs);
        const stats = await new Promise<Rspack.MultiStats>(
          (resolve, reject) => {
            compiler!.run((error, result) => {
              if (error) reject(error);
              else if (!result || result.hasErrors())
                reject(
                  new Error(
                    result?.toString({ all: false, errors: true }) ??
                      'Missing compilation stats',
                  ),
                );
              else resolve(result);
            });
          },
        );
        const json = stats.toJson({
          all: false,
          children: true,
          modules: true,
          nestedModules: true,
          orphanModules: true,
          cachedModules: true,
          dependentModules: true,
          groupModulesByPath: false,
          groupModulesByType: false,
          groupModulesByCacheStatus: false,
          groupModulesByLayer: false,
          groupModulesByExtension: false,
          groupModulesByAttributes: false,
          modulesSpace: Number.MAX_SAFE_INTEGER,
        });
        const moduleNames: string[] = [];
        const collect = (value: {
          name?: string;
          modules?: unknown[];
          children?: unknown[];
        }) => {
          if (value.name) moduleNames.push(value.name);
          for (const child of [
            ...(value.modules ?? []),
            ...(value.children ?? []),
          ])
            collect(child as typeof value);
        };
        collect(json);
        expect(moduleNames.length).toBeGreaterThan(0);
        expect(moduleNames.join('\n')).not.toMatch(
          /(?:node_modules[/\\](?:\.pnpm[/\\])?react(?:-dom|-refresh)?[/@\\]|@modern-js[/\\]runtime|react\/jsx-runtime|ReactRefresh)/u,
        );
        expect(moduleNames).toEqual(
          expect.arrayContaining([
            expect.stringContaining('index.server.ts'),
            expect.stringContaining('index.ts'),
          ]),
        );
        expect(moduleNames.join('\n')).not.toMatch(
          /\.(?:jsx|tsx|tsrx)(?:\s|$)/u,
        );
        const browser: Record<string, unknown> = { self: {} };
        vm.runInNewContext(
          fs.readFileSync(path.join(root, 'dist-client', 'client.js'), 'utf8'),
          browser,
        );
        expect(browser.__nativeInfrastructure).toBe(marker);
        const require = createRequire(import.meta.url);
        const serverPath = path.join(root, 'dist-server', 'handler.cjs');
        try {
          const handler = require(serverPath).default as (
            request: Request,
          ) => Response;
          const response = handler(new Request('https://renderer.test/proof'));
          expect(response.status).toBe(207);
          expect(response.headers.get('x-native-infrastructure')).toBe(
            renderer,
          );
          expect(await response.text()).toBe(`${marker}/proof`);
        } finally {
          delete require.cache[serverPath];
        }
      } finally {
        try {
          if (compiler)
            await new Promise<void>((resolve, reject) =>
              compiler!.close(error => (error ? reject(error) : resolve())),
            );
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );
});
