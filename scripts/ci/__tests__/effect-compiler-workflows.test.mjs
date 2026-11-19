import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
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
const cache = read('ci-cache');
const expression = value => ['$' + '{{', value, '}}'].join(' ');
const producerPath = './.github/workflows/effect-compiler-payload.yml';
const compilerSource = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../../packages/solutions/app-tools-extensions/compiler/source.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const cachePin = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
const cachedTargets = producer.jobs.build.strategy.matrix.include.map(
  entry => entry.target,
);
const step = (jobId, matcher) =>
  producer.jobs[jobId].steps.find(
    item =>
      item.id === matcher ||
      item.name === matcher ||
      (typeof item.name === 'string' && item.name.startsWith(matcher)),
  );
const stage =
  'node scripts/ultramodern-publish/stage-effect-compiler-payload.mjs stage --input .modern/effect-compiler-input --complete-manifest';

function checkCompilerVersionGuard(run, end, sourcePath) {
  const guard = run.slice(run.indexOf('const version ='), run.indexOf(end));
  const expected =
    `Version ${compilerSource.typescript.version}+effect-tsgo.${compilerSource.effect.baseVersion} ` +
    `(tsrs ${compilerSource.tsrs.version}, microsoft/TypeScript@${compilerSource.typescript.sourceCommit.slice(0, 12)})`;
  const checkVersion = stdout =>
    runInNewContext(guard, {
      assert,
      fs: {
        readFileSync(file) {
          assert.equal(file, sourcePath);
          return JSON.stringify(compilerSource);
        },
      },
      run: () => ({ status: 0, stdout, stderr: '' }),
    });
  checkVersion(`${expected}\n`);
  assert.throws(() => checkVersion('Version foreign-compiler\n'));
}

test('default-branch caches seed the two actual compiler variants before integration reuses them', () => {
  assert.equal(cache.permissions.actions, 'read');
  assert.equal(cache.jobs['effect-compiler-payload'].uses, producerPath);
  assert.equal(
    cache.jobs['effect-compiler-payload'].if,
    "github.ref == 'refs/heads/main-ultramodern' || github.event_name == 'workflow_dispatch'",
  );
  assert.equal(cache.jobs.seed.needs, undefined);
  assert.equal(cache.jobs['seed-integration'].needs, 'effect-compiler-payload');
  assert.equal(
    cache.jobs.seed.if,
    "github.ref == 'refs/heads/main-ultramodern' || github.event_name == 'workflow_dispatch'",
  );
  const entries = [
    ...cache.jobs.seed.strategy.matrix.include,
    ...cache.jobs['seed-integration'].strategy.matrix.include,
  ];
  assert.ok(
    cache.jobs.seed.strategy.matrix.include.every(
      entry => !entry.compiler_payload,
    ),
  );
  assert.ok(
    cache.jobs['seed-integration'].strategy.matrix.include.every(
      entry => entry.compiler_payload,
    ),
  );
  assert.deepEqual(cache.jobs['seed-integration'].steps, cache.jobs.seed.steps);
  assert.equal(
    entries.filter(entry => entry.compiler_payload === false).length,
    3,
  );
  assert.equal(
    entries.filter(entry => entry.compiler_payload === true).length,
    2,
  );
  assert.ok(
    entries
      .filter(entry => entry.compiler_payload)
      .every(entry => !entry.runner.includes('MACOS')),
  );
  const steps = cache.jobs.seed.steps;
  const staged = steps.findIndex(step => step.run === stage);
  const identified = steps.findIndex(step => step.id === 'build-cache-key');
  assert.ok(staged >= 0 && staged < identified);
  assert.equal(steps[staged].if, 'matrix.compiler_payload');

  const consumer = integration.jobs.integration.steps;
  const restore = consumer.findIndex(step => step.id === 'build-cache');
  const staging = consumer.findIndex(step => step.run === stage);
  const prepare = consumer.findIndex(step => step.name === 'Prepare');
  assert.ok(staging < restore && restore < prepare);
  assert.equal(
    consumer[prepare].if,
    "steps.build-cache.outputs.cache-hit != 'true'",
  );
  for (const name of [
    'Test - Framework',
    'Test - Framework workspace generator',
    'Test - Framework BFF generator',
  ])
    assert.equal(
      consumer.find(step => step.name === name).env
        .MODERN_TEST_PACKAGE_MANIFEST,
      expression('steps.build-cache.outputs.package-manifest'),
    );
});

