import {
  assertRegistryDistMatches,
  fetchRegistryPackageMetadata,
  pinnedRegistryTarballUrl,
  isRegistryNotFoundError,
  isRegistryMetadataNotFoundError,
  isThrottledRegistryMetadataError,
  isTransientNpmPublishError,
  lookupRegistryDistTag,
  lookupRegistryPackageDist,
  lookupRegistryPackument,
  mapWithConcurrency,
  registryPackumentDist,
  registryPackumentDistTag,
  verifyRegistryTarball,
} from './registry-read.mjs';
// Consumer: publish-bleedingdev.yml preflight, publish, and exact registry verification.
import fs from 'node:fs';
import path from 'node:path';
import { npmPublishAttempts, npmPublishRetryDelayMs } from './constants.mjs';
import { run, sleep } from './commands.mjs';
import { publishLevels } from './manifest.mjs';
import { pollRegistryPropagation } from './registry-propagation.mjs';
import {
  preflightTrustedPublishingPackages,
  publishAcceptedPackage,
  validateAcceptedPackageDryRun,
} from './npm-buffer-publisher.mjs';
import {
  assertVerifiedReleaseArtifacts,
  readVerifiedPackageArtifactBytes,
  verifyPackageArtifact,
  verifyPackageArtifactBytes,
} from './release-artifacts.mjs';
import {
  createRegistryProvenanceExpectation,
  historicalRegistryProvenanceExpectations,
  slsaProvenanceV1,
  verifyRegistryProvenance,
} from './provenance.mjs';
import validationKit from '../../../lib/validation-kit.js';

const { assertNonEmptyString, assertPlainObject } = validationKit;

// This code-reviewed checkpoint is deliberately independent of mutable npm
// packuments; only the listed legacy identities may bypass provenance.
const registrySourceChronologyPolicies = Object.freeze({
  '@bleedingdev/modern-js-create': Object.freeze({
    cutoverAnchor: Object.freeze({
      integrity:
        'sha512-fK3mRQR/eyTRdgvuRb+Scg8lWS2ijqhAPy/d97SoRJ+12yFZHD/e4JWTQZcm9zxkOJn0kp4BJypVjwtlI63L6Q==',
      publishedAt: '2026-05-16T21:22:57.171Z',
      sourceCommit: '846d489312f17f48c5bfbf88d1d16164ffd6f465',
      version: '3.2.0-ultramodern.1',
    }),
    grandfatheredVersions: Object.freeze([
      Object.freeze({
        integrity:
          'sha512-+ZyvnxrZouvlF5yqdw6rbtEB/+X8GJJLrBNzKVZhN7aSjYbBI1nVgugRE0IogCNtyQzibOfakbeWNKwKtEI62Q==',
        publishedAt: '2026-05-16T14:50:19.166Z',
        version: '3.2.0-ultramodern.0',
      }),
    ]),
  }),
  '@bleedingdev/modern-js-ultramodern-create': Object.freeze({
    provenanceRequiredFromFirstVersion: true,
  }),
});

const maxRegistryConcurrency = 8;
const chronologyVerificationConcurrency = 8;

function resolveRegistryConcurrency(options) {
  const requested = Number(options?.publishConcurrency);
  if (!Number.isInteger(requested) || requested < 1) {
    return 1;
  }
  return Math.min(requested, maxRegistryConcurrency);
}

function packSourcePackage(packageName, packDir) {
  const before = new Set(fs.readdirSync(packDir));
  run(
    'pnpm',
    ['--filter', packageName, 'pack', '--pack-destination', packDir],
    {
      stdio: 'pipe',
    },
  );
  const after = fs.readdirSync(packDir);
  const created = after.filter(
    name => !before.has(name) && name.endsWith('.tgz'),
  );
  if (created.length !== 1) {
    throw new Error(
      `Expected one pack artifact for ${packageName}, got ${created.length}`,
    );
  }
  return path.join(packDir, created[0]);
}

function extractTarball(tarball, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', targetDir], { stdio: 'pipe' });
  return path.join(targetDir, 'package');
}

async function packageExists(packageName, version) {
  return (await lookupRegistryPackageDist(packageName, version)) !== null;
}

function parseRegistryTimestamp(value, label) {
  assertNonEmptyString(value, label);
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return timestamp;
}

function registrySourceChronologyPolicy(packageName) {
  const policy = registrySourceChronologyPolicies[packageName];
  if (!policy) {
    throw new Error(
      `${packageName} has no independently maintained registry provenance chronology policy`,
    );
  }
  return policy;
}

