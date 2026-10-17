import { isDeepStrictEqual } from 'node:util';
import {
  RENDERER_FEDERATION_METADATA_KEY,
  readRendererFederationContract,
} from '@modern-js/federation-runtime/renderer-contract';
import type {
  NativeCompilerArtifacts,
  ValidatedNativeCompilerArtifact,
} from '@modern-js/renderer-core/adapter';
import {
  readWorkerFederationManifestUrl,
  readWorkerFederationPath,
  WORKER_FEDERATION_METADATA_KEY,
} from '@modern-js/renderer-core/worker-federation';
import type { Rspack } from '@rsbuild/core';
import {
  finalizeNativeWorkerFederationPublication,
  type NativeWorkerFederationPlan,
} from './native-worker-federation';

/** Read the final compiler publication path, after public-path hooks complete. */
export function nativeWorkerFederationManifestUrl(
  assetName: string,
  manifest: unknown,
): string {
  if (!assetName || assetName.includes(':'))
    throw new Error(
      'Native Worker publication requires its manifest filename.',
    );
  const filename = readWorkerFederationPath(`/${assetName}`).slice(1);
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('metaData' in manifest) ||
    !manifest.metaData ||
    typeof manifest.metaData !== 'object' ||
    !('publicPath' in manifest.metaData) ||
    typeof manifest.metaData.publicPath !== 'string'
  )
    throw new Error(
      'Native Worker publication requires its completed MF public path.',
    );
  const prefix = readWorkerFederationManifestUrl(manifest.metaData.publicPath);
  if (prefix.search || prefix.hash)
    throw new Error(
      'Native Worker publication requires a public directory URL.',
    );
  prefix.pathname = prefix.pathname.endsWith('/')
    ? prefix.pathname
    : `${prefix.pathname}/`;
  return readWorkerFederationManifestUrl(new URL(filename, prefix).href).href;
}

/** Client ABI authority exists only after the native compiler emits its artifacts. */
export class NativeWorkerFederationPublicationPlugin {
  constructor(
    private readonly readPlan: () => NativeWorkerFederationPlan | undefined,
    private readonly artifacts: NativeCompilerArtifacts,
  ) {}

  apply(compiler: Rspack.Compiler): void {
    const name = 'UltraModernNativeWorkerPublication';
    compiler.hooks.thisCompilation.tap(name, compilation => {
      compilation.hooks.processAssets.tapPromise(
        {
          name,
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT + 2,
        },
        async () => {
          const plan = this.readPlan();
          if (!plan) return;
          if (!compilation.hash)
            throw new Error(
              'Native Worker publication requires its actual client compilation hash.',
            );
          const validated: Record<string, ValidatedNativeCompilerArtifact> = {};
          for (const [entryName, identity] of Object.entries(
            plan.renderer.identities,
          )) {
            const asset = compilation.getAsset(
              this.artifacts.clientManifestFile(entryName),
            );
            if (!asset)
              throw new Error(
                `Native Worker publication requires the completed client artifact for ${entryName}.`,
              );
            validated[entryName] = await this.artifacts.validateClientManifest(
              JSON.parse(asset.source.source().toString()),
              identity,
              { compilationHash: compilation.hash, development: false },
            );
          }
          const worker = finalizeNativeWorkerFederationPublication(
            plan,
            validated,
          );
          let publications = 0;
          for (const { name: filename, source } of compilation.getAssets()) {
            if (!filename.endsWith('.json')) continue;
            let manifest: unknown;
            try {
              manifest = JSON.parse(source.source().toString());
            } catch {
              continue;
            }
            if (
              !manifest ||
              typeof manifest !== 'object' ||
              !('metaData' in manifest)
            )
              continue;
            const metadata = manifest.metaData;
            if (
              !metadata ||
              typeof metadata !== 'object' ||
              !(RENDERER_FEDERATION_METADATA_KEY in metadata)
            )
              continue;
            const renderer = readRendererFederationContract(
              metadata[RENDERER_FEDERATION_METADATA_KEY],
            );
            if (!isDeepStrictEqual(renderer, plan.renderer))
              throw new Error(
                'Native Worker publication conflicts with the finalized renderer contract.',
              );
            if (WORKER_FEDERATION_METADATA_KEY in metadata)
              throw new Error(
                'Native Worker publication has duplicate metadata ownership.',
              );
            Object.assign(metadata, {
              [WORKER_FEDERATION_METADATA_KEY]: worker,
            });
            compilation.updateAsset(
              filename,
              new compiler.webpack.sources.RawSource(JSON.stringify(manifest)),
            );
            publications++;
          }
          if (!publications)
            throw new Error(
              'Native Worker exposes require a finalized Module Federation manifest publication.',
            );
        },
      );
    });
  }
}
