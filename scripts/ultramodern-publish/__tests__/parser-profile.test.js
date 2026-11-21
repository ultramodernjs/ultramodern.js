const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const supplyRoot = path.resolve(__dirname, '../../ultramodern-supply');
const readCatalog = name =>
  JSON.parse(fs.readFileSync(path.join(supplyRoot, name), 'utf8'));
const retainedIds = [
  'braces',
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
  'tanstack-redact',
];

for (const name of ['sidecars.json', 'sidecar-candidates-20261116.json']) {
  test(`${name} retains only the 14 MF corrections, Redact and Braces`, () => {
    const recipes = readCatalog(name);
    assert.deepEqual(recipes.map(recipe => recipe.id).sort(), retainedIds);
    assert.equal(new Set(recipes.map(recipe => recipe.fork.name)).size, 16);
  });
}

test('parser qualification keeps Braces as its only sidecar and exercises exact stock dependencies', async () => {
  const { sidecarProfile, sidecarProfileRecipes } = await import(
    '../sidecar-profiles.mjs'
  );
  const profile = sidecarProfile('parser');
  assert.deepEqual(profile.recipeIds, ['braces']);
  assert.deepEqual(profile.qualificationDependencies, {
    micromatch: '4.0.8',
    'fast-glob': '3.3.3',
    'find-workspaces': '0.3.1',
    '@rsbuild/plugin-source-build': '1.0.7',
    ultracite: '8.2.1',
    oxlint: '1.94.0',
    oxfmt: '0.79.0',
  });
  assert.deepEqual(
    sidecarProfileRecipes('parser').map(recipe => recipe.fork),
    [{ name: '@bleedingdev/braces', version: '3.0.4' }],
  );
  assert.deepEqual(profile.probeKeys, [
    'packed-install',
    'braces-api',
    'braces-depth-guard',
    'glob-api',
    'ultracite-api',
  ]);
});

test('reduced candidate catalog still rejects identity, provenance and artifact widening outside the parser profile', async t => {
  // Exercise the public loader against isolated catalogs, never mutate the
  // shared checkout while other implementation workers are using it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publish = path.join(root, 'ultramodern-publish');
  const supply = path.join(root, 'ultramodern-supply');
  fs.mkdirSync(publish);
  fs.mkdirSync(supply);
  const modulePath = path.join(publish, 'sidecar-profiles.mjs');
  fs.copyFileSync(path.join(__dirname, '../sidecar-profiles.mjs'), modulePath);
  const active = readCatalog('sidecars.json');
  const candidates = readCatalog('sidecar-candidates-20261116.json');
  const writeCandidates = value =>
    fs.writeFileSync(
      path.join(supply, 'sidecar-candidates-20261116.json'),
      JSON.stringify(value),
    );
  fs.writeFileSync(path.join(supply, 'sidecars.json'), JSON.stringify(active));
  writeCandidates(candidates);
  const { sidecarProfileRecipes } = await import(pathToFileURL(modulePath));
  assert.deepEqual(
    sidecarProfileRecipes('parser').map(recipe => recipe.id),
    ['braces'],
  );
  for (const [label, mutate, expected] of [
    ['missing identity', list => list.slice(1), /Candidate recipe set/u],
    [
      'duplicate identity',
      list => [...list.slice(0, -1), list[0]],
      /Candidate recipe set/u,
    ],
    [
      'unreviewed name',
      list => {
        list[0].fork.name = '@bleedingdev/unreviewed-redact';
        return list;
      },
      /cannot add a name or relax provenance/u,
    ],
    [
      'upstream substitution',
      list => {
        list[0].upstream.name = 'unreviewed-redact';
        return list;
      },
      /cannot add a name or relax provenance/u,
    ],
    [
      'relaxed provenance',
      list => {
        list[0].provenance = {};
        return list;
      },
      /cannot add a name or relax provenance/u,
    ],
    [
      'partial artifact',
      list => {
        list[0].artifacts = ['dist/**'];
        return list;
      },
      /Incomplete candidate artifact\/license/u,
    ],
    [
      'license substitution',
      list => {
        list[0].license = 'UNLICENSED';
        return list;
      },
      /Incomplete candidate artifact\/license/u,
    ],
    [
      'unsafe patch',
      list => {
        list[0].patch.path = '../unreviewed.patch';
        return list;
      },
      /Invalid direct candidate patch descriptor/u,
    ],
    [
      'unauthenticated patch',
      list => {
        list[0].patch.sha256 = 'not-a-sha256';
        return list;
      },
      /Invalid direct candidate patch descriptor/u,
    ],
  ]) {
    writeCandidates(mutate(structuredClone(candidates)));
    assert.throws(() => sidecarProfileRecipes('parser'), expected, label);
  }
  writeCandidates(candidates);
  assert.equal(sidecarProfileRecipes('parser').length, 1);
});
