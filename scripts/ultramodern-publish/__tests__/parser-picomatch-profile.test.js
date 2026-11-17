const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fileURLToPath } = require('node:url');

const supply = path.resolve(__dirname, '../../ultramodern-supply');
const parserFile = path.join(supply, 'sidecar-candidates-20261117-parser.json');
const picomatch4File = path.join(
  supply,
  'sidecar-candidates-20261117-picomatch-4.json',
);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const chronology = [
  {
    version: '0.0.0-stage',
    publishedAt: '2026-11-18T08:00:00.000Z',
    integrity: `sha512-${'A'.repeat(86)}==`,
  },
  {
    version: '0.0.0-bootstrap',
    publishedAt: '2026-11-18T08:01:00.000Z',
    integrity: `sha512-${'B'.repeat(86)}==`,
  },
];
// Simulates the admitted state: canonical backport bytes and pinned bootstrap.
const admitted = () =>
  read(parserFile).map(recipe =>
    recipe.id === 'picomatch'
      ? {
          ...recipe,
          patch: { ...recipe.patch, sha256: 'a'.repeat(64) },
          provenance: { grandfatheredVersions: chronology },
        }
      : recipe,
  );

const chronology4 = chronology.map((entry, index) => ({
  ...entry,
  publishedAt: `2026-11-18T08:0${index + 2}:00.000Z`,
  integrity: `sha512-${(index ? 'D' : 'C').repeat(86)}==`,
}));
const admitted4 = () =>
  read(picomatch4File).map(recipe => ({
    ...recipe,
    patch: { ...recipe.patch, sha256: 'b'.repeat(64) },
    provenance: { grandfatheredVersions: chronology4 },
  }));

function serveCandidates(t, served) {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const filePath = file instanceof URL ? fileURLToPath(file) : file;
    if (Object.hasOwn(served, filePath))
      return JSON.stringify(served[filePath]);
    return original.call(fs, file, ...args);
  });
}
const serveParserCandidates = (t, recipes) =>
  serveCandidates(t, { [parserFile]: recipes });

test('the corrected parser closure routes micromatch to the picomatch 2 line it declares', async () => {
  const { sidecarProfile } = await import('../sidecar-profiles.mjs');
  const { assertRecipeGraph } = await import(
    '../../ultramodern-supply/verify-sidecars.mjs'
  );
  const profile = sidecarProfile('parser');
  const recipes = read(parserFile);
  assert.deepEqual(
    recipes.map(recipe => recipe.id).sort(),
    [...profile.recipeIds].sort(),
  );
  const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));
  assert.deepEqual(byId.get('picomatch').upstream, {
    name: 'picomatch',
    version: '2.3.2',
    tarball: 'https://registry.npmjs.org/picomatch/-/picomatch-2.3.2.tgz',
    integrity:
      'sha512-V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==',
  });
  assert.equal(
    byId.get('picomatch').patch.path,
    'patches/picomatch@2.3.2.patch',
  );
  assert.deepEqual(byId.get('micromatch').manifestChanges.dependencies, {
    braces: 'npm:@bleedingdev/braces@3.0.4',
    picomatch: 'npm:@bleedingdev/picomatch@2.3.3',
  });
  // Every parent of the corrected parser takes a new immutable version.
  const published = read(path.join(supply, 'sidecar-candidates-20261116.json'));
  for (const id of [
    'micromatch',
    'fast-glob',
    'rsbuild-plugin-source-build',
    'find-workspaces',
    'ultracite',
  ]) {
    const previous = published.find(recipe => recipe.id === id);
    assert.notEqual(byId.get(id).fork.version, previous.fork.version, id);
    assert.deepEqual(byId.get(id).upstream, previous.upstream, id);
    assert.deepEqual(byId.get(id).provenance, previous.provenance, id);
  }
  assert.deepEqual(
    byId.get('braces'),
    published.find(r => r.id === 'braces'),
  );
  assertRecipeGraph(recipes);
  // The prior parent alias has no recipe in the corrected closure.
  const drifted = structuredClone(recipes);
  drifted.find(
    recipe => recipe.id === 'fast-glob',
  ).manifestChanges.dependencies.micromatch =
    'npm:@bleedingdev/micromatch@4.0.8';
  assert.throws(
    () => assertRecipeGraph(drifted),
    /fast-glob dependencies\.micromatch aliases npm:@bleedingdev\/micromatch@4\.0\.8, which no sidecar recipe publishes/u,
  );
});

test('a new sidecar name is admitted only with its pinned bootstrap chronology', async t => {
  const { sidecarProfileRecipes, sidecarNameProvenance } = await import(
    '../sidecar-profiles.mjs'
  );
  // Unrelated profiles keep their own reviewed set.
  assert.equal(sidecarProfileRecipes('mf-cohort').length, 14);
  assert.equal(sidecarProfileRecipes('tanstack-redact').length, 1);

  for (const provenance of [
    undefined,
    { grandfatheredVersions: [] },
    { grandfatheredVersions: chronology.slice(1) },
    { grandfatheredVersions: [chronology[1], chronology[0]] },
    {
      grandfatheredVersions: [
        chronology[0],
        { ...chronology[1], integrity: 'sha512-short' },
      ],
    },
    { grandfatheredVersions: chronology, extra: true },
  ]) {
    const recipes = admitted();
    const recipe = recipes.find(item => item.id === 'picomatch');
    if (provenance) recipe.provenance = provenance;
    else delete recipe.provenance;
    serveParserCandidates(t, recipes);
    assert.throws(
      () => sidecarProfileRecipes('parser'),
      /without its pinned bootstrap chronology/u,
    );
    t.mock.restoreAll();
  }

  serveParserCandidates(t, admitted());
  const recipes = sidecarProfileRecipes('parser');
  assert.equal(recipes.length, 7);
  assert.deepEqual(sidecarNameProvenance('@bleedingdev/picomatch'), {
    grandfatheredVersions: chronology,
  });
  t.mock.restoreAll();

  // An existing name keeps exactly its active chronology.
  const relaxed = admitted();
  relaxed.find(recipe => recipe.id === 'micromatch').provenance = {
    grandfatheredVersions: chronology,
  };
  serveParserCandidates(t, relaxed);
  assert.throws(
    () => sidecarProfileRecipes('parser'),
    /cannot rename or relax provenance: micromatch/u,
  );
});

