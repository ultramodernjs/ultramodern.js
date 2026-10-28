import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { assertStableSidecarVersion } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/sidecar-publication.mjs';
import { readJsonFile } from './constants.mjs';
import { parseYamlFile } from './release-age-audit.mjs';

const releaseCohortPath = 'release-cohort.json';
const retiredMetadataPaths = Object.freeze([
  '.modernjs/ultramodern.json',
  '.modernjs/release-cohort.json',
  '.modernjs/ultramodern-package-source.json',
  '.modernjs/ultramodern-workspace-template-manifest.json',
]);
const dependencyBlocks = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const bootstrapDependencyBlocks = Object.freeze([
  'dependencies',
  'optionalDependencies',
]);
const minimumReleaseAgeMinutes = 1440;
const ultramodernCreateSourceName = '@modern-js/ultramodern-create';
const authenticatedBootstrapExtras = new WeakMap();
const authenticatedBootstrapTrustCohorts = new WeakMap();
// Only compiler package versions pinned by the authenticated packed generator
// authorize these native-package identities. Other external dependencies do
// not receive bootstrap exceptions.
const compilerPlatformPackages = Object.freeze({
  '@effect/tsgo': Object.freeze([
    '@effect/tsgo-darwin-arm64',
    '@effect/tsgo-darwin-x64',
    '@effect/tsgo-linux-arm',
    '@effect/tsgo-linux-arm64',
    '@effect/tsgo-linux-x64',
    '@effect/tsgo-win32-arm64',
    '@effect/tsgo-win32-x64',
  ]),
  tsrs: Object.freeze([
    '@tsrs/darwin-arm64',
    '@tsrs/darwin-x64',
    '@tsrs/linux-arm64-gnu',
    '@tsrs/linux-arm64-musl',
    '@tsrs/linux-x64-gnu',
    '@tsrs/linux-x64-musl',
    '@tsrs/win32-x64',
  ]),
});

function compilerBootstrapSelectors(packageJson) {
  const selectors = [];
  for (const [compiler, platforms] of Object.entries(
    compilerPlatformPackages,
  )) {
    const versions = bootstrapDependencyBlocks.flatMap(blockName =>
      Object.hasOwn(packageJson[blockName] ?? {}, compiler)
        ? [packageJson[blockName][compiler]]
        : [],
    );
    if (versions.length === 0) continue;
    const version = versions[0];
    assertCondition(
      typeof version === 'string' &&
        version.trim() === version &&
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
          version,
        ) &&
        versions.every(value => value === version),
      `Authenticated generator compiler ${compiler} must use one exact bootstrap version, found ${versions.join(', ')}`,
    );
    selectors.push(`${compiler}@${version}`);
    for (const platform of platforms) selectors.push(`${platform}@${version}`);
  }
  // This metadata is authenticated with the packed producer. Admit only the
  // two reviewed runtime releases, never arbitrary dependencies or selectors.
  const runtimeSelectors =
    packageJson.ultramodern?.bootstrapReleaseAgeExclude ?? [];
  const reviewedRuntimeSelectors = new Set([
    'effect@4.0.7',
    '@effect/opentelemetry@4.0.7',
  ]);
  assertCondition(
    Array.isArray(runtimeSelectors) &&
      runtimeSelectors.every(selector =>
        reviewedRuntimeSelectors.has(selector),
      ) &&
      new Set(runtimeSelectors).size === runtimeSelectors.length,
    'Authenticated generator runtime exceptions must name only reviewed exact Effect releases',
  );
  return [...selectors, ...runtimeSelectors];
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertInstalledProducerCohort(projectDir, release) {
  assertCondition(
    isPlainObject(release?.cohortProjection) &&
      /^[a-f0-9]{64}$/u.test(release.cohortProjection.sha256) &&
      isPlainObject(release.cohortProjection.value),
    'Strict release manifest cohort projection is required for installed producer validation',
  );
  const packageRoot = path.join(
    projectDir,
    'node_modules',
    '@modern-js',
    'ultramodern-create',
  );
  const installedRoot = fs.realpathSync(packageRoot);
  const installedManifest = readJsonFile(
    path.join(installedRoot, 'package.json'),
  );
  assertCondition(
    installedManifest.name === release.createPackage.targetName &&
      installedManifest.version === release.release.version,
    'Installed create package identity differs from strict release manifest',
  );
  const filePath = path.join(installedRoot, releaseCohortPath);
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  assertCondition(
    stat?.isFile() && !stat.isSymbolicLink(),
    `Installed producer authenticated release cohort is missing or unsafe: ${releaseCohortPath}`,
  );
  const bytes = fs.readFileSync(filePath);
  const expectedBytes = Buffer.from(
    `${canonicalJson(release.cohortProjection.value, 2)}\n`,
    'utf8',
  );
  assertCondition(
    bytes.equals(expectedBytes),
    `Installed producer authenticated release cohort differs from strict release manifest: ${releaseCohortPath}`,
  );
  assertCondition(
    crypto.createHash('sha256').update(bytes).digest('hex') ===
      release.cohortProjection.sha256,
    `Installed producer authenticated release cohort SHA-256 differs from strict release manifest: ${releaseCohortPath}`,
  );
}

