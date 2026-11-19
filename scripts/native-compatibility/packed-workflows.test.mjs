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
// The clean-room ERP acceptance and the Tractor rehearsal left the pull
// request: the release lane runs the identical reusable workflows on the real
// bundle and both still block every publish, so this gate covers the two lanes
// that stayed.
const required = ['native-framework-contracts', 'pack-candidate'];

test('publication tooling qualifies inside the release gate, not only in a separate push run', () => {
  const { jobs } = readWorkflow('publish-bleedingdev');
  const tooling = jobs['qualify-source-compute'].steps.find(
    step => step.name === 'Qualify the release publication tooling',
  );
  assert.equal(tooling.if, undefined);
  assert.equal(tooling['continue-on-error'], undefined);
  assert.match(tooling.run, /mise exec -- pnpm run test:publish-tooling/u);
  assert.ok(jobs['qualify-source'].needs.includes('qualify-source-compute'));
  for (const job of ['publish', 'publish-sidecars', 'validate-release'])
    assert.ok(jobs[job].needs.includes('qualify-source'));
});

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
  const release = readWorkflow('publish-bleedingdev');
  const identity = [
    '${{',
    'needs.prepare-release.outputs.producer_artifact_identity',
    '}}',
  ].join(' ');
  // Both rehearsals now live only in the release lane, and both are required
  // by the job that reaches npm, so nothing can publish without them.
  assert.equal(
    release.jobs['accept-release'].uses,
    './.github/workflows/ultramodern-release-acceptance.yml',
  );
  assert.equal(
    release.jobs['accept-release'].with.producer_artifact_identity,
    identity,
  );
  assert.equal(
    release.jobs['accept-release'].with.required_renderer_features,
    true,
  );
  assert.equal(
    release.jobs['rehearse-tractor'].uses,
    './.github/workflows/ultramodern-tractor-downstream.yml',
  );
  assert.deepEqual(release.jobs['rehearse-tractor'].with, {
    mode: 'source',
    release_bundle_artifact: `bleedingdev-release-bundle-${identity}`,
  });
  for (const gate of ['accept-release', 'rehearse-tractor']) {
    assert.ok(
      release.jobs.publish.needs.includes(gate),
      `publish must stay blocked on ${gate}`,
    );
  }
  assert.equal(jobs['packed-erp'], undefined);
  assert.equal(jobs['packed-tractor'], undefined);
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

