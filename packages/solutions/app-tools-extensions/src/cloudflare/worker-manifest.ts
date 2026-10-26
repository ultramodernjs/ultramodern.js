import path from 'node:path';
import type {
  BffEffectDataPlatformUserConfig,
  BffEffectOpenApiUserConfig,
} from '@modern-js/server-runtime-extensions/server-config';
import { fs as fse } from '@modern-js/utils';
import { getCloudflareWorkerRouteDataEntryName } from '../cloudflare-output-contract';
import { readRouteSpec } from './artifacts';
import {
  ASSETS_BINDING,
  BFF_EFFECT_WORKER_DISPATCHER_EXPORT,
  BFF_EFFECT_WORKER_ENTRY,
  CLOUDFLARE_RUNTIME_TYPE,
  CLOUDFLARE_WORKER_BUNDLE_FORMAT,
  DEFAULT_SERVER_ONLY_PUBLIC_ASSET_EXCLUDES,
  EFFECT_BFF_CLOUDFLARE_IMPORT_GUIDANCE,
  LOADABLE_STATS_FILE,
  PUBLIC_ASSETS_DIRECTORY,
  ROUTE_MANIFEST_FILE,
  ROUTE_SPEC_FILE,
  ROUTE_SPEC_OUTPUT,
  SERVER_BUNDLE_DIRECTORY,
  WORKER_BUNDLE_DIRECTORY,
  WORKER_ENTRY,
} from './constants';
import type { DeliveryUnitStamp } from './delivery-unit';
import { createI18nWorkerManifest } from './i18n-worker';
import { readNativeRendererWorkerResources } from './native-renderer';
import { readWorkerRendererBuild } from './renderer-identity';
import { createCloudflareWorkerSecurityPolicy } from './security-policies';
import type { CloudflareAppContext, CloudflareModernConfig } from './types';
import { isRecord, normalizeRelativePath } from './utils';
import {
  createWorkerManifestServiceBindings,
  createWorkerServiceBindings,
  createWorkerVpcServiceBindings,
  getWorkerEffectBffPrefix,
} from './wrangler-config';

const createMissingEffectBffWorkerError = (
  outputDirectory: string,
  worker: string,
) =>
  new Error(
    `Cloudflare Effect API runtime is configured, but the BFF worker bundle is missing: ${path.join(
      outputDirectory,
      worker,
    )}. ${EFFECT_BFF_CLOUDFLARE_IMPORT_GUIDANCE}`,
  );

const createEffectBffWorkerManifest = (
  modernConfig: CloudflareModernConfig,
) => {
  const bff = modernConfig.bff;
  const configuredPolicy = bff?.crossProjectPolicy;
  if (configuredPolicy?.verifyProducerIdentity !== undefined) {
    throw new Error(
      'Cloudflare Effect BFF cannot serialize bff.crossProjectPolicy.verifyProducerIdentity into the worker manifest. Configure a worker-native identity binding before enabling this policy at the edge.',
    );
  }
  const crossProjectPolicy = {
    ...configuredPolicy,
    enabled: configuredPolicy?.enabled ?? Boolean(bff?.isCrossProjectServer),
    requireEnvelope: configuredPolicy?.requireEnvelope ?? true,
    requireOperationContext: configuredPolicy?.requireOperationContext ?? true,
    requireOperationContextDetails:
      configuredPolicy?.requireOperationContextDetails ?? true,
    requireOperationSchemaHash:
      configuredPolicy?.requireOperationSchemaHash ?? true,
    requireOperationVersion: configuredPolicy?.requireOperationVersion ?? true,
    allowUnknownOperations: configuredPolicy?.allowUnknownOperations ?? false,
    expectedOperationContracts: {
      ...(configuredPolicy?.expectedOperationContracts ?? {}),
    },
  };

  const openapi: BffEffectOpenApiUserConfig | undefined = bff?.effect?.openapi;
  const dataPlatform: BffEffectDataPlatformUserConfig | undefined =
    bff?.effect?.dataPlatform;

  return {
    ...(openapi === undefined ? {} : { openapi }),
    ...(dataPlatform === undefined ? {} : { dataPlatform }),
    crossProjectPolicy,
  };
};

