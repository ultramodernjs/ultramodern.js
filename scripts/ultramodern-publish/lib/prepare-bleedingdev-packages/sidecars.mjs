// Consumer: prepare-bleedingdev-packages.mjs version-preserving sidecar staging lane.
//
// Sidecars are fork-owned republications of upstream packages whose dependency
// edges must resolve corrected artifacts without consumer overrides. They are NOT
// part of the Modern.js cohort:
//   * their names are never prefixed with the cohort prefix (`modern-js-`) -
//     npm-normalize-package-bin derives a string-form bin's key from
//     basename(name), so a prefixed name would silently rename an upstream
//     CLI such as `mf` and break it;
//   * their versions are never forced to the cohort's
//     X.Y.Z-ultramodern.N revision - npm evaluates non-wildcard peer ranges
//     with a loose-only semver check that EXCLUDES prereleases, so a
//     prerelease sidecar would satisfy pnpm but fail every strict
//     npm/yarn-classic consumer;
//   * their dependency keys are retained - recipe-only packages are rebuilt
//     from authenticated upstream tarballs, canonical patches and exact aliases;
//   * releases declare sidecar aliases in source.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fsKit from '../../../lib/fs-kit.js';
import {
  repoRoot as defaultRepoRoot,
  sidecarManifestFile,
  sidecarManifestSchema,
  sidecarManifestSchemaVersion,
  sidecarScope,
  sidecarStagingDirectory,
  sidecarTarballsDirectory,
} from './constants.mjs';
import {
  canonicalJson,
  inspectNpmTarball,
} from './release-artifacts.mjs';
import { verifySidecar } from '../../../ultramodern-supply/verify-sidecars.mjs';

const { readJsonFile } = fsKit;
const recipes = JSON.parse(
  fs.readFileSync(new URL('../../../ultramodern-supply/sidecars.json', import.meta.url), 'utf8'),
);
const recipeByRoot = new Map(
  recipes
    .filter(recipe => recipe.artifacts.length === 1 && recipe.artifacts[0] === '*')
    .map(recipe => [`packages/sidecar/${recipe.id}`, recipe]),
);

const SIDECAR_PACKAGE_ROOTS = recipes.map(recipe => `packages/sidecar/${recipe.id}`);

// The code-reviewed registry chronology each sidecar name must satisfy before a
// published version is reused: the same schema as the cohort's policies.
function sidecarProvenancePolicy(name) {
  const recipe = recipes.find(candidate => candidate.fork.name === name);
  if (!recipe?.provenance) {
    throw new Error(
      `${name} has no provenance policy in scripts/ultramodern-supply/sidecars.json`,
    );
  }
  return recipe.provenance;
}

// Upstream CLI contracts that must survive republication verbatim.
const sidecarBinNames = new Map([
  ['@bleedingdev/mf-cli', 'mf'],
  ['@bleedingdev/mf-enhanced', 'mf'],
]);

const stableVersionPattern = /^\d+\.\d+\.\d+$/u;

const aliasSpecifierPattern =
  /^npm:(?<target>@[^/]+\/[^@]+|[^@][^@]*)@(?<version>.+)$/u;

const dependencyBlockNames = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const stagedDirectoryName = name => name.replaceAll('/', '__');

function unscopedName(name) {
  return name.slice(sidecarScope.length + 1);
}

function normalizeBinPath(binPath) {
  return typeof binPath === 'string' && binPath.startsWith('./')
    ? binPath.slice(2)
    : binPath;
}

/**
 * Mirror of npm-normalize-package-bin for the cases a sidecar can hit: a
 * string bin becomes `{ [basename(name)]: value }`. This is the reason a
 * sidecar name may never carry the cohort prefix.
 */
function normalizeSidecarBin(packageJson) {
  const { bin, name } = packageJson;
  if (bin === undefined || bin === null) {
    return undefined;
  }

  if (typeof bin === 'string') {
    return { [path.basename(String(name))]: normalizeBinPath(bin) };
  }

  if (typeof bin !== 'object' || Array.isArray(bin)) {
    throw new Error(
      `Sidecar ${name} declares an unsupported bin of type ${typeof bin}`,
    );
  }

  return Object.fromEntries(
    Object.entries(bin).map(([binName, binPath]) => [
      binName,
      normalizeBinPath(binPath),
    ]),
  );
}

