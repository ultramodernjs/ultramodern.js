import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BLEEDINGDEV_PACKAGE_NAME_PREFIX,
  BLEEDINGDEV_PACKAGE_SCOPE,
  WORKSPACE_PACKAGE_VERSION,
} from '../ultramodern-package-source';
import { createPackageRoot } from './fs-io';
import type {
  JsonObject,
  ResolvedPackageSource,
  UltramodernWorkspaceOptions,
} from './types';

// Stable Solid is a raw registry dependency; support v4 carries no Solid archive.
const supportVersions = {
  '@effect/opentelemetry': '4.1.4',
  '@rstest/core': '0.12.6',
  'ioredis-mock': '8.13.1',
  '@types/ioredis-mock': '8.2.8',
  '@tanstack/react-router': '1.170.46',
  'rsbuild-plugin-dts': '1.0.7',
} as const;

// The closed native renderer cohort. Its router Core is the exact peer of the
// React and native TanStack adapters.
const nativeVersions = {
  octane: '0.20.0',
  '@octanejs/tanstack-router': '0.3.6',
  '@octanejs/rspack-plugin': '0.2.12',
  '@tanstack/router-core': '1.171.39',
} as const;
export const NATIVE_ROUTER_CORE = '@tanstack/router-core';

type ArtifactDescriptor<
  Protocol extends string,
  Workflow extends string,
  Versions extends Record<string, string>,
> = JsonObject & {
  protocol: Protocol;
  producer: JsonObject & {
    repository: 'ultramodernjs/ultramodern.js';
    repositoryId: 1151231350;
    workflow: Workflow;
    source: string;
    runId: number;
    runAttempt: number;
    tag: string;
  };
  manifest: { request: string; integrity: string };
  packages: {
    [Name in keyof Versions]: JsonObject & {
      version: Versions[Name];
      request: string;
      integrity: string;
      upstream: JsonObject;
      patchSha256: string;
    };
  };
};
export type SupportArtifacts = ArtifactDescriptor<
  'ultramodern.support-artifacts.v4',
  '.github/workflows/support-artifacts.yml',
  typeof supportVersions
>;
export type NativeArtifacts = ArtifactDescriptor<
  'ultramodern.native-artifacts.v1',
  '.github/workflows/native-renderer-artifacts.yml',
  typeof nativeVersions
>;

function object(value: unknown): asserts value is JsonObject {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Support metadata must be an object',
  );
}
function exactKeys(value: unknown, keys: string[]) {
  object(value);
  assert.deepEqual(
    Object.keys(value).sort(),
    keys.sort(),
    'Support metadata has unknown or missing inputs',
  );
}

const releaseBase =
  'https://github.com/ultramodernjs/ultramodern.js/releases/download/';
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;

