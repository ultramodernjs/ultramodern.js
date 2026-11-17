import fs from 'node:fs';

// Reviewed candidate sets and their exact recipe counts. A published set is
// history: a corrected closure gets a new file instead of edited recipes.
const candidateSets = Object.freeze({
  'sidecar-candidates-20261116.json': 21,
  'sidecar-candidates-20261117-parser.json': 7,
  'sidecar-candidates-20261117-picomatch-4.json': 1,
});
const mfCandidates = 'sidecar-candidates-20261116.json';

// Closed inputs shared by the standalone producer, installer and consumer graph.
// This label records dependency ordering only; it is no cohort/version qualification.
export const sidecarPublishBefore = '@bleedingdev/modern-js-utils';
export const sidecarRecipeIds = Object.freeze([
  'braces',
  'fast-glob',
  'find-workspaces',
  'micromatch',
  'picomatch',
  'rsbuild-plugin-source-build',
  'ultracite',
]);
export const sidecarQualificationProbeKeys = Object.freeze([
  'packed-install',
  'braces-api',
  'braces-depth-guard',
  'glob-api',
  'picomatch-patched-api',
  'ultracite-api',
]);
export const sidecarProfiles = Object.freeze({
  // GHSA-fc5q-39xc-vjpf: micromatch keeps its declared picomatch 2 API line.
  parser: Object.freeze({
    candidates: 'sidecar-candidates-20261117-parser.json',
    recipeIds: sidecarRecipeIds,
    probeKeys: sidecarQualificationProbeKeys,
    publishBefore: sidecarPublishBefore,
  }),
  // GHSA-fc5q-39xc-vjpf: preserve the ^4 line under a separate registry name.
  // A cohort stages each sidecar name once, and each name must point latest
  // at its exact published version. The parser sidecar stays on 2.x.
  'picomatch-4': Object.freeze({
    candidates: 'sidecar-candidates-20261117-picomatch-4.json',
    recipeIds: Object.freeze(['picomatch-4']),
    dependencies: Object.freeze({ '@bleedingdev/picomatch-v4': '4.0.8' }),
    upstream: Object.freeze({ 'picomatch-4': 'picomatch@4.0.7' }),
    probeKeys: Object.freeze(['packed-install', 'picomatch-patched-api']),
    publishBefore: sidecarPublishBefore,
  }),
  'mf-cohort': Object.freeze({
    candidates: mfCandidates,
    qualificationDependencies: Object.freeze({ webpack: '5.112.2' }),
    recipeIds: Object.freeze([
      'mf-bridge-react',
      'mf-cli',
      'mf-dts-plugin',
      'mf-enhanced',
      'mf-manifest',
      'mf-modern-js-v3',
      'mf-node',
      'mf-rsbuild-plugin',
      'mf-rspack',
      'mf-runtime',
      'mf-runtime-core',
      'mf-runtime-tools',
      'mf-sdk',
      'mf-webpack-bundler-runtime',
    ]),
    dependencies: Object.freeze({
      '@bleedingdev/mf-bridge-react': '2.9.5',
      '@bleedingdev/mf-cli': '2.9.5',
      '@bleedingdev/mf-dts-plugin': '2.9.5',
      '@bleedingdev/mf-enhanced': '2.9.5',
      '@bleedingdev/mf-manifest': '2.9.5',
      '@bleedingdev/mf-modern-js-v3': '2.9.5',
      '@bleedingdev/mf-node': '2.7.54',
      '@bleedingdev/mf-rsbuild-plugin': '2.9.5',
      '@bleedingdev/mf-rspack': '2.9.5',
      '@bleedingdev/mf-runtime': '2.9.5',
      '@bleedingdev/mf-runtime-core': '2.9.5',
      '@bleedingdev/mf-runtime-tools': '2.9.5',
      '@bleedingdev/mf-sdk': '2.9.5',
      '@bleedingdev/mf-webpack-bundler-runtime': '2.9.5',
    }),
    probeKeys: Object.freeze([
      'packed-install',
      'mf-cohort-public-apis',
      'mf-cohort-reset-and-fetch',
      'mf-cohort-dts-lifecycle',
      'mf-cohort-react-and-ssr',
    ]),
    publishBefore: '@bleedingdev/modern-js-federation-runtime',
  }),
  'mf-sdk': Object.freeze({
    candidates: mfCandidates,
    recipeIds: Object.freeze(['mf-sdk']),
    dependencies: Object.freeze({ '@bleedingdev/mf-sdk': '2.9.5' }),
    probeKeys: Object.freeze([
      'packed-install',
      'mf-sdk-cjs-api',
      'mf-sdk-esm-api',
    ]),
    publishBefore: '@bleedingdev/modern-js-federation-runtime',
  }),
  'tanstack-redact': Object.freeze({
    candidates: mfCandidates,
    recipeIds: Object.freeze(['tanstack-redact']),
    dependencies: Object.freeze({ '@bleedingdev/tanstack-redact': '0.3.2' }),
    probeKeys: Object.freeze([
      'packed-install',
      'redact-patch-marker',
      'redact-server-render',
    ]),
    publishBefore: '@bleedingdev/modern-js-ultramodern-app-tools',
  }),
});

