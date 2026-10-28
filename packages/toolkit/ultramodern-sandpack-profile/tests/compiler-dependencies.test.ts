import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ultramodernSandpackFiles } from '../src/index.ts';

const profileManifest = JSON.parse(ultramodernSandpackFiles['/package.json']);
const rootManifest = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
);
const smokeManifest = JSON.parse(
  readFileSync(
    new URL(
      '../../../../tests/integration/ultramodern-sandpack-profile-smoke/package.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

for (const [name, version] of Object.entries({
  '@effect/tsgo': '0.63.0',
  tsrs: '0.20.1-ts7.1.0-beta',
})) {
  test(`the exported app and smoke fixture pin ${name} to ${version}`, () => {
    assert.equal(rootManifest.devDependencies[name], version);
    assert.equal(profileManifest.devDependencies[name], version);
    assert.equal(smokeManifest.devDependencies[name], version);
  });
}

test('the exported app retains TypeScript tooling and Effect versions', () => {
  assert.equal(rootManifest.devDependencies.typescript, '7.0.2');
  assert.equal(profileManifest.devDependencies.typescript, '7.0.2');
  assert.equal(smokeManifest.devDependencies.typescript, '7.0.2');
  assert.equal(profileManifest.dependencies.effect, '4.0.7');
  assert.equal(smokeManifest.devDependencies.effect, '4.0.7');
});

test('the exported app keeps the build checker enabled', () => {
  assert.equal(profileManifest.scripts.build, 'modern build');
  assert.match(
    ultramodernSandpackFiles['/modern.config.ts'],
    /output:\s*\{\s*disableTsChecker:\s*false,/u,
  );
  assert.doesNotMatch(
    ultramodernSandpackFiles['/modern.config.ts'],
    /disableTsChecker:\s*true/u,
  );
});
