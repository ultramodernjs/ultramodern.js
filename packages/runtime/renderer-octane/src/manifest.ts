import type { NativeCompilerArtifacts } from '@modern-js/renderer-core/adapter';
import {
  nativeModuleManifestFilename,
  type RendererIdentity,
  readRendererIdentity,
} from '@modern-js/renderer-core/identity';
import {
  assertNativeHydrationBuildId,
  assertOctaneIdentity,
} from './bootstrap';

export const OCTANE_RUNTIME_VERSION = '0.20.0';
export const OCTANE_COMPILER_VERSION = '0.2.12';

export interface OctaneCompiledSource {
  readonly resource: string;
  readonly canonicalId: string;
  readonly moduleId: string | number;
  readonly transformKind: 'compile' | 'slots' | 'client-only-stub';
  readonly emittedSourceSha256: string;
  readonly assets: readonly string[];
}

export interface OctaneModuleManifest {
  readonly schemaVersion: 1;
  readonly renderer: 'octane';
  readonly runtimeVersion: typeof OCTANE_RUNTIME_VERSION;
  readonly compilerVersion: typeof OCTANE_COMPILER_VERSION;
  readonly rendererIdentity: Readonly<RendererIdentity>;
  readonly nativeHydrationBuildId: string;
  readonly sourceModules: readonly OctaneCompiledSource[];
  readonly assets: readonly {
    readonly file: string;
    readonly sha256: string;
  }[];
}

export function octaneModuleManifestFileName(entryName: string): string {
  return nativeModuleManifestFilename('octane', entryName);
}

function record(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed Octane compiler manifest object.');
  }
  if (Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error('Octane compiler manifest contains an unknown field.');
  }
  return value as Record<string, unknown>;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
}

function nonempty(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\0')
  );
}

function assetPath(value: unknown): value is string {
  return (
    nonempty(value) &&
    value.endsWith('.js') &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some(part => part === '..' || part === '.' || !part)
  );
}

/** A build's manifest is an immutable artifact: its shape is checked once. */
const validatedManifests = new WeakMap<object, OctaneModuleManifest>();

/** Validates completed native bytes separately from the source/profile build. */
export function validateOctaneModuleManifest(
  value: unknown,
  expectedIdentity: RendererIdentity,
  expectedNativeHydrationBuildId?: string,
): OctaneModuleManifest {
  assertOctaneIdentity(expectedIdentity);
  const cached =
    value && typeof value === 'object'
      ? validatedManifests.get(value)
      : undefined;
  const manifest = cached ?? readOctaneModuleManifest(value);
  readRendererIdentity(manifest.rendererIdentity, expectedIdentity);
  if (expectedNativeHydrationBuildId !== undefined) {
    assertNativeHydrationBuildId(expectedNativeHydrationBuildId);
    if (manifest.nativeHydrationBuildId !== expectedNativeHydrationBuildId) {
      throw new Error(
        'Octane native hydration build differs from the compiled client.',
      );
    }
  }
  if (!cached) {
    validatedManifests.set(value as object, manifest);
    validatedManifests.set(manifest, manifest);
  }
  return manifest;
}

