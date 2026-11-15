import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
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

test('retained Tractor adoption is owner-only and leaves reusable acceptance read-only', () => {
  const tractor = readWorkflow('ultramodern-tractor-downstream');
  const job = tractor.jobs['tractor-downstream'];
  const github = {
    event_name: 'workflow_dispatch',
    repository: 'ultramodernjs/ultramodern.js',
    actor: 'BleedingDev',
    triggering_actor: 'BleedingDev',
    ref: 'refs/heads/main-ultramodern',
  };
  const allowed = (overrides, artifact = '') =>
    runInNewContext(job.if, {
      github: { ...github, ...overrides },
      inputs: { release_bundle_artifact: artifact },
    });
  assert.equal(allowed({}), true);
  for (const overrides of [
    { actor: 'other' },
    { triggering_actor: 'other' },
    { ref: 'refs/heads/other' },
    { repository: 'other/repository' },
  ])
    assert.equal(allowed(overrides), false);
  assert.equal(allowed({ event_name: 'pull_request', actor: 'other' }), true);
  assert.equal(allowed({ actor: 'other' }, 'same-run-bundle'), true);
  assert.deepEqual(tractor.permissions, { actions: 'read', contents: 'read' });
  assert.equal(job.environment, undefined);
  assert.equal(job.permissions, undefined);
  const download = job.steps.find(
    step => step.name === 'Download exact release bundle',
  );
  assert.match(download.with['run-id'], /workflow_dispatch/u);
  assert.match(download.with['run-id'], /github\.run_id/u);
  assert.match(download.with.name, /inputs\.release_bundle_artifact/u);
  const retain = job.steps.find(
    step => step.name === 'Retain the accepted Tractor source commit',
  );
  assert.equal(
    retain.if,
    "success() && github.event_name == 'workflow_dispatch' && inputs.release_bundle_artifact == ''",
  );
  assert.equal(
    runInNewContext(retain.if, {
      success: () => true,
      github,
      inputs: { release_bundle_artifact: 'same-run-bundle' },
    }),
    false,
  );
  assert.match(retain.run, /export-tractor-acceptance-source\.mjs/u);
  const upload = job.steps.find(
    step => step.name === 'Upload the accepted Tractor source',
  );
  assert.equal(upload.if, retain.if);
  assert.equal(
    upload.with.path,
    'modernjs/.modern/production-readiness/tractor-source',
  );
  assert.equal(upload.with['if-no-files-found'], 'error');
});

test('retained Tractor adoption requires a successful live publication and exact release inputs', () => {
  const job = readWorkflow('ultramodern-tractor-downstream').jobs[
    'tractor-downstream'
  ];
  const validate = job.steps.find(
    step =>
      step.name === 'Validate retained adoption inputs and publication run',
  );
  const source = 'a'.repeat(40);
  const run = {
    conclusion: 'success',
    head_sha: source,
    head_branch: 'main-ultramodern',
    event: 'workflow_dispatch',
    path: '.github/workflows/publish-bleedingdev.yml',
    run_attempt: 2,
  };
  const jobs = {
    jobs: [
      { name: 'Publish accepted @bleedingdev tarballs', conclusion: 'success' },
    ],
  };
  const execute = (env = {}, runOverrides = {}, jobData = jobs) =>
    spawnSync(
      'bash',
      [
        '-e',
        '-c',
        `gh() { if [ "\${GH_FAIL:-0}" = 1 ]; then return 1; fi; case "$2" in *"/jobs?"*) printf '%s' "$JOB_DATA";; *) printf '%s' "$RUN_DATA";; esac; }\n${validate.run}`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PRODUCER_RUN_ID: '123',
          PRODUCER_RUN_ATTEMPT: '2',
          EXPECTED_SOURCE: source,
          EXPECTED_VERSION: '3.11.3-ultramodern.2',
          GITHUB_REPOSITORY: 'ultramodernjs/ultramodern.js',
          RUN_DATA: JSON.stringify({ ...run, ...runOverrides }),
          JOB_DATA: JSON.stringify(jobData),
          ...env,
        },
      },
    );
  assert.equal(execute().status, 0);
  assert.notEqual(execute({ GH_FAIL: '1' }).status, 0);
  for (const env of [
    { PRODUCER_RUN_ID: 'invalid' },
    { PRODUCER_RUN_ATTEMPT: '0' },
    { EXPECTED_SOURCE: 'main' },
    { EXPECTED_VERSION: 'latest' },
  ])
    assert.notEqual(execute(env).status, 0, JSON.stringify(env));
  for (const overrides of [
    { conclusion: 'failure' },
    { head_sha: 'b'.repeat(40) },
    { event: 'pull_request' },
    { path: '.github/workflows/other.yml' },
    { head_branch: 'other' },
    { run_attempt: 1 },
  ])
    assert.notEqual(execute({}, overrides).status, 0);
  assert.notEqual(execute({}, {}, { jobs: [] }).status, 0);
  assert.notEqual(
    execute({}, {}, { jobs: [{ ...jobs.jobs[0], conclusion: 'skipped' }] })
      .status,
    0,
  );
  const identity = job.steps.find(
    step => step.name === 'Verify retained adoption release identity',
  );
  assert.match(
    identity.run,
    /\.source\.commit == \$sha and \.release\.version == \$version/u,
  );
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
  assert.match(
    controls.run,
    /scripts\/__tests__\/rslib-tsrs-options\.test\.mjs/u,
  );
  assert.match(controls.run, /trap 'rm -rf -- "\$controls_work"' EXIT/u);
});