const createModuleFederationWorkerManifest = async (
  outputDirectory: string,
) => {
  const manifestPath = path.join(
    outputDirectory,
    PUBLIC_ASSETS_DIRECTORY,
    'mf-manifest.json',
  );

  if (!(await fse.pathExists(manifestPath))) {
    return undefined;
  }

  const manifest = (await fse.readJson(manifestPath)) as unknown;
  const name =
    isRecord(manifest) && typeof manifest.name === 'string'
      ? manifest.name
      : undefined;
  const manifestExposes =
    isRecord(manifest) && Array.isArray(manifest.exposes)
      ? manifest.exposes
      : [];
  const exposes = manifestExposes.filter(isRecord).flatMap(expose => {
    if (typeof expose.path !== 'string') {
      return [];
    }
    const assets = isRecord(expose.assets) ? expose.assets : undefined;
    const css = assets && isRecord(assets.css) ? assets.css : undefined;
    return [
      {
        path: expose.path,
        css: [
          ...(css && Array.isArray(css.sync) ? css.sync : []),
          ...(css && Array.isArray(css.async) ? css.async : []),
        ].filter(
          (asset): asset is string =>
            typeof asset === 'string' && asset.endsWith('.css'),
        ),
      },
    ];
  });

  if (!name || exposes.length === 0) return undefined;

  // A fragment is rendered by this app's own route, so it depends on the
  // route stylesheets too (for example a global Tailwind sheet no exposed
  // component imports). Bundle them so the worker reports them to the
  // composing shell without reading assets at request time.
  const routeManifestPath = path.join(
    outputDirectory,
    PUBLIC_ASSETS_DIRECTORY,
    ROUTE_MANIFEST_FILE,
  );
  const routeManifest = (await fse.pathExists(routeManifestPath))
    ? ((await fse.readJson(routeManifestPath)) as unknown)
    : undefined;
  const routeAssets =
    isRecord(routeManifest) && isRecord(routeManifest.routeAssets)
      ? Object.values(routeManifest.routeAssets).filter(isRecord)
      : [];
  const routeCss = [
    ...new Set(
      routeAssets.flatMap(routeAsset =>
        [routeAsset.referenceCssAssets, routeAsset.assets]
          .flatMap(value => (Array.isArray(value) ? value : []))
          .filter(
            (asset): asset is string =>
              typeof asset === 'string' && asset.endsWith('.css'),
          ),
      ),
    ),
  ];

  return { name, exposes, routeCss };
};

export const createWorkerManifest = async (
  outputDirectory: string,
  modernConfig: CloudflareModernConfig,
  appContext: CloudflareAppContext,
  deliveryUnitStamp: DeliveryUnitStamp | undefined,
) => {
  const routeSpec = await readRouteSpec(outputDirectory);
  const routes = await Promise.all(
    routeSpec.routes.map(async (route: Record<string, any>) => {
      const worker =
        typeof route.worker === 'string' ? route.worker : undefined;
      const routeDataWorker =
        route.isSSR && typeof route.entryName === 'string'
          ? `${WORKER_BUNDLE_DIRECTORY}/${getCloudflareWorkerRouteDataEntryName(
              route.entryName,
            )}.js`
          : undefined;
      const hasRouteDataWorker = routeDataWorker
        ? await fse.pathExists(path.join(outputDirectory, routeDataWorker))
        : false;

      return {
        urlPath: route.urlPath,
        entryName: route.entryName,
        entryPath: route.entryPath,
        isSSR: Boolean(route.isSSR),
        worker,
        workerExists: worker
          ? await fse.pathExists(path.join(outputDirectory, worker))
          : false,
        ...(hasRouteDataWorker ? { routeDataWorker } : {}),
        // Native workers apply configured route headers as the Node host does.
        ...(route.responseHeaders && typeof route.responseHeaders === 'object'
          ? { responseHeaders: route.responseHeaders }
          : {}),
      };
    }),
  );
  const rendererBuild = await readWorkerRendererBuild(
    appContext.distDirectory,
    routeSpec.routes,
    deliveryUnitStamp,
  );
  const rendererIdentities = rendererBuild?.identities;
  const nativeRenderer = await readNativeRendererWorkerResources(
    appContext.distDirectory,
    rendererBuild,
  );
  // Native-document renderers serve pages only through their native server
  // handler. Fail deploy before emitting an entry that could only reject.
  for (const route of routes) {
    const renderer =
      typeof route.entryName === 'string' &&
      rendererIdentities &&
      Object.hasOwn(rendererIdentities, route.entryName)
        ? rendererIdentities[route.entryName].renderer
        : undefined;
    if (
      renderer !== undefined &&
      rendererBuild?.renderer.nativeDocuments &&
      (nativeRenderer?.renderer !== renderer || !route.workerExists)
    )
      throw new Error(
        `Cloudflare worker deploy of the ${renderer} renderer requires its native worker build for entry ${route.entryName}. Set deploy.worker.ssr: true and rebuild with the Cloudflare deploy target.`,
      );
  }

  const isEffectApi =
    Boolean(modernConfig.bff) && modernConfig.bff?.runtimeFramework !== 'hono';
  const effectBffPrefix = getWorkerEffectBffPrefix(modernConfig);
  const effectApiWorkerExists = await fse.pathExists(
    path.join(outputDirectory, BFF_EFFECT_WORKER_ENTRY),
  );
  const typedServiceBindings = createWorkerServiceBindings(
    modernConfig,
    undefined,
  );
  const serviceBindings = createWorkerManifestServiceBindings(
    typedServiceBindings,
    // The wrangler config checks VPC names against every Worker binding; the
    // manifest only needs the framework-owned assets binding reserved.
    createWorkerVpcServiceBindings(
      modernConfig,
      undefined,
      typedServiceBindings,
      new Set([ASSETS_BINDING]),
    ),
  );
  const moduleFederation =
    await createModuleFederationWorkerManifest(outputDirectory);

  if (effectBffPrefix !== undefined && !effectApiWorkerExists) {
    throw createMissingEffectBffWorkerError(
      outputDirectory,
      BFF_EFFECT_WORKER_ENTRY,
    );
  }
  const effectBffManifest = isEffectApi
    ? createEffectBffWorkerManifest(modernConfig)
    : undefined;

  return {
    version: 1,
    runtime: {
      type: CLOUDFLARE_RUNTIME_TYPE,
      entry: WORKER_ENTRY,
      fetchExport: true,
      nodeListen: false,
    },
    assets: {
      binding: ASSETS_BINDING,
      directory: `./${PUBLIC_ASSETS_DIRECTORY}`,
      runWorkerFirst: true,
    },
    routeSpec: {
      file: ROUTE_SPEC_OUTPUT,
      routes,
    },
    workerBundles: {
      directory: WORKER_BUNDLE_DIRECTORY,
      format: CLOUDFLARE_WORKER_BUNDLE_FORMAT,
      importableFromModuleWorker: true,
      requestHandlerExport: 'requestHandler',
    },
    resources: {
      loadableStats: LOADABLE_STATS_FILE,
      routeManifest: ROUTE_MANIFEST_FILE,
    },
    security: createCloudflareWorkerSecurityPolicy(modernConfig),
    ...(moduleFederation === undefined ? {} : { moduleFederation }),
    ...(deliveryUnitStamp ? { deliveryUnit: deliveryUnitStamp } : {}),
    ...(rendererBuild
      ? { renderer: rendererBuild.renderer, rendererIdentities }
      : {}),
    ...(nativeRenderer ? { nativeRenderer } : {}),
    i18n: createI18nWorkerManifest(routeSpec, appContext),
    bff:
      effectBffPrefix !== undefined && effectApiWorkerExists
        ? {
            dispatcherExport: BFF_EFFECT_WORKER_DISPATCHER_EXPORT,
            runtimeFramework: 'effect',
            prefix: effectBffPrefix,
            worker: BFF_EFFECT_WORKER_ENTRY,
            effect: effectBffManifest,
          }
        : undefined,
    ...(serviceBindings === undefined ? {} : { serviceBindings }),
  };
};

