#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import inventory from '../../packages/toolkit/ultramodern-create/src/ultramodern-workspace/patch-inventory.ts';
import {
  MODULE_FEDERATION_NODE_VERSION,
  MODULE_FEDERATION_VERSION,
  ULTRAMODERN_PACKAGE_PINS,
} from '../../packages/toolkit/ultramodern-create/src/ultramodern-workspace/versions.ts';
import { packageMetadataRepository } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/constants.mjs';
import { sidecarProfile } from '../ultramodern-publish/sidecar-profiles.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const recipes = JSON.parse(
  fs.readFileSync(new URL('./sidecars.json', import.meta.url), 'utf8'),
);
const consumerBlocks = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];
const forkSpecifier = /^npm:(@bleedingdev\/[\w.-]+)@(.+)$/u;

/**
 * Framework runtime edges that still name an upstream package with a recipe,
 * because the fork version they must declare is not on npm yet. The monorepo
 * cannot install an unpublished alias, so local qualification resolves the
 * recipe's exact upstream version. Redact's entry is qualification-only: a
 * published default runtime must declare the patched fork alias after its
 * publication has matured past the 24h release-age gate.
 *
 * `@bleedingdev/mf-runtime@2.9.2` reaches runtime-core's
 * resetFederationRuntime (module-federation/core#5152). Backend federation in
 * plugin-bff-extensions creates its own instance and never calls it.
 *
 * These framework edges declare reviewed sidecars that have not had their
 * first signed publication yet and resolve the patched upstream in the monorepo.
 */
export const unpublishedForkEdges = [
  // Local qualification only: Redact's reviewed repository patch is installed.
  // Publication rejects this edge until the mature sidecar alias is in source.
  {
    importer: 'packages/solutions/ultramodern-app-tools',
    published: '@bleedingdev/modern-js-ultramodern-app-tools',
    dependency: '@tanstack/redact',
  },
  // The SDK fork has not had its first signed release plus 24h admission.
  {
    importer: 'packages/runtime/federation-runtime',
    published: '@bleedingdev/modern-js-federation-runtime',
    dependency: '@module-federation/sdk',
  },
  // These exact source consumers declare the parser-correction recipes until
  // their new fork names are published. This validates recipe reachability;
  // it does not correct the current installation or compiled utility bytes.
  {
    importer: 'packages/toolkit/utils',
    published: '@bleedingdev/modern-js-utils',
    dependency: 'fast-glob',
  },
  {
    importer: 'packages/cli/builder',
    published: '@bleedingdev/modern-js-builder',
    dependency: '@rsbuild/plugin-source-build',
  },
  {
    importer: 'packages/cli/builder',
    published: '@bleedingdev/modern-js-builder',
    dependency: '@rsbuild/plugin-type-check',
  },
  {
    importer: 'packages/toolkit/ultramodern-create',
    published: '@bleedingdev/modern-js-ultramodern-create',
    dependency: 'ultracite',
  },
  {
    importer: 'packages/cli/plugin-bff-extensions',
    published: '@bleedingdev/modern-js-plugin-bff-extensions',
    dependency: '@module-federation/runtime',
  },
  // The merged 2.9.2 patch carries a renderer hunk the published 2.9.3
  // modern-js-v3 fork lacks; its fork version moves to 2.9.4 and this edge
  // declares it once published.
  {
    importer: 'packages/toolkit/ultramodern-create',
    published: '@bleedingdev/modern-js-ultramodern-create',
    dependency: '@module-federation/modern-js-v3',
  },
];

/**
 * Whether `consumer`'s `dependency` edge may still be the upstream `specifier`.
 * A lockfile version may carry its peer suffix, e.g. `2.2.11(core-js@3.50.0)`.
 */
export const isUnpublishedForkEdge = (
  consumer,
  dependency,
  specifier,
  recipe,
) =>
  (specifier === recipe.upstream.version ||
    String(specifier).startsWith(`${recipe.upstream.version}(`)) &&
  unpublishedForkEdges.some(
    edge =>
      edge.dependency === dependency &&
      (edge.importer === consumer || edge.published === consumer),
  );

/**
 * Every recipe must be reachable from a generator runtime pin or an alias the
 * publisher emits into a runtime, optional or peer dependency of a published
 * cohort manifest, directly or through the alias edges of another reachable
 * recipe. Only exact aliases of the recipe's fork version count. A repository
 * patch never makes a consumer: it patches the upstream identity, not the
 * published fork. devDependencies never make a consumer either.
 */
