import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseManifest } from '../../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import {
  assertOperationalIndependenceEvidenceMatchesReceipt,
  assertOperationalIndependenceResultDetails,
  createReleaseArtifactBinding,
  operationalIndependenceEvidencePath,
  operationalIndependenceResultId,
  projectRuntimeArtifactBinding,
  requiredAcceptanceResultIds,
  requiredAcceptanceResultIdsForMode,
  resolutionParityResultId,
  runtimeIdentityBinding,
} from './acceptance-contract.mjs';
import { authenticatedCompilerTrustExclusions } from './package-cohort.mjs';
import { canonicalJson, sha256 } from './release-age-audit.mjs';

const acceptanceReceiptSchema =
  'bleedingdev.ultramodern.release-acceptance-receipt';
const acceptanceReceiptSchemaVersion = 5;
const acceptanceProfileVersion = 3;
const finalResultStatuses = new Set(['pass', 'fail', 'not-run']);
const digestPattern = /^[a-f0-9]{64}$/u;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function assertExactKeys(value, keys, label) {
  assertCondition(isPlainObject(value), `${label} must be a JSON object`);
  const actual = Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  );
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  assertCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} has unknown or missing fields: expected ${expected.join(
      ', ',
    )}; found ${actual.join(', ')}`,
  );
}

function hasSkippedProof(value) {
  if (value === 'skipped') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasSkippedProof);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.skipped === true || value.status === 'skipped') {
    return true;
  }
  return Object.values(value).some(hasSkippedProof);
}

function pendingSupplyChainBinding(release) {
  return {
    closureSha256: null,
    exceptionPolicySha256: null,
    lockSha256: null,
    registryMetadataSha256: null,
    releaseManifestSha256: release.manifestSha256,
  };
}

function releaseBinding(release) {
  return {
    source: { ...release.source },
    release: { ...release.release },
    manifest: {
      sha256: release.manifestSha256,
      cohortDigest: release.cohortDigest,
      packageCount: release.packages.length,
    },
    artifacts: createReleaseArtifactBinding(release),
  };
}

function createAcceptanceReceipt({
  release,
  mode,
  profile,
  createPackage,
  runtime,
  registry,
  runIdentity,
  now = Date,
}) {
  return {
    schema: acceptanceReceiptSchema,
    schemaVersion: acceptanceReceiptSchemaVersion,
    generatedAt: new now().toISOString(),
    status: 'running',
    passed: false,
    mode,
    binding: {
      ...releaseBinding(release),
      create: {
        sourceName: release.createPackage.sourceName,
        targetName: createPackage.packageName,
        version: createPackage.version,
        exactSpecifier: createPackage.exactSpecifier,
        integrity: release.createPackage.integrity,
      },
      profile: {
        id: profile.id,
        version: acceptanceProfileVersion,
      },
      runIdentity,
      runtimeIdentity: null,
      supplyChain: pendingSupplyChainBinding(release),
    },
    profile: {
      id: profile.id,
      version: acceptanceProfileVersion,
      verticalCount: profile.verticalCount,
      requiredResults: [...requiredAcceptanceResultIdsForMode(mode)],
    },
    runtime,
    registry,
    results: requiredAcceptanceResultIdsForMode(mode).map(id => ({
      id,
      status: 'pending',
    })),
    optionalResults: [],
    error: null,
  };
}

function bindRuntimeIdentityEvidence(receipt, runtimeIdentity) {
  assertExactKeys(
    runtimeIdentity,
    ['node', 'workerd'],
    'Runtime release-identity binding',
  );
  for (const platform of ['node', 'workerd']) {
    assertCondition(
      Array.isArray(runtimeIdentity[platform]) &&
        runtimeIdentity[platform].length === receipt.profile.verticalCount &&
        !hasSkippedProof(runtimeIdentity[platform]),
      `Runtime release-identity binding.${platform} must cover every ERP-10 MicroVertical and must not contain skipped proof`,
    );
  }
  assertCondition(
    receipt.binding.runtimeIdentity === null,
    'Acceptance receipt runtime release identity was already bound',
  );
  receipt.binding.runtimeIdentity = structuredClone(runtimeIdentity);
}

function bindSupplyChainEvidence(receipt, digests) {
  assertExactKeys(
    digests,
    [
      'closureSha256',
      'exceptionPolicySha256',
      'lockSha256',
      'registryMetadataSha256',
      'releaseManifestSha256',
    ],
    'Supply-chain digest binding',
  );
  assertCondition(
    Object.values(receipt.binding.supplyChain).some(value => value === null),
    'Acceptance receipt supply-chain evidence was already bound',
  );
  for (const [name, digest] of Object.entries(digests)) {
    assertCondition(
      digestPattern.test(digest),
      `Supply-chain digest ${name} must be a SHA-256 hex digest`,
    );
  }
  assertCondition(
    digests.releaseManifestSha256 === receipt.binding.manifest.sha256,
    'Supply-chain release manifest digest does not match the receipt manifest',
  );
  receipt.binding.supplyChain = { ...digests };
}

async function recordAcceptanceResult(receipt, id, action) {
  const result = receipt.results.find(candidate => candidate.id === id);
  assertCondition(result, `Unknown acceptance result id: ${id}`);
  assertCondition(
    result.status === 'pending',
    `Acceptance result ${id} was recorded more than once`,
  );
  try {
    const details = await action();
    assertCondition(
      isPlainObject(details) && Object.keys(details).length > 0,
      `Acceptance result ${id} must return non-empty proof details`,
    );
    assertCondition(
      !hasSkippedProof(details),
      `Required acceptance result ${id} returned skipped proof`,
    );
    Object.assign(result, { status: 'pass', details });
    return details;
  } catch (error) {
    Object.assign(result, { status: 'fail', error: errorMessage(error) });
    throw error;
  }
}

function finalizeAcceptanceReceipt(receipt, error) {
  for (const result of receipt.results) {
    if (result.status === 'pending') {
      result.status = 'not-run';
      result.reason = error
        ? 'A preceding required acceptance result failed.'
        : 'The required acceptance result was not executed.';
    }
  }
  const allPassed = receipt.results.every(result => result.status === 'pass');
  receipt.status = allPassed ? 'passed' : 'failed';
  receipt.passed = allPassed;
  receipt.error = error ? errorMessage(error) : null;
  return receipt;
}

function assertTool(tool, label) {
  assertExactKeys(tool, ['integrity', 'name', 'version'], label);
  assertCondition(
    typeof tool.name === 'string' && tool.name.length > 0,
    `${label}.name is missing`,
  );
  for (const field of ['version', 'integrity']) {
    assertCondition(
      tool[field] === null ||
        (typeof tool[field] === 'string' && tool[field].length > 0),
      `${label}.${field} must be a non-empty string or null`,
    );
  }
}

function assertRuntime(runtime) {
  assertExactKeys(
    runtime,
    [
      'arch',
      'node',
      'npm',
      'platform',
      'playwright',
      'pnpm',
      'registry',
      'yaml',
    ],
    'Acceptance receipt runtime',
  );
  for (const field of [
    'arch',
    'node',
    'npm',
    'platform',
    'playwright',
    'pnpm',
  ]) {
    assertCondition(
      typeof runtime[field] === 'string' && runtime[field].length > 0,
      `Acceptance receipt runtime.${field} is missing`,
    );
  }
  assertTool(runtime.registry, 'Acceptance receipt runtime.registry');
  assertTool(runtime.yaml, 'Acceptance receipt runtime.yaml');
}

function assertRuntimeResultDetails(result, receiptMode) {
  const match =
    /^(?<platform>node|workerd)-(?<dimension>ssr|browser-mf|api|backend|backend-driven-ui|failure-isolation|release-identity)$/u.exec(
      result.id,
    );
  if (!match?.groups) {
    return;
  }
  const expectedKeys = [
    'artifactMode',
    'assertionCount',
    'dimension',
    'durationMs',
    'platform',
    ...(match.groups.dimension === 'release-identity' ? ['apps'] : []),
  ];
  assertExactKeys(result.details, expectedKeys, `Runtime result ${result.id}`);
  assertCondition(
    result.details.artifactMode === receiptMode &&
      result.details.platform === match.groups.platform &&
      result.details.dimension === match.groups.dimension,
    `Runtime result ${result.id} is bound to the wrong artifact mode, platform, or dimension`,
  );
  assertCondition(
    Number.isSafeInteger(result.details.assertionCount) &&
      result.details.assertionCount > 0 &&
      typeof result.details.durationMs === 'number' &&
      Number.isFinite(result.details.durationMs) &&
      result.details.durationMs >= 0,
    `Runtime result ${result.id} has invalid assertion count or duration`,
  );
}

function expectedBinding(
  release,
  profileId,
  runIdentity,
  supplyChain,
  runtimeIdentity,
) {
  return {
    ...releaseBinding(release),
    create: {
      sourceName: release.createPackage.sourceName,
      targetName: release.createPackage.targetName,
      version: release.createPackage.version,
      exactSpecifier: `${release.createPackage.targetName}@${release.createPackage.version}`,
      integrity: release.createPackage.integrity,
    },
    profile: { id: profileId, version: acceptanceProfileVersion },
    runIdentity,
    runtimeIdentity,
    supplyChain,
  };
}

// Node and workerd identities exist only where the source lane built and ran
// the workspace.
function assertSourceRuntimeIdentity(receipt, runtimeModuleFederation) {
  assertExactKeys(
    receipt.binding.runtimeIdentity,
    ['node', 'workerd'],
    'Acceptance receipt binding.runtimeIdentity',
  );
  for (const platform of ['node', 'workerd']) {
    assertCondition(
      Array.isArray(receipt.binding.runtimeIdentity[platform]) &&
        receipt.binding.runtimeIdentity[platform].length ===
          receipt.profile.verticalCount &&
        !hasSkippedProof(receipt.binding.runtimeIdentity[platform]),
      `Acceptance receipt runtime identity for ${platform} must cover every ERP-10 MicroVertical without skipped proof`,
    );
    const appIds = [];
    for (const app of receipt.binding.runtimeIdentity[platform]) {
      assertExactKeys(
        app,
        [
          'appId',
          'buildMarker',
          'moduleFederation',
          'releaseVersion',
          'sourceRevision',
        ],
        `Acceptance receipt ${platform} MicroVertical identity`,
      );
      assertCondition(
        typeof app.appId === 'string' &&
          app.appId.length > 0 &&
          typeof app.buildMarker === 'string' &&
          app.buildMarker.length > 0,
        `Acceptance receipt ${platform} MicroVertical identity is incomplete`,
      );
      assertCondition(
        typeof app.sourceRevision === 'string' &&
          app.sourceRevision.length > 0 &&
          app.sourceRevision !== 'workspace' &&
          typeof app.releaseVersion === 'string' &&
          app.releaseVersion.length > 0 &&
          JSON.stringify(app.moduleFederation) ===
            JSON.stringify(runtimeModuleFederation),
        `Acceptance receipt ${platform} MicroVertical identity is stale or mixed`,
      );
      appIds.push(app.appId);
    }
    assertCondition(
      new Set(appIds).size === appIds.length,
      `Acceptance receipt ${platform} MicroVertical identity contains duplicate app ids`,
    );
  }
  runtimeIdentityBinding(
    { apps: receipt.binding.runtimeIdentity.node },
    { apps: receipt.binding.runtimeIdentity.workerd },
  );
  const runtimeIdentityResults = Object.fromEntries(
    ['node', 'workerd'].map(platform => [
      platform,
      receipt.results.find(
        result => result.id === `${platform}-release-identity`,
      )?.details?.apps,
    ]),
  );
  assertCondition(
    JSON.stringify(receipt.binding.runtimeIdentity) ===
      JSON.stringify(runtimeIdentityResults),
    'Acceptance receipt runtime release identity does not match independently recorded Node/workerd results',
  );
}

function assertAcceptanceReceipt(
  receipt,
  {
    release,
    profileId = 'erp-10',
    runIdentity,
    expectedMode,
    requirePassed = true,
  } = {},
) {
  assertExactKeys(
    receipt,
    [
      'binding',
      'error',
      'generatedAt',
      'mode',
      'optionalResults',
      'passed',
      'profile',
      'registry',
      'results',
      'runtime',
      'schema',
      'schemaVersion',
      'status',
    ],
    'Acceptance receipt',
  );
  assertCondition(
    receipt.schema === acceptanceReceiptSchema &&
      receipt.schemaVersion === acceptanceReceiptSchemaVersion,
    `Unknown acceptance receipt schema ${String(receipt.schema)}@${String(
      receipt.schemaVersion,
    )}`,
  );
  assertCondition(
    Number.isFinite(Date.parse(receipt.generatedAt)),
    'Acceptance receipt generatedAt is invalid',
  );
  assertCondition(
    ['source', 'published'].includes(receipt.mode),
    `Acceptance receipt mode is invalid: ${String(receipt.mode)}`,
  );
  if (expectedMode) {
    assertCondition(
      receipt.mode === expectedMode,
      `Acceptance receipt mode must be ${expectedMode}, found ${receipt.mode}`,
    );
  }
  assertExactKeys(
    receipt.profile,
    ['id', 'requiredResults', 'version', 'verticalCount'],
    'Acceptance receipt profile',
  );
  assertCondition(
    receipt.profile.id === profileId,
    `Acceptance receipt profile must be ${profileId}, found ${String(
      receipt.profile.id,
    )}`,
  );
  assertCondition(
    receipt.profile.version === acceptanceProfileVersion &&
      receipt.profile.verticalCount === 10,
    'Acceptance receipt ERP-10 profile identity is invalid',
  );
  assertCondition(
    JSON.stringify(receipt.profile.requiredResults) ===
      JSON.stringify(requiredAcceptanceResultIdsForMode(receipt.mode)),
    'Acceptance receipt required result contract does not match ERP-10',
  );

  assertExactKeys(
    receipt.binding,
    [
      'artifacts',
      'create',
      'manifest',
      'profile',
      'release',
      'runIdentity',
      'runtimeIdentity',
      'source',
      'supplyChain',
    ],
    'Acceptance receipt binding',
  );
  assertExactKeys(
    receipt.binding.source,
    ['commit', 'repository'],
    'Acceptance receipt binding.source',
  );
  assertExactKeys(
    receipt.binding.release,
    ['tag', 'version'],
    'Acceptance receipt binding.release',
  );
  assertExactKeys(
    receipt.binding.manifest,
    ['cohortDigest', 'packageCount', 'sha256'],
    'Acceptance receipt binding.manifest',
  );
  assertExactKeys(
    receipt.binding.artifacts,
    [
      'moduleFederation',
      'packages',
      'runtimeModuleFederation',
      'sourceRevision',
    ],
    'Acceptance receipt binding.artifacts',
  );
  assertCondition(
    Array.isArray(receipt.binding.artifacts.packages) &&
      receipt.binding.artifacts.packages.length > 0,
    'Acceptance receipt exact package cohort is missing',
  );
  for (const item of receipt.binding.artifacts.packages) {
    assertExactKeys(
      item,
      ['integrity', 'targetName', 'version'],
      'Acceptance receipt exact package',
    );
    assertCondition(
      typeof item.targetName === 'string' &&
        item.targetName.length > 0 &&
        typeof item.version === 'string' &&
        item.version.length > 0 &&
        typeof item.integrity === 'string' &&
        item.integrity.startsWith('sha512-'),
      'Acceptance receipt exact package identity is invalid',
    );
  }
  const boundCreatePackage = receipt.binding.artifacts.packages.find(
    item => item.targetName === receipt.binding.create.targetName,
  );
  assertCondition(
    boundCreatePackage?.version === receipt.binding.create.version &&
      boundCreatePackage.integrity === receipt.binding.create.integrity,
    'Acceptance receipt create package differs from the exact package cohort',
  );
  assertCondition(
    Array.isArray(receipt.binding.artifacts.moduleFederation) &&
      receipt.binding.artifacts.moduleFederation.length > 0,
    'Acceptance receipt Module Federation cohort is missing',
  );
  for (const item of receipt.binding.artifacts.moduleFederation) {
    assertExactKeys(
      item,
      ['packageName', 'version'],
      'Acceptance receipt Module Federation package',
    );
    assertCondition(
      typeof item.packageName === 'string' &&
        item.packageName.startsWith('@module-federation/') &&
        typeof item.version === 'string' &&
        item.version.length > 0,
      'Acceptance receipt Module Federation package identity is invalid',
    );
  }
  const runtimeModuleFederation = projectRuntimeArtifactBinding(
    receipt.binding.artifacts,
  ).moduleFederation;
  assertCondition(
    receipt.binding.artifacts.sourceRevision === receipt.binding.source.commit,
    'Acceptance receipt artifact sourceRevision is stale or mixed',
  );
  assertExactKeys(
    receipt.binding.create,
    ['exactSpecifier', 'integrity', 'sourceName', 'targetName', 'version'],
    'Acceptance receipt binding.create',
  );
  assertExactKeys(
    receipt.binding.profile,
    ['id', 'version'],
    'Acceptance receipt binding.profile',
  );
  assertExactKeys(
    receipt.binding.supplyChain,
    [
      'closureSha256',
      'exceptionPolicySha256',
      'lockSha256',
      'registryMetadataSha256',
      'releaseManifestSha256',
    ],
    'Acceptance receipt binding.supplyChain',
  );
  assertCondition(
    typeof receipt.binding.runIdentity === 'string' &&
      receipt.binding.runIdentity.length > 0,
    'Acceptance receipt run identity is missing',
  );
  for (const [name, digest] of Object.entries(receipt.binding.supplyChain)) {
    assertCondition(
      digestPattern.test(digest ?? ''),
      `Acceptance receipt supply-chain digest ${name} is invalid`,
    );
  }
  assertCondition(
    receipt.binding.supplyChain.releaseManifestSha256 ===
      receipt.binding.manifest.sha256,
    'Acceptance receipt supply-chain manifest digest is mixed',
  );
  assertCondition(
    receipt.binding.create.exactSpecifier ===
      `${receipt.binding.create.targetName}@${receipt.binding.create.version}`,
    'Acceptance receipt create package is not exact name@version',
  );
  assertCondition(
    JSON.stringify(receipt.binding.profile) ===
      JSON.stringify({
        id: receipt.profile.id,
        version: receipt.profile.version,
      }),
    'Acceptance receipt profile binding is mixed',
  );

  assertRuntime(receipt.runtime);
  assertExactKeys(
    receipt.registry,
    [
      'cohortPackages',
      'externalDependencies',
      'resolution',
      'sourceCandidateTrustPolicyExclude',
      'url',
    ],
    'Acceptance receipt registry',
  );
  for (const field of [
    'cohortPackages',
    'externalDependencies',
    'resolution',
    'url',
  ]) {
    assertCondition(
      typeof receipt.registry[field] === 'string' &&
        receipt.registry[field].length > 0,
      `Acceptance receipt registry.${field} is missing`,
    );
  }

  const expectedTrustExclusions =
    receipt.mode === 'source'
      ? [
          ...receipt.binding.artifacts.packages.map(
            item => `${item.targetName}@${item.version}`,
          ),
          // Extra selectors require the verified packed generator, never
          // self-declared receipt metadata or an arbitrary caller allowlist.
          ...authenticatedCompilerTrustExclusions(release),
        ].sort()
      : [];
  assertCondition(
    Array.isArray(receipt.registry.sourceCandidateTrustPolicyExclude) &&
      JSON.stringify(receipt.registry.sourceCandidateTrustPolicyExclude) ===
        JSON.stringify(expectedTrustExclusions),
    'Acceptance receipt registry trust exclusions must equal the exact source cohort plus authenticated packed compiler exceptions and be empty after publication',
  );

  const resultIds = Array.isArray(receipt.results)
    ? receipt.results.map(result => result.id)
    : [];
  assertCondition(
    JSON.stringify(resultIds) ===
      JSON.stringify(requiredAcceptanceResultIdsForMode(receipt.mode)),
    'Acceptance receipt must contain every required result exactly once and in ERP-10 order',
  );
  for (const result of receipt.results) {
    assertCondition(
      result.status !== 'skipped',
      `Required acceptance result ${result.id} must not be skipped`,
    );
    assertCondition(
      finalResultStatuses.has(result.status),
      `Required acceptance result ${result.id} has invalid final status ${String(
        result.status,
      )}`,
    );
    if (result.status === 'pass') {
      assertExactKeys(
        result,
        ['details', 'id', 'status'],
        `Result ${result.id}`,
      );
      assertCondition(
        isPlainObject(result.details) &&
          Object.keys(result.details).length > 0 &&
          !hasSkippedProof(result.details),
        `Required acceptance result ${result.id} has empty or skipped proof details`,
      );
      assertRuntimeResultDetails(result, receipt.mode);
      if (result.id === 'dependency-closure-audit') {
        assertExactKeys(
          result.details.advisories,
          ['auditLevel', 'acknowledged'],
          'Acceptance receipt advisories',
        );
        assertCondition(
          result.details.advisories.auditLevel === 'high',
          'Acceptance receipt advisories must audit high and critical vulnerabilities',
        );
        assertCondition(
          Array.isArray(result.details.advisories.acknowledged) &&
            result.details.advisories.acknowledged.length === 0,
          'ERP-10 acceptance receipt must contain an empty acknowledged advisory list',
        );
        const identities = result.details.closureIdentities;
        assertCondition(
          Array.isArray(identities) &&
            identities.length > 0 &&
            sha256(canonicalJson(identities)) ===
              receipt.binding.supplyChain.closureSha256,
          'Acceptance receipt closure identities do not match the bound closureSha256',
        );
      }
      if (result.id === 'vertical-additions') {
        const files = result.details.workspaceFiles;
        assertCondition(
          Array.isArray(files) &&
            files.length > 0 &&
            sha256(canonicalJson(files)) === result.details.workspaceSha256,
          'Acceptance receipt scaffold files do not match its workspaceSha256',
        );
      }
      if (result.id === resolutionParityResultId) {
        assertCondition(
          result.details.closureSha256 ===
            receipt.binding.supplyChain.closureSha256 &&
            result.details.workspaceSha256 ===
              receipt.results.find(item => item.id === 'vertical-additions')
                ?.details?.workspaceSha256,
          'Acceptance receipt resolution parity is not bound to its own closure and scaffold',
        );
      }
      if (result.id === operationalIndependenceResultId) {
        assertOperationalIndependenceResultDetails(
          result.details,
          receipt.mode,
        );
      }
    }
  }
  if (receipt.mode === 'source') {
    assertSourceRuntimeIdentity(receipt, runtimeModuleFederation);
  } else {
    // The published lane runs nothing, so it has no runtime identity to bind.
    assertCondition(
      receipt.binding.runtimeIdentity === null,
      'Published acceptance receipt must not bind a runtime identity; the published lane proves resolution only',
    );
  }
  assertCondition(
    Array.isArray(receipt.optionalResults) &&
      receipt.optionalResults.length === 0,
    'ERP-10 acceptance receipt must not mix optional results into the profile',
  );

  if (runIdentity) {
    assertCondition(
      receipt.binding.runIdentity === runIdentity,
      `Acceptance receipt run identity must be ${runIdentity}, found ${receipt.binding.runIdentity}`,
    );
  }
  if (release) {
    assertCondition(
      JSON.stringify(receipt.binding) ===
        JSON.stringify(
          expectedBinding(
            release,
            profileId,
            runIdentity ?? receipt.binding.runIdentity,
            receipt.binding.supplyChain,
            receipt.binding.runtimeIdentity,
          ),
        ),
      'Acceptance receipt binding does not match the strict release manifest',
    );
  }
  if (requirePassed) {
    assertCondition(
      receipt.status === 'passed' &&
        receipt.passed === true &&
        receipt.error === null,
      'Acceptance receipt is not passed',
    );
    assertCondition(
      receipt.results.every(result => result.status === 'pass'),
      'Acceptance receipt has a required result that did not pass',
    );
  }
  return receipt;
}

// The scaffold and closure a source receipt accepted, as the published lane
// compares against them. Only meaningful on a receipt assertAcceptanceReceipt
// verified as a passed source receipt.
function acceptedResolution(receipt) {
  assertCondition(
    receipt.mode === 'source' && receipt.passed === true,
    'Only a passed source acceptance receipt carries an accepted resolution',
  );
  const details = id =>
    receipt.results.find(result => result.id === id).details;
  const { workspaceFiles, workspaceSha256 } = details('vertical-additions');
  return {
    closureIdentities: details('dependency-closure-audit').closureIdentities,
    closureSha256: receipt.binding.supplyChain.closureSha256,
    workspaceFiles,
    workspaceSha256,
  };
}

function readAcceptanceReceipt(receiptPath) {
  const resolved = path.resolve(receiptPath);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  assertCondition(
    stat?.isFile() && !stat.isSymbolicLink(),
    `Acceptance receipt is missing or is not a regular file: ${resolved}`,
  );
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(
      `Acceptance receipt is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  assertCondition(
    stat?.isFile() && !stat.isSymbolicLink(),
    `${label} is missing or is not a regular file: ${resolved}`,
  );
  try {
    return {
      path: resolved,
      value: JSON.parse(fs.readFileSync(resolved, 'utf8')),
    };
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function verifyAcceptanceReceiptOperationalEvidence(receipt, receiptPath) {
  const details = receipt.results?.find(
    result => result.id === operationalIndependenceResultId,
  )?.details;
  assertCondition(
    isPlainObject(details),
    'Operational-independence acceptance receipt details are missing',
  );
  assertCondition(
    path.resolve(details.evidencePath) ===
      operationalIndependenceEvidencePath(receiptPath),
    'Operational-independence evidence path is not the receipt-owned raw evidence path',
  );
  const evidenceFile = readRegularJson(
    details.evidencePath,
    'Operational-independence evidence',
  );
  return assertOperationalIndependenceEvidenceMatchesReceipt({
    details,
    evidence: evidenceFile.value,
  });
}

function parseVerificationArgs(argv) {
  const values = new Map();
  let verify = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--verify') {
      if (verify) {
        throw new Error('Duplicate argument: --verify');
      }
      verify = true;
      continue;
    }
    if (!['--manifest', '--receipt', '--run-identity'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (values.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }
  for (const argument of ['--manifest', '--receipt', '--run-identity']) {
    if (!values.has(argument)) {
      throw new Error(`${argument} is required`);
    }
  }
  if (!verify) {
    throw new Error('--verify is required');
  }
  return {
    manifestPath: values.get('--manifest'),
    receiptPath: values.get('--receipt'),
    runIdentity: values.get('--run-identity'),
  };
}

function verifyAcceptanceReceiptCli(argv = process.argv.slice(2)) {
  const options = parseVerificationArgs(argv);
  const release = readReleaseManifest({ manifestPath: options.manifestPath });
  const receipt = readAcceptanceReceipt(options.receiptPath);
  assertAcceptanceReceipt(receipt, {
    release,
    profileId: 'erp-10',
    runIdentity: options.runIdentity,
    expectedMode: 'source',
  });
  verifyAcceptanceReceiptOperationalEvidence(receipt, options.receiptPath);
  process.stdout.write(
    `Verified ERP-10 acceptance receipt for ${release.release.version}.\n`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    verifyAcceptanceReceiptCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

export {
  acceptedResolution,
  assertAcceptanceReceipt,
  bindRuntimeIdentityEvidence,
  bindSupplyChainEvidence,
  createAcceptanceReceipt,
  finalizeAcceptanceReceipt,
  readAcceptanceReceipt,
  recordAcceptanceResult,
  requiredAcceptanceResultIds,
  requiredAcceptanceResultIdsForMode,
  verifyAcceptanceReceiptOperationalEvidence,
};
