import path from 'node:path';

const releaseAcceptanceProfileId = 'erp-10';
const releaseAcceptanceVerticalCount = 10;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

const staticAcceptanceResultIds = Object.freeze([
  'registry-cohort-integrity',
  'native-create',
  'vertical-additions',
  'generate-lockfile',
  'dependency-closure-audit',
  'install',
  'pnpm-check',
  'build',
  'cloudflare-build',
  'topology',
  'module-federation',
  'api',
  'backend',
]);

const runtimeAcceptancePlatforms = Object.freeze(['node', 'workerd']);
const runtimeAcceptanceDimensions = Object.freeze([
  'ssr',
  'browser-mf',
  'api',
  'backend',
  'backend-driven-ui',
  'failure-isolation',
  'release-identity',
]);

const runtimeAcceptanceResultIds = Object.freeze(
  runtimeAcceptancePlatforms.flatMap(platform =>
    runtimeAcceptanceDimensions.map(dimension => `${platform}-${dimension}`),
  ),
);
const operationalIndependenceResultId = 'operational-independence';

const requiredAcceptanceResultIds = Object.freeze([
  ...staticAcceptanceResultIds,
  ...runtimeAcceptanceResultIds,
  operationalIndependenceResultId,
]);

function requiredAcceptanceResultIdsForMode(mode) {
  if (mode === 'source' || mode === 'published') {
    return requiredAcceptanceResultIds;
  }
  throw new Error(`Unknown acceptance mode: ${mode}`);
}

const dependencyBlocks = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const exactVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

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

function containsSkippedProof(value) {
  if (value === 'skipped') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsSkippedProof);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.skipped === true || value.status === 'skipped') {
    return true;
  }
  return Object.values(value).some(containsSkippedProof);
}

function containsDegradedProof(value) {
  if (value === 'degraded') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsDegradedProof);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.degraded === true || value.status === 'degraded') {
    return true;
  }
  return Object.values(value).some(containsDegradedProof);
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map(key => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return (
    JSON.stringify(canonicalValue(left)) ===
    JSON.stringify(canonicalValue(right))
  );
}

function releaseIdentityCoherence(identity) {
  assertCondition(
    isPlainObject(identity),
    'Release identity coherence requires an identity',
  );
  const { buildMarker: _buildMarker, ...coherence } = identity;
  return structuredClone(coherence);
}

function rendererReleaseCoherence(ui) {
  if (ui === undefined) return undefined;
  assertCondition(
    isPlainObject(ui) &&
      isPlainObject(ui.rendererIdentity) &&
      isPlainObject(ui.rendererProfile) &&
      isPlainObject(ui.routerBindings),
    'Renderer release coherence requires completed renderer evidence',
  );
  const { buildId: _buildId, ...rendererIdentity } = ui.rendererIdentity;
  return structuredClone({
    rendererIdentity,
    rendererProfile: ui.rendererProfile,
    routerBindings: ui.routerBindings,
  });
}

function operationalIndependenceEvidencePath(receiptPath) {
  const absoluteReceiptPath = path.resolve(receiptPath);
  const extension = path.extname(absoluteReceiptPath);
  const stem = extension
    ? absoluteReceiptPath.slice(0, -extension.length)
    : absoluteReceiptPath;
  return `${stem}.operational-independence.json`;
}

function releasePackageCohort(release) {
  assertCondition(
    Array.isArray(release?.packages) && release.packages.length > 0,
    'Release acceptance requires a non-empty exact package cohort',
  );
  const packages = release.packages
    .map(item => {
      assertCondition(
        typeof item?.targetName === 'string' && item.targetName.length > 0,
        'Release package targetName is missing',
      );
      assertCondition(
        typeof item.version === 'string' &&
          exactVersionPattern.test(item.version),
        `${item.targetName} release package version must be exact`,
      );
      assertCondition(
        typeof item.integrity === 'string' &&
          /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(item.integrity),
        `${item.targetName} release package integrity is missing or invalid`,
      );
      return {
        targetName: item.targetName,
        version: item.version,
        integrity: item.integrity,
      };
    })
    .sort((left, right) => left.targetName.localeCompare(right.targetName));
  assertCondition(
    new Set(packages.map(item => item.targetName)).size === packages.length,
    'Release package cohort contains duplicate target names',
  );
  return packages;
}