export function sidecarProfile(name) {
  if (typeof name !== 'string' || !Object.hasOwn(sidecarProfiles, name))
    throw new Error(
      `Unknown sidecar profile; expected ${Object.keys(sidecarProfiles).join(', ')}`,
    );
  const selected = sidecarProfiles[name];
  assertSidecarProfileRecipes(name, candidateRecipes(selected.candidates));
  return selected;
}

export function assertSidecarProfileDependencies(name, packages) {
  const { dependencies } = sidecarProfile(name);
  if (!dependencies) return;
  const actual = packages
    .map(({ name, version }) => `${name}@${version}`)
    .sort();
  const expected = Object.entries(dependencies)
    .map(([name, version]) => `${name}@${version}`)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      'Sidecar installed dependencies differ from the closed profile',
    );
}

export function assertSidecarProfileRecipes(name, recipes) {
  const selected = sidecarProfiles[name];
  if (!selected?.dependencies) return;
  const byFork = new Map();
  for (const id of selected.recipeIds) {
    const rows = recipes.filter(recipe => recipe.id === id);
    if (rows.length !== 1)
      throw new Error(`Closed ${name} recipe drift: ${id}`);
    const [recipe] = rows;
    if (selected.dependencies[recipe.fork.name] !== recipe.fork.version)
      throw new Error(`Closed ${name} recipe identity drift: ${id}`);
    if (
      selected.upstream &&
      `${recipe.upstream.name}@${recipe.upstream.version}` !==
        selected.upstream[id]
    )
      throw new Error(`Closed ${name} upstream drift: ${id}`);
    if (
      name === 'mf-cohort' &&
      (recipe.upstream.name !== `@module-federation/${id.slice(3)}` ||
        recipe.upstream.version !== (id === 'mf-node' ? '2.7.53' : '2.9.3'))
    )
      throw new Error(`Closed mf-cohort upstream drift: ${id}`);
    if (
      name === 'mf-cohort' &&
      id === 'mf-enhanced' &&
      recipe.manifestChanges.peerDependencies?.webpack !== '^5.112.2'
    )
      throw new Error('Closed mf-cohort Webpack support drift: mf-enhanced');
    byFork.set(recipe.upstream.name, recipe);
  }
  if (name !== 'mf-cohort') return;
  for (const recipe of byFork.values()) {
    for (const changes of Object.values(recipe.manifestChanges)) {
      for (const [dependency, specifier] of Object.entries(changes)) {
        const target = byFork.get(dependency);
        if (
          target &&
          specifier !== `npm:${target.fork.name}@${target.fork.version}`
        )
          throw new Error(
            `Closed mf-cohort alias drift: ${recipe.id} -> ${dependency}`,
          );
        const alias = /^npm:(@bleedingdev\/[^@]+)@(.+)$/u.exec(specifier);
        if (alias && selected.dependencies[alias[1]] !== alias[2])
          throw new Error(`Closed mf-cohort alias drift: ${specifier}`);
      }
    }
  }
}

