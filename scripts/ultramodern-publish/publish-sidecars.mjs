#!/usr/bin/env node
// Consumer: publish-bleedingdev.yml publish-sidecars job (runs BEFORE the cohort).
//
// The cohort package @bleedingdev/modern-js-image pins its sidecars through
// `npm:@bleedingdev/<name>@<exact version>` alias specifiers, which npm can
// only resolve once those exact versions already exist on the registry. This
// CLI publishes the staged sidecars, in alias order, from the same immutable
// release bundle the cohort publishes from, using the same npm trusted
// publishing OIDC exchange. There is no token path.
//
// Modes:
//   --check-registry bundle-free: cohort recipes or one closed sidecar profile
//   --check-staging  offline validation of the staged sidecar lane (no network)
//   --dry-run        plan against the live registry without publishing
//   (default)        publish, then re-verify the exact registry state
import fs from 'node:fs';
import path from 'node:path';
import cliKit from '../lib/cli-kit.js';
import validationKit from '../lib/validation-kit.js';
import { isDirectRun } from './lib/direct-run.mjs';
import { rejectInlineOptionSyntax } from './lib/option-syntax.mjs';
import { sleep } from './lib/prepare-bleedingdev-packages/commands.mjs';
import {
  repoRoot,
  sidecarAliasConsumerTargetName,
  sidecarManifestFile,
  sidecarTarballsDirectory,
} from './lib/prepare-bleedingdev-packages/constants.mjs';
import {
  assertAcceptedPublishToolchain,
  loadNpmPublishingRuntime,
  preflightTrustedPublishingPackages,
  requestTrustedPublishingToken,
} from './lib/prepare-bleedingdev-packages/npm-buffer-publisher.mjs';
import { resolveOwnedPreparationOutput } from './lib/prepare-bleedingdev-packages/options.mjs';
import {
  createRegistryProvenanceExpectation,
  RegistryProvenancePendingError,
  verifyRegistryProvenance,
} from './lib/prepare-bleedingdev-packages/provenance.mjs';
import { lookupRegistryPackument } from './lib/prepare-bleedingdev-packages/registry.mjs';
import {
  createRegistryPropagationDeadline,
  pollRegistryPropagation,
  registryPropagationBudgetMs,
} from './lib/prepare-bleedingdev-packages/registry-propagation.mjs';
import { verifyRegistryTarball } from './lib/prepare-bleedingdev-packages/registry-read.mjs';
import { verifyReleaseArtifacts } from './lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import {
  assertSidecarPublishOrder,
  assertSidecarPublishTarget,
  assertSidecarReuseProvenance,
  assertSidecarStagingManifest,
  assertSidecarTrustedPublishContext,
  npmRegistryUrl,
  sidecarContentProjection,
  sidecarPublishTag,
  sidecarRegistryDecision,
} from './lib/prepare-bleedingdev-packages/sidecar-publication.mjs';
import { sidecarProvenancePolicy } from './lib/prepare-bleedingdev-packages/sidecars.mjs';
import {
  readSidecarBundleInputs,
  resolveSidecarOutput,
  sidecarProfile,
  verifySidecarQualification,
} from './sidecar-bundle.mjs';

const { parseCliArgs } = cliKit;
const { isPlainObject } = validationKit;

const registryNotFoundPattern = /registry metadata returned HTTP 404$/u;
const initialPackumentDelaysMs = Object.freeze([2000, 3000, 5000]);

// The only registry states a post-publish wait may retry. Each one is a state
// the registry reaches on its own within the propagation window; nothing here
// describes a registry that disagrees with what this lane staged.
const propagationPendingStates = Object.freeze({
  // The packument itself is not readable yet (first version of a new package).
  packumentAbsent: 'packument-absent',
  // The version index has not caught up with the publish.
  versionAbsent: 'version-absent',
  // The dist-tag already names this exact version, but the version document is
  // not indexed yet. Only reachable for the version this run just published, so
  // it can never mean drift.
  versionAbsentTagClaimed: 'version-absent-tag-claimed',
  // The version is readable and identical, but the dist-tag has not moved yet.
  tagAbsent: 'tag-absent',
});

