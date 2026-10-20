import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { satisfies } from 'semver';
import { rewritePackageJson } from '../../../../scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/rewrite.mjs';

const packageRoot = new URL('../', import.meta.url);
const manifest = JSON.parse(
  fs.readFileSync(new URL('package.json', packageRoot), 'utf8'),
);
const acceptedNativeArtifacts = {
  octane:
    'https://github.com/BleedingDev/octane/releases/download/ultramodern-octane-2383d2ab1e70/octane-0.13.8.tgz',
  '@octanejs/tanstack-router':
    'https://github.com/BleedingDev/octane/releases/download/ultramodern-octane-2383d2ab1e70/octanejs-tanstack-router-0.2.10.tgz',
  '@octanejs/rspack-plugin':
    'https://github.com/BleedingDev/octane/releases/download/ultramodern-octane-2383d2ab1e70/octanejs-rspack-plugin-0.2.4.tgz',
  '@tanstack/router-core':
    'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz',
};
const nativeArtifactPeers = Object.keys(acceptedNativeArtifacts);
const compilerPeers = ['@rsbuild/core', '@tsrx/oxc'];
const frameworkPeer = '@modern-js/i18n-runtime-extensions';
const supportedPeers = [
  ...nativeArtifactPeers,
  ...compilerPeers,
  'i18next',
  frameworkPeer,
];

test('the published SDK preserves application peers, accepted artifacts and framework aliases without exotic runtime subdependencies', () => {
  const published = structuredClone(manifest);
  rewritePackageJson(
    published,
    manifest.name,
    {
      scope: 'bleedingdev',
      prefix: 'modern-js-',
      version: '3.9.0-ultramodern.0',
      dependencyVersion: '3.9.0-ultramodern.0',
      homepage: 'https://github.com/BleedingDev/ultramodern.js',
      bugsUrl: 'https://github.com/BleedingDev/ultramodern.js/issues',
      repositoryUrl: 'https://github.com/BleedingDev/ultramodern.js.git',
    },
    new Set([
      manifest.name,
      '@modern-js/renderer-core',
      '@modern-js/tsconfig',
      frameworkPeer,
    ]),
  );
  assert.equal(published.name, '@bleedingdev/modern-js-renderer-octane');
  assert.equal(
    published.dependencies['@modern-js/renderer-core'],
    'npm:@bleedingdev/modern-js-renderer-core@3.9.0-ultramodern.0',
  );
  for (const name of ['@modern-js/tsconfig', frameworkPeer]) {
    assert.equal(
      published.devDependencies[name],
      `npm:@bleedingdev/modern-js-${name.slice('@modern-js/'.length)}@3.9.0-ultramodern.0`,
    );
  }
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
  assert.deepEqual(
    published.ultramodern.nativeArtifacts,
    manifest.ultramodern.nativeArtifacts,
  );
  for (const dependencies of [
    published.dependencies,
    published.optionalDependencies,
  ]) {
    for (const specifier of Object.values(dependencies ?? {})) {
      assert.doesNotMatch(specifier, /^(?:https?:|git(?:\+|:)|file:|link:)/u);
    }
  }
});

test('SDK development retains the immutable native artifacts matching its installed peer versions', () => {
  for (const name of nativeArtifactPeers) {
    const version = manifest.peerDependencies[name];
    const artifact = manifest.ultramodern.nativeArtifacts[name];
    assert.equal(manifest.devDependencies[name], acceptedNativeArtifacts[name]);
    assert.equal(artifact.request, acceptedNativeArtifacts[name]);
    assert.equal(artifact.version, version);
    assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
    const nativeManifest = JSON.parse(
      fs.readFileSync(
        new URL(`node_modules/${name}/package.json`, packageRoot),
        'utf8',
      ),
    );
    assert.equal(nativeManifest.name, name);
    assert.equal(nativeManifest.version, version);
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
