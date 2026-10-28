import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stringify as dump, parse as load } from 'yaml';
import {
  inspectNpmTarball,
  readVerifiedPackageArtifactBytes,
} from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import {
  compilerBootstrapSelectors,
  expectedReleaseCohort,
  reviewedCompilerTrustExclusions,
} from '../published-create-proof/package-cohort.mjs';
import { validateExactExclusions } from '../published-create-proof/release-age-audit.mjs';
import { collectPackageJsonFiles } from './contract.mjs';

const dependencyBlocks = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

export const tractorEffectPackages = [
  'effect',
  '@effect/opentelemetry',
  '@effect/tsgo',
];

export const tractorReactPackages = [
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
];

export function assertTractorReactDependencies(dependencies) {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Object.keys(dependencies).length !== tractorReactPackages.length ||
    tractorReactPackages.some(
      name =>
        typeof dependencies[name] !== 'string' ||
        !/^\d+\.\d+\.\d+$/u.test(dependencies[name]),
    ) ||
    dependencies.react !== dependencies['react-dom']
  ) {
    throw new Error(
      'Exact producer React dependencies must select paired React and React DOM and exact type versions',
    );
  }
  return dependencies;
}

export function assertTractorEffectDependencies(dependencies) {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Object.keys(dependencies).length !== tractorEffectPackages.length ||
    tractorEffectPackages.some(
      name =>
        typeof dependencies[name] !== 'string' ||
        !/^\d+\.\d+\.\d+$/u.test(dependencies[name]),
    ) ||
    dependencies.effect !== dependencies['@effect/opentelemetry']
  ) {
    throw new Error(
      'Exact producer Effect dependencies must select native stable Effect, OpenTelemetry and compiler versions',
    );
  }
  return dependencies;
}

