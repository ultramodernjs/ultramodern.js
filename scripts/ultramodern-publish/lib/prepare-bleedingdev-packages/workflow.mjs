// Consumer: prepare-bleedingdev-packages.mjs release staging and publish orchestration.
import fs from 'node:fs';
import path from 'node:path';
import fsKit from '../../../lib/fs-kit.js';
import {
  repoRoot,
  sidecarAliasConsumerTargetName,
  trustedPublishRef,
  trustedPublishRepository,
  isTrustedPublishRepositoryContext,
} from './constants.mjs';
import {
  bindCiRedactSidecar,
  collectSidecarPackages,
  stageSidecarPackages,
  validateAliasConsistency,
  writeSidecarStagingManifest,
} from './sidecars.mjs';
import {
  collectModernPackages,
  enforceSingleVersionPolicy,
  rewritePackageJson,
  targetPackageName,
} from './rewrite.mjs';
import {
  normalizeDeclaredTypePaths,
  validateStagedTypeFiles,
} from './types.mjs';
import { validatePublishManifest } from './manifest.mjs';
import {
  assertCohortRecipeConsumers,
  assertRepositoryRecipeConsumers,
} from '../../../ultramodern-supply/verify-sidecars.mjs';
import {
  createReleaseArtifacts,
  resolveSourceIdentity,
  verifyReleaseArtifacts,
} from './release-artifacts.mjs';
import {
  extractTarball,
  packSourcePackage,
  publishManifestPackages,
} from './registry.mjs';
import { assertCleanCommittedSource } from '../release-source-state.mjs';
import { resolveOwnedPreparationOutput } from './options.mjs';

const { readJsonFile, writeJsonFile } = fsKit;

function assertSidecarAliasConsumerCount(count) {
  if (count !== 1) {
    throw new Error(
      `Sidecar staging requires exactly one ${sidecarAliasConsumerTargetName} cohort package, found ${count}`,
    );
  }
}

function assertTrustedPublishContext() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error(
      'Publishing is only allowed from the GitHub Actions trusted publishing workflow. Run without --publish locally to prepare and validate packages.',
    );
  }

  if (!isTrustedPublishRepositoryContext(process.env)) {
    throw new Error(
      `Publishing is only allowed from ${trustedPublishRepository}.`,
    );
  }

  if (process.env.GITHUB_REF !== trustedPublishRef) {
    throw new Error(`Publishing is only allowed from ${trustedPublishRef}.`);
  }
}