function sourcePackageSuffix(sourceName) {
  const separator = sourceName.lastIndexOf('/');
  assertCondition(
    sourceName.startsWith('@modern-js/') && separator > 0,
    `Release alias source must be an exact @modern-js package name: ${sourceName}`,
  );
  return sourceName.slice(separator + 1);
}

function targetAliasParts(sourceName, targetName) {
  const match = /^@(?<scope>[^/]+)\/(?<name>[^/]+)$/u.exec(targetName);
  assertCondition(
    match?.groups,
    `Release alias target must be an exact scoped package name: ${targetName}`,
  );
  const suffix = sourcePackageSuffix(sourceName);
  assertCondition(
    match.groups.name.endsWith(suffix),
    `Release alias ${sourceName} -> ${targetName} does not preserve the source package suffix`,
  );
  return {
    aliasScope: match.groups.scope,
    aliasPackageNamePrefix: match.groups.name.slice(
      0,
      match.groups.name.length - suffix.length,
    ),
  };
}

function expectedReleaseCohort(release) {
  assertCondition(
    isPlainObject(release?.aliases),
    'Strict release manifest aliases are required for cohort validation',
  );
  assertCondition(
    Array.isArray(release?.publishOrder) && release.publishOrder.length > 0,
    'Strict release manifest publishOrder is required for cohort validation',
  );

  const aliasEntries = Object.entries(release.aliases).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  assertCondition(
    aliasEntries.length > 0,
    'Strict release manifest aliases must not be empty',
  );
  const targetNames = aliasEntries.map(([, targetName]) => targetName);
  const publishedTargets = [...release.publishOrder];
  assertCondition(
    new Set(publishedTargets).size === publishedTargets.length,
    'Strict release manifest publishOrder contains duplicate targets',
  );
  assertCondition(
    JSON.stringify([...targetNames].sort()) ===
      JSON.stringify([...publishedTargets].sort()),
    'Strict release manifest aliases and publishOrder must independently enumerate the same cohort',
  );

  let aliasProfile;
  for (const [sourceName, targetName] of aliasEntries) {
    assertCondition(
      typeof targetName === 'string' && targetName.length > 0,
      `Strict release manifest alias for ${sourceName} is missing`,
    );
    const currentProfile = targetAliasParts(sourceName, targetName);
    aliasProfile ??= currentProfile;
    assertCondition(
      currentProfile.aliasScope === aliasProfile.aliasScope &&
        currentProfile.aliasPackageNamePrefix ===
          aliasProfile.aliasPackageNamePrefix,
      `Strict release manifest aliases cannot be represented by one generated package-source profile: ${sourceName} -> ${targetName}`,
    );
  }

  if (release.packages !== undefined) {
    assertCondition(
      Array.isArray(release.packages),
      'Strict release manifest package observations must be an array',
    );
    const packagePairs = release.packages
      .map(item => `${item.sourceName}\0${item.targetName}`)
      .sort();
    const expectedPairs = aliasEntries
      .map(([sourceName, targetName]) => `${sourceName}\0${targetName}`)
      .sort();
    assertCondition(
      JSON.stringify(packagePairs) === JSON.stringify(expectedPairs),
      'Strict release manifest package observations omit or add a cohort member from aliases/publishOrder',
    );
  }

  return Object.freeze({
    aliases: Object.freeze(Object.fromEntries(aliasEntries)),
    aliasScope: aliasProfile.aliasScope,
    aliasPackageNamePrefix: aliasProfile.aliasPackageNamePrefix,
    sourceNames: Object.freeze(aliasEntries.map(([sourceName]) => sourceName)),
    targetNames: Object.freeze(targetNames),
  });
}

