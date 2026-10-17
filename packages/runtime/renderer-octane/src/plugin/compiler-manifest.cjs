const { createHash } = require('node:crypto');
const path = require('node:path');
const { getOctaneRspackBuildInfo } = require('@octanejs/rspack-plugin');

const name = 'ultramodern:octane:compiler-manifest';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The released native compiler remains responsible for every transformation. */
class OctaneCompilerManifestPlugin {
  constructor(options) {
    this.options = options;
  }

  apply(compiler) {
    compiler.hooks.normalModuleFactory.tap(name, factory => {
      factory.hooks.beforeResolve.tap(name, result => {
        if (/\.svg\?(?:[^#]*&)?react(?:[=&]|$)/u.test(result.request)) {
          throw new Error(
            'unsupported-renderer-capability: `?react` SVG imports are React components; import Octane SVG components with `?component`.',
          );
        }
      });
      factory.hooks.afterResolve.tap(name, result => {
        const resource = result.createData?.resource?.split('?')[0];
        if (resource && path.extname(resource).toLowerCase() === '.jsx') {
          throw new Error(
            `unsupported-renderer-capability: Octane does not support .jsx source: ${resource}. Supported source extensions: .tsx, .tsrx, .ts, .js.`,
          );
        }
      });
    });
    if (!this.options.emitClientManifest) return;
    compiler.hooks.thisCompilation.tap(name, compilation => {
      compilation.hooks.processAssets.tap(
        {
          name,
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT + 1,
        },
        () => {
          // Preserve the owning resolver/compiler diagnostic on an invalid graph.
          if (compilation.errors.length) return;
          const buildAsset = compilation.getAsset('octane-client-build.json');
          if (!buildAsset)
            throw new Error(
              'The native Octane client build manifest is missing.',
            );
          const nativeBuild = JSON.parse(buildAsset.source.source().toString());
          if (
            nativeBuild.version !== 1 ||
            nativeBuild.buildId !== compilation.hash
          ) {
            throw new Error(
              'The native Octane client manifest does not match the completed compilation.',
            );
          }
          const sourcesByModule = new Map();
          const moduleAssets = new Map();
          const visit = (module, inheritedAssets = []) => {
            const chunks = [
              ...compilation.chunkGraph.getModuleChunksIterable(module),
            ];
            const previousAssets = moduleAssets.get(module);
            const assets = [
              ...new Set([
                ...(previousAssets ?? []),
                ...inheritedAssets,
                ...chunks.flatMap(chunk => [...chunk.files]),
              ]),
            ]
              .filter(file => file.endsWith('.js'))
              .sort();
            // Rspack also lists concatenated children as standalone modules.
            // A later parent visit can supply their first emitted chunk.
            if (
              previousAssets &&
              assets.every(file => previousAssets.has(file))
            )
              return;
            moduleAssets.set(module, new Set(assets));
            const info = getOctaneRspackBuildInfo(module);
            if (info && assets.length) {
              const resource = module.resource?.split('?')[0];
              const emitted = module.originalSource();
              if (!resource || !emitted) {
                throw new Error(
                  `Octane compiled module has no source: ${module.identifier()}.`,
                );
              }
              const relative = path.relative(this.options.root, resource);
              sourcesByModule.set(module, {
                resource:
                  relative.split(path.sep).join('/') +
                  (info.resourceQuery ?? ''),
                canonicalId: info.canonicalId,
                moduleId:
                  compilation.chunkGraph.getModuleId(module) ??
                  module.identifier(),
                transformKind: info.transformKind,
                emittedSourceSha256: digest(emitted.buffer()),
                assets,
              });
            }
            for (const nested of module.modules ?? []) visit(nested, assets);
          };
          for (const module of compilation.modules) visit(module);
          const sources = [...sourcesByModule.values()];
          sources.sort((left, right) =>
            left.resource.localeCompare(right.resource),
          );
          // Module Federation publishes exposed native modules through a
          // separate container entry in this same compilation. Its browser
          // closure belongs to this application's publication, even when the
          // document itself never imports an exposed component.
          const containerChunks = new Set();
          for (const [entryName, entry] of compilation.entries) {
            if (
              !entry.dependencies.some(
                dependency => dependency.type === 'container entry',
              )
            )
              continue;
            const container = compilation.entrypoints.get(entryName);
            if (!container)
              throw new Error(
                `Octane compiler has no federation container entry for ${entryName}.`,
              );
            for (const chunk of container.chunks) {
              containerChunks.add(chunk);
              for (const referenced of chunk.getAllReferencedChunks())
                containerChunks.add(referenced);
            }
          }
          const identities = this.options.rendererIdentities();
          if (!identities || !Object.keys(identities).length) {
            throw new Error(
              'Octane compiler requires immutable application entry identities.',
            );
          }
          for (const [entryName, rendererIdentity] of Object.entries(
            identities,
          )) {
            if (
              rendererIdentity?.renderer !== 'octane' ||
              rendererIdentity.entryName !== entryName
            ) {
              throw new Error(
                `Octane compiler identity conflicts with entry ${entryName}.`,
              );
            }
            const entrypoint = compilation.entrypoints.get(entryName);
            if (!entrypoint)
              throw new Error(
                `Octane compiler has no client entry for ${entryName}.`,
              );
            const entryChunks = new Set([
              ...entrypoint.chunks,
              ...containerChunks,
            ]);
            for (const chunk of entrypoint.chunks) {
              for (const referenced of chunk.getAllReferencedChunks())
                entryChunks.add(referenced);
            }
            const files = [
              ...new Set(
                [...entryChunks]
                  .flatMap(chunk => [...chunk.files])
                  .filter(file => file.endsWith('.js')),
              ),
            ].sort();
            const fileSet = new Set(files);
            const manifest = {
              schemaVersion: 1,
              renderer: 'octane',
              runtimeVersion: this.options.runtimeVersion,
              compilerVersion: this.options.compilerVersion,
              rendererIdentity,
              nativeHydrationBuildId: nativeBuild.buildId,
              sourceModules: sources.flatMap(source => {
                const assets = source.assets.filter(file => fileSet.has(file));
                return assets.length ? [{ ...source, assets }] : [];
              }),
              assets: files.map(file => ({
                file,
                sha256: digest(compilation.getAsset(file).source.buffer()),
              })),
            };
            this.options.validateManifest(
              manifest,
              rendererIdentity,
              compilation.hash,
            );
            compilation.emitAsset(
              this.options.manifestFilename(entryName),
              new compiler.webpack.sources.RawSource(
                `${JSON.stringify(manifest, null, 2)}\n`,
              ),
            );
          }
        },
      );
    });
  }
}
module.exports = { OctaneCompilerManifestPlugin };
