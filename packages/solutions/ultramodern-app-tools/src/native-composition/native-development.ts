import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';
import type { RendererBuildIdentities } from '@modern-js/app-tools-extensions/renderer-build-identity';
import type {
  NativeCompilerArtifacts,
  NativeRendererAdapter,
} from '@modern-js/renderer-core/adapter';
import {
  assertRendererIdentity,
  type Renderer,
  type RendererIdentity,
} from '@modern-js/renderer-core/identity';
import { validateNativeClientAssetManifest } from '@modern-js/renderer-core/server';
import { mime } from '@modern-js/utils';
import type { RsbuildPlugin, Rspack } from '@rsbuild/core';
import {
  createRendererBuildManifest,
  RENDERER_BUILD_MANIFEST_FILE,
  RENDERER_DEVELOPMENT_DIRECTORY,
  validateRendererDevelopmentBuildManifest,
} from './native-build-manifest';
import {
  collectNativeFederationDevAssets,
  NATIVE_FEDERATION_DEV_REVISION_HEADER,
  type NativeDevelopmentAsset,
  type NativeFederationDevGraph,
  nativeFederationDevGraph,
  nativeFederationDevRevision,
  resolveNativeFederationDevAsset,
  resolveNativeFederationDevManifest,
  retainNativeFederationDevAssets,
} from './native-federation-dev-assets';
import { nativeFederationDevHotUpdateTarget } from './native-federation-dev-public-path';
import type { NativeDevelopmentSnapshot } from './native-server-plugin';
import type { RendererBuildProfile } from './renderer-profile';
import { resolveNativeRendererAdapter } from './renderer-registration';

interface DevServerHeaderConfig {
  readonly cors?: unknown;
  readonly headers?: Readonly<Record<string, string | string[]>>;
}

interface DevCorsOptions {
  readonly origin?: unknown;
  readonly credentials?: boolean;
  readonly exposedHeaders?: string | readonly string[];
}

const allowsOrigin = (allowed: unknown, origin: string): boolean =>
  Array.isArray(allowed)
    ? allowed.some(entry => allowsOrigin(entry, origin))
    : allowed instanceof RegExp
      ? allowed.test(origin)
      : typeof allowed === 'string'
        ? allowed === origin
        : Boolean(allowed);

/**
 * Federation assets are answered before Rsbuild's own middlewares, so they
 * apply the configured `server.headers` and `server.cors` themselves, as the
 * `cors` package does: a host on another origin loads these containers and
 * chunks as module scripts.
 */