function assertPinnedRegistryChronologyEntry(
  entry,
  expected,
  packageName,
  label,
) {
  if (entry.version !== expected.version) {
    throw new Error(
      `${packageName} registry ${label} expected version ${expected.version}, found ${entry.version}`,
    );
  }
  if (entry.publishedAt !== expected.publishedAt) {
    throw new Error(
      `${packageName}@${entry.version} registry ${label} publication time must be ${expected.publishedAt}`,
    );
  }
  assertPlainObject(
    entry.published.dist,
    `${packageName}@${entry.version} registry dist metadata`,
  );
  if (entry.published.dist.integrity !== expected.integrity) {
    throw new Error(
      `${packageName}@${entry.version} registry ${label} integrity does not match the independently maintained chronology`,
    );
  }
}

function registryVersionChronology(metadata, packageName) {
  assertPlainObject(metadata, `${packageName} registry metadata`);
  if (metadata.name !== packageName) {
    throw new Error(
      `${packageName} registry metadata identifies package ${String(metadata.name)}`,
    );
  }
  assertPlainObject(metadata.versions, `${packageName} registry versions`);
  assertPlainObject(metadata.time, `${packageName} registry time metadata`);
  const versionNames = Object.keys(metadata.versions).sort();
  const timeVersionNames = Object.keys(metadata.time)
    .filter(name => name !== 'created' && name !== 'modified')
    .sort();
  const versionNameSet = new Set(versionNames);
  const timeVersionNameSet = new Set(timeVersionNames);
  const versionsMissingTime = versionNames.filter(
    version => !timeVersionNameSet.has(version),
  );
  const timesMissingVersion = timeVersionNames.filter(
    version => !versionNameSet.has(version),
  );
  if (versionsMissingTime.length > 0 || timesMissingVersion.length > 0) {
    throw new Error(
      `${packageName} registry versions/time metadata disagree: versions missing from time [${versionsMissingTime.join(
        ', ',
      )}]; time versions missing from versions [${timesMissingVersion.join(', ')}]`,
    );
  }
  const created = parseRegistryTimestamp(
    metadata.time.created,
    `${packageName} registry creation time`,
  );
  const modified = parseRegistryTimestamp(
    metadata.time.modified,
    `${packageName} registry modification time`,
  );
  if (created > modified) {
    throw new Error(`${packageName} registry time metadata is out of order`);
  }

  const entries = Object.entries(metadata.versions).map(
    ([version, published], originalIndex) => {
      assertNonEmptyString(version, `${packageName} registry version`);
      assertPlainObject(
        published,
        `${packageName}@${version} registry version metadata`,
      );
      if (published.name !== packageName || published.version !== version) {
        throw new Error(
          `${packageName}@${version} registry version identity is inconsistent`,
        );
      }
      const publishedAt = metadata.time[version];
      const timestamp = parseRegistryTimestamp(
        publishedAt,
        `${packageName}@${version} registry publication time`,
      );
      if (timestamp < created || timestamp > modified) {
        throw new Error(
          `${packageName}@${version} registry publication time is outside the package lifetime`,
        );
      }
      return { originalIndex, published, publishedAt, timestamp, version };
    },
  );
  if (entries.length === 0) {
    throw new Error(`${packageName} registry metadata has no version ledger`);
  }
  entries.sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      left.originalIndex - right.originalIndex,
  );
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].timestamp === entries[index].timestamp) {
      throw new Error(
        `${packageName} registry version chronology is ambiguous at ${entries[index].publishedAt}`,
      );
    }
  }
  return entries;
}

function declaresSlsaV1Provenance(published) {
  return (
    published?.dist?.attestations?.provenance?.predicateType ===
    slsaProvenanceV1
  );
}

const registryProvenanceStatusPattern =
  /registry provenance returned HTTP (\d{3})$/u;

// A throttled attestation response carries no information about whether the
// version is provenanced, so it must never be reported as missing provenance.
function isThrottledRegistryProvenanceError(error) {
  const match = registryProvenanceStatusPattern.exec(
    error instanceof Error ? error.message : '',
  );
  return match ? Number(match[1]) === 429 : false;
}

const registryProvenanceRetryAttempts = 4;
const registryProvenanceRetryDelayMs = 1000;

// Bounded backoff for throttled attestation reads; anything still throttled
// after the last attempt propagates so the chronology gate stays fail-closed.
async function retryThrottledProvenance(operation, wait = sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= registryProvenanceRetryAttempts ||
        !isThrottledRegistryProvenanceError(error)
      ) {
        throw error;
      }
      await wait(registryProvenanceRetryDelayMs * attempt);
    }
  }
}

function historicalProvenanceExpectation(expectation) {
  return {
    certificateIdentity: expectation.certificateIdentity,
    issuer: expectation.issuer,
    source: { repository: expectation.source.repository },
    workflow: { ...expectation.workflow },
  };
}

/**
 * Authenticates a package's whole registry chronology against a code-reviewed
 * policy: the pinned grandfathered prefix (exact version, publication time and
 * integrity), the optional provenance cutover anchor, then SLSA v1 provenance
 * from the trusted repository and workflow for every later version. Shared by
 * the cohort source-commit gate and sidecar reuse; returns the per-version
 * evidence so each caller applies its own identity rule.
 */
