import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { yaml } from '@modern-js/utils';
import { parsePnpmLockfile } from '../../scripts/lib/parse-pnpm-lockfile.mjs';
import { inspectNpmTarball } from '../../scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { startSidecarRegistry } from '../../scripts/ultramodern-publish/qualify-sidecar-bundle.mjs';
import { stripPackedFrameworkSources } from './packedConsumerSources.mjs';
import {
  bleedingdevEdges,
  runPnpm,
  runPnpmAsync,
} from './runWithPrerequisites.mjs';

const { dump, load } = yaml;

type PackedPackage = { tarball: string; integrity: string };
type PackedSidecar = PackedPackage & { version: string };
type BleedingdevEdge = {
  name: string;
  spec: string;
  target: string;
  version: string;
};

function packedBleedingdevSpecifier(
  edge: BleedingdevEdge,
  sidecars: Record<string, PackedSidecar>,
): string {
  const packed = sidecars[edge.target];
  if (packed?.version !== edge.version) {
    throw new Error(
      `${edge.name}: ${edge.spec} is not in the packed test cohort ` +
        `(packed ${edge.target}: ${packed?.version ?? 'none'}). ` +
        'Add it to scripts/ultramodern-supply/sidecars.json / staged cohort ' +
        'so tests install the artifact the release publishes.',
    );
  }
  return `file:${packed.tarball}`;
}

function assertPacked(file: string, name: string, integrity: string) {
  const actual = createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
  if (actual !== integrity) {
    throw new Error(`Packed prerequisite changed after preparation: ${name}`);
  }
}

/**
 * Point every `@bleedingdev/*` edge at its packed tarball. pnpm matches an
 * override by dependency key, so an `npm:` alias needs a `key@npm:...` selector;
 * a bare target-name override would leave the alias on the registry.
 */
export function bleedingdevOverrides(
  edges: BleedingdevEdge[],
  sidecars: Record<string, PackedSidecar>,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const edge of edges) {
    overrides[`${edge.name}@${edge.spec}`] = packedBleedingdevSpecifier(
      edge,
      sidecars,
    );
  }
  return overrides;
}

/** Bind registry-resolved sidecars to this run's authenticated packed bytes. */
export function assertPackedRegistrySidecars(
  packages: Record<
    string,
    { resolution?: { tarball?: string; integrity?: string } }
  >,
  sidecars: Record<string, PackedSidecar>,
  registryUrl: string,
): void {
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('@bleedingdev/') || key.includes('@file:')) continue;
    const match = /^(@bleedingdev\/[^@]+)@([^(@]+)(?:\(|$)/u.exec(key);
    assert.ok(
      match,
      'Generated workspace resolved an unaccepted sidecar: ' + key,
    );
    const packed = sidecars[match[1]];
    assert.ok(
      packed && packed.version === match[2],
      'Generated workspace resolved an unaccepted sidecar: ' + key,
    );
    const bytes = fs.readFileSync(packed.tarball);
    assertPacked(packed.tarball, match[1], packed.integrity);
    assert.equal(
      entry.resolution?.tarball,
      registryUrl + 'tarballs/' + encodeURIComponent(match[1]) + '.tgz',
      'Generated workspace sidecar escaped its packed registry: ' + key,
    );
    assert.equal(
      entry.resolution?.integrity,
      'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      'Generated workspace sidecar integrity drift: ' + key,
    );
  }
}

/**
 * A packed alias edge whose installed version differs from its spec (a listed
 * previousFork) resolves the packed fork from the same sidecar registry.
 */
export function reboundRegistryOverrides(
  edges: BleedingdevEdge[],
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const edge of edges) {
    const installed = `npm:${edge.target}@${edge.version}`;
    if (edge.spec.startsWith('npm:') && edge.spec !== installed)
      overrides[`${edge.name}@${edge.spec}`] = installed;
  }
  return overrides;
}

