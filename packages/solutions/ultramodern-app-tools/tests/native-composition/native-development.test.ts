import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type RendererBuildIdentities,
  resolveRendererBuildIdentities,
} from '@modern-js/app-tools-extensions/renderer-build-identity';
import { findHostingModuleDirectory } from '@modern-js/app-tools-extensions/runtime-package-resolution';
import { SERVICE_WORKER_ENVIRONMENT_NAME } from '@modern-js/builder';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { createRequestSession } from '@modern-js/renderer-core/session';
import type { Entrypoint } from '@modern-js/types/cli/base';
import {
  createRsbuild,
  type RsbuildPlugin,
  type Rspack,
  rspack,
} from '@rsbuild/core';
import { afterEach, describe, expect, it } from '@rstest/core';
import { nativeClientAssetsPlugin } from '../../src/native-composition/native-assets';
import {
  RENDERER_BUILD_MANIFEST_FILE,
  RENDERER_DEVELOPMENT_DIRECTORY,
  readRendererDevelopmentBuildManifest,
} from '../../src/native-composition/native-build-manifest';
import {
  applyDevServerHeaders,
  NativeDevelopment,
  nativeDevelopmentOutputDirectory,
} from '../../src/native-composition/native-development';
import { createNativeEntryGenerator } from '../../src/native-composition/native-entry';
import {
  NATIVE_FEDERATION_DEV_REVISION_HEADER,
  NativeFederationDevAssetsPlugin,
} from '../../src/native-composition/native-federation-dev-assets';
import type { NativeDevelopmentSnapshot } from '../../src/native-composition/native-server-plugin';
import {
  type RendererBuildProfile,
  resolveCandidateRendererProfile,
  resolveRendererProfileMetadata,
} from '../../src/native-composition/renderer-profile';
import { resolveNativeRendererAdapter } from '../../src/native-composition/renderer-registration';
import { resolveEntrypointRouterBindings } from '../../src/native-composition/renderer-router-resolution';
import { nativeRendererIsolationPlugin } from '../../src/native-composition/renderer-selection';
import {
  createReplacementAdapter,
  createReplacementCompilerArtifacts,
} from './replacement-compiler-artifacts';

const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const close of closes.splice(0).reverse()) await close();
  } finally {
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), prefix),
    ),
  );
  roots.push(root);
  return root;
}

interface DevApp {
  readonly root: string;
  readonly identity: RendererIdentity;
  readonly session: RendererBuildIdentities;
  readonly profile: RendererBuildProfile;
  readonly authority: NativeDevelopment;
  readonly address: URL;
  edit(marker: string): void;
}

async function startDevServer(
  app: Omit<DevApp, 'address'>,
  rsbuildConfig: Parameters<typeof createRsbuild>[0]['rsbuildConfig'],
): Promise<DevApp> {
  const rsbuild = await createRsbuild({ cwd: app.root, rsbuildConfig });
  const dev = await rsbuild.createDevServer({ getPortSilently: true });
  closes.push(() => dev.close());
  closes.push(() => app.authority.close());
  const listening = await dev.listen();
  return { ...app, address: new URL(listening.urls[0]) };
}

async function render(app: DevApp, snapshot: NativeDevelopmentSnapshot) {
  const request = new Request(app.address);
  const session = createRequestSession({
    request,
    identity: app.identity,
    platform: {
      kind: 'node',
      bindings: { loaderContext: new Map<string, unknown>() },
    },
  });
  try {
    const response = await snapshot.manifest.nativeRequestHandler(request, {
      session,
      entry: app.identity,
      assets: snapshot.assets,
      nativeManifest: snapshot.nativeManifest,
      serverConfig: { ssr: true },
    });
    return await response.text();
  } finally {
    session.abort();
  }
}

