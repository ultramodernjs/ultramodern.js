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
const candidate = 'octane-0.20.0';
const inputs = [
  `${correctionDirectory}/octane-0.20.0/runtime-source.patch`,
  `${correctionDirectory}/octane-0.20.0/rspack-source.patch`,
  `${correctionDirectory}/octane-0.20.0/rspack-tests.patch`,
  `${correctionDirectory}/runtime-tests.patch`,
  `${correctionDirectory}/typescript-compat/typescript-source.patch`,
  `${correctionDirectory}/typescript-compat/native-signals-source.patch`,
  `${correctionDirectory}/typescript-compat/volar-core-source.patch`,
  `${correctionDirectory}/octane-0.20.0/provenance.json`,
  `${correctionDirectory}/octane-0.20.0/runtime-build-package.json`,
  `${correctionDirectory}/octane-0.20.0/runtime-build-pnpm-lock.yaml`,
];
const patches = [
  'patches/octane@0.20.0.patch',
  'patches/@octanejs__rspack-plugin@0.2.12.patch',
];
const rejectedCandidates = [
  'octane-0.18.0',
  'octane-0.19.0',
  'octane-latest',
  '__proto__',
  'octane-0.20.0; touch injected',
  '$(touch injected)',
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

test('the Octane candidate is a fixed choice that reaches shell only through env', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.octane_candidate, {
    description:
      'Octane correction candidate qualified when runtime_patch_handoff is true',
    required: true,
    type: 'choice',
    options: [candidate],
    default: candidate,
  });
  for (const name of [names.qualify, names.receipt]) {
    const step = stepNamed(name);
    assert.equal(
      step.env.OCTANE_CANDIDATE,
      expression('inputs.octane_candidate'),
      name,
    );
    assert.doesNotMatch(step.run, /\$\{\{[^}]*inputs\./u, name);
  }
});