function registrySidecars(sidecars: Record<string, PackedSidecar>) {
  return Object.entries(sidecars).map(([name, packed]) => {
    assertPacked(packed.tarball, name, packed.integrity);
    const bytes = fs.readFileSync(packed.tarball);
    const packageJson = JSON.parse(
      inspectNpmTarball(bytes).packageJsonBytes.toString('utf8'),
    );
    assert.equal(packageJson.name, name);
    assert.equal(packageJson.version, packed.version);
    return {
      name,
      version: packed.version,
      packageJson,
      bytes,
      integrity:
        'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      shasum: createHash('sha1').update(bytes).digest('hex'),
    };
  });
}

function packedPrerequisites() {
  const manifestPath = process.env.MODERN_TEST_PACKAGE_MANIFEST;
  if (!manifestPath) {
    throw new Error(
      'Missing packed framework prerequisites. Run pnpm test:framework, or ' +
        'set MODERN_TEST_PACKAGE_MANIFEST to the packages.json produced by ' +
        'tests/utils/runWithPrerequisites.mjs --pack-only <directory>.',
    );
  }
  const {
    packages,
    sidecars,
    edges,
    allowBuilds,
    minimumReleaseAgeExclude = [],
  } = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    packages: Record<string, PackedPackage>;
    sidecars: Record<string, PackedSidecar>;
    edges: BleedingdevEdge[];
    allowBuilds: Record<string, boolean>;
    minimumReleaseAgeExclude: string[];
  };
  const overrides: Record<string, string> = {};
  for (const [name, { tarball, integrity }] of Object.entries(packages)) {
    assertPacked(tarball, name, integrity);
    overrides[name] = `file:${tarball}`;
  }
  for (const [name, { tarball, integrity }] of Object.entries(sidecars)) {
    assertPacked(tarball, name, integrity);
  }
  Object.assign(overrides, bleedingdevOverrides(edges, sidecars));
  return {
    framework: Object.keys(packages),
    edges,
    overrides,
    sidecars,
    allowBuilds,
    minimumReleaseAgeExclude,
  };
}

/** Remove only framework source copies in this disposable consumer. Application
 * workspace TypeScript (including injected shared-contracts) remains intact. */
function prepareSourceUnavailableConsumer(
  consumer: string,
  requireFramework = false,
) {
  const required = new Set(
    requireFramework
      ? [
          '@modern-js/ultramodern-create',
          '@modern-js/plugin-tanstack',
          '@modern-js/app-tools',
          '@modern-js/server-runtime-extensions',
        ]
      : ['@modern-js/ultramodern-create'],
  );
  const { root, packages } = stripPackedFrameworkSources(
    consumer,
    packedPrerequisites().framework,
  );
  for (const { name, packageDir } of packages) {
    if (required.has(name)) {
      const entry = execFileSync(
        process.execPath,
        ['-e', 'console.log(require.resolve(process.argv[1]))', name],
        {
          cwd: packageDir,
          encoding: 'utf8',
          env: { ...process.env, NODE_PATH: '' },
        },
      ).trim();
      const resolved = fs.realpathSync(entry);
      if (
        !resolved.startsWith(`${root}${path.sep}`) ||
        resolved.split(path.sep).includes('src')
      ) {
        throw new Error(
          `Packed entry selected framework source or an external tree: ${name}: ${resolved}`,
        );
      }
      required.delete(name);
    }
  }
  if (required.size)
    throw new Error(
      `Missing packed framework consumer entries: ${[...required].join(', ')}`,
    );
}