function exactModuleFederationVersion(specifier, label) {
  assertCondition(
    typeof specifier === 'string' && specifier.length > 0,
    `${label} version is missing`,
  );
  const aliasMatch = /^npm:(?:@[^/]+\/[^@]+|[^@]+)@(?<version>.+)$/u.exec(
    specifier,
  );
  const version = aliasMatch?.groups?.version ?? specifier;
  assertCondition(
    exactVersionPattern.test(version),
    `${label} must use one exact Module Federation version, found ${specifier}`,
  );
  return version;
}

function releaseModuleFederationCohort(release) {
  const versions = new Map();
  for (const item of release?.packages ?? []) {
    assertCondition(
      isPlainObject(item.packageJson),
      `${item.targetName} verified packed package.json is required to bind the Module Federation cohort`,
    );
    for (const blockName of dependencyBlocks) {
      const block = item.packageJson[blockName];
      if (!isPlainObject(block)) {
        continue;
      }
      for (const [packageName, specifier] of Object.entries(block)) {
        if (!packageName.startsWith('@module-federation/')) {
          continue;
        }
        const version = exactModuleFederationVersion(
          specifier,
          `${item.targetName} ${blockName}.${packageName}`,
        );
        const previous = versions.get(packageName);
        assertCondition(
          previous === undefined || previous === version,
          `Release package cohort mixes Module Federation ${packageName} versions ${previous} and ${version}`,
        );
        versions.set(packageName, version);
      }
    }
  }
  assertCondition(
    versions.size > 0,
    'Release acceptance could not bind any Module Federation package versions',
  );
  return [...versions]
    .map(([packageName, version]) => ({ packageName, version }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function createReleaseArtifactBinding(release) {
  const moduleFederation = releaseModuleFederationCohort(release);
  const runtimeSidecars = (release.sidecars?.packages ?? []).filter(
    item => item.name === '@bleedingdev/mf-runtime',
  );
  assertCondition(
    runtimeSidecars.length <= 1,
    'Release runtime sidecar identity is duplicated',
  );
  const runtimeSidecar = runtimeSidecars[0];
  if (runtimeSidecar) {
    assertCondition(
      exactVersionPattern.test(runtimeSidecar.version ?? '') &&
        runtimeSidecar.packageJson?.name === runtimeSidecar.name &&
        runtimeSidecar.packageJson.version === runtimeSidecar.version &&
        /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(runtimeSidecar.integrity ?? ''),
      'Release runtime sidecar requires one verified exact packed identity',
    );
  }
  return {
    packages: releasePackageCohort(release),
    moduleFederation,
    // SDK dependencies record upstream versions. App surfaces execute the
    // selected sidecar whose bytes readReleaseManifest already verified.
    runtimeModuleFederation: runtimeSidecar
      ? [
          {
            packageName: '@module-federation/runtime',
            version: runtimeSidecar.version,
          },
        ]
      : moduleFederation.filter(
          item => item.packageName === '@module-federation/runtime',
        ),
    sourceRevision: release.source.commit,
  };
}

function projectRuntimeArtifactBinding(artifactBinding) {
  const moduleFederation = artifactBinding.runtimeModuleFederation;
  assertCondition(
    Array.isArray(moduleFederation) &&
      moduleFederation.length === 1 &&
      moduleFederation[0]?.packageName === '@module-federation/runtime' &&
      exactVersionPattern.test(moduleFederation[0].version ?? '') &&
      artifactBinding.moduleFederation.filter(
        item => item.packageName === '@module-federation/runtime',
      ).length === 1,
    'Release acceptance requires one exact Module Federation runtime in its verified artifact cohort',
  );
  return { ...artifactBinding, moduleFederation };
}

function assertReleaseAcceptanceProfile(options) {
  assertCondition(
    options?.selectedProfile?.id === releaseAcceptanceProfileId,
    `Release acceptance requires profile ${releaseAcceptanceProfileId}, found ${String(
      options?.selectedProfile?.id,
    )}`,
  );
  assertCondition(
    (options.selectedProfile.verticalCount === undefined ||
      options.selectedProfile.verticalCount ===
        releaseAcceptanceVerticalCount) &&
      (options.verticalCount === undefined ||
        options.verticalCount === releaseAcceptanceVerticalCount) &&
      Array.isArray(options.verticals) &&
      options.verticals.length === releaseAcceptanceVerticalCount,
    `ERP-10 acceptance must generate exactly ${releaseAcceptanceVerticalCount} verticals`,
  );
  assertCondition(
    new Set(options.verticals).size === releaseAcceptanceVerticalCount,
    'ERP-10 acceptance vertical ids must be unique',
  );
  assertCondition(
    options.deployCloudflare === false,
    'Cloudflare deployment is outside exact-artifact ERP-10 acceptance',
  );
  return options;
}

function runtimeAcceptanceInvocation(mode, platform) {
  assertCondition(
    ['source', 'published'].includes(mode),
    `Acceptance artifact mode must be source or published, found ${String(mode)}`,
  );
  assertCondition(
    runtimeAcceptancePlatforms.includes(platform),
    `Acceptance runtime platform must be node or workerd, found ${String(platform)}`,
  );
  return Object.freeze({
    artifactMode: mode,
    matrixId: `${platform}-full-stack`,
    mode,
    platform,
    shellRuntime: platform,
  });
}

function assertionDetails(
  evidence,
  label,
  { artifactMode, platform, verticals },
) {
  assertCondition(isPlainObject(evidence), `${label} evidence is missing`);
  assertCondition(
    evidence.artifactMode === artifactMode,
    `${label} evidence artifactMode must be ${artifactMode}, found ${String(
      evidence.artifactMode,
    )}`,
  );
  assertCondition(
    evidence.platform === platform,
    `${label} evidence platform must be ${platform}, found ${String(
      evidence.platform,
    )}`,
  );
  assertCondition(
    evidence.status === 'pass',
    `${label} evidence status must be pass, found ${String(evidence.status)}`,
  );
  assertCondition(
    !containsSkippedProof(evidence),
    `${label} evidence contains skipped proof`,
  );
  assertCondition(
    Array.isArray(evidence.assertions) && evidence.assertions.length > 0,
    `${label} assertions must be non-empty`,
  );
  const failed = evidence.assertions.filter(
    assertion => assertion?.status !== 'pass',
  );
  assertCondition(
    failed.length === 0,
    `${label} has ${failed.length} non-passing assertion(s)`,
  );
  assertCondition(
    Array.isArray(evidence.verticalIds) &&
      sameJson([...evidence.verticalIds].sort(), [...verticals].sort()),
    `${label} evidence must cover every ERP-10 MicroVertical exactly once`,
  );
  assertCondition(
    new Set(evidence.verticalIds).size === evidence.verticalIds.length,
    `${label} evidence contains duplicate MicroVertical ids`,
  );
}

function assertSurfaceIdentity(
  surface,
  { appId, applicationSourceRevision, platform, moduleFederation },
) {
  const label = `${platform} ${appId} ${surface.name} release identity`;
  assertCondition(isPlainObject(surface.value), `${label} is missing`);
  assertCondition(
    typeof surface.value.sourceRevision === 'string' &&
      surface.value.sourceRevision.length > 0 &&
      surface.value.sourceRevision !== 'workspace',
    `${label} application sourceRevision is missing or not promotable`,
  );
  assertCondition(
    applicationSourceRevision === undefined ||
      surface.value.sourceRevision === applicationSourceRevision,
    `${label} application sourceRevision must be ${String(
      applicationSourceRevision,
    )}, found ${String(surface.value.sourceRevision)}`,
  );
  assertCondition(
    typeof surface.value.releaseVersion === 'string' &&
      surface.value.releaseVersion.length > 0,
    `${label} MicroVertical releaseVersion is missing`,
  );
  assertCondition(
    typeof surface.value.buildMarker === 'string' &&
      surface.value.buildMarker.length > 0,
    `${label} buildMarker is missing`,
  );
  assertCondition(
    sameJson(surface.value.moduleFederation, moduleFederation),
    `${label} Module Federation cohort differs from the exact release cohort`,
  );
}

function assertRuntimeReleaseIdentity(
  evidence,
  { applicationSourceRevision, platform, verticals, artifactBinding },
) {
  assertCondition(
    Array.isArray(evidence.apps) && evidence.apps.length === verticals.length,
    `${platform} release-identity evidence must cover all ${verticals.length} MicroVerticals`,
  );
  const appIds = evidence.apps.map(app => app?.appId);
  assertCondition(
    sameJson([...appIds].sort(), [...verticals].sort()),
    `${platform} release-identity evidence MicroVertical ids differ from ERP-10`,
  );
  const observed = [];
  for (const app of evidence.apps) {
    assertCondition(
      isPlainObject(app.surfaces),
      `${platform} ${app.appId} surfaces are missing`,
    );
    const surfaces = ['frontend', 'ssr', 'api', 'backend'].map(name => ({
      name,
      value: app.surfaces[name],
    }));
    for (const surface of surfaces) {
      assertSurfaceIdentity(surface, {
        appId: app.appId,
        applicationSourceRevision,
        platform,
        moduleFederation: artifactBinding.moduleFederation,
      });
    }
    const identities = surfaces.map(surface => surface.value);
    assertCondition(
      identities.every(identity => sameJson(identity, identities[0])),
      `${platform} ${app.appId} frontend, SSR, API, and backend do not share one atomic release identity`,
    );
    observed.push({
      appId: app.appId,
      buildMarker: identities[0].buildMarker,
      moduleFederation: identities[0].moduleFederation,
      releaseVersion: identities[0].releaseVersion,
      sourceRevision: identities[0].sourceRevision,
    });
  }
  return observed.sort((left, right) => left.appId.localeCompare(right.appId));
}

function assertRuntimeAcceptanceDimension(
  report,
  {
    applicationSourceRevision,
    artifactBinding,
    dimension,
    mode,
    platform,
    verticals,
  },
) {
  const label = `${platform} ${dimension}`;
  assertCondition(
    isPlainObject(report),
    `${platform} runtime acceptance report is missing`,
  );
  assertCondition(
    report.artifactMode === mode,
    `${platform} runtime report artifactMode must be ${mode}, found ${String(
      report.artifactMode,
    )}`,
  );
  assertCondition(
    report.platform === platform,
    `${platform} runtime report platform must be ${platform}, found ${String(
      report.platform,
    )}`,
  );
  assertCondition(
    report.shellRuntime === platform,
    `${platform} runtime report shellRuntime must be ${platform}, found ${String(
      report.shellRuntime,
    )}`,
  );
  assertCondition(
    isPlainObject(report.targetRuntimes) &&
      verticals.every(appId => report.targetRuntimes[appId] === platform),
    `${platform} runtime report targetRuntimes must prove every ERP-10 MicroVertical ran on ${platform}`,
  );
  assertCondition(
    report.status === 'pass',
    `${platform} runtime report status must be pass, found ${String(report.status)}`,
  );
  assertCondition(
    Array.isArray(report.skipped) && report.skipped.length === 0,
    `${platform} runtime report must not skip targets`,
  );
  const evidence = report.evidence?.[dimension];
  assertionDetails(evidence, label, {
    artifactMode: mode,
    platform,
    verticals,
  });
  const details = {
    artifactMode: mode,
    assertionCount: evidence.assertions.length,
    dimension,
    platform,
  };
  if (dimension === 'release-identity') {
    details.apps = assertRuntimeReleaseIdentity(evidence, {
      applicationSourceRevision,
      platform,
      verticals,
      artifactBinding,
    });
  }
  return details;
}

function runtimeIdentityBinding(nodeDetails, workerdDetails) {
  assertCondition(
    Array.isArray(nodeDetails?.apps) && Array.isArray(workerdDetails?.apps),
    'Node and workerd release-identity details must both be present',
  );
  const nodeByAppId = new Map(nodeDetails.apps.map(app => [app.appId, app]));
  const workerdByAppId = new Map(
    workerdDetails.apps.map(app => [app.appId, app]),
  );
  assertCondition(
    nodeByAppId.size === nodeDetails.apps.length &&
      workerdByAppId.size === workerdDetails.apps.length &&
      sameJson(
        [...nodeByAppId.keys()].sort(),
        [...workerdByAppId.keys()].sort(),
      ),
    'Node and workerd release identities must cover the same unique MicroVerticals',
  );
  for (const [appId, node] of nodeByAppId) {
    const workerd = workerdByAppId.get(appId);
    assertCondition(
      [node, workerd].every(
        identity =>
          typeof identity.buildMarker === 'string' &&
          identity.buildMarker.length > 0 &&
          identity.buildMarker.trim() === identity.buildMarker,
      ),
      `${appId} Node and workerd build markers must each be present`,
    );
    assertCondition(
      sameJson(
        releaseIdentityCoherence(node),
        releaseIdentityCoherence(workerd),
      ),
      `${appId} Node and workerd release identities differ`,
    );
  }
  return {
    node: nodeDetails.apps,
    workerd: workerdDetails.apps,
  };
}

function assertOperationalServedBehavior({
  changedIdentity,
  expectedApiValue,
  expectedUiValue,
  servedBehavior,
  target,
}) {
  const runtimePlatform = target === 'cloudflare' ? 'workerd' : 'node';
  assertCondition(
    isPlainObject(servedBehavior) &&
      servedBehavior.result === 'pass' &&
      !containsSkippedProof(servedBehavior) &&
      !containsDegradedProof(servedBehavior),
    `Operational-independence ${target} served behavior is missing, degraded, skipped, or non-passing`,
  );
  assertCondition(
    sameJson(Object.keys(servedBehavior).sort(), [
      'appId',
      'baseUrls',
      'identity',
      'platform',
      'responses',
      'result',
      'routes',
    ]),
    `Operational-independence ${target} served behavior has unknown or missing fields`,
  );
  const baseUrls = servedBehavior.baseUrls;
  let appBaseUrl;
  let shellBaseUrl;
  try {
    appBaseUrl = new URL(baseUrls?.app);
    shellBaseUrl = new URL(baseUrls?.shell);
  } catch {
    appBaseUrl = undefined;
    shellBaseUrl = undefined;
  }
  assertCondition(
    servedBehavior.appId === 'inventory' &&
      servedBehavior.platform === runtimePlatform &&
      sameJson(Object.keys(baseUrls ?? {}).sort(), ['app', 'shell']) &&
      [appBaseUrl, shellBaseUrl].every(baseUrl =>
        ['http:', 'https:'].includes(baseUrl?.protocol),
      ),
    `Operational-independence ${target} served behavior did not execute the expected inventory runtime`,
  );
  assertCondition(
    sameJson(servedBehavior.routes, {
      api: '/inventory-api/inventory',
      ssr: '/en',
      ui: '/en',
    }),
    `Operational-independence ${target} served behavior routes are invalid`,
  );
  const expectedIdentity = {
    build: changedIdentity.buildMarker,
    buildMarker: changedIdentity.buildMarker,
    sourceRevision: changedIdentity.sourceRevision,
    unitId: changedIdentity.unitId,
    version: changedIdentity.releaseVersion,
  };
  assertCondition(
    sameJson(servedBehavior.identity, expectedIdentity),
    `Operational-independence ${target} served behavior identity does not match the changed C1 identity`,
  );
  const { api, ssr, ui } = servedBehavior.responses ?? {};
  assertCondition(
    sameJson(Object.keys(servedBehavior.responses ?? {}).sort(), [
      'api',
      'ssr',
      'ui',
    ]) &&
      sameJson(Object.keys(api ?? {}).sort(), [
        'bodySha256',
        'contentType',
        'status',
        'value',
      ]) &&
      sameJson(Object.keys(ssr ?? {}).sort(), [
        'bodySha256',
        'buildMarker',
        'contentType',
        'status',
      ]) &&
      sameJson(Object.keys(ui ?? {}).sort(), [
        'bodySha256',
        'boundaryId',
        'contentType',
        'expose',
        'status',
        'value',
        'visiblyRendered',
      ]),
    `Operational-independence ${target} served behavior responses have unknown or missing fields`,
  );
  assertCondition(
    [api, ssr, ui].every(
      response =>
        response.status === 200 &&
        SHA256_PATTERN.test(response.bodySha256) &&
        typeof response.contentType === 'string' &&
        response.contentType.length > 0,
    ) &&
      ssr.buildMarker === changedIdentity.buildMarker &&
      ui.boundaryId === 'verticalInventory' &&
      ui.expose === './Widget' &&
      ui.visiblyRendered === true,
    `Operational-independence ${target} served behavior response probes are invalid`,
  );
  assertCondition(
    api.value === expectedApiValue && ui.value === expectedUiValue,
    `Operational-independence ${target} served behavior did not observe the exact C1 API and UI mutations`,
  );
  return structuredClone(servedBehavior);
}

function createOperationalIndependenceResultDetails({
  applicationSourceRevision,
  changedRevision,
  evidence,
  evidencePath,
  expectedApiValue,
  expectedChangedPaths,
  expectedUiValue,
  mode,
}) {
  assertCondition(
    ['source', 'published'].includes(mode),
    `Operational-independence artifact mode must be source or published, found ${String(mode)}`,
  );
  assertCondition(
    isPlainObject(evidence) &&
      evidence.kind === 'ultramodern-operational-independence-proof' &&
      evidence.result === 'pass' &&
      evidence.schemaVersion === 1 &&
      !containsSkippedProof(evidence),
    'Operational-independence evidence is missing, skipped, or not passing',
  );
  assertCondition(
    isPlainObject(evidence.commits) &&
      evidence.commits.baseline === applicationSourceRevision &&
      evidence.commits.changed === changedRevision &&
      sameJson(evidence.commits.changedPaths, expectedChangedPaths) &&
      evidence.commits.ownerPath === 'verticals/inventory',
    'Operational-independence commits are stale, mixed, or outside inventory ownership',
  );
  assertCondition(
    isPlainObject(evidence.apps) &&
      evidence.apps.shell?.id === 'shell-super-app' &&
      evidence.apps.changed?.id === 'inventory' &&
      evidence.apps.sibling?.id === 'finance',
    'Operational-independence evidence selected the wrong shell or MicroVerticals',
  );
  const changedIdentities = [];
  const changedRenderers = [];
  for (const target of ['node', 'cloudflare']) {
    const targetEvidence = evidence.targets?.[target];
    const comparison = targetEvidence?.comparison;
    assertCondition(
      isPlainObject(targetEvidence) &&
        isPlainObject(comparison) &&
        comparison.target === target &&
        comparison.changed?.changed === true &&
        comparison.changed.beforeIdentity?.sourceRevision ===
          applicationSourceRevision &&
        comparison.changed.afterIdentity?.sourceRevision === changedRevision &&
        typeof comparison.changed.beforeTreeDigest === 'string' &&
        comparison.changed.beforeTreeDigest.length > 0 &&
        typeof comparison.changed.afterTreeDigest === 'string' &&
        comparison.changed.afterTreeDigest.length > 0 &&
        comparison.changed.beforeTreeDigest !==
          comparison.changed.afterTreeDigest &&
        comparison.shell?.byteIdentical === true &&
        comparison.shell?.envelopeIdentical === true &&
        typeof comparison.shell.treeDigest === 'string' &&
        comparison.shell.treeDigest.length > 0 &&
        comparison.sibling?.byteIdentical === true &&
        comparison.sibling?.envelopeIdentical === true &&
        typeof comparison.sibling.treeDigest === 'string' &&
        comparison.sibling.treeDigest.length > 0,
      `Operational-independence ${target} comparison is incomplete or non-passing`,
    );
    for (const surface of [
      'uiClient',
      'ssr',
      'apiBackend',
      'backendFederation',
    ]) {
      const surfaceEvidence = comparison.changed.surfaces?.[surface];
      assertCondition(
        surfaceEvidence?.changed === true &&
          typeof surfaceEvidence.beforeDigest === 'string' &&
          surfaceEvidence.beforeDigest.length > 0 &&
          typeof surfaceEvidence.afterDigest === 'string' &&
          surfaceEvidence.afterDigest.length > 0 &&
          surfaceEvidence.beforeDigest !== surfaceEvidence.afterDigest,
        `Operational-independence ${target} ${surface} did not rotate`,
      );
    }
    assertOperationalServedBehavior({
      changedIdentity: comparison.changed.afterIdentity,
      expectedApiValue,
      expectedUiValue,
      servedBehavior: targetEvidence.servedBehavior,
      target,
    });
    assertCondition(
      isPlainObject(comparison.changed.afterUi) &&
        comparison.changed.afterUi.rendererIdentity?.appId ===
          evidence.apps.changed.id &&
        comparison.changed.afterUi.rendererIdentity?.buildId ===
          comparison.changed.afterIdentity.buildMarker,
      `Operational-independence ${target} renderer identity does not match its own changed C1 identity`,
    );
    changedIdentities.push(comparison.changed.afterIdentity);
    changedRenderers.push(rendererReleaseCoherence(comparison.changed.afterUi));
  }
  assertCondition(
    evidence.crossTarget?.equal === true &&
      evidence.crossTarget.identity?.sourceRevision === changedRevision &&
      sameJson(
        releaseIdentityCoherence(changedIdentities[0]),
        releaseIdentityCoherence(changedIdentities[1]),
      ) &&
      sameJson(
        evidence.crossTarget.identity,
        releaseIdentityCoherence(changedIdentities[0]),
      ) &&
      sameJson(evidence.crossTarget.nodeIdentity, changedIdentities[0]) &&
      sameJson(evidence.crossTarget.cloudflareIdentity, changedIdentities[1]) &&
      sameJson(changedRenderers[0], changedRenderers[1]) &&
      sameJson(evidence.crossTarget.renderer, changedRenderers[0]),
    'Operational-independence Node and Cloudflare changed identities differ',
  );
  assertCondition(
    typeof evidencePath === 'string' && path.isAbsolute(evidencePath),
    'Operational-independence durable evidence path is invalid',
  );
  return {
    artifactMode: mode,
    baselineRevision: applicationSourceRevision,
    changedPaths: [...expectedChangedPaths],
    changedRevision,
    evidencePath,
    mutations: {
      apiResponse: {
        path: expectedChangedPaths[0],
        value: expectedApiValue,
      },
      uiLocalization: {
        path: expectedChangedPaths[1],
        value: expectedUiValue,
      },
    },
  };
}

function assertOperationalIndependenceEvidenceMatchesReceipt({
  details,
  evidence,
}) {
  assertOperationalIndependenceResultDetails(details, details.artifactMode);
  const reconstructed = createOperationalIndependenceResultDetails({
    applicationSourceRevision: details.baselineRevision,
    changedRevision: details.changedRevision,
    evidence,
    evidencePath: details.evidencePath,
    expectedApiValue: details.mutations.apiResponse.value,
    expectedChangedPaths: details.changedPaths,
    expectedUiValue: details.mutations.uiLocalization.value,
    mode: details.artifactMode,
  });
  const { durationMs: _durationMs, ...receiptReference } = details;
  assertCondition(
    sameJson(reconstructed, receiptReference),
    'Operational-independence evidence does not match the acceptance execution reference',
  );
  return evidence;
}

function assertOperationalIndependenceResultDetails(details, receiptMode) {
  assertCondition(
    isPlainObject(details),
    'Operational-independence receipt details are missing',
  );
  const expectedKeys = [
    'artifactMode',
    'baselineRevision',
    'changedPaths',
    'changedRevision',
    'durationMs',
    'evidencePath',
    'mutations',
  ];
  assertCondition(
    sameJson(Object.keys(details).sort(), expectedKeys.sort()),
    'Operational-independence receipt details have unknown or missing fields',
  );
  assertCondition(
    details.artifactMode === receiptMode,
    `Operational-independence artifactMode must be ${receiptMode}, found ${String(details.artifactMode)}`,
  );
  assertCondition(
    SOURCE_REVISION_PATTERN.test(details.baselineRevision) &&
      SOURCE_REVISION_PATTERN.test(details.changedRevision) &&
      details.baselineRevision !== details.changedRevision,
    'Operational-independence receipt revisions are invalid or unchanged',
  );
  const expectedChangedPaths = [
    'verticals/inventory/api/index.ts',
    'verticals/inventory/locales/en/inventory.json',
  ];
  assertCondition(
    sameJson(details.changedPaths, expectedChangedPaths),
    'Operational-independence receipt changed paths escape inventory UI/API ownership',
  );
  assertCondition(
    typeof details.evidencePath === 'string' &&
      path.isAbsolute(details.evidencePath),
    'Operational-independence receipt evidence path is invalid',
  );
  assertCondition(
    typeof details.durationMs === 'number' &&
      Number.isFinite(details.durationMs) &&
      details.durationMs >= 0,
    'Operational-independence receipt duration is invalid',
  );
  assertCondition(
    details.mutations?.apiResponse?.path === expectedChangedPaths[0] &&
      details.mutations?.uiLocalization?.path === expectedChangedPaths[1] &&
      typeof details.mutations.apiResponse.value === 'string' &&
      details.mutations.apiResponse.value.length > 0 &&
      typeof details.mutations.uiLocalization.value === 'string' &&
      details.mutations.uiLocalization.value.length > 0,
    'Operational-independence receipt mutations do not bind the real inventory UI and API changes',
  );
  return details;
}

export {
  assertOperationalIndependenceEvidenceMatchesReceipt,
  assertOperationalIndependenceResultDetails,
  assertReleaseAcceptanceProfile,
  assertRuntimeAcceptanceDimension,
  createOperationalIndependenceResultDetails,
  createReleaseArtifactBinding,
  operationalIndependenceEvidencePath,
  operationalIndependenceResultId,
  projectRuntimeArtifactBinding,
  releaseIdentityCoherence,
  rendererReleaseCoherence,
  requiredAcceptanceResultIds,
  requiredAcceptanceResultIdsForMode,
  runtimeAcceptanceDimensions,
  runtimeAcceptanceInvocation,
  runtimeAcceptancePlatforms,
  runtimeIdentityBinding,
};
