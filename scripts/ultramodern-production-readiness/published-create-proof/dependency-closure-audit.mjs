import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mergePnpmLockfileDocuments } from '../../lib/pnpm-lockfile-documents.mjs';
import { run } from './process.mjs';

const YAML_NAME = 'js-yaml';
const YAML_VERSION = '5.5.0';
const YAML_SPECIFIER = `${YAML_NAME}@${YAML_VERSION}`;
const YAML_INTEGRITY =
  'sha512-paNr4LFIFPjeeSmwNYdrb8FafLLG/Cr2Af3GjbsHJ5CxIjH4r0c2emlmRdAtpPAieP1gRVzk6buBbVP5gBMGAg==';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
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
  /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[A-Za-z0-9][A-Za-z0-9._~-]*)$/u;
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

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
    if (!peer) {
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
      ...(identity ? { package: identityKey(identity) } : {}),
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
  { registryUrlFor, fetchImpl = fetch, concurrency = 16 },
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
      results[index] = {
        name: item.name,
        version: item.version,
        integrity,
        publishedAt: packument?.time?.[item.version] ?? null,
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
    policy.trustPolicy === 'no-downgrade' &&
      policy.trustPolicyIgnoreAfter === 1440,
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

async function auditDependencyClosure({
  projectDir,
  release,
  registryUrl,
  runImpl = run,
  fetchImpl = fetch,
  parseYamlImpl,
  verifyYamlTool = true,
}) {
  if (verifyYamlTool) {
    assertYamlDistributionIntegrity(runImpl);
  }
  const workspacePath = path.join(projectDir, 'pnpm-workspace.yaml');
  const workspace = readNativeWorkspacePolicy(workspacePath, {
    parseYamlImpl,
  });
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

  // First-party metadata comes from the controlled release registry.
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
  });
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
    releaseManifestSha256: release.manifestSha256,
  };

  return {
    tarballs: closureResult.tarballs,
    closureCount: closureResult.closure.length,
    closureIdentities: resolution.closureIdentities,
    candidateDiscovery: {
      classification: 'quarantined-input-only',
      source: 'native-generated-pnpm-lock',
      workspaceMutation: false,
    },
    digests,
    importerCount: closureResult.importerCount,
    lockfileVersion: closureResult.lockfileVersion,
    registryMetadataCount: metadata.length,
    workspacePolicySha256: workspace.sha256,
  };
}

function verifyStrictInstallInputs(
  projectDir,
  audit,
  { parseYamlImpl, phase = 'frozen-install' } = {},
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
  return {
    lockSha256: audit.digests.lockSha256,
    phase,
    workspacePolicySha256: audit.workspacePolicySha256,
  };
}

export {
  auditDependencyClosure,
  buildDependencyClosure,
  canonicalJson,
  closureResolution,
  fetchRegistryMetadata,
  parsePackageKey,
  parseYaml,
  parseYamlFile,
  sha256,
  validateExactExclusions,
  verifyStrictInstallInputs,
  YAML_INTEGRITY,
  YAML_NAME,
  YAML_SPECIFIER,
  YAML_VERSION,
};
