import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mergePnpmLockfileDocuments } from '../../lib/pnpm-lockfile-documents.mjs';
import { resolveCreatePackage } from './package-cohort.mjs';
import { run } from './process.mjs';

const YAML_NAME = 'js-yaml';
const YAML_VERSION = '5.5.0';
const YAML_SPECIFIER = `${YAML_NAME}@${YAML_VERSION}`;
const YAML_INTEGRITY =
  'sha512-paNr4LFIFPjeeSmwNYdrb8FafLLG/Cr2Af3GjbsHJ5CxIjH4r0c2emlmRdAtpPAieP1gRVzk6buBbVP5gBMGAg==';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const releaseAgePolicySchema = 'bleedingdev.ultramodern.release-age-exceptions';
const releaseAgePolicySchemaVersion = 2;
const minimumReleaseAgeMinutes = 1440;
const dependencyBlocks = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'packageManagerDependencies',
  'configDependencies',
]);
const exactVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const exactPackageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u;
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function compareCodeUnits(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  assertCondition(isPlainObject(value), `${label} must be a JSON object`);
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...expectedKeys].sort(compareCodeUnits);
  assertCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} has unknown or missing fields: expected ${expected.join(
      ', ',
    )}; found ${actual.join(', ')}`,
  );
}

function assertNonEmptyString(value, label) {
  assertCondition(
    typeof value === 'string' && value !== '' && value.trim() === value,
    `${label} must be a non-empty trimmed string`,
  );
}

function canonicalValue(value, label = 'value') {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    assertCondition(Number.isFinite(value), `${label} must be finite`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      canonicalValue(item, `${label}[${index}]`),
    );
  }
  assertPlainObject(value, label);
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map(key => [key, canonicalValue(value[key], `${label}.${key}`)]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runYamlCli(args, { input, spawnImpl = spawnSync } = {}) {
  const usesStdin = input !== undefined;
  const result = spawnImpl('pnpm', ['dlx', YAML_SPECIFIER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    ...(usesStdin ? { input } : {}),
    maxBuffer: 64 * 1024 * 1024,
    stdio: [usesStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(
      `Pinned YAML parser failed to start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Pinned YAML parser exited ${String(result.status)}: ${String(
        result.stderr,
      ).trim()}`,
    );
  }
  return result.stdout;
}

function parseYaml(source, spawnImpl = spawnSync) {
  const output = runYamlCli([], { input: source, spawnImpl });
  try {
    return mergePnpmLockfileDocuments(JSON.parse(output));
  } catch (error) {
    throw new Error(
      `Pinned YAML parser returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseYamlFile(
  filePath,
  spawnImpl = spawnSync,
  { singleDocument = false } = {},
) {
  const output = runYamlCli([filePath], { spawnImpl });
  try {
    const value = JSON.parse(output);
    assertCondition(
      !singleDocument || !Array.isArray(value),
      `Expected one YAML document in ${filePath}`,
    );
    return mergePnpmLockfileDocuments(value);
  } catch (error) {
    throw new Error(
      `Pinned YAML parser returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertYamlDistributionIntegrity(runImpl = run) {
  const output = runImpl(
    'npm',
    [
      'view',
      YAML_SPECIFIER,
      'dist.integrity',
      '--json',
      '--registry',
      NPM_REGISTRY,
    ],
    { stdio: 'pipe' },
  );
  let integrity;
  try {
    integrity = JSON.parse(output);
  } catch {
    integrity = output;
  }
  assertCondition(
    integrity === YAML_INTEGRITY,
    `YAML ${YAML_VERSION} integrity mismatch: expected ${YAML_INTEGRITY}, found ${String(
      integrity,
    )}`,
  );
}

function isHttpsTarballLocator(value) {
  if (
    !value.startsWith('https://') ||
    /[\s()]/u.test(value) ||
    !URL.canParse(value)
  )
    return false;
  const url = new URL(value);
  return (
    url.href === value &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  );
}

function splitPeerContext(locator) {
  const peerStart = locator.indexOf('(');
  if (peerStart === -1) {
    return { base: locator, peers: [] };
  }
  const context = locator.slice(peerStart);
  const segments = [];
  let start = -1;
  let depth = 0;
  for (let index = 0; index < context.length; index += 1) {
    const character = context[index];
    if (character === '(') {
      if (depth === 0) {
        start = index + 1;
      }
      depth += 1;
      continue;
    }
    if (character !== ')' || depth === 0) {
      if (depth === 0) {
        return { unresolved: locator };
      }
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      const segment = context.slice(start, index);
      if (segment === '') {
        return { unresolved: locator };
      }
      segments.push(segment);
      start = -1;
    }
  }
  if (depth !== 0 || start !== -1) {
    return { unresolved: locator };
  }

  const peers = [];
  for (const segment of segments) {
    if (
      /^patch_hash=[a-f0-9]{32,128}$/u.test(segment) ||
      /^[a-f0-9]{32,128}$/u.test(segment)
    ) {
      continue;
    }
    const peer = parsePackageKey(segment);
    if (!peer || isHttpsTarballLocator(peer.version)) {
      return { unresolved: locator };
    }
    peers.push(peer);
  }
  return { base: locator.slice(0, peerStart), peers };
}

function parseFullPackageLocator(rawLocator) {
  const locator = rawLocator.replace(/^\//u, '');
  const tarballSeparator = locator.indexOf('@https://');
  const separator =
    tarballSeparator > 0 ? tarballSeparator : locator.lastIndexOf('@');
  if (separator <= 0) {
    return undefined;
  }
  const name = locator.slice(0, separator);
  const version = locator.slice(separator + 1);
  if (
    !exactPackageNamePattern.test(name) ||
    (!exactVersionPattern.test(version) && !isHttpsTarballLocator(version))
  ) {
    return undefined;
  }
  return { name, version };
}

function parsePackageKey(rawKey) {
  assertNonEmptyString(rawKey, 'pnpm package key');
  const peerContext = splitPeerContext(rawKey.replace(/^\//u, ''));
  if (peerContext.unresolved) {
    return undefined;
  }
  const { base, peers } = peerContext;
  const identity = parseFullPackageLocator(base);
  return identity ? { ...identity, peers } : undefined;
}

function localDependencyVersion(value) {
  return /^(?:file|link|workspace):/u.test(value);
}

function aliasNameFromSpecifier(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('npm:')) {
    return undefined;
  }
  const alias = specifier.slice('npm:'.length);
  const separator = alias.lastIndexOf('@');
  return separator > 0 ? alias.slice(0, separator) : undefined;
}

function dependencyIdentity(dependencyName, rawValue) {
  const descriptor = isPlainObject(rawValue) ? rawValue : undefined;
  const value = descriptor?.version ?? rawValue;
  if (
    typeof value !== 'string' ||
    value === '' ||
    localDependencyVersion(value)
  ) {
    return undefined;
  }

  const npmAliasValue = value.startsWith('npm:')
    ? value.slice('npm:'.length)
    : value;
  const peerContext = splitPeerContext(npmAliasValue);
  if (peerContext.unresolved) {
    return { unresolved: value };
  }
  const { base, peers } = peerContext;
  if (
    isHttpsTarballLocator(base) &&
    exactPackageNamePattern.test(dependencyName)
  ) {
    return { name: dependencyName, version: base, peers };
  }
  const full = parseFullPackageLocator(base);
  if (full) {
    return { ...full, peers };
  }
  if (!exactVersionPattern.test(base)) {
    return { unresolved: value };
  }
  const aliasName = aliasNameFromSpecifier(descriptor?.specifier);
  return { name: aliasName ?? dependencyName, version: base, peers };
}

function identityKey(identity) {
  const packageName = identity.name ?? identity.package ?? identity.targetName;
  return `${packageName}@${identity.version}`;
}

function sortedEntries(value) {
  return Object.entries(isPlainObject(value) ? value : {}).sort(
    ([left], [right]) => compareCodeUnits(left, right),
  );
}

function dependencyEdges(value) {
  const edges = [];
  for (const blockName of dependencyBlocks) {
    for (const [dependencyName, descriptor] of sortedEntries(
      value?.[blockName],
    )) {
      edges.push({ blockName, dependencyName, descriptor });
    }
  }
  return edges;
}

function buildDependencyClosure(lock) {
  assertPlainObject(lock, 'pnpm lockfile');
  assertCondition(
    typeof lock.lockfileVersion === 'string' ||
      typeof lock.lockfileVersion === 'number',
    'pnpm lockfileVersion is missing',
  );
  assertPlainObject(lock.importers, 'pnpm lockfile importers');
  assertPlainObject(lock.packages, 'pnpm lockfile packages');
  assertPlainObject(lock.snapshots, 'pnpm lockfile snapshots');

  const metadataByIdentity = new Map();
  for (const [packageKey, packageRecord] of sortedEntries(lock.packages)) {
    const identity = parsePackageKey(packageKey);
    if (!identity) {
      continue;
    }
    const integrity = packageRecord?.resolution?.integrity;
    const key = identityKey(identity);
    if (metadataByIdentity.has(key)) {
      assertCondition(
        metadataByIdentity.get(key).integrity === integrity,
        `pnpm lock contains conflicting integrity values for ${key}`,
      );
      continue;
    }
    metadataByIdentity.set(key, {
      name: identity.name,
      version: identity.version,
      integrity,
    });
  }

  const packageRecords = new Map(sortedEntries(lock.packages));
  const snapshotRecords = new Map(sortedEntries(lock.snapshots));
  const packageRecordsByIdentity = new Map();
  for (const [packageKey, packageRecord] of packageRecords) {
    const identity = parsePackageKey(packageKey);
    if (!identity) {
      continue;
    }
    const key = identityKey(identity);
    packageRecordsByIdentity.set(key, [
      ...(packageRecordsByIdentity.get(key) ?? []),
      packageRecord,
    ]);
  }

  const nodes = new Map();
  const nodeIdsByIdentity = new Map();
  for (const nodeId of [...snapshotRecords.keys()].sort(compareCodeUnits)) {
    const identity = parsePackageKey(nodeId);
    if (!identity) {
      continue;
    }
    const key = identityKey(identity);
    const node = {
      id: nodeId,
      identity,
      packageRecords: packageRecordsByIdentity.get(key) ?? [],
      snapshotRecord: snapshotRecords.get(nodeId),
    };
    nodes.set(nodeId, node);
    const nodeIds = nodeIdsByIdentity.get(key) ?? [];
    nodeIds.push(nodeId);
    nodeIdsByIdentity.set(key, nodeIds);
  }

  const queue = [];
  const shortestNodePaths = new Map();
  const unresolved = [];

  function recordUnresolved(identity, pathParts, reason) {
    unresolved.push({
      package: identity ? identityKey(identity) : undefined,
      path: pathParts,
      reason,
    });
  }

  function enqueueIdentity(identity, pathParts) {
    const key = identityKey(identity);
    const targetNodeIds = nodeIdsByIdentity.get(key);
    if (!targetNodeIds || targetNodeIds.length === 0) {
      recordUnresolved(identity, [...pathParts, key], 'missing lock snapshot');
      return;
    }
    for (const nodeId of targetNodeIds) {
      const nextPath = [...pathParts, key];
      const currentPath = shortestNodePaths.get(nodeId);
      if (currentPath && currentPath.length <= nextPath.length) {
        continue;
      }
      shortestNodePaths.set(nodeId, nextPath);
      queue.push(nodeId);
    }
  }

  for (const [importerName, importer] of sortedEntries(lock.importers)) {
    for (const edge of dependencyEdges(importer)) {
      const identity = dependencyIdentity(edge.dependencyName, edge.descriptor);
      if (!identity) {
        continue;
      }
      const rootPath = [`importer:${importerName}`];
      if (identity.unresolved) {
        recordUnresolved(
          undefined,
          [...rootPath, edge.dependencyName],
          `non-exact dependency locator ${identity.unresolved}`,
        );
        continue;
      }
      enqueueIdentity(identity, rootPath);
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    const node = nodes.get(nodeId);
    const nodePath = shortestNodePaths.get(nodeId);
    if (node.packageRecords.length === 0) {
      recordUnresolved(node.identity, nodePath, 'missing lock package');
      continue;
    }
    for (const peer of node.identity.peers) {
      enqueueIdentity(peer, nodePath);
    }
    for (const record of [...node.packageRecords, node.snapshotRecord]) {
      for (const edge of dependencyEdges(record)) {
        const identity = dependencyIdentity(
          edge.dependencyName,
          edge.descriptor,
        );
        if (!identity) {
          continue;
        }
        if (identity.unresolved) {
          recordUnresolved(
            undefined,
            [...nodePath, edge.dependencyName],
            `non-exact dependency locator ${identity.unresolved}`,
          );
          continue;
        }
        enqueueIdentity(identity, nodePath);
      }
    }
  }

  const shortestIdentityPaths = new Map();
  for (const [nodeId, nodePath] of shortestNodePaths) {
    const key = identityKey(nodes.get(nodeId).identity);
    const current = shortestIdentityPaths.get(key);
    if (!current || nodePath.length < current.length) {
      shortestIdentityPaths.set(key, nodePath);
    }
  }

  const tarballs = [];
  const closure = [...shortestIdentityPaths.entries()]
    .map(([key, packagePath]) => {
      const metadata = metadataByIdentity.get(key);
      if (!metadata || !integrityPattern.test(metadata.integrity ?? '')) {
        recordUnresolved(
          metadata,
          packagePath,
          'missing exact SHA-512 lock integrity',
        );
        return undefined;
      }
      if (isHttpsTarballLocator(metadata.version)) {
        let version;
        for (const record of packageRecordsByIdentity.get(key) ?? []) {
          assertCondition(
            record?.resolution?.tarball === metadata.version &&
              typeof record.version === 'string' &&
              exactVersionPattern.test(record.version) &&
              (version === undefined || version === record.version),
            `pnpm lockfile package ${key} has uncertain tarball identity.`,
          );
          version = record.version;
        }
        tarballs.push({
          name: metadata.name,
          version,
          url: metadata.version,
          integrity: metadata.integrity,
          path: packagePath,
        });
        return undefined;
      }
      return { ...metadata, path: packagePath };
    })
    .filter(Boolean)
    .sort((left, right) =>
      compareCodeUnits(identityKey(left), identityKey(right)),
    );

  unresolved.sort((left, right) =>
    compareCodeUnits(canonicalJson(left), canonicalJson(right)),
  );
  return {
    closure,
    tarballs,
    importerCount: Object.keys(lock.importers).length,
    lockfileVersion: String(lock.lockfileVersion),
    unresolved,
  };
}

// What a lane resolved, reduced to the identity that pins the bytes it
// installs. Dependency paths are left out on purpose: two lanes that resolve
// the same packages yield the same digest however pnpm reached them.
function closureResolution({ closure, tarballs }) {
  const closureIdentities = [...closure, ...tarballs]
    .map(({ name, version, integrity }) => ({ name, version, integrity }))
    .sort(
      (left, right) =>
        compareCodeUnits(identityKey(left), identityKey(right)) ||
        compareCodeUnits(left.integrity, right.integrity),
    );
  return {
    closureIdentities,
    closureSha256: sha256(canonicalJson(closureIdentities)),
  };
}

function formatUnresolvedCandidates(unresolved) {
  return unresolved
    .slice(0, 20)
    .map(item => {
      const dependencyPath = item.path.join(' -> ');
      return `- ${item.package ?? 'unknown package'}: ${item.reason}; path ${dependencyPath}`;
    })
    .join('\n');
}

function emptyExceptionPolicy() {
  return {
    schema: releaseAgePolicySchema,
    schemaVersion: releaseAgePolicySchemaVersion,
    entries: [],
  };
}

function canonicalInstant(value, label) {
  assertNonEmptyString(value, label);
  const timestamp = Date.parse(value);
  assertCondition(
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value,
    `${label} must be a canonical ISO-8601 UTC timestamp`,
  );
  return timestamp;
}

function assertImmutableEvidenceUri(value, label) {
  assertNonEmptyString(value, label);
  if (/^urn:sha256:[a-f0-9]{64}$/u.test(value)) {
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an immutable evidence URI`);
  }
  if (parsed.protocol === 'ipfs:') {
    assertCondition(
      parsed.hostname.length > 0 && parsed.search === '' && parsed.hash === '',
      `${label} must be an immutable evidence URI without query or fragment`,
    );
    return;
  }
  const immutablePathSegment = parsed.pathname
    .split('/')
    .some(segment => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(segment));
  assertCondition(
    parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      immutablePathSegment,
    `${label} must be HTTPS and content-addressed by a full commit or SHA-256 path segment`,
  );
}

