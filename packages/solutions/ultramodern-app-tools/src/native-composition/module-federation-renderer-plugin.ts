import { createRequire } from 'node:module';
import path from 'node:path';
import type { AppTools, CliPlugin } from '@modern-js/app-tools';
import type { RendererBuildIdentities } from '@modern-js/app-tools-extensions/renderer-build-identity';
import {
  RENDERER_FEDERATION_METADATA_KEY,
  RENDERER_FEDERATION_SCHEMA,
  RENDERER_FEDERATION_SCHEMA_VERSION,
  type RendererFederationCompatibility,
  readRendererFederationCompatibility,
  readRendererFederationContract,
  rendererFederationError,
} from '@modern-js/federation-runtime/renderer-contract';
import type { Renderer } from '@modern-js/renderer-core';
import type { Rspack } from '@rsbuild/core';
import { resolveReactFederationCompatibility } from '../renderers/react/module-federation';
import {
  projectInstalledFederationProfile,
  readRendererFrameworkPackage,
} from './renderer-installed-profile';
import { resolveRendererProfileMetadata } from './renderer-profile';
import { resolveRendererAdapter } from './renderer-registration';

/** The CLI plugin that installs native MF for non-React renderers. */
export const NATIVE_MODULE_FEDERATION_PLUGIN =
  '@modern-js/ultramodern-native-module-federation';

const NATIVE_PLUGINS = [
  'plugin-module-federation',
  'plugin-module-federation-server',
];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
type AdditionalDataArgs = { stats: unknown; compilation: object };
type AdditionalData = (args: AdditionalDataArgs) => unknown | Promise<unknown>;

/** The manifest and stats asset names native MF derives from its manifest options. */
function nativeManifestAssetNames(manifest: Record<string, unknown>): string[] {
  const filePath =
    typeof manifest.filePath === 'string' ? manifest.filePath : '';
  const fileName =
    typeof manifest.fileName === 'string' ? manifest.fileName : '';
  const manifestName = fileName
    ? fileName.endsWith('.json')
      ? fileName
      : `${fileName}.json`
    : 'mf-manifest.json';
  const statsName = fileName
    ? manifestName.replace('.json', '-stats.json')
    : 'mf-stats.json';
  return [manifestName, statsName].map(name =>
    path.posix.join(filePath.replace(/\\/gu, '/'), name),
  );
}

export function resolveRendererFederationRuntimePlugin(
  registrarUrl = import.meta.url,
): string {
  return createRequire(registrarUrl).resolve(
    '@modern-js/federation-runtime/renderer-runtime-plugin',
  );
}

/** Resolve the consuming renderer tuple from the selected installed owners. */
export function resolveRendererFederationCompatibility(
  renderer: Renderer,
): RendererFederationCompatibility {
  const adapter = resolveRendererAdapter(renderer);
  if (adapter.kind !== 'native') return resolveReactFederationCompatibility();
  const owners = adapter.runtime;
  const metadata = resolveRendererProfileMetadata(renderer);
  const bootstrap = metadata.frameworkPackages.find(
    owner => owner.specifier === owners.bootstrap,
  );
  if (!bootstrap)
    throw rendererFederationError(
      `the installed ${renderer} bootstrap owner is absent.`,
    );
  // The runtime is the copy the selected bootstrap owner itself imports.
  const runtime = readRendererFrameworkPackage({
    specifier: owners.package,
    filename: createRequire(`${bootstrap.directory}/package.json`).resolve(
      owners.package,
    ),
  });
  const { protocolVersion, compiler, hydration, router } =
    projectInstalledFederationProfile(metadata.profile, bootstrap);
  return readRendererFederationCompatibility({
    profile: { renderer, protocolVersion, compiler, hydration, router },
    runtime: { name: runtime.name, version: runtime.version },
    bootstrap: { name: bootstrap.name, version: bootstrap.version },
  });
}