const resumableInitialStates = new Set([
  propagationPendingStates.versionAbsentTagClaimed,
  propagationPendingStates.tagAbsent,
]);

const cliValueOptions = new Set([
  '--out',
  '--tag',
  '--mode',
  '--profile',
  '--qualification',
  '--github-output',
]);
const cliBooleanOptions = new Set([
  '--check-registry',
  '--check-staging',
  '--dry-run',
]);

const sidecarRecipesUrl = new URL(
  '../ultramodern-supply/sidecars.json',
  import.meta.url,
);

function parseArgs(argv) {
  rejectInlineOptionSyntax(argv, {
    booleanOptions: cliBooleanOptions,
    valueOptions: cliValueOptions,
  });

  const options = parseCliArgs(argv, {
    defaults: {
      mode: 'cohort',
      profile: undefined,
      qualification: undefined,
      checkRegistry: false,
      checkStaging: false,
      dryRun: false,
      out: path.join(repoRoot, '.modern', 'bleedingdev-publish'),
      tag: sidecarPublishTag,
    },
    ignoreTerminator: true,
    options: {
      'check-registry': { key: 'checkRegistry', type: 'boolean' },
      'check-staging': { key: 'checkStaging', type: 'boolean' },
      'dry-run': { key: 'dryRun', type: 'boolean' },
      out: {},
      tag: {},
      mode: {},
      profile: {},
      qualification: {},
      'github-output': { key: 'githubOutput' },
    },
  });
  // reconcile-sidecars' decision: publish-sidecars runs only on `publish`.
  if (options.githubOutput !== undefined && !options.dryRun)
    throw new Error('--github-output requires --dry-run');

  if (
    [options.checkRegistry, options.checkStaging, options.dryRun].filter(
      Boolean,
    ).length > 1
  ) {
    throw new Error(
      '--check-registry, --check-staging and --dry-run are mutually exclusive',
    );
  }
  if (options.tag !== sidecarPublishTag) {
    throw new Error(
      `--tag must be ${sidecarPublishTag}; the cohort and its sidecars ship one dist-tag`,
    );
  }
  if (!['cohort', 'sidecars'].includes(options.mode))
    throw new Error('--mode must be cohort or sidecars');
  if (options.checkRegistry) {
    const incompatible = ['--out', '--qualification', '--tag'].filter(option =>
      argv.includes(option),
    );
    if (incompatible.length > 0)
      throw new Error(
        `--check-registry is bundle-free and cannot use ${incompatible.join(', ')}`,
      );
    if (options.mode === 'sidecars') {
      if (options.profile === undefined)
        throw new Error('--mode sidecars --check-registry requires --profile');
      sidecarProfile(options.profile);
    } else if (options.profile !== undefined) {
      throw new Error('--profile requires --mode sidecars --check-registry');
    }
    return options;
  }
  if (options.profile !== undefined)
    throw new Error('--profile requires --mode sidecars --check-registry');
  if (options.mode === 'sidecars') {
    if (!argv.includes('--out'))
      options.out = path.join(
        repoRoot,
        '.modern',
        'bleedingdev-sidecars',
        'bundle',
      );
    if (!options.qualification)
      throw new Error('Independent sidecars require --qualification');
    options.out = resolveSidecarOutput(options.out);
    options.qualification = resolveSidecarOutput(options.qualification);
  } else {
    if (options.qualification)
      throw new Error('--qualification is independent-sidecar-only');
    options.out = resolveOwnedPreparationOutput(options.out);
  }
  return options;
}

/**
 * Read the staged sidecar lane from the release bundle and re-derive its
 * identity from the staged bytes rather than trusting sidecars.json alone.
 */