test('the picomatch 4 line needs its own bootstrap and remains closed', async t => {
  const { sidecarProfileRecipes, sidecarNameProvenance } = await import(
    '../sidecar-profiles.mjs'
  );
  const [line] = read(picomatch4File);
  assert.deepEqual(line.upstream, {
    name: 'picomatch',
    version: '4.0.7',
    tarball: 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz',
    integrity:
      'sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==',
  });
  assert.equal(line.patch.path, 'patches/picomatch@4.0.7.patch');
  const unpinned4 = admitted4();
  delete unpinned4[0].provenance;
  serveCandidates(t, { [parserFile]: admitted(), [picomatch4File]: unpinned4 });
  assert.equal(sidecarProfileRecipes('parser').length, 7);
  assert.throws(
    () => sidecarProfileRecipes('picomatch-4'),
    /adds the npm name @bleedingdev\/picomatch-v4 without its pinned bootstrap chronology/u,
  );
  t.mock.restoreAll();

  const withoutPatchDigest = admitted4();
  delete withoutPatchDigest[0].patch.sha256;
  serveCandidates(t, { [picomatch4File]: withoutPatchDigest });
  assert.throws(
    () => sidecarProfileRecipes('picomatch-4'),
    /Invalid direct candidate patch descriptor: picomatch-4/u,
  );
  t.mock.restoreAll();

  serveCandidates(t, {
    [parserFile]: admitted(),
    [picomatch4File]: admitted4(),
  });
  const [recipe] = sidecarProfileRecipes('picomatch-4');
  assert.deepEqual(recipe.fork, {
    name: '@bleedingdev/picomatch-v4',
    version: '4.0.8',
  });
  assert.deepEqual(sidecarNameProvenance('@bleedingdev/picomatch-v4'), {
    grandfatheredVersions: chronology4,
  });
  assert.deepEqual(sidecarNameProvenance('@bleedingdev/picomatch'), {
    grandfatheredVersions: chronology,
  });
  t.mock.restoreAll();

  for (const [mutate, error] of [
    [
      r => Object.assign(r, { upstream: { ...r.upstream, version: '4.0.6' } }),
      /Closed picomatch-4 upstream drift: picomatch-4/u,
    ],
    [
      r => Object.assign(r, { upstream: { ...r.upstream, name: 'other' } }),
      /Closed picomatch-4 upstream drift: picomatch-4/u,
    ],
    [
      r => Object.assign(r, { fork: { ...r.fork, version: '4.0.9' } }),
      /Closed picomatch-4 recipe identity drift: picomatch-4/u,
    ],
  ]) {
    const lines = admitted4();
    mutate(lines[0]);
    serveCandidates(t, { [picomatch4File]: lines });
    assert.throws(() => sidecarProfileRecipes('picomatch-4'), error);
    t.mock.restoreAll();
  }
});

test('one framework release can stage and validate both matcher majors', async t => {
  const { sidecarProfileRecipes } = await import('../sidecar-profiles.mjs');
  const {
    collectSidecarPackages,
    validateAliasConsistency,
    sidecarPublishOrder,
  } = await import('../lib/prepare-bleedingdev-packages/sidecars.mjs');
  serveCandidates(t, {
    [parserFile]: admitted(),
    [picomatch4File]: admitted4(),
  });
  const recipes = [
    ...sidecarProfileRecipes('parser'),
    ...sidecarProfileRecipes('picomatch-4'),
  ];
  const roots = recipes.map(recipe => 'packages/sidecar/' + recipe.id);
  const collect = reviewedRecipes =>
    collectSidecarPackages(undefined, { roots, reviewedRecipes });
  const staged = collect(recipes);
  const ordered = sidecarPublishOrder(staged).map(item => item.name);
  assert.ok(ordered.indexOf('@bleedingdev/picomatch') >= 0);
  assert.ok(
    ordered.indexOf('@bleedingdev/picomatch') <
      ordered.indexOf('@bleedingdev/micromatch'),
  );
  assert.ok(ordered.includes('@bleedingdev/picomatch-v4'));
  const framework = [
    {
      name: '@bleedingdev/modern-js-utils',
      dependencies: {
        'fast-glob': 'npm:@bleedingdev/fast-glob@3.3.4',
        picomatch: 'npm:@bleedingdev/picomatch-v4@4.0.8',
      },
    },
  ];
  assert.equal(validateAliasConsistency(framework, staged), recipes.length + 1);
  const duplicateName = structuredClone(recipes);
  duplicateName.find(item => item.id === 'picomatch-4').fork.name =
    '@bleedingdev/picomatch';
  assert.throws(
    () => collect(duplicateName),
    /Duplicate sidecar package name @bleedingdev\/picomatch/u,
  );
});
