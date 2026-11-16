import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';
import { validateWorkflowContent } from '../validate-github-workflows.mjs';

const workflowPath = '.github/workflows/support-artifacts.yml';
const read = () =>
  yaml.load(
    fs.readFileSync(new URL(`../../../${workflowPath}`, import.meta.url)),
  );
const errors = workflow =>
  validateWorkflowContent(workflowPath, yaml.dump(workflow)).filter(error =>
    error.includes('support artifact workflow'),
  );

test('normal validation treats support publication as sensitive without filtering diagnostics', () => {
  for (const mutate of [
    workflow => {
      for (const job of Object.values(workflow.jobs))
        job.steps = job.steps.filter(
          step => !step.uses?.startsWith('step-security/harden-runner@'),
        );
    },
    workflow => {
      workflow.jobs.qualify.steps.push({
        run: 'node --test --test-name-pattern="safe-only" control.test.mjs',
      });
    },
  ]) {
    const workflow = read();
    mutate(workflow);
    assert(
      validateWorkflowContent(workflowPath, yaml.dump(workflow)).length > 0,
      'Sensitive publication mutations must fail the complete validator',
    );
  }
});

test('support artifacts require independent qualification and a single writer', () => {
  assert.deepEqual(errors(read()), []);
});

test('both security workflows execute the shared kernel and support controls', () => {
  for (const directory of ['.github', '.depot']) {
    const workflow = yaml.load(
      fs.readFileSync(
        new URL(
          `../../../${directory}/workflows/workflow-security.yml`,
          import.meta.url,
        ),
      ),
    );
    const steps = workflow.jobs['workflow-security'].steps.filter(step =>
      String(step.run ?? '').includes(
        'ultramodern-support-artifacts/*.test.mjs',
      ),
    );
    assert.equal(steps.length, 1);
    assert.equal(steps[0].if, undefined);
    assert.equal(steps[0]['continue-on-error'], undefined);
    assert.equal(
      steps[0].run.trim(),
      [
        'work="$(mktemp -d "$RUNNER_TEMP/support-controls.XXXXXX")"',
        'trap \'rm -rf "$work"\' EXIT',
        'OWNED_TEMP_DIR="$work" mise exec node@26.13.1 -- node --test scripts/ultramodern-artifacts/*.test.mjs scripts/ultramodern-support-artifacts/*.test.mjs',
      ].join('\n'),
    );
  }
});

for (const [label, mutate] of Object.entries({
  'automatic trigger': workflow => {
    workflow.on.push = {};
  },
  'top-level writer': workflow => {
    workflow.permissions.contents = 'write';
  },
  'unknown job': workflow => {
    workflow.jobs.extra = structuredClone(workflow.jobs.produce);
  },
  'unrestricted source actor': workflow => {
    workflow.jobs.produce.if = 'true';
  },
  'missing owning qualification': workflow => {
    workflow.jobs.publish.needs = ['produce'];
  },
  'unconditional publication': workflow => {
    workflow.jobs.publish.if = 'always()';
  },
  'qualification writer': workflow => {
    workflow.jobs.qualify.permissions.contents = 'write';
  },
  'ignored qualification': workflow => {
    workflow.jobs.qualify['continue-on-error'] = true;
  },
  'changed source checkout': workflow => {
    workflow.jobs.produce.steps.find(step =>
      step.uses?.startsWith('actions/checkout@'),
    ).with.ref = 'main-ultramodern';
  },
  'persisted checkout credential': workflow => {
    workflow.jobs.qualify.steps.find(step =>
      step.uses?.startsWith('actions/checkout@'),
    ).with['persist-credentials'] = true;
  },
  'root Node fallback': workflow => {
    workflow.jobs.publish.steps.find(step =>
      step.uses?.startsWith('actions/setup-node@'),
    ).with = { 'node-version-file': '.nvmrc' };
  },
  'wrong pnpm toolchain': workflow => {
    workflow.jobs.produce.steps.find(step =>
      step.uses?.startsWith('jdx/mise-action@'),
    ).with.install_args = 'node@26.13.1 pnpm@11.21.0';
  },
  'toolchain cache writer': workflow => {
    delete workflow.jobs.qualify.steps.find(step =>
      step.uses?.startsWith('jdx/mise-action@'),
    ).with.cache_save;
  },
  'skipped packed command': workflow => {
    workflow.jobs.qualify.steps.find(step =>
      step.run?.includes('support-artifacts/main.mjs'),
    ).if = 'false';
  },
  'substituted qualification command': workflow => {
    workflow.jobs.qualify.steps.find(step =>
      step.run?.includes('support-artifacts/main.mjs'),
    ).run = 'echo qualified';
  },
})) {
  test(`support workflow rejects ${label}`, () => {
    const workflow = read();
    mutate(workflow);
    assert(errors(workflow).length > 0);
  });
}