function readStagedSidecars(
  releaseDir,
  {
    verifyRelease = verifyReleaseArtifacts,
    mode = 'cohort',
    qualification,
  } = {},
) {
  const release =
    mode === 'sidecars'
      ? verifySidecarQualification(releaseDir, qualification)
      : verifyRelease(releaseDir);
  if (!release.sidecars) {
    throw new Error(
      `Missing accepted ${sidecarManifestFile} in ${releaseDir}; stage the release with --include-sidecars before publishing sidecars`,
    );
  }
  const manifest = assertSidecarStagingManifest(release.sidecars.manifest, {
    publishBefore:
      mode === 'sidecars'
        ? sidecarProfile(release.manifest.profile).publishBefore
        : sidecarAliasConsumerTargetName,
  });
  const byName = new Map(
    release.sidecars.packages.map(sidecar => [sidecar.name, sidecar]),
  );
  const sidecars = manifest.packages.map(entry => {
    const accepted = byName.get(entry.name);
    if (!accepted) {
      throw new Error(
        `Accepted sidecar ${entry.name}@${entry.version} has no verified tarball`,
      );
    }
    if (
      accepted.packageJson.name !== entry.name ||
      accepted.packageJson.version !== entry.version
    ) {
      throw new Error(
        `Accepted sidecar ${entry.name}@${entry.version} contains ${String(accepted.packageJson.name)}@${String(accepted.packageJson.version)}`,
      );
    }
    assertSidecarPublishTarget(
      accepted.packageJson,
      `Sidecar ${entry.name}@${entry.version}`,
    );
    return {
      ...entry,
      bytes: accepted.bytes,
      packageJson: accepted.packageJson,
    };
  });

  assertSidecarPublishOrder(sidecars);
  return { manifest, release, sidecars };
}

async function readSidecarPackument(name, fetchImpl = globalThis.fetch) {
  try {
    // An explicit fetchImpl bypasses the process-wide packument memo, so the
    // post-publish re-read observes the registry as it is now.
    return await lookupRegistryPackument(name, { fetchImpl });
  } catch (error) {
    if (
      registryNotFoundPattern.test(error instanceof Error ? error.message : '')
    ) {
      return null;
    }
    throw error;
  }
}

// npm trusted publishing publishes to an EXISTING package with a configured
// trusted publisher; the OIDC exchange cannot create a package name, so a first
// publish is a deliberate, authorized, interactive act.
function sidecarBootstrapError(sidecars, observation) {
  return new Error(
    [
      ...sidecars.map(
        sidecar =>
          `${sidecar.name} ${observation}, so the trusted-publishing lane cannot create it.`,
      ),
      'npm trusted publishing publishes to an existing package with a configured trusted publisher; the OIDC token cannot bootstrap a new package name.',
      ...sidecars.map(
        sidecar =>
          `Bootstrap ${sidecar.name} interactively once, with explicit authorization, as a deprecated 0.0.0-bootstrap placeholder; record it in its sidecars.json provenance.grandfatheredVersions, configure this workflow as its trusted publisher on npm and re-run this lane.`,
      ),
      'This lane fails closed in both dry-run and publication modes rather than claiming a publish it cannot perform.',
    ].join('\n'),
  );
}

function readRecipeSidecars(recipesUrl = sidecarRecipesUrl) {
  return JSON.parse(fs.readFileSync(recipesUrl, 'utf8')).map(recipe => ({
    name: recipe.fork.name,
    version: recipe.fork.version,
  }));
}

/**
 * Bundle-free registry gate for the start of the release. Reads the sidecar
 * recipes and fails on the first registry read when any fork name does not
 * exist on npm, instead of after the bundle build and clean-room acceptance.
 * No propagation wait: a name that does not exist yet is never going to
 * appear without an interactive bootstrap.
 *
 * Trusted-publisher configuration is not checked here: npm serves it only to
 * an authenticated maintainer (GET /-/package/<name>/trust answers 401), and
 * this workflow holds no stored token. A missing trusted publisher still fails
 * at the OIDC exchange in publish-sidecars.
 */
