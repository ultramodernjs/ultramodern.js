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

const supportVersions = {
  'solid-js': '2.0.0-rc.22',
  '@effect/opentelemetry': '4.1.4',
  '@rstest/core': '0.12.6',
  'ioredis-mock': '8.13.1',
  '@types/ioredis-mock': '8.2.8',
  '@tanstack/react-router': '1.170.46',
} as const;

export type SupportArtifacts = JsonObject & {
  protocol: 'ultramodern.support-artifacts.v2';
  producer: JsonObject & {
    repository: 'ultramodernjs/ultramodern.js';
    repositoryId: 1151231350;
    workflow: '.github/workflows/support-artifacts.yml';
    source: string;
    runId: number;
    runAttempt: number;
    tag: string;
  };
  manifest: { request: string; integrity: string };
  packages: {
    [Name in keyof typeof supportVersions]: JsonObject & {
      version: (typeof supportVersions)[Name];
      request: string;
      integrity: string;
      upstream: JsonObject;
      patchSha256: string;
    };
  };
};

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

/** Project publisher-admitted framework metadata, not archive authentication. */
export function parseSupportArtifacts(value: unknown): SupportArtifacts {
  exactKeys(value, ['protocol', 'producer', 'manifest', 'packages']);
  object(value);
  assert.equal(value.protocol, 'ultramodern.support-artifacts.v2');
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
  assert.equal(producer.workflow, '.github/workflows/support-artifacts.yml');
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
    `support-artifacts-${producer.source}-${producer.runId}-${producer.runAttempt}`,
  );
  const base = `https://github.com/ultramodernjs/ultramodern.js/releases/download/${producer.tag}/`;
  const checkPin = (pin: JsonObject, filename: string) => {
    assert.equal(
      pin.request,
      `${base}${filename}`,
      'Support request differs from descriptor authority',
    );
    assert(
      typeof pin.integrity === 'string' &&
        /^sha512-[A-Za-z0-9+/]{86}==$/u.test(pin.integrity),
    );
  };
  exactKeys(value.manifest, ['request', 'integrity']);
  object(value.manifest);
  checkPin(value.manifest, 'support-artifacts.json');
  exactKeys(value.packages, Object.keys(supportVersions));
  object(value.packages);
  for (const [name, version] of Object.entries(supportVersions)) {
    const pin: unknown = value.packages[name];
    exactKeys(pin, [
      'version',
      'request',
      'integrity',
      'upstream',
      'patchSha256',
    ]);
    object(pin);
    assert.equal(pin.version, version, `${name}: support version mismatch`);
    checkPin(
      pin,
      `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`,
    );
    assert(
      typeof pin.patchSha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(pin.patchSha256),
    );
    object(pin.upstream);
  }
  // The publisher authenticates archive/provenance before writing this metadata.
  return structuredClone(value) as SupportArtifacts;
}

export function readSupportArtifacts(
  manifest: unknown,
): SupportArtifacts | undefined {
  object(manifest);
  const metadata = manifest.ultramodern;
  if (metadata === undefined) return undefined;
  object(metadata);
  return Object.hasOwn(metadata, 'supportArtifacts')
    ? parseSupportArtifacts(metadata.supportArtifacts)
    : undefined;
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

export function resolvePackageSource(
  options: UltramodernWorkspaceOptions,
): ResolvedPackageSource {
  const supportArtifacts = readSupportArtifacts(
    JSON.parse(
      fs.readFileSync(path.join(createPackageRoot, 'package.json'), 'utf8'),
    ),
  );
  const strategy = options.packageSource?.strategy ?? 'install';
  if (strategy === 'workspace') {
    return {
      strategy,
      ...(supportArtifacts ? { supportArtifacts } : {}),
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
    ...(supportArtifacts ? { supportArtifacts } : {}),
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
