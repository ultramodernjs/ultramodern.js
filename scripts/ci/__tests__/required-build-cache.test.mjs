import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { scripts } = JSON.parse(
  fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
);

test('required CI builds execute the complete compiler-backed graph without depending on remote cache availability', () => {
  const required = scripts['build:required'].split(' ');
  const ordinary = scripts['prepare-build'].split(' ');
  assert.equal(required.filter(arg => arg === '--skipRemoteCache').length, 1);
  assert.deepEqual(
    required.filter(arg => arg !== '--skipRemoteCache'),
    ordinary,
  );
  assert.equal(required.includes('--skipNxCache'), false);
  assert.deepEqual(required.slice(0, 5), [
    'node',
    './scripts/with-effect-tsrs.mjs',
    'nx',
    'run-many',
    '-t',
  ]);
  assert.equal(
    scripts['prepare-build:local'].includes('--skipRemoteCache'),
    false,
  );
});