/** Run the qualify step with stubbed mise, pnpm and node, so no qualifier work starts. */
function runQualifyStep(t, selected = candidate) {
  const cwd = fs.mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'runtime-qualify-step-',
    ),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin');
  const pnpm = path.join(cwd, 'pnpm');
  const argv = path.join(cwd, 'node-argv');
  fs.mkdirSync(bin);
  fs.writeFileSync(pnpm, '#!/usr/bin/env bash\necho 12.21.0\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(bin, 'mise'),
    `#!/usr/bin/env bash\necho ${pnpm}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'node'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$QUALIFY_ARGV"\n',
    { mode: 0o755 },
  );
  const result = runBash(stepNamed(names.qualify).run, {
    cwd,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: cwd,
      OCTANE_CANDIDATE: selected,
      QUALIFY_ARGV: argv,
    },
  });
  assert.equal(fs.existsSync(path.join(cwd, 'injected')), false);
  return {
    result,
    argv: fs.existsSync(argv)
      ? fs.readFileSync(argv, 'utf8').trimEnd().split('\n')
      : undefined,
  };
}

test('manual qualifier passes only the current Octane flag', t => {
  const { result, argv } = runQualifyStep(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(argv, [
    'scripts/ultramodern-renderers/octane-corrections/qualify-runtime.mjs',
    '--octane-0.20.0',
    '--write-patch',
  ]);
});

test('manual qualifier rejects legacy, moving and injected candidates before starting', t => {
  for (const selected of rejectedCandidates) {
    const { result, argv } = runQualifyStep(t, selected);
    assert.notEqual(result.status, 0, selected);
    assert.equal(argv, undefined, selected);
  }
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

function stageFiles(cwd, files) {
  for (const [file, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), bytes);
  }
}

/** Run the receipt step against candidate files staged in a scratch checkout. */
function runReceipt(t, selected = candidate, env = {}) {
  const cwd = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'runtime-receipt-'),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const files = Object.fromEntries(
    [...inputs, ...patches].map(file => [
      file,
      fs.readFileSync(new URL(file, root)),
    ]),
  );
  stageFiles(cwd, files);
  const handoff = path.join(cwd, 'handoff');
  const result = runBash(stepNamed(names.receipt).run, {
    cwd,
    env: {
      HANDOFF_DIR: handoff,
      OCTANE_CANDIDATE: selected,
      SOURCE_SHA: 'a'.repeat(40),
      RUN_ID: '42',
      RUN_ATTEMPT: '3',
      PNPM_VERSION: '12.21.0',
      MISE_VERSION: '2026.11.8',
      ...env,
    },
  });
  assert.equal(fs.existsSync(path.join(cwd, 'injected')), false);
  return { result, files, handoff };
}

test('receipt binds the checkout SHA, run identity, toolchain and every staged file digest', t => {
  const receipt = stepNamed(names.receipt);
  assert.equal(receipt.env.SOURCE_SHA, expression('github.sha'));
  assert.equal(receipt.env.RUN_ID, expression('github.run_id'));
  assert.equal(receipt.env.RUN_ATTEMPT, expression('github.run_attempt'));
  assert.equal(receipt.env.PNPM_VERSION, '12.21.0');
  assert.equal(receipt.env.MISE_VERSION, '2026.11.8');
  const { result, files, handoff } = runReceipt(t);
  assert.equal(result.status, 0, result.stderr);
  const describe = file => ({
    path: file,
    bytes: files[file].length,
    sha256: sha256(files[file]),
  });
  const body = JSON.parse(
    fs.readFileSync(path.join(handoff, 'receipt.json'), 'utf8'),
  );
  assert.equal(body.schema, 'runtime-patch-handoff/v1');
  assert.equal(body.candidate, candidate);
  assert.equal(body.sourceSha, 'a'.repeat(40));
  assert.deepEqual(body.run, { id: '42', attempt: '3' });
  assert.deepEqual(body.toolchain, {
    node: process.versions.node,
    pnpm: '12.21.0',
    mise: '2026.11.8',
  });
  assert.deepEqual(body.patches, patches.map(describe));
  assert.deepEqual(body.inputs, inputs.map(describe));
  // The handoff carries the actual inputs and outputs, not only their digests.
  for (const file of [...inputs, ...patches])
    assert.deepEqual(
      fs.readFileSync(path.join(handoff, file)),
      files[file],
      file,
    );
});

test('receipt reproduces authenticated handoff 44296887336 without changing input order, patches or toolchains', t => {
  const expected = JSON.parse(
    fs.readFileSync(
      new URL(
        `${correctionDirectory}/octane-0.20.0/runtime-handoff.json`,
        root,
      ),
      'utf8',
    ),
  );
  assert.deepEqual(expected.run, { id: '44296887336', attempt: '1' });
  assert.deepEqual(expected.toolchain, {
    node: '26.13.1',
    pnpm: '12.21.0',
    mise: '2026.11.8',
  });
  assert.deepEqual(
    expected.patches.map(({ sha256 }) => sha256),
    [
      'b81dfd366a14935b0a90f449916a8434d2c398f007dcdafcc6a0911235491493',
      'bd448e034c50f526e9a580e4595ab73417cf19273ddf9fc1254cdfe71b51fcfb',
    ],
  );
  const { result, handoff } = runReceipt(t, candidate, {
    SOURCE_SHA: expected.sourceSha,
    RUN_ID: expected.run.id,
    RUN_ATTEMPT: expected.run.attempt,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(handoff, 'receipt.json'), 'utf8')),
    expected,
  );
});

test('receipt rejects legacy, moving and injected candidates without writing a handoff', t => {
  for (const selected of rejectedCandidates) {
    const { result, handoff } = runReceipt(t, selected);
    assert.notEqual(result.status, 0, selected);
    assert.equal(fs.existsSync(handoff), false, selected);
  }
});

test('the native framework contracts job runs this schema test', () => {
  const controls = stepNamed('Test renderer acceptance controls');
  assert.match(
    controls.run,
    /scripts\/ci\/__tests__\/native-runtime-handoff\.test\.mjs/u,
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
