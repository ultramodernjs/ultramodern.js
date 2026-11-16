import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// Use the prebundler's declared parser without requiring generated framework output.
const require = createRequire(
  new URL('../prebundle/package.json', import.meta.url),
);
const yaml = require('js-yaml');

const workflow = yaml.load(
  readFileSync(
    new URL('../../.github/workflows/ut-macOS.yml', import.meta.url),
    'utf8',
  ),
);

test('macOS units stay in the PR-associated check suite', () => {
  assert.deepEqual(workflow.on.pull_request.branches, [
    'main',
    'main-ultramodern',
  ]);
  assert.equal(
    workflow.concurrency.group,
    `\${{ github.workflow }}-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.ref }}`,
  );
});

// Every job of this repository runs on Depot. The former `ci:github-hosted-macos`
// label and the `runner_backend` dispatch input selected GitHub-hosted macOS,
// which is exactly what this check must no longer be able to do: a blocked
// Depot pool has to block the required check, not move it to other hardware.
test('the macOS units select Depot with no GitHub-hosted escape', () => {
  assert.equal(
    workflow.jobs['ut-mac-shards']['runs-on'],
    `\${{ vars.DEPOT_MACOS_RUNNER || 'depot-macos-26' }}`,
  );
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.equal(workflow.on.pull_request.types, undefined);
  const source = readFileSync(
    new URL('../../.github/workflows/ut-macOS.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /runner_backend|ci:github-hosted-macos/u);
  assert.doesNotMatch(source, /macos-26(?!-)(?<!depot-macos-26)/u);
});

test('macOS units retain every shard and the fail-closed required gate', () => {
  const shards = workflow.jobs['ut-mac-shards'];
  assert.equal(shards.if, undefined);
  assert.equal(shards.strategy['fail-fast'], false);
  assert.deepEqual(shards.strategy.matrix.shard, [1, 2, 3]);
  assert.equal(
    shards.steps.find(step => step.name === 'Test').run,
    `pnpm run test:ut:prepared --shard=\${{ matrix.shard }}/3`,
  );
  const gate = workflow.jobs['ut-mac'];
  assert.equal(gate.if, `\${{ always() }}`);
  assert.equal(gate.needs, 'ut-mac-shards');
  assert.equal(
    gate.steps[0].env.SHARD_RESULT,
    `\${{ needs.ut-mac-shards.result }}`,
  );
  assert.match(
    gate.steps[0].run,
    /if \[\[ "\$SHARD_RESULT" != "success" \]\]/u,
  );
  assert.match(gate.steps[0].run, /exit 1/u);
});
