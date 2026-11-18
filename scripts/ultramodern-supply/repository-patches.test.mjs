import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { parse, parseAllDocuments } from 'yaml';
import inventory from '../../packages/toolkit/ultramodern-create/src/ultramodern-workspace/patch-inventory.ts';
import { targets } from '../ultramodern-dependencies/snapshot.mjs';

const root = new URL('../../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const recipes = JSON.parse(read('scripts/ultramodern-supply/sidecars.json'));
const workspace = parse(read('pnpm-workspace.yaml').toString());
const lock = parseAllDocuments(read('pnpm-lock.yaml').toString())
  .at(-1)
  .toJS({ maxAliasCount: -1 });
const supportInputs = JSON.parse(
  read('scripts/ultramodern-support-artifacts/inputs.json'),
);

test('repository SVGR declarations derive the actual template type from their declared peer', () => {
  const patch = inventory.find(
    item =>
      item.packageName === '@svgr/babel-plugin-transform-svg-component' &&
      item.version === '8.0.0',
  );
  assert.ok(patch);
  assert.equal(patch.repository, true);
  assert.equal(patch.workspace, null);
  assert.equal(
    workspace.patchedDependencies[
      '@svgr/babel-plugin-transform-svg-component@8.0.0'
    ],
    patch.path,
  );
  assert.equal(sha256(read(patch.path)), patch.sha256);
});

test('repository patch selectors are exactly the locked patch selectors', () => {
  assert.deepEqual(
    Object.keys(lock.patchedDependencies ?? {}).sort(),
    Object.keys(workspace.patchedDependencies).sort(),
  );
  for (const patch of inventory.filter(item => item.repository))
    assert.equal(
      lock.patchedDependencies[`${patch.packageName}@${patch.version}`],
      patch.sha256,
    );
});

// Every resolution of a producer-corrected package must be the authenticated
// archive pinned by its owning descriptor, so pnpm must not reapply the
// canonical correction on top of bytes that already carry it.
const assertQualifiedArchiveOnly = (packageName, producerPatchSha256) => {
  const descriptors = new Map();
  const specifiers = [];
  for (const importer of Object.keys(lock.importers)) {
    const manifest = JSON.parse(read(`${importer}/package.json`));
    for (const kind of ['nativeArtifacts', 'supportArtifacts']) {
      const descriptor = manifest.ultramodern?.[kind]?.packages?.[packageName];
      if (descriptor) descriptors.set(JSON.stringify(descriptor), descriptor);
    }
    for (const block of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ]) {
      const specifier = manifest[block]?.[packageName];
      if (specifier) specifiers.push([importer, specifier]);
    }
  }
  assert.equal(descriptors.size, 1, `${packageName} descriptor`);
  const [descriptor] = descriptors.values();
  assert.equal(descriptor.patchSha256, producerPatchSha256, packageName);
  assert.ok(specifiers.length > 0, packageName);
  for (const [importer, specifier] of specifiers)
    assert.equal(specifier, descriptor.request, `${importer} ${packageName}`);

  const selector = `${packageName}@${descriptor.version}`;
  assert.equal(Object.hasOwn(workspace.patchedDependencies, selector), false);
  assert.equal(Object.hasOwn(lock.patchedDependencies ?? {}, selector), false);
  const archive = `${packageName}@${descriptor.request}`;
  const packages = Object.keys(lock.packages).filter(key =>
    key.startsWith(`${packageName}@`),
  );
  assert.deepEqual(packages, [archive], packageName);
  assert.deepEqual(lock.packages[archive].resolution, {
    integrity: descriptor.integrity,
    tarball: descriptor.request,
  });
  const references = [];
  for (const [key, snapshot] of Object.entries(lock.snapshots)) {
    if (key.startsWith(`${packageName}@`))
      references.push(key.slice(packageName.length + 1));
    for (const block of ['dependencies', 'optionalDependencies'])
      if (snapshot[block]?.[packageName])
        references.push(snapshot[block][packageName]);
  }
  for (const project of Object.values(lock.importers))
    for (const block of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ])
      if (project[block]?.[packageName])
        references.push(project[block][packageName].version);
  assert.ok(references.length > 0, packageName);
  for (const reference of references) {
    assert.equal(reference.split('(')[0], descriptor.request, packageName);
    assert.doesNotMatch(reference, /patch_hash=/u, packageName);
  }
  return descriptor;
};

