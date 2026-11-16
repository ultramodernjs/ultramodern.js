import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import yaml from '../../packages/toolkit/utils/compiled/js-yaml/index.js';
import {
  upstreamCommit,
  upstreamDependencies,
} from '../native-compatibility/consumer.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const tempRoot = process.env.OWNED_TEMP_DIR ?? os.tmpdir();
const workflow = yaml.load(
  readFileSync(
    path.join(repoRoot, '.github/workflows/integration-test.yml'),
    'utf8',
  ),
);
const integration = workflow.jobs.integration;
const matrix = integration.strategy.matrix;

// Apply GitHub's include semantics to the original Cartesian combinations.
function scheduledJobs() {
  const axes = Object.entries(matrix).filter(
    ([key]) => key !== 'include' && key !== 'exclude',
  );
  const original =
    axes.length === 0
      ? []
      : axes.reduce(
          (jobs, [key, values]) =>
            jobs.flatMap(job =>
              values.map(value => ({ ...job, [key]: value })),
            ),
          [{}],
        );
  const jobs = original.map(job => ({ ...job }));
  for (const entry of matrix.include ?? []) {
    let matched = false;
    for (let index = 0; index < original.length; index += 1) {
      if (
        Object.entries(entry).every(
          ([key, value]) =>
            !(key in original[index]) || original[index][key] === value,
        )
      ) {
        Object.assign(jobs[index], entry);
        matched = true;
      }
    }
    if (!matched) jobs.push({ ...entry });
  }
  return jobs.filter(
    job =>
      !(matrix.exclude ?? []).some(entry =>
        Object.entries(entry).every(([key, value]) => job[key] === value),
      ),
  );
}

test('integration schedules six core shards and isolated generators on both platforms', () => {
  const jobs = scheduledJobs();
  for (const platform of ['Linux', 'Windows']) {
    const framework = jobs.filter(
      job => job.platform === platform && job.suite === 'framework',
    );
    assert.deepEqual(framework.map(job => job.shard).sort(), [
      '1/6',
      '2/6',
      '3/6',
      '4/6',
      '5/6',
      '6/6',
    ]);
    assert.ok(framework.every(job => job.runner));
    assert.ok(framework.every(job => job.framework_suite === 'core'));
    const generators = jobs.filter(
      job =>
        job.platform === platform &&
        job.suite.startsWith('framework-generator-'),
    );
    assert.deepEqual(
      generators.map(job => `${job.suite}:${job.framework_suite}`).sort(),
      [
        'framework-generator-bff:generator-bff',
        'framework-generator-workspace:generator-workspace',
      ],
    );
    assert.ok(generators.every(job => job.runner && job.shard === undefined));
  }
  assert.equal(jobs.length, 19);
  assert.equal(integration.strategy['fail-fast'], false);
  assert.equal(integration.strategy['max-parallel'], undefined);
});

test('adapter and package utility coverage still runs once per supported platform', () => {
  assert.deepEqual(
    scheduledJobs()
      .filter(job => !job.suite.startsWith('framework'))
      .map(job => `${job.platform}:${job.suite}`)
      .sort(),
    ['Linux:rstest-adapter', 'Linux:utils', 'Windows:rstest-adapter'],
  );
});

const run = promisify(execFile);

// Generator suites run every `*.test.ts` in their fixture directory. Windows
// excludes runtime fixtures in tests/rstest.config.mts, so mirror that rule.
function generatorTestFiles(generator) {
  const excludedOnWindows =
    process.platform === 'win32' ? ['runtime.test.ts'] : [];
  return readdirSync(
    path.join(repoRoot, 'tests/integration', generator, 'tests'),
  )
    .filter(
      name => name.endsWith('.test.ts') && !excludedOnWindows.includes(name),
    )
    .map(name => `${generator}/tests/${name}`)
    .sort();
}

