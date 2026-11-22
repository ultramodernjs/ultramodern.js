import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { compilerBootstrapSelectors } from '../published-create-proof/package-cohort.mjs';

const generator = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../../packages/toolkit/ultramodern-create/package.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('compiler trust authenticates packed root dependencies without age exceptions or platform selectors', () => {
  const expected = ['@effect/tsgo', 'tsrs']
    .filter(name => generator.dependencies?.[name])
    .map(name => `${name}@${generator.dependencies[name]}`);
  assert.deepEqual(compilerBootstrapSelectors(generator), expected);
  assert.equal(generator.ultramodern?.bootstrapReleaseAgeExclude, undefined);
});