function exactBootstrapDependencyTargets(packageJson, release, cohort) {
  const targets = new Set();
  const knownTargets = new Set(cohort.targetNames);
  for (const blockName of bootstrapDependencyBlocks) {
    for (const [dependencyName, specifier] of Object.entries(
      packageJson[blockName] ?? {},
    )) {
      const sourceAliasTarget = cohort.aliases[dependencyName];
      const npmAlias =
        typeof specifier === 'string'
          ? /^npm:(?<target>@[^/]+\/[^@]+|[^@]+)@(?<version>.+)$/u.exec(
              specifier,
            )?.groups
          : undefined;
      const targetName = sourceAliasTarget ?? npmAlias?.target;
      if (!targetName || !knownTargets.has(targetName)) {
        assertCondition(
          !targetName?.startsWith('@bleedingdev/modern-js-'),
          `${blockName}.${dependencyName} targets omitted release package ${targetName}`,
        );
        continue;
      }
      const expectedSpecifier = `npm:${targetName}@${release.release.version}`;
      assertCondition(
        specifier === expectedSpecifier,
        `${blockName}.${dependencyName} must resolve to exact bootstrap dependency ${expectedSpecifier}, found ${String(
          specifier,
        )}`,
      );
      targets.add(targetName);
    }
  }
  return [...targets].sort((left, right) => left.localeCompare(right));
}