export function assertRecipeConsumers(
  recipeList,
  { generatorPins, publishedManifests, qualificationOnly = false },
) {
  const byFork = new Map(
    recipeList.map(item => [`${item.fork.name}@${item.fork.version}`, item]),
  );
  const reached = new Set();
  const pending = [];
  const reach = recipe => {
    if (recipe && !reached.has(recipe)) {
      reached.add(recipe);
      pending.push(recipe);
    }
  };
  const reachSpecifiers = dependencies => {
    for (const specifier of Object.values(dependencies ?? {})) {
      const [, fork, version] = forkSpecifier.exec(String(specifier)) ?? [];
      reach(byFork.get(`${fork}@${version}`));
    }
  };
  const reachBlocks = manifest => {
    for (const block of consumerBlocks) reachSpecifiers(manifest[block]);
  };
  // The publisher ships source edges unchanged, so a cohort package that names
  // an upstream package with a recipe would ship the uncorrected artifact.
  const recipeByUpstream = new Map(
    recipeList.map(item => [item.upstream.name, item]),
  );
  for (const manifest of publishedManifests) {
    for (const block of consumerBlocks) {
      for (const [name, specifier] of Object.entries(manifest[block] ?? {})) {
        const recipe = recipeByUpstream.get(name);
        const expected =
          recipe && `npm:${recipe.fork.name}@${recipe.fork.version}`;
        // The repository patch qualifies local Redact builds, not published
        // framework consumers. Generated workspaces do not receive that patch.
        if (recipe && name === '@tanstack/redact' && !qualificationOnly) {
          assert.equal(
            specifier,
            expected,
            `${manifest.name} ${block}.${name} is ${specifier}; cohort publication is blocked: bootstrap @bleedingdev/tanstack-redact, publish the reviewed patched sidecar, then switch the source alias to ${expected} and exempt that exact version from the repository release-age gate. The repository patch is for local qualification only.`,
          );
        }
        const unpublished =
          recipe &&
          isUnpublishedForkEdge(manifest.name, name, specifier, recipe);
        assert.ok(
          !recipe || specifier === expected || unpublished,
          `${manifest.name} ${block}.${name} is ${specifier}; declare ${expected} in source`,
        );
        // A listed unpublished fork edge is the recipe's declared consumer
        // until the fork is on npm and the edge becomes its exact alias.
        if (unpublished) reach(recipe);
      }
    }
  }
  for (const pins of generatorPins) reachSpecifiers(pins);
  for (const manifest of publishedManifests) reachBlocks(manifest);
  while (pending.length) reachBlocks(pending.pop().manifestChanges);
  const orphan = recipeList.find(item => !reached.has(item));
  assert.ok(
    !orphan,
    `sidecar ${orphan?.id} has no runtime consumer; delete the recipe or wire a consumer`,
  );
}

/** Check the repository recipes against the generator's runtime pins and the published cohort manifests. */
export function assertRepositoryRecipeConsumers(
  publishedManifests,
  { qualificationOnly = false } = {},
) {
  assertModuleFederationRelease(recipes);
  const qualifiedProfilePins = ['mf-sdk', 'tanstack-redact'].map(profile =>
    Object.fromEntries(
      Object.entries(sidecarProfile(profile).dependencies).map(
        ([name, version]) => [name, `npm:${name}@${version}`],
      ),
    ),
  );
  assertRecipeGraph(recipes, {
    generatorPins: [
      ...Object.values(ULTRAMODERN_PACKAGE_PINS),
      ...qualifiedProfilePins,
    ],
  });
  assertRecipeConsumers(recipes, {
    // The standalone SDK and Redact qualifiers are direct installed public API
    // consumers. Their immutable profiles also drive the exact installer
    // dependencies.
    generatorPins: [
      ...Object.entries(ULTRAMODERN_PACKAGE_PINS)
        .filter(([block]) => !block.endsWith('DevDependencies'))
        .map(([, pins]) => pins),
      ...qualifiedProfilePins,
    ],
    publishedManifests,
    qualificationOnly,
  });
}

/** Only a non-publish candidate that reconstructs sidecars may qualify source
 * before its unpublished Redact edge is replaced in the staged manifest.
 */
export function isCiSidecarQualification(options = {}) {
  return (
    options.tag === 'ci' &&
    options.includeSidecars === true &&
    !options.publish &&
    !options.publishExisting
  );
}

/** Source admission only. Staged and packed manifests must pass the strict
 * repository gate: CI consumers need the corrected dependency closure too.
 */
export function assertCohortRecipeConsumers(publishedManifests, options = {}) {
  assertRepositoryRecipeConsumers(publishedManifests, {
    qualificationOnly: isCiSidecarQualification(options),
  });
}

