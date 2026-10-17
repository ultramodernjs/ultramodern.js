import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppTools, CliPlugin } from '@modern-js/app-tools/cli-config';
import {
  type RendererBuildIdentities,
  rendererProfileKey,
} from '@modern-js/app-tools-extensions/renderer-build-identity';
import { SERVICE_WORKER_ENVIRONMENT_NAME } from '@modern-js/builder';
import type { RendererFederationCompatibility } from '@modern-js/federation-runtime/renderer-contract';
import type {
  BffRuntimeBuildIdentityProvider,
  WithBffRuntimeBuildIdentity,
} from '@modern-js/plugin-bff-build-extensions';
import {
  assertRendererIdentity,
  type Renderer,
  type RendererIdentity,
} from '@modern-js/renderer-core';
import type { NativeRendererAdapter } from '@modern-js/renderer-core/adapter';
import {
  type FileSystemRouteIR,
  projectFileSystemRoutes,
} from '@modern-js/renderer-core/data';
import { validateNativeClientAssetManifest } from '@modern-js/renderer-core/server';
import type { Entrypoint } from '@modern-js/types/cli/base';
import { getArgv, SERVER_BUNDLE_DIRECTORY } from '@modern-js/utils';
import { isEntryMetadataRead } from './config-read-context';
import { resolveRendererFederationCompatibility } from './module-federation-renderer-plugin';
import {
  createRendererBuildManifest,
  RENDERER_DEVELOPMENT_DIRECTORY,
  readRendererBuildManifest,
  rendererBuildCachePerformance,
  writeRendererBuildManifest,
} from './native-build-manifest';
import {
  NativeDevelopment,
  nativeDevelopmentOutputDirectory,
} from './native-development';
import { findNativeFederationConfig } from './native-federation-files';
import {
  type NativeI18nConfig,
  type NativeI18nEntry,
  resolveNativeI18nEntry,
} from './native-i18n';
import { loadNativeFederationConfig } from './native-module-federation';
import {
  isNativeWorkerBuild,
  nativeWorkerEntrySource,
  nativeWorkerEnvironment,
  writeNativeWorkerResources,
} from './native-worker';
import { resolveNativeWorkerContextProfiles } from './native-worker-context-profiles';
import {
  createNativeWorkerFederationPlan,
  type NativeWorkerFederationPlan,
} from './native-worker-federation';
import {
  type NativeWorkerFederationServiceConfig,
  resolveNativeWorkerFederationConfig,
} from './native-worker-federation-config';
import { loadNativeWorkerFederationPolicies } from './native-worker-federation-policy';
import {
  NativeWorkerFederationPublicationPlugin,
  nativeWorkerFederationManifestUrl,
} from './native-worker-publication';
import {
  type RendererBuildProfile,
  resolveCandidateRendererProfile,
  resolveRendererProfile,
} from './renderer-profile';
import {
  nativeInfrastructurePluginName,
  resolveNativeRendererAdapter,
} from './renderer-registration';
import { rendererReleaseIdentityBuilderPlugin } from './renderer-release-identity';
import { resolveSdkServerPlugin } from './server-plugin-resolution';

export interface NativeEntryGeneration {
  renderer: Exclude<Renderer, 'react'>;
  entrypoint: Entrypoint;
  appDirectory: string;
  internalDirectory: string;
  profile: RendererBuildProfile;
  rendererIdentity?: RendererIdentity;
  documentSSR: boolean;
  basePath: string;
  /** Present when the application registered the native i18nPlugin(). */
  i18n?: NativeI18nEntry;
  workerFederation?: {
    compatibility: RendererFederationCompatibility;
    services: readonly NativeWorkerFederationServiceConfig[];
    plan?: NativeWorkerFederationPlan;
    contextProfiles?: readonly string[];
  };
  modifyRoutes(routes: FileSystemRouteIR[]): Promise<FileSystemRouteIR[]>;
}

/** Native adapters own their bootstrap and server module source. */
export interface NativeEntryGenerator {
  client(context: NativeEntryGeneration): string | Promise<string>;
  server(context: NativeEntryGeneration): string | Promise<string>;
  worker?(context: NativeEntryGeneration): string | Promise<string>;
}