/** Select the exact supplied bundle through the consumer's native pnpm catalog. */
export function prepareTractorCohortInstallation(
  workspace,
  release,
  {
    pnpmOverrides = {},
    minimumReleaseAgeExclude,
    trustPolicy,
    trustPolicyIgnoreAfter,
    trustPolicyExclude,
    producerEffectDependencies,
    producerReactDependencies,
  } = {},
) {
  const effectDependencies = assertTractorEffectDependencies(
    producerEffectDependencies,
  );
  const reactDependencies = assertTractorReactDependencies(
    producerReactDependencies,
  );
  const nativeDependencies = { ...effectDependencies, ...reactDependencies };
  const nativePackages = [...tractorEffectPackages, ...tractorReactPackages];
  const cohort = expectedReleaseCohort(release);
  const version = release.release.version;
  const create = release.createPackage;
  const packed = inspectNpmTarball(
    readVerifiedPackageArtifactBytes(create, create.artifactPath),
  );
  const cohortBytes = packed.fileContents.get('release-cohort.json');
  if (!cohortBytes) {
    throw new Error(
      'Release create package is missing its producer-owned release-cohort.json',
    );
  }
  let installedCohort;
  try {
    installedCohort = JSON.parse(cohortBytes.toString('utf8'));
  } catch {
    throw new Error(
      'Release create package has an invalid release-cohort.json',
    );
  }
  if (
    !isDeepStrictEqual(installedCohort.aliases, cohort.aliases) ||
    installedCohort.release?.version !== version ||
    (release.cohortProjection?.value &&
      !isDeepStrictEqual(installedCohort, release.cohortProjection.value))
  ) {
    throw new Error(
      'Installed producer release cohort disagrees with the authenticated bundle',
    );
  }
  const verifiedSidecars = (release.sidecars?.packages ?? [])
    .map(({ name, version }) => ({ name, version }))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  if (!isDeepStrictEqual(installedCohort.sidecars, verifiedSidecars)) {
    throw new Error(
      'Installed producer sidecars disagree with the authenticated bundle',
    );
  }
  const sidecars = new Map(
    verifiedSidecars.map(item => [item.name, item.version]),
  );
  const producerExclusions = validateExactExclusions(
    minimumReleaseAgeExclude,
    'Producer pnpm minimumReleaseAgeExclude',
  );
  const compilerSelectors = compilerBootstrapSelectors(packed.packageJson);
  const expectedExclusions = [
    ...cohort.targetNames.map(name => `${name}@${version}`),
    ...Array.from(
      sidecars,
      ([name, sidecarVersion]) => `${name}@${sidecarVersion}`,
    ),
    ...compilerSelectors,
  ].sort();
  if (!isDeepStrictEqual(producerExclusions, expectedExclusions)) {
    throw new Error(
      'Producer pnpm minimumReleaseAgeExclude must select exactly the verified Modern.js cohort, sidecars and packed producer compiler selectors',
    );
  }
  if (trustPolicy !== 'no-downgrade' || trustPolicyIgnoreAfter !== 1440) {
    throw new Error(
      'Producer pnpm trust policy must retain no-downgrade and its 24-hour window',
    );
  }
  const producerTrustExclusions = validateExactExclusions(
    trustPolicyExclude,
    'Producer pnpm trustPolicyExclude',
  );
  if (
    !isDeepStrictEqual(
      producerTrustExclusions,
      reviewedCompilerTrustExclusions(compilerSelectors),
    )
  ) {
    throw new Error(
      'Producer pnpm trustPolicyExclude must select exactly the reviewed packed producer compiler exceptions',
    );
  }
  const compiler = prepareTractorCompilerConfig(workspace);

  const workspaceFile = path.join(workspace, 'pnpm-workspace.yaml');
  const policy = load(fs.readFileSync(workspaceFile, 'utf8'));
  const catalog = policy?.catalogs?.ultramodern;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('Tractor requires a native catalogs.ultramodern entry');
  }
  const requested = new Set();
  let dependencyCount = 0;
  for (const file of collectPackageJsonFiles(workspace)) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const block of dependencyBlocks) {
      for (const [name, specifier] of Object.entries(manifest[block] ?? {})) {
        if (!name.startsWith('@modern-js/')) continue;
        if (!cohort.aliases[name]) {
          throw new Error(
            `Tractor dependency ${name} is absent from the release cohort`,
          );
        }
        if (specifier !== 'catalog:ultramodern') {
          throw new Error(
            `Tractor dependency ${name} in ${path.relative(workspace, file)} must use catalog:ultramodern`,
          );
        }
        requested.add(name);
        dependencyCount += 1;
      }
    }
  }
  if (dependencyCount === 0) {
    throw new Error('Tractor has no framework dependencies to install');
  }
  for (const name of Object.keys(catalog)) {
    if (!cohort.aliases[name]) {
      throw new Error(
        `Tractor catalog entry ${name} is absent from the release cohort`,
      );
    }
  }
  for (const name of requested) {
    if (!Object.hasOwn(catalog, name)) {
      throw new Error(
        `Tractor catalog is missing requested framework dependency ${name}`,
      );
    }
  }
  for (const [name, target] of Object.entries(cohort.aliases)) {
    catalog[name] = `npm:${target}@${version}`;
  }
  // Consumers select sidecars directly (`npm:@bleedingdev/mf-modern-js-v3@…`
  // in manifests, the default and named catalogs, and overrides). The bundle ships its own sidecar
  // versions, so adopting it moves those selections too.
  for (const selections of [
    policy.catalog,
    ...Object.values(policy.catalogs),
    policy.overrides,
  ]) {
    selectBundleSidecars(selections, sidecars);
    if (selections)
      for (const name of nativePackages) {
        if (Object.hasOwn(selections, name))
          selections[name] = nativeDependencies[name];
      }
  }
  const manifestUpdates = collectPackageJsonFiles(workspace).flatMap(file => {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = false;
    if (
      path.dirname(file) !== workspace &&
      ['ts', 'js', 'mjs'].some(extension =>
        fs.existsSync(
          path.join(path.dirname(file), `modern.config.${extension}`),
        ),
      )
    ) {
      const dependency = '@modern-js/backend-federation-contracts';
      if (!cohort.aliases[dependency])
        throw new Error(
          'Tractor native build identity dependency is absent from the exact release cohort',
        );
      manifest.dependencies ??= {};
      changed = manifest.dependencies[dependency] !== 'catalog:ultramodern';
      manifest.dependencies[dependency] = 'catalog:ultramodern';
    }
    for (const block of dependencyBlocks) {
      changed = selectBundleSidecars(manifest[block], sidecars) || changed;
      for (const name of nativePackages) {
        if (
          Object.hasOwn(manifest[block] ?? {}, name) &&
          !manifest[block][name].startsWith('catalog:')
        ) {
          changed ||= manifest[block][name] !== nativeDependencies[name];
          manifest[block][name] = nativeDependencies[name];
        }
      }
    }
    return changed ? [[file, manifest]] : [];
  });
  for (const specifier of Object.values(pnpmOverrides)) {
    if (typeof specifier !== 'string') {
      throw new Error(
        'Producer pnpm overrides must be native string selections',
      );
    }
    if (!specifier.startsWith('npm:@bleedingdev/')) continue;
    const separator = specifier.lastIndexOf('@');
    const name = specifier.slice('npm:'.length, separator);
    if (sidecars.get(name) !== specifier.slice(separator + 1)) {
      throw new Error(
        `Producer pnpm override ${specifier} differs from the exact sidecar bundle`,
      );
    }
  }
  const managedPackages = [
    ...nativePackages,
    ...Object.keys(pnpmOverrides).map(selector => {
      const versionSeparator = selector.indexOf('@', 1);
      return versionSeparator === -1
        ? selector
        : selector.slice(0, versionSeparator);
    }),
  ];
  const managedSelector =
    managedPackages.length > 0
      ? new RegExp(
          `(?:^|>)\\s*(?:${managedPackages.map(RegExp.escape).join('|')})(?:@(?:[^>]|>(?=\\s*(?:=|\\d|v\\d)))*)?\\s*$`,
          'u',
        )
      : undefined;
  policy.overrides = {
    ...Object.fromEntries(
      Object.entries(policy.overrides ?? {}).filter(
        ([selector]) => !managedSelector?.test(selector),
      ),
    ),
    ...pnpmOverrides,
  };
  policy.minimumReleaseAge = 1440;
  policy.minimumReleaseAgeStrict = true;
  policy.minimumReleaseAgeIgnoreMissingTime = false;
  policy.minimumReleaseAgeExclude = producerExclusions;
  policy.trustPolicy = trustPolicy;
  policy.trustPolicyIgnoreAfter = trustPolicyIgnoreAfter;
  // Replace old approvals even when the new producer needs none.
  policy.trustPolicyExclude = producerTrustExclusions;
  const toolchain = prepareTractorToolchain(workspace, release.tools);
  fs.writeFileSync(workspaceFile, dump(policy, { lineWidth: 0 }));
  fs.writeFileSync(toolchain.miseFile, toolchain.mise);
  fs.writeFileSync(
    compiler.file,
    `${JSON.stringify(compiler.config, null, 2)}\n`,
  );
  fs.writeFileSync(
    toolchain.manifestFile,
    `${JSON.stringify(toolchain.manifest, null, 2)}\n`,
  );
  for (const [file, manifest] of manifestUpdates) {
    if (file === toolchain.manifestFile) {
      manifest.packageManager = toolchain.manifest.packageManager;
    }
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { catalogCount: Object.keys(cohort.aliases).length, dependencyCount };
}