export async function applyDevServerHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  server: DevServerHeaderConfig | undefined,
): Promise<void> {
  for (const [name, value] of Object.entries(server?.headers ?? {}))
    response.setHeader(name, value);
  if (!server?.cors) return;
  const options: DevCorsOptions =
    server.cors === true ? {} : (server.cors as DevCorsOptions);
  const requestOrigin = request.headers.origin;
  let allowed: unknown = options.origin ?? '*';
  if (typeof allowed === 'function')
    allowed = await new Promise<unknown>((resolve, reject) =>
      (
        allowed as (origin: unknown, done: (...args: unknown[]) => void) => void
      )(requestOrigin, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
  if (allowed === '*') response.setHeader('Access-Control-Allow-Origin', '*');
  else {
    response.setHeader('Vary', 'Origin');
    if (typeof allowed === 'string')
      response.setHeader('Access-Control-Allow-Origin', allowed);
    else if (requestOrigin && allowsOrigin(allowed, requestOrigin))
      response.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }
  if (options.credentials === true)
    response.setHeader('Access-Control-Allow-Credentials', 'true');
  const exposed = options.exposedHeaders;
  if (exposed?.length)
    response.setHeader(
      'Access-Control-Expose-Headers',
      typeof exposed === 'string' ? exposed : exposed.join(','),
    );
}

export interface NativeDevelopmentOptions {
  readonly renderer: Exclude<Renderer, 'react'>;
  readonly profile: RendererBuildProfile;
  /** The renderer adapter to run; defaults to the registered one. */
  readonly adapter?: NativeRendererAdapter;
  readonly distDirectory: string;
  readonly getSessionIdentities: () => RendererBuildIdentities;
}

export function nativeDevelopmentOutputDirectory(
  distDirectory: string,
  name: string,
): string {
  if (
    !name ||
    name !== path.basename(name) ||
    name === '.' ||
    name === '..' ||
    ['bundles', RENDERER_BUILD_MANIFEST_FILE].includes(name)
  )
    throw new Error(
      `Unsafe or conflicting native development environment name: ${name}`,
    );
  return path.join(
    distDirectory,
    RENDERER_DEVELOPMENT_DIRECTORY,
    name === 'server' ? 'bundles' : name,
  );
}

const serverModules = createRequire(import.meta.url);

/** Read an asset from the compiler's own output filesystem. */
function emittedBytes(result: Rspack.Stats, name: string): Promise<Buffer> {
  const output = result.compilation.outputOptions.path;
  const filesystem = result.compilation.compiler.outputFileSystem;
  if (!result.compilation.getAsset(name) || !output || !filesystem)
    throw new Error(`Native compilation did not emit ${name}`);
  return new Promise((resolve, reject) => {
    filesystem.readFile(path.join(output, name), (error, bytes) => {
      if (error || !bytes)
        reject(error ?? new Error(`Missing emitted native asset ${name}`));
      else resolve(Buffer.from(bytes));
    });
  });
}

/**
 * Publishes each successful client+server dev compile: the server entry is
 * imported fresh (cache-busting query) and `.ultramodern-dev/renderer-build.json`
 * is refreshed. A save during a compile only starts another compile; requests
 * wait for the newest completed one.
 */
export class NativeDevelopment {
  readonly plugin: RsbuildPlugin;
  /** Bumped by every invalidation; a compile publishes only if still current. */
  private epoch = 0;
  private readonly compilerVersions = new WeakMap<Rspack.Compiler, number>();
  private readonly compilationVersions = new WeakMap<
    Rspack.Compilation,
    number
  >();
  private generation = 0;
  private closed = false;
  private ready: ReadonlyMap<string, NativeDevelopmentSnapshot> | undefined;
  private failure: { readonly error: unknown } | undefined;
  /** Client assets of earlier compiles stay reachable for already-open pages. */
  private readonly retained = new Map<string, NativeDevelopmentAsset>();
  /** Node containers and their chunks belong to the latest completed build. */
  private federationAssets: ReadonlyMap<string, NativeDevelopmentAsset> =
    new Map();
  private federationRevision: string | undefined;
  private federationGraph: NativeFederationDevGraph | undefined;
  /** Immutable remote closures stay available to already-open hosts. */
  private retainedFederationAssets: ReadonlyMap<
    string,
    NativeDevelopmentAsset
  > = new Map();
  private readonly mutableClientAssets = new Set(['renderer-assets.json']);
  private readonly adapter: NativeRendererAdapter;
  private readonly compilerArtifacts: NativeCompilerArtifacts;
  private readonly waiters = new Set<() => void>();
  private manifestFile: string | undefined;

  constructor(private readonly options: NativeDevelopmentOptions) {
    this.adapter =
      options.adapter ?? resolveNativeRendererAdapter(options.renderer);
    this.compilerArtifacts = this.adapter.artifacts;
    this.plugin = {
      name: `ultramodern:${options.renderer}:development`,
      setup: api => {
        this.manifestFile = path.join(
          options.distDirectory,
          RENDERER_DEVELOPMENT_DIRECTORY,
          RENDERER_BUILD_MANIFEST_FILE,
        );
        // The dev SSR handler imports the server bundle from disk.
        api.modifyEnvironmentConfig((config, { name }) =>
          name === 'server'
            ? { ...config, dev: { ...config.dev, writeToDisk: true } }
            : config,
        );
        api.modifyRspackConfig((config, { environment }) => {
          config.output ??= {};
          if (environment.name === 'server') {
            // Server chunks are imported relative to the entry; a content hash
            // keeps a fresh entry from reusing an older chunk module.
            config.output.chunkFilename = '[name].[contenthash].js';
            return;
          }
          if (environment.name !== 'client') return;
          // Publication needs the selected client graph compiled up front.
          if (config.lazyCompilation)
            config.lazyCompilation = {
              ...(config.lazyCompilation === true
                ? {}
                : config.lazyCompilation),
              entries: false,
              imports: false,
            };
          config.output.filename = '[name].[contenthash].js';
          config.output.chunkFilename = '[name].[contenthash].js';
          config.output.cssFilename = '[name].[contenthash].css';
          config.output.cssChunkFilename = '[name].[contenthash].css';
        });
        api.modifyRsbuildConfig(config => {
          config.mode = 'development';
          const previous = config.dev?.setupMiddlewares;
          const retain: NonNullable<
            NonNullable<typeof config.dev>['setupMiddlewares']
          > = middlewares => {
            middlewares.unshift((request, response, next) => {
              if (this.closed) return next();
              if (request.method !== 'GET' && request.method !== 'HEAD')
                return next();
              const pathname = URL.parse(
                request.url ?? '/',
                'http://native-dev.invalid',
              )?.pathname;
              const protocol =
                request.socket instanceof TLSSocket ? 'https:' : 'http:';
              const origin = `${protocol}//${request.headers.host}`;
              const hotUpdate =
                this.federationGraph &&
                nativeFederationDevHotUpdateTarget(
                  this.federationGraph.publicPath,
                  request.url ?? '/',
                  origin,
                );
              if (hotUpdate) {
                // Native check/apply still consumes the live compiler's actual
                // deltas. They are never admitted to immutable graph storage.
                request.url = hotUpdate;
                return next();
              }
              const federationAsset =
                resolveNativeFederationDevAsset(
                  this.federationAssets,
                  request.url ?? '/',
                  origin,
                ) ??
                (this.federationGraph &&
                  resolveNativeFederationDevManifest(
                    this.federationAssets,
                    request.url ?? '/',
                    this.federationGraph.manifest,
                  ));
              const revision = this.federationRevision;
              const asset =
                federationAsset || (pathname && this.retained.get(pathname));
              if (!asset) return next();
              applyDevServerHeaders(
                request,
                response,
                api.getNormalizedConfig().server,
              ).then(() => {
                response.setHeader('Content-Type', asset.contentType);
                response.setHeader('Content-Length', asset.bytes.length);
                response.setHeader(
                  'Cache-Control',
                  asset.immutable
                    ? 'public, max-age=31536000, immutable'
                    : 'no-store',
                );
                if (federationAsset) {
                  const graphManifest =
                    asset.graphManifest ??
                    this.federationGraph?.immutableManifest;
                  if (graphManifest)
                    response.setHeader(
                      'Link',
                      `<${graphManifest}>; rel="ultramodern-completed-graph"`,
                    );
                  const graphRevision = asset.revision ?? revision;
                  if (graphRevision)
                    response.setHeader(
                      NATIVE_FEDERATION_DEV_REVISION_HEADER,
                      graphRevision,
                    );
                  if (api.getNormalizedConfig().server.cors) {
                    const previous = response.getHeader(
                      'Access-Control-Expose-Headers',
                    );
                    const exposed = new Set(
                      [
                        ...(Array.isArray(previous)
                          ? previous
                          : String(previous ?? '').split(',')),
                        'Link',
                        NATIVE_FEDERATION_DEV_REVISION_HEADER,
                      ]
                        .map(value => value.trim())
                        .filter(Boolean),
                    );
                    response.setHeader(
                      'Access-Control-Expose-Headers',
                      [...exposed].join(','),
                    );
                  }
                }
                response.end(
                  request.method === 'HEAD' ? undefined : asset.bytes,
                );
              }, next);
            });
          };
          config.dev = {
            ...config.dev,
            setupMiddlewares: [
              retain,
              ...(Array.isArray(previous)
                ? previous
                : previous
                  ? [previous]
                  : []),
            ],
          };
        });
        api.onAfterCreateCompiler(({ compiler, environments }) => {
          for (const filename of Object.values(
            environments.client?.htmlPaths ?? {},
          ))
            this.mutableClientAssets.add(filename);
          const compilers =
            'compilers' in compiler ? compiler.compilers : [compiler];
          for (const candidate of compilers) {
            this.compilerVersions.set(candidate, 0);
            let runVersion = 0;
            const captureRun = () => {
              runVersion = this.compilerVersions.get(candidate)!;
            };
            const runHook = {
              name: 'UltraModernNativeDevelopment',
              stage: Number.NEGATIVE_INFINITY,
            };
            candidate.hooks.watchRun.tap(runHook, captureRun);
            candidate.hooks.run.tap(runHook, captureRun);
            candidate.hooks.thisCompilation.tap(
              'UltraModernNativeDevelopment',
              compilation => {
                this.compilationVersions.set(compilation, runVersion);
              },
            );
            candidate.hooks.invalid.tap('UltraModernNativeDevelopment', () => {
              this.compilerVersions.set(
                candidate,
                this.compilerVersions.get(candidate)! + 1,
              );
              this.invalidate();
            });
            candidate.hooks.failed.tap('UltraModernNativeDevelopment', error =>
              this.fail(error),
            );
          }
        });
        api.onDevCompileDone(async ({ stats }) => {
          const epoch = this.epoch;
          const results = 'stats' in stats ? stats.stats : [stats];
          if (
            this.closed ||
            results.some(result => {
              const version = this.compilationVersions.get(result.compilation);
              return (
                version === undefined ||
                version !==
                  this.compilerVersions.get(result.compilation.compiler)
              );
            })
          )
            return;
          // Rsbuild already reports compile errors; requests surface them too.
          if (stats.hasErrors())
            return this.fail(
              new Error('Native development compilation failed'),
            );
          try {
            const publication = await this.publish(stats);
            if (this.closed || epoch !== this.epoch) return;
            this.retainedFederationAssets =
              publication.retainedFederationAssets;
            this.federationAssets = new Map([
              ...publication.federationAssets,
              ...this.retainedFederationAssets,
            ]);
            this.federationRevision = publication.federationRevision;
            this.federationGraph = publication.federationGraph;
            this.ready = publication.entries;
            this.failure = undefined;
            this.notify();
          } catch (error) {
            if (this.closed || epoch !== this.epoch) return;
            this.fail(error);
            api.logger.error(
              'Native development could not load the compiled application.',
              error,
            );
          }
        });
        api.onCloseDevServer(() => this.close());
      },
    };
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  private invalidate(): void {
    if (this.closed) return;
    this.epoch++;
    this.ready = undefined;
    this.failure = undefined;
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.ready = undefined;
    this.failure = { error };
    this.notify();
  }

  async resolveSnapshot(
    identity: RendererIdentity,
    signal: AbortSignal,
  ): Promise<NativeDevelopmentSnapshot> {
    for (;;) {
      signal.throwIfAborted();
      if (this.closed) throw new Error('Native development compiler is closed');
      if (this.failure) throw this.failure.error;
      if (this.ready) {
        const snapshot = this.ready.get(identity.entryName);
        if (!snapshot)
          throw new Error(
            `Native development has no entry ${identity.entryName}`,
          );
        assertRendererIdentity(snapshot.manifest.rendererIdentity, identity);
        return snapshot;
      }
      await new Promise<void>((resolve, reject) => {
        const resumed = () => {
          signal.removeEventListener('abort', aborted);
          resolve();
        };
        const aborted = () => {
          this.waiters.delete(resumed);
          reject(signal.reason);
        };
        this.waiters.add(resumed);
        signal.addEventListener('abort', aborted, { once: true });
      });
    }
  }

  private async publish(stats: Rspack.Stats | Rspack.MultiStats): Promise<{
    readonly entries: ReadonlyMap<string, NativeDevelopmentSnapshot>;
    readonly federationAssets: ReadonlyMap<string, NativeDevelopmentAsset>;
    readonly federationRevision: string | undefined;
    readonly federationGraph: NativeFederationDevGraph | undefined;
    readonly retainedFederationAssets: ReadonlyMap<
      string,
      NativeDevelopmentAsset
    >;
  }> {
    const results = 'stats' in stats ? stats.stats : [stats];
    const client = results.find(result => result.compilation.name === 'client');
    const server = results.find(result => result.compilation.name === 'server');
    const serverRoot = server?.compilation.outputOptions.path;
    if (!client?.compilation.hash || !server?.compilation.hash || !serverRoot)
      throw new Error(
        'Native development requires completed client and server compilations',
      );
    const session = this.options.getSessionIdentities();
    const entryNames = Object.keys(session.identities);
    const federationAssets = new Map([
      ...(await collectNativeFederationDevAssets(server, entryNames, name =>
        emittedBytes(server, name),
      )),
      ...(await collectNativeFederationDevAssets(client, entryNames, name =>
        emittedBytes(client, name),
      )),
    ]);
    const federationGraph = nativeFederationDevGraph(client);
    const federationRevision = federationAssets.size
      ? nativeFederationDevRevision(federationAssets)
      : undefined;
    const retainedFederationAssets = retainNativeFederationDevAssets(
      this.retainedFederationAssets,
      new Map(
        [...federationAssets].map(([url, asset]) => [
          url,
          {
            ...asset,
            revision: federationRevision,
            graphManifest: federationGraph?.immutableManifest,
          },
        ]),
      ),
    );
    const publicPath = client.compilation.outputOptions.publicPath;
    const prefix =
      typeof publicPath === 'string' && publicPath !== 'auto'
        ? publicPath.endsWith('/')
          ? publicPath
          : `${publicPath}/`
        : '/';
    for (const asset of client.compilation.getAssets()) {
      if (
        asset.info.immutable !== true ||
        asset.info.hotModuleReplacement ||
        this.mutableClientAssets.has(asset.name) ||
        this.compilerArtifacts.isMutableDevelopmentAsset(asset.name, entryNames)
      )
        continue;
      const pathname = new URL(
        `${prefix}${asset.name}`,
        'http://native-dev.invalid',
      ).pathname;
      if (this.retained.has(pathname)) continue;
      this.retained.set(pathname, {
        bytes: await emittedBytes(client, asset.name),
        // contentType() treats a name with a slash as a MIME type, so pass
        // only the extension.
        contentType:
          mime.contentType(path.extname(asset.name)) ||
          'application/octet-stream',
      });
    }
    const assets = JSON.parse(
      (await emittedBytes(client, 'renderer-assets.json')).toString(),
    );
    const entries = new Map<string, NativeDevelopmentSnapshot>();
    for (const [entryName, identity] of Object.entries(session.identities)) {
      const { nativeManifest, hydrationBuildId } =
        await this.compilerArtifacts.validateClientManifest(
          JSON.parse(
            (
              await emittedBytes(
                client,
                this.compilerArtifacts.clientManifestFile(entryName),
              )
            ).toString(),
          ),
          identity,
          { compilationHash: client.compilation.hash, development: true },
        );
      const files = [
        ...(server.compilation.entrypoints.get(entryName)?.getEntrypointChunk()
          .files ?? []),
      ].filter(filename => /\.[cm]?js$/u.test(filename));
      if (files.length !== 1)
        throw new Error(
          `Native development entry ${entryName} requires one emitted server module`,
        );
      // Load the newest server bundle once per server compilation: ESM is
      // cached by URL (the query), CommonJS by filename (require.cache).
      const filename = path.join(serverRoot, files[0]);
      delete serverModules.cache[filename];
      const loaded = await import(
        `${pathToFileURL(filename).href}?compilation=${server.compilation.hash}`
      );
      const exported = loaded.rendererIdentity ? loaded : loaded.default;
      assertRendererIdentity(exported?.rendererIdentity, identity);
      if (
        typeof exported?.nativeRequestHandler !== 'function' ||
        typeof exported?.nativeCSRRequestHandler !== 'function'
      )
        throw new Error(
          `Native development entry ${entryName} is missing its native transport handlers`,
        );
      entries.set(entryName, {
        manifest: {
          rendererIdentity: { ...exported.rendererIdentity },
          nativeRequestHandler: exported.nativeRequestHandler,
          nativeCSRRequestHandler: exported.nativeCSRRequestHandler,
          ...(typeof exported.nativeMatchRouteIds === 'function'
            ? { nativeMatchRouteIds: exported.nativeMatchRouteIds }
            : {}),
        },
        assets: validateNativeClientAssetManifest(assets, identity),
        nativeManifest,
        ...(hydrationBuildId !== undefined ? { hydrationBuildId } : {}),
      });
    }
    const generation = ++this.generation;
    const metadata = validateRendererDevelopmentBuildManifest(
      {
        ...createRendererBuildManifest(
          this.options.profile,
          session,
          this.adapter.worker,
        ),
        devCompilation: {
          compilationHashes: Object.fromEntries(
            results.map(result => [
              result.compilation.name,
              result.compilation.hash,
            ]),
          ),
          generation,
        },
      },
      this.options.profile,
      { routerFrameworks: this.adapter.routerFrameworks },
    );
    const manifestFile = this.manifestFile!;
    const temporary = `${manifestFile}.${process.pid}.${generation}.tmp`;
    await fs.mkdir(path.dirname(manifestFile), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(metadata));
    await fs.rename(temporary, manifestFile);
    return {
      entries,
      federationAssets,
      federationGraph,
      federationRevision,
      retainedFederationAssets,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = undefined;
    this.notify();
    this.retained.clear();
    this.federationAssets = new Map();
    this.federationRevision = undefined;
    this.federationGraph = undefined;
    this.retainedFederationAssets = new Map();
    if (this.manifestFile) await fs.rm(this.manifestFile, { force: true });
  }
}