async function checkSidecarRegistry(
  dependencies = {},
  { mode = 'cohort', profile } = {},
) {
  if (!['cohort', 'sidecars'].includes(mode))
    throw new Error('--mode must be cohort or sidecars');
  if (mode === 'sidecars') {
    if (profile === undefined)
      throw new Error('--mode sidecars --check-registry requires --profile');
    sidecarProfile(profile);
  } else if (profile !== undefined) {
    throw new Error('--profile requires --mode sidecars --check-registry');
  }
  const sidecars =
    mode === 'sidecars'
      ? readSidecarBundleInputs(profile)
      : (dependencies.readRecipes ?? readRecipeSidecars)();
  const readPackument = dependencies.readPackument ?? readSidecarPackument;
  const packuments = await Promise.all(
    sidecars.map(sidecar => readPackument(sidecar.name)),
  );
  const missing = sidecars.filter(
    (_, index) => packuments[index] === null || packuments[index] === undefined,
  );
  if (missing.length > 0) {
    throw sidecarBootstrapError(missing, 'does not exist on the registry');
  }
  const checked = sidecars.map(sidecar => sidecar.name);
  console.log(
    `Registry check: all ${checked.length} sidecar name(s) exist on npm.`,
  );
  return { checked };
}

async function publishSidecarBuffer(
  sidecar,
  bytes,
  options,
  dependencies = {},
) {
  const runtime = (dependencies.loadRuntime ?? loadNpmPublishingRuntime)();
  assertAcceptedPublishToolchain(options.acceptedTools, runtime);
  const requestToken =
    dependencies.requestToken ?? requestTrustedPublishingToken;
  const token = await requestToken(sidecar.name, {
    registryUrl: npmRegistryUrl,
  });
  // The lane's last chance to stop: nothing below is reversible.
  options.assertMayPublish?.();
  const registry = new URL(npmRegistryUrl);
  const authKey = `//${registry.host}${registry.pathname}:_authToken`;
  await runtime.publish(sidecar.packageJson, bytes, {
    access: 'public',
    defaultTag: options.tag,
    npmVersion: runtime.npmVersion,
    provenance: true,
    registry: npmRegistryUrl,
    [authKey]: token,
  });
  return { npmVersion: runtime.npmVersion };
}

/**
 * Classify a post-publish registry read as "still propagating" or "settled".
 *
 * Returns a typed pending state while the registry has simply not caught up
 * with the publish this lane just performed, and `null` the moment the read is
 * decisive - at which point `sidecarRegistryDecision` owns the verdict.
 *
 * The distinction that matters: a MISSING dist-tag is transient (npm writes the
 * version document and the dist-tag separately), while a dist-tag pointing at a
 * DIFFERENT real version is terminal - that is another publisher's tag, not a
 * slow one, and no amount of waiting turns it into ours. Content drift is
 * terminal for the same reason: an npm version is immutable.
 *
 * Every pending answer is proved, not assumed: before reporting a transient
 * state this re-runs `sidecarRegistryDecision`, so a terminal condition hiding
 * behind a missing tag (content drift, a backwards `latest`) still throws.
 */
async function classifySidecarPropagation(sidecar, packument, { tag }) {
  if (packument === null || packument === undefined) {
    return {
      detail: `${sidecar.name} is not readable on the registry yet`,
      state: propagationPendingStates.packumentAbsent,
    };
  }
  if (!isPlainObject(packument)) {
    return null;
  }
  const distTags = packument['dist-tags'];
  const versions = packument.versions;
  // Anything malformed or mis-identified is decisive: sidecarRegistryDecision
  // rejects it rather than this lane waiting on a registry that is not ours.
  if (
    packument.name !== sidecar.name ||
    !isPlainObject(distTags) ||
    !isPlainObject(versions)
  ) {
    return null;
  }
  const currentTag =
    typeof distTags[tag] === 'string' ? distTags[tag] : undefined;

  if (!Object.hasOwn(versions, sidecar.version)) {
    if (currentTag === sidecar.version) {
      return {
        detail: `${sidecar.name} dist-tag ${tag} already names ${sidecar.version}, but the version document is not indexed yet`,
        state: propagationPendingStates.versionAbsentTagClaimed,
      };
    }
    // Throws on a backwards `latest`; returns `publish` while genuinely absent.
    await sidecarRegistryDecision(sidecar, packument, { tag });
    return {
      detail: `${sidecar.name}@${sidecar.version} is still absent from the registry`,
      state: propagationPendingStates.versionAbsent,
    };
  }

  if (currentTag !== undefined) {
    // The version and the dist-tag are both readable: decisive either way.
    return null;
  }

  // The version is readable but untagged. Confirm the published bytes are the
  // staged bytes before waiting - content drift can never resolve itself.
  await sidecarRegistryDecision(
    sidecar,
    { ...packument, 'dist-tags': { ...distTags, [tag]: sidecar.version } },
    { tag },
  );
  return {
    detail: `${sidecar.name} dist-tag ${tag} has not propagated to ${sidecar.version} yet`,
    state: propagationPendingStates.tagAbsent,
  };
}

