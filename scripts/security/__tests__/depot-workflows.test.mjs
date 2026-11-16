import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';
import { validateWorkflowContent } from '../validate-github-workflows.mjs';

const workflowDirectory = new URL(
  '../../../.depot/workflows/',
  import.meta.url,
);
const readWorkflow = (directory, name) =>
  yaml.load(fs.readFileSync(new URL(name, directory), 'utf8'));

test('Depot workflows keep pinned actions, read permissions, and Linux runners', () => {
  const files = fs
    .readdirSync(workflowDirectory)
    .filter(name => name.endsWith('.yml'));
  assert.deepEqual(files.sort(), [
    'check-dependencies.yml',
    'ci-cache.yml',
    'integration-test.yml',
    'lint-Linux.yml',
    'native-compatibility.yml',
    'test-builder-e2e.yml',
    'type-check.yml',
    'ut-Linux.yml',
    'workflow-security.yml',
  ]);
  for (const name of files) {
    const content = fs.readFileSync(new URL(name, workflowDirectory), 'utf8');
    assert.deepEqual(
      validateWorkflowContent(`.depot/workflows/${name}`, content),
      [],
      name,
    );
    const workflow = yaml.load(content);
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(
        job['runs-on'] === 'depot-ubuntu-24.04-8' ||
          job['runs-on'] === ['${{', 'matrix.runner', '}}'].join(' '),
        name,
      );
      for (const entry of job.strategy?.matrix?.include ?? []) {
        assert.equal(entry.runner, 'depot-ubuntu-24.04-8', name);
        assert.equal(entry.platform, 'Linux', name);
      }
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('./')) {
          assert.ok(step.uses.startsWith('./.depot/actions/'), name);
          assert.ok(
            fs.existsSync(
              new URL(`../../../${step.uses}/action.yml`, import.meta.url),
            ),
            name,
          );
        }
      }
    }
  }
});

test('Depot integration retains every Linux suite', () => {
  const depot = readWorkflow(workflowDirectory, 'integration-test.yml');
  const github = readWorkflow(
    new URL('../../../.github/workflows/', import.meta.url),
    'integration-test.yml',
  );
  const coverage = entries => entries.map(({ runner, ...entry }) => entry);
  const expected = github.jobs.integration.strategy.matrix.include.filter(
    entry => entry.platform === 'Linux',
  );
  assert.deepEqual(
    coverage(depot.jobs.integration.strategy.matrix.include),
    coverage(expected),
  );
});
