import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { parse } from 'yaml';

const root = new URL('../../../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const load = async file =>
  import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(read(file))).toString('base64')}`
  );
const target = '2.0.0-rc.22';

test('repository policy selects the qualified Solid serializer tuple', () => {
  const { overrides } = parse(read('pnpm-workspace.yaml'));
  assert.equal(overrides['seroval@>=1.0.0 <1.8.1'], '1.8.1');
  assert.equal(overrides['seroval-plugins@>=1.0.0 <1.8.0'], '1.8.0');
  assert.equal(Object.hasOwn(overrides, 'seroval'), false);
  assert.equal(Object.hasOwn(overrides, 'seroval-plugins'), false);
});

test('the owning declaration, compiler ABI, runtime identity and generator profile agree', async () => {
  const manifest = JSON.parse(
    read('packages/runtime/renderer-solid/package.json'),
  );
  const { solidProfile } = await load(
    'packages/runtime/renderer-solid/src/plugin/profile.ts',
  );
  const { SOLID_RENDERER_PROFILE: identity } = await load(
    'packages/runtime/renderer-solid/src/index.ts',
  );
  for (const name of [
    'solid-js',
    '@solidjs/web',
    '@solidjs/signals',
    '@solidjs/compiler',
  ]) {
    assert.equal(
      manifest.dependencies[name] ?? manifest.peerDependencies[name],
      target,
      name,
    );
    assert.equal(solidProfile.dependencies[name], target, name);
  }
  assert.equal(solidProfile.compiler.version, target);
  assert.equal(solidProfile.hydration.version, target);
  assert.equal(identity.solid, target);
  assert.equal(identity.web, target);
  assert.equal(identity.nativePromiseMetadata.runtime, target);
  assert.match(
    read('packages/runtime/renderer-solid/src/manifest.ts'),
    /SOLID_COMPILER_VERSION = '2\.0\.0-rc\.22'/u,
  );
  assert.match(
    read(
      'packages/runtime/renderer-solid/src/plugin/preserve-import-loader.cjs',
    ),
    /@solidjs\/web 2\.0\.0-rc\.22/u,
  );
  // Router qualification is independent of the registry Solid tuple: the
  // binding source is pinned by provenance, the core by the owning native
  // artifact descriptor.
  assert.equal(
    identity.routerSource,
    '4fbd65c5c3b40be87a6248867c22021c1c19bba8',
  );
  const routerCore =
    manifest.ultramodern.nativeArtifacts.packages['@tanstack/router-core'];
  assert.equal(identity.routerCore, routerCore.version);
  assert.equal(solidProfile.router.coreVersion, routerCore.version);
  assert.equal(
    solidProfile.dependencies['@tanstack/router-core'],
    routerCore.request,
  );
  assert.equal(
    solidProfile.dependencies['@tanstack/router-core'],
    manifest.devDependencies['@tanstack/router-core'],
  );
});