async function verifyRegistryProvenanceChronology(
  { expectation, metadata, packageName, policy },
  dependencies = {},
) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const provenanceVerifier =
    dependencies.verifyRegistryProvenance ?? verifyRegistryProvenance;
  const provenanceRequiredFromFirstVersion =
    policy.provenanceRequiredFromFirstVersion === true;
  const { cutoverAnchor, grandfatheredVersions = [] } = policy;
  if (
    provenanceRequiredFromFirstVersion &&
    (cutoverAnchor || grandfatheredVersions.length > 0)
  ) {
    throw new Error(
      `${packageName} provenance policy cannot both require provenance from the first version and grandfather earlier versions`,
    );
  }
  const chronology = registryVersionChronology(metadata, packageName);
  const cutoverIndex = grandfatheredVersions.length;
  if (cutoverAnchor) {
    const anchorIndex = chronology.findIndex(
      entry => entry.version === cutoverAnchor.version,
    );
    if (anchorIndex === -1) {
      throw new Error(
        `${packageName} registry chronology is missing independently maintained provenance cutover anchor ${cutoverAnchor.version}`,
      );
    }
    if (anchorIndex !== cutoverIndex) {
      throw new Error(
        `${packageName} registry chronology before ${cutoverAnchor.version} is not independently authorized`,
      );
    }
  } else if (chronology.length < cutoverIndex) {
    throw new Error(
      `${packageName} registry chronology is missing grandfathered version ${grandfatheredVersions[chronology.length].version}`,
    );
  }
  for (const [index, grandfatheredVersion] of grandfatheredVersions.entries()) {
    assertPinnedRegistryChronologyEntry(
      chronology[index],
      grandfatheredVersion,
      packageName,
      'grandfathered version',
    );
  }
  if (cutoverAnchor) {
    assertPinnedRegistryChronologyEntry(
      chronology[cutoverIndex],
      cutoverAnchor,
      packageName,
      'provenance cutover anchor',
    );
    if (!declaresSlsaV1Provenance(chronology[cutoverIndex].published)) {
      throw new Error(
        `${packageName}@${cutoverAnchor.version} authenticated provenance cutover anchor is missing its SLSA v1 declaration`,
      );
    }
  }
  const missingProvenance = entry =>
    cutoverAnchor
      ? `${packageName}@${entry.version} is missing SLSA v1 provenance after the ${cutoverAnchor.version} cutover`
      : provenanceRequiredFromFirstVersion
        ? `${packageName}@${entry.version} is missing SLSA v1 provenance; this identity requires provenance from its first published version`
        : `${packageName}@${entry.version} is missing SLSA v1 provenance and is not a grandfathered version`;
  const firstVerified = chronology[cutoverIndex];
  if (firstVerified && !declaresSlsaV1Provenance(firstVerified.published)) {
    throw new Error(missingProvenance(firstVerified));
  }

  const discoveryExpectations =
    historicalRegistryProvenanceExpectations(expectation);
  const results = await mapWithConcurrency(
    chronology.slice(cutoverIndex),
    chronologyVerificationConcurrency,
    async entry => {
      try {
        if (!declaresSlsaV1Provenance(entry.published)) {
          throw new Error(missingProvenance(entry));
        }
        assertPlainObject(
          entry.published.dist,
          `${packageName}@${entry.version} registry dist metadata`,
        );
        let evidence;
        const identityErrors = [];
        for (const historicalExpectation of discoveryExpectations) {
          const versionExpectation =
            cutoverAnchor && entry.version === cutoverAnchor.version
              ? {
                  ...historicalExpectation,
                  source: {
                    ...historicalExpectation.source,
                    commit: cutoverAnchor.sourceCommit,
                  },
                }
              : historicalExpectation;
          try {
            evidence = await retryThrottledProvenance(
              () =>
                provenanceVerifier(
                  {
                    integrity: entry.published.dist.integrity,
                    targetName: packageName,
                    version: entry.version,
                  },
                  entry.published.dist,
                  versionExpectation,
                  fetchImpl,
                  dependencies.bundleVerifier,
                ),
              dependencies.wait,
            );
            break;
          } catch (error) {
            // Throttling is not an identity mismatch; preserve its bounded
            // retry budget and fail closed without trying another identity.
            if (isThrottledRegistryProvenanceError(error)) throw error;
            identityErrors.push(error);
          }
        }
        if (identityErrors.length === discoveryExpectations.length)
          throw identityErrors[0];
        return { entry, evidence };
      } catch (error) {
        if (isThrottledRegistryProvenanceError(error)) {
          return {
            entry,
            error: new Error(
              `${packageName}@${entry.version} registry provenance is throttled; the published-cohort chronology cannot be authenticated`,
              { cause: error },
            ),
          };
        }
        return { entry, error };
      }
    },
  );
  // Assertions replay in chronology order so the reported failure is the
  // earliest one, exactly as a serial walk would report it.
  for (const { entry, error, evidence } of results) {
    if (error) {
      throw error;
    }
    if (
      cutoverAnchor &&
      entry.version === cutoverAnchor.version &&
      evidence.sourceCommit !== cutoverAnchor.sourceCommit
    ) {
      throw new Error(
        `${packageName}@${cutoverAnchor.version} provenance cutover anchor authenticated unexpected source commit ${String(evidence.sourceCommit)}`,
      );
    }
  }
  return { chronology, cutoverIndex, results };
}