function parseArtifactDescriptor(
  value: unknown,
  policy: {
    protocol: string;
    workflow: string;
    tagPrefix: string;
    manifestFilename: string;
    versions: Readonly<Record<string, string>>;
    label: string;
    upstream?: (value: unknown, name: string, version: string) => void;
  },
): unknown {
  exactKeys(value, ['protocol', 'producer', 'manifest', 'packages']);
  object(value);
  assert.equal(value.protocol, policy.protocol);
  const producer = value.producer;
  exactKeys(producer, [
    'repository',
    'repositoryId',
    'workflow',
    'source',
    'runId',
    'runAttempt',
    'tag',
  ]);
  object(producer);
  assert.equal(producer.repository, 'ultramodernjs/ultramodern.js');
  assert.equal(producer.repositoryId, 1151231350);
  assert.equal(producer.workflow, policy.workflow);
  assert(
    typeof producer.source === 'string' &&
      /^[a-f0-9]{40}$/u.test(producer.source),
  );
  for (const key of ['runId', 'runAttempt'])
    assert(
      typeof producer[key] === 'number' &&
        Number.isSafeInteger(producer[key]) &&
        producer[key] > 0,
    );
  assert.equal(
    producer.tag,
    `${policy.tagPrefix}-${producer.source}-${producer.runId}-${producer.runAttempt}`,
  );
  const base = `${releaseBase}${producer.tag}/`;
  const checkPin = (pin: JsonObject, filename: string) => {
    assert.equal(
      pin.request,
      `${base}${filename}`,
      `${policy.label} request differs from descriptor authority`,
    );
    assert(
      typeof pin.integrity === 'string' && integrityPattern.test(pin.integrity),
    );
  };
  exactKeys(value.manifest, ['request', 'integrity']);
  object(value.manifest);
  checkPin(value.manifest, policy.manifestFilename);
  exactKeys(value.packages, Object.keys(policy.versions));
  object(value.packages);
  for (const [name, version] of Object.entries(policy.versions)) {
    const pin: unknown = value.packages[name];
    exactKeys(pin, [
      'version',
      'request',
      'integrity',
      'upstream',
      'patchSha256',
    ]);
    object(pin);
    assert.equal(
      pin.version,
      version,
      `${name}: ${policy.label.toLowerCase()} version mismatch`,
    );
    checkPin(
      pin,
      `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`,
    );
    assert(
      typeof pin.patchSha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(pin.patchSha256),
    );
    object(pin.upstream);
    policy.upstream?.(pin.upstream, name, version);
  }
  // The publisher authenticates archive/provenance before writing this metadata.
  return structuredClone(value);
}

/** Project publisher-admitted framework metadata, not archive authentication. */
export function parseSupportArtifacts(value: unknown): SupportArtifacts {
  return parseArtifactDescriptor(value, {
    protocol: 'ultramodern.support-artifacts.v4',
    workflow: '.github/workflows/support-artifacts.yml',
    tagPrefix: 'support-artifacts',
    manifestFilename: 'support-artifacts.json',
    versions: supportVersions,
    label: 'Support',
  }) as SupportArtifacts;
}

