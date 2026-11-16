import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the application supplies the React router and its shared corrected core', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const [name, version] of Object.entries({
    '@tanstack/react-router': '1.170.46',
    '@tanstack/router-core': '1.171.39',
  })) {
    assert(!Object.hasOwn(manifest.dependencies, name));
    assert(!Object.hasOwn(manifest.optionalDependencies ?? {}, name));
    assert.equal(manifest.peerDependencies[name], version);
    assert.equal(manifest.devDependencies[name], version);
    assert(!Object.hasOwn(manifest.peerDependenciesMeta, name));
  }
});