async function assertRegistrySourceCommitUnpublished(
  request,
  dependencies = {},
) {
  assertPlainObject(request, 'Registry source-cohort request');
  const {
    env = process.env,
    packageName,
    requestedVersion,
    sourceCommit,
    sourceRepository,
  } = request;
  assertNonEmptyString(packageName, 'Registry source-cohort package name');
  assertNonEmptyString(
    requestedVersion,
    'Registry source-cohort requested version',
  );
  const chronologyPolicy = registrySourceChronologyPolicy(packageName);
  const expectation = createRegistryProvenanceExpectation(
    {
      source: { commit: sourceCommit, repository: sourceRepository },
    },
    env,
  );
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  let metadata;
  try {
    metadata = await fetchRegistryPackageMetadata(packageName, fetchImpl);
  } catch (error) {
    if (
      chronologyPolicy.provenanceRequiredFromFirstVersion === true &&
      isRegistryMetadataNotFoundError(error)
    ) {
      return {
        cutover: null,
        exactVersionAuthenticated: false,
        grandfatheredCount: 0,
        inspectedCount: 0,
        packageName,
        requestedVersion,
        sourceCommit: expectation.source.commit,
        versionCount: 0,
      };
    }
    throw error;
  }
  const { chronology, cutoverIndex, results } =
    await verifyRegistryProvenanceChronology(
      {
        expectation,
        metadata,
        packageName,
        policy: chronologyPolicy,
      },
      dependencies,
    );
  const cutoverEntry = chronology[cutoverIndex];
  const requestedIndex = chronology.findIndex(
    entry => entry.version === requestedVersion,
  );
  if (requestedIndex !== -1 && requestedIndex < cutoverIndex) {
    throw new Error(
      `${packageName}@${requestedVersion} predates authenticated registry provenance and cannot be safely reused`,
    );
  }
  for (const { entry, evidence } of results) {
    if (
      entry.version !== requestedVersion &&
      evidence.sourceCommit === expectation.source.commit
    ) {
      throw new Error(
        `Source commit ${expectation.source.commit} is already authenticated and published as ${packageName}@${entry.version}; refusing requested version ${requestedVersion}`,
      );
    }
  }

  return {
    cutover: {
      publishedAt: cutoverEntry.publishedAt,
      version: cutoverEntry.version,
    },
    exactVersionAuthenticated: requestedIndex !== -1,
    grandfatheredCount: cutoverIndex,
    inspectedCount: results.length,
    packageName,
    requestedVersion,
    sourceCommit: expectation.source.commit,
    versionCount: chronology.length,
  };
}

async function verifyRegistryPackageDist(
  item,
  dist,
  provenanceExpectation,
  registry = {
    assertRegistryDistMatches,
    verifyRegistryProvenance,
    verifyRegistryTarball,
  },
) {
  registry.assertRegistryDistMatches(item, dist);
  await registry.verifyRegistryTarball(item, dist);
  // An immutable version may have been placed by an earlier failed run. Its
  // signed source commit is authenticated from the bundle; exact tarball bytes
  // establish equivalence with this release rather than mutable run identity.
  await registry.verifyRegistryProvenance(
    item,
    dist,
    historicalProvenanceExpectation(provenanceExpectation),
  );
  return dist;
}