/** Wait until the latest published compile renders the expected marker. */
async function until(app: DevApp, marker: string) {
  const deadline = Date.now() + 90_000;
  let last: unknown;
  for (;;) {
    try {
      const snapshot = await app.authority.resolveSnapshot(
        app.identity,
        AbortSignal.timeout(30_000),
      );
      const html = await render(app, snapshot);
      if (html.includes(marker)) {
        const manifest = await readRendererDevelopmentBuildManifest(
          path.join(app.root, 'dist'),
          app.profile,
          {
            routerFrameworks: [
              ...app.session.routerBindings.main.providers,
            ].map(provider => provider.framework),
          },
        );
        return { snapshot, html, manifest };
      }
      last = html;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(`Dev server never rendered ${marker}`, { cause: last });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function view(marker: string) {
  return `import './style.css';\nexport default function App() { return <main data-native-wave="${marker}">${marker}</main>; }\n`;
}

/** A real Solid or Octane app compiled by the selected native compiler. */
async function nativeApp(renderer: 'solid' | 'octane', module: boolean) {
  const root = temporaryRoot('native-dev-');
  const metadata = resolveRendererProfileMetadata(renderer);
  const dependencies: Record<string, string> = {};
  const bindings = new Map(
    metadata.frameworkPackages.map(owner => [owner.specifier, owner.directory]),
  );
  for (const specifier of new Set([
    ...bindings.keys(),
    ...Object.keys(metadata.profile.dependencies),
    '@modern-js/renderer-core',
  ])) {
    const directory =
      bindings.get(specifier) ??
      fs.realpathSync(
        path.join(
          metadata.frameworkPackages
            .map(owner =>
              findHostingModuleDirectory(specifier, owner.directory),
            )
            .find(Boolean)!,
          specifier,
        ),
      );
    const owner: { name: string; version: string } = JSON.parse(
      fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
    );
    dependencies[specifier] =
      owner.name === specifier
        ? owner.version
        : `npm:${owner.name}@${owner.version}`;
    const link = path.join(root, 'node_modules', specifier);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(directory, link, 'dir');
  }
  const packageName = `native-${renderer}-development`;
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: packageName, private: true, dependencies }),
  );
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        jsx: 'preserve',
        jsxImportSource: metadata.profile.jsxImportSource,
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
    }),
  );
  fs.mkdirSync(path.join(root, 'src'));
  const app = path.join(root, 'src', 'App.tsx');
  fs.writeFileSync(app, view('first'));
  fs.writeFileSync(
    path.join(root, 'src', 'style.css'),
    'main { color: rebeccapurple; }\n',
  );
  const internalDirectory = path.join(root, 'node_modules', '.modern-js');
  const distDirectory = path.join(root, 'dist');
  const entrypoint: Entrypoint = {
    entryName: 'main',
    entry: app,
    isAutoMount: true,
    isMainEntry: true,
  };
  const session = resolveRendererBuildIdentities({
    projectRoot: root,
    appId: packageName,
    renderer,
    profile: metadata.profile,
    mode: 'development',
    entryNames: ['main'],
    routerBindings: await resolveEntrypointRouterBindings(
      renderer,
      [entrypoint],
      [`@modern-js/renderer-${renderer}-infrastructure`],
      metadata,
    ),
  });
  const identity = session.identities.main;
  const generator = createNativeEntryGenerator(renderer);
  const context = {
    renderer,
    profile: metadata.profile,
    rendererIdentity: identity,
    appDirectory: root,
    internalDirectory,
    entrypoint,
    documentSSR: true,
    basePath: '/',
    modifyRoutes: async <T>(routes: T) => routes,
  };
  const entryDirectory = path.join(internalDirectory, renderer, 'main');
  const clientEntry = path.join(entryDirectory, 'index.ts');
  const serverEntry = path.join(entryDirectory, 'index.server.ts');
  fs.mkdirSync(entryDirectory, { recursive: true });
  fs.writeFileSync(clientEntry, await generator.client(context));
  fs.writeFileSync(serverEntry, await generator.server(context));
  const authority = new NativeDevelopment({
    renderer,
    profile: metadata.profile,
    distDirectory,
    getSessionIdentities: () => session,
  });
  return startDevServer(
    {
      root,
      identity,
      session,
      profile: metadata.profile,
      authority,
      edit: marker => fs.writeFileSync(app, view(marker)),
    },
    {
      plugins: [
        nativeRendererIsolationPlugin(renderer),
        nativeClientAssetsPlugin(
          renderer,
          () => session.identities,
          resolveNativeRendererAdapter(renderer).lazyStyles,
        ),
        resolveNativeRendererAdapter(renderer).compiler({
          rendererIdentities: () => session.identities,
          workerEnvironmentName: SERVICE_WORKER_ENVIRONMENT_NAME,
        }),
        authority.plugin,
      ],
      server: { host: '127.0.0.1', port: 0, printUrls: false },
      dev: { writeToDisk: false, hmr: true, liveReload: false },
      output: { minify: false, sourceMap: false, injectStyles: false },
      performance: { printFileSize: false },
      environments: {
        client: {
          source: { entry: { main: clientEntry } },
          output: {
            target: 'web',
            assetPrefix: '/native-assets/',
            distPath: {
              root: nativeDevelopmentOutputDirectory(distDirectory, 'client'),
            },
          },
          tools: { htmlPlugin: false },
        },
        server: {
          source: { entry: { main: serverEntry } },
          output: {
            target: 'node',
            module,
            distPath: {
              root: nativeDevelopmentOutputDirectory(distDirectory, 'server'),
            },
            filename: { js: module ? '[name].mjs' : '[name].js' },
          },
          tools: { htmlPlugin: false, rspack: { externals: [] } },
        },
      },
    },
  );
}

