import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppTools, CliPlugin } from '@modern-js/app-tools';
import type { Renderer } from '@modern-js/renderer-core';
import type { NativeRendererFederation } from '@modern-js/renderer-core/adapter';
import { SERVER_BUNDLE_DIRECTORY } from '@modern-js/utils';
import { type Rspack, rspack } from '@rsbuild/core';
import { resolveManifestRecoveryRuntimePlugin } from '../renderers/react/module-federation-recovery-plugin';
import { NATIVE_MODULE_FEDERATION_PLUGIN } from './module-federation-renderer-plugin';
import {
  NATIVE_FEDERATION_DEV_REVISION_HEADER,
  NativeFederationDevAssetsPlugin,
} from './native-federation-dev-assets';
import { resolveNativeFederationDevPublicPath } from './native-federation-dev-public-path';
import { findNativeFederationConfig } from './native-federation-files';
import { isNativeWorkerBuild } from './native-worker';
import { resolveNativeRendererAdapter } from './renderer-registration';

export {
  findNativeFederationConfig,
  NATIVE_FEDERATION_CONFIG_FILES,
} from './native-federation-files';

/** Chain keys shared with the React MF plugin, so publication stamping applies. */
export const NATIVE_FEDERATION_CHAIN_KEY = 'plugin-module-federation';

/** The Node container format a server-rendering host loads over HTTP. */
export const NATIVE_SERVER_CONTAINER_TYPE = 'commonjs-module';

type NativeRenderer = Exclude<Renderer, 'react'>;
type FederationOptions = Record<string, unknown>;
type NativeFederationEnvironment = 'client' | 'server';

interface NativeSharedOwner {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly exports: unknown;
}

export interface NativeSharedBindings {
  readonly versions: Readonly<Record<string, string>>;
  readonly imports: Readonly<Record<string, string>>;
  readonly aliases: Readonly<Record<string, string>>;
}

/** The selected adapter's federation descriptor and its bootstrap package. */
function nativeFederationProfile(renderer: NativeRenderer) {
  const adapter = resolveNativeRendererAdapter(renderer);
  if (!adapter.federation)
    throw federationError(`renderer ${renderer} has no federation profile.`);
  return { ...adapter.federation, bootstrap: adapter.runtime.bootstrap };
}

/** Options the native renderer owns; a config cannot replace them. */
const OWNED_OPTIONS = ['library', 'remoteType', 'runtime'] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const federationError = (message: string): Error =>
  new Error(`Native Module Federation: ${message}`);