// Inherit the producer's compiler policy instead of retaining a copied Effect
// diagnostics table that becomes stale when the native compiler changes.
function prepareTractorCompilerConfig(workspace) {
  const file = path.join(workspace, 'tsconfig.base.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Tractor requires a native compiler configuration object');
  }
  const options = config.compilerOptions;
  if (
    options !== undefined &&
    (!options || typeof options !== 'object' || Array.isArray(options))
  ) {
    throw new Error('Tractor requires a native compiler options object');
  }
  if (options?.plugins !== undefined) {
    if (
      !Array.isArray(options.plugins) ||
      options.plugins.some(
        plugin => plugin?.name !== '@effect/language-service',
      )
    ) {
      throw new Error(
        'Tractor compiler plugins must contain only its copied Effect policy before adopting the native preset',
      );
    }
    delete options.plugins;
  }
  const preset = '@modern-js/ultramodern-create/tsconfig';
  const inherited =
    config.extends === undefined
      ? []
      : typeof config.extends === 'string'
        ? [config.extends]
        : config.extends;
  if (
    !Array.isArray(inherited) ||
    inherited.some(value => typeof value !== 'string' || !value.trim())
  ) {
    throw new Error('Tractor compiler extends must select native config paths');
  }
  const parents = [...inherited.filter(value => value !== preset), preset];
  config.extends = parents.length === 1 ? preset : parents;
  return { file, config };
}

// Adopt the release's exact tools alongside its dependency catalog, so the
// committed consumer snapshot and its future mise-driven CI use the same tools.
function prepareTractorToolchain(workspace, tools) {
  const node =
    typeof tools?.node === 'string' ? tools.node.replace(/^v/u, '') : undefined;
  const pnpm = tools?.pnpm;
  for (const [name, version] of Object.entries({ node, pnpm })) {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
      throw new Error(`Tractor requires an exact release ${name} version`);
    }
  }
  const miseFile = path.join(workspace, '.mise.toml');
  const mise = fs.readFileSync(miseFile, 'utf8');
  // Tractor's native toolchain file contains just these two pinned tools.
  // Reject an unfamiliar shape rather than silently deleting custom settings.
  if (
    !/^\[tools\]\r?\nnode = "[^"\r\n]+"\r?\npnpm = "[^"\r\n]+"\r?\n?$/u.test(
      mise,
    )
  ) {
    throw new Error('Tractor requires its native two-tool .mise.toml');
  }
  const manifestFile = path.join(workspace, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.packageManager = `pnpm@${pnpm}`;
  return {
    manifestFile,
    manifest,
    miseFile,
    mise: `[tools]\nnode = "${node}"\npnpm = "${pnpm}"\n`,
  };
}

