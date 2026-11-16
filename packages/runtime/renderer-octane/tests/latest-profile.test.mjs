import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { targets } from '../../../../scripts/ultramodern-dependencies/snapshot.mjs';
import { OCTANE_RUNTIME_PROFILE } from '../src/index.ts';
import { octaneProfile } from '../src/plugin/profile.ts';

const manifest = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const nativeArtifacts = manifest.ultramodern.nativeArtifacts.packages;

test('generated Octane compiler and serializer requests match the reviewed latest cohort', () => {
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

test('generated applications install the native archives the renderer admits', () => {
  const { compiler, hydration, router } = octaneProfile;
  for (const [name, version] of [
    [compiler.name, compiler.version],
    [hydration.name, hydration.version],
    [router.name, router.version],
    [router.coreName, router.coreVersion],
  ]) {
    assert.equal(version, nativeArtifacts[name].version, name);
    assert.equal(
      octaneProfile.dependencies[name],
      nativeArtifacts[name].request,
      name,
    );
  }
  const installedRouter = JSON.parse(
    fs.readFileSync(
      new URL(`../node_modules/${router.name}/package.json`, import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(OCTANE_RUNTIME_PROFILE, {
    renderer: 'octane',
    runtime: hydration.version,
    router: router.version,
    routerCore: router.coreVersion,
    history: installedRouter.dependencies['@tanstack/history'],
  });
});