function readOctaneModuleManifest(value: unknown): OctaneModuleManifest {
  const manifest = record(value, [
    'schemaVersion',
    'renderer',
    'runtimeVersion',
    'compilerVersion',
    'rendererIdentity',
    'nativeHydrationBuildId',
    'sourceModules',
    'assets',
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.renderer !== 'octane' ||
    manifest.runtimeVersion !== OCTANE_RUNTIME_VERSION ||
    manifest.compilerVersion !== OCTANE_COMPILER_VERSION
  ) {
    throw new Error(
      'Octane compiler manifest ABI conflicts with the application.',
    );
  }
  // The caller compares this well-formed record with its expected identity.
  const rendererIdentity = readRendererIdentity(
    manifest.rendererIdentity,
    manifest.rendererIdentity as RendererIdentity,
  );
  const nativeHydrationBuildId = manifest.nativeHydrationBuildId;
  assertNativeHydrationBuildId(nativeHydrationBuildId);
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) {
    throw new Error(
      'Octane compiler manifest has no emitted JavaScript closure.',
    );
  }
  const assetNames = new Set<string>();
  const assets = manifest.assets.map(value => {
    const asset = record(value, ['file', 'sha256']);
    if (
      !assetPath(asset.file) ||
      !digest(asset.sha256) ||
      assetNames.has(asset.file)
    ) {
      throw new Error('Invalid Octane emitted asset digest.');
    }
    assetNames.add(asset.file);
    return Object.freeze({ file: asset.file, sha256: asset.sha256 });
  });
  if (
    !Array.isArray(manifest.sourceModules) ||
    !manifest.sourceModules.length
  ) {
    throw new Error(
      'Octane compiler manifest has no authenticated native sources.',
    );
  }
  const resources = new Set<string>();
  const sourceModules = manifest.sourceModules.map(value => {
    const source = record(value, [
      'resource',
      'canonicalId',
      'moduleId',
      'transformKind',
      'emittedSourceSha256',
      'assets',
    ]);
    if (
      !nonempty(source.resource) ||
      source.resource.startsWith('/') ||
      source.resource.includes('\\') ||
      !nonempty(source.canonicalId) ||
      !(
        (typeof source.moduleId === 'string' && nonempty(source.moduleId)) ||
        (typeof source.moduleId === 'number' &&
          Number.isFinite(source.moduleId))
      ) ||
      !(
        source.transformKind === 'compile' ||
        source.transformKind === 'slots' ||
        source.transformKind === 'client-only-stub'
      ) ||
      !digest(source.emittedSourceSha256) ||
      !Array.isArray(source.assets) ||
      !source.assets.length ||
      source.assets.some(
        file => typeof file !== 'string' || !assetNames.has(file),
      ) ||
      new Set(source.assets).size !== source.assets.length ||
      resources.has(source.resource)
    ) {
      throw new Error('Invalid Octane native source-to-asset provenance.');
    }
    resources.add(source.resource);
    return Object.freeze({
      resource: source.resource,
      canonicalId: source.canonicalId,
      moduleId: source.moduleId,
      transformKind: source.transformKind,
      emittedSourceSha256: source.emittedSourceSha256,
      assets: Object.freeze([...source.assets] as string[]),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    renderer: 'octane',
    runtimeVersion: OCTANE_RUNTIME_VERSION,
    compilerVersion: OCTANE_COMPILER_VERSION,
    rendererIdentity,
    nativeHydrationBuildId,
    sourceModules: Object.freeze(sourceModules),
    assets: Object.freeze(assets),
  });
}

/**
 * The compiler artifact ABI. It lives in this runtime module, not in the
 * build-only `./plugin`, because the production server validates manifests
 * with it and deployments trace it from there.
 */
export const compilerArtifacts: NativeCompilerArtifacts = {
  clientManifestFile: octaneModuleManifestFileName,
  async validateClientManifest(value, identity, context) {
    const hydrationBuildId =
      context.compilationHash ?? context.hydrationBuildId;
    if (
      context.development &&
      (typeof hydrationBuildId !== 'string' || !hydrationBuildId.trim())
    )
      throw new Error(
        'Octane development snapshot has no native hydration build.',
      );
    const nativeManifest = validateOctaneModuleManifest(
      value,
      identity,
      hydrationBuildId,
    );
    return {
      nativeManifest,
      hydrationBuildId: nativeManifest.nativeHydrationBuildId,
    };
  },
  isMutableDevelopmentAsset(filename, entryNames) {
    return (
      filename === 'octane-client-build.json' ||
      entryNames.some(entry => filename === octaneModuleManifestFileName(entry))
    );
  },
};
