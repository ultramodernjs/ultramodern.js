import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceDevManifest } from './source-dev.mjs';

const fixture = {
  name: 'source-dev-consumer',
  private: true,
  dependencies: {
    '@modern-js/renderer-octane': 'workspace',
    octane: '0.13.8',
  },
};
const requests = () => ({
  '@modern-js/renderer-octane': 'file:/owned/renderer-octane.tgz',
  octane: 'file:/owned/octane.tgz',
  typescript: '7.0.2',
  '@types/node': '26.6.5',
  '@module-federation/runtime': 'npm:@bleedingdev/mf-runtime@2.9.3',
});

test('selects real normal archive requests without inventing a release identity', () => {
  const packageRequests = requests();
  const manifest = sourceDevManifest(fixture, { packageRequests });
  assert.deepEqual(manifest.dependencies, packageRequests);
  assert.equal(manifest.name, fixture.name);
  assert.equal(manifest.version, undefined);
  assert.equal(manifest.pnpm, undefined);
  assert.equal(fixture.dependencies['@modern-js/renderer-octane'], 'workspace');
});

for (const request of [
  'workspace:*',
  'link:../octane',
  'catalog:',
  '^0.13.8',
  '*',
])
  test(`rejects ${request} instead of silently source-linking or floating`, () => {
    assert.throws(() =>
      sourceDevManifest(fixture, {
        packageRequests: { ...requests(), octane: request },
      }),
    );
  });

test('missing candidate request cannot fall back to the old fixture pin', () => {
  const packageRequests = requests();
  delete packageRequests.octane;
  assert.throws(() => sourceDevManifest(fixture, { packageRequests }));
});
