import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';

const root = new URL('../../../', import.meta.url);
const expression = value => ['$' + '{{', value, '}}'].join(' ');
const workflow = yaml.load(
  fs.readFileSync(
    new URL('.github/workflows/native-compatibility.yml', root),
    'utf8',
  ),
);
const job = workflow.jobs['native-framework-contracts'];
const stepNames = job.steps.map(step => step.name);
const names = {
  qualify: 'Qualify runtime source and write canonical patches',
  receipt: 'Stage runtime patch handoff receipt',
  upload: 'Upload runtime patch handoff',
};
const newSteps = Object.values(names).map(name => stepNamed(name));
const correctionDirectory = 'scripts/ultramodern-renderers/octane-corrections';
const sourcePatch = `${correctionDirectory}/runtime-source.patch`;
const testsPatch = `${correctionDirectory}/runtime-tests.patch`;
const generatedPatches = [
  'patches/octane@0.18.0.patch',
  'patches/@octanejs__rspack-plugin@0.2.10.patch',
];
const uploadPin =
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const manualCondition =
  "github.event_name == 'workflow_dispatch' && inputs.runtime_patch_handoff == true && github.workflow_ref == format('{0}/.github/workflows/native-compatibility.yml@{1}', github.repository, github.ref)";

function stepNamed(name) {
  const matches = job.steps.filter(step => step.name === name);
  assert.equal(matches.length, 1, name);
  return matches[0];
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** Run a workflow `run:` block the way GitHub runs bash steps. */
function runBash(script, { cwd, env }) {
  return spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
    { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' },
  );
}

test('new handoff steps append after every existing native framework check', () => {
  const start = stepNames.indexOf('Test native compatibility');
  assert.ok(start >= 0);
  assert.deepEqual(stepNames.slice(start), [
    'Test native compatibility',
    names.qualify,
    names.receipt,
    names.upload,
  ]);
});

test('runtime patch generation is an explicit manual opt-in, never a change-gated check', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.runtime_patch_handoff, {
    description:
      'Generate qualified runtime correction patches for review, without publishing',
    required: false,
    type: 'boolean',
    default: false,
  });
  assert.doesNotMatch(
    JSON.stringify(newSteps),
    /git diff|steps\.[\w-]+\.outputs\.changed|skipCI/u,
  );
});

test('manual qualifier writes canonical patches from the reviewed pnpm', () => {
  const qualify = stepNamed(names.qualify);
  assert.equal(qualify.if, manualCondition);
  assert.equal(qualify['continue-on-error'], undefined);
  assert.match(
    qualify.run,
    /pnpm_binary="\$\(mise which pnpm --tool pnpm@12\.21\.0\)"/u,
  );
  assert.match(qualify.run, /\/\*\)/u);
  assert.match(
    qualify.run,
    /if \[ "\$\("\$pnpm_binary" --version\)" != 12\.21\.0 \]/u,
  );
  assert.match(
    qualify.run,
    /owned="\$\(mktemp -d "\$RUNNER_TEMP\/runtime-qualify-XXXXXX"\)"/u,
  );
  assert.match(
    qualify.run,
    /OWNED_TEMP_DIR="\$owned" PNPM_BINARY="\$pnpm_binary"/u,
  );
  assert.match(
    qualify.run,
    /node scripts\/ultramodern-renderers\/octane-corrections\/qualify-runtime\.mjs --write-patch/u,
  );
  assert.doesNotMatch(qualify.run, /pnpm\s+(install|run|build|test)\b/u);
  assert.equal(
    stepNames.indexOf(names.qualify),
    stepNames.indexOf('Test native compatibility') + 1,
  );
  const pinned = /^pnpm\s*=\s*"([^"]+)"/mu;
  const mise = fs.readFileSync(new URL('.mise.toml', root), 'utf8');
  assert.equal(pinned.exec(mise)?.[1], '12.21.0');
});

test('receipt and upload run only after a successful opted-in manual qualifier', () => {
  for (const name of [names.receipt, names.upload]) {
    const step = stepNamed(name);
    assert.equal(step.if, `success() && ${manualCondition}`, name);
    assert.equal(step['continue-on-error'], undefined, name);
  }
});

test('upload is immutable, pinned, bound to the run and checkout SHA, and publishes nothing', () => {
  const upload = stepNamed(names.upload);
  assert.equal(upload.uses, uploadPin);
  assert.equal(
    upload.with.name,
    [
      'runtime-patch-handoff',
      expression('github.run_id'),
      expression('github.run_attempt'),
      expression('github.sha'),
    ].join('-'),
  );
  assert.equal(
    upload.with.path,
    `${expression('runner.temp')}/runtime-handoff`,
  );
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.doesNotMatch(
    JSON.stringify(newSteps),
    /npm publish|pnpm publish|secrets\.|id-token|actions\/cache\/save|contents: write|gh release/u,
  );
});

test('receipt binds the checkout SHA, run identity, toolchain and every patch digest', t => {
  const receipt = stepNamed(names.receipt);
  assert.equal(receipt.env.SOURCE_SHA, expression('github.sha'));
  assert.equal(receipt.env.RUN_ID, expression('github.run_id'));
  assert.equal(receipt.env.RUN_ATTEMPT, expression('github.run_attempt'));
  assert.equal(receipt.env.PNPM_VERSION, '12.21.0');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-receipt-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const files = {
    [generatedPatches[0]]: 'octane patch\n',
    [generatedPatches[1]]: 'rspack patch\n',
    [sourcePatch]: 'source correction\n',
    [testsPatch]: 'test correction\n',
  };
  for (const [file, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), bytes);
  }
  const handoff = path.join(cwd, 'handoff');
  const result = runBash(receipt.run, {
    cwd,
    env: {
      HANDOFF_DIR: handoff,
      SOURCE_SHA: 'a'.repeat(40),
      RUN_ID: '42',
      RUN_ATTEMPT: '3',
      PNPM_VERSION: '12.21.0',
      MISE_VERSION: '2026.11.8',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const digest = file => sha256(Buffer.from(files[file]));
  for (const file of generatedPatches)
    assert.equal(
      fs.readFileSync(path.join(handoff, file), 'utf8'),
      files[file],
    );
  const body = JSON.parse(
    fs.readFileSync(path.join(handoff, 'receipt.json'), 'utf8'),
  );
  assert.equal(body.schema, 'runtime-patch-handoff/v1');
  assert.equal(body.sourceSha, 'a'.repeat(40));
  assert.deepEqual(body.run, { id: '42', attempt: '3' });
  assert.equal(body.toolchain.pnpm, '12.21.0');
  assert.equal(body.toolchain.mise, '2026.11.8');
  assert.equal(body.toolchain.node, process.versions.node);
  assert.deepEqual(
    body.patches.map(({ path: file, sha256: hash }) => [file, hash]),
    generatedPatches.map(file => [file, digest(file)]),
  );
  assert.deepEqual(
    body.inputs.map(({ path: file, sha256: hash }) => [file, hash]),
    [sourcePatch, testsPatch].map(file => [file, digest(file)]),
  );
});

test('the native compatibility workflow keeps read-only permissions and the strict aggregate', () => {
  assert.deepEqual(workflow.permissions, {
    actions: 'read',
    contents: 'read',
  });
  assert.equal(job.permissions, undefined);
  assert.equal(job['timeout-minutes'], 90);
  assert.deepEqual(workflow.jobs['native-compatibility'].needs, [
    'native-framework-contracts',
    'pack-candidate',
  ]);
});