// Post-publish, the sidecar lane waits on the same bounded propagation schedule
// as the cohort: npm has needed minutes, not seconds, before a freshly
// published version is readable (run 36137116871).
async function awaitPublishedSidecar(sidecar, options, dependencies = {}) {
  const readPackument = dependencies.readPackument ?? readSidecarPackument;
  const classify =
    dependencies.classifyPropagation ?? classifySidecarPropagation;
  const outcome = await pollRegistryPropagation(
    async () => {
      const packument = await readPackument(sidecar.name);
      // A throw from either call is terminal by construction: the classifier
      // only ever returns a pending state it has already proved is transient.
      const pending = await classify(sidecar, packument, { tag: options.tag });
      if (pending === null) {
        return {
          settled: true,
          value: await sidecarRegistryDecision(sidecar, packument, {
            tag: options.tag,
          }),
        };
      }
      return { detail: pending.detail, settled: false };
    },
    { wait: dependencies.wait },
  );
  if (outcome.settled) {
    return outcome.value;
  }
  throw new Error(
    `Published sidecar ${sidecar.name}@${sidecar.version} did not become verifiable after ${outcome.attempts} registry reads: ${outcome.detail}`,
  );
}

// npm declares a version's `dist.attestations` and serves its attestation
// bundle only some time after the version itself is readable (the cohort
// verifier observed 404s a minute after publish), so a version younger than
// one propagation budget can still be mid-publication.
const attestationLagMs = registryPropagationBudgetMs;

/**
 * A non-grandfathered version published within one propagation window, or
 * undefined. Only such a version can still gain its provenance; an older one
 * that fails verification never will.
 */
function propagatingSidecarVersion(sidecar, packument, now = Date.now()) {
  const grandfathered = new Set(
    (sidecarProvenancePolicy(sidecar.name).grandfatheredVersions ?? []).map(
      entry => entry.version,
    ),
  );
  return Object.keys(packument.versions ?? {}).find(
    version =>
      !grandfathered.has(version) &&
      now - Date.parse(packument.time?.[version]) < attestationLagMs,
  );
}

/**
 * Reuse requires the registry provenance chronology. A null read (a replica
 * that has not seen the package yet) is pending. While a non-grandfathered
 * version is younger than the propagation window, a failed verification is
 * re-read on the shared schedule, as the cohort verifier does after
 * publishing; otherwise the first failure is terminal. `packument`, when
 * given, answers the first read.
 */