export interface NativeInfrastructureOptions {
  /** Localized routing and translations from the native i18nPlugin(). */
  readonly i18n?: NativeI18nConfig;
  readonly profile?: RendererBuildProfile;
  /** The renderer adapter this plugin runs; defaults to the registered one. */
  readonly adapter?: NativeRendererAdapter;
  /**
   * Receives each entry's route tree after every modifyFileSystemRoutes
   * plugin ran, the same tree the generated application uses.
   */
  onRoutes?(entryName: string, routes: readonly unknown[]): void;
  resolveBuildIdentities?(context: {
    entrypoints: readonly Entrypoint[];
    appDirectory: string;
    internalDirectory: string;
    distDirectory: string;
    packageName: string;
    pluginNames?: readonly string[];
    mode?: 'development' | 'production';
  }): Promise<RendererBuildIdentities>;
}

async function findSource(
  directory: string,
  name: string,
  extensions: readonly string[],
): Promise<string | undefined> {
  for (const extension of extensions) {
    const file = path.join(directory, `${name}${extension}`);
    try {
      if ((await fs.stat(file)).isFile()) return file;
    } catch {}
  }
  return undefined;
}

/**
 * The Node transport around an authored `index.server` Fetch handler: renderer
 * identity, RSC rejection and, for `ssrByRouteIds`, the authored route matcher.
 */
export function nativeCustomServerEntrySource(
  rendererIdentity: RendererIdentity,
  customServerEntry: string,
): string {
  const entry = JSON.stringify(customServerEntry);
  return `import { assertRendererIdentity } from '@modern-js/renderer-core/identity';
import { rejectNativeRscRequest } from '@modern-js/renderer-core/server';
import { untilAborted } from '@modern-js/renderer-core/session';
export const rendererIdentity = ${JSON.stringify(rendererIdentity)};
// A module load that stalls, as a stuck development compilation can, must
// not keep a disconnected request, its context and session alive.
const loadHandler = context => untilAborted(import(${entry}), context.session.signal);
export async function nativeRequestHandler(request, context) {
  const rejection = rejectNativeRscRequest(request);
  if (rejection) return rejection;
  assertRendererIdentity(context.entry, rendererIdentity);
  assertRendererIdentity(context.session.identity, rendererIdentity);
  const handler = await loadHandler(context);
  const execute = handler.nativeRequestHandler ?? handler.default;
  if (typeof execute !== 'function') throw new Error('The native custom server entry must export a Fetch handler');
  return execute(request, context);
}
export async function nativeCSRRequestHandler(request, context) {
  const rejection = rejectNativeRscRequest(request);
  if (rejection) return rejection;
  assertRendererIdentity(context.entry, rendererIdentity);
  assertRendererIdentity(context.session.identity, rendererIdentity);
  const handler = await loadHandler(context);
  // A CSR handler serves routes outside ssrByRouteIds; without one, the
  // authored Fetch handler renders every document itself.
  const execute = handler.nativeCSRRequestHandler ?? handler.nativeRequestHandler ?? handler.default;
  if (typeof execute !== 'function') throw new Error('The native custom server entry must export a Fetch handler');
  return execute(request, context);
}
export async function nativeMatchRouteIds(request, context) {
  assertRendererIdentity(context.entry, rendererIdentity);
  assertRendererIdentity(context.session.identity, rendererIdentity);
  const handler = await loadHandler(context);
  if (typeof handler.nativeMatchRouteIds !== 'function') throw new Error('unsupported-renderer-capability: ssrByRouteIds requires the native custom server entry to export nativeMatchRouteIds');
  return handler.nativeMatchRouteIds(request, context);
}
export default nativeRequestHandler;
`;
}

