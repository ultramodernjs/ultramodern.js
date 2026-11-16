import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { satisfies } from 'semver';
import {
  collectModernPackages,
  rewritePackageJson,
} from '../../../../scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/rewrite.mjs';
import {
  cohort,
  descriptorFor,
  validateDescriptor,
} from '../../../../scripts/ultramodern-renderers/native-artifacts/protocol.mjs';
import { nativeFederationArtifacts } from '../../../../scripts/ultramodern-renderers/native-federation-inputs.mjs';

const packageRoot = new URL('../', import.meta.url);
const manifest = JSON.parse(
  fs.readFileSync(new URL('package.json', packageRoot), 'utf8'),
);
const nativeArtifacts = manifest.ultramodern.nativeArtifacts;
const nativeArtifactPeers = Object.keys(cohort);
const compilerPeers = ['@rsbuild/core', '@tsrx/oxc'];
const frameworkPeer = '@modern-js/i18n-runtime-extensions';
const supportedPeers = [
  ...nativeArtifactPeers,
  ...compilerPeers,
  'i18next',
  frameworkPeer,
];

test('the published SDK preserves application peers, accepted artifacts and framework aliases without exotic runtime subdependencies', () => {
  const options = {
    scope: 'bleedingdev',
    prefix: 'modern-js-',
    version: '3.9.0-ultramodern.0',
    dependencyVersion: '3.9.0-ultramodern.0',
    homepage: 'https://github.com/BleedingDev/ultramodern.js',
    bugsUrl: 'https://github.com/BleedingDev/ultramodern.js/issues',
    repositoryUrl: 'https://github.com/BleedingDev/ultramodern.js.git',
  };
  const published = structuredClone(manifest);
  // The release publishes every public workspace framework package.
  rewritePackageJson(
    published,
    manifest.name,
    options,
    collectModernPackages(options).sourceNames,
  );
  assert.equal(published.name, '@bleedingdev/modern-js-renderer-octane');
  const alias = name =>
    `npm:@bleedingdev/modern-js-${name.slice('@modern-js/'.length)}@3.9.0-ultramodern.0`;
  for (const block of ['dependencies', 'devDependencies'])
    for (const [name, request] of Object.entries(manifest[block]))
      if (name.startsWith('@modern-js/') && request.startsWith('workspace:'))
        assert.equal(published[block][name], alias(name), name);
  assert.equal(
    published.dependencies['@modern-js/renderer-core'],
    alias('@modern-js/renderer-core'),
  );
  assert.equal(published.devDependencies[frameworkPeer], alias(frameworkPeer));
  assert.deepEqual(
    Object.keys(published.peerDependencies).sort(),
    supportedPeers.toSorted(),
  );
  for (const name of supportedPeers) {
    assert.equal(typeof published.peerDependencies?.[name], 'string');
    assert.equal(
      published.peerDependencies[name],
      name === frameworkPeer
        ? '3.9.0-ultramodern.0'
        : manifest.peerDependencies[name],
    );
    assert.equal(published.dependencies?.[name], undefined);
    assert.equal(published.optionalDependencies?.[name], undefined);
    const optional = name === '@tanstack/router-core' ? undefined : true;
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, optional);
    assert.equal(published.peerDependenciesMeta?.[name]?.optional, optional);
  }
  assert.deepEqual(published.ultramodern.nativeArtifacts, nativeArtifacts);
  // Consumers read the packed renderer's typed descriptor, never a flat map.
  const consumed = nativeFederationArtifacts({
    sourceName: manifest.name,
    targetName: published.name,
    packageJson: published,
  });
  assert.deepEqual(
    Object.keys(consumed).sort(),
    nativeArtifactPeers.toSorted(),
  );
  for (const [name, artifact] of Object.entries(consumed))
    assert.equal(artifact.request, nativeArtifacts.packages[name].request);
  for (const dependencies of [
    published.dependencies,
    published.optionalDependencies,
  ]) {
    for (const specifier of Object.values(dependencies ?? {})) {
      assert.doesNotMatch(specifier, /^(?:https?:|git(?:\+|:)|file:|link:)/u);
    }
  }
});

test('SDK development installs the authenticated native producer cohort it publishes', () => {
  validateDescriptor(nativeArtifacts);
  // The manifest pin is the integrity of the producer's canonical manifest.
  const { protocol, producer, packages } = nativeArtifacts;
  assert.deepEqual(
    descriptorFor({ protocol, producer, packages }),
    nativeArtifacts,
  );
  for (const [name, version] of Object.entries(cohort)) {
    const artifact = nativeArtifacts.packages[name];
    assert.equal(manifest.devDependencies[name], artifact.request);
    assert.equal(manifest.peerDependencies[name], version);
    const installed = JSON.parse(
      fs.readFileSync(
        new URL(`node_modules/${name}/package.json`, packageRoot),
        'utf8',
      ),
    );
    assert.equal(installed.name, name);
    assert.equal(installed.version, version);
  }
});

test('SDK development resolves framework, i18n and compiler peers from their declared sources', () => {
  assert.equal(
    manifest.peerDependencies[frameworkPeer],
    `workspace:^${manifest.version}`,
  );
  assert.equal(manifest.devDependencies[frameworkPeer], 'workspace:*');
  const frameworkManifest = JSON.parse(
    fs.readFileSync(
      new URL(`node_modules/${frameworkPeer}/package.json`, packageRoot),
      'utf8',
    ),
  );
  assert.equal(frameworkManifest.name, frameworkPeer);
  assert.equal(frameworkManifest.version, manifest.version);
  assert.equal(
    manifest.peerDependencies.i18next,
    frameworkManifest.peerDependencies.i18next,
  );
  const installedI18next = JSON.parse(
    fs.readFileSync(
      new URL(
        `node_modules/${frameworkPeer}/node_modules/i18next/package.json`,
        packageRoot,
      ),
      'utf8',
    ),
  );
  assert.equal(installedI18next.name, 'i18next');
  assert.equal(
    satisfies(installedI18next.version, manifest.peerDependencies.i18next),
    true,
  );
  for (const name of compilerPeers) {
    const installed = JSON.parse(
      fs.readFileSync(
        new URL(`node_modules/${name}/package.json`, packageRoot),
        'utf8',
      ),
    );
    assert.equal(installed.name, name);
    assert.equal(
      manifest.devDependencies[name],
      manifest.peerDependencies[name],
    );
    assert.equal(installed.version, manifest.peerDependencies[name]);
  }
});
