import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  hasCreateReleaseCohort,
  readCreateReleaseCohort,
} from '../ultramodern-release-cohort';
import { createPackageRoot } from './fs-io';
import { type SupportArtifacts, selectSupportRequests } from './package-source';
import { isRecord } from './types';

type FrameworkManifest = {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

function requests(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  assert(isRecord(value), 'Framework dependency group must be an object');
  return Object.fromEntries(
    Object.entries(value).map(([name, request]) => {
      assert(
        typeof request === 'string',
        `Framework dependency ${name} must be a string`,
      );
      return [name, request];
    }),
  );
}

/**
 * The create bundle supplies the workspace's peer context. Transitive dev
 * dependencies are not installed; optional peers participate only when their
 * owner is in this bundle's dependency closure.
 */
export function readBundledFrameworkManifests(
  bundleRoot: string,
  cohortNames: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, FrameworkManifest> {
  const manifests = new Map<string, FrameworkManifest>();
  const queue = [
    {
      name: '@modern-js/ultramodern-create',
      filename: path.join(bundleRoot, 'package.json'),
    },
  ];
  for (const { name, filename } of queue) {
    if (manifests.has(name)) continue;
    const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert(isRecord(value), `Invalid framework manifest ${filename}`);
    const manifest = {
      dependencies: requests(value.dependencies),
      optionalDependencies: requests(value.optionalDependencies),
      peerDependencies: requests(value.peerDependencies),
    };
    manifests.set(name, manifest);
    const require = createRequire(filename);
    for (const [dependency, request] of Object.entries({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      if (
        !dependency.startsWith('@modern-js/') ||
        (!request.startsWith('workspace:') && !cohortNames.has(dependency))
      )
        continue;
      const candidate = require.resolve
        .paths(dependency)
        ?.map(directory => path.join(directory, dependency, 'package.json'))
        .find(file => fs.existsSync(file));
      if (!candidate) {
        assert(
          Object.hasOwn(manifest.optionalDependencies, dependency),
          `Create bundle is missing required framework owner ${dependency}`,
        );
        continue;
      }
      queue.push({ name: dependency, filename: candidate });
    }
  }
  return manifests;
}

let bundledManifests: ReadonlyMap<string, FrameworkManifest> | undefined;

/** Exact support peers reached by this importer's installed framework tooling. */
export function toolingSupportDependencies(
  directDependencies: Readonly<Record<string, string>>,
  support: SupportArtifacts | undefined,
  manifests?: ReadonlyMap<string, FrameworkManifest>,
): Record<string, string> {
  if (!support) return {};
  const bundle =
    manifests ??
    (bundledManifests ??= readBundledFrameworkManifests(
      createPackageRoot,
      new Set(
        hasCreateReleaseCohort()
          ? readCreateReleaseCohort().packages.map(pkg => pkg.sourceName)
          : [],
      ),
    ));
  const hosts: Record<string, string> = {};
  const seen = new Set<string>();
  const queue = Object.keys(directDependencies);
  for (const name of queue) {
    if (seen.has(name)) continue;
    seen.add(name);
    const manifest = bundle.get(name);
    if (!manifest) continue;
    for (const [peer, request] of Object.entries(manifest.peerDependencies))
      if (Object.hasOwn(support.packages, peer))
        Object.assign(
          hosts,
          selectSupportRequests({ [peer]: request }, support),
        );
    queue.push(
      ...Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }).filter(dependency => bundle.has(dependency)),
    );
  }
  return hosts;
}
