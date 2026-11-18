// Consumer: publish-bleedingdev.yml full-cohort publish order and identity checks.
import fs from 'node:fs';
import path from 'node:path';
import fsKit from '../../../lib/fs-kit.js';
import {
  incorporatedModernCreateSourceName,
  repoRoot,
  retiredBleedingdevCreateTargetName,
  ultramodernCreateSourceName,
  ultramodernCreateTargetName,
} from './constants.mjs';
import { validateCreateTemplateFiles } from './types.mjs';

const { readJsonFile } = fsKit;

function validateFullCohortManifest(manifest) {
  const legacyCreate = manifest.packages.find(
    item =>
      item.sourceName === incorporatedModernCreateSourceName ||
      item.targetName === retiredBleedingdevCreateTargetName,
  );
  if (
    legacyCreate ||
    Object.hasOwn(manifest.aliases, incorporatedModernCreateSourceName) ||
    Object.values(manifest.aliases).includes(retiredBleedingdevCreateTargetName)
  ) {
    throw new Error(
      `${incorporatedModernCreateSourceName} is the release-base anchor and must never be published as ${retiredBleedingdevCreateTargetName}.`,
    );
  }
  if (
    manifest.aliases[ultramodernCreateSourceName] !==
      ultramodernCreateTargetName ||
    !manifest.packages.some(
      item =>
        item.sourceName === ultramodernCreateSourceName &&
        item.targetName === ultramodernCreateTargetName,
    )
  ) {
    throw new Error(
      `BleedingDev publish manifest must select ${ultramodernCreateSourceName} as ${ultramodernCreateTargetName}.`,
    );
  }
  const selectedSources = new Set(
    manifest.packages.map(item => item.sourceName),
  );
  const missing = Object.keys(manifest.aliases)
    .filter(sourceName => !selectedSources.has(sourceName))
    .sort((a, b) => a.localeCompare(b));

  if (missing.length > 0) {
    throw new Error(
      [
        `BleedingDev publish manifest is missing ${missing.length} public package(s).`,
        'Every public @modern-js/* package must be in the exact-version cohort before any final dist-tag promotion.',
        `Missing packages: ${missing.join(', ')}`,
      ].join('\n'),
    );
  }
}

function validateNoWorkspaceProtocol(packageJson, packageName, blockName) {
  const block = packageJson[blockName];
  if (!block || typeof block !== 'object') {
    return;
  }

  for (const [dependencyName, specifier] of Object.entries(block)) {
    if (typeof specifier === 'string' && specifier.startsWith('workspace:')) {
      throw new Error(
        `${packageName} ${blockName}.${dependencyName} still uses ${specifier}`,
      );
    }
  }
}

function validatePublishManifest(manifest) {
  validateFullCohortManifest(manifest);
  for (const item of manifest.packages) {
    const packageJson = readJsonFile(
      path.join(repoRoot, item.packageDir, 'package.json'),
    );
    if (packageJson.name !== item.targetName) {
      throw new Error(
        `Publish manifest target mismatch: expected ${item.targetName}, got ${packageJson.name}`,
      );
    }
    if (packageJson.version !== item.version) {
      throw new Error(
        `${item.targetName} has version ${packageJson.version}, expected ${item.version}`,
      );
    }
    if (packageJson.publishConfig?.access !== 'public') {
      throw new Error(`${item.targetName} must publish with public access`);
    }
    for (const blockName of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      validateNoWorkspaceProtocol(packageJson, item.targetName, blockName);
    }
    if (item.sourceName === ultramodernCreateSourceName) {
      validateCreateTemplateFiles(
        path.join(repoRoot, item.packageDir),
        item.targetName,
      );
    }
  }
}

function dependencyTargetForSpecifier(dependencyName, specifier, manifest) {
  const targetNames = new Set(manifest.packages.map(item => item.targetName));
  const aliasedTarget = manifest.aliases?.[dependencyName];
  if (targetNames.has(aliasedTarget)) {
    return aliasedTarget;
  }
  if (targetNames.has(dependencyName)) {
    return dependencyName;
  }
  if (typeof specifier !== 'string') {
    return undefined;
  }

  const match = /^npm:(?<packageName>@[^/]+\/[^@]+|[^@]+)@/u.exec(specifier);
  const packageName = match?.groups?.packageName;
  return packageName && targetNames.has(packageName) ? packageName : undefined;
}

function packageDependenciesFromPackageJson(
  packageJson,
  targetName,
  manifest,
) {
  const dependencies = ['dependencies', 'optionalDependencies'].flatMap(
    blockName => Object.entries(packageJson[blockName] ?? {}),
  );

  return [
    ...new Set(
      dependencies
        .map(([dependencyName, specifier]) =>
          dependencyTargetForSpecifier(dependencyName, specifier, manifest),
        )
        .filter(
          dependencyTarget =>
            dependencyTarget !== undefined && dependencyTarget !== targetName,
        ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function publishDependenciesForItem(item, manifest) {
  if (manifest.dependencyGraph) {
    return manifest.dependencyGraph[item.targetName] ?? [];
  }

  const packageJsonPath = path.join(repoRoot, item.packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return [];
  }
  const packageJson = readJsonFile(packageJsonPath);
  return packageDependenciesFromPackageJson(
    packageJson,
    item.targetName,
    manifest,
  );
}

function createPackageDependencyGraph(packages, manifest) {
  return Object.fromEntries(
    [...packages]
      .sort((left, right) => left.targetName.localeCompare(right.targetName))
      .map(item => [
        item.targetName,
        publishDependenciesForItem(item, {
          ...manifest,
          dependencyGraph: undefined,
        }),
      ]),
  );
}

function orderPublishItems(packages, manifest = { aliases: {}, packages }) {
  const sourceOrderedPackages = [...packages].sort((left, right) => {
    if (left.sourceName === ultramodernCreateSourceName) {
      return 1;
    }
    if (right.sourceName === ultramodernCreateSourceName) {
      return -1;
    }
    return left.sourceName.localeCompare(right.sourceName);
  });
  const byTargetName = new Map(
    sourceOrderedPackages.map(item => [item.targetName, item]),
  );
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  const visit = item => {
    if (visited.has(item.targetName)) {
      return;
    }
    if (visiting.has(item.targetName)) {
      throw new Error(
        `BleedingDev publish dependency cycle includes ${item.targetName}`,
      );
    }

    visiting.add(item.targetName);
    for (const dependencyTarget of publishDependenciesForItem(item, manifest)) {
      const dependency = byTargetName.get(dependencyTarget);
      if (dependency) {
        visit(dependency);
      }
    }
    visiting.delete(item.targetName);
    visited.add(item.targetName);
    ordered.push(item);
  };

  for (const item of sourceOrderedPackages) {
    visit(item);
  }

  const createItem = byTargetName.get(
    manifest.aliases?.[ultramodernCreateSourceName] ??
      ultramodernCreateSourceName,
  );
  if (createItem && ordered.at(-1) !== createItem) {
    throw new Error(
      `${createItem.targetName} must publish last, but another cohort package depends on it`,
    );
  }

  return ordered;
}

export {
  createPackageDependencyGraph,
  orderPublishItems,
  packageDependenciesFromPackageJson,
  validateFullCohortManifest,
  validatePublishManifest,
};