function resolveBootstrapReleaseAgePolicy(release, cohort, createPackage) {
  assertCondition(
    isPlainObject(release?.dependencyGraph),
    'Strict release manifest dependencyGraph is required for bootstrap policy',
  );
  assertCondition(
    Array.isArray(release?.packages),
    'Strict release manifest package observations are required for bootstrap policy',
  );

  const graphTargets = Object.keys(release.dependencyGraph).sort(
    (left, right) => left.localeCompare(right),
  );
  const expectedTargets = [...cohort.targetNames].sort((left, right) =>
    left.localeCompare(right),
  );
  assertCondition(
    JSON.stringify(graphTargets) === JSON.stringify(expectedTargets),
    'Strict release manifest dependencyGraph must enumerate the exact release cohort',
  );

  const packagesByTarget = new Map();
  for (const item of release.packages) {
    assertCondition(
      isPlainObject(item) &&
        typeof item.sourceName === 'string' &&
        cohort.aliases[item.sourceName] === item.targetName,
      `Strict release manifest contains an invalid package observation for ${String(
        item?.targetName,
      )}`,
    );
    assertCondition(
      item.version === release.release.version,
      `Bootstrap dependency ${item.targetName} must use release version ${release.release.version}, found ${String(
        item.version,
      )}`,
    );
    assertCondition(
      isPlainObject(item.packageJson),
      `Bootstrap dependency ${item.targetName} is missing its authenticated packed package.json`,
    );
    assertCondition(
      !packagesByTarget.has(item.targetName),
      `Strict release manifest contains duplicate package observation ${item.targetName}`,
    );
    packagesByTarget.set(item.targetName, item);
  }
  assertCondition(
    packagesByTarget.size === expectedTargets.length,
    'Strict release manifest package observations must enumerate the exact release cohort for bootstrap policy',
  );

  for (const targetName of expectedTargets) {
    const graphDependencies = release.dependencyGraph[targetName];
    assertCondition(
      Array.isArray(graphDependencies) &&
        graphDependencies.every(
          dependency =>
            typeof dependency === 'string' &&
            packagesByTarget.has(dependency) &&
            dependency !== targetName,
        ) &&
        new Set(graphDependencies).size === graphDependencies.length,
      `Strict release manifest dependencyGraph.${targetName} is malformed`,
    );
    const packageObservation = packagesByTarget.get(targetName);
    const packedDependencies = exactBootstrapDependencyTargets(
      packageObservation.packageJson,
      release,
      cohort,
    );
    assertCondition(
      JSON.stringify(
        [...graphDependencies].sort((left, right) => left.localeCompare(right)),
      ) === JSON.stringify(packedDependencies),
      `Strict release manifest dependencyGraph.${targetName} differs from authenticated packed runtime dependencies`,
    );
  }

  const reachableTargets = new Set();
  const visiting = new Set();
  const visit = targetName => {
    assertCondition(
      !visiting.has(targetName),
      `Strict release manifest bootstrap dependency cycle includes ${targetName}`,
    );
    if (reachableTargets.has(targetName)) {
      return;
    }
    visiting.add(targetName);
    for (const dependency of release.dependencyGraph[targetName]) {
      visit(dependency);
    }
    visiting.delete(targetName);
    reachableTargets.add(targetName);
  };
  visit(createPackage.targetName);

  // readReleaseManifest supplies these identities and packed manifests only
  // after verifying sidecars.json and every corresponding tarball's bytes.
  const sidecarRecords = release.sidecars?.packages ?? [];
  assertCondition(
    Array.isArray(sidecarRecords),
    'Strict release manifest sidecar observations must be an array',
  );
  const sidecarsByName = new Map();
  for (const item of sidecarRecords) {
    assertCondition(
      isPlainObject(item) &&
        typeof item.name === 'string' &&
        /^@bleedingdev\/[a-z0-9][a-z0-9._~-]*$/u.test(item.name) &&
        !item.name.startsWith('@bleedingdev/modern-js-') &&
        isPlainObject(item.packageJson) &&
        item.packageJson.name === item.name &&
        item.packageJson.version === item.version &&
        !sidecarsByName.has(item.name),
      `Strict release manifest contains an invalid packed sidecar observation for ${String(item?.name)}`,
    );
    assertStableSidecarVersion(item.name, item.version);
    sidecarsByName.set(item.name, item);
  }
  const reachableSidecars = new Set();
  const visitSidecars = packageJson => {
    for (const blockName of bootstrapDependencyBlocks) {
      for (const [dependencyName, specifier] of Object.entries(
        packageJson[blockName] ?? {},
      )) {
        const npmAlias =
          typeof specifier === 'string'
            ? /^npm:(?<target>@[^/]+\/[^@]+|[^@]+)@(?<version>.+)$/u.exec(
                specifier,
              )?.groups
            : undefined;
        const targetName = npmAlias?.target ?? dependencyName;
        const sidecar = sidecarsByName.get(targetName);
        if (!sidecar) {
          assertCondition(
            !release.sidecars ||
              !targetName.startsWith('@bleedingdev/') ||
              packagesByTarget.has(targetName),
            `${blockName}.${dependencyName} targets omitted bootstrap sidecar ${targetName}`,
          );
          continue;
        }
        const expectedSpecifier = npmAlias
          ? `npm:${sidecar.name}@${sidecar.version}`
          : sidecar.version;
        assertCondition(
          specifier === expectedSpecifier,
          `${blockName}.${dependencyName} must resolve to exact bootstrap sidecar ${expectedSpecifier}, found ${String(specifier)}`,
        );
        if (reachableSidecars.has(sidecar.name)) continue;
        reachableSidecars.add(sidecar.name);
        visitSidecars(sidecar.packageJson);
      }
    }
  };
  for (const targetName of reachableTargets) {
    visitSidecars(packagesByTarget.get(targetName).packageJson);
  }
  const sidecarSelectors = [...reachableSidecars].map(name => {
    const item = sidecarsByName.get(name);
    return `${item.name}@${item.version}`;
  });
  const compilerSelectors = compilerBootstrapSelectors(
    packagesByTarget.get(createPackage.targetName).packageJson,
  );
  const policy = Object.freeze({
    minimumReleaseAge: minimumReleaseAgeMinutes,
    minimumReleaseAgeExclude: Object.freeze(
      [
        ...[...reachableTargets].map(
          targetName => `${targetName}@${release.release.version}`,
        ),
        ...sidecarSelectors,
        ...compilerSelectors,
      ].sort((left, right) => left.localeCompare(right)),
    ),
    minimumReleaseAgeIgnoreMissingTime: false,
    minimumReleaseAgeStrict: true,
  });
  authenticatedBootstrapExtras.set(
    policy,
    new Set([...sidecarSelectors, ...compilerSelectors]),
  );
  authenticatedBootstrapTrustCohorts.set(
    policy,
    release.packages.map(item => `${item.targetName}@${item.version}`).sort(),
  );
  return policy;
}