/** Remote request prefixes, keyed by alias, for `name@url` manifest remotes. */
export function readNativeFederationRemotes(
  options: FederationOptions,
): Readonly<Record<string, string>> {
  const remotes = options.remotes;
  if (remotes === undefined) return {};
  if (!Array.isArray(remotes) && !record(remotes))
    throw federationError('remotes must be a record or an array.');
  const entries: [string, unknown][] = Array.isArray(remotes)
    ? remotes.map(remote => {
        if (typeof remote !== 'string')
          throw federationError('array remotes must be name@url strings.');
        return [remote.slice(0, remote.indexOf('@')), remote];
      })
    : Object.entries(remotes);
  // A valid alias such as `__proto__` must stay an own entry.
  const result: Record<string, string> = Object.create(null);
  for (const [alias, remote] of entries) {
    const entry =
      typeof remote === 'string'
        ? remote
        : record(remote) && typeof remote.entry === 'string'
          ? `${String(remote.name ?? alias)}@${remote.entry}`
          : undefined;
    const separator = entry?.indexOf('@') ?? -1;
    const url = entry && separator > 0 ? entry.slice(separator + 1) : '';
    if (!alias || !/^[a-z0-9_@][\w@./-]*$/iu.test(alias))
      throw federationError(`remote alias ${alias} is not a module request.`);
    if (
      !/^(?:https?:)?\/\/[^?#]+\.json(?:[?#].*)?$|^\/[^?#]*\.json$/u.test(url)
    )
      throw federationError(
        `remote ${alias} must name its native manifest (name@https://host/mf-manifest.json); direct remote entries skip renderer admission.`,
      );
    result[alias] = entry!;
  }
  return result;
}

export async function loadNativeFederationConfig(
  file: string,
): Promise<FederationOptions> {
  const version = fs.statSync(file).mtimeMs;
  const module = await import(`${pathToFileURL(file).href}?mtime=${version}`);
  let value: unknown = module.default ?? module;
  if (typeof value === 'function') value = await value();
  if (!record(value))
    throw federationError(
      `${path.basename(file)} must default-export Module Federation options.`,
    );
  if (typeof value.name !== 'string' || !value.name)
    throw federationError('options require a container name.');
  for (const key of OWNED_OPTIONS)
    if (value[key] !== undefined)
      throw federationError(
        `${key} is owned by the native renderer output format; remove it.`,
      );
  if (record(value.experiments) && 'asyncStartup' in value.experiments)
    throw federationError(
      'experiments.asyncStartup is owned by the native renderer bootstrap.',
    );
  if (value.manifest === false)
    throw federationError(
      'renderer components require native manifest publication.',
    );
  readNativeFederationRemotes(value);
  return value;
}

/** The package that owns a share key, e.g. `@scope/name` for `@scope/name/sub/`. */
export function sharedPackageName(key: string): string {
  const parts = key.split('/');
  return parts.slice(0, key.startsWith('@') ? 2 : 1).join('/');
}

/** Read the installed version by Node's node_modules lookup, ignoring exports. */
function installedPackageOwner(
  name: string,
  from: readonly string[],
): NativeSharedOwner | undefined {
  for (const base of from)
    for (let directory = base; ; directory = path.dirname(directory)) {
      const manifest = path.join(
        directory,
        'node_modules',
        name,
        'package.json',
      );
      if (fs.existsSync(manifest)) {
        const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (
          typeof installed.version === 'string' &&
          typeof installed.name === 'string'
        )
          return {
            directory: path.dirname(fs.realpathSync(manifest)),
            name: installed.name,
            version: installed.version,
            exports: installed.exports,
          };
      }
      if (path.dirname(directory) === directory) break;
    }
  return undefined;
}

function nativeSharedRequests(
  profile: NativeRendererFederation,
  environment?: NativeFederationEnvironment,
): string[] {
  return [
    ...new Set(
      [
        ...profile.shared,
        ...Object.keys(profile.sharedByEnvironment?.client ?? {}),
        ...Object.keys(profile.sharedByEnvironment?.server ?? {}),
      ].filter(
        name =>
          environment === undefined ||
          profile.shared.includes(name) ||
          Object.hasOwn(profile.sharedByEnvironment?.[environment] ?? {}, name),
      ),
    ),
  ];
}

/** The selected bootstrap and router own the packages whose state is shared. */
function resolveNativeSharedOwners(
  renderer: NativeRenderer,
  appDirectory: string,
): Readonly<Record<string, NativeSharedOwner>> {
  const profile = nativeFederationProfile(renderer);
  const bootstrap = installedPackageOwner(profile.bootstrap, [appDirectory]);
  const from = [...(bootstrap ? [bootstrap.directory] : []), appDirectory];
  const adapter = resolveNativeRendererAdapter(renderer);
  const router =
    adapter.profile.router.name === profile.bootstrap
      ? bootstrap
      : installedPackageOwner(adapter.profile.router.name, from);
  const routerFrom = router ? [router.directory, ...from] : from;
  const core = installedPackageOwner(
    adapter.profile.router.coreName,
    routerFrom,
  );
  const owners: Record<string, NativeSharedOwner> = {};
  for (const key of nativeSharedRequests(profile)) {
    const name = sharedPackageName(key);
    const owner =
      name === adapter.profile.router.coreName
        ? core
        : name === profile.bootstrap
          ? bootstrap
          : installedPackageOwner(
              name,
              name === '@tanstack/history' && core
                ? [core.directory, ...routerFrom]
                : from,
            );
    if (!owner)
      throw federationError(
        `cannot find the installed ${name} that ${renderer} shares.`,
      );
    owners[name] = owner;
  }
  return owners;
}

/** Installed versions for all required providers, including both native targets. */
export function resolveNativeSharedVersions(
  renderer: NativeRenderer,
  appDirectory: string,
): Readonly<Record<string, string>> {
  const profile = nativeFederationProfile(renderer);
  const owners = resolveNativeSharedOwners(renderer, appDirectory);
  return Object.fromEntries(
    nativeSharedRequests(profile).map(name => [
      name,
      owners[sharedPackageName(name)].version,
    ]),
  );
}

function hasRuntimeExport(
  value: unknown,
  conditions: ReadonlySet<string>,
): boolean {
  if (typeof value === 'string') return true;
  if (Array.isArray(value))
    return value.some(target => hasRuntimeExport(target, conditions));
  if (!record(value)) return false;
  return Object.entries(value).some(
    ([condition, target]) =>
      (condition === 'default' || conditions.has(condition)) &&
      hasRuntimeExport(target, conditions),
  );
}

/** Resolve the actual ESM providers and their canonical requests from one owner. */
export function resolveNativeSharedBindings(
  renderer: NativeRenderer,
  appDirectory: string,
  environment: NativeFederationEnvironment,
  configuration: Rspack.Configuration = {},
): NativeSharedBindings {
  const profile = nativeFederationProfile(renderer);
  const owners = resolveNativeSharedOwners(renderer, appDirectory);
  const normalized = rspack.config.getNormalizedRspackOptions({
    ...configuration,
    context: appDirectory,
    target:
      configuration.target ?? (environment === 'server' ? 'async-node' : 'web'),
  });
  rspack.config.applyRspackOptionsDefaults(normalized);
  const { byDependency, ...base } = normalized.resolve;
  const esm = rspack.util.cleverMerge(base, byDependency?.esm ?? {});
  const resolver = new rspack.experiments.resolver.ResolverFactory({
    conditionNames: esm.conditionNames,
    extensions: esm.extensions,
    mainFields: esm.mainFields,
    mainFiles: esm.mainFiles,
    exportsFields: esm.exportsFields,
    symlinks: true,
  });
  const conditions = new Set<string>(esm.conditionNames);
  const versions: Record<string, string> = {};
  const imports: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  const overrides = profile.sharedByEnvironment?.[environment] ?? {};
  const resolve = (request: string): string => {
    const canonical = sharedPackageName(request);
    const owner = owners[canonical];
    if (!owner)
      throw federationError(`native import ${request} has no selected owner.`);
    const physicalRequest = `${owner.name}${request.slice(canonical.length)}`;
    const resolved = resolver.sync(owner.directory, physicalRequest);
    if (!resolved.path)
      throw federationError(
        `native import ${request} has no ESM implementation.`,
      );
    return resolved.path;
  };
  for (const key of nativeSharedRequests(profile, environment)) {
    const owner = owners[sharedPackageName(key)];
    versions[key] = owner.version;
    if (key.endsWith('/')) {
      // Prefix shares consume optional subpaths when present. Anchor those
      // requests to the same physical package without forcing optional APIs.
      if (record(owner.exports))
        for (const [subpath, target] of Object.entries(owner.exports)) {
          if (
            !subpath.startsWith('./') ||
            !hasRuntimeExport(target, conditions)
          )
            continue;
          if (subpath.includes('*'))
            throw federationError(
              `singleton ${key} must publish exact runtime exports.`,
            );
          const request = `${sharedPackageName(key)}${subpath.slice(1)}`;
          aliases[`${request}$`] = resolve(overrides[request] ?? request);
        }
      continue;
    }
    imports[key] = resolve(overrides[key] ?? key);
    aliases[`${key}$`] = imports[key];
  }
  return { versions, imports, aliases };
}

/** Keep compiler imports and MF provider factories on the selected ESM graph. */
export class NativeFederationSharedOwnersPlugin {
  constructor(
    private readonly renderer: NativeRenderer,
    private readonly appDirectory: string,
    private readonly environment: NativeFederationEnvironment,
    private readonly bindings: NativeSharedBindings,
  ) {}

  apply(compiler: Rspack.Compiler): void {
    const owned = nativeSharedRequests(nativeFederationProfile(this.renderer));
    compiler.hooks.normalModuleFactory.tap(
      'UltraModernFederationSharedOwners',
      factory => {
        factory.hooks.beforeResolve.tap(
          'UltraModernFederationSharedOwners',
          data => {
            if (!data) return;
            const request = data.request.split(/[?#]/u, 1)[0];
            if (
              !Object.hasOwn(this.bindings.aliases, `${request}$`) &&
              owned.some(
                key =>
                  key === request ||
                  (key.endsWith('/') && request.startsWith(key)),
              )
            ) {
              throw federationError(
                `singleton ${request} has no runtime export in its selected owner.`,
              );
            }
          },
        );
      },
    );
    compiler.hooks.afterResolvers.tap(
      {
        name: 'UltraModernFederationSharedOwners',
        // Native compiler aliases are installed at the ordinary stage. Pin the
        // shared owner after those aliases exist, before modules are compiled.
        stage: 100,
      },
      () => {
        const finalized = resolveNativeSharedBindings(
          this.renderer,
          this.appDirectory,
          this.environment,
          compiler.options as Rspack.Configuration,
        );
        for (const [request, imported] of Object.entries(this.bindings.imports))
          if (finalized.imports[request] !== imported)
            throw federationError(
              `the finalized ESM owner of ${request} differs from its provider.`,
            );
        compiler.options.resolve.alias = {
          ...finalized.aliases,
          ...Object.fromEntries(
            Object.entries(compiler.options.resolve.alias || {}).filter(
              ([request]) => !Object.hasOwn(finalized.aliases, request),
            ),
          ),
        };
        for (const dependency of Object.values(
          compiler.options.resolve.byDependency ?? {},
        )) {
          if (!dependency) continue;
          dependency.alias = {
            ...finalized.aliases,
            ...Object.fromEntries(
              Object.entries(dependency.alias || {}).filter(
                ([request]) => !Object.hasOwn(finalized.aliases, request),
              ),
            ),
          };
        }
      },
    );
  }
}

/** Private identity discovery creates a compiler but never starts it. */
export class NativeFederationDevOriginPlugin {
  constructor(
    private readonly readAddress: () => Parameters<
      typeof resolveNativeFederationDevPublicPath
    >[1],
  ) {}

  apply(compiler: Rspack.Compiler): void {
    const assertOrigin = () => {
      const publicPath = compiler.options.output.publicPath;
      const resolved = resolveNativeFederationDevPublicPath(
        typeof publicPath === 'string' ? publicPath : '',
        this.readAddress(),
      );
      if (resolved !== publicPath)
        throw federationError(
          'a live dev compiler must publish its resolved server origin.',
        );
    };
    compiler.hooks.beforeRun.tap(
      'UltraModernFederationDevOrigin',
      assertOrigin,
    );
    compiler.hooks.watchRun.tap('UltraModernFederationDevOrigin', assertOrigin);
  }
}

/** Merge renderer singletons; a config may add packages but not weaken them. */
export function createNativeSharedConfig(
  renderer: NativeRenderer,
  shared: unknown,
  versions: Readonly<Record<string, string>>,
  bindings?: NativeSharedBindings,
  environment?: NativeFederationEnvironment,
): Record<string, unknown> {
  const profile = nativeFederationProfile(renderer);
  const authored: Record<string, unknown> =
    shared === undefined
      ? {}
      : Array.isArray(shared)
        ? Object.fromEntries(
            shared.map(name => {
              if (typeof name !== 'string')
                throw federationError('array shared entries must be names.');
              return [name, {}];
            }),
          )
        : record(shared)
          ? shared
          : (() => {
              throw federationError('shared must be a record or an array.');
            })();
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(authored)) {
    if (
      nativeSharedRequests(profile).some(
        owned =>
          owned === name || (owned.endsWith('/') && name.startsWith(owned)),
      )
    )
      throw federationError(
        `${name} is a ${renderer} runtime singleton owned by the renderer; remove it from shared.`,
      );
    // An own property: a `__proto__` share key must not set the prototype.
    Object.defineProperty(result, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  // Exact versions: workspace and alias ranges in manifests are not semver.
  for (const name of nativeSharedRequests(profile, environment)) {
    const version = versions[name];
    if (!version)
      throw federationError(`shared ${name} has no installed version.`);
    result[name] = {
      singleton: true,
      strictVersion: true,
      requiredVersion: version,
      version,
      ...(bindings?.imports[name] ? { import: bindings.imports[name] } : {}),
      eager: false,
    };
  }
  return result;
}

/** Whether a configuration exposes modules; an empty `exposes` is host-only. */
export function exposesNativeModules(authored: FederationOptions): boolean {
  const { exposes } = authored;
  if (Array.isArray(exposes)) return exposes.length > 0;
  if (record(exposes)) return Object.keys(exposes).length > 0;
  return Boolean(exposes);
}

/**
 * Publish the server container beside the browser one, as the MF SSR snapshot
 * expects: the manifest's ssrRemoteEntry and ssrPublicPath name the Node
 * container a server-rendering host loads.
 */
export function withNativeServerContainer(
  manifest: unknown,
  serverDirectory: string,
  filename: string,
): Record<string, unknown> {
  if (manifest === false)
    throw federationError(
      'renderer components require native manifest publication.',
    );
  const options = record(manifest) ? manifest : {};
  const previous = options.additionalData;
  if (previous !== undefined && typeof previous !== 'function')
    throw federationError('manifest additionalData must be callable.');
  return {
    ...options,
    async additionalData(input: { stats: Record<string, unknown> }) {
      const stats =
        ((await (previous as ((value: typeof input) => unknown) | undefined)?.(
          input,
        )) as Record<string, unknown> | undefined) ?? input.stats;
      const metaData = stats.metaData;
      if (!record(metaData) || typeof metaData.publicPath !== 'string')
        throw federationError(
          'a server container requires an explicit browser publicPath.',
        );
      metaData.ssrRemoteEntry = {
        name: filename,
        path: '',
        type: NATIVE_SERVER_CONTAINER_TYPE,
      };
      metaData.ssrPublicPath = `${metaData.publicPath}${metaData.publicPath.endsWith('/') ? '' : '/'}${serverDirectory}/`;
      return stats;
    },
  };
}

/** Browser container options for a native renderer client compilation. */
export function createNativeClientFederationOptions(
  renderer: NativeRenderer,
  authored: FederationOptions,
  versions: Readonly<Record<string, string>>,
  runtimePlugin?: string,
  serverDirectory?: string,
  bindings?: NativeSharedBindings,
): FederationOptions {
  const profile = nativeFederationProfile(renderer);
  const { remotes: _remotes, ...container } = authored;
  if (
    authored.runtimePlugins !== undefined &&
    !Array.isArray(authored.runtimePlugins)
  )
    throw federationError('runtimePlugins must be an array.');
  return {
    ...container,
    // Remotes register at runtime; see nativeFederationRuntimePluginSource.
    runtimePlugins: [
      ...((authored.runtimePlugins as unknown[] | undefined) ?? []),
      ...(runtimePlugin ? [runtimePlugin] : []),
    ],
    filename: authored.filename ?? 'remoteEntry.js',
    library: { type: profile.library },
    // The renderer splits its runtime chunk; the container must carry its own.
    runtime: false,
    // A host must start without contacting remotes it has not rendered yet.
    shareStrategy: authored.shareStrategy ?? 'loaded-first',
    manifest:
      serverDirectory && exposesNativeModules(authored)
        ? withNativeServerContainer(
            authored.manifest,
            serverDirectory,
            String(authored.filename ?? 'remoteEntry.js'),
          )
        : (authored.manifest ?? true),
    dts: authored.dts ?? false,
    shared: createNativeSharedConfig(
      renderer,
      authored.shared,
      versions,
      bindings,
      'client',
    ),
    experiments: {
      ...(record(authored.experiments) ? authored.experiments : {}),
      // Entries start through an import() bootstrap instead. Async startup
      // with remotes drops the ESM runtime chunk's __webpack_require__ export.
      asyncStartup: false,
    },
  };
}

/**
 * Node container options for a native renderer server compilation. Shares
 * stay non-eager: the generated server entry reaches the renderer through an
 * import() boundary, so the host's singletons serve every remote it renders.
 */
export function createNativeServerFederationOptions(
  renderer: NativeRenderer,
  authored: FederationOptions,
  versions: Readonly<Record<string, string>>,
  runtimePlugins: readonly (
    | string
    | readonly [string, Record<string, unknown>]
  )[],
  bindings?: NativeSharedBindings,
): FederationOptions {
  const { remotes: _remotes, ...container } = authored;
  if (
    authored.runtimePlugins !== undefined &&
    !Array.isArray(authored.runtimePlugins)
  )
    throw federationError('runtimePlugins must be an array.');
  const recovery = resolveManifestRecoveryRuntimePlugin(import.meta.url);
  const authoredPlugins =
    (authored.runtimePlugins as unknown[] | undefined) ?? [];
  if (
    authoredPlugins.some(
      plugin => (Array.isArray(plugin) ? plugin[0] : plugin) === recovery,
    )
  )
    throw federationError(
      'manifest recovery has duplicate registration ownership.',
    );
  return {
    ...container,
    runtimePlugins: [
      // Recover transient manifest failures before the native Node loader
      // converts them into terminal rendering failures. Admission still gates
      // every recovered manifest before a remote factory executes.
      recovery,
      ...authoredPlugins,
      ...runtimePlugins,
    ],
    filename: authored.filename ?? 'remoteEntry.js',
    library: { type: NATIVE_SERVER_CONTAINER_TYPE, name: authored.name },
    remoteType: 'script',
    shareStrategy: authored.shareStrategy ?? 'loaded-first',
    // The browser manifest publishes this container as its ssrRemoteEntry.
    manifest: authored.manifest ?? true,
    dts: false,
    dev: false,
    shared: createNativeSharedConfig(
      renderer,
      authored.shared,
      versions,
      bindings,
      'server',
    ),
    experiments: {
      ...(record(authored.experiments) ? authored.experiments : {}),
      asyncStartup: false,
      optimization: {
        ...(record(authored.experiments) &&
        record(authored.experiments.optimization)
          ? authored.experiments.optimization
          : {}),
        target: 'node',
      },
    },
  };
}

/**
 * The host client module that loads a remote through the host's federation
 * instance. Solid imports it, by the asset key the server rendered, before it
 * hydrates the boundary holding that remote. The server names the host, so
 * co-located hosts in one browser realm hydrate through their own instances.
 */
export const nativeFederationHydrationSource = `const query = new URL(import.meta.url).searchParams;
const id = query.get('id');
const name = query.get('host');
// Module Federation keeps one instance per name in a realm.
const host = globalThis.__FEDERATION__?.__INSTANCES__?.find(instance => instance.name === name);
if (!id || !host) throw new Error('Cannot hydrate the federated component ' + id + ': the ' + name + ' federation runtime has not started');
const module = await host.loadRemote(id);
if (!module || typeof module.default !== 'function') throw new TypeError('Remote module ' + id + ' has no default component to hydrate');
export default module.default;
`;

/** Content-addressed client path of the hydration module. */
export const NATIVE_FEDERATION_HYDRATION_MODULE = `static/js/ultramodern-federation-hydration.${createHash(
  'sha256',
)
  .update(nativeFederationHydrationSource)
  .digest('hex')
  .slice(0, 8)}.js`;

/** The import() boundary that lets an entry consume shared singletons. */
export function nativeFederationBootstrapSource(entry: string): string {
  return `import(${JSON.stringify(entry)});\n`;
}

/**
 * Start every generated application entry through an async boundary, so the
 * share scope is initialized before the renderer runtime is consumed.
 */
async function splitClientEntries(
  chain: {
    entryPoints: { entries(): Record<string, unknown> | undefined };
    entry(name: string): any;
  },
  internalDirectory: string,
): Promise<void> {
  for (const name of Object.keys(chain.entryPoints.entries() ?? {})) {
    const entry = chain.entry(name);
    const values: unknown[] = entry.values();
    const next: unknown[] = [];
    for (const value of values) {
      if (
        typeof value !== 'string' ||
        !path.isAbsolute(value) ||
        path.relative(internalDirectory, value).startsWith('..')
      ) {
        next.push(value);
        continue;
      }
      const bootstrap = path.join(
        path.dirname(value),
        `${path.basename(value, path.extname(value))}.federation.js`,
      );
      await fs.promises.writeFile(
        bootstrap,
        nativeFederationBootstrapSource(value),
      );
      next.push(bootstrap);
    }
    entry.clear();
    for (const value of next) entry.add(value);
  }
}

/** Runtime remote registrations for `alias -> name@manifest` remotes. */
export function createNativeRuntimeRemotes(
  remotes: Readonly<Record<string, string>>,
): { name: string; alias: string; entry: string }[] {
  return Object.entries(remotes).map(([alias, remote]) => {
    const separator = remote.indexOf('@');
    return {
      name: remote.slice(0, separator),
      alias,
      entry: remote.slice(separator + 1),
    };
  });
}

/**
 * The application's runtime plugin. It registers the configured remotes when
 * its federation instance initializes. Generated entries pass that instance to
 * the renderer, so federatedComponent() loads through its own application's
 * host. Build-time remotes would compile remote externals into the ESM runtime
 * chunk, which rspack 2.2.7 renders without its chunk loading runtime;
 * federated components load by id instead.
 */
export function nativeFederationRuntimePluginSource(
  remotes: ReturnType<typeof createNativeRuntimeRemotes>,
  server?: {
    readonly requestTimeout?: number;
  },
  browserDev = false,
): string {
  const requestTimeout = server?.requestTimeout ?? 3000;
  if (server && (!Number.isSafeInteger(requestTimeout) || requestTimeout <= 0))
    throw federationError('server requestTimeout must be a positive integer.');
  return `${
    browserDev
      ? `import { ModuleFederation } from '@module-federation/enhanced/runtime';
import { preparePublisherBoundaryReplacement } from 'octane';
import { createNativeBrowserDevRuntimePlugin } from '@modern-js/federation-runtime/native-browser-dev-runtime-plugin';
import { prepareNativeBrowserDevClient, releaseNativeBrowserDevClient } from '@modern-js/federation-runtime/native-browser-dev-client';
`
      : ''
  }const remotes = ${JSON.stringify(remotes)};
${
  server
    ? `const requestTimeout = ${requestTimeout};
`
    : ''
}export default function ultramodernNativeFederation() {
  ${
    browserDev
      ? `const browser = createNativeBrowserDevRuntimePlugin({
    remotes,
    prepareReplacement: preparePublisherBoundaryReplacement,
    createHost(options) {
      // Normal beforeInit can append sibling remotes to the mutable options.
      // This attempt owns only the immutable remotes passed before construction.
      const ownedRemotes = (options.remotes ?? []).map(remote => ({ ...remote }));
      const leases = [];
      const host = new ModuleFederation(options);
      return { host, prepareFactory() {
        for (const remote of ownedRemotes)
          leases.push(prepareNativeBrowserDevClient(remote.name, remote.entry));
      }, release() {
        for (const release of leases.splice(0)) release();
        for (const remote of ownedRemotes)
          releaseNativeBrowserDevClient(remote.name, remote.entry);
      } };
    },
  });`
      : ''
  }
  return {
    name: 'ultramodern-native-federation',${
      server
        ? `
    async fetch(url, options) {
      // The deadline belongs to this shared transport, and stays active while
      // the native SDK consumes its Response body. A component only times out
      // its own waiter; it cannot abort another response's shared entry load.
      const deadline = AbortSignal.timeout(requestTimeout);
      const signal = options?.signal
        ? AbortSignal.any([options.signal, deadline])
        : deadline;
      const response = await globalThis.fetch(url, { ...options, signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw Object.assign(new Error('Remote HTTP request failed: ' + response.status + ' ' + url), {
          status: response.status,
        });
      }
      return response;
    },`
        : ''
    }
    beforeInit(args) {
      const registered = args.userOptions.remotes ?? [];
      const known = new Set(registered.map(remote => remote.alias ?? remote.name));
      args.userOptions.remotes = [
        ...registered,
        ...remotes.filter(remote => !known.has(remote.alias)).map(remote => ({ ...remote })),
      ];
      ${browserDev ? 'browser.beforeInit(args);' : ''}
      return args;
    },
  };
}
`;
}

/** Replace only this Octane remote's Rsbuild client through normal aliasing. */
export function nativeFederationDevClientSource(remoteName: string): string {
  return `import { startNativeBrowserDevClient } from '@modern-js/federation-runtime/native-browser-dev-client';
let overlay;
export function registerOverlay(create, clear) { overlay = { create, clear }; }
export function init(token, config, serverHost, serverPort, serverBase, liveReload, browserLogs, logLevel, resolveWebSocketUrl) {
  const dispose = startNativeBrowserDevClient({
    remoteName: ${JSON.stringify(remoteName)},
    buildId: ULTRAMODERN_BUILD_MARKER,
    revisionHeader: ${JSON.stringify(NATIVE_FEDERATION_DEV_REVISION_HEADER)},
    token, config, serverHost, serverPort, serverBase, liveReload, browserLogs, logLevel, resolveWebSocketUrl,
    hot: import.meta.webpackHot,
    hash: () => import.meta.rspackHash,
    overlay: () => overlay,
    installCustomListeners(listeners) {
      const interceptor = ({ module }) => {
        const owned = new Map();
        module.hot.on = (event, callback) => {
          listeners.set(event, [...(listeners.get(event) ?? []), callback]);
          owned.set(event, [...(owned.get(event) ?? []), callback]);
        };
        module.hot.dispose(() => {
          for (const [event, callbacks] of owned)
            listeners.set(event, (listeners.get(event) ?? []).filter(callback => !callbacks.includes(callback)));
        });
      };
      __webpack_require__.i.push(interceptor);
      return () => {
        const index = __webpack_require__.i.indexOf(interceptor);
        if (index !== -1) __webpack_require__.i.splice(index, 1);
      };
    },
  });
  import.meta.webpackHot?.dispose(dispose);
}
`;
}

function resolveModuleFederationPlugin(appDirectory: string): unknown {
  const require = createRequire(path.join(appDirectory, 'package.json'));
  let file: string;
  try {
    file = require.resolve('@module-federation/enhanced/rspack');
  } catch (error) {
    throw Object.assign(
      federationError(
        'install @module-federation/enhanced in the application to use module-federation.config.',
      ),
      { cause: error },
    );
  }
  const { ModuleFederationPlugin } = require(file) as {
    ModuleFederationPlugin?: unknown;
  };
  if (typeof ModuleFederationPlugin !== 'function')
    throw federationError(
      '@module-federation/enhanced/rspack has no ModuleFederationPlugin.',
    );
  return ModuleFederationPlugin;
}

/** The Node runtime plugin that loads remote containers and chunks over HTTP. */
function resolveNodeRuntimePlugin(appDirectory: string): string {
  const require = createRequire(path.join(appDirectory, 'package.json'));
  try {
    return require.resolve('@module-federation/node/runtimePlugin');
  } catch (error) {
    throw Object.assign(
      federationError(
        'install @module-federation/node in the application: server rendering and server containers load remotes through it.',
      ),
      { cause: error },
    );
  }
}

const STATIC_ASSET_MODULE_TYPES = ['asset', 'asset/resource'] as const;

/** Emit the hydration module beside the client's own scripts. */
class NativeFederationHydrationModulePlugin {
  apply(compiler: {
    webpack: {
      Compilation: { PROCESS_ASSETS_STAGE_ADDITIONAL: number };
      sources: { RawSource: new (source: string) => unknown };
    };
    hooks: {
      thisCompilation: {
        tap(
          name: string,
          callback: (compilation: {
            hooks: {
              processAssets: {
                tap(
                  options: { name: string; stage: number },
                  callback: () => void,
                ): void;
              };
            };
            emitAsset(file: string, source: unknown): void;
          }) => void,
        ): void;
      };
    };
  }): void {
    const name = 'UltraModernFederationHydrationModule';
    compiler.hooks.thisCompilation.tap(name, compilation => {
      compilation.hooks.processAssets.tap(
        {
          name,
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () =>
          compilation.emitAsset(
            NATIVE_FEDERATION_HYDRATION_MODULE,
            new compiler.webpack.sources.RawSource(
              nativeFederationHydrationSource,
            ),
          ),
      );
    });
  }
}

/**
 * Same-renderer Module Federation for native renderers. The plugin is inert
 * without a module-federation.config file; with one, the client compilation
 * publishes and consumes ESM containers whose renderer runtime is shared.
 * When the application server-renders, or exposes modules a host may
 * server-render, the Node server compilation publishes and consumes Node
 * containers with the same singletons. Native Workers instead compile their
 * static expose registry and use service-binding snapshot transport; only
 * their browser compilation installs Module Federation.
 */
export function nativeModuleFederationPlugin(
  renderer: NativeRenderer,
): CliPlugin<AppTools> {
  return {
    name: NATIVE_MODULE_FEDERATION_PLUGIN,
    setup(api) {
      let loaded: Promise<FederationOptions | undefined> | undefined;
      const workerBuild = () => isNativeWorkerBuild(api.getNormalizedConfig());
      const load = () =>
        (loaded ??= (async () => {
          const file = findNativeFederationConfig(
            api.getAppContext().appDirectory,
          );
          if (!file) return undefined;
          if (!resolveNativeRendererAdapter(renderer).federation)
            throw new Error(
              `unsupported-renderer-capability: renderer ${renderer} does not support Module Federation; remove ${path.basename(file)}`,
            );
          if (workerBuild() && renderer !== 'octane')
            throw new Error(
              `unsupported-renderer-capability: renderer ${renderer} has no native Worker snapshot federation transport`,
            );
          return loadNativeFederationConfig(file);
        })());
      const serverRendered = (authored: FederationOptions): boolean => {
        // Worker SSR owns static exposes and service bindings, not HTTP-loaded
        // Node containers. Its client still publishes the browser manifest
        // stamped by native infrastructure with exact Worker coordinates.
        if (
          workerBuild() ||
          !resolveNativeRendererAdapter(renderer).federation?.ssr
        )
          return false;
        if (exposesNativeModules(authored)) return true;
        const { server } = api.getNormalizedConfig();
        return Boolean(
          server?.ssr ||
            Object.values(server?.ssrByEntries ?? {}).some(Boolean),
        );
      };
      const writeRuntimePlugin = async (
        name: string,
        source: string,
      ): Promise<string> => {
        const file = path.join(
          api.getAppContext().internalDirectory,
          'federation',
          name,
        );
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, source);
        return file;
      };

      api.modifyBundlerChain(async (chain, { environment }) => {
        const authored = await load();
        if (!authored) return;
        const server = environment.name === 'server';
        if (!server && environment.name !== 'client') return;
        const ssr = serverRendered(authored);
        if (server && !ssr) return;
        const { appDirectory, internalDirectory } = api.getAppContext();
        const Plugin = resolveModuleFederationPlugin(appDirectory);
        const remotes = createNativeRuntimeRemotes(
          readNativeFederationRemotes(authored),
        );
        if (api.getAppContext().command === 'dev')
          chain
            .plugin('ultramodern-federation-dev-origin')
            .use(NativeFederationDevOriginPlugin, [
              () => api.getAppContext().builder?.context.devServer,
            ]);
        if (server) chain.target('async-node');
        const bindings = resolveNativeSharedBindings(
          renderer,
          appDirectory,
          server ? 'server' : 'client',
          chain.toConfig?.() ?? {},
        );
        const versions = bindings.versions;
        chain
          .plugin('ultramodern-federation-shared-owners')
          .use(NativeFederationSharedOwnersPlugin, [
            renderer,
            appDirectory,
            server ? 'server' : 'client',
            bindings,
          ]);
        if (server) {
          if (
            api.getAppContext().command === 'dev' &&
            exposesNativeModules(authored)
          )
            chain
              .plugin('ultramodern-federation-dev-assets')
              .use(NativeFederationDevAssetsPlugin, [String(authored.name)]);
          const runtimePlugin = await writeRuntimePlugin(
            'native-runtime.server.mjs',
            nativeFederationRuntimePluginSource(remotes, {}),
          );
          chain.plugin(NATIVE_FEDERATION_CHAIN_KEY).use(
            Plugin as never,
            [
              createNativeServerFederationOptions(
                renderer,
                authored,
                versions,
                [
                  resolveNodeRuntimePlugin(appDirectory),
                  runtimePlugin,
                  ...(api.getAppContext().command === 'dev'
                    ? [
                        [
                          createRequire(import.meta.url).resolve(
                            '@modern-js/federation-runtime/native-dev-refresh-runtime-plugin',
                          ),
                          {
                            remotes,
                            shared: nativeSharedRequests(
                              nativeFederationProfile(renderer),
                              'server',
                            ),
                            revisionHeader:
                              NATIVE_FEDERATION_DEV_REVISION_HEADER,
                            requestTimeout: 3000,
                          },
                        ] as const,
                      ]
                    : []),
                ],
                bindings,
              ),
            ] as never,
          );
          return;
        }
        const browserDev =
          api.getAppContext().command === 'dev' && renderer === 'octane';
        const runtimePlugin = await writeRuntimePlugin(
          'native-runtime.mjs',
          nativeFederationRuntimePluginSource(remotes, undefined, browserDev),
        );
        if (browserDev && exposesNativeModules(authored)) {
          const client = await writeRuntimePlugin(
            'native-dev-client.mjs',
            nativeFederationDevClientSource(String(authored.name)),
          );
          // App-tools runs as this composition's dependency. Applications may
          // install only the composition, including through a package alias.
          // Resolve the client from the same selected builder owner.
          const appToolsRequire = createRequire(
            createRequire(import.meta.url).resolve('@modern-js/app-tools'),
          );
          const hmr = path.join(
            path.dirname(appToolsRequire.resolve('@rsbuild/core')),
            'client/hmr.js',
          );
          if (!fs.existsSync(hmr))
            throw federationError(
              'the selected Rsbuild HMR client cannot be resolved.',
            );
          chain.resolve.alias.set(`${hmr}$`, client);
          const manifest = record(authored.manifest) ? authored.manifest : {};
          const filename =
            typeof manifest.fileName === 'string' && manifest.fileName
              ? manifest.fileName.endsWith('.json')
                ? manifest.fileName
                : `${manifest.fileName}.json`
              : 'mf-manifest.json';
          chain
            .plugin('ultramodern-federation-dev-browser-assets')
            .use(NativeFederationDevAssetsPlugin, [
              String(authored.name),
              {
                browserManifest: path.posix.join(
                  String(manifest.filePath ?? '').replace(/\\/gu, '/'),
                  filename,
                ),
              },
            ]);
        }
        chain
          .plugin(NATIVE_FEDERATION_CHAIN_KEY)
          .use(
            Plugin as never,
            [
              createNativeClientFederationOptions(
                renderer,
                authored,
                versions,
                runtimePlugin,
                ssr ? SERVER_BUNDLE_DIRECTORY : undefined,
                bindings,
              ),
            ] as never,
          );
        if (ssr)
          chain
            .plugin('ultramodern-federation-hydration-module')
            .use(NativeFederationHydrationModulePlugin);
        await splitClientEntries(chain as never, internalDirectory);
      });

      // A server container resolves its chunks from its own public path,
      // while server-rendered asset URLs keep the client's.
      api.modifyRspackConfig(async (config, { environment }) => {
        const authored = await load();
        if (!authored) return;
        if (environment.name !== 'client' && environment.name !== 'server')
          return;
        const context = api.getAppContext();
        const address = context.builder?.context.devServer;
        if (context.command === 'dev' && address) {
          config.output ??= {};
          config.output.publicPath = resolveNativeFederationDevPublicPath(
            typeof config.output.publicPath === 'string'
              ? config.output.publicPath
              : '',
            address,
            environment.config.dev.assetPrefix,
          );
        }
        // Private compiler discovery precedes the live dev server and never
        // emits. The public dev compiler receives its resolved address above.
        if (environment.name !== 'server' || !serverRendered(authored)) return;
        const publicPath = config.output?.publicPath;
        if (
          typeof publicPath !== 'string' ||
          !publicPath ||
          publicPath === 'auto'
        )
          throw federationError(
            'server containers require an explicit output.assetPrefix.',
          );
        config.module ??= {};
        const generator = (config.module.generator ??= {}) as Record<
          string,
          Record<string, unknown>
        >;
        for (const type of STATIC_ASSET_MODULE_TYPES) {
          generator[type] ??= {};
          generator[type].publicPath ??= publicPath;
        }
        config.output!.publicPath = `${publicPath}${publicPath.endsWith('/') ? '' : '/'}${SERVER_BUNDLE_DIRECTORY}/`;
      });
    },
  };
}
