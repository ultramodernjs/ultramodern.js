import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  BOOTSTRAP_RELEASE_AGE_EXCEPTIONS,
  COMPILER_RELEASE_AGE_EXCEPTIONS,
} from '../../../packages/toolkit/ultramodern-create/src/ultramodern-workspace/versions.ts';
import yaml from '../../../packages/toolkit/utils/compiled/js-yaml/index.js';
import { compilerBootstrapSelectors } from '../published-create-proof/package-cohort.mjs';

const root = new URL('../../../', import.meta.url);
const generator = JSON.parse(
  fs.readFileSync(
    new URL('packages/toolkit/ultramodern-create/package.json', root),
    'utf8',
  ),
);

test('packed generator bootstrap authenticates every selected compiler host and runtime', () => {
  assert.deepEqual(
    compilerBootstrapSelectors(generator).sort(),
    [...BOOTSTRAP_RELEASE_AGE_EXCEPTIONS].sort(),
  );
});

test('repository release-age policy admits the selected compiler platform set exactly', () => {
  const workspace = yaml.load(
    fs.readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8'),
  );
  const actual = workspace.minimumReleaseAgeExclude.filter(selector =>
    /^(?:@effect\/tsgo(?:-[^@]+)?|tsrs|@tsrs\/[^@]+)@\S+$/u.test(selector),
  );
  assert.deepEqual(actual.sort(), [...COMPILER_RELEASE_AGE_EXCEPTIONS].sort());
});