test('retained Tractor adoption requires an accepted live publication and exact release inputs', () => {
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
  // A green publish run proves only that npm accepted the tarballs.
  const acceptance = {
    workflow_runs: [
      {
        display_title: 'Accept published release from run 123',
        conclusion: 'success',
        head_branch: 'main-ultramodern',
        event: 'workflow_dispatch',
      },
    ],
  };
  const comparison = {
    status: 'identical',
    merge_base_commit: { sha: source },
  };
  const execute = (
    env = {},
    runOverrides = {},
    jobData = jobs,
    acceptanceData = acceptance,
    comparisonData = comparison,
  ) =>
    spawnSync(
      'bash',
      [
        '-e',
        '-c',
        `gh() { if [ "\${GH_FAIL:-0}" = 1 ]; then return 1; fi; case "$2" in *"/compare/"*) printf '%s' "$COMPARISON_DATA";; *"/jobs?"*) printf '%s' "$JOB_DATA";; *"/accept-bleedingdev-release.yml/runs?"*) printf '%s' "$ACCEPTANCE_DATA";; *) printf '%s' "$RUN_DATA";; esac; }\n${validate.run}`,
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
          ACCEPTANCE_DATA: JSON.stringify(acceptanceData),
          COMPARISON_DATA: JSON.stringify(comparisonData),
          ...env,
        },
      },
    );
  assert.equal(execute().status, 0);
  assert.equal(
    execute({}, { head_sha: 'b'.repeat(40) }, jobs, acceptance, {
      ...comparison,
      status: 'ahead',
    }).status,
    0,
    'recovery may publish the qualified source with newer descendant tooling',
  );
  for (const invalid of [
    { status: 'diverged', merge_base_commit: { sha: 'c'.repeat(40) } },
    { status: 'behind', merge_base_commit: { sha: 'b'.repeat(40) } },
    { status: 'ahead', merge_base_commit: { sha: 'c'.repeat(40) } },
    { status: 'identical' },
  ])
    assert.notEqual(
      execute({}, { head_sha: 'b'.repeat(40) }, jobs, acceptance, invalid)
        .status,
      0,
      JSON.stringify(invalid),
    );
  for (const patch of [
    { conclusion: 'failure' },
    { display_title: 'Accept published release from run 1234' },
    { head_branch: 'other' },
  ])
    assert.notEqual(
      execute({}, {}, jobs, {
        workflow_runs: [{ ...acceptance.workflow_runs[0], ...patch }],
      }).status,
      0,
      JSON.stringify(patch),
    );
  assert.notEqual(execute({}, {}, jobs, { workflow_runs: [] }).status, 0);
  // A run that accepted the cohort in-run needs no separate acceptance.
  assert.equal(
    execute(
      {},
      {},
      {
        jobs: [
          ...jobs.jobs,
          {
            name: 'Accept the exact published registry cohort',
            conclusion: 'success',
          },
        ],
      },
      { workflow_runs: [] },
    ).status,
    0,
  );
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
    { head_sha: 'not-a-commit' },
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
  // The source leg runs the feature rows in its own `renderer-features` job,
  // concurrently with the ERP acceptance; `seal` binds the two receipts.
  const source = readWorkflow('ultramodern-release-acceptance').jobs[
    'renderer-features'
  ];
  const published = readWorkflow('accept-bleedingdev-release').jobs[
    'accept-published'
  ];
  for (const job of [source, published]) {
    const step = job.steps.find(step =>
      step.name.includes('installed renderer features'),
    );
    assert(step, 'The required installed feature step must exist');
    const command = step.run;
    assert.match(command, /export OWNED_TEMP_DIR="\$feature_work"/u);
    // The source leg uses a fixed $RUNNER_TEMP/renderer-features so `seal`
    // reconstructs the identical evidence root; the published leg still
    // mktemp's one. Either way the root the proofs own is canonicalised.
    assert.match(command, /feature_work="\$\(realpath "[^"\n]+"\)"/u);
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
  assert.match(
    controls.run,
    /tests\/ultramodern-renderers\/octane-federation\/\{artifact-ownership,browser-temporary\}\.test\.mjs/u,
  );
  assert.match(
    controls.run,
    /tests\/ultramodern-renderers\/octane-federation-workers\/contract\.test\.mjs/u,
  );
  assert.match(controls.run, /trap 'rm -rf -- "\$controls_work"' EXIT/u);
});

test('feature proofs select Depot on every event, with no GitHub-hosted branch', () => {
  const source = readWorkflow('ultramodern-release-acceptance').jobs[
    'accept-release'
  ];
  const published = readWorkflow('accept-bleedingdev-release').jobs[
    'accept-published'
  ];
  // Every job of this repository runs on Depot, so no event and no repository
  // variable may resolve either leg to a GitHub-hosted label. The source leg
  // pins a literal Depot label, which no event or variable can move.
  assert.equal(source['runs-on'], 'depot-ubuntu-24.04-16');
  for (const job of [published]) {
    const expression = job['runs-on'].slice(3, -3);
    const select = (vars = {}, foreign = false, required = true) =>
      runInNewContext(expression, {
        inputs: { required_renderer_features: required },
        github: {
          event_name: 'pull_request',
          repository: 'owner/repo',
          event: {
            pull_request: {
              head: {
                repo: {
                  full_name: foreign ? 'contributor/repo' : 'owner/repo',
                },
              },
            },
          },
        },
        vars,
        fromJSON: JSON.parse,
      });
    for (const required of [false, true]) {
      for (const foreign of [false, true]) {
        assert.equal(
          select({ DEPOT_LINUX_RUNNER: 'depot-linux' }, foreign, required),
          'depot-linux',
        );
        assert.equal(
          select(
            { BLEEDINGDEV_ACCEPT_RUNNER_LABELS: '["self-hosted","linux"]' },
            foreign,
            required,
          ),
          'depot-ubuntu-24.04-8',
        );
        assert.equal(select({}, foreign, required), 'depot-ubuntu-24.04-8');
      }
    }
  }
  const acceptance = readWorkflow('ultramodern-release-acceptance').jobs;
  for (const job of [...Object.values(acceptance), published]) {
    for (const env of [job.env, ...job.steps.map(step => step.env)]) {
      assert.equal(env?.RUNNER_ENVIRONMENT, undefined);
      assert.equal(env?.GITHUB_ACTIONS, undefined);
      assert.equal(env?.RUNNER_NAME, undefined);
    }
  }
});

test('renderer evidence is required after execution, not when upstream failure skipped the feature step', () => {
  const job = readWorkflow('ultramodern-release-acceptance').jobs[
    'renderer-features'
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