/** Project publisher-admitted native renderer metadata, not archive authentication. */
export function parseNativeArtifacts(value: unknown): NativeArtifacts {
  return parseArtifactDescriptor(value, {
    protocol: 'ultramodern.native-artifacts.v1',
    workflow: '.github/workflows/native-renderer-artifacts.yml',
    tagPrefix: 'native-renderers',
    manifestFilename: 'native-artifacts.json',
    versions: nativeVersions,
    label: 'Native',
    upstream(upstream, name, version) {
      exactKeys(upstream, [
        'request',
        'integrity',
        'repository',
        'commit',
        'sourceArchiveIntegrity',
        'licenseSha256',
      ]);
      object(upstream);
      assert.equal(
        upstream.request,
        `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
      );
      for (const key of ['integrity', 'sourceArchiveIntegrity'])
        assert(
          typeof upstream[key] === 'string' &&
            integrityPattern.test(upstream[key]),
        );
      assert(
        typeof upstream.repository === 'string' &&
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(upstream.repository),
      );
      assert(
        typeof upstream.commit === 'string' &&
          /^[a-f0-9]{40}$/u.test(upstream.commit),
      );
      assert(
        typeof upstream.licenseSha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(upstream.licenseSha256),
      );
    },
  }) as NativeArtifacts;
}

function readArtifactMetadata<Descriptor>(
  manifest: unknown,
  key: 'supportArtifacts' | 'nativeArtifacts',
  parse: (value: unknown) => Descriptor,
): Descriptor | undefined {
  object(manifest);
  const metadata = manifest.ultramodern;
  if (metadata === undefined) return undefined;
  object(metadata);
  return Object.hasOwn(metadata, key) ? parse(metadata[key]) : undefined;
}

export function readSupportArtifacts(
  manifest: unknown,
): SupportArtifacts | undefined {
  return readArtifactMetadata(
    manifest,
    'supportArtifacts',
    parseSupportArtifacts,
  );
}

export function readNativeArtifacts(
  manifest: unknown,
): NativeArtifacts | undefined {
  return readArtifactMetadata(
    manifest,
    'nativeArtifacts',
    parseNativeArtifacts,
  );
}

export function selectSupportRequests(
  dependencies: Record<string, string>,
  support: SupportArtifacts | undefined,
): Record<string, string> {
  if (!support) {
    for (const name of Object.keys(supportVersions))
      assert(
        !dependencies[name]?.startsWith(
          'https://github.com/ultramodernjs/ultramodern.js/releases/download/support-artifacts-',
        ),
        `${name}: corrected input requires support descriptor`,
      );
    return dependencies;
  }
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, request]) => {
      if (!Object.hasOwn(supportVersions, name)) return [name, request];
      const pin = support.packages[name as keyof typeof supportVersions];
      assert(
        request === pin.version || request === pin.request,
        `${name}: direct input ${request} differs from support descriptor`,
      );
      return [name, pin.request];
    }),
  );
}

/**
 * Select the admitted native Core archive for an exact Core request. Without
 * a native descriptor a consumer keeps its registry request and cannot carry
 * a native archive.
 */
export function selectNativeCoreRequest(
  dependencies: Record<string, string>,
  native: NativeArtifacts | undefined,
): Record<string, string> {
  const request = dependencies[NATIVE_ROUTER_CORE];
  if (request === undefined) return dependencies;
  if (!native) {
    assert(
      !request.startsWith(`${releaseBase}native-renderers-`),
      `${NATIVE_ROUTER_CORE}: native Core input requires native descriptor`,
    );
    return dependencies;
  }
  const pin = native.packages[NATIVE_ROUTER_CORE];
  assert(
    request === pin.version || request === pin.request,
    `${NATIVE_ROUTER_CORE}: direct input ${request} differs from native descriptor`,
  );
  return { ...dependencies, [NATIVE_ROUTER_CORE]: pin.request };
}

export function resolvePackageSource(
  options: UltramodernWorkspaceOptions,
): ResolvedPackageSource {
  const createManifest: unknown = JSON.parse(
    fs.readFileSync(path.join(createPackageRoot, 'package.json'), 'utf8'),
  );
  const supportArtifacts = readSupportArtifacts(createManifest);
  const nativeArtifacts = readNativeArtifacts(createManifest);
  const artifacts = {
    ...(supportArtifacts ? { supportArtifacts } : {}),
    ...(nativeArtifacts ? { nativeArtifacts } : {}),
  };
  const strategy = options.packageSource?.strategy ?? 'install';
  if (strategy === 'workspace') {
    return {
      strategy,
      ...artifacts,
      modernPackageVersion: WORKSPACE_PACKAGE_VERSION,
      registry: options.packageSource?.registry,
      aliasScope: options.packageSource?.aliasScope,
      aliasPackageNamePrefix: options.packageSource?.aliasPackageNamePrefix,
    };
  }

  const registry = options.packageSource?.registry;
  const aliasScope =
    options.packageSource?.aliasScope ??
    (registry ? undefined : BLEEDINGDEV_PACKAGE_SCOPE);

  return {
    strategy,
    ...artifacts,
    modernPackageVersion:
      options.packageSource?.modernPackageVersion ?? options.modernVersion,
    registry,
    aliasScope,
    aliasPackageNamePrefix:
      options.packageSource?.aliasPackageNamePrefix ??
      (aliasScope ? BLEEDINGDEV_PACKAGE_NAME_PREFIX : undefined),
  };
}

export function resolveWorkspacePackageLinkingPolicy(
  packageSource: Pick<ResolvedPackageSource, 'strategy'>,
): Partial<Record<'injectWorkspacePackages' | 'linkWorkspacePackages', true>> {
  return packageSource.strategy === 'workspace'
    ? {
        injectWorkspacePackages: true,
        linkWorkspacePackages: true,
      }
    : {};
}