async function prepareBleedingdevPackages(options) {
  if (!options.publishExisting) {
    options.out = resolveOwnedPreparationOutput(options.out);
  }

  const sourceCommit = assertCleanCommittedSource(repoRoot);
  const { allPackages, aliases, packages, sourceNames } =
    collectModernPackages(options);
  enforceSingleVersionPolicy(options, packages, allPackages);
  // Fail before reconstruction, packing, or any registry write. Checking source
  // also covers --publish-existing and preparation without --include-sidecars.
  assertCohortRecipeConsumers(
    packages.map(({ packageJson }) => ({
      ...packageJson,
      name: targetPackageName(packageJson.name, options),
    })),
    options,
  );

  if (options.publishExisting) {
    assertCleanCommittedSource(repoRoot, { expectedCommit: sourceCommit });
    const checkoutSource = { ...resolveSourceIdentity(), commit: sourceCommit };
    const releaseArtifacts = verifyReleaseArtifacts(options.out, {
      aliases,
      sourceNames: [...sourceNames],
      tag: options.tag,
      version: options.version,
    });
    // Recovery must validate the immutable tarball manifests as well: a fixed
    // checkout cannot authorize an older candidate with the upstream edge.
    assertRepositoryRecipeConsumers(
      releaseArtifacts.packages.map(item => item.packageJson),
    );
    if (
      releaseArtifacts.manifest.source.repository !== checkoutSource.repository
    ) {
      throw new Error(
        `Release artifact repository ${releaseArtifacts.manifest.source.repository} does not match trusted checkout ${checkoutSource.repository}`,
      );
    }
    assertTrustedPublishContext();
    await publishManifestPackages(releaseArtifacts, options);
    return;
  }

  const packDir = path.join(options.out, 'source-tarballs');
  const stageDir = path.join(options.out, 'packages');
  // Read the sidecar roots before the output directory is recreated so an
  // invalid sidecar fails the run before anything is staged.
  const sidecars = options.includeSidecars
    ? collectSidecarPackages(repoRoot)
    : [];

  options.out = resolveOwnedPreparationOutput(options.out);
  fs.rmSync(options.out, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const stagedSidecars = options.includeSidecars
    ? await stageSidecarPackages(sidecars, options.out)
    : [];

  const stagingManifest = {
    aliases,
    packages: [],
  };
  const stagedManifests = [];
  let sidecarAliasConsumerCount = 0;

  for (const item of packages) {
    const sourceName = item.packageJson.name;
    const targetName = targetPackageName(sourceName, options);
    const tarball = packSourcePackage(sourceName, packDir);
    const packageDir = extractTarball(
      tarball,
      path.join(stageDir, targetName.replaceAll('/', '__')),
    );
    const packageJsonPath = path.join(packageDir, 'package.json');
    const packageJson = readJsonFile(packageJsonPath);
    rewritePackageJson(packageJson, sourceName, options, sourceNames);
    bindCiRedactSidecar(packageJson, options, stagedSidecars);
    if (targetName === sidecarAliasConsumerTargetName)
      sidecarAliasConsumerCount += 1;
    normalizeDeclaredTypePaths(packageDir, packageJson);
    writeJsonFile(packageJsonPath, packageJson);
    validateStagedTypeFiles(packageDir, packageJson);

    stagedManifests.push({ name: targetName, packageJson });
    stagingManifest.packages.push({
      sourceName,
      targetName,
      version: options.version,
      packageDir: path.relative(repoRoot, packageDir),
    });
  }

  let sidecarDescriptor = null;
  if (options.includeSidecars) {
    assertSidecarAliasConsumerCount(sidecarAliasConsumerCount);
    assertRepositoryRecipeConsumers(
      stagedManifests.map(item => item.packageJson),
    );
    validateAliasConsistency(stagedManifests, stagedSidecars, {
      cohortTargetNames: new Set(Object.values(aliases)),
    });
    const {
      descriptor,
      manifest: sidecarManifest,
      manifestPath,
    } = writeSidecarStagingManifest(options.out, stagedSidecars, {
      publishBefore: sidecarAliasConsumerTargetName,
    });
    sidecarDescriptor = descriptor;
    console.log(
      [
        `Staged ${sidecarManifest.packages.length} version-preserving sidecar package(s): ${sidecarManifest.packages
          .map(item => `${item.name}@${item.version}`)
          .join(', ')}`,
        `Publish order recorded in ${path.relative(repoRoot, manifestPath)}; these must reach npm before ${sidecarAliasConsumerTargetName}.`,
      ].join('\n'),
    );
  }

  validatePublishManifest(stagingManifest);
  assertCleanCommittedSource(repoRoot, { expectedCommit: sourceCommit });
  const releaseArtifacts = createReleaseArtifacts({
    aliases,
    outDir: options.out,
    packages: stagingManifest.packages,
    sidecars: sidecarDescriptor,
    source: { ...resolveSourceIdentity(), commit: sourceCommit },
    tag: options.tag,
    version: options.version,
  });
  assertRepositoryRecipeConsumers(
    releaseArtifacts.packages.map(item => item.packageJson),
  );

  console.log(
    `Prepared ${releaseArtifacts.manifest.packages.length} immutable package artifact(s) under ${path.relative(repoRoot, options.out)}`,
  );

  if (!options.publish) {
    console.log(
      'Publish skipped. GitHub Actions trusted publishing is required for npm publish.',
    );
    return;
  }

  assertTrustedPublishContext();
  await publishManifestPackages(releaseArtifacts, options);
}

export { assertSidecarAliasConsumerCount, prepareBleedingdevPackages };