function assertSidecarName(name, root) {
  if (typeof name !== 'string' || !name.startsWith(`${sidecarScope}/`)) {
    throw new Error(
      `Sidecar package at ${root} must be named ${sidecarScope}/<name>, found ${String(name)}`,
    );
  }

  const unscoped = unscopedName(name);
  if (unscoped.length === 0 || unscoped.includes('/')) {
    throw new Error(`Sidecar package at ${root} has an unusable name ${name}`);
  }

  if (unscoped.startsWith('modern-js-')) {
    throw new Error(
      [
        `Sidecar ${name} must not carry the Modern.js cohort prefix.`,
        'Sidecars are independent republications; the cohort prefix would rename their string-form bins via npm-normalize-package-bin (basename of the package name) and break the upstream CLI contract.',
      ].join('\n'),
    );
  }
}

function assertSidecarVersion(name, version) {
  if (typeof version !== 'string' || !stableVersionPattern.test(version)) {
    throw new Error(
      [
        `Sidecar ${name} version ${String(version)} must be stable semver (X.Y.Z).`,
        'npm resolves non-wildcard peer ranges with a prerelease-excluding check.',
      ].join('\n'),
    );
  }
}

function assertSidecarBin(packageJson, root) {
  const expectedBinName = sidecarBinNames.get(packageJson.name);
  const normalizedBin = normalizeSidecarBin(packageJson);
  if (!expectedBinName) {
    return normalizedBin;
  }

  if (!normalizedBin) {
    throw new Error(
      `Sidecar ${packageJson.name} at ${root} must keep the upstream '${expectedBinName}' bin`,
    );
  }

  if (typeof packageJson.bin === 'string') {
    const derivedBinName = path.basename(packageJson.name);
    if (derivedBinName !== expectedBinName) {
      throw new Error(
        [
          `Sidecar ${packageJson.name} declares a string bin, which npm normalizes to the key '${derivedBinName}'.`,
          `The upstream CLI contract requires '${expectedBinName}'.`,
        ].join('\n'),
      );
    }
    return normalizedBin;
  }

  if (!Object.hasOwn(normalizedBin, expectedBinName)) {
    throw new Error(
      `Sidecar ${packageJson.name} must expose the '${expectedBinName}' bin, found ${Object.keys(normalizedBin).join(', ') || 'none'}`,
    );
  }

  return normalizedBin;
}

function assertSidecarDependencies(packageJson, root) {
  for (const blockName of dependencyBlockNames) {
    const block = packageJson[blockName];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      continue;
    }

    for (const [dependencyName, specifier] of Object.entries(block)) {
      if (typeof specifier !== 'string') {
        continue;
      }
      if (specifier.startsWith('workspace:')) {
        throw new Error(
          `Sidecar ${packageJson.name} at ${root} ${blockName}.${dependencyName} uses ${specifier}; sidecars publish verbatim and cannot carry workspace protocol specifiers`,
        );
      }
      if (specifier.startsWith('npm:@modern-js/')) {
        throw new Error(
          `Sidecar ${packageJson.name} at ${root} ${blockName}.${dependencyName} aliases the unpublished upstream name ${specifier}`,
        );
      }
    }
  }
}

function readSidecarManifest(repoRoot, root) {
  const dir = path.resolve(repoRoot, root);
  const packageJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      `Sidecar package root ${root} has no package.json; vendor the sidecar before staging it`,
    );
  }
  return { dir, packageJson: readJsonFile(packageJsonPath), packageJsonPath };
}

/**
 * Read every sidecar package root and enforce the fail-closed invariants that
 * keep a sidecar publishable to strict npm consumers.
 */
