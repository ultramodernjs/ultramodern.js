import fs from 'node:fs';
// Closed inputs shared by the standalone producer, installer and consumer graph.
// This label records dependency ordering only; it is no cohort/version qualification.
export const sidecarPublishBefore = '@bleedingdev/modern-js-utils';
export const sidecarRecipeIds = Object.freeze([
  'braces',
  'fast-glob',
  'find-workspaces',
  'micromatch',
  'rsbuild-plugin-source-build',
  'ultracite',
]);
export const sidecarQualificationProbeKeys = Object.freeze([
  'packed-install',
  'braces-api',
  'braces-depth-guard',
  'glob-api',
  'ultracite-api',
]);
export const sidecarProfiles = Object.freeze({
  parser: Object.freeze({
    recipeIds: sidecarRecipeIds,
    probeKeys: sidecarQualificationProbeKeys,
    publishBefore: sidecarPublishBefore,
  }),
  'mf-cohort': Object.freeze({
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
      'Unknown sidecar profile; expected parser, mf-sdk, mf-cohort or tanstack-redact',
    );
  const selected = sidecarProfiles[name];
  assertSidecarProfileRecipes(name, candidateRecipes());
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
      name === 'mf-cohort' &&
      (recipe.upstream.name !== `@module-federation/${id.slice(3)}` ||
        recipe.upstream.version !== (id === 'mf-node' ? '2.7.53' : '2.9.3'))
    )
      throw new Error(`Closed mf-cohort upstream drift: ${id}`);
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

function candidateRecipes() {
  return JSON.parse(
    fs.readFileSync(
      new URL(
        '../ultramodern-supply/sidecar-candidates-20261116.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
}

export function sidecarProfileRecipes(name) {
  const selected = sidecarProfile(name);
  const recipes = candidateRecipes();
  const active = JSON.parse(
    fs.readFileSync(
      new URL('../ultramodern-supply/sidecars.json', import.meta.url),
      'utf8',
    ),
  );
  if (
    recipes.length !== 21 ||
    new Set(recipes.map(recipe => recipe.id)).size !== 21
  )
    throw new Error(
      'Candidate recipe set must contain the reviewed 21 identities',
    );
  for (const recipe of recipes) {
    const original = active.find(item => item.id === recipe.id);
    if (
      !original ||
      original.fork.name !== recipe.fork.name ||
      original.upstream.name !== recipe.upstream.name ||
      JSON.stringify(original.provenance) !== JSON.stringify(recipe.provenance)
    )
      throw new Error(
        `Candidate recipe cannot add a name or relax provenance: ${recipe.id}`,
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
      throw new Error(
        `Invalid direct candidate patch descriptor: ${recipe.id}`,
      );
  }
  return selected.recipeIds.map(id => {
    const matches = recipes.filter(recipe => recipe.id === id);
    if (matches.length !== 1) throw new Error(`Candidate recipe drift: ${id}`);
    return matches[0];
  });
}
