import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';
import { MINIMUM_NODE_VERSION } from '../../ultramodern-node-policy/check-node-version.mjs';

const root = new URL('../../../', import.meta.url);
const miseVersion = '2026.11.8';
const mise = fs.readFileSync(new URL('.mise.toml', root), 'utf8');
const node = /^node\s*=\s*"(\d+\.\d+\.\d+)"$/mu.exec(mise)?.[1];
assert(node, 'Root mise configuration must pin an exact stable Node version');

test('local Node selectors and the runtime boundary agree', () => {
  assert.equal(fs.readFileSync(new URL('.nvmrc', root), 'utf8').trim(), node);
  assert.equal(MINIMUM_NODE_VERSION, node);
});

test('dependency update commands use the reviewed Taze version', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('package.json', root), 'utf8'),
  );
  for (const [script, group] of [
    ['update-rspress', 'rspress'],
    ['update-rsbuild', 'rsbuild'],
  ])
    assert.equal(
      manifest.scripts[script],
      `npx --yes taze@21.3.0 major --include /${group}/ -w -r -l`,
    );
});

for (const directory of ['.github/workflows', '.depot/workflows'])
  test(`${directory} uses the exact qualified Node pin`, () => {
    let setupCount = 0;
    for (const filename of fs.readdirSync(new URL(`${directory}/`, root))) {
      if (!/\.ya?ml$/u.test(filename)) continue;
      const workflow = yaml.load(
        fs.readFileSync(new URL(`${directory}/${filename}`, root), 'utf8'),
      );
      for (const job of Object.values(workflow.jobs ?? {}))
        for (const step of job.steps ?? [])
          if (step.uses?.startsWith('actions/setup-node@')) {
            setupCount++;
            if (step.with?.['node-version-file'] !== undefined) {
              assert.equal(step.with['node-version-file'], '.nvmrc');
              assert.equal(step.with['node-version'], undefined);
              continue;
            }
            assert.equal(
              step.with?.['node-version'],
              node,
              `${path.join(directory, filename)}: ${step.name}`,
            );
          }
    }
    assert(setupCount > 0, 'The workflow inventory cannot be empty');
  });

for (const directory of ['.github/workflows', '.depot/workflows'])
  test(`${directory} pins the reviewed mise release`, () => {
    let count = 0;
    for (const filename of fs.readdirSync(new URL(`${directory}/`, root))) {
      if (!/\.ya?ml$/u.test(filename)) continue;
      const workflow = yaml.load(
        fs.readFileSync(new URL(`${directory}/${filename}`, root), 'utf8'),
      );
      for (const job of Object.values(workflow.jobs ?? {}))
        for (const step of job.steps ?? [])
          if (step.uses?.startsWith('jdx/mise-action@')) {
            count++;
            assert.equal(
              step.with?.version,
              miseVersion,
              `${path.join(directory, filename)}: ${step.name}`,
            );
          }
    }
    assert(count > 0, 'The mise workflow inventory cannot be empty');
  });
