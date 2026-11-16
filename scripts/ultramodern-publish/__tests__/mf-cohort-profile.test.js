const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const recipes = () =>
  JSON.parse(
    fs.readFileSync(
      new URL(
        '../../ultramodern-supply/sidecar-candidates-20261116.json',
        `file://${__filename}`,
      ),
      'utf8',
    ),
  );

test('closed MF cohort covers all 14 exact corrected identities and singleton profiles agree', async () => {
  const {
    sidecarProfile,
    assertSidecarProfileDependencies,
    assertSidecarProfileRecipes,
  } = await import('../sidecar-profiles.mjs');
  const { readSidecarBundleInputs } = await import('../sidecar-bundle.mjs');
  const profile = sidecarProfile('mf-cohort');
  assert.equal(profile.recipeIds.length, 14);
  assert.equal(new Set(profile.recipeIds).size, 14);
  const packages = readSidecarBundleInputs('mf-cohort');
  assert.equal(packages.length, 14);
  assertSidecarProfileDependencies('mf-cohort', packages);
  assertSidecarProfileRecipes('mf-cohort', recipes());
  for (const name of ['mf-sdk', 'tanstack-redact'])
    assertSidecarProfileDependencies(name, readSidecarBundleInputs(name));
  for (const bad of [
    packages.slice(1),
    [...packages, packages[0]],
    packages.map((p, index) => (index ? p : { ...p, version: '2.9.4' })),
  ]) {
    assert.throws(
      () => assertSidecarProfileDependencies('mf-cohort', bad),
      /closed profile/u,
    );
  }
  for (const change of [
    list => list.filter(recipe => recipe.id !== 'mf-runtime'),
    list => {
      list.find(recipe => recipe.id === 'mf-runtime').fork.version = '2.9.6';
      return list;
    },
    list => {
      list.find(recipe => recipe.id === 'mf-runtime').upstream.version =
        '2.9.2';
      return list;
    },
    list => {
      list.find(
        recipe => recipe.id === 'mf-runtime',
      ).manifestChanges.dependencies['@module-federation/sdk'] = '2.9.3';
      return list;
    },
  ])
    assert.throws(
      () => assertSidecarProfileRecipes('mf-cohort', change(recipes())),
      /Closed mf-cohort/u,
    );
  assert.throws(
    () => sidecarProfile('mf-cohort-extra'),
    /Unknown sidecar profile/u,
  );
});