async function awaitSidecarReuseProvenance(
  sidecar,
  packument,
  { source },
  dependencies = {},
) {
  const readPackument = dependencies.readPackument ?? readSidecarPackument;
  const verify = dependencies.verifyReuse ?? assertSidecarReuseProvenance;
  let lastSeen;
  const outcome = await pollRegistryPropagation(
    async attempt => {
      const current =
        attempt === 1 && packument
          ? packument
          : await readPackument(sidecar.name);
      if (current === null || current === undefined) {
        return {
          detail: `${sidecar.name} is not readable on the registry`,
          settled: false,
        };
      }
      lastSeen = current;
      try {
        await verify(sidecar, current, { source });
        return { settled: true };
      } catch (error) {
        const propagating = propagatingSidecarVersion(sidecar, lastSeen);
        if (!propagating) throw error;
        return {
          detail: `${sidecar.name}@${propagating} provenance is still propagating: ${error instanceof Error ? error.message : String(error)}`,
          settled: false,
        };
      }
    },
    { wait: dependencies.wait },
  );
  if (!outcome.settled) {
    throw new Error(
      `Reused sidecar ${sidecar.name}@${sidecar.version} provenance did not become verifiable after ${outcome.attempts} registry reads: ${outcome.detail}`,
    );
  }
}

async function verifyFreshSidecar(sidecar, { source }, dependencies = {}) {
  const readPackument = dependencies.readPackument ?? readSidecarPackument;
  const exactProvenance =
    dependencies.verifyFreshProvenance ?? verifyRegistryProvenance;
  const verifyTarball =
    dependencies.verifyFreshTarball ?? verifyRegistryTarball;
  // The sidecar set's propagation deadline. npm served
  // @bleedingdev/mf-dts-plugin@2.9.5's tarball later than the old per-call
  // 2-minute window allowed (run 43804632305, 11.4 min of wall clock lost);
  // one deadline for the whole lane waits that out without multiplying the
  // wait by the number of sidecars in flight.
  const deadline =
    dependencies.propagationDeadline ?? createRegistryPropagationDeadline();
  const expectation = createRegistryProvenanceExpectation({ source });
  if (!expectation.invocation)
    throw new Error(
      'Fresh sidecar provenance requires its workflow run and attempt',
    );
  expectation.invocation.exactAttempt = true;
  const outcome = await pollRegistryPropagation(
    async () => {
      const packument = await readPackument(sidecar.name);
      const pending = await classifySidecarPropagation(sidecar, packument, {
        tag: sidecarPublishTag,
      });
      if (pending) return { settled: false, detail: pending.detail };
      await sidecarRegistryDecision(sidecar, packument);
      const dist = packument.versions[sidecar.version].dist;
      await verifyTarball({ ...sidecar, targetName: sidecar.name }, dist, {
        deadline,
      });
      if (
        !Object.hasOwn(dist, 'attestations') ||
        (isPlainObject(dist.attestations) &&
          !Object.hasOwn(dist.attestations, 'provenance'))
      ) {
        return {
          settled: false,
          detail: `${sidecar.name}@${sidecar.version} provenance metadata is not indexed yet`,
        };
      }
      try {
        await exactProvenance(
          { ...sidecar, targetName: sidecar.name },
          dist,
          expectation,
        );
      } catch (error) {
        if (error instanceof RegistryProvenancePendingError)
          return { settled: false, detail: error.message };
        throw error;
      }
      await (dependencies.verifyReuse ?? assertSidecarReuseProvenance)(
        sidecar,
        packument,
        { source },
      );
      return { settled: true };
    },
    { wait: dependencies.wait },
  );
  if (!outcome.settled)
    throw new Error(
      `Published sidecar ${sidecar.name}@${sidecar.version} provenance did not verify: ${outcome.detail}`,
    );
}

async function awaitInitialSidecarPackument(sidecar, dependencies = {}) {
  const readPackument = dependencies.readPackument ?? readSidecarPackument;
  const wait = dependencies.wait ?? sleep;
  for (const delayMs of initialPackumentDelaysMs) {
    await wait(delayMs);
    const packument = await readPackument(sidecar.name);
    if (packument !== null && packument !== undefined) {
      return packument;
    }
  }
  return null;
}