/** A compiler outside the registry that owns its own manifest ABI. */
async function replacementApp(module: boolean, federation = false) {
  const root = temporaryRoot('replacement-dev-');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'replacement-native-development', private: true }),
  );
  const profile = {
    ...resolveCandidateRendererProfile('solid'),
    renderer: 'replacement',
  };
  const buildId = 'a'.repeat(64);
  const identity: RendererIdentity = {
    renderer: 'replacement',
    appId: 'replacement-native-development',
    entryName: 'main',
    protocolVersion: 1,
    buildId,
  };
  const state = path.join(root, 'state.js');
  const clientEntry = path.join(root, 'client.js');
  const serverEntry = path.join(root, 'server.js');
  const widget = path.join(root, 'widget.js');
  if (federation) {
    fs.writeFileSync(
      widget,
      'import { shared } from "fixture-shared"; import image from "./widget.png"; import font from "./widget.woff2"; import wasm from "./widget.wasm"; import sourceMap from "./widget.js.map"; import config from "./private.config.ts?raw"; export const resources = { image, font, wasm, sourceMap, config }; export const marker = "first-remote" + shared; export const lazy = () => import("./remote-lazy.js");\n',
    );
    fs.writeFileSync(
      path.join(root, 'remote-lazy.js'),
      'export default "REMOTE_LAZY_CHUNK";\n',
    );
    fs.writeFileSync(
      path.join(root, 'private-lazy.js'),
      'export default "PRIVATE_SERVER_CHUNK";\n',
    );
    fs.writeFileSync(
      path.join(root, 'widget.png'),
      Buffer.from([137, 80, 78, 71]),
    );
    fs.writeFileSync(path.join(root, 'widget.woff2'), Buffer.from('wOF2'));
    fs.writeFileSync(
      path.join(root, 'widget.wasm'),
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    fs.writeFileSync(
      path.join(root, 'widget.js.map'),
      '{"sourcesContent":["PRIVATE_SOURCE"]}',
    );
    fs.writeFileSync(
      path.join(root, 'private.config.ts'),
      'export const token = "PRIVATE_CONFIG";',
    );
    fs.writeFileSync(
      path.join(root, 'shared-lib.js'),
      'export const shared = "PUBLIC_SHARED_CHUNK";\n',
    );
  }
  fs.writeFileSync(state, 'export const marker = "first";\n');
  fs.writeFileSync(
    clientEntry,
    'import { marker } from "./state.js";\nglobalThis.replacementCompilerMarker = marker;\n',
  );
  fs.writeFileSync(
    serverEntry,
    `import { marker } from "./state.js";
export const rendererIdentity = ${JSON.stringify(identity)};
export async function nativeRequestHandler(_request, context) {
  return new Response(marker + ":" + context.nativeManifest.owner);
}
export async function nativeCSRRequestHandler() { return new Response(marker); }
${federation ? 'export const privateLazy = () => import("./private-lazy.js");' : ''}
`,
  );
  const provider = { framework: 'replacement', ...profile.router };
  const session: RendererBuildIdentities = {
    identities: { main: identity },
    buildId,
    profileKey: 'b'.repeat(64),
    sourceRevision: 'workspace',
    routerBindings: {
      main: {
        owner: '@fixture/replacement-router-owner',
        evidence: 'file-routes',
        defaultProvider: provider,
        providers: [provider],
      },
    },
  };
  let poison = false;
  let serverCompilation: Rspack.Compilation | undefined;
  let clientCompiler: Rspack.Compiler | undefined;
  let beforeAggregateCompile: (() => Promise<void>) | undefined;
  let afterAggregateCompile: (() => void) | undefined;
  let duringNextCompile: (() => void) | undefined;
  const compilerArtifacts = createReplacementCompilerArtifacts();
  const authority = new NativeDevelopment({
    renderer: 'replacement',
    profile,
    adapter: createReplacementAdapter(profile, compilerArtifacts),
    distDirectory: path.join(root, 'dist'),
    getSessionIdentities: () => session,
  });
  const owner: RsbuildPlugin = {
    name: 'test-replacement-compiler',
    setup(api) {
      api.onAfterCreateCompiler(({ compiler }) => {
        clientCompiler = (
          'compilers' in compiler ? compiler.compilers : [compiler]
        ).find(candidate => candidate.options.name === 'client');
      });
      api.onDevCompileDone({
        order: 'post',
        handler: () => {
          const callback = afterAggregateCompile;
          afterAggregateCompile = undefined;
          callback?.();
        },
      });
      api.onDevCompileDone(async ({ stats }) => {
        serverCompilation = ('stats' in stats ? stats.stats : [stats]).find(
          result => result.compilation.name === 'server',
        )?.compilation;
        const callback = beforeAggregateCompile;
        beforeAggregateCompile = undefined;
        await callback?.();
      });
      api.modifyRspackConfig((config, { environment }) => {
        if (federation && environment.name === 'server') {
          config.target = 'async-node';
          config.output ??= {};
          config.output.publicPath = `http://${api.context.devServer!.hostname}:${api.context.devServer!.port}/bundles/`;
        }
        if (federation) {
          config.plugins ??= [];
          config.plugins.push(
            new rspack.container.ModuleFederationPlugin({
              name: 'test_remote',
              filename: 'remoteEntry.js',
              library: {
                type: environment.name === 'server' ? 'commonjs-module' : 'var',
                name: 'test_remote',
              },
              exposes: { './Widget': widget },
              shared: {
                'fixture-shared': {
                  import: path.join(root, 'shared-lib.js'),
                  version: '1.0.0',
                  requiredVersion: false,
                },
              },
            }),
          );
          if (environment.name === 'server')
            config.plugins.push(
              new NativeFederationDevAssetsPlugin('test_remote'),
            );
          config.module ??= {};
          config.module.rules ??= [];
          config.module.rules.push({
            oneOf: [
              {
                test: /\.config\.ts$/u,
                type: 'asset/resource',
                generator: { filename: 'resources/config.png' },
              },
              {
                test: /\.map$/u,
                type: 'asset/resource',
                generator: { filename: 'resources/source.png' },
              },
              {
                test: /\.(?:png|woff2|wasm)$/u,
                type: 'asset/resource',
                generator: { filename: 'resources/[name][ext]' },
              },
            ],
          });
        }
        if (environment.name !== 'client') return;
        config.plugins ??= [];
        config.plugins.push({
          apply(compiler) {
            compiler.hooks.thisCompilation.tap('ReplacementCompiler', current =>
              current.hooks.processAssets.tap(
                {
                  name: 'ReplacementCompiler',
                  stage: rspack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
                },
                () => {
                  const during = duringNextCompile;
                  duringNextCompile = undefined;
                  during?.();
                  const manifest = {
                    abi: 'replacement-compiler/v1',
                    owner: 'replacement-compiler',
                    build: {
                      identity: poison
                        ? { ...identity, buildId: 'foreign-build' }
                        : identity,
                      hydrationBuildId: current.hash,
                    },
                  };
                  current.emitAsset(
                    'compiled-artifacts/main.replacement.json',
                    new rspack.sources.RawSource(JSON.stringify(manifest)),
                    { immutable: false },
                  );
                  if (federation)
                    current.emitAsset(
                      'mf-manifest.json',
                      new rspack.sources.RawSource(
                        JSON.stringify({ compilationHash: current.hash }),
                      ),
                      { immutable: false },
                    );
                },
              ),
            );
          },
        });
      });
    },
  };
  const app = await startDevServer(
    {
      root,
      identity,
      session,
      profile,
      authority,
      edit: marker =>
        fs.writeFileSync(
          state,
          `export const marker = ${JSON.stringify(marker)};\n`,
        ),
    },
    {
      plugins: [
        nativeClientAssetsPlugin(
          'replacement',
          () => session.identities,
          'renderer',
        ),
        owner,
        authority.plugin,
      ],
      server: { host: '127.0.0.1', port: 0, printUrls: false },
      dev: {
        assetPrefix: '/replacement-assets/',
        writeToDisk: false,
        hmr: true,
        liveReload: false,
      },
      output: { minify: false, sourceMap: false },
      performance: { printFileSize: false },
      environments: {
        client: {
          source: { entry: { main: clientEntry } },
          output: {
            target: 'web',
            assetPrefix: '/replacement-assets/',
            distPath: {
              root: nativeDevelopmentOutputDirectory(
                path.join(root, 'dist'),
                'client',
              ),
            },
          },
          tools: { htmlPlugin: false },
        },
        server: {
          source: { entry: { main: serverEntry } },
          output: {
            target: 'node',
            module,
            distPath: {
              root: nativeDevelopmentOutputDirectory(
                path.join(root, 'dist'),
                'server',
              ),
            },
            filename: { js: module ? '[name].mjs' : '[name].js' },
          },
          tools: { htmlPlugin: false, rspack: { externals: [] } },
        },
      },
    },
  );
  return {
    ...app,
    serverCompilation() {
      if (!serverCompilation)
        throw new Error('No completed server compilation');
      return serverCompilation;
    },
    removeFederatedImport() {
      fs.writeFileSync(widget, 'export const marker = "second-remote";\n');
      app.edit('second');
    },
    editRemoteLazy(marker: string) {
      fs.writeFileSync(
        path.join(root, 'remote-lazy.js'),
        `export default ${JSON.stringify(marker)};\n`,
      );
    },
    beforeNextAggregateCompile(callback: () => Promise<void>) {
      beforeAggregateCompile = callback;
    },
    afterNextAggregateCompile(callback: () => void) {
      afterAggregateCompile = callback;
    },
    invalidateClient() {
      if (!clientCompiler?.watching)
        throw new Error('No watching client compiler');
      clientCompiler.watching.invalidate();
    },
    async startInvalidatedClientRun() {
      if (!clientCompiler) throw new Error('No client compiler');
      // Exercise the actual invalid/watchRun callbacks while an aggregate
      // callback still holds the previous Stats, without blocking Rspack's
      // scheduler on a second compile inside its awaited done hook.
      clientCompiler.hooks.invalid.call(undefined, Date.now());
      await clientCompiler.hooks.watchRun.promise(clientCompiler);
    },
    compilerArtifacts,
    poison(value: boolean) {
      poison = value;
    },
    /** Run `callback` while the next client compile is in flight. */
    duringNextCompile(callback: () => void) {
      duringNextCompile = callback;
    },
  };
}