test('feature proofs use Depot for owned jobs and retain GitHub-hosted fork isolation', () => {
  const source = readWorkflow('ultramodern-release-acceptance').jobs[
    'accept-release'
  ];
  const published = readWorkflow('publish-bleedingdev').jobs[
    'accept-published'
  ];
  const expression = source['runs-on'].slice(3, -3);
  const select = (required, vars = {}, foreign = false) =>
    runInNewContext(expression, {
      inputs: { required_renderer_features: required },
      github: {
        event_name: 'pull_request',
        repository: 'owner/repo',
        event: {
          pull_request: {
            head: {
              repo: { full_name: foreign ? 'contributor/repo' : 'owner/repo' },
            },
          },
        },
      },
      vars,
      fromJSON: JSON.parse,
    });
  for (const required of [false, true]) {
    assert.equal(
      select(required, { DEPOT_LINUX_RUNNER: 'depot-linux' }),
      'depot-linux',
    );
    assert.equal(
      select(required, { DEPOT_LINUX_RUNNER: 'depot-linux' }, true),
      'ubuntu-latest',
    );
    assert.equal(
      select(required, {
        BLEEDINGDEV_ACCEPT_RUNNER_LABELS: '["self-hosted","linux"]',
      }),
      'depot-ubuntu-24.04-8',
    );
    assert.equal(select(required), 'depot-ubuntu-24.04-8');
  }
  const publishedRunner = published['runs-on'].slice(3, -3);
  assert.equal(
    runInNewContext(publishedRunner, {
      vars: { DEPOT_LINUX_RUNNER: 'depot-linux' },
    }),
    'depot-linux',
  );
  assert.equal(
    runInNewContext(publishedRunner, { vars: {} }),
    'depot-ubuntu-24.04-8',
  );
  for (const job of [source, published]) {
    for (const env of [job.env, ...job.steps.map(step => step.env)]) {
      assert.equal(env?.RUNNER_ENVIRONMENT, undefined);
      assert.equal(env?.GITHUB_ACTIONS, undefined);
      assert.equal(env?.RUNNER_NAME, undefined);
    }
  }
});

test('renderer evidence is required after execution, not when upstream failure skipped the feature step', () => {
  const job = readWorkflow('ultramodern-release-acceptance').jobs[
    'accept-release'
  ];
  const execution = job.steps.find(
    step => step.name === 'Run exact-bundle installed renderer features',
  );
  const evidence = job.steps.find(
    step => step.name === 'Preserve renderer feature runtime evidence',
  );
  assert.equal(execution.id, 'renderer-features');
  assert.equal(evidence.with['if-no-files-found'], 'error');
  assert.equal(evidence.with['include-hidden-files'], true);
  assert.equal(
    evidence.if,
    "always() && inputs.required_renderer_features && steps.renderer-features.outcome != 'skipped'",
  );
  // GitHub treats hyphenated step ids as property names, not subtraction.
  const condition = evidence.if.replaceAll(
    'steps.renderer-features',
    'steps["renderer-features"]',
  );
  for (const outcome of ['success', 'failure', 'cancelled', 'skipped']) {
    for (const required of [true, false]) {
      assert.equal(
        runInNewContext(condition, {
          always: () => true,
          inputs: { required_renderer_features: required },
          steps: { 'renderer-features': { outcome } },
        }),
        required && outcome !== 'skipped',
      );
    }
  }
});