// Fork publication versions are immutable correction identities; only their
// upstream source releases must follow the generator's MF release pins.
export function assertModuleFederationRelease(recipeList) {
  for (const { upstream } of recipeList) {
    if (!upstream.name.startsWith('@module-federation/')) continue;
    const expected =
      upstream.name === '@module-federation/node'
        ? MODULE_FEDERATION_NODE_VERSION
        : MODULE_FEDERATION_VERSION;
    assert.equal(
      upstream.version,
      expected,
      `${upstream.name} source must use the generator release ${expected}`,
    );
  }
}

/**
 * Resolve the recipe graph. Every `npm:@bleedingdev/<fork>@<version>` alias in
 * a recipe or a generator pin must name a recipe at exactly that version, so
 * deleting a recipe fails here instead of publishing a dangling alias. A
 * runtime, optional or peer alias is a graph edge; any other manifest change
 * is a correction the recipe carries itself, like a patch.
 */
function recipeGraph(recipeList, generatorPins) {
  const byFork = new Map(
    recipeList.map(item => [`${item.fork.name}@${item.fork.version}`, item]),
  );
  const resolve = (owner, specifier) => {
    const [, fork, version] = forkSpecifier.exec(String(specifier)) ?? [];
    if (!fork) return undefined;
    const target = byFork.get(`${fork}@${version}`);
    assert.ok(
      target,
      `${owner} aliases ${specifier}, which no sidecar recipe publishes; restore the recipe or drop the alias`,
    );
    return target;
  };
  for (const pins of generatorPins)
    for (const [name, specifier] of Object.entries(pins))
      resolve(`generator pin ${name}`, specifier);
  const edges = new Map();
  const corrections = new Set();
  for (const recipe of recipeList) {
    const aliases = [];
    for (const [block, changes] of Object.entries(recipe.manifestChanges)) {
      for (const [name, specifier] of Object.entries(changes)) {
        const target = resolve(
          `sidecar ${recipe.id} ${block}.${name}`,
          specifier,
        );
        if (!target) corrections.add(recipe);
        else if (consumerBlocks.includes(block))
          aliases.push({ block, name, specifier, target });
      }
    }
    edges.set(recipe, aliases);
  }
  return { corrections, edges };
}

/**
 * Split the recipes into those that still carry or reach a correction and the
 * retirable rest, treating the `upstreamed` recipes' patches as already
 * shipped by upstream.
 */
function partitionRecipes(recipeList, { generatorPins, upstreamed }) {
  const { corrections, edges } = recipeGraph(recipeList, generatorPins);
  const parents = new Map(recipeList.map(item => [item, []]));
  for (const [recipe, aliases] of edges)
    for (const { target } of aliases) parents.get(target).push(recipe);
  const required = new Set(
    recipeList.filter(
      item => corrections.has(item) || (item.patch && !upstreamed.has(item)),
    ),
  );
  const pending = [...required];
  while (pending.length) {
    for (const parent of parents.get(pending.pop())) {
      if (!required.has(parent)) {
        required.add(parent);
        pending.push(parent);
      }
    }
  }
  return {
    edges,
    required,
    retirable: recipeList.filter(item => !required.has(item)),
  };
}

/**
 * A recipe without a patch exists only to rewire a runtime dependency onto a
 * corrected recipe. Reject any recipe that neither carries a correction nor
 * reaches one through its runtime aliases, and any alias whose recipe is gone.
 */
export function assertRecipeGraph(recipeList, { generatorPins = [] } = {}) {
  const [orphan] = partitionRecipes(recipeList, {
    generatorPins,
    upstreamed: new Set(),
  }).retirable;
  assert.ok(
    !orphan,
    `sidecar ${orphan?.id} has no patched descendant; delete recipe`,
  );
}

/**
 * Report what upstream releases make retirable: each upstreamed patch, every
 * recipe that no longer reaches a correction, and every alias a remaining
 * recipe must drop.
 */
export function assertNoUpstreamedPatches(
  recipeList,
  upstreamed,
  { generatorPins = [] } = {},
) {
  const { edges, required, retirable } = partitionRecipes(recipeList, {
    generatorPins,
    upstreamed: new Set(upstreamed.keys()),
  });
  const lines = [...upstreamed].map(
    ([recipe, version]) =>
      `sidecar ${recipe.id} patch is already present in ${recipe.upstream.name}@${version}${required.has(recipe) ? '; drop the patch, the recipe still rewires to a patched recipe' : ''}`,
  );
  if (retirable.length)
    lines.push(
      `retirable sidecars: ${retirable.map(item => item.id).join(', ')}; delete these recipes and move their consumers to the upstream release`,
    );
  for (const recipe of required)
    for (const { block, name, specifier, target } of edges.get(recipe))
      if (!required.has(target))
        lines.push(
          `sidecar ${recipe.id} must drop ${block}.${name} ${specifier} when ${target.id} is retired`,
        );
  assert.ok(!lines.length, lines.join('\n'));
}