async function publishSidecars(options, dependencies = {}) {
  const readSidecars = dependencies.readSidecars ?? readStagedSidecars;
  const { manifest, release, sidecars } = readSidecars(options.out, options);
  const acceptedTools = release.manifest.tools;
  const plan = sidecars.map(sidecar => `${sidecar.name}@${sidecar.version}`);
  console.log(
    [
      `Sidecar publication order (before ${manifest.publishBefore}): ${plan.join(' -> ')}`,
    ].join('\n'),
  );

  if (options.checkStaging) {
    console.log(
      `Staging check only: ${sidecars.length} sidecar(s) validated offline; nothing was published.`,
    );
    return { published: [], reused: [], validated: plan };
  }

  const readPackument = dependencies.readPackument ?? readSidecarPackument;
  // One propagation deadline for the whole sidecar set, so eleven sidecars
  // waiting on npm's read-after-write lag cost one propagation window between
  // them instead of one each.
  const freshSidecarDependencies = {
    ...dependencies,
    propagationDeadline:
      dependencies.propagationDeadline ?? createRegistryPropagationDeadline(),
  };
  const verifyReuse = (sidecar, packument) =>
    awaitSidecarReuseProvenance(
      sidecar,
      packument,
      { source: release.manifest.source },
      { ...dependencies, readPackument },
    );
  const published = [];
  const reused = [];
  // Sidecars publish in alias order, so an alias target version exists on the
  // registry before anything that aliases it is published. Read-side
  // propagation is verified concurrently: every published sidecar must become
  // verifiable before the lane reports success (and so before the cohort), but
  // the lane's wall clock is one propagation window, not one per sidecar or
  // per alias level (the job has a fixed timeout).
  for (const sidecar of sidecars) {
    assertSidecarPublishTarget(sidecar.packageJson, sidecar.name);
    sidecarContentProjection(sidecar.packageJson, sidecar.name);
  }
  const missingNames = [];
  const absentVersions = [];
  for (const sidecar of sidecars) {
    let packument = await readPackument(sidecar.name);
    if (packument === null || packument === undefined) {
      packument = await awaitInitialSidecarPackument(sidecar, {
        ...dependencies,
        readPackument,
      });
    }
    if (packument === null || packument === undefined) {
      missingNames.push(sidecar);
      continue;
    }
    const pending = await classifySidecarPropagation(sidecar, packument, {
      tag: options.tag,
    });
    if (pending && resumableInitialStates.has(pending.state)) {
      await awaitPublishedSidecar(sidecar, options, dependencies);
      await verifyReuse(sidecar, undefined);
    } else {
      const decision = await sidecarRegistryDecision(sidecar, packument, {
        tag: options.tag,
      });
      if (decision.action === 'publish')
        absentVersions.push({ targetName: sidecar.name });
      else await verifyReuse(sidecar, packument);
    }
  }
  if (missingNames.length > 0)
    throw sidecarBootstrapError(
      missingNames,
      'does not exist on the registry after the bounded propagation wait',
    );
  const preflightPublishNames = new Set(
    absentVersions.map(item => item.targetName),
  );
  if (!options.dryRun && absentVersions.length > 0) {
    assertSidecarTrustedPublishContext();
    assertAcceptedPublishToolchain(
      acceptedTools,
      (dependencies.loadRuntime ?? loadNpmPublishingRuntime)(),
    );
    await (dependencies.preflightTokens ?? preflightTrustedPublishingPackages)(
      absentVersions,
      { registryUrl: npmRegistryUrl },
      dependencies,
    );
  }
  const propagating = [];
  let propagationFailure;
  const assertNoPropagationFailure = () => {
    if (propagationFailure) {
      throw propagationFailure.error;
    }
  };
  const trackPropagation = (sidecar, settledMessage) => {
    const verification = awaitPublishedSidecar(
      sidecar,
      options,
      dependencies,
    ).then(async decision => {
      await verifyFreshSidecar(
        sidecar,
        { source: release.manifest.source },
        freshSidecarDependencies,
      );
      console.log(settledMessage(decision));
    });
    // Record the first failure so the lane stops publishing; the rejection
    // itself is still surfaced by the final Promise.all.
    verification.catch(error => {
      propagationFailure ??= { error };
    });
    propagating.push(verification);
  };
  for (const sidecar of sidecars) {
    let packument = await readPackument(sidecar.name);
    if (packument === null || packument === undefined) {
      packument = await awaitInitialSidecarPackument(sidecar, {
        ...dependencies,
        readPackument,
      });
    }
    const pending = await classifySidecarPropagation(sidecar, packument, {
      tag: options.tag,
    });
    // A previous run may have published this exact version and stopped while npm
    // was indexing it. Resume only when the registry itself proves that claim:
    // the tag already names this version, or the identical version is readable
    // and only its tag is missing. An absent package/version still takes the
    // ordinary publish/bootstrap path instead of sleeping on an assumption.
    if (pending && resumableInitialStates.has(pending.state)) {
      // Another publisher's version is reused only after it proves the same
      // provenance chronology as an indexed one, and nothing later publishes
      // before it has: a later sidecar may alias it.
      const decision = await awaitPublishedSidecar(
        sidecar,
        options,
        dependencies,
      );
      await verifyReuse(sidecar, undefined);
      console.log(`Reusing ${decision.reason}`);
      reused.push(`${sidecar.name}@${sidecar.version}`);
      continue;
    }
    const decision = await sidecarRegistryDecision(sidecar, packument, {
      tag: options.tag,
    });
    if (decision.action === 'reuse') {
      await verifyReuse(sidecar, packument);
      console.log(`Reusing ${decision.reason}`);
      reused.push(`${sidecar.name}@${sidecar.version}`);
      continue;
    }

    if (packument === null || packument === undefined) {
      throw sidecarBootstrapError(
        [sidecar],
        'does not exist on the registry after the bounded propagation wait',
      );
    }
    if (options.dryRun) {
      console.log(
        `Dry-run: would publish ${sidecar.name}@${sidecar.version} at ${options.tag} (${decision.reason})`,
      );
      published.push(`${sidecar.name}@${sidecar.version}`);
      continue;
    }

    if (!preflightPublishNames.has(sidecar.name))
      throw new Error(
        `Sidecar ${sidecar.name} registry state changed after the complete publication preflight`,
      );
    assertSidecarTrustedPublishContext();
    // An earlier sidecar's verification may have failed during any await
    // above; the publisher re-checks after its own token await as well.
    assertNoPropagationFailure();
    await publishSidecarBuffer(
      sidecar,
      sidecar.bytes,
      {
        ...options,
        acceptedTools,
        assertMayPublish: assertNoPropagationFailure,
      },
      dependencies,
    );
    trackPropagation(
      sidecar,
      () => `Published ${sidecar.name}@${sidecar.version} at ${options.tag}`,
    );
    published.push(`${sidecar.name}@${sidecar.version}`);
  }
  await Promise.all(propagating);

  console.log(
    [
      options.dryRun
        ? `Dry-run validated ${plan.length} sidecar(s) before ${manifest.publishBefore}.`
        : `Sidecar lane complete: ${published.length} published, ${reused.length} reused, all readable before ${manifest.publishBefore}.`,
    ].join('\n'),
  );
  return { published, reused, validated: plan };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await (options.checkRegistry
    ? checkSidecarRegistry({}, options)
    : publishSidecars(options));
  if (options.githubOutput !== undefined)
    writeSidecarDecision(options.githubOutput, result);
}

function writeSidecarDecision(githubOutput, { published, reused }) {
  const decision = published.length > 0 ? 'publish' : 'reuse';
  fs.appendFileSync(githubOutput, `decision=${decision}\n`);
  console.log(
    `Sidecar decision: ${decision} (${published.length} to publish, ${reused.length} reused)`,
  );
}

if (isDirectRun(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export {
  awaitInitialSidecarPackument,
  awaitPublishedSidecar,
  awaitSidecarReuseProvenance,
  checkSidecarRegistry,
  classifySidecarPropagation,
  initialPackumentDelaysMs,
  parseArgs,
  propagationPendingStates,
  publishSidecarBuffer,
  publishSidecars,
  readSidecarPackument,
  readStagedSidecars,
  sidecarTarballsDirectory,
  verifyFreshSidecar,
  writeSidecarDecision,
};