const retiredPatch = (packageName, version) => {
  const patch = inventory.find(
    item => item.packageName === packageName && item.version === version,
  );
  assert.ok(patch, `${packageName}@${version}`);
  assert.equal(patch.repository, false);
  assert.equal(patch.workspace, null);
  assert.equal(sha256(read(patch.path)), patch.sha256);
  return patch;
};

test('repository router-core resolves only the native archive built from the canonical correction', () => {
  const patch = retiredPatch('@tanstack/router-core', '1.171.39');
  const descriptor = assertQualifiedArchiveOnly(
    '@tanstack/router-core',
    patch.sha256,
  );
  assert.equal(descriptor.version, patch.version);
});

test('repository Effect telemetry resolves only the support archive built from the canonical correction', () => {
  const support = supportInputs['@effect/opentelemetry'];
  const patch = retiredPatch('@effect/opentelemetry', support.version);
  assert.equal(patch.path, support.patchPath);
  assert.equal(patch.sha256, support.patchSha256);
  const descriptor = assertQualifiedArchiveOnly(
    '@effect/opentelemetry',
    support.patchSha256,
  );
  assert.equal(descriptor.version, support.version);
});

test('repository Solid resolves the stable registry family without a support archive', () => {
  const family = [
    'solid-js',
    '@solidjs/signals',
    '@solidjs/web',
    '@solidjs/compiler',
  ];
  for (const name of family) {
    const version = targets[name];
    assert.match(version, /^\d+\.\d+\.\d+$/u, name);
    const key = `${name}@${version}`;
    assert.equal(Object.hasOwn(supportInputs, name), false, name);
    assert.equal(
      inventory.some(patch => patch.packageName === name),
      false,
    );
    assert.deepEqual(
      Object.keys(lock.packages).filter(id => id.startsWith(`${name}@`)),
      [key],
      name,
    );
    const resolution = lock.packages[key].resolution;
    assert.match(resolution.integrity, /^sha512-/u, name);
    assert.equal(Object.hasOwn(resolution, 'tarball'), false, name);
    assert.equal(
      Object.keys(lock.patchedDependencies ?? {}).some(id =>
        id.startsWith(`${name}@`),
      ),
      false,
      name,
    );
  }
  for (const importer of Object.keys(lock.importers)) {
    const manifest = JSON.parse(read(`${importer}/package.json`));
    const support = manifest.ultramodern?.supportArtifacts;
    if (support) {
      assert.equal(
        support.protocol,
        'ultramodern.support-artifacts.v4',
        importer,
      );
      assert.equal(
        Object.hasOwn(support.packages, 'solid-js'),
        false,
        importer,
      );
    }
    for (const block of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ])
      for (const name of family) {
        const specifier = manifest[block]?.[name];
        if (specifier !== undefined)
          assert.equal(specifier, targets[name], `${importer} ${name}`);
      }
  }
});

test('published MF aliases retain their canonical corrections without unused upstream patch selectors', () => {
  for (const name of [
    'bridge-react',
    'dts-plugin',
    'enhanced',
    'manifest',
    'modern-js-v3',
    'node',
    'rspack',
    'runtime-core',
  ]) {
    const packageName = `@module-federation/${name}`;
    const patch = inventory.find(item => item.packageName === packageName);
    const recipe = recipes.find(item => item.upstream.name === packageName);
    assert.equal(patch.repository, false, packageName);
    assert.equal(
      Object.hasOwn(
        workspace.patchedDependencies,
        `${packageName}@${patch.version}`,
      ),
      false,
      packageName,
    );
    assert.equal(recipe.patch.inventory, `${packageName}@${patch.version}`);
    assert.equal(recipe.fork.name, `@bleedingdev/mf-${name}`);
    assert.equal(sha256(read(patch.path)), patch.sha256, packageName);
  }
  for (const name of [
    'rsbuild-plugin-dts',
    'braces',
    '@module-federation/sdk',
  ]) {
    const patch = inventory.find(item => item.packageName === name);
    assert.equal(patch.repository, true, name);
    assert.equal(
      workspace.patchedDependencies[`${name}@${patch.version}`],
      patch.path,
      name,
    );
  }
});