async function verifyRegistryPackage(
  item,
  provenanceExpectation,
  registry = {
    assertRegistryDistMatches,
    lookupRegistryPackageDist,
    verifyRegistryPackageDist,
    verifyRegistryProvenance,
    verifyRegistryTarball,
  },
) {
  // npm's attestation propagation regularly exceeds one minute right after
  // publish (observed: attestations endpoint 404s ~60s in, then appears), so
  // the shared post-publish schedule (registry-propagation.mjs) must
  // comfortably outlast that lag or the cohort aborts on a package that in
  // fact published fine.
  // Byte identity is established against the manifest-pinned integrity, shasum,
  // and size, none of which change between attempts, so the tarball download is
  // not repeated once it has matched. The dist itself is re-resolved every
  // attempt: a dist without .attestations is exactly what a lagging publish
  // looks like and only a fresh lookup can observe it appear.
  let tarballVerified = false;
  const verifyTarballOnce = async (tarballItem, dist, ...rest) => {
    // Only the byte download is safe to memoize; the dist is re-resolved every
    // attempt, so each one must still prove its tarball URL is the pinned npm
    // endpoint before the memo can vouch for the bytes behind it.
    pinnedRegistryTarballUrl(tarballItem, dist?.tarball);
    if (tarballVerified) {
      return;
    }
    await registry.verifyRegistryTarball(tarballItem, dist, ...rest);
    tarballVerified = true;
  };

  const outcome = await pollRegistryPropagation(
    async () => {
      const dist = await registry.lookupRegistryPackageDist(
        item.targetName,
        item.version,
      );
      if (dist === null) {
        return {
          detail: `${item.targetName}@${item.version} is not present in the registry`,
          settled: false,
        };
      }
      try {
        await registry.verifyRegistryPackageDist(
          item,
          dist,
          provenanceExpectation,
          {
            assertRegistryDistMatches: registry.assertRegistryDistMatches,
            verifyRegistryProvenance: registry.verifyRegistryProvenance,
            verifyRegistryTarball: verifyTarballOnce,
          },
        );
        return { settled: true, value: dist };
      } catch (error) {
        return {
          detail: error instanceof Error ? error.message : String(error),
          settled: false,
        };
      }
    },
    { wait: registry.wait },
  );
  if (outcome.settled) {
    if (outcome.firstDetail !== undefined) {
      console.log(
        `${item.targetName}@${item.version} verified on npm after ${outcome.attempts} reads; first pending: ${outcome.firstDetail}`,
      );
    }
    return outcome.value;
  }

  throw new Error(
    `Published package ${item.targetName}@${item.version} did not verify on npm after ${outcome.attempts} attempts: ${outcome.detail} (first pending: ${outcome.firstDetail})`,
  );
}

async function verifyRegistryDistTag(packageName, tag, version) {
  const resolvedVersion = await lookupRegistryDistTag(packageName, tag);
  if (resolvedVersion !== version) {
    throw new Error(
      `${packageName} dist-tag ${tag} points at ${resolvedVersion ?? '<missing>'}, expected ${version}`,
    );
  }
}

const ultramodernVersionPattern = /^(\d+\.\d+\.\d+)-ultramodern\.([1-9]\d*)$/;

/**
 * A new incorporated Modern.js base restarts the ultramodern revision counter.
 * Carrying the previous base's revision forward (3.8.1-ultramodern.5 ->
 * 3.8.2-ultramodern.6) is still forward semver, so plain ordering accepts it,
 * but it claims a release history the new base never had. A base change must
 * land on the lowest revision the new base has not used yet: normally `.1`,
 * but a cohort attempt that crashes after partially publishing (post-publish
 * verification can abort mid-cohort) leaves members already tagged on the new
 * base. Those exact versions are immutable and pinned to the crashed run's
 * provenance, so they burn their revision for the whole cohort and the
 * recovery cohort publishes at the next free revision instead.
 */
function assertBaseRevisionReset(
  semver,
  targetName,
  candidate,
  currentTag,
  allowedRevision = '1',
) {
  const candidateMatch = ultramodernVersionPattern.exec(candidate);
  const currentMatch = ultramodernVersionPattern.exec(currentTag);
  if (!candidateMatch || !currentMatch) {
    return;
  }

  const [, candidateBase, candidateRevision] = candidateMatch;
  const [, currentBase] = currentMatch;
  if (!semver.gt(candidateBase, currentBase)) {
    return;
  }

  if (candidateRevision !== allowedRevision) {
    const burnedNote =
      allowedRevision === '1'
        ? ''
        : ` (lower revisions at base ${candidateBase} are burned by a partially published cohort)`;
    throw new Error(
      `${targetName}@${candidate} moves the incorporated Modern.js base from ${currentBase} to ${candidateBase}; the only valid next version on a base change is ${candidateBase}-ultramodern.${allowedRevision}${burnedNote}`,
    );
  }
}

/**
 * The lowest revision the cohort may claim when it moves to a new incorporated
 * base: one past the highest revision any cohort member's current dist-tag
 * already occupies at that base (crash remnants), or `.1` when the base is
 * untouched. A member whose current dist-tag already IS the cohort version is
 * not a remnant — it is this cohort partially placed (a converge re-run after
 * a mid-cohort crash), so that revision stays claimable by the rest of the
 * cohort instead of forcing an endless revision escalation.
 */
function nextBaseChangeRevision(cohortVersion, currentTags) {
  const cohortMatch = ultramodernVersionPattern.exec(cohortVersion ?? '');
  if (!cohortMatch) {
    return '1';
  }
  const [, cohortBase, cohortRevision] = cohortMatch;
  let burned = 0;
  for (const tag of currentTags) {
    const tagMatch = ultramodernVersionPattern.exec(tag ?? '');
    if (!tagMatch || tagMatch[1] !== cohortBase) {
      continue;
    }
    if (tag === cohortVersion) {
      return cohortRevision;
    }
    burned = Math.max(burned, Number(tagMatch[2]));
  }
  return String(burned + 1);
}

