const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
  assert.deepEqual(
    recipes().find(recipe => recipe.id === 'mf-enhanced').manifestChanges
      .peerDependencies,
    { webpack: '^5.112.2' },
  );
  assert.deepEqual(profile.qualificationDependencies, { webpack: '5.112.2' });
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
    list => {
      list.find(
        recipe => recipe.id === 'mf-enhanced',
      ).manifestChanges.peerDependencies = { webpack: '^5.0.0' };
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

test('Modern.js config types activate the qualified recipe and preserve every canonical correction', async () => {
  const { sidecarProfileRecipes } = await import('../sidecar-profiles.mjs');
  const active = JSON.parse(
    fs.readFileSync(
      new URL('../../ultramodern-supply/sidecars.json', `file://${__filename}`),
      'utf8',
    ),
  );
  const selected = sidecarProfileRecipes('mf-cohort');
  for (const recipe of selected) {
    const original = active.find(item => item.id === recipe.id);
    assert.equal(
      recipe.fork.version,
      recipe.id === 'mf-modern-js-v3' ? '2.9.6' : original.fork.version,
    );
  }
  const recipe = selected.find(item => item.id === 'mf-modern-js-v3');
  const original = active.find(item => item.id === recipe.id);
  assert.equal(original.fork.version, '2.9.6');
  assert.deepEqual(recipe, original);
  const readPatch = name =>
    fs.readFileSync(
      new URL(`../../../${name}`, `file://${__filename}`),
      'utf8',
    );
  const canonical = readPatch(
    'patches/@module-federation__modern-js-v3@2.9.3.patch',
  );
  const candidate = readPatch(recipe.patch.path);
  assert.equal(
    createHash('sha256').update(candidate).digest('hex'),
    recipe.patch.sha256,
  );
  assert.ok(candidate.startsWith(canonical));
  assert.equal(
    candidate.slice(canonical.length),
    `diff --git a/dist/types/cli/index.d.ts b/dist/types/cli/index.d.ts
--- a/dist/types/cli/index.d.ts
+++ b/dist/types/cli/index.d.ts
@@ -2,5 +2,5 @@
 import type { PluginOptions } from '../types';
 export declare const moduleFederationPlugin: (userConfig?: PluginOptions) => CliPlugin<AppTools>;
 export default moduleFederationPlugin;
-export { createModuleFederationConfig } from '@module-federation/enhanced';
+export { createModuleFederationConfig } from '@module-federation/sdk';
 export type { ModuleFederationRuntimePlugin } from '@module-federation/enhanced/runtime';
`,
  );
});