function collectSidecarPackages(
  repoRoot = defaultRepoRoot,
  { roots = SIDECAR_PACKAGE_ROOTS } = {},
) {
  const sidecars = roots.map(root => {
    const recipe = repoRoot === defaultRepoRoot ? recipeByRoot.get(root) : undefined;
    if (recipe) {
      const packageJson = {
        name: recipe.fork.name,
        version: recipe.fork.version,
        license: recipe.license,
        publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' },
        ...recipe.manifestChanges,
      };
      assertSidecarName(packageJson.name, root);
      assertSidecarVersion(packageJson.name, packageJson.version);
      assertSidecarDependencies(packageJson, root);
      return {
        bin: undefined,
        dir: undefined,
        name: packageJson.name,
        packageJson,
        packageJsonPath: undefined,
        recipeOnly: true,
        root,
        version: packageJson.version,
      };
    }
    const { dir, packageJson, packageJsonPath } = readSidecarManifest(
      repoRoot,
      root,
    );

    assertSidecarName(packageJson.name, root);
    assertSidecarVersion(packageJson.name, packageJson.version);

    if (packageJson.private) {
      throw new Error(
        `Sidecar ${packageJson.name} at ${root} must not be private`,
      );
    }
    if (packageJson.publishConfig?.access !== 'public') {
      throw new Error(
        `Sidecar ${packageJson.name} at ${root} must declare publishConfig.access "public"`,
      );
    }

    const bin = assertSidecarBin(packageJson, root);
    assertSidecarDependencies(packageJson, root);

    return {
      bin,
      dir,
      name: packageJson.name,
      packageJson,
      packageJsonPath,
      root,
      version: packageJson.version,
    };
  });

  const seen = new Set();
  for (const sidecar of sidecars) {
    if (seen.has(sidecar.name)) {
      throw new Error(`Duplicate sidecar package name ${sidecar.name}`);
    }
    seen.add(sidecar.name);
  }

  return sidecars;
}

function sidecarAliasEntries(packageJson) {
  const entries = [];
  for (const blockName of dependencyBlockNames) {
    const block = packageJson[blockName];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      continue;
    }
    for (const [dependencyName, specifier] of Object.entries(block)) {
      if (typeof specifier !== 'string') {
        continue;
      }
      const match = aliasSpecifierPattern.exec(specifier);
      const target = match?.groups?.target ?? dependencyName;
      if (!target || !target.startsWith(`${sidecarScope}/`)) {
        continue;
      }
      entries.push({
        blockName,
        dependencyName,
        specifier,
        target,
        version: match?.groups?.version ?? specifier,
      });
    }
  }
  return entries;
}

/**
 * Order sidecars so a sidecar publishes after everything it aliases.
 */
function sidecarPublishOrder(sidecars) {
  const byName = new Map(sidecars.map(sidecar => [sidecar.name, sidecar]));
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();

  const visit = sidecar => {
    if (visited.has(sidecar.name)) {
      return;
    }
    if (visiting.has(sidecar.name)) {
      throw new Error(`Sidecar dependency cycle includes ${sidecar.name}`);
    }
    visiting.add(sidecar.name);
    for (const entry of sidecarAliasEntries(sidecar.packageJson)) {
      const dependency = byName.get(entry.target);
      if (dependency && dependency !== sidecar) {
        visit(dependency);
      }
    }
    visiting.delete(sidecar.name);
    visited.add(sidecar.name);
    ordered.push(sidecar);
  };

  for (const sidecar of [...sidecars].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    visit(sidecar);
  }

  return ordered;
}

/**
 * Stage a committed sidecar verbatim, or reconstruct a recipe-only sidecar
 * from its authenticated upstream artifact. Neither path applies cohort
 * name/version rewriting or consumer overrides.
 */
async function stageSidecarPackage(
  sidecar,
  stageDir,
  { repoRoot = defaultRepoRoot } = {},
) {
  const packageDir = path.join(stageDir, stagedDirectoryName(sidecar.name));
  fs.rmSync(packageDir, { force: true, recursive: true });
  if (sidecar.recipeOnly) {
    await verifySidecar(path.basename(sidecar.root), {
      materializeTo: packageDir,
    });
  } else {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.cpSync(sidecar.dir, packageDir, {
      recursive: true,
      filter: source => {
        const base = path.basename(source);
        return base !== 'node_modules' && base !== '.git';
      },
    });
  }

  const stagedPackageJsonPath = path.join(packageDir, 'package.json');
  const stagedBytes = fs.readFileSync(stagedPackageJsonPath);
  const stagedPackageJson = JSON.parse(stagedBytes);
  if (sidecar.recipeOnly) {
    assertSidecarName(stagedPackageJson.name, sidecar.root);
    assertSidecarVersion(stagedPackageJson.name, stagedPackageJson.version);
    assertSidecarBin(stagedPackageJson, sidecar.root);
    assertSidecarDependencies(stagedPackageJson, sidecar.root);
    if (stagedPackageJson.name !== sidecar.name || stagedPackageJson.version !== sidecar.version) {
      throw new Error(`Reconstructed sidecar ${sidecar.name} identity changed`);
    }
  } else if (!stagedBytes.equals(fs.readFileSync(sidecar.packageJsonPath))) {
    throw new Error(
      `Staged sidecar ${sidecar.name} manifest differs from ${sidecar.root}/package.json; sidecars must stage verbatim`,
    );
  }

  return {
    ...sidecar,
    bin: assertSidecarBin(stagedPackageJson, sidecar.root),
    packageJson: stagedPackageJson,
    packageJsonPath: stagedPackageJsonPath,
    packageDir: path.relative(repoRoot, packageDir),
    stagedDir: packageDir,
  };
}

