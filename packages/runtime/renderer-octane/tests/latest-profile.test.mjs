import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { targets } from '../../../../scripts/ultramodern-dependencies/snapshot.mjs';
import { octaneProfile } from '../src/plugin/profile.ts';

test('generated Octane compiler and serializer requests match the reviewed latest cohort', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const name of ['@tsrx/oxc', 'seroval', 'seroval-plugins'])
    assert.equal(octaneProfile.dependencies[name], targets[name]);
  assert.equal(
    manifest.peerDependencies['@tsrx/oxc'],
    octaneProfile.dependencies['@tsrx/oxc'],
  );
  assert.equal(
    manifest.devDependencies['@tsrx/oxc'],
    octaneProfile.dependencies['@tsrx/oxc'],
  );
});