describe('native development asset headers', () => {
  const answer = async (cors: unknown, origin?: string) => {
    const headers = new Map<string, unknown>();
    await applyDevServerHeaders(
      { headers: origin ? { origin } : {} } as never,
      {
        setHeader: (name: string, value: unknown) =>
          headers.set(name.toLowerCase(), value),
      } as never,
      { cors, headers: { 'x-dev': 'yes' } },
    );
    return Object.fromEntries(headers);
  };

  it('applies server.headers and the cors origin policy', async () => {
    const local = /^https?:\/\/localhost(?::\d+)?$/u;
    expect(await answer({ origin: local }, 'http://localhost:3030')).toEqual({
      'x-dev': 'yes',
      vary: 'Origin',
      'access-control-allow-origin': 'http://localhost:3030',
    });
    expect(
      await answer({ origin: local }, 'https://elsewhere.example'),
    ).toEqual({ 'x-dev': 'yes', vary: 'Origin' });
    expect(await answer(true, 'https://elsewhere.example')).toMatchObject({
      'access-control-allow-origin': '*',
    });
    expect(
      await answer(
        {
          origin: (
            origin: string,
            done: (error: null, value: boolean) => void,
          ) => done(null, origin.endsWith('.example')),
          credentials: true,
          exposedHeaders: ['x-a', 'x-b'],
        },
        'https://app.example',
      ),
    ).toMatchObject({
      'access-control-allow-origin': 'https://app.example',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-a,x-b',
    });
    expect(await answer(false, 'http://localhost:3030')).toEqual({
      'x-dev': 'yes',
    });
  });
});

