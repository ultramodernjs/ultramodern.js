import fs from 'node:fs';
import path from 'node:path';
import type { Renderer } from '@modern-js/renderer-core';
import semver from '@modern-js/utils/semver';
import type { RendererBuildProfile } from './renderer-profile';

/** Installed package that owns a selected public framework module. */
export interface RendererFrameworkPackageBinding {
  readonly specifier: string;
  readonly name: string;
  readonly version: string;
  readonly directory: string;
}

export interface FrameworkModule {
  readonly specifier: string;
  readonly filename: string;
}

export interface RendererProfileMetadata<
  TRenderer extends Renderer = Renderer,
> {
  readonly profile: RendererBuildProfile<TRenderer>;
  readonly frameworkPackages: readonly RendererFrameworkPackageBinding[];
}

interface InstalledFrameworkOwner {
  readonly binding: RendererFrameworkPackageBinding;
  /** Canonical source package the publish step stamped into this manifest. */
  readonly sourceName: unknown;
}

/** Read the physical owner of a resolved public module, including npm aliases. */
export function readRendererFrameworkPackage(
  module: FrameworkModule,
): RendererFrameworkPackageBinding {
  return readInstalledFrameworkOwner(module).binding;
}

/** Select a physical dependency through its owner's node_modules ancestry. */
export function resolveInstalledRendererPackage(
  specifier: string,
  from: readonly string[],
):
  | (RendererFrameworkPackageBinding & { readonly exports: unknown })
  | undefined {
  for (const base of from)
    for (let directory = base; ; directory = path.dirname(directory)) {
      const filename = path.join(
        directory,
        'node_modules',
        specifier,
        'package.json',
      );
      if (fs.existsSync(filename)) {
        const owner = readRendererFrameworkPackage({ specifier, filename });
        const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
        return { ...owner, exports: manifest.exports };
      }
      if (path.dirname(directory) === directory) break;
    }
  return undefined;
}

/** Federation describes the exact installed native owners, not scaffold pins. */
export function projectInstalledFederationProfile<TRenderer extends Renderer>(
  profile: RendererBuildProfile<TRenderer>,
  bootstrap: RendererFrameworkPackageBinding,
): RendererBuildProfile<TRenderer> {
  const installed = (
    specifier: string,
    from: readonly string[] = [bootstrap.directory],
  ) => {
    if (specifier === bootstrap.specifier) return bootstrap;
    const owner = resolveInstalledRendererPackage(specifier, from);
    if (!owner)
      throw new Error(
        `Installed native federation owner ${specifier} is absent`,
      );
    return assertCanonicalPublication(
      readInstalledFrameworkOwner({
        specifier,
        filename: path.join(owner.directory, 'package.json'),
      }),
    );
  };
  const compiler = installed(profile.compiler.name);
  const hydration = installed(profile.hydration.name);
  const router = installed(profile.router.name);
  // MF selects the core owned by this router and aliases its providers to it.
  const core = installed(profile.router.coreName, [
    router.directory,
    bootstrap.directory,
  ]);
  return {
    ...profile,
    compiler: { ...profile.compiler, version: compiler.version },
    hydration: { ...profile.hydration, version: hydration.version },
    router: {
      ...profile.router,
      version: router.version,
      coreVersion: core.version,
    },
  };
}

function readInstalledFrameworkOwner(
  module: FrameworkModule,
): InstalledFrameworkOwner {
  let directory = path.dirname(fs.realpathSync(module.filename));
  for (;;) {
    const manifestFile = path.join(directory, 'package.json');
    if (fs.existsSync(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const formatMarker =
        manifest &&
        typeof manifest === 'object' &&
        !Array.isArray(manifest) &&
        Object.keys(manifest).length === 1 &&
        (manifest.type === 'module' || manifest.type === 'commonjs');
      if (!formatMarker) {
        if (
          !manifest ||
          typeof manifest !== 'object' ||
          Array.isArray(manifest) ||
          typeof manifest.name !== 'string' ||
          !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(
            manifest.name,
          ) ||
          typeof manifest.version !== 'string' ||
          !semver.valid(manifest.version)
        )
          throw new Error(
            `Invalid installed framework manifest for ${module.specifier}: ${manifestFile}`,
          );
        return {
          binding: Object.freeze({
            specifier: module.specifier,
            name: manifest.name,
            version: manifest.version,
            directory,
          }),
          sourceName: manifest.ultramodern?.sourceName,
        };
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(
        `The public framework module ${module.specifier} has no owning package manifest`,
      );
    directory = parent;
  }
}

/**
 * A renamed install stands for its canonical specifier only when the
 * installed manifest itself names that specifier as its publication source.
 */
function assertCanonicalPublication({
  binding,
  sourceName,
}: InstalledFrameworkOwner): RendererFrameworkPackageBinding {
  if (binding.name !== binding.specifier && sourceName !== binding.specifier)
    throw new Error(
      `Installed framework owner ${binding.name}@${binding.version} is not a publication of ${binding.specifier}: ${path.join(binding.directory, 'package.json')}`,
    );
  return binding;
}

/**
 * Native upstream pins stay fixed; selected framework versions are installed
 * facts. Profile identities stay on the canonical public specifier that app
 * source, config and topology name; the physical (possibly npm-aliased) owner
 * is carried only by its framework package binding.
 */
export function projectInstalledRendererProfile<TRenderer extends Renderer>(
  candidate: RendererBuildProfile<TRenderer>,
  modules: readonly FrameworkModule[],
): RendererProfileMetadata<TRenderer> {
  const frameworkPackages = modules
    .map(readInstalledFrameworkOwner)
    .map(assertCanonicalPublication);
  const dependencies = { ...candidate.dependencies };
  let router = { ...candidate.router };
  for (const owner of frameworkPackages) {
    if (Object.hasOwn(dependencies, owner.specifier))
      dependencies[owner.specifier] = owner.version;
    if (router.name === owner.specifier)
      router = { ...router, version: owner.version };
  }
  return Object.freeze({
    profile: {
      ...candidate,
      dependencies: Object.freeze(dependencies),
      router: Object.freeze(router),
    },
    frameworkPackages: Object.freeze(frameworkPackages),
  });
}
