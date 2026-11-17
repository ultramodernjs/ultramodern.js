const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withFixtureBootstraps } = require('./sidecar-bootstrap-fixture.js');

test('candidate bundle inputs are independent of the current published consumer graph', async t => {
  withFixtureBootstraps(t);
  const { sidecarNameProvenance, sidecarProfileRecipes } = await import(
    '../sidecar-profiles.mjs'
  );
  const { assertRecipeConsumers, assertRecipeGraph } = await import(
    '../../ultramodern-supply/verify-sidecars.mjs'
  );
  const root = path.resolve(__dirname, '../../..');
  const read = file =>
    JSON.parse(
      execFileSync('git', ['show', `HEAD:${file}`], {
        cwd: root,
        encoding: 'utf8',
      }),
    );
  const active = read('scripts/ultramodern-supply/sidecars.json');
  const manifests = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', 'HEAD', 'packages'],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(file => file.endsWith('/package.json'))
    .map(read)
    .filter(
      manifest => manifest.name?.startsWith('@modern-js/') && !manifest.private,
    )
    .map(manifest => ({
      ...manifest,
      name: manifest.name.replace('@modern-js/', '@bleedingdev/modern-js-'),
    }));
  assertRecipeGraph(active);
  assertRecipeConsumers(active, {
    generatorPins: [],
    publishedManifests: manifests,
  });
  const candidates = [
    'mf-cohort',
    'tanstack-redact',
    'parser',
    'picomatch-4',
  ].flatMap(sidecarProfileRecipes);
  assert.equal(candidates.length, 23);
  assert.equal(new Set(candidates.map(recipe => recipe.id)).size, 23);
  assertRecipeGraph(candidates);
  // Live HEAD manifests are not a candidate oracle: they may already declare
  // candidate aliases. Each negative/positive case uses an explicit fixture.
  for (const recipe of candidates)
    assert.throws(
      () =>
        assertRecipeConsumers(candidates, {
          generatorPins: [],
          publishedManifests: [
            {
              name: '@bleedingdev/modern-js-previous-consumer',
              dependencies: { [recipe.upstream.name]: recipe.upstream.version },
            },
          ],
        }),
      error =>
        error.message.includes(
          `npm:${recipe.fork.name}@${recipe.fork.version}`,
        ),
      `${recipe.id}: a previous consumer on the upstream identity must be rejected`,
    );
  const four = candidates.find(recipe => recipe.id === 'picomatch-4');
  assertRecipeConsumers(candidates, {
    generatorPins: [
      {
        'picomatch@>=4.0.0 <4.0.8': `npm:${four.fork.name}@${four.fork.version}`,
      },
    ],
    publishedManifests: [
      {
        name: '@bleedingdev/modern-js-current-consumer',
        dependencies: Object.fromEntries(
          candidates
            .filter(recipe => recipe !== four)
            .map(recipe => [
              recipe.upstream.name,
              `npm:${recipe.fork.name}@${recipe.fork.version}`,
            ]),
        ),
      },
    ],
  });
  // Active names keep their chronology; a new name carries its pinned bootstrap.
  for (const candidate of candidates)
    assert.deepEqual(
      candidate.provenance,
      active.find(recipe => recipe.id === candidate.id)?.provenance ??
        sidecarNameProvenance(candidate.fork.name),
    );
  const file = path.join(root, 'scripts/ultramodern-supply/sidecars.json');
  const before = fs.readFileSync(file);
  sidecarProfileRecipes('mf-cohort');
  assert.deepEqual(fs.readFileSync(file), before);
});