/** Own native entry discovery and generated paths through existing CLI hooks. */
export function nativeRendererInfrastructurePlugin(
  renderer: Exclude<Renderer, 'react'>,
  generator?: NativeEntryGenerator,
  options: NativeInfrastructureOptions = {},
): CliPlugin<WithBffRuntimeBuildIdentity<AppTools>> {
  const adapter = options.adapter ?? resolveNativeRendererAdapter(renderer);
  const compilerArtifacts = adapter.artifacts;
  const assertSupportedSource = adapter.assertSupportedSource;
  const serverEntries = new Map<string, string>();
  const workerEntries = new Map<string, string>();
  let buildIdentities: RendererBuildIdentities | undefined;
  let completedBuildIdentities: RendererBuildIdentities | undefined;
  let development: NativeDevelopment | undefined;
  let workerFederation: NativeEntryGeneration['workerFederation'];
  let workerFederationManifestAsset: string | undefined;
  return {
    name: nativeInfrastructurePluginName(renderer),
    post: ['@modern-js/plugin-analyze', '@modern-js/plugin-bff'],
    setup(api) {
      // Entry discovery uses the owner's generation contract before installation.
      // Operational setup still requires the selected installed provider.
      const metadataRead = isEntryMetadataRead();
      const profile =
        options.profile ??
        (metadataRead
          ? resolveCandidateRendererProfile(renderer)
          : resolveRendererProfile(renderer));
      const { appDirectory, command } = api.getAppContext();
      api.modifyBundlerChain((chain, { environment }) => {
        if (environment.name !== 'client') return;
        chain
          .plugin('ultramodern-native-worker-publication')
          .use(NativeWorkerFederationPublicationPlugin, [
            () => workerFederation?.plan,
            compilerArtifacts,
          ]);
      });

      if (
        options.resolveBuildIdentities &&
        (command === 'build' || command === 'deploy')
      ) {
        const resolveBffRuntimeBuildIdentity: BffRuntimeBuildIdentityProvider =
          async compilation => {
            if (
              compilation.appDirectory !== appDirectory ||
              api.getAppContext().appDirectory !== appDirectory
            )
              throw new Error(
                'Native BFF runtime identity requires its owning application compilation',
              );
            if (!completedBuildIdentities)
              throw new Error(
                'Native BFF runtime identity requires a completed renderer build',
              );
            return Object.freeze({
              buildMarker: completedBuildIdentities.buildId,
              sourceRevision: completedBuildIdentities.sourceRevision,
            });
          };
        api.updateAppContext({ resolveBffRuntimeBuildIdentity });
        api.onBeforeBuild(() => {
          completedBuildIdentities = undefined;
        });
      }
      if (options.resolveBuildIdentities && !metadataRead)
        api.modifyResolvedConfig(config => {
          const { command, apiOnly } = api.getAppContext();
          if (apiOnly) return config;
          // The UI unit's build marker is its renderer buildId in every bundle.
          const identity = rendererReleaseIdentityBuilderPlugin(
            () => buildIdentities,
          );
          if (command !== 'dev')
            return {
              ...config,
              builderPlugins: [...(config.builderPlugins ?? []), identity],
            };
          development ??= new NativeDevelopment({
            renderer,
            profile,
            adapter,
            get distDirectory() {
              return api.getAppContext().distDirectory;
            },
            getSessionIdentities() {
              if (!buildIdentities)
                throw new Error(
                  'Native development session identity is not prepared',
                );
              return buildIdentities;
            },
          });
          return {
            ...config,
            builderPlugins: [
              ...(config.builderPlugins ?? []),
              identity,
              development.plugin,
            ],
          };
        });
      api.checkEntryPoint(async ({ path: directory, entry }) => {
        if (entry) {
          await assertSupportedSource?.(entry);
          return { path: directory, entry };
        }
        const app = await findSource(
          directory,
          'App',
          profile.sourceExtensions,
        );
        if (app) return { path: directory, entry: app };
        const routes = path.join(directory, 'routes');
        try {
          if ((await fs.stat(routes)).isDirectory()) {
            return { path: directory, entry: routes };
          }
        } catch {}
        // The upstream fallback already recognizes ordinary JS/TS entries.
        // Native-only extensions need discovery here as well.
        const custom = await findSource(
          directory,
          'index',
          profile.sourceExtensions,
        );
        if (!custom && assertSupportedSource) {
          for (const name of ['App', 'index'])
            await assertSupportedSource(
              await findSource(directory, name, ['.jsx']),
            );
        }
        return { path: directory, entry: custom ?? false };
      });

      api.modifyEntrypoints(async ({ entrypoints }) => {
        const { internalDirectory } = api.getAppContext();
        const owned = await Promise.all(
          entrypoints.map(async entrypoint => {
            const directory =
              entrypoint.absoluteEntryDir ?? path.dirname(entrypoint.entry);
            const customServerEntry =
              entrypoint.customServerEntry ||
              (await findSource(
                directory,
                'index.server',
                profile.sourceExtensions,
              ));
            const customEntry = /^index\.[a-z]+$/u.test(
              path.basename(entrypoint.entry),
            );
            const next = {
              ...entrypoint,
              customEntry,
              isAutoMount: !customEntry,
              customServerEntry,
              internalEntry: path.join(
                internalDirectory,
                renderer,
                entrypoint.entryName,
                'index.ts',
              ),
            };
            return next;
          }),
        );
        return { entrypoints: owned };
      });

      api.generateEntryCode(async ({ entrypoints }) => {
        const {
          appDirectory,
          internalDirectory,
          distDirectory,
          packageName,
          serverRoutes,
        } = api.getAppContext();
        // Consumer entry hooks have all completed. Reconcile the owned paths
        // here so renamed, added and removed entries share this final identity
        // and compiler map, rather than the earlier discovery projection.
        serverEntries.clear();
        workerEntries.clear();
        const workerBuild = isNativeWorkerBuild(api.getNormalizedConfig());
        const federationFile =
          workerBuild && findNativeFederationConfig(appDirectory);
        const profileModules =
          api.getNormalizedConfig().deploy?.worker?.federation?.contextProfiles;
        if (
          profileModules !== undefined &&
          (!federationFile || renderer !== 'octane')
        )
          throw new Error(
            'Native Worker contextProfiles require Octane federation and a Cloudflare Worker build.',
          );
        const contextProfiles = federationFile
          ? await resolveNativeWorkerContextProfiles(
              profileModules,
              appDirectory,
            )
          : [];

        const entryBasePaths = new Map<string, string>();
        for (const entrypoint of entrypoints) {
          const directory =
            entrypoint.absoluteEntryDir ?? path.dirname(entrypoint.entry);
          entrypoint.customEntry = /^index\.[a-z]+$/u.test(
            path.basename(entrypoint.entry),
          );
          entrypoint.isAutoMount = !entrypoint.customEntry;
          entrypoint.customServerEntry ||= await findSource(
            directory,
            'index.server',
            profile.sourceExtensions,
          );
          await assertSupportedSource?.(entrypoint.entry);
          await assertSupportedSource?.(entrypoint.customServerEntry);
          if (
            federationFile &&
            (entrypoint.customEntry || entrypoint.customServerEntry)
          )
            throw new Error(
              'Native Worker federation requires generated client and server entries to own snapshot hydration and dispatch.',
            );

          const basePaths = [
            ...new Set(
              (serverRoutes ?? [])
                .filter(
                  route =>
                    route.entryName === entrypoint.entryName && !route.isApi,
                )
                .map(route => route.urlPath),
            ),
          ];
          if (options.resolveBuildIdentities && basePaths.length !== 1)
            throw new Error(
              `Native entry ${entrypoint.entryName} requires exactly one analyzed public route prefix`,
            );
          if (
            options.resolveBuildIdentities &&
            entrypoint.customEntry &&
            !entrypoint.customServerEntry
          )
            throw new Error(
              `Native custom client entry ${entrypoint.entryName} requires an explicit index.server Fetch handler for its Node transport`,
            );
          entryBasePaths.set(entrypoint.entryName, basePaths[0] ?? '/');
          entrypoint.internalEntry = path.join(
            internalDirectory,
            renderer,
            entrypoint.entryName,
            'index.ts',
          );
          serverEntries.set(
            entrypoint.entryName,
            path.join(
              path.dirname(entrypoint.internalEntry),
              'index.server.ts',
            ),
          );
          if (workerBuild)
            workerEntries.set(
              entrypoint.entryName,
              path.join(
                path.dirname(entrypoint.internalEntry),
                'index.worker.ts',
              ),
            );
        }
        if (options.resolveBuildIdentities && !isEntryMetadataRead()) {
          // One identity per build or dev session; config changes restart dev.
          buildIdentities = await options.resolveBuildIdentities({
            entrypoints: entrypoints.map(entrypoint => ({ ...entrypoint })),
            appDirectory,
            internalDirectory,
            distDirectory,
            packageName,
            pluginNames: api.getAppContext().plugins.map(plugin => plugin.name),
            ...(api.getAppContext().command === 'dev'
              ? { mode: 'development' as const }
              : {}),
          });
        }
        workerFederation = undefined;
        workerFederationManifestAsset = undefined;
        if (federationFile && !buildIdentities && !metadataRead)
          throw new Error(
            'Native Worker federation requires finalized renderer build identities.',
          );
        if (federationFile && buildIdentities) {
          if (renderer !== 'octane')
            throw new Error(
              `unsupported-renderer-capability: renderer ${renderer} has no native Worker snapshot federation transport`,
            );
          const authored = await loadNativeFederationConfig(federationFile);
          const services =
            api.getNormalizedConfig().deploy?.worker?.services ?? [];
          const remoteI18n = await loadNativeWorkerFederationPolicies({
            appDirectory,
            services,
            env: command === 'dev' ? 'development' : 'production',
          });
          const prefixes = [...new Set(entryBasePaths.values())];
          if (prefixes.length !== 1)
            throw new Error(
              'Native Worker federation requires one analyzed publication prefix.',
            );
          const resolved = resolveNativeWorkerFederationConfig({
            authored,
            appDirectory,
            identities: buildIdentities,
            services,
            i18n: options.i18n,
            basePath: prefixes[0],
            remoteI18n,
            contextProfiles,
          });
          const compatibility =
            resolveRendererFederationCompatibility(renderer);
          workerFederation = {
            compatibility,
            services: resolved.services,
            contextProfiles: resolved.contextProfiles,
            ...(resolved.publication
              ? {
                  plan: createNativeWorkerFederationPlan({
                    authored,
                    appDirectory,
                    identities: buildIdentities,
                    compatibility,
                    ...resolved.publication,
                  }),
                }
              : {}),
          };
          if (workerFederation.plan) {
            const manifest =
              typeof authored.manifest === 'object' &&
              authored.manifest !== null
                ? (authored.manifest as Record<string, unknown>)
                : {};
            const filename =
              typeof manifest.fileName === 'string' && manifest.fileName
                ? manifest.fileName
                : 'mf-manifest.json';
            const directory =
              typeof manifest.filePath === 'string' ? manifest.filePath : '';
            workerFederationManifestAsset = path.posix.join(
              directory,
              filename.endsWith('.json') ? filename : `${filename}.json`,
            );
          }
        }
        for (const entrypoint of entrypoints) {
          const context: NativeEntryGeneration = {
            renderer,
            entrypoint,
            appDirectory,
            internalDirectory,
            profile,
            basePath: entryBasePaths.get(entrypoint.entryName)!,
            ...(options.i18n
              ? {
                  i18n: resolveNativeI18nEntry(
                    options.i18n,
                    appDirectory,
                    entryBasePaths.get(entrypoint.entryName)!,
                  ),
                }
              : {}),
            rendererIdentity: buildIdentities?.identities[entrypoint.entryName],
            workerFederation,
            documentSSR: Boolean(
              api.getNormalizedConfig().server?.ssrByEntries?.[
                entrypoint.entryName
              ] ?? api.getNormalizedConfig().server?.ssr,
            ),
            async modifyRoutes(routes) {
              const exposeModules = (
                route: FileSystemRouteIR,
              ): Record<string, unknown> => ({
                ...route,
                ...route.modules,
                children: route.children.map(exposeModules),
              });
              const { routes: modified } = await api
                .getHooks()
                .modifyFileSystemRoutes.call({
                  entrypoint,
                  routes: routes.map(exposeModules) as Parameters<
                    Parameters<typeof api.modifyFileSystemRoutes>[0]
                  >[0]['routes'],
                });
              const projected = projectFileSystemRoutes(modified);
              options.onRoutes?.(entrypoint.entryName, modified);
              return projected;
            },
          };
          const client = entrypoint.customEntry
            ? `import ${JSON.stringify(entrypoint.entry)};\n`
            : generator
              ? await generator.client(context)
              : undefined;
          const server = entrypoint.customServerEntry
            ? context.rendererIdentity
              ? nativeCustomServerEntrySource(
                  context.rendererIdentity,
                  entrypoint.customServerEntry,
                )
              : `export { default } from ${JSON.stringify(entrypoint.customServerEntry)};\nexport * from ${JSON.stringify(entrypoint.customServerEntry)};\n`
            : generator
              ? await generator.server(context)
              : undefined;
          if (!client) {
            throw new Error(
              `Renderer ${renderer} has no admitted bootstrap generator for ${entrypoint.entryName}`,
            );
          }
          if (
            !server &&
            (options.resolveBuildIdentities ||
              api.getNormalizedConfig().server?.ssr)
          ) {
            throw new Error(
              `Renderer ${renderer} requires a native server handler for ${entrypoint.entryName}`,
            );
          }
          const clientPath = entrypoint.internalEntry!;
          await fs.mkdir(path.dirname(clientPath), { recursive: true });
          await fs.writeFile(clientPath, client);
          if (server) {
            await fs.writeFile(
              serverEntries.get(entrypoint.entryName)!,
              server,
            );
            const workerEntry = workerEntries.get(entrypoint.entryName);
            if (workerEntry)
              await fs.writeFile(
                workerEntry,
                entrypoint.customServerEntry
                  ? nativeWorkerEntrySource('./index.server')
                  : generator?.worker
                    ? await generator.worker(context)
                    : nativeWorkerEntrySource('./index.server'),
              );
          }
        }
      });

      if (options.resolveBuildIdentities) {
        api.modifyServerRoutes(({ routes }) => ({
          routes: routes.map(route =>
            route.entryName && !route.isApi
              ? {
                  ...route,
                  // The owning dev provider executes the immutable compiler
                  // checkpoint. Do not let the host import old production disk.
                  bundle:
                    api.getAppContext().command === 'dev'
                      ? undefined
                      : `${SERVER_BUNDLE_DIRECTORY}/${route.entryName}.js`,
                }
              : route,
          ),
        }));
      }

      api.modifyBuilderEnvironments(({ environments }) => {
        const { checkedEntries, distDirectory, command } = api.getAppContext();
        const entries = Object.fromEntries(
          [...serverEntries].filter(
            ([entryName]) =>
              !checkedEntries || checkedEntries.includes(entryName),
          ),
        );
        if (options.resolveBuildIdentities) {
          const server = environments.server;
          const authored = api.getConfig().environments?.server;
          const authoredRoot =
            typeof authored?.output?.distPath === 'string'
              ? authored.output.distPath
              : authored?.output?.distPath?.root;
          if (
            (authored?.output?.filename?.js &&
              authored.output.filename.js !== '[name].js') ||
            (authoredRoot &&
              path.resolve(api.getAppContext().appDirectory, authoredRoot) !==
                path.join(distDirectory, SERVER_BUNDLE_DIRECTORY))
          )
            throw new Error(
              'Native server entry filenames and output directory are owned by the Node transport contract',
            );
          const rspack = server?.tools?.rspack;
          if (
            rspack &&
            typeof rspack === 'object' &&
            !Array.isArray(rspack) &&
            rspack.output?.filename &&
            rspack.output.filename !== '[name].js'
          )
            throw new Error(
              'Native server entry filenames are owned by the Node transport contract',
            );
        }
        const withServer =
          options.resolveBuildIdentities && !environments.server
            ? {
                ...environments,
                server: {
                  output: { target: 'node' as const },
                  source: { entry: entries },
                  tools: { htmlPlugin: false },
                },
              }
            : environments;
        const selected = Object.fromEntries(
          Object.entries(withServer).map(([name, environment]) => {
            let selectedEnvironment = { ...environment };
            if (
              name === SERVICE_WORKER_ENVIRONMENT_NAME &&
              workerEntries.size
            ) {
              selectedEnvironment = nativeWorkerEnvironment(
                environment,
                Object.fromEntries(
                  [...workerEntries].filter(
                    ([entryName]) =>
                      !checkedEntries || checkedEntries.includes(entryName),
                  ),
                ),
              );
            } else if (
              name === 'server' ||
              name === SERVICE_WORKER_ENVIRONMENT_NAME
            ) {
              selectedEnvironment = {
                ...environment,
                source: { ...environment.source, entry: entries },
              };
              if (options.resolveBuildIdentities && name === 'server') {
                selectedEnvironment.output = {
                  ...environment.output,
                  target: 'node',
                  filename: {
                    ...environment.output?.filename,
                    js: '[name].js',
                  },
                  distPath: {
                    ...(typeof environment.output?.distPath === 'object'
                      ? environment.output.distPath
                      : {}),
                    root: path.join(distDirectory, SERVER_BUNDLE_DIRECTORY),
                    js: '',
                    jsAsync: '',
                    css: '',
                    cssAsync: '',
                  },
                };
              }
            }
            if (options.resolveBuildIdentities) {
              selectedEnvironment = {
                ...selectedEnvironment,
                performance: rendererBuildCachePerformance(
                  environment.performance,
                  renderer,
                  profile,
                  api.getNormalizedConfig().performance?.buildCache,
                ),
              };
              if (command === 'dev') {
                selectedEnvironment.output = {
                  ...selectedEnvironment.output,
                  distPath: {
                    ...(typeof selectedEnvironment.output?.distPath === 'object'
                      ? selectedEnvironment.output.distPath
                      : {}),
                    root: nativeDevelopmentOutputDirectory(distDirectory, name),
                  },
                };
              }
            }
            return [name, selectedEnvironment];
          }),
        );
        return { environments: selected };
      });

      if (options.resolveBuildIdentities) {
        api.onBeforeCreateCompiler(({ bundlerConfigs }) => {
          if (api.getAppContext().apiOnly) return;
          const server = bundlerConfigs?.find(
            config => config.name === 'server',
          );
          if (
            !server ||
            server.output?.filename !== '[name].js' ||
            server.output.path !==
              path.join(
                api.getAppContext().distDirectory,
                ...(api.getAppContext().command === 'dev'
                  ? [RENDERER_DEVELOPMENT_DIRECTORY]
                  : []),
                SERVER_BUNDLE_DIRECTORY,
              )
          )
            throw new Error(
              'Native Node transport requires its registered bundles/[name].js compiler output contract',
            );
        });
        api._internalServerPlugins(async ({ plugins }) => {
          const { command, distDirectory, apiOnly } = api.getAppContext();
          const reuseBuilt =
            command === 'serve' ||
            (command === 'deploy' &&
              getArgv().some(
                argument => argument === '--skip-build' || argument === '-s',
              ));
          if (reuseBuilt && !apiOnly) {
            const built = await readRendererBuildManifest(
              distDirectory,
              profile,
              { routerFrameworks: adapter.routerFrameworks },
            );
            buildIdentities = {
              identities: built.entries,
              buildId: built.buildId,
              profileKey: rendererProfileKey(built.profile),
              sourceRevision: built.sourceRevision,
              routerBindings: built.routerBindings,
            };
          }
          if (!buildIdentities && !apiOnly)
            throw new Error(
              'Native server plugins require resolved build identities',
            );
          const name = resolveSdkServerPlugin(
            appDirectory,
            'native-server-plugin',
            import.meta.url,
          );
          if (plugins.some(plugin => plugin.name === name)) {
            throw new Error('Duplicate native server dispatcher');
          }
          return {
            plugins: [
              ...plugins,
              {
                name,
                // The deployed server loads the renderer's runtime manifest
                // module by name, so trace it into the output.
                includeEntries: [adapter.runtime.manifest],
                options: {
                  renderer,
                  manifestModule: adapter.runtime.manifest,
                  entries: buildIdentities?.identities ?? {},
                  // Document caching stays off in dev.
                  cacheAllowed: command !== 'dev',
                  ...(command === 'dev' && !apiOnly
                    ? {
                        resolveDevelopmentSnapshot: (
                          identity: RendererIdentity,
                          signal: AbortSignal,
                        ) => {
                          if (!development)
                            throw new Error(
                              'Native development compiler authority is not registered',
                            );
                          return development.resolveSnapshot(identity, signal);
                        },
                      }
                    : {}),
                  ...(!apiOnly
                    ? {
                        assetManifestFile: 'renderer-assets.json',
                        nativeManifestFiles: Object.fromEntries(
                          Object.keys(buildIdentities!.identities).map(
                            entryName => [
                              entryName,
                              compilerArtifacts.clientManifestFile(entryName),
                            ],
                          ),
                        ),
                      }
                    : {}),
                },
              },
            ],
          };
        });
        api.onAfterBuild(async ({ stats }) => {
          if (api.getAppContext().command === 'dev') return;
          if (api.getAppContext().apiOnly) return;
          if (!buildIdentities)
            throw new Error(
              'A successful native build requires its resolved identities',
            );
          if (!stats)
            throw new Error(
              'Native build identity requires actual compiler stats',
            );
          // Rsbuild runs this hook before it rejects a failed build. Native
          // compilers skip their manifests once a compilation has errors, so
          // the compiler diagnostics are the build failure; reading the absent
          // artifacts here would replace them with an unrelated ENOENT.
          if (stats.hasErrors()) return;
          const results = 'stats' in stats ? stats.stats : [stats];
          const server = results.find(
            result => result.compilation.name === 'server',
          );
          const client = results.find(
            result => result.compilation.name === 'client',
          );
          if (!client)
            throw new Error(
              'Native build requires its actual client compilation',
            );
          const clientCompilationHash = client.compilation.hash;
          if (!clientCompilationHash)
            throw new Error(
              'Native build requires its completed client compilation hash',
            );
          if (!server)
            throw new Error(
              'Native build requires its emitted Node transport compilation',
            );
          const assets = JSON.parse(
            await fs.readFile(
              path.join(
                api.getAppContext().distDirectory,
                'renderer-assets.json',
              ),
              'utf8',
            ),
          );
          for (const [entryName, identity] of Object.entries(
            buildIdentities.identities,
          )) {
            validateNativeClientAssetManifest(assets, identity);
            const nativeManifest = JSON.parse(
              await fs.readFile(
                path.join(
                  client.compilation.outputOptions.path!,
                  compilerArtifacts.clientManifestFile(entryName),
                ),
                'utf8',
              ),
            );
            await compilerArtifacts.validateClientManifest(
              nativeManifest,
              identity,
              { compilationHash: clientCompilationHash },
            );
            const chunk = server.compilation.entrypoints
              .get(entryName)
              ?.getEntrypointChunk();
            const files = chunk
              ? [...chunk.files].filter(file => /\.[cm]?js$/u.test(file))
              : [];
            if (files.length !== 1)
              throw new Error(
                `Native server entry ${entryName} requires exactly one emitted entry module`,
              );
            if (
              path
                .relative(
                  api.getAppContext().distDirectory,
                  path.join(server.compilation.outputOptions.path!, files[0]),
                )
                .split(path.sep)
                .join('/') !== `${SERVER_BUNDLE_DIRECTORY}/${entryName}.js`
            )
              throw new Error(
                `Native Node entry ${entryName} was emitted outside its registered server route bundle`,
              );
            const module = await import(
              `${pathToFileURL(path.join(server.compilation.outputOptions.path!, files[0])).href}?build=${identity.buildId}`
            );
            const exported = module.rendererIdentity ? module : module.default;
            assertRendererIdentity(exported?.rendererIdentity, identity);
            if (
              typeof exported?.nativeRequestHandler !== 'function' ||
              typeof exported?.nativeCSRRequestHandler !== 'function'
            )
              throw new Error(
                `Native server entry ${entryName} does not export its required native transport handlers`,
              );
          }
          if (workerEntries.size) {
            const worker = results.find(
              result =>
                result.compilation.name === SERVICE_WORKER_ENVIRONMENT_NAME,
            );
            if (!worker)
              throw new Error(
                'Native Cloudflare SSR requires its emitted worker compilation',
              );
            const workerOutput = worker.compilation.outputOptions.path!;
            const manifestUrl = workerFederationManifestAsset
              ? nativeWorkerFederationManifestUrl(
                  workerFederationManifestAsset,
                  JSON.parse(
                    await fs.readFile(
                      path.join(
                        client.compilation.outputOptions.path!,
                        workerFederationManifestAsset,
                      ),
                      'utf8',
                    ),
                  ),
                )
              : undefined;

            await writeNativeWorkerResources({
              renderer,
              distDirectory: api.getAppContext().distDirectory,
              clientOutputDirectory: client.compilation.outputOptions.path!,
              metaName: api.getAppContext().metaName,
              config: api.getNormalizedConfig(),
              identities: buildIdentities.identities,
              compilerArtifacts,
              clientCompilationHash,
              ...(workerFederation
                ? {
                    workerFederation: {
                      plan: workerFederation.plan,
                      services: workerFederation.services,
                      manifestUrl,
                    },
                  }
                : {}),
              workerEntryFiles: Object.fromEntries(
                [...workerEntries.keys()].map(entryName => {
                  const chunk = worker.compilation.entrypoints
                    .get(entryName)
                    ?.getEntrypointChunk();
                  return [
                    entryName,
                    chunk
                      ? [...chunk.files]
                          .filter(file => /\.[cm]?js$/u.test(file))
                          .map(file =>
                            path
                              .relative(
                                api.getAppContext().distDirectory,
                                path.join(workerOutput, file),
                              )
                              .split(path.sep)
                              .join('/'),
                          )
                      : [],
                  ];
                }),
              ),
            });
          }
          await writeRendererBuildManifest(
            api.getAppContext().distDirectory,
            createRendererBuildManifest(
              profile,
              buildIdentities,
              adapter.worker,
            ),
          );
          completedBuildIdentities = buildIdentities;
        });
      }
    },
  };
}