function resolveCreatePackage(release, requestedSpecifier) {
  const cohort = expectedReleaseCohort(release);
  const createPackage = release?.createPackage;
  assertCondition(
    createPackage?.sourceName === ultramodernCreateSourceName,
    `Strict release manifest must identify ${ultramodernCreateSourceName} as the create package`,
  );
  assertCondition(
    cohort.aliases[createPackage.sourceName] === createPackage.targetName,
    'Strict release manifest create package does not match aliases/publishOrder',
  );
  assertCondition(
    createPackage.version === release.release?.version,
    'Strict release manifest create package version does not match release.version',
  );
  const frameworkVersion =
    createPackage.packageJson?.ultramodern?.frameworkVersion;
  assertCondition(
    frameworkVersion === release.release.version,
    `Exact create package must natively declare ultramodern.frameworkVersion=${release.release.version}, found ${String(
      frameworkVersion,
    )}`,
  );

  const exactSpecifier = `${createPackage.targetName}@${createPackage.version}`;
  if (
    requestedSpecifier !== undefined &&
    requestedSpecifier !== exactSpecifier
  ) {
    throw new Error(
      `Create package must be the exact release manifest package ${exactSpecifier}, found ${requestedSpecifier}`,
    );
  }
  const bootstrapReleaseAgePolicy = resolveBootstrapReleaseAgePolicy(
    release,
    cohort,
    createPackage,
  );
  return Object.freeze({
    packageName: createPackage.targetName,
    version: createPackage.version,
    frameworkVersion,
    exactSpecifier,
    bootstrapReleaseAgePolicy,
  });
}