test('ordinary cache writers are independent of compiler allocation and Windows and macOS seeds restore installed files', () => {
  const seed = cache.jobs.seed;
  assert.equal(seed.needs, undefined);
  assert.equal(cache.jobs['seed-integration'].needs, 'effect-compiler-payload');
  const steps = seed.steps;
  const restore = steps.findIndex(
    step => step.name === 'Rebuild native installed dependency links',
  );
  const install = steps.findIndex(step => step.name === 'Install Dependencies');
  assert.ok(restore >= 0 && restore < install);
  assert.equal(
    steps.find(step => step.id === 'dependencies-snapshot').if,
    "(runner.os == 'Windows' || runner.os == 'macOS')",
  );
  assert.equal(
    steps[restore].if,
    "(runner.os == 'Windows' || runner.os == 'macOS') && steps.dependencies-snapshot.outputs.cache-hit == 'true'",
  );
  assert.equal(
    steps[restore].run,
    'node scripts/ci/dependency-snapshot.mjs restore',
  );
  assert.ok(!steps.some(step => step.run?.includes('verify-transport')));
});

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

test('compiler matrix uses four Depot builds without Intel Mac or Ubuntu 22.04', () => {
  assert.deepEqual(producer.on, {
    workflow_call: null,
    push: { branches: ['main-ultramodern'] },
    workflow_dispatch: null,
  });
  assert.deepEqual(producer.jobs.build.strategy.matrix.include, [
    {
      target: 'darwin-arm64',
      rust_target: 'aarch64-apple-darwin',
      runner: expression("vars.DEPOT_MACOS_RUNNER || 'depot-macos-26'"),
    },
    {
      target: 'linux-x64',
      rust_target: 'x86_64-unknown-linux-gnu',
      runner: 'depot-ubuntu-24.04-8',
    },
    {
      target: 'linux-arm64',
      rust_target: 'aarch64-unknown-linux-gnu',
      runner: 'depot-ubuntu-24.04-arm-8',
    },
    {
      target: 'win32-x64',
      rust_target: 'x86_64-pc-windows-msvc',
      runner: expression("vars.DEPOT_WINDOWS_RUNNER || 'depot-windows-2025-8'"),
    },
  ]);
  const source = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../../packages/solutions/app-tools-extensions/compiler/source.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.deepEqual(
    producer.jobs.build.strategy.matrix.include.map(item => item.target),
    source.targets,
  );
  assert.deepEqual(source.macos, {
    architecture: 'arm64',
    minimumChip: 'M3',
  });
  assert.equal(
    producer.jobs.aggregate['runs-on'],
    expression("vars.DEPOT_LINUX_RUNNER || 'depot-ubuntu-24.04-8'"),
  );
  const steps = producer.jobs.build.steps;
  assert.equal(
    steps.find(step => step.uses?.startsWith('actions/setup-node@')).with[
      'node-version'
    ],
    '26.13.1',
  );
  assert.equal(
    producer.jobs.aggregate.steps.find(step =>
      step.uses?.startsWith('actions/setup-node@'),
    ).with['node-version'],
    '26.13.1',
  );
  const checkout = steps.find(
    step => step.with?.repository === 'Effect-TS/tsgo',
  );
  assert.equal(checkout.with.ref, '0e722d359c969bdf1b1316f08e8637022cde3cce');
  const setup = steps.find(
    step => step.uses === './.github/actions/setup-repo',
  );
  assert.equal(setup.with.component, 'tsrs');
  assert.equal(setup.with.version, '0.25.0-ts7.1.0-beta');
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
    /--version 0\.25\.0-ts7\.1\.0-beta --target "\$TARGET" --optimize none/,
  );
  const smoke = steps.find(step =>
    step.name.startsWith('Smoke the actual release'),
  );
  const constraints = steps.find(step =>
    step.name.startsWith('Test retained-checker'),
  );
  assert.ok(steps.indexOf(build) < steps.indexOf(constraints));
  assert.ok(steps.indexOf(constraints) < steps.indexOf(smoke));
  assert.match(constraints.run, /fs\.constants\.COPYFILE_EXCL/);
  assert.match(
    constraints.run,
    /cargo test --locked -p ets_typeparser --test ultramodern_base_constraint_history -- --exact base_constraint_history_matrix --nocapture/,
  );
  assert.equal(
    smoke.env.ARTIFACT_DIR,
    expression('steps.compiler.outputs.artifact_path'),
  );
  checkCompilerVersionGuard(
    smoke.run,
    'const client =',
    'harness/packages/solutions/app-tools-extensions/compiler/source.json',
  );
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
  const uploads = steps.filter(step =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  // The receipt artifact `aggregate` stages from, and the pre-receipt
  // directory the single x64 cache writer saves. Both are required: the
  // receipt is run-identity bound and must never be cached.
  assert.deepEqual(
    uploads.map(step => step.with.name),
    [
      `effect-compiler-cache-${expression('matrix.target')}-${expression('github.sha')}`,
      `effect-compiler-target-${expression('matrix.target')}-${expression('github.sha')}`,
    ],
  );
  const aggregate = producer.jobs.aggregate;
  assert.deepEqual([...aggregate.needs].sort(), ['build', 'resolve']);
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

test('macOS producer accepts M3 and newer but rejects Intel, Rosetta, M1, M2 and unknown hardware', () => {
  const guard = producer.jobs.build.steps.find(
    step => step.name === 'Verify the supported Apple Silicon runner',
  );
  assert.equal(guard.if, "runner.os == 'macOS'");
  for (const [arch, chip, succeeds] of [
    ['arm64', 'Apple M3', true],
    ['arm64', 'Apple M3 Pro', true],
    ['arm64', 'Apple M4 Max', true],
    ['arm64', 'Apple M10 Ultra', true],
    ['arm64', 'Apple M1', false],
    ['arm64', 'Apple M2 Max', false],
    ['arm64', 'Apple M30unknown', false],
    ['arm64', 'unknown', false],
    ['x86_64', 'Intel Core i7', false],
    ['x86_64', 'Apple M4', false],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -e
uname() { printf '%s\\n' "$TEST_ARCH"; }
sysctl() { printf '%s\\n' "$TEST_CHIP"; }
${guard.run}`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TEST_ARCH: arch, TEST_CHIP: chip },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status === 0, succeeds, `${arch}: ${chip}`);
  }
});

test('a verified full restore skips the build matrix and the aggregate job', () => {
  const resolve = producer.jobs.resolve;
  assert.equal(
    resolve['runs-on'],
    expression("vars.DEPOT_LINUX_RUNNER || 'depot-ubuntu-24.04-8'"),
  );
  assert.equal(resolve['timeout-minutes'], 15);
  assert.deepEqual(resolve.outputs, {
    hit: expression('steps.payload.outputs.hit'),
  });
  for (const id of ['build', 'aggregate']) {
    const needs = producer.jobs[id].needs;
    assert.ok((Array.isArray(needs) ? needs : [needs]).includes('resolve'), id);
    assert.equal(producer.jobs[id].if, "needs.resolve.outputs.hit != 'true'");
  }
  // The hit path reuses aggregate's bare checkout, Node and staging command;
  // it installs nothing and downloads no per-target artifacts.
  const aggregate = producer.jobs.aggregate.steps;
  for (const index of [0, 1])
    assert.deepEqual(resolve.steps[index], aggregate[index]);
  assert.equal(
    step('resolve', 'Validate and stage the complete compiler payload').run,
    aggregate.find(item => item.run?.includes('stage --input')).run,
  );
  assert.deepEqual(
    step('resolve', 'Upload the complete staged payload').with,
    aggregate.find(item => item.uses?.startsWith('actions/upload-artifact@'))
      .with,
  );
  assert.ok(
    !resolve.steps.some(item =>
      /pnpm install|npm ci|download-artifact/.test(
        `${item.run ?? ''}${item.uses ?? ''}`,
      ),
    ),
  );
  for (const name of [
    'Smoke the cached Linux release binary',
    'Produce the target inventory and same-run receipt',
    'Validate and stage the complete compiler payload',
    'Upload the complete staged payload',
    "Report the cached payload as this run's payload",
  ])
    assert.equal(
      step('resolve', name).if,
      "steps.identity.outputs.usable == 'true'",
      name,
    );
  assert.equal(
    step('resolve', 'payload').run,
    'echo "hit=true" >> "$GITHUB_OUTPUT"',
  );
  // The Linux smoke keeps running on the hit path, and it runs on the staged
  // payload rather than the restored directory: the cached bytes now reach
  // this job through artifact transport, which strips the executable mode,
  // and the stager is the only thing allowed to repair it. Smoking after
  // staging therefore executes exactly the bytes consumers receive.
  const resolveSteps = producer.jobs.resolve.steps;
  const smoke = step('resolve', 'Smoke the cached Linux release binary');
  assert.equal(
    smoke.env.ARTIFACT_DIR,
    'packages/solutions/app-tools-extensions/compiler/payload/linux-x64',
  );
  assert.ok(
    resolveSteps.indexOf(
      resolveSteps.find(item => item.run?.includes('stage --input')),
    ) < resolveSteps.indexOf(smoke),
    'the smoke must run after the stager repaired the executable mode',
  );
  checkCompilerVersionGuard(
    smoke.run,
    'const root = fs.mkdtempSync',
    'packages/solutions/app-tools-extensions/compiler/source.json',
  );
  assert.match(smoke.run, /lib\.d\.ts/);
});

// Measured in run 43889178478: Depot serves the Actions cache from its own
// backend and that backend does not span CPU architectures. The x64 `resolve`
// job restored linux-x64 and win32-x64 and reported "Cache not found" for
// darwin-arm64 and linux-arm64, whose entries the build matrix had just
// written from arm64 machines under byte-identical keys. One writer per
// architecture therefore cannot be read by one reader, and because a partial
// restore rebuilds every target it wasted the whole lever. Every entry is
// written by `aggregate`, on the one architecture `resolve` reads from.
test('one x64 job writes every cache entry, and the build matrix writes none', () => {
  const saves = producer.jobs.aggregate.steps.filter(item =>
    item.uses?.startsWith('actions/cache/save@'),
  );
  assert.equal(saves.length, 4);
  assert.equal(
    producer.jobs.aggregate['runs-on'],
    producer.jobs.resolve['runs-on'],
    'the cache writer must run on the architecture the reader reads from',
  );
  for (const item of producer.jobs.build.steps)
    assert.ok(
      !/^actions\/cache/.test(item.uses ?? ''),
      `${item.name} writes the cache from a per-target runner; arm64 entries written there are invisible to the x64 reader`,
    );
});

test('the cache key carries every pinned identity, the epoch and the runner label', () => {
  const targets = producer.jobs.build.strategy.matrix.include;
  assert.equal(targets.length, 4);
  for (const entry of targets) {
    const save = producer.jobs.aggregate.steps.find(
      item => item.with?.path === `.effect-compiler-cache/${entry.target}`,
    );
    assert.ok(save?.uses?.startsWith('actions/cache/save@'), entry.target);
    // Durable-ref events only. A pull_request or merge_group ref is discarded
    // after the run, so an entry written there is unreadable dead quota - the
    // parking ci-cache.yml's header records. Asserting the condition rather
    // than a branch name is what keeps both of those events excluded.
    assert.equal(
      save.if,
      "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
    );
    assert.equal(save.with.enableCrossOsArchive, true);
    assert.ok(
      save.with.key.startsWith(
        `effect-compiler-payload-v2-${expression('steps.cache-key.outputs.epoch')}-${entry.target}-${entry.runner}-`,
      ),
      entry.target,
    );
    for (const file of [
      'packages/solutions/app-tools-extensions/compiler/source.json',
      'packages/solutions/app-tools-extensions/compiler/constraint.patch',
      '.github/workflows/effect-compiler-payload.yml',
    ])
      assert.ok(
        save.with.key.includes(expression(`hashFiles('${file}')`)),
        `${entry.target}: ${file}`,
      );
    // .github/actions/setup-repo resolves inside the Effect-TS/tsgo checkout
    // and does not exist in this repository, so it adds nothing to a digest.
    assert.ok(!save.with.key.includes('setup-repo'));
    // The one failure mode of a split writer and reader is a key that differs
    // by a character, which is a permanent silent miss rather than an error.
    const restore = step('resolve', `cache-${entry.target}`);
    assert.equal(restore.with.path, save.with.path);
    assert.equal(restore.with.enableCrossOsArchive, true);
    assert.equal(restore.with['restore-keys'], undefined);
    assert.equal(restore.with.key, save.with.key, entry.target);
  }
  for (const item of [
    ...producer.jobs.resolve.steps,
    ...producer.jobs.build.steps,
    ...producer.jobs.aggregate.steps,
  ])
    if (/^actions\/cache/.test(item.uses ?? ''))
      assert.equal(item.uses.split('@')[1].split(' ')[0], cachePin);
});

test('the cache epoch is one committed integer that only a human bumps', () => {
  const content = fs.readFileSync(
    new URL('../../../.github/effect-compiler-cache-epoch', import.meta.url),
    'utf8',
  );
  const values = content
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'));
  assert.deepEqual(values.length, 1);
  assert.match(values[0], /^\d+$/);
  assert.match(content, /[Bb]ump/);
  assert.match(content, /runner image/);
  // Both jobs check out the repository root, so neither needs the harness/
  // prefix the build matrix used while it still wrote its own entries.
  for (const [jobId, file] of [
    ['resolve', '.github/effect-compiler-cache-epoch'],
    ['aggregate', '.github/effect-compiler-cache-epoch'],
  ]) {
    const key = step(jobId, 'cache-key');
    assert.equal(key.env.EPOCH_FILE, file);
    assert.ok(key.run.includes('*[!0-9]*)'));
    assert.ok(key.run.includes('echo "epoch=$epoch" >> "$GITHUB_OUTPUT"'));
  }
});

test('a partial restore or a foreign identity rebuilds instead of staging', () => {
  assert.deepEqual(cachedTargets, compilerSource.targets);
  const identity = step('resolve', 'identity');
  assert.equal(identity.if, undefined);
  assert.deepEqual(
    identity.env.RESTORED.trim()
      .split('\n')
      .map(line => line.trim()),
    cachedTargets.map(
      target =>
        `${target} ${expression(`steps.cache-${target}.outputs.cache-hit`)}`,
    ),
  );
  assert.match(identity.run, /verify-identity/);
  assert.match(identity.run, /usable=false/);
  assert.ok(identity.run.includes('echo "usable=$usable" >> "$GITHUB_OUTPUT"'));
  assert.deepEqual(
    step('resolve', 'Produce the target inventory').env.TARGETS.split(' '),
    cachedTargets,
  );
});

test('only bytes the stager accepted in the same run are cached, and never the receipt', () => {
  const steps = producer.jobs.build.steps;
  const at = matcher => steps.indexOf(step('build', matcher));
  const notices = at('Include source licenses');
  const copy = at('Copy the verified target directory');
  const receipt = at('Produce the target');
  const handoff = at('Upload the verified target directory for the cache');
  const upload = at('Upload the complete target directory and receipt');
  assert.ok(
    notices < copy && copy < receipt && receipt < handoff && handoff < upload,
  );
  // What the cache writer receives is the pre-receipt directory. The receipt
  // is run-identity bound, so caching it would let a later run present a
  // foreign run's receipt as its own; it travels in the other artifact and
  // every consuming run produces its own.
  assert.equal(
    steps[handoff].with.path,
    `.effect-compiler-cache/${expression('matrix.target')}`,
  );
  assert.equal(steps[handoff].if, undefined);
  assert.ok(!steps[handoff].with.path.includes('.modern'));
  assert.equal(steps[copy].if, undefined);
  assert.match(steps[copy].run, /write-identity/);
  assert.match(steps[copy].run, /MB/);
  assert.match(steps[copy].run, /\.effect-compiler-cache/);
  assert.ok(!steps[copy].run.includes('.modern/effect-compiler-target'));

  // And nothing is written until the stager accepted the complete payload in
  // the writer's own run, so a run that cannot produce a valid inventory for
  // all four targets seeds nothing.
  const writer = producer.jobs.aggregate.steps;
  const stage = writer.findIndex(item => item.run?.includes('stage --input'));
  const saves = writer
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.uses?.startsWith('actions/cache/save@'));
  assert.equal(saves.length, 4);
  for (const { index } of saves) assert.ok(stage < index);
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
  for (const [id, build] of [
    ['qualify-source-compute', 'Qualify release source'],
    ['prepare-release', 'Build Packages'],
  ]) {
    assert.ok(
      [publish.jobs[id].needs].flat().includes('effect-compiler-payload'),
      id,
    );
    assertHandoff(publish.jobs[id], build, true);
  }
});

// The payload starts beside publish-security and authorizes nothing; every
// release job that builds from it still waits for the validated dispatch.
const publishPayloadNeeds = Object.freeze({
  'select-integration-evidence': [
    'publish-security',
    'effect-compiler-payload',
  ],
  integration: [
    'publish-security',
    'effect-compiler-payload',
    'select-integration-evidence',
  ],
  'qualify-source-compute': ['publish-security', 'effect-compiler-payload'],
  'prepare-release': ['publish-security', 'effect-compiler-payload'],
});
const assertPublishPayloadNeeds = () => {
  assert.equal(publish.jobs['effect-compiler-payload'].needs, undefined);
  for (const [id, needs] of Object.entries(publishPayloadNeeds))
    assert.deepEqual([publish.jobs[id].needs].flat(), needs, id);
};

test('publish invokes one producer; nested integration reuses it rather than colliding', () => {
  assert.equal(
    Object.values(publish.jobs).filter(job => job.uses === producerPath).length,
    1,
  );
  assertPublishPayloadNeeds();
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

// A recovery dispatch qualifies HEAD's publication tooling like any cohort:
// it runs integration on HEAD, or reuses a pull request run that
// select-integration-evidence proved on HEAD's identical tree.
test('recovery retains current-source integration evidence and compiler qualification; sidecars do not build a compiler', () => {
  assertPublishPayloadNeeds();
  assert.match(
    publish.jobs['effect-compiler-payload'].if,
    /inputs\.mode == 'cohort'/,
  );
  assert.doesNotMatch(
    publish.jobs['effect-compiler-payload'].if,
    /recovery_run_id/,
  );
  assert.doesNotMatch(publish.jobs.integration.if, /recovery_run_id/);
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
  const results = {
    ...Object.fromEntries(Object.keys(publish.jobs).map(id => [id, 'success'])),
    'select-integration-evidence': {
      result: 'success',
      outputs: { decision: 'run' },
    },
    'reconcile-sidecars': {
      result: 'success',
      outputs: { decision: 'publish' },
    },
  };
  assert.doesNotMatch(
    publish.jobs['select-integration-evidence'].if,
    /recovery_run_id/,
  );
  for (const jobId of [
    'select-integration-evidence',
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
  for (const jobId of [
    'select-integration-evidence',
    'integration',
    'qualify-source-compute',
    'prepare-release',
  ])
    for (const result of ['failure', 'cancelled', 'skipped'])
      assert.equal(
        evaluateJobSchedule({
          workflow: publish,
          jobId,
          results: { ...results, 'publish-security': result },
          context,
        }),
        false,
        `${jobId} rejects publish-security ${result}`,
      );
  const reused = {
    ...results,
    'select-integration-evidence': {
      result: 'success',
      outputs: { decision: 'reuse' },
    },
    integration: 'skipped',
  };
  for (const jobId of ['qualify-source', 'publish', 'publish-sidecars']) {
    assert.equal(
      evaluateJobSchedule({ workflow: publish, jobId, results, context }),
      true,
      `${jobId} accepts recovery integration run on HEAD`,
    );
    assert.equal(
      evaluateJobSchedule({
        workflow: publish,
        jobId,
        results: reused,
        context,
      }),
      true,
      `${jobId} accepts a reused run proved on HEAD's tree`,
    );
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
  }
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

test('only a direct PR native qualification cancels its superseded head', () => {
  const workflow = {
    jobs: { cancel: { if: native.concurrency['cancel-in-progress'] } },
  };
  const github = {
    repository: 'ultramodernjs/ultramodern.js',
    ref: 'refs/pull/312/merge',
    event_name: 'pull_request',
    workflow_ref:
      'ultramodernjs/ultramodern.js/.github/workflows/native-compatibility.yml@refs/pull/312/merge',
  };
  const evaluates = values =>
    evaluateJobSchedule({
      workflow,
      jobId: 'cancel',
      context: { github: { ...github, ...values } },
    });
  assert.equal(evaluates({}), true);
  for (const event_name of [
    'merge_group',
    'workflow_dispatch',
    'workflow_call',
  ])
    assert.equal(evaluates({ event_name }), false, event_name);
  assert.equal(
    evaluates({
      workflow_ref:
        'ultramodernjs/ultramodern.js/.github/workflows/publish-bleedingdev.yml@refs/pull/312/merge',
    }),
    false,
  );
});