/** pnpm owns workspace links, per-package versions, peer resolution and builds. */
export async function materializeGeneratedWorkspaceDependencies(
  workspaceDir: string,
): Promise<void> {
  const {
    overrides: packedOverrides,
    edges,
    framework,
    sidecars,
    minimumReleaseAgeExclude,
  } = packedPrerequisites();
  const overrides = {
    ...Object.fromEntries(
      Object.entries(packedOverrides).filter(([name]) =>
        framework.includes(name),
      ),
    ),
    ...reboundRegistryOverrides(edges),
  };
  const generatedEdges = fs
    .globSync('**/package.json', {
      cwd: workspaceDir,
      exclude: ['**/node_modules'],
    })
    .flatMap(manifest =>
      bleedingdevEdges(
        JSON.parse(fs.readFileSync(path.join(workspaceDir, manifest), 'utf8')),
      ),
    );
  // Validate authored alias versions without replacing the producer's policy.
  bleedingdevOverrides(generatedEdges, sidecars);
  const workspaceFile = path.join(workspaceDir, 'pnpm-workspace.yaml');
  const workspace = load(fs.readFileSync(workspaceFile, 'utf8')) as {
    overrides?: Record<string, string>;
    minimumReleaseAgeExclude?: string[];
  };
  bleedingdevOverrides(
    bleedingdevEdges({ dependencies: workspace.overrides }),
    sidecars,
  );
  // Fresh dependency candidates use only the repository's exact reviewed selectors.
  // The published generator retains its normal release-age policy.
  // Keep the framework file overrides installed: reverting them would invalidate
  // pnpm's lockfile settings and break verifyDepsBeforeRun for real commands.
  fs.writeFileSync(
    workspaceFile,
    dump({
      ...workspace,
      overrides: {
        ...workspace.overrides,
        ...overrides,
      },
      minimumReleaseAgeExclude: [
        ...new Set([
          ...(workspace.minimumReleaseAgeExclude ?? []),
          ...minimumReleaseAgeExclude,
          ...Object.entries(sidecars).map(
            ([name, { version }]) => `${name}@${version}`,
          ),
        ]),
      ],
    }),
  );
  const npmrcPath = path.join(workspaceDir, '.npmrc');
  const originalNpmrc = fs.existsSync(npmrcPath)
    ? fs.readFileSync(npmrcPath)
    : undefined;
  const registry = await startSidecarRegistry(registrySidecars(sidecars));
  try {
    fs.writeFileSync(
      npmrcPath,
      (originalNpmrc?.toString() ?? '') +
        '\n@bleedingdev:registry=' +
        registry.registryUrl +
        '\n',
    );
    await runPnpmAsync(['install', '--no-frozen-lockfile'], {
      cwd: workspaceDir,
      env: { ...process.env, NODE_PATH: '', CI: 'true' },
      stdio: 'pipe',
    });
    const { packages: locked = {} } = parsePnpmLockfile(
      fs.readFileSync(path.join(workspaceDir, 'pnpm-lock.yaml'), 'utf8'),
    );
    assertPackedRegistrySidecars(locked, sidecars, registry.registryUrl);
  } finally {
    try {
      await registry.stop();
    } finally {
      if (originalNpmrc) fs.writeFileSync(npmrcPath, originalNpmrc);
      else fs.rmSync(npmrcPath, { force: true });
    }
  }
  prepareSourceUnavailableConsumer(workspaceDir, true);
}

/** A standalone consumer outside the repository, without source links. */
export function installPackedGenerator(tempRoot: string): string {
  const { overrides, allowBuilds, minimumReleaseAgeExclude } =
    packedPrerequisites();
  const consumer = path.join(tempRoot, 'generator-consumer');
  fs.mkdirSync(consumer, { recursive: true });
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      name: 'packed-generator-consumer',
      private: true,
      dependencies: {
        '@modern-js/ultramodern-create':
          overrides['@modern-js/ultramodern-create'],
      },
    }),
  );
  fs.writeFileSync(
    path.join(consumer, 'pnpm-workspace.yaml'),
    dump({ packages: [], overrides, allowBuilds, minimumReleaseAgeExclude }),
  );
  runPnpm(['install', '--no-frozen-lockfile'], {
    cwd: consumer,
    env: { ...process.env, NODE_PATH: '', CI: 'true' },
    stdio: 'pipe',
  });
  prepareSourceUnavailableConsumer(consumer);
  const bin = path.join(
    consumer,
    'node_modules/@modern-js/ultramodern-create/bin/run.js',
  );
  if (
    !fs.realpathSync(bin).startsWith(`${fs.realpathSync(consumer)}${path.sep}`)
  ) {
    throw new Error(
      'Packed generator resolved outside its standalone consumer',
    );
  }
  return bin;
}

export function generatedModernBin(packageDir: string): string {
  return path.join(
    packageDir,
    'node_modules/@modern-js/app-tools/bin/modern.js',
  );
}