test('core integration jobs fetch the immutable native baseline before running tests', () => {
  const checkoutIndex = integration.steps.findIndex(
    step => step.name === 'Checkout',
  );
  const baselineIndex = integration.steps.findIndex(
    step => step.name === 'Fetch native compatibility baseline',
  );
  assert.ok(checkoutIndex >= 0);
  assert.equal(integration.steps[checkoutIndex].with['fetch-depth'], 1);
  assert.ok(baselineIndex > checkoutIndex);
  const baseline = integration.steps[baselineIndex];
  assert.equal(
    baseline.if,
    "matrix.suite == 'framework' && matrix.framework_suite == 'core'",
  );
  assert.equal(baseline.shell, 'bash');
  assert.equal(baseline['continue-on-error'], undefined);
  assert.equal(
    baseline.run.trim(),
    `git fetch --no-tags --depth=1 origin ${upstreamCommit}\ngit cat-file -e '${upstreamCommit}^{commit}'`,
  );
  for (const [index, step] of integration.steps.entries()) {
    if (step.run?.includes('test:framework:prepared')) {
      assert.ok(
        index > baselineIndex,
        'Baseline must precede framework tests.',
      );
    }
  }
});

test('an isolated shallow checkout can read every native baseline manifest after an exact depth-one fetch', async () => {
  const directory = mkdtempSync(
    path.join(tempRoot, 'modernjs-native-history-'),
  );
  const source = path.join(directory, 'source.git');
  const checkout = path.join(directory, 'checkout');
  const gitOptions = { encoding: 'utf8', timeout: 60_000 };
  try {
    await run('git', ['init', '--bare', source], gitOptions);
    const writeGit = (args, input) =>
      execFileSync('git', args, { ...gitOptions, cwd: source, input }).trim();
    const emptyTree = writeGit(['mktree'], '');
    const identity = [
      '-c',
      'user.name=CI history regression',
      '-c',
      'user.email=ci@example.invalid',
    ];
    const parent = writeGit(
      [...identity, 'commit-tree', emptyTree],
      'parent\n',
    );
    const head = writeGit(
      [...identity, 'commit-tree', emptyTree, '-p', parent],
      'checkout\n',
    );
    writeGit(['update-ref', 'refs/heads/main', head]);
    await run(
      'git',
      [
        'clone',
        '--depth=1',
        '--no-checkout',
        '--branch',
        'main',
        pathToFileURL(source).href,
        checkout,
      ],
      gitOptions,
    );
    const readGit = args =>
      execFileSync('git', args, {
        ...gitOptions,
        cwd: checkout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    assert.equal(
      readGit(['rev-parse', '--is-shallow-repository']).trim(),
      'true',
    );
    assert.throws(() => upstreamDependencies(readGit));
    await run(
      'git',
      ['remote', 'set-url', 'origin', pathToFileURL(repoRoot).href],
      {
        ...gitOptions,
        cwd: checkout,
      },
    );
    await run(
      'git',
      ['fetch', '--no-tags', '--depth=1', 'origin', upstreamCommit],
      {
        ...gitOptions,
        cwd: checkout,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.deepEqual(upstreamDependencies(readGit), upstreamDependencies());
    const manifests = readGit([
      'ls-tree',
      '-r',
      '--name-only',
      upstreamCommit,
      '--',
      'packages',
    ])
      .trim()
      .split('\n')
      .filter(file => file.endsWith('/package.json'));
    assert.ok(manifests.length > 0);
    for (const manifest of manifests) {
      assert.equal(
        typeof JSON.parse(readGit(['show', `${upstreamCommit}:${manifest}`])),
        'object',
      );
    }
    assert.equal(readGit(['rev-parse', 'HEAD']).trim(), head);
    assert.equal(
      readGit(['rev-parse', '--is-shallow-repository']).trim(),
      'true',
    );
    assert.equal(readGit(['rev-list', '--count', upstreamCommit]).trim(), '1');
    assert.throws(
      () => readGit(['rev-parse', '--verify', `${upstreamCommit}^`]),
      'No baseline ancestry was fetched.',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const rstestPackage = createRequire(import.meta.url).resolve(
  '@rstest/core/package.json',
);
const rstestBin = path.join(
  path.dirname(rstestPackage),
  JSON.parse(readFileSync(rstestPackage, 'utf8')).bin.rstest,
);

async function listFiles(shard, suite) {
  const directory = mkdtempSync(path.join(tempRoot, 'modernjs-shard-list-'));
  const output = path.join(directory, 'files.json');
  const args = [rstestBin, 'list', '--filesOnly', '--json', output];
  if (shard) args.push('--shard', shard);
  const env = { ...process.env };
  // Default discovery must remain the complete suite even if this regression
  // runs inside a matrix job that selected a framework subset.
  delete env.MODERN_TEST_FRAMEWORK_SUITE;
  if (suite !== undefined) env.MODERN_TEST_FRAMEWORK_SUITE = suite;
  try {
    await run(process.execPath, args, {
      cwd: path.join(repoRoot, 'tests'),
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    // Sharding prints a banner even in JSON mode. The file contains only JSON.
    return JSON.parse(readFileSync(output, 'utf8'))
      .map(entry => entry.file)
      .sort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('native core shards and generator runners run every discovered file exactly once', async () => {
  const coreShards = [
    ...new Set(
      scheduledJobs()
        .filter(job => job.suite === 'framework')
        .map(job => job.shard),
    ),
  ];
  const [all, core, workspace, bff, ...shards] = await Promise.all([
    listFiles(),
    listFiles(undefined, 'core'),
    listFiles(undefined, 'generator-workspace'),
    listFiles(undefined, 'generator-bff'),
    ...coreShards.map(shard => listFiles(shard, 'core')),
  ]);
  assert.ok(all.length >= coreShards.length, 'Every CI shard must have tests.');
  assert.ok(shards.every(files => files.length > 0));
  assert.deepEqual(
    workspace
      .map(file => file.replaceAll('\\', '/').split('/integration/')[1])
      .sort(),
    generatorTestFiles('create-ultramodern-workspace'),
  );
  assert.deepEqual(
    bff
      .map(file => file.replaceAll('\\', '/').split('/integration/')[1])
      .sort(),
    generatorTestFiles('create-bff-runtime'),
  );
  assert.equal(core.length, all.length - workspace.length - bff.length);
  assert.deepEqual(
    core
      .map(file => file.replaceAll('\\', '/').split('/integration/')[1])
      .filter(file => file?.startsWith('native-compatibility/')),
    [
      'native-compatibility/fork.test.ts',
      'native-compatibility/upstream.test.ts',
    ],
    'Both native compatibility targets must run inside the core shards.',
  );
  assert.deepEqual(shards.flat().sort(), core, 'Core shards must cover core.');
  const combined = [...shards.flat(), ...workspace, ...bff];
  assert.equal(new Set(combined).size, combined.length, 'Shards overlap.');
  assert.deepEqual(
    combined.sort(),
    all,
    'The shard union must equal live discovery.',
  );
  // Discovery comes from Rstest, so new matching files enter the union without
  // updating a checked-in test manifest.
});

test('native shard discovery is deterministic and rejects invalid shard inputs', async () => {
  assert.deepEqual(
    await listFiles('1/6', 'core'),
    await listFiles('1/6', 'core'),
  );
  for (const shard of ['0/6', '7/6', '1/0', 'invalid']) {
    await assert.rejects(listFiles(shard, 'core'), undefined, shard);
  }
});

test('framework suite defaults to full and rejects unknown selectors', async () => {
  assert.deepEqual(await listFiles(), await listFiles(undefined, 'full'));
  for (const suite of ['', 'unknown', 'generator', 'Core']) {
    await assert.rejects(listFiles(undefined, suite), undefined, suite);
  }
});

test('all framework matrix jobs keep prepared commands, browsers, and timing reports', () => {
  const browserIndex = integration.steps.findIndex(
    step => step.name === 'Install Playwright browsers',
  );
  assert.ok(browserIndex >= 0);
  for (const suite of [
    'framework',
    'framework-generator-workspace',
    'framework-generator-bff',
  ]) {
    const stepIndex = integration.steps.findIndex(
      step => step.if === `matrix.suite == '${suite}'`,
    );
    assert.ok(stepIndex > browserIndex, `${suite} needs browser provisioning`);
    const step = integration.steps[stepIndex];
    assert.match(step.run, /test:framework:prepared/u);
    assert.match(step.run, /--reporters default --reporters blob/u);
    if (suite === 'framework') assert.match(step.run, /--shard/u);
    else assert.doesNotMatch(step.run, /--shard/u);
  }
  const timing = integration.steps.find(
    step => step.name === 'Upload framework test timings',
  );
  assert.match(timing.if, /always\(\)/u);
  assert.match(timing.if, /matrix\.suite == 'framework'/u);
  assert.match(timing.if, /matrix\.suite == 'framework-generator-workspace'/u);
  assert.match(timing.if, /matrix\.suite == 'framework-generator-bff'/u);
  assert.equal(timing.with.path, 'tests/.rstest-reports/');
});