const readSupplyJson = file =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../ultramodern-supply/${file}`, import.meta.url),
      'utf8',
    ),
  );

function candidateRecipes(file) {
  if (!Object.hasOwn(candidateSets, file))
    throw new Error(`Unreviewed sidecar candidate set: ${file}`);
  return readSupplyJson(file);
}

const placeholderVersions = ['0.0.0-stage', '0.0.0-bootstrap'];

// npm trusted publishing cannot create a package name. A new name enters a
// candidate set only after its authorized interactive bootstrap is pinned.
function assertBootstrapChronology(recipe) {
  const entries = recipe.provenance?.grandfatheredVersions;
  const pinned =
    Array.isArray(entries) &&
    Object.keys(recipe.provenance).length === 1 &&
    entries.length === placeholderVersions.length &&
    entries.every(
      (entry, index) =>
        Object.keys(entry).sort().join() === 'integrity,publishedAt,version' &&
        entry.version === placeholderVersions[index] &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
          entry.publishedAt,
        ) &&
        /^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity),
    );
  if (!pinned)
    throw new Error(
      `Candidate ${recipe.id} adds the npm name ${recipe.fork.name} without its pinned bootstrap chronology. ` +
        'Bootstrap the name interactively once with explicit authorization (npm 0.0.0-stage holding placeholder, then a deprecated 0.0.0-bootstrap placeholder), ' +
        "configure publish-bleedingdev.yml in environment npm-publish as its trusted publisher, and pin both placeholders in one recipe's provenance.grandfatheredVersions.",
    );
}

function assertCandidateRecipe(recipe, active) {
  // One npm name has one registry chronology, whichever recipe line carries it;
  // a new name declares it once and its other lines inherit it.
  const original = active.find(
    item => item.id === recipe.id || item.fork.name === recipe.fork.name,
  );
  if (!original) introducedProvenance(recipe.fork.name);
  else if (
    original.fork.name !== recipe.fork.name ||
    original.upstream.name !== recipe.upstream.name ||
    JSON.stringify(original.provenance) !== JSON.stringify(recipe.provenance)
  )
    throw new Error(
      `Candidate recipe cannot rename or relax provenance: ${recipe.id}`,
    );
  if (
    recipe.artifacts.length !== 1 ||
    recipe.artifacts[0] !== '*' ||
    recipe.license !== 'MIT'
  )
    throw new Error(`Incomplete candidate artifact/license: ${recipe.id}`);
  if (
    recipe.patch &&
    (!/^patches\/[^/]+\.patch$/u.test(recipe.patch.path) ||
      !/^[a-f0-9]{64}$/u.test(recipe.patch.sha256))
  )
    throw new Error(`Invalid direct candidate patch descriptor: ${recipe.id}`);
}

// The single pinned bootstrap chronology reviewed candidate sets declare for a
// name sidecars.json does not own yet, or undefined when no set introduces it.
function introducedProvenance(name) {
  const lines = Object.keys(candidateSets)
    .flatMap(candidateRecipes)
    .filter(recipe => recipe.fork.name === name);
  if (!lines.length) return undefined;
  if (lines.some(recipe => recipe.upstream.name !== lines[0].upstream.name))
    throw new Error(`Candidate sets republish different packages as ${name}`);
  const declarations = lines.filter(recipe =>
    Object.hasOwn(recipe, 'provenance'),
  );
  if (declarations.length > 1)
    throw new Error(
      `Candidate sets declare ${name} provenance ${declarations.length} times; declare a new name's bootstrap chronology in exactly one recipe`,
    );
  assertBootstrapChronology(declarations[0] ?? lines[0]);
  return declarations[0].provenance;
}

export function sidecarProfileRecipes(name) {
  const selected = sidecarProfile(name);
  const recipes = candidateRecipes(selected.candidates);
  const active = readSupplyJson('sidecars.json');
  const expected = candidateSets[selected.candidates];
  if (
    recipes.length !== expected ||
    new Set(recipes.map(recipe => recipe.id)).size !== expected
  )
    throw new Error(
      `Candidate recipe set must contain the reviewed ${expected} identities`,
    );
  for (const recipe of recipes) assertCandidateRecipe(recipe, active);
  return selected.recipeIds.map(id => {
    const matches = recipes.filter(recipe => recipe.id === id);
    if (matches.length !== 1) throw new Error(`Candidate recipe drift: ${id}`);
    return matches[0];
  });
}

/**
 * The reviewed registry chronology of a sidecar name: the active recipe's, or
 * the pinned bootstrap of a name only a reviewed candidate set introduces.
 */
export function sidecarNameProvenance(name) {
  const active = readSupplyJson('sidecars.json');
  const owner = active.find(recipe => recipe.fork.name === name);
  if (owner) return owner.provenance;
  return introducedProvenance(name);
}