describe('native development', () => {
  it('refreshes stable browser federation files and publishes the completed server graph revision', async () => {
    const app = await replacementApp(false, true);
    await until(app, 'first:replacement-compiler');
    const entryUrl = new URL('/bundles/remoteEntry.js', app.address);
    const manifestUrl = new URL(
      '/replacement-assets/mf-manifest.json',
      app.address,
    );
    const browserEntryUrl = new URL(
      '/replacement-assets/remoteEntry.js',
      app.address,
    );
    const first = await fetch(entryUrl, { method: 'HEAD' });
    const revision = first.headers.get(NATIVE_FEDERATION_DEV_REVISION_HEADER);
    expect(revision).toMatch(/^[a-f0-9]{64}$/u);
    const firstManifest = await (await fetch(manifestUrl)).text();
    const firstBrowserEntry = await (await fetch(browserEntryUrl)).text();
    const completed = Promise.withResolvers<void>();
    app.afterNextAggregateCompile(() => completed.resolve());
    app.editRemoteLazy('REMOTE_LAZY_SECOND');
    await completed.promise;
    const latest = await fetch(entryUrl, { method: 'HEAD' });
    const latestRevision = latest.headers.get(
      NATIVE_FEDERATION_DEV_REVISION_HEADER,
    );
    expect(latestRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(latestRevision).not.toBe(revision);
    expect(
      (await fetch(entryUrl)).headers.get(
        NATIVE_FEDERATION_DEV_REVISION_HEADER,
      ),
    ).toBe(latestRevision);
    expect(await (await fetch(manifestUrl)).text()).not.toBe(firstManifest);
    expect(await (await fetch(browserEntryUrl)).text()).not.toBe(
      firstBrowserEntry,
    );
  }, 300_000);

  it('discards an old aggregate done callback after a sibling starts another compile', async () => {
    const app = await replacementApp(false, true);
    await until(app, 'first:replacement-compiler');
    const entryUrl = new URL('/bundles/remoteEntry.js', app.address);
    const firstEntry = await fetch(entryUrl);
    const firstRevision = firstEntry.headers.get(
      NATIVE_FEDERATION_DEV_REVISION_HEADER,
    );
    const firstBytes = Buffer.from(await firstEntry.arrayBuffer());
    const aggregateReached = Promise.withResolvers<void>();
    const publicationReached = Promise.withResolvers<void>();
    const resumePublication = Promise.withResolvers<void>();
    const abort = new AbortController();
    let resolved = false;
    let snapshot: Promise<unknown> | undefined;
    try {
      app.beforeNextAggregateCompile(async () => {
        await app.startInvalidatedClientRun();
        snapshot = app.authority
          .resolveSnapshot(app.identity, abort.signal)
          .then(() => {
            resolved = true;
          });
      });
      app.afterNextAggregateCompile(() => aggregateReached.resolve());
      app.editRemoteLazy('REMOTE_LAZY_CONCURRENT');
      app.edit('stale');
      await aggregateReached.promise;
      expect(resolved).toBe(false);
      app.beforeNextAggregateCompile(async () => {
        publicationReached.resolve();
        await resumePublication.promise;
      });
      const entryRequest = fetch(entryUrl);
      app.invalidateClient();
      await publicationReached.promise;
      // The web compilation is finished while native publication is held.
      // Concurrent requests still see the last completed graph and revision.
      const retained = await entryRequest;
      expect(retained.headers.get(NATIVE_FEDERATION_DEV_REVISION_HEADER)).toBe(
        firstRevision,
      );
      expect(
        Buffer.compare(Buffer.from(await retained.arrayBuffer()), firstBytes),
      ).toBe(0);
      expect(resolved).toBe(false);
      resumePublication.resolve();
      await until(app, 'stale:replacement-compiler');
      await snapshot;
      expect(resolved).toBe(true);
      const latest = await fetch(entryUrl);
      expect(
        latest.headers.get(NATIVE_FEDERATION_DEV_REVISION_HEADER),
      ).not.toBe(firstRevision);
      const latestBytes = Buffer.from(await latest.arrayBuffer());
      expect(
        Buffer.compare(
          latestBytes,
          fs.readFileSync(
            path.join(
              app.serverCompilation().outputOptions.path!,
              'remoteEntry.js',
            ),
          ),
        ),
      ).toBe(0);
      expect(Buffer.compare(latestBytes, firstBytes)).not.toBe(0);
    } finally {
      resumePublication.resolve();
      abort.abort();
      await snapshot?.catch(() => {});
    }
  }, 300_000);

  it('publishes only the latest Node federation graph and stops publishing when closed', async () => {
    const app = await replacementApp(false, true);
    await until(app, 'first:replacement-compiler');
    const compilation = app.serverCompilation();
    // Read the compilation before any request: a later rebuild replaces it.
    const emitted = compilation.getAssets().map(asset => asset.name);
    const chunks = compilation.entrypoints
      .get('test_remote')!
      .getEntrypointChunk()
      .getAllReferencedChunks();
    const names = new Set([
      ...chunks.flatMap(chunk => [...chunk.files]),
      ...chunks
        .flatMap(chunk => [...chunk.auxiliaryFiles])
        .filter(name => /resources\/widget\.(?:png|woff2|wasm)$/u.test(name)),
    ]);
    expect(names.has('remoteEntry.js')).toBe(true);
    for (const extension of ['png', 'woff2', 'wasm'])
      expect([...names].some(name => name.endsWith(`.${extension}`))).toBe(
        true,
      );
    const lazy = [...names].find(name =>
      fs
        .readFileSync(path.join(compilation.outputOptions.path!, name), 'utf8')
        .includes('REMOTE_LAZY_CHUNK'),
    );
    expect(lazy).toBeDefined();
    expect(
      [...names].some(
        name =>
          /\.js$/u.test(name) &&
          fs
            .readFileSync(
              path.join(compilation.outputOptions.path!, name),
              'utf8',
            )
            .includes('PUBLIC_SHARED_CHUNK'),
      ),
    ).toBe(true);
    for (const name of names) {
      const response = await fetch(
        new URL(`/bundles/${name}?build=first`, app.address),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(
        /javascript|image\/png|font\/woff2|application\/wasm/u,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        fs.readFileSync(path.join(compilation.outputOptions.path!, name)),
      );
    }
    const head = await fetch(new URL('/bundles/remoteEntry.js', app.address), {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(head.headers.get(NATIVE_FEDERATION_DEV_REVISION_HEADER)).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
    // Answered before Rsbuild's middlewares, the assets still carry its CORS
    // policy, so a host page on another local origin can load them.
    for (const [origin, allowed] of [
      ['http://localhost:3030', 'http://localhost:3030'],
      ['https://elsewhere.example', null],
    ] as const) {
      const crossOrigin = await fetch(
        new URL('/bundles/remoteEntry.js', app.address),
        { headers: { origin } },
      );
      expect(crossOrigin.headers.get('access-control-allow-origin')).toBe(
        allowed,
      );
      expect(crossOrigin.headers.get('vary')).toMatch(/origin/iu);
    }
    const privateNames = emitted.filter(name => !names.has(name));
    expect(privateNames.some(name => name === 'main.js')).toBe(true);
    expect(privateNames).toContain('resources/config.png');
    expect(privateNames).toContain('resources/source.png');
    expect(
      privateNames.some(
        name =>
          /\.js$/u.test(name) &&
          fs
            .readFileSync(
              path.join(compilation.outputOptions.path!, name),
              'utf8',
            )
            .includes('PRIVATE_SERVER_CHUNK'),
      ),
    ).toBe(true);
    for (const name of [
      ...privateNames,
      'renderer-build.json',
      'module-federation.config.ts',
    ])
      expect(
        (await fetch(new URL(`/bundles/${name}`, app.address))).status,
      ).toBe(404);

    app.removeFederatedImport();
    await until(app, 'second:replacement-compiler');
    expect((await fetch(new URL(`/bundles/${lazy}`, app.address))).status).toBe(
      404,
    );
    const latest = await fetch(new URL('/bundles/remoteEntry.js', app.address));
    expect(latest.status).toBe(200);
    expect(Buffer.from(await latest.arrayBuffer())).toEqual(
      fs.readFileSync(
        path.join(
          app.serverCompilation().outputOptions.path!,
          'remoteEntry.js',
        ),
      ),
    );
    await app.authority.close();
    expect(
      (await fetch(new URL('/bundles/remoteEntry.js', app.address))).status,
    ).toBe(404);
  }, 300_000);

  it.each([
    ['CommonJS', false],
    ['ESM', true],
  ])(
    'imports the newest %s server bundle after every compile',
    async (_format, module) => {
      const app = await replacementApp(module);
      const first = await until(app, 'first:replacement-compiler');
      expect(first.manifest.entries).toEqual(app.session.identities);
      expect(first.manifest.buildId).toBe(app.session.buildId);
      expect(first.snapshot.hydrationBuildId).toBe(
        first.manifest.devCompilation.compilationHashes.client,
      );
      const script = first.snapshot.assets.find(
        asset => asset.kind === 'script' && /\/main\./u.test(asset.href),
      );
      if (!script) throw new Error('The first compile emitted no script');
      const firstScript = Buffer.from(
        await (await fetch(new URL(script.href, app.address))).arrayBuffer(),
      );

      app.edit('second');
      const second = await until(app, 'second:replacement-compiler');
      expect(second.manifest.devCompilation.generation).toBeGreaterThan(
        first.manifest.devCompilation.generation,
      );
      expect(second.manifest.buildId).toBe(first.manifest.buildId);
      expect(
        second.snapshot.assets.find(
          asset => asset.kind === 'script' && /\/main\./u.test(asset.href),
        )?.href,
      ).not.toBe(script.href);
      // Pages opened before the edit still load their own scripts.
      const retained = await fetch(new URL(script.href, app.address));
      expect(retained.status).toBe(200);
      expect(
        retained.headers.get(NATIVE_FEDERATION_DEV_REVISION_HEADER),
      ).toBeNull();
      expect(Buffer.from(await retained.arrayBuffer())).toEqual(firstScript);

      // Saving during a compile just leads to another compile. The failure
      // is recorded directly: the next compile would clear it before a poll.
      const failures: unknown[] = [];
      const authority = app.authority as unknown as {
        fail(error: unknown): void;
      };
      const fail = authority.fail.bind(app.authority);
      authority.fail = error => {
        failures.push(error);
        fail(error);
      };
      let savedMidCompile = false;
      app.duringNextCompile(() => {
        app.edit('mid');
        savedMidCompile = true;
      });
      app.edit('third');
      await until(app, 'mid:replacement-compiler');
      expect(savedMidCompile).toBe(true);
      expect(failures).toEqual([]);
    },
    300_000,
  );

  it('rejects a mismatched compiler manifest and recovers on the next save', async () => {
    const app = await replacementApp(true);
    await until(app, 'first:replacement-compiler');
    app.poison(true);
    app.edit('rejected');
    await expect(
      (async () => {
        for (;;) {
          await app.authority.resolveSnapshot(
            app.identity,
            AbortSignal.timeout(30_000),
          );
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      })(),
    ).rejects.toThrow(/identity/iu);
    app.poison(false);
    app.edit('recovered');
    await until(app, 'recovered:replacement-compiler');
  }, 300_000);

  it('stops serving and removes its dev manifest when closed', async () => {
    const app = await replacementApp(true);
    await until(app, 'first:replacement-compiler');
    const manifest = path.join(
      app.root,
      'dist',
      RENDERER_DEVELOPMENT_DIRECTORY,
      RENDERER_BUILD_MANIFEST_FILE,
    );
    expect(fs.existsSync(manifest)).toBe(true);
    await app.authority.close();
    await expect(
      app.authority.resolveSnapshot(app.identity, AbortSignal.timeout(1_000)),
    ).rejects.toThrow(/closed/iu);
    expect(fs.existsSync(manifest)).toBe(false);
  }, 300_000);

  it.each([
    ['solid', false],
    ['octane', true],
  ] as const)(
    'server-renders each %s edit with the native compiler',
    async (renderer, module) => {
      const app = await nativeApp(renderer, module);
      const first = await until(app, 'first');
      expect(first.manifest.entries).toEqual(app.session.identities);
      expect(first.snapshot.manifest.rendererIdentity).toEqual(app.identity);
      app.edit(`${renderer}-second`);
      const second = await until(app, `${renderer}-second`);
      expect(second.manifest.devCompilation.generation).toBeGreaterThan(
        first.manifest.devCompilation.generation,
      );
      if (renderer === 'octane')
        expect(second.snapshot.hydrationBuildId).toBe(
          second.manifest.devCompilation.compilationHashes.client,
        );
    },
    300_000,
  );
});
