import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';
import { validateWorkflowContent } from '../validate-github-workflows.mjs';

const workflowPath = '.github/workflows/native-renderer-artifacts.yml';
const read = () =>
  yaml.load(
    fs.readFileSync(new URL(`../../../${workflowPath}`, import.meta.url)),
  );
const errors = workflow =>
  validateWorkflowContent(workflowPath, yaml.dump(workflow)).filter(error =>
    error.includes('native artifact workflow'),
  );

test('native archive release has the closed qualification graph and least privilege', () => {
  assert.deepEqual(errors(read()), []);
});

test('all native jobs select the owning Node without relying on root pins', () => {
  for (const job of Object.values(read().jobs)) {
    const setup = job.steps.find(step =>
      step.uses?.startsWith('actions/setup-node@'),
    );
    assert.deepEqual(setup.with, { 'node-version': '26.13.1' });
  }
});

test('both independent build jobs bind each owner to its exact installed pnpm', () => {
  for (const id of ['produce', 'qualify']) {
    const job = read().jobs[id];
    const installer = job.steps.find(step =>
      step.uses?.startsWith('jdx/mise-action@'),
    );
    assert.equal(
      installer.with.install_args,
      'node@26.13.1 pnpm@11.21.0 pnpm@12.21.0',
    );
    const run = job.steps.find(step =>
      step.run?.includes('native-artifacts/main.mjs'),
    ).run;
    assert(
      run.includes(
        'NATIVE_ROUTER_PNPM="$(mise which pnpm --tool pnpm@11.21.0)"',
      ),
    );
    assert(
      run.includes(
        'NATIVE_RUNTIME_PNPM="$(mise which pnpm --tool pnpm@12.21.0)"',
      ),
    );
    assert(run.includes('mise exec node@26.13.1 -- node'));
  }
});

test('the required security job runs native controls in a cleaned operation-owned workspace', () => {
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
      String(step.run ?? '').includes('native-artifacts/*.test.mjs'),
    );
    const installer = workflow.jobs['workflow-security'].steps.find(step =>
      step.uses?.startsWith('jdx/mise-action@'),
    );
    assert.equal(installer.with.install_args, 'node@26.13.1');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].if, undefined);
    assert.equal(steps[0]['continue-on-error'], undefined);
    assert.equal(
      steps[0].run.trim(),
      [
        'work="$(mktemp -d "$RUNNER_TEMP/native-controls.XXXXXX")"',
        'trap \'rm -rf "$work"\' EXIT',
        'OWNED_TEMP_DIR="$work" mise exec node@26.13.1 -- node --test scripts/ultramodern-renderers/native-artifacts/*.test.mjs',
      ].join('\n'),
    );
  }
});

for (const [label, mutate] of Object.entries({
  'root Node pin': workflow => {
    workflow.jobs.release.steps.find(step =>
      step.uses?.startsWith('actions/setup-node@'),
    ).with = { 'node-version-file': '.nvmrc' };
  },
  'wrong Node version': workflow => {
    workflow.jobs.produce.steps.find(step =>
      step.uses?.startsWith('actions/setup-node@'),
    ).with = { 'node-version': '26.12.0' };
  },
  'another trigger': workflow => {
    workflow.on.pull_request = {};
  },
  'top-level write': workflow => {
    workflow.permissions.contents = 'write';
  },
  'additional job': workflow => {
    workflow.jobs.extra = structuredClone(workflow.jobs.produce);
  },
  'wrong repository': workflow => {
    workflow.jobs.produce.if = workflow.jobs.produce.if.replace(
      'ultramodernjs/ultramodern.js',
      'another/repository',
    );
  },
  'wrong branch': workflow => {
    workflow.jobs.produce.if = workflow.jobs.produce.if.replace(
      'main-ultramodern',
      'main',
    );
  },
  'unrestricted actor': workflow => {
    workflow.jobs.produce.if = 'true';
  },
  'missing source prerequisite': workflow => {
    delete workflow.jobs.qualify.needs;
  },
  'missing qualification prerequisite': workflow => {
    workflow.jobs.release.needs = ['produce'];
  },
  'qualification writer': workflow => {
    workflow.jobs.qualify.permissions.contents = 'write';
  },
  'npm OIDC': workflow => {
    workflow.jobs.release.permissions['id-token'] = 'write';
  },
  'ignored failure': workflow => {
    workflow.jobs.qualify['continue-on-error'] = true;
  },
  'unconditional release': workflow => {
    workflow.jobs.release.if = 'always()';
  },
  'different publication command': workflow => {
    workflow.jobs.release.steps.at(-1).run += ' || true';
  },
  'skipped qualification command': workflow => {
    workflow.jobs.qualify.steps.at(-1).if = 'false';
  },
  'missing owning toolchain': workflow => {
    workflow.jobs.produce.steps = workflow.jobs.produce.steps.filter(
      step => !step.uses?.startsWith('jdx/mise-action@'),
    );
  },
  'root pnpm instead of owning toolchain': workflow => {
    workflow.jobs.qualify.steps.find(step =>
      step.uses?.startsWith('jdx/mise-action@'),
    ).with.install_args = 'node@26.13.1 pnpm@12.21.0';
  },
  'missing runtime toolchain': workflow => {
    workflow.jobs.produce.steps.find(step =>
      step.uses?.startsWith('jdx/mise-action@'),
    ).with.install_args = 'node@26.13.1 pnpm@11.21.0';
  },
  'swapped runtime binary': workflow => {
    const step = workflow.jobs.qualify.steps.find(step =>
      step.run?.includes('native-artifacts/main.mjs'),
    );
    step.run = step.run.replace(
      'NATIVE_RUNTIME_PNPM="$(mise which pnpm --tool pnpm@12.21.0)"',
      'NATIVE_RUNTIME_PNPM="$(mise which pnpm --tool pnpm@11.21.0)"',
    );
  },
  'ignored toolchain installation': workflow => {
    workflow.jobs.produce.steps.find(step =>
      step.uses?.startsWith('jdx/mise-action@'),
    )['continue-on-error'] = true;
  },
  'mutable checkout': workflow => {
    workflow.jobs.produce.steps.find(step =>
      step.uses?.startsWith('actions/checkout@'),
    ).with.ref = 'main-ultramodern';
  },
  'persisted checkout credentials': workflow => {
    workflow.jobs.release.steps.find(step =>
      step.uses?.startsWith('actions/checkout@'),
    ).with['persist-credentials'] = true;
  },
}))
  test(`rejects native archive ${label}`, () => {
    const workflow = read();
    mutate(workflow);
    assert(errors(workflow).length > 0);
  });