function validateExceptionPolicy(policy, now = new Date()) {
  assertExactKeys(
    policy,
    ['entries', 'schema', 'schemaVersion'],
    'Release-age exception policy',
  );
  assertCondition(
    policy.schema === releaseAgePolicySchema &&
      policy.schemaVersion === releaseAgePolicySchemaVersion,
    `Unknown release-age exception policy schema ${String(
      policy.schema,
    )}@${String(policy.schemaVersion)}`,
  );
  assertCondition(
    Array.isArray(policy.entries),
    'Release-age exception policy entries must be an array',
  );
  const normalized = [];
  const identities = new Set();
  const nowMs = now.getTime();
  assertCondition(
    Number.isFinite(nowMs),
    'Release-age exception policy validation requires a valid current time',
  );
  for (const [index, entry] of policy.entries.entries()) {
    const label = `Release-age exception policy entries[${index}]`;
    assertExactKeys(
      entry,
      [
        'approvedBy',
        'evidence',
        'expiresAt',
        'integrity',
        'package',
        'reviewedAt',
        'version',
      ],
      label,
    );
    for (const field of [
      'approvedBy',
      'expiresAt',
      'integrity',
      'package',
      'reviewedAt',
      'version',
    ]) {
      assertNonEmptyString(entry[field], `${label}.${field}`);
    }
    assertCondition(
      exactPackageNamePattern.test(entry.package),
      `${label}.package must be one exact npm package name without a range, tag, or glob`,
    );
    assertCondition(
      exactVersionPattern.test(entry.version),
      `${label}.version must be an exact semantic version`,
    );
    assertCondition(
      integrityPattern.test(entry.integrity),
      `${label}.integrity must be a SHA-512 SRI value`,
    );
    assertCondition(
      !/^(?:unknown|todo|tbd|placeholder)$/iu.test(entry.approvedBy),
      `${label}.approvedBy must identify a real reviewer`,
    );
    const reviewedAtMs = canonicalInstant(
      entry.reviewedAt,
      `${label}.reviewedAt`,
    );
    const expiresAtMs = canonicalInstant(entry.expiresAt, `${label}.expiresAt`);
    assertCondition(
      reviewedAtMs <= nowMs,
      `${label}.reviewedAt must not be in the future`,
    );
    assertCondition(
      expiresAtMs > reviewedAtMs,
      `${label}.expiresAt must be after review`,
    );
    assertExactKeys(entry.evidence, ['sha256', 'uri'], `${label}.evidence`);
    assertImmutableEvidenceUri(entry.evidence.uri, `${label}.evidence.uri`);
    assertCondition(
      sha256Pattern.test(entry.evidence.sha256),
      `${label}.evidence.sha256 must be a lowercase SHA-256 digest`,
    );
    const key = identityKey(entry);
    assertCondition(
      !identities.has(key),
      `Release-age exception policy contains duplicate ${key}`,
    );
    identities.add(key);
    normalized.push({
      approvedBy: entry.approvedBy,
      evidence: { ...entry.evidence },
      expiresAt: entry.expiresAt,
      integrity: entry.integrity,
      package: entry.package,
      reviewedAt: entry.reviewedAt,
      version: entry.version,
    });
  }
  normalized.sort((left, right) =>
    compareCodeUnits(identityKey(left), identityKey(right)),
  );
  return {
    schema: releaseAgePolicySchema,
    schemaVersion: releaseAgePolicySchemaVersion,
    entries: normalized,
  };
}

