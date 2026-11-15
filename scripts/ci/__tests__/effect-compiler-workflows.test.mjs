import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';
import { evaluateJobSchedule } from '../../security/github-job-condition.mjs';

const read = name =>
  yaml.load(
    fs.readFileSync(
      new URL(`../../../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    ),
  );
const producer = read('effect-compiler-payload');
const integration = read('integration-test');
const native = read('native-compatibility');
const publish = read('publish-bleedingdev');
const expression = value => ['$' + '{{', value, '}}'].join(' ');
const producerPath = './.github/workflows/effect-compiler-payload.yml';
const stage =
  'node scripts/ultramodern-publish/stage-effect-compiler-payload.mjs stage --input .modern/effect-compiler-input --complete-manifest';

function assertHandoff(job, before, conditional = false) {
  const download = job.steps.findIndex(
    step => step.name === 'Download corrected Effect compiler payload',
  );
  const staging = job.steps.findIndex(step => step.run === stage);
  const build = job.steps.findIndex(step => step.name === before);
  assert.ok(download >= 0 && download < staging && staging < build, before);
  assert.equal(
    job.steps[download].with.name,
    `effect-compiler-payload-${expression('github.sha')}`,
  );
  assert.equal(job.steps[download].with.path, '.modern/effect-compiler-input');
  if (conditional) {
    assert.equal(job.steps[download].if, "inputs.recovery_run_id == ''");
    assert.equal(job.steps[staging].if, "inputs.recovery_run_id == ''");
  }
  assert.ok(!job.steps.some(step => /chmod|\bcp\b/.test(step.run ?? '')));
}

test('compiler matrix uses exactly five native pinned-base release builds', () => {
  assert.deepEqual(producer.on, { workflow_call: null });
  assert.deepEqual(producer.jobs.build.strategy.matrix.include, [
    {
      target: 'darwin-arm64',
      rust_target: 'aarch64-apple-darwin',
      runner: 'macos-latest',
    },
    {
      target: 'darwin-x64',
      rust_target: 'x86_64-apple-darwin',
      runner: 'macos-26-intel',
    },
    {
      target: 'linux-x64',
      rust_target: 'x86_64-unknown-linux-gnu',
      runner: 'ubuntu-22.04',
    },
    {
      target: 'linux-arm64',
      rust_target: 'aarch64-unknown-linux-gnu',
      runner: 'ubuntu-22.04-arm',
    },
    {
      target: 'win32-x64',
      rust_target: 'x86_64-pc-windows-msvc',
      runner: 'windows-latest',
    },
  ]);
  const steps = producer.jobs.build.steps;
  const checkout = steps.find(
    step => step.with?.repository === 'Effect-TS/tsgo',
  );
  assert.equal(checkout.with.ref, '3cbaa7bc6f149b83d4d3c2f67ef95f8426487d8e');
  const setup = steps.find(
    step => step.uses === './.github/actions/setup-repo',
  );
  assert.equal(setup.with.component, 'tsrs');
  assert.equal(setup.with.version, '0.21.0-ts7.1.0-beta');
  const correction = steps.find(step =>
    step.name.startsWith('Verify source contract'),
  );
  assert.ok(steps.indexOf(correction) < steps.indexOf(setup));
  assert.match(correction.run, /source\.patchSha256/);
  assert.match(correction.run, /compiler';/);
  assert.match(correction.run, /035-checker-base-constraint-identity\.patch/);
  const build = steps.find(step => step.id === 'compiler');
  assert.match(build.run, /repoctl build artifact --component tsrs/);
  assert.match(
    build.run,
    /--version 0\.21\.0-ts7\.1\.0-beta --target "\$TARGET" --optimize none/,
  );
  const smoke = steps.find(step =>
    step.name.startsWith('Smoke the actual release'),
  );
  assert.equal(
    smoke.env.ARTIFACT_DIR,
    expression('steps.compiler.outputs.artifact_path'),
  );
  assert.match(smoke.run, /Version 7\.1\.0-beta\+effect-tsgo\.0\.67\.0/);
  assert.match(smoke.run, /client\.echo/);
  assert.match(smoke.run, /377001/);
  const notices = steps.find(step =>
    step.name.startsWith('Include source licenses'),
  );
  const receipt = steps.find(step =>
    step.name.startsWith('Produce the target'),
  );
  assert.ok(steps.indexOf(smoke) < steps.indexOf(receipt));
  assert.ok(steps.indexOf(notices) < steps.indexOf(receipt));
  for (const name of [
    'LICENSE-Effect',
    'LICENSE-tsrs',
    'LICENSE-TypeScript',
    'THIRD-PARTY-NOTICES',
  ])
    assert.ok(notices.run.includes(name));
  assert.match(receipt.run, /--artifact-dir "\$ARTIFACT_DIR"/);
  const upload = steps.find(step =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.equal(
    upload.with.name,
    `effect-compiler-target-${expression('matrix.target')}-${expression('github.sha')}`,
  );
  const aggregate = producer.jobs.aggregate;
  assert.equal(aggregate.needs, 'build');
  const download = aggregate.steps.find(step =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  assert.equal(
    download.with.pattern,
    `effect-compiler-target-*-${expression('github.sha')}`,
  );
  assert.equal(download.with['merge-multiple'], false);
  const final = aggregate.steps.find(step =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.equal(
    final.with.name,
    `effect-compiler-payload-${expression('github.sha')}`,
  );
  assert.equal(
    final.with.path,
    'packages/solutions/app-tools-extensions/compiler/payload',
  );
});

test('every fresh build stages the complete payload before selecting a compiler', () => {
  for (const [id, build] of [
    ['native-framework-contracts', 'Prepare'],
    ['pack-candidate', 'Build the publishable cohort'],
  ]) {
    assert.equal(native.jobs[id].needs, 'effect-compiler-payload');
    assertHandoff(native.jobs[id], build);
  }
  assert.equal(native.jobs['effect-compiler-payload'].uses, producerPath);
  assertHandoff(integration.jobs.integration, 'Prepare');
  assert.equal(
    integration.jobs.integration.steps.some(
      step => step.uses === './.github/actions/restore-build-cache',
    ),
    false,
  );
  for (const [id, build] of [
    ['qualify-source-compute', 'Qualify release source'],
    ['prepare-release', 'Build Packages'],
  ]) {
    assert.equal(publish.jobs[id].needs, 'effect-compiler-payload');
    assertHandoff(publish.jobs[id], build, true);
  }
});

test('publish invokes one producer; nested integration reuses it rather than colliding', () => {
  assert.equal(
    Object.values(publish.jobs).filter(job => job.uses === producerPath).length,
    1,
  );
  assert.equal(publish.jobs.integration.needs, 'effect-compiler-payload');
  assert.equal(publish.jobs.integration.with.compiler_payload_provided, true);
  assert.equal(
    integration.on.workflow_call.inputs.compiler_payload_provided.default,
    false,
  );
  assert.equal(
    integration.jobs['effect-compiler-payload'].if,
    'inputs.compiler_payload_provided != true',
  );
  assert.match(
    integration.jobs.integration.if,
    /always\(\).*?cancelled\(\) == false/s,
  );
  assert.match(
    integration.jobs.integration.if,
    /inputs.compiler_payload_provided == true/,
  );
  assert.match(integration.jobs.integration.if, /result == 'success'/);
});

test('recovery retains current-source integration and compiler qualification; sidecars do not build a compiler', () => {
  assert.equal(
    publish.jobs['effect-compiler-payload'].needs,
    'publish-security',
  );
  assert.match(
    publish.jobs['effect-compiler-payload'].if,
    /inputs\.mode == 'cohort'/,
  );
  assert.doesNotMatch(
    publish.jobs['effect-compiler-payload'].if,
    /recovery_run_id/,
  );
  assert.doesNotMatch(publish.jobs.integration.if, /recovery_run_id/);
  for (const id of ['qualify-source-compute', 'prepare-release'])
    assert.equal(publish.jobs[id].needs, 'effect-compiler-payload');
  for (const id of ['prepare-sidecars', 'qualify-sidecars'])
    assert.ok(!publish.jobs[id].needs?.includes('effect-compiler-payload'));
  const context = {
    github: {
      actor: 'BleedingDev',
      triggering_actor: 'BleedingDev',
      ref: 'refs/heads/main-ultramodern',
    },
    vars: { BLEEDINGDEV_PUBLISH_BRANCH: 'main-ultramodern' },
    inputs: { mode: 'cohort', recovery_run_id: '123', dry_run: false },
  };
  const results = Object.fromEntries(
    Object.keys(publish.jobs).map(id => [id, 'success']),
  );
  for (const jobId of [
    'integration',
    'qualify-source-compute',
    'prepare-release',
  ]) {
    assert.equal(
      evaluateJobSchedule({ workflow: publish, jobId, results, context }),
      true,
    );
    for (const result of ['failure', 'cancelled', 'skipped'])
      assert.equal(
        evaluateJobSchedule({
          workflow: publish,
          jobId,
          results: { ...results, 'effect-compiler-payload': result },
          context,
        }),
        false,
      );
  }
  for (const jobId of ['qualify-source', 'publish', 'publish-sidecars'])
    for (const result of ['failure', 'cancelled', 'skipped'])
      assert.equal(
        evaluateJobSchedule({
          workflow: publish,
          jobId,
          results: { ...results, integration: result },
          context,
        }),
        false,
        `${jobId} rejects recovery integration ${result}`,
      );
});

test('native and release qualification run isolated fake contracts before native compilation', () => {
  for (const [job, nativeBuild] of [
    [native.jobs['native-framework-contracts'], 'Prepare'],
    [publish.jobs['qualify-source-compute'], 'Qualify release source'],
  ]) {
    const contract = job.steps.findIndex(
      step =>
        step.name ===
        'Test owned compiler payload contracts without native builds',
    );
    assert.ok(
      contract >= 0 &&
        contract < job.steps.findIndex(step => step.name === nativeBuild),
    );
    assert.match(job.steps[contract].run, /OWNED_TEMP_DIR=/);
    assert.match(job.steps[contract].run, /trap/);
    for (const name of [
      'resolve.test.cjs',
      'stage-effect-compiler-payload.test.mjs',
      'effect-tsrs-provider.test.mjs',
      'owned-effect-discovery.test.mjs',
    ])
      assert.ok(
        fs
          .readFileSync(
            new URL(
              '../../ultramodern-publish/test-effect-compiler-contracts.mjs',
              import.meta.url,
            ),
            'utf8',
          )
          .includes(name),
      );
  }
});
