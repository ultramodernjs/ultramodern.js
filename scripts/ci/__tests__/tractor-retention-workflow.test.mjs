import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';

const repository = 'ultramodernjs/ultramodern.js';
const source = 'a'.repeat(40);
const workflow = yaml.load(
  fs.readFileSync(
    new URL(
      '../../../.github/workflows/ultramodern-tractor-downstream.yml',
      import.meta.url,
    ),
    'utf8',
  ),
);
const script = workflow.jobs['tractor-downstream'].steps.find(
  step => step.name === 'Validate retained adoption inputs and publication run',
).run;

function runPreflight(
  t,
  { head = source, comparison, mutate = () => {} } = {},
) {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'tractor-retention-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = {
    conclusion: 'success',
    run_attempt: 1,
    head_sha: head,
    head_branch: 'main-ultramodern',
    event: 'workflow_dispatch',
    path: '.github/workflows/publish-bleedingdev.yml',
  };
  mutate(run);
  const base = `repos/${repository}`;
  const responses = {
    [`${base}/actions/runs/42`]: run,
    [`${base}/compare/${source}...${head}`]: comparison ?? {
      status: head === source ? 'identical' : 'ahead',
      merge_base_commit: { sha: source },
    },
    [`${base}/actions/runs/42/jobs?filter=latest&per_page=100`]: {
      jobs: [
        'Publish accepted @bleedingdev tarballs',
        'Accept the exact published registry cohort',
      ].map(name => ({ name, conclusion: 'success' })),
    },
  };
  const gh = path.join(root, 'gh');
  fs.writeFileSync(
    gh,
    `#!${process.execPath}
const responses = JSON.parse(process.env.GH_RESPONSES);
const route = process.argv[3];
if (process.argv[2] !== 'api' || !Object.hasOwn(responses, route)) process.exit(2);
console.log(JSON.stringify(responses[route]));
`,
    { mode: 0o755 },
  );
  return spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: `${root}${path.delimiter}${process.env.PATH}`,
        GH_RESPONSES: JSON.stringify(responses),
        GITHUB_REPOSITORY: repository,
        PRODUCER_RUN_ID: '42',
        PRODUCER_RUN_ATTEMPT: '1',
        EXPECTED_SOURCE: source,
        EXPECTED_VERSION: '3.11.3-ultramodern.8',
      },
    },
  );
}

for (const head of [source, 'b'.repeat(40)])
  test(`retention accepts qualified source with publication head ${head}`, t => {
    const result = runPreflight(t, { head });
    assert.equal(result.status, 0, result.stderr);
  });

for (const comparison of [
  { status: 'diverged', merge_base_commit: { sha: 'c'.repeat(40) } },
  { status: 'behind', merge_base_commit: { sha: 'b'.repeat(40) } },
  { status: 'ahead', merge_base_commit: { sha: 'c'.repeat(40) } },
])
  test(`retention rejects publication ancestry ${JSON.stringify(comparison)}`, t => {
    assert.notEqual(
      runPreflight(t, { head: 'b'.repeat(40), comparison }).status,
      0,
    );
  });

for (const change of [
  { conclusion: 'failure' },
  { run_attempt: 0 },
  { head_branch: 'untrusted' },
  { event: 'pull_request' },
  { path: '.github/workflows/other.yml' },
])
  test(`retention rejects untrusted publication ${JSON.stringify(change)}`, t => {
    assert.notEqual(
      runPreflight(t, { mutate: run => Object.assign(run, change) }).status,
      0,
    );
  });

for (const [commit, version, accepted] of [
  [source, '3.11.3-ultramodern.8', true],
  ['b'.repeat(40), '3.11.3-ultramodern.8', false],
  [source, '3.11.3-ultramodern.7', false],
])
  test(`downloaded manifest remains bound to exact requested source and version: ${commit}/${version}`, t => {
    const root = fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'tractor-manifest-'),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const out = path.join(root, '.modern/bleedingdev-publish');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'manifest.json'),
      JSON.stringify({ source: { commit }, release: { version } }),
    );
    const verify = workflow.jobs['tractor-downstream'].steps.find(
      step => step.name === 'Verify retained adoption release identity',
    ).run;
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', verify], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        EXPECTED_SOURCE: source,
        EXPECTED_VERSION: '3.11.3-ultramodern.8',
      },
    });
    assert.equal(result.status === 0, accepted, result.stderr);
  });