export const createWorkerModuleLoaders = (manifest: any) => {
  const imports = new Map<string, string>();

  for (const route of manifest.routeSpec.routes) {
    for (const worker of [
      route.workerExists ? route.worker : undefined,
      route.routeDataWorker,
    ]) {
      if (worker) {
        const importPath = `../${String(worker).replace(/^\/+/u, '')}`;
        imports.set(worker, `() => import(${JSON.stringify(importPath)})`);
      }
    }
  }

  if (manifest.bff?.worker) {
    const importPath = `../${String(manifest.bff.worker).replace(/^\/+/u, '')}`;
    imports.set(
      manifest.bff.worker,
      `() => import(${JSON.stringify(importPath)})`,
    );
  }

  if (imports.size === 0) {
    return '{}';
  }

  const loaders = [...imports.entries()].map(
    ([worker, loader]) => `${JSON.stringify(worker)}: ${loader}`,
  );

  return `{\n${loaders.join(',\n')}\n}`;
};

export const getPublicAssetExcludes = (
  appDirectory: string,
  modernConfig: CloudflareModernConfig,
) =>
  [
    ...DEFAULT_SERVER_ONLY_PUBLIC_ASSET_EXCLUDES.filter(directory => {
      try {
        return fse.statSync(path.join(appDirectory, directory)).isDirectory();
      } catch {
        return false;
      }
    }),
    ...(modernConfig.deploy?.worker?.publicAssetExcludes ?? []),
  ].map(entry =>
    normalizeRelativePath(entry, 'deploy.worker.publicAssetExcludes'),
  );

export const shouldCopyToPublicAssets = (
  src: string,
  distDirectory: string,
  publicAssetExcludes: string[],
) => {
  const relativePath = path.relative(distDirectory, src);

  if (!relativePath) {
    return true;
  }

  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  const [topLevelDirectory] = normalizedRelativePath.split('/');
  const basename = normalizedRelativePath.split('/').pop() ?? '';

  return (
    normalizedRelativePath !== ROUTE_SPEC_FILE &&
    topLevelDirectory !== WORKER_BUNDLE_DIRECTORY &&
    topLevelDirectory !== SERVER_BUNDLE_DIRECTORY &&
    basename !== '.env' &&
    !basename.startsWith('.env.') &&
    !publicAssetExcludes.some(
      exclude =>
        normalizedRelativePath === exclude ||
        normalizedRelativePath.startsWith(`${exclude}/`),
    )
  );
};

export const shouldCopyToWorkerBundle = (
  src: string,
  workerBundleDirectory: string,
) => {
  const relativePath = path.relative(workerBundleDirectory, src);

  if (!relativePath) {
    return true;
  }

  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  const basename = path.basename(normalizedRelativePath);

  if (basename.startsWith('.') || normalizedRelativePath.includes('/.')) {
    return false;
  }

  if (fse.statSync(src).isDirectory()) {
    return true;
  }

  return ['.cjs', '.js', '.mjs'].includes(path.extname(normalizedRelativePath));
};
