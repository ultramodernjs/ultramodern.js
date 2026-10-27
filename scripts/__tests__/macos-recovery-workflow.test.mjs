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

test('macOS recovery stays in the PR-associated check suite', () => {
  assert.deepEqual(workflow.on.pull_request.types, [
    'opened',
    'synchronize',
    'reopened',
    'labeled',
    'unlabeled',
  ]);
  assert.equal(
    workflow.concurrency.group,
    `\${{ github.workflow }}-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.ref }}`,
  );
});

test('only explicit recovery selects GitHub-hosted macOS over the configured pool', () => {
  assert.equal(
    workflow.on.workflow_dispatch.inputs.runner_backend.default,
    'configured',
  );
  assert.equal(
    workflow.jobs['ut-mac-shards']['runs-on'].replace(/\s+/gu, ' ').trim(),
    `\${{ (github.event_name == 'workflow_dispatch' && inputs.runner_backend == 'github-hosted' || github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'ci:github-hosted-macos')) && 'macos-26' || vars.DEPOT_MACOS_RUNNER || 'macos-26' }}`,
  );
});

test('macOS recovery retains every shard and the fail-closed required gate', () => {
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
