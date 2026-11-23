import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppTools, CliPlugin } from '@modern-js/app-tools';
import type { Rspack } from '@rsbuild/core';
import {
  readRendererFrameworkPackage,
  resolveInstalledRendererPackage,
} from '../../native-composition/renderer-installed-profile';

type SharedConfig = { requiredVersion?: unknown } & Record<string, unknown>;
type SharedRecord = Record<string, string | SharedConfig>;
type Shared = SharedRecord | Array<string | SharedRecord>;

// The compiled JSX in every federated bundle imports these React entries.
// Sharing `react` without them gives each bundle its own JSX runtime, so a
// remote's elements reach the host's React with a foreign runtime identity.
const REACT_JSX_RUNTIMES = ['react/jsx-runtime', 'react/jsx-dev-runtime'];

// Chain ids under which `@module-federation/modern-js-v3` registers its
// browser and server federation plugins.
const MODULE_FEDERATION_SERVER_CHAIN_ID = 'plugin-module-federation-server';
const MODULE_FEDERATION_CHAIN_IDS = [
  'plugin-module-federation',
  MODULE_FEDERATION_SERVER_CHAIN_ID,
];

// Retries a server-side remote manifest fetch that failed transiently.
const MANIFEST_RECOVERY_RUNTIME_PLUGIN =
  '@modern-js/federation-runtime/manifest-recovery-runtime-plugin';

/**
 * Framework packages whose subpaths share module state: React contexts and
 * Effect's request storage. Every exported subpath under `prefix` is shared,
 * and each subpath reaches that state through a package self-reference (for
 * example `@modern-js/runtime/context`), so a remote never evaluates its own
 * copy. Subpaths are listed from the package's `exports` rather than shared by
 * prefix: the app aliases unexported ones such as `@modern-js/runtime/registry`
 * to its own generated modules, which must never be shared.
 * `contexts` matches the files that define that state (React contexts, the
 * Effect request storage): only a shared module or another of those files may
 * import them.
 * `peers` are packages whose values cross the federation boundary through
 * this package's exports, so they are shared with it (see `peerShare`).
 */
const FRAMEWORK_SHARES: ReadonlyArray<{
  packageName: string;
  prefix: string;
  contextsRequest: string;
  contexts: RegExp;
  peers?: readonly string[];
}> = [
  {
    packageName: '@modern-js/runtime',
    prefix: '@modern-js/runtime/',
    contextsRequest: '@modern-js/runtime/context',
    contexts: /[\\/]core[\\/]context[\\/](?:index|runtime)\.[cm]?[jt]sx?$/,
  },
  {
    packageName: '@modern-js/plugin-i18n',
    prefix: '@modern-js/plugin-i18n/runtime/',
    contextsRequest: '@modern-js/plugin-i18n/runtime/contexts',
    contexts: /[\\/]runtime[\\/]contexts\.[cm]?[jt]sx?$/,
  },
  {
    packageName: '@modern-js/bff-effect',
    prefix: '@modern-js/bff-effect/',
    contextsRequest: '@modern-js/bff-effect/context',
    contexts: /[\\/]effect[\\/]context\.[cm]?[jt]sx?$/,
    // Its modules re-export Effect: schemas, tags and layers built by a remote
    // are decoded and provided by the host, which needs the same Effect.
    peers: ['effect'],
  },
];

export type FrameworkSharedPackage = {
  prefix: string;
  version: string;
  /**
   * Requests to share: exported subpaths under `prefix` that load code, or for
   * a peer its bare name and its `prefix` (a Module Federation prefix share).
   */
  requests: string[];
  /** Real path of the installed package directory. */
  directory: string;
  contextsRequest?: string;
  contexts?: RegExp;
};

// A types-only export or a wildcard pattern names no module to share.
const loadsCode = (target: unknown): boolean =>
  typeof target === 'string'
    ? !target.endsWith('.d.ts')
    : Boolean(target) &&
      typeof target === 'object' &&
      Object.entries(target as object).some(
        ([condition, value]) => condition !== 'types' && loadsCode(value),
      );

const exportedRequests = (
  packageName: string,
  prefix: string,
  exports: unknown,
) =>
  Object.entries(
    exports && typeof exports === 'object' ? (exports as object) : {},
  )
    .filter(
      ([subpath, target]) =>
        subpath !== './package.json' &&
        !subpath.includes('*') &&
        loadsCode(target),
    )
    .map(([subpath]) => `${packageName}${subpath.slice(1)}`)
    .filter(request => request.startsWith(prefix))
    .sort();

/**
 * The app's `node_modules` lookup for `packageName`. `NODE_PATH` is ignored:
 * a package the app does not install is not the app's to share.
 */