/** Stamp and gate MF publications for the selected renderer tuple. */
export function createRendererModuleFederationIntegration(
  renderer: Renderer,
  options: {
    resolveCompatibility?: () => RendererFederationCompatibility;
    resolveRuntimePlugin?: () => string;
  } = {},
) {
  let identities: RendererBuildIdentities | undefined;
  const controller = {
    onBuildIdentities(completed: RendererBuildIdentities): void {
      identities = completed;
    },
  };
  const plugin: CliPlugin<AppTools> = {
    name: '@modern-js/ultramodern-module-federation-renderer-contract',
    pre: [
      '@modern-js/plugin-module-federation-config',
      '@modern-js/plugin-module-federation',
      '@modern-js/plugin-module-federation-ssr',
      NATIVE_MODULE_FEDERATION_PLUGIN,
    ],
    setup(api) {
      api.modifyBundlerChain(chain => {
        const nativeKeys = NATIVE_PLUGINS.filter(key => chain.plugins.has(key));
        if (!nativeKeys.length) return;
        const compatibility = readRendererFederationCompatibility(
          options.resolveCompatibility?.() ??
            resolveRendererFederationCompatibility(renderer),
        );
        const runtimePlugin = (
          options.resolveRuntimePlugin ?? resolveRendererFederationRuntimePlugin
        )();
        const stamped = new WeakSet<object>();
        const publications = new Set<string>();
        for (const nativeKey of nativeKeys)
          chain.plugin(nativeKey).tap(args => {
            const wrapped = record(args[0]) && record(args[0].mfConfig);
            const original = wrapped ? args[0].mfConfig : args[0];
            if (!record(original))
              throw rendererFederationError(
                'native MF configuration is absent.',
              );
            // Native MF shares its browser options with workerSSR. Register on
            // this compiler's snapshot without changing the next compiler's input.
            const config = { ...original };
            if (config.manifest === false)
              throw rendererFederationError(
                'renderer components require native manifest publication.',
              );
            if (
              config.manifest !== undefined &&
              config.manifest !== true &&
              !record(config.manifest)
            )
              throw rendererFederationError(
                'native manifest options must be a boolean or record.',
              );
            const manifest = record(config.manifest) ? config.manifest : {};
            for (const name of nativeManifestAssetNames(manifest))
              publications.add(name);
            const previous = manifest.additionalData;
            if (previous !== undefined && typeof previous !== 'function')
              throw rendererFederationError(
                'native manifest additionalData must be callable.',
              );
            config.manifest = {
              ...manifest,
              async additionalData(input: AdditionalDataArgs) {
                const replacement =
                  previous === undefined
                    ? undefined
                    : await (previous as AdditionalData)(input);
                const stats = replacement ?? input.stats;
                if (!record(stats) || !record(stats.metaData))
                  throw rendererFederationError(
                    'native MF stats metadata is absent.',
                  );
                // The private compiler discovery pass has no completed identity
                // and never emits. The emit hook below rejects unstamped public output.
                if (!identities) return stats;
                if (
                  Object.hasOwn(
                    stats.metaData,
                    RENDERER_FEDERATION_METADATA_KEY,
                  )
                )
                  throw rendererFederationError(
                    'renderer publication metadata has duplicate ownership.',
                  );
                stats.metaData[RENDERER_FEDERATION_METADATA_KEY] =
                  readRendererFederationContract({
                    schema: RENDERER_FEDERATION_SCHEMA,
                    schemaVersion: RENDERER_FEDERATION_SCHEMA_VERSION,
                    ...compatibility,
                    identities: identities.identities,
                  });
                stamped.add(input.compilation);
                return stats;
              },
            };
            if (
              config.runtimePlugins !== undefined &&
              !Array.isArray(config.runtimePlugins)
            )
              throw rendererFederationError(
                'native runtimePlugins must be an array.',
              );
            const runtimePlugins: unknown[] = config.runtimePlugins ?? [];
            if (
              runtimePlugins.some(
                value =>
                  (Array.isArray(value) ? value[0] : value) === runtimePlugin,
              )
            )
              throw rendererFederationError(
                'renderer runtime guard has duplicate registration ownership.',
              );
            // Native node plugins must see only snapshots that passed this gate.
            config.runtimePlugins = [
              [runtimePlugin, compatibility],
              ...runtimePlugins,
            ];
            return [
              wrapped ? { ...args[0], mfConfig: config } : config,
              ...args.slice(1),
            ];
          });
        chain.plugin('ultramodern-mf-renderer-publication').use(
          class {
            apply(compiler: Rspack.Compiler): void {
              compiler.hooks.emit.tap(
                'ultramodern-mf-renderer-publication',
                compilation => {
                  // An environment whose native MF publishes no manifest (the
                  // Cloudflare workerSSR bundle) has no publication to gate.
                  if (
                    !Object.keys(compilation.assets).some(name =>
                      publications.has(name),
                    )
                  )
                    return;
                  if (!stamped.has(compilation))
                    throw rendererFederationError(
                      'emitted native manifest lacks finalized renderer authority.',
                    );
                },
              );
            }
          },
        );
      });
    },
  };
  return { plugin, controller };
}
