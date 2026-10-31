import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { AppTools, CliPlugin } from '@modern-js/app-tools';
import type {
  CloudflareWorkerServiceBindingConfig,
  DeployTarget,
} from '@modern-js/app-tools-extensions/config';
import { resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { readModuleFederationConfigInspection } from '@modern-js/app-tools-extensions/module-federation-config';
import {
  DEVELOPMENT_OVERLAY_PATH,
  type DevelopmentOverlay,
  distributedSsrFragmentRoute,
  findWorkspaceRoot,
  normalizeRelativePath,
  REFERENCE_TOPOLOGY_PATH,
  type ReferenceTopology,
  type TopologyApp,
} from '@modern-js/app-tools-extensions/workspace-topology';
import { createLoadedConfig, mergeConfig } from '@modern-js/plugin/cli';
import { resolveBrowserManifestAddress } from '@modern-js/surface-resolution';
import { type PresetUltramodernOptions, presetUltramodern } from './preset';
import type { AppUserConfig } from './types';

export interface PresetUltramodernWorkspaceOptions
  extends Omit<PresetUltramodernOptions, 'appId' | 'deliveryUnit'> {
  /** App identity declared in topology/reference-topology.json. */
  appId: string;
  /** The application config's import.meta.url, or its absolute filename. */
  from: string | URL;
  /** Explicit target for programmatic builds; CLI builds use native resolution. */
  deployTarget?: DeployTarget;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[ultramodern-workspace] Missing ${field}.`);
  }
  return value;
};

const readJson = (filename: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(filename, 'utf8'));
  if (!record(value)) {
    throw new Error(`[ultramodern-workspace] Invalid object at ${filename}.`);
  }
  return value;
};

const envValue = (environment: Readonly<NodeJS.ProcessEnv>, name: string) =>
  environment[name]?.trim() || undefined;

const envSegment = (value: string) =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/[._]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toUpperCase()
    .replace(/-/gu, '_');

const developmentPort = (value: unknown, appId: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `[ultramodern-workspace] Invalid development port for ${appId}: ${port}`,
    );
  }
  return port;
};

const portEnvironment = (app: TopologyApp): string => {
  if (typeof app.portEnv === 'string') return app.portEnv;
  const id = requiredString(app.id, 'app.id');
  if (app.kind === 'shell') {
    return id === 'shell-super-app'
      ? 'SHELL_SUPER_APP_PORT'
      : `SHELL_${envSegment(id.replace(/^shell-/u, ''))}_PORT`;
  }
  return `VERTICAL_${envSegment(typeof app.domain === 'string' ? app.domain : id)}_PORT`;
};

const serviceBinding = (
  remote: TopologyApp,
  environment: Readonly<NodeJS.ProcessEnv>,
  exposes: unknown,
): CloudflareWorkerServiceBindingConfig | undefined => {
  const id = requiredString(remote.id, 'remote.id');
  if (
    !Array.isArray(exposes) ||
    exposes.some(expose => typeof expose !== 'string')
  ) {
    throw new Error(`[ultramodern-workspace] Invalid exposes for ${id}.`);
  }
  const fragments = exposes
    .filter((expose): expose is string => expose !== './Route')
    .toSorted()
    .map(expose => ({
      boundaryId: requiredString(
        remote.moduleFederation?.name,
        `${id}.moduleFederation.name`,
      ),
      expose,
      path: distributedSsrFragmentRoute(expose),
      remote: id,
    }));
  if (!remote.api && fragments.length === 0) return undefined;

  const segment = envSegment(
    typeof remote.domain === 'string' ? remote.domain : id,
  );
  const dispatch =
    remote.backendFederation?.executionSurfaces?.cloudflare?.workerDispatch;
  const bindingEnv =
    typeof dispatch?.serviceBindingEnv === 'string'
      ? dispatch.serviceBindingEnv
      : `VERTICAL_${segment}_WORKER_BINDING`;
  const workerNameEnv =
    typeof dispatch?.dispatchWorkerNameEnv === 'string'
      ? dispatch.dispatchWorkerNameEnv
      : `VERTICAL_${segment}_WORKER_NAME`;
  return {
    binding:
      envValue(environment, bindingEnv) ??
      (typeof dispatch?.serviceBinding === 'string'
        ? dispatch.serviceBinding
        : `VERTICAL_${segment}_WORKER`),
    service:
      envValue(environment, workerNameEnv) ??
      requiredString(
        remote.cloudflare?.workerName,
        `${id}.cloudflare.workerName`,
      ),
    ...(remote.api
      ? {
          prefix: requiredString(
            remote.api.bff?.prefix,
            `${id}.api.bff.prefix`,
          ),
        }
      : {}),
    ...(fragments.length > 0 ? { fragments } : {}),
  };
};

const zephyrBuildPlugin = (
  from: string | URL,
  environment: Readonly<NodeJS.ProcessEnv>,
): CliPlugin<AppTools> => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api) {
    if ((environment.ZE_CI_TOKEN ?? '').length === 0) return;
    if (environment.ZE_FAIL_BUILD !== 'true') {
      throw new Error(
        'ZE_CI_TOKEN is set but ZE_FAIL_BUILD is not "true", so a failed Zephyr upload would not fail the deploy. Set ZE_FAIL_BUILD=true in the deploy environment next to ZE_CI_TOKEN.',
      );
    }
    if (
      environment.ZE_CI_TOKEN !== process.env.ZE_CI_TOKEN ||
      environment.ZE_FAIL_BUILD !== process.env.ZE_FAIL_BUILD
    ) {
      throw new Error(
        'Zephyr reads credentials and fail-build policy from process.env. ZE_CI_TOKEN and ZE_FAIL_BUILD must match the supplied build environment before its uploader can register.',
      );
    }
    // Resolve the app's declared uploader only for an authoritative deploy.
    // Ordinary builds never load Zephyr, contact it, or require an account.
    const require = createRequire(from);
    const { withZephyr } = require('zephyr-rspack-plugin') as {
      withZephyr: () => Parameters<typeof api.modifyRspackConfig>[0];
    };
    api.modifyRspackConfig(withZephyr());
  },
});

const dynamicCloudflareServicesPlugin = (
  remotes: TopologyApp[],
  dynamicRemotes: Set<TopologyApp>,
  workspaceRoot: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  initialServices: readonly CloudflareWorkerServiceBindingConfig[],
): CliPlugin<AppTools> => ({
  name: '@modern-js/ultramodern-workspace-services',
  setup(api) {
    api.modifyResolvedConfig(async normalizedConfig => {
      const services: CloudflareWorkerServiceBindingConfig[] = [];
      for (const remote of remotes) {
        let exposes = remote.moduleFederation?.exposes ?? [];
        if (dynamicRemotes.has(remote)) {
          const appDirectory = path.resolve(
            workspaceRoot,
            requiredString(remote.path, 'remote.path'),
          );
          // Use Modern.js's loader, including config functions and local dev
          // overrides. A valid native config is not restricted by the static
          // inspector's ability to understand its source.
          const loaded = await createLoadedConfig<unknown>(
            appDirectory,
            path.join(appDirectory, 'module-federation.config.ts'),
          );
          if (!record(loaded.config)) {
            throw new Error(
              `Invalid Module Federation config for ${String(remote.id)}.`,
            );
          }
          const authoredExposes = loaded.config.exposes;
          exposes = record(authoredExposes)
            ? Object.keys(authoredExposes)
            : (authoredExposes ?? []);
        } else {
          exposes =
            readModuleFederationConfigInspection(
              workspaceRoot,
              requiredString(remote.path, 'remote.path'),
            )?.exposes ?? exposes;
        }
        const binding = serviceBinding(remote, environment, exposes);
        if (binding) services.push(binding);
      }
      // Native config-hook contributions can precede preset services. Replace
      // only the original native bindings, wherever merge placed them, so
      // authored config and plugin contributions retain their services.
      const remainingInitialServices = [...initialServices];
      const authoredServices =
        normalizedConfig.deploy.worker?.services?.filter(service => {
          const index = remainingInitialServices.findIndex(initial =>
            isDeepStrictEqual(service, initial),
          );
          if (index < 0) return true;
          remainingInitialServices.splice(index, 1);
          return false;
        }) ?? [];
      return {
        ...normalizedConfig,
        deploy: {
          ...normalizedConfig.deploy,
          worker: {
            ...normalizedConfig.deploy.worker,
            services: [...services, ...authoredServices],
          },
        },
      };
    });
  },
});

const resolveWorkspaceConfig = (
  config: AppUserConfig,
  options: PresetUltramodernWorkspaceOptions,
) => {
  const environment = { ...(options.environment ?? process.env) };
  const configFilename =
    options.from instanceof URL || String(options.from).startsWith('file:')
      ? fileURLToPath(options.from)
      : path.resolve(options.from);
  const appDirectory = path.dirname(configFilename);
  const workspaceRoot = findWorkspaceRoot(appDirectory);
  if (!workspaceRoot) {
    throw new Error(
      `[ultramodern-workspace] No reference topology for ${options.appId} at ${appDirectory}.`,
    );
  }
  const topology = readJson(
    path.join(workspaceRoot, REFERENCE_TOPOLOGY_PATH),
  ) as ReferenceTopology;
  const overlay = readJson(
    path.join(workspaceRoot, DEVELOPMENT_OVERLAY_PATH),
  ) as DevelopmentOverlay;
  if (
    topology.schemaVersion !== 1 ||
    overlay.schemaVersion !== 1 ||
    !record(topology.shell) ||
    !Array.isArray(topology.verticals) ||
    (topology.shells !== undefined && !Array.isArray(topology.shells)) ||
    !record(overlay.ports)
  ) {
    throw new Error(
      '[ultramodern-workspace] Invalid reference topology or development overlay.',
    );
  }
  const apps = [
    ...(topology.shell ? [topology.shell] : []),
    ...(topology.shells ?? []),
    ...topology.verticals,
  ];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const candidate of apps) {
    if (!record(candidate))
      throw new Error('[ultramodern-workspace] Invalid topology app.');
    const id = requiredString(candidate.id, 'app.id');
    const declaredPath = requiredString(candidate.path, `${id}.path`);
    const absolutePath = path.resolve(
      workspaceRoot,
      normalizeRelativePath(declaredPath),
    );
    const relativePath = path.relative(workspaceRoot, absolutePath);
    if (
      ids.has(id) ||
      paths.has(absolutePath) ||
      path.isAbsolute(declaredPath) ||
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `[ultramodern-workspace] Unsafe or duplicate topology identity/path for ${id}.`,
      );
    }
    ids.add(id);
    paths.add(absolutePath);
  }
  const app = apps.find(candidate => candidate.id === options.appId);
  if (!app || !['shell', 'vertical'].includes(String(app.kind))) {
    throw new Error(`[ultramodern-workspace] Unknown app ${options.appId}.`);
  }
  const appPath = requiredString(app.path, `${options.appId}.path`);
  if (
    path.resolve(workspaceRoot, normalizeRelativePath(appPath)) !== appDirectory
  ) {
    throw new Error(
      `[ultramodern-workspace] App ${options.appId} path does not match its config location.`,
    );
  }
  const packageManifest = readJson(path.join(appDirectory, 'package.json'));
  if (
    app.package !== packageManifest.name ||
    app.deliveryUnit?.packageName !== packageManifest.name
  ) {
    throw new Error(
      `[ultramodern-workspace] Package identity for ${options.appId} does not match topology.`,
    );
  }
  if (app.deliveryUnit?.version !== packageManifest.version) {
    throw new Error(
      `[ultramodern-workspace] Delivery unit version for ${options.appId} does not match package.json.`,
    );
  }
  // Topology declares each UI app's renderer. The authored config may restate
  // it for `defineConfig`, but cannot select a different renderer. A headless
  // unit declares renderer `none`: it has no UI renderer and no browser Module
  // Federation identity, so its config selects no renderer at all.
  const declaredRenderer = (app as { renderer?: unknown }).renderer;
  const headless =
    app.surfaceProfile === 'api-only' || declaredRenderer === 'none';
  if (
    (headless && config.renderer !== undefined) ||
    (declaredRenderer !== undefined &&
      config.renderer !== undefined &&
      config.renderer !== declaredRenderer)
  ) {
    throw new Error(
      `[ultramodern-workspace] Renderer for ${options.appId} does not match topology${headless ? ': a headless unit selects no renderer' : ''}.`,
    );
  }
  const portEnv = portEnvironment(app);
  const port = developmentPort(
    environment[portEnv] ?? overlay.ports[options.appId],
    options.appId,
  );
  const allowedOrigins = Object.entries(overlay.ports).map(
    ([id, defaultPort]) => {
      const declaredApp = apps.find(candidate => candidate.id === id);
      const override = declaredApp
        ? environment[portEnvironment(declaredApp)]
        : undefined;
      return `http://localhost:${developmentPort(override ?? defaultPort, id)}`;
    },
  );
  const target = options.deployTarget
    ? resolveDeployTarget({ argv: [], configTarget: options.deployTarget })
        .target
    : resolveDeployTarget({
        configTarget: config.deploy?.target,
        env: environment.MODERNJS_DEPLOY ?? '',
      }).target;
  if (
    options.deployTarget &&
    config.deploy?.target &&
    config.deploy.target !== target
  ) {
    throw new Error(
      '[ultramodern-workspace] Authored deploy.target does not match the explicit programmatic deployTarget.',
    );
  }
  const cloudflare = target === 'cloudflare';
  const workerName = requiredString(
    app.cloudflare?.workerName,
    `${options.appId}.cloudflare.workerName`,
  );
  const publicUrlEnv = requiredString(
    app.cloudflare?.publicUrlEnv,
    `${options.appId}.cloudflare.publicUrlEnv`,
  );
  const configuredCloudflareUrl = envValue(environment, publicUrlEnv);
  const workersDevSubdomain = envValue(
    environment,
    'ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN',
  );
  const inferredCloudflareUrl =
    cloudflare && workersDevSubdomain
      ? `https://${workerName}.${workersDevSubdomain}.workers.dev`
      : undefined;
  const siteUrl =
    envValue(environment, 'MODERN_PUBLIC_SITE_URL') ||
    configuredCloudflareUrl ||
    inferredCloudflareUrl ||
    `http://localhost:${port}`;
  const remoteAssetOrigin =
    configuredCloudflareUrl ||
    inferredCloudflareUrl ||
    (cloudflare ? '' : `http://localhost:${port}`);
  let defaultAssetPrefix =
    app.kind === 'shell'
      ? '/'
      : remoteAssetOrigin
        ? `${remoteAssetOrigin.replace(/\/+$/u, '')}/`
        : 'auto';
  const assetPrefixOverride =
    envValue(environment, 'MODERN_ASSET_PREFIX') ||
    envValue(environment, 'ULTRAMODERN_ASSET_PREFIX');
  if (
    !assetPrefixOverride &&
    config.output?.assetPrefix === undefined &&
    declaredRenderer === 'octane' &&
    app.kind === 'vertical' &&
    Array.isArray(app.moduleFederation?.exposes) &&
    app.moduleFederation.exposes.length > 0
  ) {
    const name = requiredString(
      app.moduleFederation.name,
      `${options.appId}.moduleFederation.name`,
    );
    const address = resolveBrowserManifestAddress(
      { ...environment, MODERNJS_DEPLOY: target },
      {
        manifestEnv: `VERTICAL_${envSegment(typeof app.domain === 'string' ? app.domain : options.appId)}_MF_MANIFEST`,
        publicUrlEnv,
        mfName: name,
        workerName,
        port,
      },
      environment.NODE_ENV ?? 'production',
    );
    if (!address.ok)
      throw new Error(
        `[ultramodern-workspace] Remote ${name}: ${address.reason}`,
      );
    defaultAssetPrefix = new URL('.', address.manifestUrl).href;
  }
  const assetPrefix = assetPrefixOverride || defaultAssetPrefix;
  const buildTarget = cloudflare ? 'cloudflare' : 'web';
  const refs =
    app.verticalRefs ??
    app.moduleFederation?.verticalRefs ??
    (Array.isArray(app.moduleFederation?.remotes)
      ? app.moduleFederation.remotes.map(remote =>
          record(remote) ? remote.id : undefined,
        )
      : []);
  if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) {
    throw new Error(
      `[ultramodern-workspace] Invalid remote references for ${options.appId}.`,
    );
  }
  const referencedRemotes = cloudflare
    ? refs.map(ref => {
        const remote = topology.verticals!.find(
          candidate => candidate.id === ref,
        );
        if (!remote)
          throw new Error(
            `[ultramodern-workspace] Unknown remote ${ref} for ${options.appId}.`,
          );
        return remote;
      })
    : [];
  const dynamicRemotes = new Set<TopologyApp>();
  const services = referencedRemotes.flatMap(remote => {
    const appPath = requiredString(remote.path, 'remote.path');
    const inspection = readModuleFederationConfigInspection(
      workspaceRoot,
      appPath,
    );
    if (
      !inspection &&
      existsSync(
        path.join(workspaceRoot, appPath, 'module-federation.config.ts'),
      )
    ) {
      dynamicRemotes.add(remote);
      return [];
    }
    const binding = serviceBinding(
      remote,
      environment,
      inspection?.exposes ?? remote.moduleFederation?.exposes ?? [],
    );
    return binding ? [binding] : [];
  });
  // Only UI units own a browser Module Federation container whose chunk
  // globals must stay distinct in a shared page.
  const mfName = headless
    ? undefined
    : requiredString(
        app.moduleFederation?.name,
        `${options.appId}.moduleFederation.name`,
      );
  const workspaceConfig: AppUserConfig = {
    ...(!headless && declaredRenderer !== undefined
      ? { renderer: declaredRenderer as AppUserConfig['renderer'] }
      : {}),
    ...(cloudflare
      ? {
          deploy: {
            target,
            worker: {
              compatibilityDate: requiredString(
                app.cloudflare?.compatibilityDate,
                `${options.appId}.cloudflare.compatibilityDate`,
              ),
              name: workerName,
              security: app.cloudflare?.security,
              ...(services.length > 0 ? { services } : {}),
              ssr: true,
            },
          },
        }
      : options.deployTarget
        ? { deploy: { target } }
        : {}),
    dev: {
      assetPrefix: app.kind === 'shell' ? '/' : assetPrefix,
      server: { cors: { origin: allowedOrigins } },
    },
    html: { outputStructure: 'flat' },
    output: {
      assetPrefix,
      disableTsChecker: false,
      distPath: { html: './', root: cloudflare ? 'dist-cloudflare' : 'dist' },
      polyfill: 'off',
      splitRouteChunks: true,
      tempDir: `node_modules/.modern-js-${options.appId}-${buildTarget}`,
    },
    performance: {
      buildCache: {
        cacheDigest: [options.appId, buildTarget],
        cacheDirectory: `node_modules/.cache/rspack-${options.appId}-${buildTarget}`,
      },
    },
    plugins: [
      ...(dynamicRemotes.size > 0
        ? [
            dynamicCloudflareServicesPlugin(
              referencedRemotes,
              dynamicRemotes,
              workspaceRoot,
              environment,
              services,
            ),
          ]
        : []),
      ...(headless ? [] : [zephyrBuildPlugin(configFilename, environment)]),
    ],
    server: { port, publicDir: ['./locales', './assets'] },
    source: {
      alias: {
        '@modern-js/plugin-i18n/runtime$':
          '@modern-js/plugin-i18n/runtime/no-react-i18next',
      },
      globalVars: { ULTRAMODERN_SITE_URL: siteUrl },
      mainEntryName: 'index',
    },
    tools: {
      ...(mfName
        ? {
            bundlerChain: chain => {
              chain.output
                .uniqueName(mfName)
                .chunkLoadingGlobal(
                  `__ULTRAMODERN_${envSegment(mfName)}_LOADED_CHUNKS__`,
                );
            },
          }
        : {}),
      devServer: {
        headers: {
          'Access-Control-Allow-Headers':
            'Accept, Authorization, Content-Type, X-Requested-With',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          ...(allowedOrigins.length === 1
            ? { 'Access-Control-Allow-Origin': allowedOrigins[0] }
            : {}),
        },
      },
      tsChecker: { typescript: { build: false } },
    },
  };
  const presetOptions: PresetUltramodernOptions = {
    ...options,
    environment,
    deliveryUnit: {
      buildMarker: requiredString(
        app.deliveryUnit?.buildMarker,
        `${options.appId}.deliveryUnit.buildMarker`,
      ),
      unitId: requiredString(
        app.deliveryUnit?.unitId,
        `${options.appId}.deliveryUnit.unitId`,
      ),
      version: requiredString(
        app.deliveryUnit?.version,
        `${options.appId}.deliveryUnit.version`,
      ),
      workspaceRoot,
    },
  };
  return { workspaceConfig, presetOptions };
};

/** Inspect the native policy for an app in its declared workspace. */
export const createPresetUltramodernWorkspaceConfig = (
  options: PresetUltramodernWorkspaceOptions,
): AppUserConfig => presetUltramodernWorkspace({}, options);

/**
 * Compose workspace build policy before authored Modern.js configuration.
 * Nested records, arrays and hooks keep presetUltramodern's native merge rules.
 */
export const presetUltramodernWorkspace = (
  config: AppUserConfig,
  options: PresetUltramodernWorkspaceOptions,
): AppUserConfig => {
  const { workspaceConfig, presetOptions } = resolveWorkspaceConfig(
    config,
    options,
  );
  return presetUltramodern(
    mergeConfig<AppUserConfig, AppUserConfig>([workspaceConfig, config]),
    presetOptions,
  );
};