const findInstalledManifest = (appDirectory: string, packageName: string) => {
  for (let directory = appDirectory; ; ) {
    const manifest = path.join(
      directory,
      'node_modules',
      packageName,
      'package.json',
    );
    if (existsSync(manifest)) return manifest;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const readManifest = (manifest: string) =>
  JSON.parse(readFileSync(manifest, 'utf8')) as {
    version: string;
    exports?: unknown;
  };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const readPackage = (directory: string) => {
  const filename = path.join(directory, 'package.json');
  const manifest: unknown = JSON.parse(readFileSync(filename, 'utf8'));
  if (!record(manifest))
    throw new Error(`Module Federation: invalid package manifest ${filename}`);
  return manifest;
};

/** Project publisher-admitted artifact identity, not an arbitrary URL's name. */
const artifactRequirementVersion = (
  appDirectory: string,
  request: string,
  requirement: string,
): string => {
  const name = request
    .split('/')
    .slice(0, request.startsWith('@') ? 2 : 1)
    .join('/');
  const fail = () =>
    new Error(
      `Module Federation: ${request} artifact requiredVersion must match this framework's admitted artifact request and the application's installed package identity: ${requirement}`,
    );
  const app = readPackage(appDirectory);
  const dependencies = record(app.dependencies) ? app.dependencies : {};
  const devDependencies = record(app.devDependencies)
    ? app.devDependencies
    : {};
  if ((dependencies[name] ?? devDependencies[name]) !== requirement)
    throw fail();
  // These installed framework manifests carry release-admitted descriptors.
  // App-authored descriptors cannot admit URLs; archive authentication stays
  // with the publisher/installer, not this sharing-options projection.
  const require = createRequire(import.meta.url);
  for (const authority of [
    {
      specifier: '@modern-js/ultramodern-app-tools',
      filename: fileURLToPath(import.meta.url),
    },
    {
      specifier: '@modern-js/app-tools-extensions',
      filename: require.resolve('@modern-js/app-tools-extensions'),
    },
  ]) {
    const owner = readRendererFrameworkPackage(authority);
    const metadata = readPackage(owner.directory).ultramodern;
    if (!record(metadata)) continue;
    for (const descriptor of [
      metadata.supportArtifacts,
      metadata.nativeArtifacts,
    ]) {
      if (!record(descriptor) || !record(descriptor.packages)) continue;
      const pin = descriptor.packages[name];
      if (!record(pin) || pin.request !== requirement) continue;
      const installed = resolveInstalledRendererPackage(name, [appDirectory]);
      if (
        !installed ||
        installed.name !== name ||
        installed.version !== pin.version
      )
        throw fail();
      return installed.version;
    }
  }
  throw fail();
};

const withArtifactRequirements = (
  shared: Shared | undefined,
  appDirectory: string,
): Shared | undefined => {
  const rewrite = (entries: SharedRecord): SharedRecord => {
    let result = entries;
    for (const [request, config] of Object.entries(entries)) {
      if (
        config &&
        typeof config === 'object' &&
        typeof config.requiredVersion === 'string' &&
        /^https?:\/\//iu.test(config.requiredVersion)
      ) {
        result = {
          ...result,
          [request]: {
            ...config,
            requiredVersion: artifactRequirementVersion(
              appDirectory,
              typeof config.import === 'string' ? config.import : request,
              config.requiredVersion,
            ),
          },
        };
      }
    }
    return result;
  };
  if (!Array.isArray(shared)) return shared && rewrite(shared);
  const result = shared.map(entry =>
    typeof entry === 'string' ? entry : rewrite(entry),
  );
  return result.every((entry, index) => entry === shared[index])
    ? shared
    : result;
};

/**
 * `packageName` and all of its subpaths, as the framework package that
 * depends on it resolves them from `directory`: that copy's version is the one
 * the release cohort pins. The subpaths are shared by the `packageName/`
 * prefix because packages such as Effect export them through a `./*` pattern
 * that names no fixed list.
 */
const peerShare = (
  directory: string,
  packageName: string,
): FrameworkSharedPackage[] => {
  const manifest = findInstalledManifest(directory, packageName);
  if (!manifest) return [];
  return [
    {
      prefix: `${packageName}/`,
      version: readManifest(manifest).version,
      requests: [packageName, `${packageName}/`],
      directory: realpathSync(path.dirname(manifest)),
    },
  ];
};

/**
 * The framework packages the app installs, with their installed versions,
 * followed by the peers whose values they carry across the boundary.
 */
export const resolveFrameworkSharedPackages = (
  appDirectory: string,
): FrameworkSharedPackage[] =>
  FRAMEWORK_SHARES.flatMap(share => {
    const manifest = findInstalledManifest(appDirectory, share.packageName);
    if (!manifest) return [];
    const { version, exports } = readManifest(manifest);
    const directory = realpathSync(path.dirname(manifest));
    const { peers = [], ...shareConfig } = share;
    return [
      {
        ...shareConfig,
        version,
        requests: exportedRequests(share.packageName, share.prefix, exports),
        directory,
      },
      ...peers.flatMap(peer => peerShare(directory, peer)),
    ];
  });

const findShared = (
  entries: Array<string | SharedRecord>,
  request: string,
): SharedConfig | undefined => {
  for (const entry of entries) {
    if (entry === request) return {};
    if (typeof entry === 'object' && Object.hasOwn(entry, request)) {
      const config = entry[request];
      return typeof config === 'string' ? { requiredVersion: config } : config;
    }
  }
  return undefined;
};

const toEntries = (shared: unknown) =>
  (Array.isArray(shared) ? shared : [shared]) as Array<string | SharedRecord>;

/** Add `missing` to `shared`, keeping every entry the app configured. */
const withShared = <T>(shared: T, missing: SharedRecord): T => {
  const entries = toEntries(shared);
  const added = Object.fromEntries(
    Object.entries(missing).filter(
      ([request]) => !findShared(entries, request),
    ),
  );
  if (Object.keys(added).length === 0) return shared;
  if (!shared) return added as T;
  return (
    Array.isArray(shared) ? [...shared, added] : { ...shared, ...added }
  ) as T;
};

/**
 * Share `react/jsx-runtime` and `react/jsx-dev-runtime` as singletons at the
 * shared `react` version whenever `react` itself is shared. Entries the app
 * configured explicitly are kept as written.
 */
export const withReactJsxRuntimeShared = <T>(shared: T): T => {
  if (!shared || typeof shared !== 'object') return shared;
  const react = findShared(toEntries(shared), 'react');
  if (!react) return shared;
  return withShared(
    shared,
    Object.fromEntries(
      REACT_JSX_RUNTIMES.map(request => [
        request,
        {
          ...(react.requiredVersion === undefined
            ? {}
            : { requiredVersion: react.requiredVersion }),
          singleton: true,
          treeShaking: false,
        },
      ]),
    ),
  );
};

/**
 * Share every exported subpath of the framework packages as a singleton at
 * the installed version. Entries the app configured explicitly are kept.
 */
export const withFrameworkShared = <T>(
  shared: T,
  packages: FrameworkSharedPackage[],
): T =>
  withShared(
    shared,
    Object.fromEntries(
      packages.flatMap(({ requests, version }) =>
        requests.map(request => [
          request,
          { requiredVersion: version, singleton: true, treeShaking: false },
        ]),
      ),
    ),
  );

type FederationPluginOptions = {
  shared?: Shared;
  exposes?: unknown;
  mfConfig?: unknown;
  runtimePlugins?: unknown[];
  shareStrategy?: unknown;
};

/**
 * The server manifest-recovery runtime plugin of the app's own
 * `@modern-js/federation-runtime`, or `undefined` when the app does not
 * install it. Resolved from the app directory, never from `process.cwd()`.
 */
export const resolveManifestRecoveryRuntimePlugin = (
  appDirectory: string,
): string | undefined => {
  if (!findInstalledManifest(appDirectory, '@modern-js/federation-runtime'))
    return undefined;
  return createRequire(path.join(appDirectory, 'package.json')).resolve(
    MANIFEST_RECOVERY_RUNTIME_PLUGIN,
  );
};

/** Append `runtimePlugin` unless the app already registered it. */
export const withRuntimePlugin = (
  runtimePlugins: unknown[] | undefined,
  runtimePlugin: string,
): unknown[] => {
  const plugins = runtimePlugins ?? [];
  const registered = plugins.some(
    plugin => (Array.isArray(plugin) ? plugin[0] : plugin) === runtimePlugin,
  );
  return registered ? plugins : [...plugins, runtimePlugin];
};

// `secondarySharedTreeShaking` wraps the federation config in `mfConfig`.
const federationConfig = (
  options: FederationPluginOptions,
): FederationPluginOptions =>
  options.mfConfig && typeof options.mfConfig === 'object'
    ? federationConfig(options.mfConfig as FederationPluginOptions)
    : options;

const withDefaults = (
  options: FederationPluginOptions,
  packages: FrameworkSharedPackage[],
  runtimePlugin: string | undefined,
  appDirectory: string,
): FederationPluginOptions =>
  options.mfConfig && typeof options.mfConfig === 'object'
    ? {
        ...options,
        mfConfig: withDefaults(
          options.mfConfig as FederationPluginOptions,
          packages,
          runtimePlugin,
          appDirectory,
        ),
      }
    : {
        ...options,
        shared: withFrameworkShared(
          withReactJsxRuntimeShared(
            withArtifactRequirements(options.shared, appDirectory),
          ),
          packages,
        ),
        // A host must start without contacting remotes it has not rendered
        // yet. Version-first sharing loads every remote entry on start.
        shareStrategy: options.shareStrategy ?? 'loaded-first',
        ...(runtimePlugin
          ? {
              runtimePlugins: withRuntimePlugin(
                options.runtimePlugins,
                runtimePlugin,
              ),
            }
          : {}),
      };

const hasExposes = (options: FederationPluginOptions) => {
  const { exposes } = federationConfig(options);
  return Array.isArray(exposes)
    ? exposes.length > 0
    : Boolean(exposes) && Object.keys(exposes as object).length > 0;
};

const SHARED_MODULE_TYPES = new Set([
  'consume-shared-module',
  'provide-module',
]);

// Only normal modules carry a file resource.
const resourceOf = (module: Rspack.Module | null) =>
  module && 'resource' in module && typeof module.resource === 'string'
    ? module.resource
    : undefined;

const describeModule = (module: Rspack.Module | null) =>
  module ? (resourceOf(module) ?? module.identifier()) : 'an entry';

// The dependency type of a Module Federation container entry, the same in
// Rspack and webpack.
const CONTAINER_ENTRY_DEPENDENCY = 'container entry';

const buildsContainer = (compilation: Rspack.Compilation) =>
  [...compilation.entries.values()].some(({ dependencies }) =>
    dependencies.some(({ type }) => type === CONTAINER_ENTRY_DEPENDENCY),
  );

/**
 * Fails a federation build that exposes modules when a framework context file
 * is imported other than through its shared request. That remote would run
 * with its own contexts and never see the host's request state.
 *
 * The check runs only when the compilation really builds a container: an
 * environment may drop the federation plugin after the chain was configured
 * (the Cloudflare workerd SSR graph does), and a graph with no container has
 * no host to share contexts with.
 */
export class FederationPrivateContextsPlugin {
  constructor(private readonly packages: FrameworkSharedPackage[]) {}

  apply(compiler: Rspack.Compiler) {
    const name = 'FederationPrivateContextsPlugin';
    const definitionOf = (module: Rspack.Module | null) => {
      const resource = resourceOf(module);
      return resource === undefined
        ? undefined
        : this.packages.find(
            ({ contexts, directory }) =>
              contexts?.test(resource) &&
              resource.startsWith(directory + path.sep),
          );
    };
    compiler.hooks.compilation.tap(name, compilation => {
      compilation.hooks.finishModules.tap(name, modules => {
        if (!buildsContainer(compilation)) return;
        for (const module of modules) {
          const share = definitionOf(module);
          if (!share) continue;
          const importer = compilation.moduleGraph
            .getIncomingConnections(module)
            .map(connection => connection.originModule)
            .find(
              origin =>
                !(origin && SHARED_MODULE_TYPES.has(origin.type)) &&
                definitionOf(origin) !== share,
            );
          if (importer === undefined) continue;
          compilation.errors.push(
            new compiler.webpack.WebpackError(
              `[ultramodern] This Module Federation build bundles a private copy of ${share.contextsRequest}: ${describeModule(importer)} imports ${describeModule(module)} directly. It would not see the host's request state. Share the "${share.prefix}" subpaths and import the contexts through "${share.contextsRequest}".`,
            ),
          );
        }
      });
    });
  }
}

/**
 * Apply UltraModern's Module Federation defaults to the federation plugins
 * that `@module-federation/modern-js-v3` registered on the chain: the shares,
 * the loaded-first share strategy, and on the server the manifest-recovery
 * runtime plugin.
 */
export const ultramodernModuleFederationSharedPlugin =
  (): CliPlugin<AppTools> => ({
    name: '@modern-js/ultramodern-module-federation-shared',
    pre: [
      '@modern-js/plugin-module-federation',
      '@modern-js/plugin-module-federation-ssr',
    ],
    setup(api) {
      api.modifyBundlerChain(chain => {
        const ids = MODULE_FEDERATION_CHAIN_IDS.filter(id =>
          chain.plugins.has(id),
        );
        if (ids.length === 0) return;
        const { appDirectory } = api.getAppContext();
        const packages = resolveFrameworkSharedPackages(appDirectory);
        const manifestRecovery =
          resolveManifestRecoveryRuntimePlugin(appDirectory);
        let exposes = false;
        for (const id of ids) {
          const [options] = chain.plugin(id).get('args') as [
            FederationPluginOptions,
          ];
          exposes ||= hasExposes(options);
          chain
            .plugin(id)
            .tap(([options, ...rest]) => [
              withDefaults(
                options,
                packages,
                id === MODULE_FEDERATION_SERVER_CHAIN_ID
                  ? manifestRecovery
                  : undefined,
                appDirectory,
              ),
              ...rest,
            ]);
        }
        if (exposes) {
          chain
            .plugin('ultramodern-federation-private-contexts')
            .use(FederationPrivateContextsPlugin, [packages]);
        }
      });
    },
  });
