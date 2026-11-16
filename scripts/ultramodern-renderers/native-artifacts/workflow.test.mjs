import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fixture } from './fixtures.test-support.mjs';
import { currentProducer } from './main.mjs';
import { repository, repositoryId, workflow } from './protocol.mjs';
import { releaseRecipe } from './recipes.mjs';

test('workflow separates read-only qualifications from the final release writer', () => {
  const source = fs.readFileSync(
    new URL(
      '../../../.github/workflows/native-renderer-artifacts.yml',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(source, /workflow_dispatch:/u);
  assert(
    !/workflow_call:|workflow_run:|pull_request_target:|id-token:|secrets\.|npm publish|clobber|latest\/download/u.test(
      source,
    ),
  );
  assert.equal(source.match(/contents: write/gu)?.length, 1);
  assert.equal(source.match(/contents: read/gu)?.length, 3);
  assert.match(source, /release:\n\s+needs: \[produce, qualify\]/u);
  assert.equal(source.match(/persist-credentials: false/gu)?.length, 3);
  assert.equal(source.match(/ref: \$\{\{ github.sha \}\}/gu)?.length, 3);
  assert.match(source, /github.repository_id == '1151231350'/u);
  assert.match(source, /github.ref == 'refs\/heads\/main-ultramodern'/u);
  assert.match(source, /github.actor == 'BleedingDev'/u);
  assert.match(source, /github.triggering_actor == 'BleedingDev'/u);
  assert.equal(source.match(/runs-on: ubuntu-24\.04$/gmu)?.length, 3);
  assert(!source.includes('DEPOT_LINUX_RUNNER'));
  for (const action of source.matchAll(/uses: ([^\n]+)/gu))
    assert.match(action[1], /^[a-z-]+\/[a-z-]+@[a-f0-9]{40}(?: #.*)?$/u);
});
test('runtime source identity is restricted to canonical main workflow dispatch', () => {
  const { producer } = fixture();
  const env = {
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: String(repositoryId),
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main-ultramodern`,
    GITHUB_REF: 'refs/heads/main-ultramodern',
    GITHUB_ACTOR: 'BleedingDev',
    GITHUB_TRIGGERING_ACTOR: 'BleedingDev',
    GITHUB_SHA: producer.source,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
  };
  assert.deepEqual(currentProducer(env), producer);
  for (const key of [
    'GITHUB_REPOSITORY',
    'GITHUB_REPOSITORY_ID',
    'GITHUB_EVENT_NAME',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_REF',
    'GITHUB_ACTOR',
    'GITHUB_TRIGGERING_ACTOR',
  ])
    assert.throws(() => currentProducer({ ...env, [key]: 'unit-other' }));
});
test('production recipe has all four exact pins without claiming a successful producer run', () => {
  const recipe = releaseRecipe();
  assert.equal(Object.keys(recipe.packages).length, 4);
  assert.equal(
    recipe.packages.octane.patchSha256,
    '529e0cbb9dd695c7569ae9d64b04ee0ba9685402823faa230c339d582d811f74',
  );
  assert.equal(typeof recipe.qualifySource, 'function');
  assert.equal(typeof recipe.qualifyPacked, 'function');
});
