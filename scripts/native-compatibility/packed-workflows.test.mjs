import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import yaml from '../../packages/toolkit/utils/compiled/js-yaml/index.js';

const readWorkflow = name =>
  yaml.load(
    fs.readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    ),
  );
const workflow = readWorkflow('native-compatibility');
const required = [
  'native-framework-contracts',
  'pack-candidate',
  'packed-erp',
  'packed-tractor',
];

test('required native compatibility rejects every unsuccessful or missing consumer lane', () => {
  const aggregate = workflow.jobs['native-compatibility'];
  assert.equal(aggregate.name, 'native-compatibility');
  assert.equal(aggregate.if, 'always()');
  assert.deepEqual(aggregate.needs, required);
  const run = results =>
    spawnSync('bash', ['-c', aggregate.steps[0].run], {
      env: { ...process.env, RESULTS: JSON.stringify(results) },
      encoding: 'utf8',
    });
  const success = Object.fromEntries(
    required.map(name => [name, { result: 'success' }]),
  );
  assert.equal(run(success).status, 0);
  for (const name of required) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.equal(
        run({ ...success, [name]: { result } }).status,
        1,
        `${name}: ${result}`,
      );
    }
    const missing = { ...success };
    delete missing[name];
    assert.equal(run(missing).status, 1, `${name}: missing`);
  }
});

test('ERP and Tractor consume the same once-packed cohort through the release owners', () => {
  const jobs = workflow.jobs;
  const identity = [
    '${{',
    'needs.pack-candidate.outputs.producer_artifact_identity',
    '}}',
  ].join(' ');
  assert.equal(jobs['packed-erp'].needs, 'pack-candidate');
  assert.equal(
    jobs['packed-erp'].uses,
    './.github/workflows/ultramodern-release-acceptance.yml',
  );
  assert.equal(jobs['packed-erp'].with.producer_artifact_identity, identity);
  assert.equal(jobs['packed-tractor'].needs, 'pack-candidate');
  assert.equal(
    jobs['packed-tractor'].uses,
    './.github/workflows/ultramodern-tractor-downstream.yml',
  );
  assert.deepEqual(jobs['packed-tractor'].with, {
    mode: 'source',
    release_bundle_artifact: `bleedingdev-release-bundle-${identity}`,
  });
  const commands = jobs['pack-candidate'].steps
    .map(step => step.run ?? '')
    .join('\n');
  assert.equal(
    (commands.match(/ultramodern:prepare-bleedingdev-publish/g) ?? []).length,
    1,
  );
  assert.match(commands, /packages\/toolkit\/create\/package\.json/);
  assert.match(commands, /--include-sidecars/);
  assert.doesNotMatch(
    commands,
    /--publish|publish-sidecars|qualify-source|test:scripts/,
  );
  const release = readWorkflow('publish-bleedingdev');
  assert.equal(release.jobs['accept-release'].uses, jobs['packed-erp'].uses);
  const acceptance = readWorkflow('ultramodern-release-acceptance');
  assert.deepEqual(acceptance.permissions, {
    actions: 'read',
    contents: 'read',
  });
  assert.match(
    acceptance.jobs['accept-release'].steps
      .map(step => step.run ?? '')
      .join('\n'),
    /--scale-profile erp-10/,
  );
  assert.equal(acceptance.jobs['accept-release'].environment, undefined);
});

test('both required feature workflows stage verified native inputs before consumer execution', () => {
  const source = readWorkflow('ultramodern-release-acceptance').jobs[
    'accept-release'
  ];
  const published = readWorkflow('publish-bleedingdev').jobs[
    'accept-published'
  ];
  for (const job of [source, published]) {
    const step = job.steps.find(step =>
      step.name.includes('installed renderer features'),
    );
    assert(step, 'The required installed feature step must exist');
    const command = step.run;
    assert.match(command, /export OWNED_TEMP_DIR="\$feature_work"/u);
    assert.match(command, /feature_work="\$\(realpath "\$feature_work"\)"/u);
    assert.match(
      command,
      /trap 'rm -rf -- "\$feature_work\/native-inputs"' EXIT/u,
    );
    const stage = command.indexOf('native-federation-inputs.mjs');
    const proof = command.indexOf('ultramodern-renderers/release.mjs');
    assert(
      stage >= 0 && stage < proof,
      'Verified inputs must be staged before any proof runs',
    );
    assert.match(
      command,
      /--manifest "\$BLEEDINGDEV_RELEASE_MANIFEST" --out "\$feature_work\/native-inputs"/u,
    );
    assert.match(
      command,
      /--native-inputs "\$feature_work\/native-inputs\/native-inputs\.json"/u,
    );
    assert.match(command, /--required-features/u);
  }
});

test('required native PR checks run focused renderer acceptance controls', () => {
  const controls = workflow.jobs['native-framework-contracts'].steps.find(
    step => step.name === 'Test renderer acceptance controls',
  );
  assert(controls);
  assert.match(controls.run, /OWNED_TEMP_DIR="\$controls_work" node --test/u);
  assert.match(controls.run, /scripts\/ultramodern-renderers\/\*\.test\.mjs/u);
  assert.match(
    controls.run,
    /scripts\/native-compatibility\/packed-workflows\.test\.mjs/u,
  );
  assert.match(controls.run, /trap 'rm -rf -- "\$controls_work"' EXIT/u);
});