function recipePatch(recipe) {
  let patch = recipe.patch;
  if (patch.inventory) {
    patch = inventory.find(
      item => `${item.packageName}@${item.version}` === patch.inventory,
    );
    assert.ok(patch, `${recipe.id}: missing canonical patch`);
  }
  const patchBytes = fs.readFileSync(path.resolve(root, patch.path));
  assert.equal(
    createHash('sha256').update(patchBytes).digest('hex'),
    patch.sha256,
    `${recipe.id}: recipe patch integrity`,
  );
  return patchBytes;
}

function compareVersions(left, right) {
  const parse = version => {
    const [core, pre] = version.split('+')[0].split(/-(.*)/su);
    return { core: core.split('.').map(Number), pre: pre?.split('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++)
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  if (!a.pre || !b.pre) return (a.pre ? -1 : 0) + (b.pre ? 1 : 0);
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const [x, y] = [a.pre[index], b.pre[index]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/u;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x) !== numeric.test(y)) return numeric.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Fetch the newest registry release of the recipe's upstream major.minor
 * (prereleases only when the pin is one), authenticated by its packument
 * integrity. Returns undefined when the pin is already that release.
 */
async function fetchLatestTarball(recipe) {
  const { name, version } = recipe.upstream;
  const response = await fetch(
    `https://registry.npmjs.org/${name.replace('/', '%2f')}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  assert.ok(response.ok, `${name}: packument fetch failed: ${response.status}`);
  const packument = await response.json();
  const line = version.split('.').slice(0, 2).join('.');
  const [latest] = Object.keys(packument.versions)
    .filter(
      candidate =>
        candidate.split('.').slice(0, 2).join('.') === line &&
        (version.includes('-') || !candidate.includes('-')),
    )
    .sort((left, right) => compareVersions(right, left));
  if (!latest || compareVersions(latest, version) <= 0) return undefined;
  const { tarball, integrity } = packument.versions[latest].dist;
  const tarballResponse = await fetch(tarball, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(
    tarballResponse.ok,
    `${name}@${latest}: tarball fetch failed: ${tarballResponse.status}`,
  );
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    integrity,
    `${name}@${latest}: tarball integrity`,
  );
  return { bytes, version: latest };
}

/**
 * Extract `name` inside `directory`. tar runs there with a relative archive
 * name: Git Bash's GNU tar on Windows reads `C:\...` as a remote `host:path`.
 */
function extractTarball(directory, name) {
  execFileSync('tar', ['-xzf', name], { cwd: directory, stdio: 'pipe' });
}

/**
 * Map each patched recipe whose patch reverse-applies with zero fuzz to the
 * newest upstream release of its major.minor, i.e. upstream already ships it.
 */
export async function findUpstreamedPatches(
  recipeList,
  { latestTarball = fetchLatestTarball } = {},
) {
  const upstreamed = new Map();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-upstream-'));
  try {
    for (const recipe of recipeList.filter(item => item.patch)) {
      const latest = await latestTarball(recipe);
      if (!latest) continue;
      const directory = path.join(temp, recipe.id);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'upstream.tgz'), latest.bytes);
      extractTarball(directory, 'upstream.tgz');
      try {
        execFileSync('patch', ['-p1', '-R', '-f', '--dry-run', '--fuzz=0'], {
          cwd: path.join(directory, 'package'),
          input: recipePatch(recipe),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        upstreamed.set(recipe, latest.version);
      } catch (error) {
        if (error.status === undefined) throw error;
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return upstreamed;
}

function nestedNodeModules(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const absolute = path.join(directory, entry.name);
      return entry.name === 'node_modules'
        ? [absolute]
        : nestedNodeModules(absolute);
    });
}

async function fetchPinnedTarball(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    let bytes;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const transient =
        error.name === 'TimeoutError' ||
        [
          'ETIMEDOUT',
          'ECONNRESET',
          'EAI_AGAIN',
          'ENETUNREACH',
          'ECONNREFUSED',
          'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_SOCKET',
        ].includes(error.cause?.code ?? error.code);
      if (!transient || attempt === 3) {
        throw new Error(
          `Upstream tarball fetch failed for ${url} after ${attempt} attempt(s)`,
          { cause: error },
        );
      }
      continue;
    }
    assert.ok(response.ok, `upstream fetch failed: ${response.status}`);
    return bytes;
  }
}

/**
 * Reconstruct a recipe from its pinned tarball in an owned temporary directory,
 * or into `materializeTo` when given.
 */
export async function verifySidecar(id, { artifactsDir, materializeTo } = {}) {
  const recipe = recipes.find(item => item.id === id);
  assert.ok(recipe, `unknown sidecar: ${id}`);
  assert.deepEqual(
    recipe.artifacts,
    ['*'],
    `${id}: reconstruction requires the complete upstream artifact`,
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-sidecar-'));
  try {
    const target = materializeTo ?? path.join(temp, 'reconstructed');
    let bytes;
    if (artifactsDir) {
      // Explicit offline input must exist and is held to the same integrity check.
      bytes = fs.readFileSync(path.join(artifactsDir, `${id}.tgz`));
    } else {
      bytes = await fetchPinnedTarball(recipe.upstream.tarball);
    }
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    assert.equal(
      integrity,
      recipe.upstream.integrity,
      `${id}: upstream tarball integrity`,
    );
    fs.writeFileSync(path.join(temp, 'upstream.tgz'), bytes);
    extractTarball(temp, 'upstream.tgz');
    const upstreamDir = path.join(temp, 'package');
    // pnpm never installs node_modules directories shipped inside a package
    // tarball, so they are not part of the installable artifact. Republishing
    // them would declare files no consumer can receive.
    for (const nested of nestedNodeModules(upstreamDir)) {
      fs.rmSync(nested, { recursive: true, force: true });
      console.log(
        `${id}: dropped uninstallable ${path.relative(upstreamDir, nested)}`,
      );
    }
    const upstream = JSON.parse(
      fs.readFileSync(path.join(upstreamDir, 'package.json'), 'utf8'),
    );
    assert.equal(upstream.name, recipe.upstream.name);
    assert.equal(upstream.version, recipe.upstream.version);
    assert.equal(upstream.license, recipe.license);
    if (recipe.patch) {
      // -E removes the files an upstream PR deletes; GNU and BSD patch both
      // otherwise leave them behind empty.
      execFileSync('patch', ['-p1', '-E', '--fuzz=0', '--batch'], {
        cwd: upstreamDir,
        input: recipePatch(recipe),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    // A carried upstream PR can change the manifest too (for example its
    // `exports`), so the publication manifest projects the patched one.
    const patched = JSON.parse(
      fs.readFileSync(path.join(upstreamDir, 'package.json'), 'utf8'),
    );
    assert.equal(patched.name, upstream.name);
    assert.equal(patched.version, upstream.version);
    const projected = {
      ...patched,
      name: recipe.fork.name,
      version: recipe.fork.version,
      publishConfig: {
        registry: 'https://registry.npmjs.org/',
        access: 'public',
      },
      repository: {
        type: 'git',
        // npm provenance must name the repository producing this artifact.
        url: `git+https://github.com/${packageMetadataRepository()}.git`,
        directory: 'scripts/ultramodern-supply',
      },
    };
    for (const [key, changes] of Object.entries(recipe.manifestChanges)) {
      for (const dependencyName of Object.keys(changes)) {
        assert.ok(
          Object.hasOwn(patched[key] ?? {}, dependencyName),
          `${id}: recipe changes absent upstream ${key}.${dependencyName}`,
        );
      }
      projected[key] = { ...patched[key], ...changes };
    }
    fs.writeFileSync(
      path.join(upstreamDir, 'package.json'),
      `${JSON.stringify(projected, null, 2)}\n`,
    );
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(upstreamDir, target, { recursive: true });
    console.log(
      `Reconstructed ${id}: authenticated ${recipe.upstream.name}@${recipe.upstream.version}, exact patch and publication manifest.`,
    );
    return upstream;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const generatorPins = Object.values(ULTRAMODERN_PACKAGE_PINS);
  if (args.includes('--upstream-latest')) {
    assert.equal(args.length, 1, '--upstream-latest takes no other argument');
    assertNoUpstreamedPatches(recipes, await findUpstreamedPatches(recipes), {
      generatorPins,
    });
    console.log('No sidecar patch is present in its newest upstream release.');
  } else {
    assertRecipeGraph(recipes, { generatorPins });
    const offline = args.indexOf('--artifacts');
    const artifactsDir = offline < 0 ? undefined : args.splice(offline, 2)[1];
    assert.ok(offline < 0 || artifactsDir, '--artifacts requires a directory');
    for (const id of args.length ? args : recipes.map(item => item.id))
      await verifySidecar(id, { artifactsDir });
  }
}