async function preflightRegistryPackages(
  publishItems,
  options,
  provenanceExpectation,
  registry = {
    lookupRegistryDistTag,
    lookupRegistryPackageDist,
    lookupRegistryPackument,
    verifyRegistryPackageDist,
  },
) {
  const failures = [];
  const { default: semver } = await import('semver');
  const states = new Map();
  const currentTags = new Map();
  const concurrency = resolveRegistryConcurrency(options);
  const describeFailure = (item, error) =>
    `${item.targetName}@${item.version}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  // One packument answers both phases, so it may only stand in for lookups the
  // caller has not replaced with its own implementations.
  const packumentLookup =
    registry.lookupRegistryDistTag === lookupRegistryDistTag &&
    registry.lookupRegistryPackageDist === lookupRegistryPackageDist
      ? registry.lookupRegistryPackument
      : undefined;
  // `undefined`: no packument, fall back to the npm-view lookups. `null`: the
  // package itself is absent from the registry.
  const readPackument = async packageName => {
    if (!packumentLookup) {
      return undefined;
    }
    try {
      return await packumentLookup(packageName);
    } catch (error) {
      if (isRegistryMetadataNotFoundError(error)) {
        return null;
      }
      if (isThrottledRegistryMetadataError(error)) {
        throw error;
      }
      return undefined;
    }
  };

  const tagResults = await mapWithConcurrency(
    publishItems,
    concurrency,
    async item => {
      try {
        const packument = await readPackument(item.targetName);
        if (packument === undefined) {
          return {
            currentTag: await registry.lookupRegistryDistTag(
              item.targetName,
              options.tag,
            ),
          };
        }
        return {
          currentTag:
            packument === null
              ? undefined
              : registryPackumentDistTag(
                  packument,
                  item.targetName,
                  options.tag,
                ),
        };
      } catch (error) {
        return { error };
      }
    },
  );
  // The base-change revision may only be computed once every member's current
  // tag is known, so this barrier stays between the two phases.
  for (const [index, item] of publishItems.entries()) {
    const result = tagResults[index];
    if (result.error) {
      failures.push(describeFailure(item, result.error));
      continue;
    }
    currentTags.set(item.targetName, result.currentTag);
  }
  const allowedBaseChangeRevision = nextBaseChangeRevision(
    options.version,
    currentTags.values(),
  );
  const stateResults = await mapWithConcurrency(
    publishItems,
    concurrency,
    async item => {
      if (!currentTags.has(item.targetName)) {
        return { skipped: true };
      }
      try {
        const currentTag = currentTags.get(item.targetName);
        const packument = await readPackument(item.targetName);
        let dist;
        if (packument === undefined) {
          dist = await registry.lookupRegistryPackageDist(
            item.targetName,
            item.version,
          );
        } else {
          dist =
            packument === null
              ? null
              : registryPackumentDist(packument, item.targetName, item.version);
        }
        if (dist !== null) {
          await registry.verifyRegistryPackageDist(
            item,
            dist,
            provenanceExpectation,
          );
          if (currentTag !== item.version) {
            throw new Error(
              `${item.targetName} dist-tag ${options.tag} points at ${currentTag ?? '<missing>'}, expected ${item.version}`,
            );
          }
          return { state: { currentTag, dist, exists: true } };
        }

        if (currentTag === item.version) {
          throw new Error(
            `${item.targetName} dist-tag ${options.tag} points at ${item.version}, but that exact registry version is absent`,
          );
        }
        if (currentTag !== undefined) {
          if (!semver.valid(item.version) || !semver.valid(currentTag)) {
            throw new Error(
              `${item.targetName} cannot compare candidate ${item.version} with current ${options.tag} ${currentTag} as strict semantic versions`,
            );
          }
          if (!semver.gt(item.version, currentTag)) {
            throw new Error(
              `${item.targetName}@${item.version} must be greater than current ${options.tag} ${currentTag}`,
            );
          }
          assertBaseRevisionReset(
            semver,
            item.targetName,
            item.version,
            currentTag,
            allowedBaseChangeRevision,
          );
        }
        const prefix = options.dryRun
          ? 'Dry-run registry preflight'
          : 'Registry publish preflight';
        return {
          notice: `${prefix}: ${item.targetName}@${item.version} is absent; provenance equivalence cannot be asserted before publication. Current ${options.tag}: ${currentTag ?? '<missing>'}.`,
          state: { currentTag, dist: null, exists: false },
        };
      } catch (error) {
        return { error };
      }
    },
  );
  for (const [index, item] of publishItems.entries()) {
    const result = stateResults[index];
    if (result.skipped) {
      continue;
    }
    if (result.error) {
      failures.push(describeFailure(item, result.error));
      continue;
    }
    states.set(item.targetName, result.state);
    if (result.notice) {
      console.log(result.notice);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      [
        `Registry publish preflight failed for ${options.version}.`,
        ...failures,
      ].join('\n'),
    );
  }
  return states;
}

async function publishPackage(artifact, options, overrides = {}) {
  const registry = {
    assertRegistryDistMatches,
    lookupRegistryPackageDist,
    verifyRegistryPackageDist,
    verifyRegistryProvenance,
    verifyRegistryTarball,
    ...overrides.registry,
  };
  const artifactReader =
    overrides.artifactReader ?? readVerifiedPackageArtifactBytes;
  const acceptedBytes = Buffer.from(
    artifactReader(artifact, artifact.artifactPath),
  );
  const publishAcceptedPackageImpl =
    overrides.publishAcceptedPackage ?? publishAcceptedPackage;
  const validateAcceptedPackageDryRunImpl =
    overrides.validateAcceptedPackageDryRun ?? validateAcceptedPackageDryRun;
  const wait = overrides.wait ?? sleep;
  const maxAttempts = options.dryRun ? 1 : npmPublishAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const acceptedArtifact = verifyPackageArtifactBytes(
      artifact,
      acceptedBytes,
    );
    try {
      try {
        if (options.dryRun) {
          await validateAcceptedPackageDryRunImpl(
            acceptedArtifact,
            acceptedBytes,
            options,
          );
        } else {
          await publishAcceptedPackageImpl(
            acceptedArtifact,
            acceptedBytes,
            options,
          );
        }
      } finally {
        verifyPackageArtifactBytes(artifact, acceptedBytes);
      }
    } catch (error) {
      if (!options.dryRun && options.provenanceExpectation) {
        const dist = await registry.lookupRegistryPackageDist(
          artifact.targetName,
          artifact.version,
        );
        if (dist !== null) {
          await registry.verifyRegistryPackageDist(
            artifact,
            dist,
            options.provenanceExpectation,
            {
              assertRegistryDistMatches: registry.assertRegistryDistMatches,
              verifyRegistryProvenance: registry.verifyRegistryProvenance,
              verifyRegistryTarball: registry.verifyRegistryTarball,
            },
          );
          console.log(
            `Reusing byte-identical ${artifact.targetName}@${artifact.version} after npm publish returned an error`,
          );
          return artifact.targetName;
        }
      }

      const shouldRetry =
        attempt < maxAttempts && isTransientNpmPublishError(error);
      if (!shouldRetry) {
        throw error;
      }

      const delay = npmPublishRetryDelayMs * attempt;
      console.warn(
        `npm publish for ${artifact.targetName}@${artifact.version} failed with a transient registry/provenance error; retrying attempt ${
          attempt + 1
        }/${maxAttempts} in ${delay}ms.`,
      );
      await wait(delay);
      continue;
    }

    return artifact.targetName;
  }
  return artifact.targetName;
}

const cohortVerificationFailureBudget = 3;

async function validateRegistryCohort(
  manifest,
  options,
  registry = { verifyRegistryDistTag, verifyRegistryPackage },
  now = () => performance.now(),
) {
  if (options.dryRun) {
    console.log('Skipping final registry cohort assertion for dry-run publish');
    return;
  }

  const provenanceExpectation = createRegistryProvenanceExpectation(manifest);
  let failureCount = 0;
  const outcomes = await mapWithConcurrency(
    manifest.packages,
    resolveRegistryConcurrency(options),
    async item => {
      // Every member keeps its full propagation window, but once this many have
      // definitively failed the cohort cannot become coherent, so the remaining
      // windows would only burn the job timeout.
      if (failureCount >= cohortVerificationFailureBudget) {
        return { unverified: true };
      }
      const startedAt = now();
      const elapsed = () => `${((now() - startedAt) / 1000).toFixed(1)}s`;
      try {
        await registry.verifyRegistryPackage(item, provenanceExpectation);
        await registry.verifyRegistryDistTag(
          item.targetName,
          options.tag,
          manifest.release.version,
        );
        console.log(`Registry verified ${item.targetName} in ${elapsed()}`);
        return {};
      } catch (error) {
        failureCount += 1;
        console.log(
          `Registry verification failed for ${item.targetName} after ${elapsed()}`,
        );
        return { error };
      }
    },
  );

  const failures = [];
  let unverified = 0;
  for (const [index, item] of manifest.packages.entries()) {
    const outcome = outcomes[index];
    if (outcome.unverified) {
      unverified += 1;
      continue;
    }
    if (outcome.error) {
      failures.push(
        `${item.targetName}@${manifest.release.version}: ${
          outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error)
        }`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        `Registry cohort validation failed for ${manifest.release.version}.`,
        `The ${options.tag} dist-tag is not coherent for the full cohort.`,
        ...failures,
        ...(unverified > 0
          ? [
              `Stopped after ${cohortVerificationFailureBudget} failed members; ${unverified} remaining member(s) were left unverified.`,
            ]
          : []),
      ].join('\n'),
    );
  }
}

async function publishManifestPackages(
  releaseArtifacts,
  options,
  overrides = {},
) {
  const registry = {
    assertRegistryDistMatches,
    lookupRegistryDistTag,
    lookupRegistryPackageDist,
    lookupRegistryPackument,
    preflightTrustedPublishingPackages,
    preflightRegistryPackages,
    publishPackage,
    validateRegistryCohort,
    verifyPackageArtifact,
    verifyRegistryDistTag,
    verifyRegistryPackage,
    verifyRegistryPackageDist,
    verifyRegistryProvenance,
    verifyRegistryTarball,
    ...overrides,
  };
  assertVerifiedReleaseArtifacts(releaseArtifacts);
  const { manifest } = releaseArtifacts;
  if (
    manifest.release.version !== options.version ||
    manifest.release.tag !== options.tag
  ) {
    throw new Error(
      `Verified release ${manifest.release.version} (${manifest.release.tag}) does not match publish request ${options.version} (${options.tag})`,
    );
  }
  const provenanceExpectation = createRegistryProvenanceExpectation(manifest);

  const artifactsByTarget = new Map(
    releaseArtifacts.packages.map(item => [item.targetName, item]),
  );
  const publishItems = manifest.publishOrder.map(targetName => {
    const artifact = artifactsByTarget.get(targetName);
    if (!artifact) {
      throw new Error(`Verified release is missing artifact ${targetName}`);
    }
    return artifact;
  });

  for (const artifact of publishItems) {
    registry.verifyPackageArtifact(artifact, artifact.artifactPath);
  }
  const preflight = await registry.preflightRegistryPackages(
    publishItems,
    options,
    provenanceExpectation,
    {
      lookupRegistryDistTag: registry.lookupRegistryDistTag,
      lookupRegistryPackageDist: registry.lookupRegistryPackageDist,
      lookupRegistryPackument: registry.lookupRegistryPackument,
      verifyRegistryPackageDist: registry.verifyRegistryPackageDist,
    },
  );
  const absentPublishItems = publishItems.filter(
    item => !preflight.get(item.targetName)?.exists,
  );
  if (!options.dryRun && absentPublishItems.length > 0) {
    await registry.preflightTrustedPublishingPackages(
      absentPublishItems,
      options,
      overrides.trustedPublishing,
    );
  }

  const levels = publishLevels(manifest).map(level =>
    level.map(targetName => artifactsByTarget.get(targetName)),
  );
  console.log(
    `Publishing ${publishItems.length} immutable package artifact(s) in ${levels.length} dependency level(s)`,
  );
  const publishOne = async artifact => {
    const state = preflight.get(artifact.targetName);
    if (!state) {
      throw new Error(
        `Registry preflight omitted ${artifact.targetName}@${artifact.version}`,
      );
    }
    if (!options.dryRun && state.exists) {
      console.log(
        `Reusing byte-identical ${artifact.targetName}@${artifact.version} for full-cohort publish`,
      );
      return;
    }

    const publishedName = await registry.publishPackage(artifact, {
      ...options,
      acceptedTools: manifest.tools,
      provenanceExpectation,
    });
    console.log(
      options.dryRun
        ? `Dry-run validated ${publishedName}@${artifact.version}`
        : `Published ${publishedName}@${artifact.version}`,
    );
    registry.verifyPackageArtifact(artifact, artifact.artifactPath);
  };
  // A level starts only after every publish of the previous level has
  // returned, so consumers never reach npm before their cohort dependencies.
  for (const level of levels) {
    await mapWithConcurrency(
      level,
      resolveRegistryConcurrency(options),
      publishOne,
    );
  }

  if (!options.dryRun) {
    await registry.validateRegistryCohort(manifest, options, {
      verifyRegistryDistTag: registry.verifyRegistryDistTag,
      verifyRegistryPackage: registry.verifyRegistryPackage,
    });
  }
}

export {
  assertRegistrySourceCommitUnpublished,
  assertRegistryDistMatches,
  createRegistryProvenanceExpectation,
  extractTarball,
  isRegistryNotFoundError,
  isTransientNpmPublishError,
  lookupRegistryDistTag,
  lookupRegistryPackageDist,
  lookupRegistryPackument,
  mapWithConcurrency,
  packSourcePackage,
  packageExists,
  preflightRegistryPackages,
  publishManifestPackages,
  publishPackage,
  validateRegistryCohort,
  verifyRegistryDistTag,
  verifyRegistryPackage,
  verifyRegistryPackageDist,
  verifyRegistryProvenance,
  verifyRegistryProvenanceChronology,
  verifyRegistryTarball,
};