function readExceptionPolicy(policyPath, now = new Date()) {
  if (!policyPath) {
    return validateExceptionPolicy(emptyExceptionPolicy(), now);
  }
  const resolved = path.resolve(policyPath);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  assertCondition(
    stat?.isFile() && !stat.isSymbolicLink(),
    `Release-age exception policy is missing or is not a regular file: ${resolved}`,
  );
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(
      `Release-age exception policy is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return validateExceptionPolicy(policy, now);
}

function readActiveReleaseAgeExceptionSelectors(
  policyPath,
  { now = new Date() } = {},
) {
  const policy = readExceptionPolicy(policyPath, now);
  const nowMs = now.getTime();
  return policy.entries
    .filter(entry => Date.parse(entry.expiresAt) > nowMs)
    .map(identityKey)
    .sort(compareCodeUnits);
}

// The one release-age exemption set. Every lane that installs a release —
// source acceptance, published acceptance, the Tractor rehearsal and the
// published Tractor run — passes exactly this set to pnpm, so the source
// rehearsal reproduces the published install. There is deliberately no lane
// parameter: a lane-specific set is how the published lanes of
// 3.9.0-ultramodern.13 missed the sidecars the source lane exempted.
function releaseAgeExemptions(release, { policyPath, now = new Date() } = {}) {
  assertCondition(
    typeof policyPath === 'string' && policyPath.length > 0,
    'Release-age exemptions require the reviewed exception policy path (pass --release-age-policy)',
  );
  assertCondition(
    Array.isArray(release?.packages) && release.packages.length > 0,
    'Strict release manifest package observations are required for release-age exclusions',
  );
  const version = release.release?.version;
  const cohort = release.packages.map((item, index) => {
    assertCondition(
      item?.version === version && typeof item.targetName === 'string',
      `Strict release manifest package observation ${index} must bind targetName to release version ${String(version)}`,
    );
    return `${item.targetName}@${item.version}`;
  });
  // Sidecars are first-party @bleedingdev packages the release publishes just
  // before the cohort, so every lane exempts exactly the manifest's versions.
  const sidecars = release.sidecars?.packages ?? [];
  assertCondition(
    Array.isArray(sidecars),
    'Release manifest sidecar observations must be an array',
  );
  const sidecarSelectors = sidecars.map((item, index) => {
    assertCondition(
      typeof item?.name === 'string' && typeof item.version === 'string',
      `Verified sidecar observation ${index} must bind an exact name and version`,
    );
    return `${item.name}@${item.version}`;
  });
  const releaseSelectors = validateExactExclusions(
    [...cohort, ...sidecarSelectors].sort(compareCodeUnits),
    'Acceptance command release-age exclusions',
  );
  return validateExactExclusions(
    [
      ...new Set([
        ...releaseSelectors,
        ...readActiveReleaseAgeExceptionSelectors(policyPath, { now }),
        ...authenticatedBootstrapExclusions(release),
      ]),
    ].sort(compareCodeUnits),
    'Acceptance command release-age exclusions',
  );
}

function authenticatedBootstrapExclusions(release) {
  // Use the same authenticated packed producer as pnpm dlx. A release without
  // a producer grants no compiler exceptions; malformed producer metadata
  // must fail rather than infer exceptions from arbitrary dependencies.
  return release.createPackage
    ? resolveCreatePackage(release).bootstrapReleaseAgePolicy
        .minimumReleaseAgeExclude
    : [];
}

function packumentUrl(registryUrl, packageName) {
  const base = new URL(registryUrl);
  assertCondition(
    ['http:', 'https:'].includes(base.protocol),
    `Registry URL must use HTTP or HTTPS: ${registryUrl}`,
  );
  const encodedName = packageName.startsWith('@')
    ? packageName.replace('/', '%2f')
    : encodeURIComponent(packageName);
  return new URL(encodedName, base);
}

const registryFetchAttempts = 3;
const registryFetchRetryDelayMs = 250;

function isTransientRegistryStatus(status) {
  return status === 429 || status >= 500;
}

async function fetchRegistryResponse(fetchImpl, url) {
  let lastError;
  for (let attempt = 0; attempt < registryFetchAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
      });
      if (
        response.ok ||
        !isTransientRegistryStatus(response.status) ||
        attempt === registryFetchAttempts - 1
      ) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === registryFetchAttempts - 1) {
        throw error;
      }
    }
    await new Promise(resolve =>
      setTimeout(resolve, registryFetchRetryDelayMs * 2 ** attempt),
    );
  }
  throw lastError;
}

async function fetchRegistryMetadata(
  packages,
  { registryUrlFor, fetchImpl = fetch, now = new Date(), concurrency = 16 },
) {
  assertCondition(
    typeof registryUrlFor === 'function',
    'Registry metadata fetch requires a registryUrlFor resolver',
  );
  const results = new Array(packages.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < packages.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = packages[index];
      const specifier = identityKey(item);
      let response;
      try {
        response = await fetchRegistryResponse(
          fetchImpl,
          packumentUrl(registryUrlFor(item.name), item.name),
        );
      } catch (error) {
        throw new Error(
          `Registry metadata is uncertain for ${specifier} (${item.path.join(
            ' -> ',
          )}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      assertCondition(
        response.ok,
        `Registry metadata is uncertain for ${specifier} (${item.path.join(
          ' -> ',
        )}): HTTP ${response.status}`,
      );
      let packument;
      try {
        packument = await response.json();
      } catch (error) {
        throw new Error(
          `Registry metadata is invalid JSON for ${specifier}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const integrity = packument?.versions?.[item.version]?.dist?.integrity;
      assertCondition(
        integrityPattern.test(integrity ?? ''),
        `Registry metadata integrity is missing for ${specifier}`,
      );
      assertCondition(
        integrity === item.integrity,
        `Registry metadata integrity mismatch for ${specifier}: lock has ${item.integrity}, registry has ${integrity}`,
      );
      const publishedAt = packument?.time?.[item.version];
      const publishedAtMs = Date.parse(publishedAt);
      assertCondition(
        typeof publishedAt === 'string' && Number.isFinite(publishedAtMs),
        `Registry publication time is missing or invalid for ${specifier}`,
      );
      const ageMinutes = (now.getTime() - publishedAtMs) / 60_000;
      assertCondition(
        Number.isFinite(ageMinutes) && ageMinutes >= 0,
        `Registry publication time is in the future for ${specifier}`,
      );
      results[index] = {
        name: item.name,
        version: item.version,
        integrity,
        publishedAt: new Date(publishedAtMs).toISOString(),
        ageMinutes,
        path: item.path,
      };
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(packages.length, 1)) },
      () => worker(),
    ),
  );
  return results;
}

function formatImmaturePackage(item) {
  const matureAt = new Date(
    Date.parse(item.publishedAt) + minimumReleaseAgeMinutes * 60_000,
  ).toISOString();
  const waitHours = (minimumReleaseAgeMinutes - item.ageMinutes) / 60;
  return `- ${identityKey(item)} published ${item.publishedAt}, mature at ${matureAt} (wait ${waitHours.toFixed(
    1,
  )}h); path ${item.path.join(' -> ')}`;
}

function approveImmaturePackages({ metadata, policy, release, now }) {
  const policyByIdentity = new Map(
    policy.entries.map(entry => [identityKey(entry), entry]),
  );
  const releaseByIdentity = new Map(
    release.packages.map(item => [`${item.targetName}@${item.version}`, item]),
  );
  const sidecars = new Map(
    (release.sidecars?.packages ?? []).map(item => [
      `${item.name}@${item.version}`,
      item,
    ]),
  );
  const exactExclusions = [];
  const approvals = [];
  const rejected = [];
  const matchedPolicyEntries = new Set();
  for (const item of metadata) {
    const key = identityKey(item);
    const sidecar = sidecars.get(key);
    assertCondition(
      !sidecar || sidecar.integrity === item.integrity,
      `Sidecar ${key} registry integrity differs from authenticated release manifest`,
    );
    const exception = policyByIdentity.get(key);
    if (exception?.integrity === item.integrity) {
      matchedPolicyEntries.add(key);
    }
    if (item.ageMinutes >= minimumReleaseAgeMinutes) {
      continue;
    }
    const releaseItem = releaseByIdentity.get(key);
    if (releaseItem?.integrity === item.integrity) {
      exactExclusions.push(key);
      approvals.push({
        authority: 'strict-release-manifest',
        package: item.name,
        version: item.version,
        integrity: item.integrity,
        source: {
          cohortDigest: release.cohortDigest,
          commit: release.source.commit,
          manifestSha256: release.manifestSha256,
          repository: release.source.repository,
          sourceName: releaseItem.sourceName,
          targetName: releaseItem.targetName,
        },
      });
      continue;
    }
    if (sidecar?.integrity === item.integrity) {
      exactExclusions.push(key);
      approvals.push({
        authority: 'strict-release-manifest-sidecar',
        package: item.name,
        version: item.version,
        integrity: item.integrity,
        source: {
          commit: release.source.commit,
          manifestSha256: release.manifestSha256,
        },
      });
      continue;
    }
    if (
      exception?.integrity === item.integrity &&
      Date.parse(exception.expiresAt) > now.getTime()
    ) {
      exactExclusions.push(key);
      approvals.push({
        authority: 'external-release-age-policy',
        package: exception.package,
        version: exception.version,
        integrity: exception.integrity,
        approvedBy: exception.approvedBy,
        reviewedAt: exception.reviewedAt,
        expiresAt: exception.expiresAt,
        evidence: { ...exception.evidence },
      });
      continue;
    }
    rejected.push(item);
  }
  if (rejected.length > 0) {
    throw new Error(
      [
        `Dependency closure contains ${rejected.length} immature package(s) without an exact, unexpired approval:`,
        ...rejected.slice(0, 20).map(formatImmaturePackage),
        'Wait until the listed time, pin an older mature version, or add a reviewed exact entry (package, version, integrity) to the release-age exception policy.',
      ].join('\n'),
    );
  }
  const unmatchedPolicyEntries = policy.entries.filter(
    entry => !matchedPolicyEntries.has(identityKey(entry)),
  );
  if (unmatchedPolicyEntries.length > 0) {
    throw new Error(
      `Release-age exception policy contains stale or unmatched approval(s): ${unmatchedPolicyEntries
        .map(identityKey)
        .join(', ')}`,
    );
  }
  exactExclusions.sort(compareCodeUnits);
  approvals.sort((left, right) =>
    compareCodeUnits(identityKey(left), identityKey(right)),
  );
  return {
    approvals,
    exactExclusions,
    matchedPolicyEntries: [...matchedPolicyEntries].sort(compareCodeUnits),
  };
}

function readRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  assertCondition(
    stat?.isFile() && !stat.isSymbolicLink(),
    `${label} is missing or is not a regular file: ${filePath}`,
  );
  return fs.readFileSync(filePath);
}

function validateExactExclusions(value, label) {
  assertCondition(Array.isArray(value), `${label} must be an array`);
  const exclusions = [];
  const identities = new Set();
  for (const [index, exclusion] of value.entries()) {
    assertNonEmptyString(exclusion, `${label}[${index}]`);
    assertCondition(
      !/[?*[\]{}]/u.test(exclusion),
      `${label}[${index}] must not contain a glob`,
    );
    const identity = parseFullPackageLocator(exclusion);
    assertCondition(
      identity && identityKey(identity) === exclusion,
      `${label}[${index}] must be one exact package@version selector, found ${exclusion}`,
    );
    assertCondition(
      !identities.has(exclusion),
      `${label} contains duplicate ${exclusion}`,
    );
    identities.add(exclusion);
    exclusions.push(exclusion);
  }
  const sorted = [...exclusions].sort(compareCodeUnits);
  assertCondition(
    JSON.stringify(exclusions) === JSON.stringify(sorted),
    `${label} must be sorted canonically`,
  );
  return exclusions;
}

function readNativeWorkspacePolicy(workspacePath, { parseYamlImpl } = {}) {
  const bytes = readRegularFile(
    workspacePath,
    'Generated pnpm workspace policy',
  );
  const policy = parseYamlImpl
    ? parseYamlImpl(bytes.toString('utf8'))
    : parseYamlFile(workspacePath);
  assertPlainObject(policy, 'Generated pnpm workspace policy');
  assertCondition(
    policy.minimumReleaseAge === minimumReleaseAgeMinutes &&
      policy.minimumReleaseAgeStrict === true &&
      policy.minimumReleaseAgeIgnoreMissingTime === false,
    'Generated pnpm workspace policy must natively enforce strict 1440-minute release age with missing times rejected',
  );
  assertCondition(
    policy.trustPolicy === 'no-downgrade' &&
      policy.trustPolicyIgnoreAfter === minimumReleaseAgeMinutes,
    'Generated pnpm workspace policy must natively enforce no-downgrade trust for 1440 minutes',
  );
  return {
    bytes,
    policy,
    sha256: sha256(bytes),
  };
}

function readNativeLock(lockPath, { parseYamlImpl } = {}) {
  const bytes = readRegularFile(lockPath, 'Generated pnpm lockfile');
  return {
    bytes,
    lock: parseYamlImpl
      ? parseYamlImpl(bytes.toString('utf8'))
      : parseYamlFile(lockPath),
    sha256: sha256(bytes),
  };
}

function assertExternalApprovalUnexpired(approval, now) {
  if (approval.authority !== 'external-release-age-policy') {
    return;
  }
  const nowMs = now.getTime();
  assertCondition(
    Number.isFinite(nowMs),
    'Release-age expiry recheck requires a valid current time',
  );
  const expiresAtMs = canonicalInstant(
    approval.expiresAt,
    `Approval ${identityKey(approval)} expiresAt`,
  );
  assertCondition(
    expiresAtMs > nowMs,
    `Release-age approval for ${identityKey(approval)} expired at ${approval.expiresAt} before frozen install`,
  );
}

async function auditReleaseAgePolicy({
  projectDir,
  release,
  commandExclusions,
  registryUrl,
  policyPath,
  runImpl = run,
  fetchImpl = fetch,
  now = new Date(),
  parseYamlImpl,
  verifyYamlTool = true,
}) {
  assertCondition(
    now instanceof Date && Number.isFinite(now.getTime()),
    'Release-age audit requires a valid current time',
  );
  if (verifyYamlTool) {
    assertYamlDistributionIntegrity(runImpl);
  }
  const workspacePath = path.join(projectDir, 'pnpm-workspace.yaml');
  const workspace = readNativeWorkspacePolicy(workspacePath, {
    parseYamlImpl,
  });
  // Ordinary installs must use the exact authenticated producer policy.
  const cohortSelectors = validateExactExclusions(
    [
      ...new Set([
        ...release.packages.map(item => `${item.targetName}@${item.version}`),
        ...(release.sidecars?.packages ?? []).map(
          item => `${item.name}@${item.version}`,
        ),
        ...authenticatedBootstrapExclusions(release),
      ]),
    ].sort(compareCodeUnits),
    'Authenticated generated workspace release-age exclusions',
  );
  const persistedExclusions = workspace.policy.minimumReleaseAgeExclude;
  assertCondition(
    JSON.stringify(persistedExclusions) === JSON.stringify(cohortSelectors),
    [
      'Generated pnpm workspace minimumReleaseAgeExclude must list exactly the release cohort and verified sidecars, plus authenticated producer compiler selectors.',
      `Expected: ${cohortSelectors.join(', ')}`,
      `Found: ${Array.isArray(persistedExclusions) ? persistedExclusions.join(', ') || '(empty)' : String(persistedExclusions)}`,
    ].join('\n'),
  );
  const lockPath = path.join(projectDir, 'pnpm-lock.yaml');
  const nativeLock = readNativeLock(lockPath, { parseYamlImpl });
  const closureResult = buildDependencyClosure(nativeLock.lock);
  const resolution = closureResolution(closureResult);
  const cohortNames = new Set([
    ...release.packages.flatMap(item => [item.targetName, item.sourceName]),
    ...(release.sidecars?.packages ?? []).map(item => item.name),
  ]);
  for (const tarball of closureResult.tarballs) {
    assertCondition(
      !cohortNames.has(tarball.name),
      `First-party lock candidate ${tarball.name} must resolve through the authenticated release cohort, not a tarball URL.`,
    );
  }
  if (closureResult.unresolved.length > 0) {
    throw new Error(
      `Dependency closure has unresolved candidates:\n${formatUnresolvedCandidates(
        closureResult.unresolved,
      )}`,
    );
  }

  const policy = readExceptionPolicy(policyPath, now);
  const expectedExclusions = releaseAgeExemptions(release, { policyPath, now });
  if (
    JSON.stringify(commandExclusions) !== JSON.stringify(expectedExclusions)
  ) {
    const declared = new Set(
      Array.isArray(commandExclusions) ? commandExclusions : [],
    );
    const expected = new Set(expectedExclusions);
    throw new Error(
      [
        'Acceptance command release-age exclusions differ from releaseAgeExemptions(manifest, policy); every lane must pass that exact set.',
        `Missing: ${expectedExclusions.filter(key => !declared.has(key)).join(', ') || '(none)'}`,
        `Unexpected: ${[...declared].filter(key => !expected.has(key)).join(', ') || '(none)'}`,
      ].join('\n'),
    );
  }
  // Cohort packuments stay on the selected registry (in source mode that is
  // the ephemeral Verdaccio, where the cohort's publishedAt lives and what
  // feeds the strict-release-manifest exclusion path). External packuments go
  // direct to npmjs — strictly stronger (authoritative publishedAt/integrity)
  // and faster than proxying through Verdaccio.
  const cohortScopePrefix = `@${release.targetScope}/`;
  const sidecarNames = new Set(
    (release.sidecars?.packages ?? []).map(item => item.name),
  );
  const registryUrlFor = name =>
    name.startsWith(cohortScopePrefix) || sidecarNames.has(name)
      ? registryUrl
      : NPM_REGISTRY;
  const metadata = await fetchRegistryMetadata(closureResult.closure, {
    registryUrlFor,
    fetchImpl,
    now,
  });
  const { approvals, exactExclusions: requiredExclusions } =
    approveImmaturePackages({
      metadata,
      policy,
      release,
      now,
    });
  const declaredExclusions = new Set(persistedExclusions);
  const missingExclusions = requiredExclusions.filter(
    key => !declaredExclusions.has(key),
  );
  assertCondition(
    missingExclusions.length === 0,
    `Generated workspace release-age policy does not permit immature dependencies: ${
      missingExclusions.join(', ') || '(empty)'
    }. External release-age approvals cannot override ordinary workspace installs.`,
  );
  const exactExclusions = persistedExclusions;

  const metadataIdentity = metadata.map(item => ({
    name: item.name,
    version: item.version,
    integrity: item.integrity,
    publishedAt: item.publishedAt,
  }));
  const digests = {
    lockSha256: nativeLock.sha256,
    closureSha256: resolution.closureSha256,
    registryMetadataSha256: sha256(canonicalJson(metadataIdentity)),
    exceptionPolicySha256: sha256(canonicalJson(policy)),
    releaseManifestSha256: release.manifestSha256,
  };

  return {
    approvals,
    tarballs: closureResult.tarballs,
    closureCount: closureResult.closure.length,
    closureIdentities: resolution.closureIdentities,
    candidateDiscovery: {
      classification: 'quarantined-input-only',
      source: 'native-generated-pnpm-lock',
      workspaceMutation: false,
    },
    digests,
    exactExclusions,
    importerCount: closureResult.importerCount,
    lockfileVersion: closureResult.lockfileVersion,
    matureCount: metadata.filter(
      item => item.ageMinutes >= minimumReleaseAgeMinutes,
    ).length,
    policyEntryCount: policy.entries.length,
    registryMetadataCount: metadata.length,
    workspacePolicySha256: workspace.sha256,
  };
}

function verifyStrictInstallInputs(
  projectDir,
  audit,
  { parseYamlImpl, now = new Date(), phase = 'frozen-install' } = {},
) {
  const lockPath = path.join(projectDir, 'pnpm-lock.yaml');
  const nativeLock = readNativeLock(lockPath, { parseYamlImpl });
  assertCondition(
    nativeLock.sha256 === audit.digests.lockSha256,
    `${phase} input pnpm lockfile differs from the audited native lock`,
  );
  const workspacePath = path.join(projectDir, 'pnpm-workspace.yaml');
  const workspace = readNativeWorkspacePolicy(workspacePath, {
    parseYamlImpl,
  });
  assertCondition(
    workspace.sha256 === audit.workspacePolicySha256,
    `${phase} input pnpm workspace policy differs from the audited native policy`,
  );
  for (const approval of audit.approvals) {
    assertExternalApprovalUnexpired(approval, now);
  }
  return {
    exactExclusionCount: audit.exactExclusions.length,
    lockSha256: audit.digests.lockSha256,
    minimumReleaseAgeMinutes,
    phase,
    workspacePolicySha256: audit.workspacePolicySha256,
  };
}

export {
  auditReleaseAgePolicy,
  buildDependencyClosure,
  canonicalJson,
  closureResolution,
  fetchRegistryMetadata,
  parsePackageKey,
  parseYaml,
  parseYamlFile,
  readActiveReleaseAgeExceptionSelectors,
  releaseAgeExemptions,
  sha256,
  validateExactExclusions,
  validateExceptionPolicy,
  verifyStrictInstallInputs,
  YAML_INTEGRITY,
  YAML_NAME,
  YAML_SPECIFIER,
  YAML_VERSION,
};