function assertBootstrapReleaseAgePolicy(createPackage) {
  const policy = createPackage?.bootstrapReleaseAgePolicy;
  const createIdentity =
    typeof createPackage?.exactSpecifier === 'string'
      ? /^(?<packageName>@[^/]+\/[^@]+)@(?<version>[1-9]\d*\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/u.exec(
          createPackage.exactSpecifier,
        )?.groups
      : undefined;
  const exactExcludes = policy?.minimumReleaseAgeExclude;
  assertCondition(
    createIdentity &&
      createPackage.version === createIdentity.version &&
      policy?.minimumReleaseAge === minimumReleaseAgeMinutes &&
      policy.minimumReleaseAgeStrict === true &&
      policy.minimumReleaseAgeIgnoreMissingTime === false &&
      Array.isArray(exactExcludes) &&
      exactExcludes.length > 0 &&
      exactExcludes.every(
        specifier =>
          typeof specifier === 'string' &&
          (authenticatedBootstrapExtras.get(policy)?.has(specifier) ||
            (/^@[^/]+\/[^@/]+@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(
              specifier,
            ) &&
              specifier.endsWith(`@${createIdentity.version}`) &&
              specifier.startsWith(
                `${createIdentity.packageName.slice(
                  0,
                  createIdentity.packageName.indexOf('/') + 1,
                )}`,
              ))),
      ) &&
      new Set(exactExcludes).size === exactExcludes.length &&
      JSON.stringify(exactExcludes) ===
        JSON.stringify(
          [...exactExcludes].sort((left, right) => left.localeCompare(right)),
        ) &&
      exactExcludes.includes(createPackage.exactSpecifier),
    'Create package must carry an exact authenticated bootstrap release-age policy',
  );
  return policy;
}

// An age approval alone is not a trust approval. Only this reviewed release
// needs the bootstrap-approver workaround, and only when the producer pins it.
function reviewedCompilerTrustExclusions(bootstrapSelectors) {
  return bootstrapSelectors.includes('tsrs@0.20.1-ts7.1.0-beta')
    ? ['tsrs@0.20.1-ts7.1.0-beta']
    : [];
}

function authenticatedCompilerTrustExclusions(release) {
  if (!release?.createPackage) return [];
  const policy = resolveCreatePackage(release).bootstrapReleaseAgePolicy;
  return reviewedCompilerTrustExclusions(policy.minimumReleaseAgeExclude);
}

function createPnpmDlxArgs(createPackage, forwardedArgs, environment = {}) {
  const policy = assertBootstrapReleaseAgePolicy(createPackage);
  const compilerTrust = reviewedCompilerTrustExclusions(
    policy.minimumReleaseAgeExclude,
  );
  let trustExclusions = compilerTrust;
  if (
    compilerTrust.length &&
    environment.pnpm_config_trust_policy_exclude !== undefined
  ) {
    let provided;
    try {
      provided = JSON.parse(environment.pnpm_config_trust_policy_exclude);
    } catch {
      throw new Error(
        'Bootstrap trust requires exact authenticated source cohort selectors',
      );
    }
    const cohort = authenticatedBootstrapTrustCohorts.get(policy);
    const withCompiler = [...cohort, ...compilerTrust].sort();
    assertCondition(
      [cohort, withCompiler, compilerTrust].some(
        expected => JSON.stringify(provided) === JSON.stringify(expected),
      ),
      'Bootstrap trust requires exact authenticated source cohort selectors',
    );
    trustExclusions =
      provided.length === compilerTrust.length ? compilerTrust : withCompiler;
  }
  return [
    '--pm-on-fail=ignore',
    `--config.minimum-release-age=${policy.minimumReleaseAge}`,
    `--config.minimum-release-age-strict=${String(policy.minimumReleaseAgeStrict)}`,
    `--config.minimum-release-age-ignore-missing-time=${String(
      policy.minimumReleaseAgeIgnoreMissingTime,
    )}`,
    ...policy.minimumReleaseAgeExclude.map(
      specifier => `--config.minimum-release-age-exclude=${specifier}`,
    ),
    ...(compilerTrust.length
      ? [
          '--config.trust-policy=no-downgrade',
          '--config.trust-policy-ignore-after=1440',
          ...trustExclusions.map(
            selector => `--config.trust-policy-exclude=${selector}`,
          ),
        ]
      : []),
    'dlx',
    '--allow-build=esbuild',
    createPackage.exactSpecifier,
    ...forwardedArgs,
  ];
}

function packageJsonFiles(root) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['.git', '.output', 'dist', 'node_modules'].includes(entry.name)) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.name === 'package.json') {
        files.push(absolute);
      }
    }
  }
  return files.sort();
}

function assertNoRetiredMetadata(projectDir) {
  for (const retiredPath of retiredMetadataPaths) {
    const filePath = path.join(projectDir, retiredPath);
    if (fs.existsSync(filePath)) {
      throw new Error(
        `Generated workspace contains retired metadata ${retiredPath}`,
      );
    }
  }
}