/** Point every `npm:<sidecar>@<version>` selection at the bundle's version. */
function selectBundleSidecars(selections, sidecars) {
  let changed = false;
  for (const [name, specifier] of Object.entries(selections ?? {})) {
    if (typeof specifier !== 'string' || !specifier.startsWith('npm:')) {
      continue;
    }
    const separator = specifier.lastIndexOf('@');
    const sidecar = specifier.slice('npm:'.length, separator);
    const version = sidecars.get(sidecar);
    if (separator <= 'npm:'.length || version === undefined) continue;
    const selected = `npm:${sidecar}@${version}`;
    if (selected !== specifier) {
      selections[name] = selected;
      changed = true;
    }
  }
  return changed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readNativeCatalog(workspace) {
  const policy = load(
    fs.readFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'utf8'),
  );
  const catalog = policy?.catalogs?.ultramodern;
  assert(
    catalog && typeof catalog === 'object' && !Array.isArray(catalog),
    'Tractor requires native catalogs.ultramodern',
  );
  return catalog;
}

function findInstalledManifest(workspace, packageFile, name) {
  let directory = path.dirname(packageFile);
  const root = path.resolve(workspace);
  while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    const candidate = path.join(
      directory,
      'node_modules',
      name,
      'package.json',
    );
    if (fs.existsSync(candidate)) return readJson(candidate);
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  throw new Error(
    `${normalizePath(path.relative(workspace, packageFile))} ${name} is not installed`,
  );
}

export function assertAuthenticatedTractorCohort(workspace, release) {
  for (const retired of [
    '.modernjs/ultramodern.json',
    '.modernjs/release-cohort.json',
  ]) {
    assert(
      !fs.existsSync(path.join(workspace, retired)),
      `Tractor still carries retired ${retired}`,
    );
  }
  const catalog = readNativeCatalog(workspace);
  const version = release.release?.version;
  const aliases = release.aliases;
  assert(
    typeof version === 'string' && version.length > 0,
    'Exact release version is required',
  );
  assert(
    aliases && typeof aliases === 'object',
    'Exact release aliases are required',
  );
  const cohortPath = path.join(
    workspace,
    'node_modules/@modern-js/ultramodern-create/release-cohort.json',
  );
  assert(
    fs.existsSync(cohortPath),
    'Installed producer release cohort is missing',
  );
  const observed = readJson(cohortPath);
  assert(
    observed.release?.version === version &&
      isDeepStrictEqual(observed.aliases, aliases) &&
      (!release.cohortProjection?.value ||
        isDeepStrictEqual(observed, release.cohortProjection.value)),
    'Installed producer release cohort differs from the exact release manifest',
  );
  for (const [name, target] of Object.entries(aliases)) {
    assert(
      catalog[name] === `npm:${target}@${version}`,
      `Tractor native catalog ${name} must select exact release ${version}`,
    );
  }
  return { catalogCount: Object.keys(aliases).length, version };
}

export function assertExactModernDependencySpecifiers(workspace, release) {
  const catalog = readNativeCatalog(workspace);
  const version = release.release?.version;
  const aliases = release.aliases;
  assert(
    typeof version === 'string' && version.length > 0,
    'Release version is required for Tractor cohort validation',
  );
  assert(
    aliases && typeof aliases === 'object',
    'Release aliases are required for Tractor cohort validation',
  );
  const observations = [];
  for (const packageFile of collectPackageJsonFiles(workspace)) {
    const manifest = readJson(packageFile);
    for (const blockName of dependencyBlocks) {
      for (const [dependencyName, specifier] of Object.entries(
        manifest[blockName] ?? {},
      )) {
        if (!dependencyName.startsWith('@modern-js/')) continue;
        const targetName = aliases[dependencyName];
        assert(
          typeof targetName === 'string',
          `${normalizePath(path.relative(workspace, packageFile))} ${blockName}.${dependencyName} is absent from the exact release cohort`,
        );
        assert(
          specifier === 'catalog:ultramodern',
          `${normalizePath(path.relative(workspace, packageFile))} ${blockName}.${dependencyName} must use catalog:ultramodern`,
        );
        const expected = `npm:${targetName}@${version}`;
        assert(
          catalog[dependencyName] === expected,
          `${dependencyName} catalog request must be ${expected}`,
        );
        const installed = findInstalledManifest(
          workspace,
          packageFile,
          dependencyName,
        );
        assert(
          installed.name === targetName && installed.version === version,
          `${dependencyName} installed identity/version differs from the exact release`,
        );
        observations.push({
          blockName,
          dependencyName,
          packageFile: normalizePath(path.relative(workspace, packageFile)),
          specifier,
          targetName,
        });
      }
    }
  }
  assert(
    observations.length > 0,
    'Tractor workspace contains no Modern.js dependencies to bind to the release cohort',
  );
  return observations;
}
