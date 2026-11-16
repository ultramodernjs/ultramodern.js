import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { reactProfile } from '../../packages/solutions/ultramodern-app-tools/src/renderers/react/profile.ts';

const read = file =>
  JSON.parse(fs.readFileSync(new URL(`../../${file}`, import.meta.url)));
const root = read('package.json');
const runtime = read('packages/runtime/plugin-runtime/package.json');
const frameworkOwners = {
  '@modern-js/runtime': runtime,
  '@modern-js/i18n-integration': read(
    'packages/runtime/i18n-integration/package.json',
  ),
  '@modern-js/runtime-renderer-extensions': read(
    'packages/runtime/renderer-extensions/package.json',
  ),
};

test('the executable React profile uses the reviewed Node floor and its source owners', () => {
  assert.equal(root.engines.node, `>=${reactProfile.minimumNode}`);
  for (const [name, version] of Object.entries(reactProfile.dependencies)) {
    const owner = frameworkOwners[name];
    const expected = owner
      ? owner.version
      : (runtime.dependencies[name] ?? runtime.peerDependencies[name]);
    assert.ok(expected, `${name}: missing source owner`);
    assert.equal(version, expected.replace(/^\^/u, ''), name);
  }
});

test('React compiler, hydration and router metadata agree with their declared dependency requests', () => {
  for (const input of [
    reactProfile.compiler,
    reactProfile.hydration,
    reactProfile.router,
  ]) {
    assert.equal(
      input.version,
      reactProfile.dependencies[input.name],
      input.name,
    );
  }
  assert.equal(
    reactProfile.router.coreVersion,
    reactProfile.dependencies[reactProfile.router.coreName],
  );
});