function assertGeneratedCohort(projectDir, release) {
  assertNoRetiredMetadata(projectDir);
  assertInstalledProducerCohort(projectDir, release);
  const expected = expectedReleaseCohort(release);
  const workspace = parseYamlFile(
    path.join(projectDir, 'pnpm-workspace.yaml'),
    undefined,
    { singleDocument: true },
  );
  assertCondition(
    isPlainObject(workspace),
    'Generated pnpm-workspace.yaml must be a mapping',
  );
  const resolveRequest = (sourceName, request) => {
    if (typeof request !== 'string' || !request.startsWith('catalog:'))
      return request;
    const catalogName = request.slice('catalog:'.length);
    const catalog = catalogName
      ? workspace.catalogs?.[catalogName]
      : workspace.catalog;
    const resolved = catalog?.[sourceName];
    assertCondition(
      typeof resolved === 'string',
      `Generated pnpm catalog ${catalogName || 'default'} omits ${sourceName}`,
    );
    return resolved;
  };

  const sourceNames = new Set(expected.sourceNames);
  const targetNames = new Set(expected.targetNames);
  const sidecarVersions = new Map();
  for (const [index, sidecar] of (release.sidecars?.packages ?? []).entries()) {
    assertCondition(
      typeof sidecar?.name === 'string' &&
        sidecar.name.startsWith('@bleedingdev/') &&
        typeof sidecar.version === 'string' &&
        sidecar.version.length > 0 &&
        !sidecarVersions.has(sidecar.name),
      `Verified sidecar observation ${index} must bind one exact BleedingDev package and version`,
    );
    sidecarVersions.set(sidecar.name, sidecar.version);
  }
  const observed = new Set();
  for (const packageJsonPath of packageJsonFiles(projectDir)) {
    const relative = path.relative(projectDir, packageJsonPath);
    const packageJson = readJsonFile(packageJsonPath);
    for (const blockName of dependencyBlocks) {
      const block = packageJson[blockName];
      if (!isPlainObject(block)) {
        continue;
      }
      for (const [dependencyName, request] of Object.entries(block)) {
        const specifier = resolveRequest(dependencyName, request);
        if (targetNames.has(dependencyName)) {
          throw new Error(
            `${relative} ${blockName}.${dependencyName} bypasses the source-name alias contract`,
          );
        }
        const exactSourceName = sourceNames.has(dependencyName)
          ? dependencyName
          : undefined;
        if (dependencyName.startsWith('@modern-js/')) {
          assertCondition(
            exactSourceName,
            `${relative} declares ${dependencyName} outside strict release aliases/publishOrder`,
          );
        }
        if (exactSourceName) {
          const expectedSpecifier = `npm:${expected.aliases[exactSourceName]}@${release.release.version}`;
          assertCondition(
            specifier === expectedSpecifier,
            `${relative} ${blockName}.${dependencyName} must be ${expectedSpecifier}, found ${String(
              specifier,
            )}`,
          );
          observed.add(exactSourceName);
          continue;
        }
        const npmAlias =
          typeof specifier === 'string'
            ? /^npm:(?<target>@[^/]+\/[^@]+|[^@]+)@(?<version>.+)$/u.exec(
                specifier,
              )?.groups
            : undefined;
        if (npmAlias && targetNames.has(npmAlias.target)) {
          const expectedSpecifier = `npm:${npmAlias.target}@${release.release.version}`;
          assertCondition(
            specifier === expectedSpecifier,
            `${relative} ${blockName}.${dependencyName} must target exact cohort package ${npmAlias.target}@${release.release.version}, found ${String(
              specifier,
            )}`,
          );
        }
        if (npmAlias && sidecarVersions.has(npmAlias.target)) {
          const expectedSpecifier = `npm:${npmAlias.target}@${sidecarVersions.get(npmAlias.target)}`;
          assertCondition(
            specifier === expectedSpecifier,
            `${relative} ${blockName}.${dependencyName} must target exact verified sidecar ${npmAlias.target}@${sidecarVersions.get(npmAlias.target)}, found ${String(specifier)}`,
          );
        }
        if (
          typeof specifier === 'string' &&
          specifier.startsWith('npm:@bleedingdev/')
        ) {
          assertCondition(
            targetNames.has(npmAlias?.target) ||
              sidecarVersions.has(npmAlias?.target),
            `${relative} ${blockName}.${dependencyName} aliases an unknown BleedingDev cohort target ${String(
              npmAlias?.target,
            )}`,
          );
        }
      }
    }
  }
  assertCondition(
    observed.size > 0,
    'Generated workspace does not observe any strict release Modern package alias',
  );

  return {
    expectedPackageCount: expected.sourceNames.length,
    observedPackageCount: observed.size,
    observedSourceNames: [...observed].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export {
  assertBootstrapReleaseAgePolicy,
  assertGeneratedCohort,
  authenticatedCompilerTrustExclusions,
  compilerBootstrapSelectors,
  createPnpmDlxArgs,
  expectedReleaseCohort,
  packageJsonFiles,
  resolveCreatePackage,
  retiredMetadataPaths,
  reviewedCompilerTrustExclusions,
};