/** Stage every sidecar under `<outDir>/sidecars`; shared by release staging and the test harness. */
async function stageSidecarPackages(sidecars, outDir) {
  const stageDir = path.join(outDir, sidecarStagingDirectory);
  fs.mkdirSync(stageDir, { recursive: true });
  const staged = [];
  for (const sidecar of sidecars) {
    staged.push(await stageSidecarPackage(sidecar, stageDir));
  }
  return staged;
}

function sidecarArtifactDigests(bytes) {
  return {
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
  };
}

function packStagedSidecar(
  sidecar,
  tarballsDir,
  { command = execFileSync, outDir = path.dirname(tarballsDir) } = {},
) {
  fs.mkdirSync(tarballsDir, { recursive: true });
  const before = new Set(fs.readdirSync(tarballsDir));
  const stdout = command(
    'npm',
    [
      'pack',
      sidecar.stagedDir,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      tarballsDir,
    ],
    {
      cwd: defaultRepoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let metadata;
  try {
    const parsed = JSON.parse(String(stdout));
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error('npm pack must return exactly one artifact');
    }
    [metadata] = parsed;
  } catch (error) {
    throw new Error(
      `npm pack for ${sidecar.name} did not return a single JSON artifact: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const created = fs
    .readdirSync(tarballsDir)
    .filter(fileName => !before.has(fileName));
  if (created.length !== 1) {
    throw new Error(
      `npm pack for ${sidecar.name} created ${created.length} files; expected exactly one`,
    );
  }
  if (
    typeof metadata.filename !== 'string' ||
    path.basename(metadata.filename) !== metadata.filename ||
    metadata.filename !== created[0]
  ) {
    throw new Error(`npm pack for ${sidecar.name} returned an unsafe filename`);
  }
  if (metadata.name !== sidecar.name || metadata.version !== sidecar.version) {
    throw new Error(
      `npm pack identity mismatch for ${sidecar.name}: ${String(metadata.name)}@${String(metadata.version)}`,
    );
  }

  const tarballPath = path.join(tarballsDir, metadata.filename);
  const bytes = fs.readFileSync(tarballPath);
  const inspection = inspectNpmTarball(bytes);
  const stagedPackageJsonBytes = fs.readFileSync(
    path.join(sidecar.stagedDir, 'package.json'),
  );
  if (!inspection.packageJsonBytes.equals(stagedPackageJsonBytes)) {
    throw new Error(
      `Packed sidecar ${sidecar.name} manifest differs from its staged package.json`,
    );
  }
  const digests = sidecarArtifactDigests(bytes);
  const computed = {
    ...digests,
    fileCount: inspection.fileCount,
    fileListSha256: inspection.fileListSha256,
    packageJsonSha256: inspection.packageJsonSha256,
    size: bytes.length,
    unpackedSize: inspection.unpackedSize,
  };
  for (const field of [
    'integrity',
    'shasum',
    'size',
    'unpackedSize',
  ]) {
    if (metadata[field] !== computed[field]) {
      throw new Error(
        `npm pack ${field} mismatch for ${sidecar.name}: reported ${String(metadata[field])}, computed ${computed[field]}`,
      );
    }
  }
  if (metadata.entryCount !== computed.fileCount) {
    throw new Error(
      `npm pack file count mismatch for ${sidecar.name}: reported ${String(metadata.entryCount)}, computed ${computed.fileCount}`,
    );
  }

  return {
    artifact: {
      ...computed,
      tarballPath: path.relative(outDir, tarballPath).split(path.sep).join('/'),
    },
    bytes,
    tarballPath,
  };
}

/**
 * Every hard-coded `npm:@bleedingdev/<name>@<version>` alias in the staged
 * cohort (notably @modern-js/image) and inside the sidecar manifests
 * themselves must name a sidecar that this
 * run actually stages, at exactly that version. The cohort collector forces
 * the cohort version onto package versions but never touches alias TARGETS,
 * so this is the only seam that keeps those literals honest.
 */
function validateAliasConsistency(
  stagedManifests,
  sidecars,
  { cohortTargetNames = new Set() } = {},
) {
  const byName = new Map(sidecars.map(sidecar => [sidecar.name, sidecar]));
  const manifests = [
    ...stagedManifests.map(item => ({
      name: item.name ?? item.targetName ?? item.packageJson?.name,
      packageJson: item.packageJson ?? item,
    })),
    ...sidecars.map(sidecar => ({
      name: sidecar.name,
      packageJson: sidecar.packageJson,
    })),
  ];

  for (const manifest of manifests) {
    for (const entry of sidecarAliasEntries(manifest.packageJson)) {
      if (cohortTargetNames.has(entry.target)) {
        continue;
      }

      const sidecar = byName.get(entry.target);
      if (!sidecar) {
        throw new Error(
          [
            `${manifest.name} ${entry.blockName}.${entry.dependencyName} aliases ${entry.specifier}, which is neither a staged sidecar nor a cohort package.`,
            `Staged sidecars: ${[...byName.keys()].sort().join(', ') || 'none'}`,
          ].join('\n'),
        );
      }

      if (sidecar.version !== entry.version) {
        throw new Error(
          [
            `${manifest.name} ${entry.blockName}.${entry.dependencyName} pins ${entry.specifier} but sidecar ${sidecar.name} stages version ${sidecar.version}.`,
            'Alias targets are never rewritten by the publisher; update the alias or the sidecar version so they match.',
          ].join('\n'),
        );
      }
    }
  }

  return manifests.length;
}

/**
 * Record the sidecar publication lane for the CI step that publishes sidecars
 * BEFORE the cohort (the aliases in @modern-js/image only resolve once the
 * sidecar versions exist on the registry).
 */
function writeSidecarStagingManifest(
  outDir,
  stagedSidecars,
  { command = execFileSync, publishBefore } = {},
) {
  const ordered = sidecarPublishOrder(stagedSidecars);
  const tarballsDir = path.join(outDir, sidecarTarballsDirectory);
  fs.rmSync(tarballsDir, { force: true, recursive: true });
  fs.mkdirSync(tarballsDir, { recursive: true });
  const packages = ordered.map(sidecar => {
    const { artifact } = packStagedSidecar(sidecar, tarballsDir, {
      command,
      outDir,
    });
    return {
      ...artifact,
      name: sidecar.name,
      root: sidecar.root,
      version: sidecar.version,
    };
  });
  const manifest = {
    packages,
    ...(publishBefore ? { publishBefore } : {}),
    publishOrder: ordered.map(sidecar => sidecar.name),
    schema: sidecarManifestSchema,
    schemaVersion: sidecarManifestSchemaVersion,
  };

  const manifestPath = path.join(outDir, sidecarManifestFile);
  const manifestBytes = Buffer.from(`${canonicalJson(manifest, 2)}\n`, 'utf8');
  fs.writeFileSync(manifestPath, manifestBytes);
  return {
    descriptor: {
      manifestPath: sidecarManifestFile,
      sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    },
    manifest,
    manifestPath,
  };
}

export {
  sidecarProvenancePolicy,
  SIDECAR_PACKAGE_ROOTS,
  collectSidecarPackages,
  normalizeSidecarBin,
  packStagedSidecar,
  sidecarAliasEntries,
  sidecarManifestSchema,
  sidecarManifestSchemaVersion,
  sidecarPublishOrder,
  stageSidecarPackage,
  stageSidecarPackages,
  validateAliasConsistency,
  writeSidecarStagingManifest,
};
