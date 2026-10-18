#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inspectNpmTarball } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { readReleaseManifest } from '../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';

const packages = {
  octane: ['octane', 'octane'],
  '@octanejs/tanstack-router': ['octane', 'octanejs-tanstack-router'],
  '@octanejs/rspack-plugin': ['octane', 'octanejs-rspack-plugin'],
  '@tanstack/router-core': ['router', 'tanstack-router-core'],
};
const startPackages = {
  '@tanstack/start-storage-context': 'storage',
  '@tanstack/start-client-core': 'client',
  '@tanstack/start-server-core': 'server',
};
export const nativeStartSharedPeers = Object.freeze({
  '@tanstack/start-storage-context': ['@tanstack/router-core'],
  '@tanstack/start-client-core': [
    '@tanstack/router-core',
    '@tanstack/start-storage-context',
  ],
  '@tanstack/start-server-core': [
    '@tanstack/router-core',
    '@tanstack/start-storage-context',
    '@tanstack/start-client-core',
  ],
});

/** Consumer roots must agree on shared native requests in every direct block. */
export function nativeFederationPackageRequests(manifest) {
  const start = ['@octanejs/tanstack-start', ...Object.keys(startPackages)];
  const shared = [...Object.keys(packages), ...start];
  for (const name of shared) {
    const production = manifest.dependencies?.[name];
    const development = manifest.devDependencies?.[name];
    if (production !== undefined && development !== undefined)
      assert.equal(
        production,
        development,
        `Conflicting native request: ${name}`,
      );
    if (start.includes(name))
      assert(
        !Object.hasOwn(manifest.optionalDependencies ?? {}, name),
        `Native Start authority cannot be optional: ${name}`,
      );
  }
  return { ...manifest.dependencies, ...manifest.devDependencies };
}

/** Start uses one explicitly declared host authority, never inferred registry peers. */
export function nativeStartArchiveRequests(requests) {
  if (
    !['@octanejs/tanstack-start', ...Object.keys(startPackages)].some(name =>
      Object.hasOwn(requests, name),
    )
  )
    return {};
  return Object.fromEntries(
    ['@tanstack/router-core', ...Object.keys(startPackages)].map(name => {
      const request = requests[name];
      assert.equal(
        typeof request,
        'string',
        `Incomplete native Start closure: ${name}`,
      );
      const profile = startPackages[name];
      const prefix = profile
        ? `ultramodern-start-${profile}`
        : 'ultramodern-router-core';
      const basename = name.slice('@tanstack/'.length);
      assert.match(
        request,
        new RegExp(
          `^https://github\\.com/BleedingDev/router/releases/download/${prefix}-[a-f0-9]{12}/tanstack-${basename}-[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?\\.tgz$`,
          'u',
        ),
        `${name} must select its owning hosted native archive`,
      );
      return [name, request];
    }),
  );
}

export function assertNativeStartPeers(manifest, versions) {
  for (const name of nativeStartSharedPeers[manifest.name] ?? []) {
    assert.equal(
      typeof versions[name],
      'string',
      `Missing shared Start authority: ${name}`,
    );
    assert.equal(
      manifest.peerDependencies?.[name],
      versions[name],
      `${manifest.name} must require the selected exact shared ${name}`,
    );
    assert.notEqual(manifest.peerDependenciesMeta?.[name]?.optional, true);
    assert.equal(manifest.dependencies?.[name], undefined);
    assert.equal(manifest.optionalDependencies?.[name], undefined);
  }
}
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/** Read only the descriptor carried by the verified packed renderer manifest. */
export function nativeFederationArtifacts(rendererPackage) {
  assert.equal(rendererPackage.sourceName, '@modern-js/renderer-octane');
  const manifest = rendererPackage.packageJson;
  assert.equal(manifest.name, rendererPackage.targetName);
  assert.equal(manifest.ultramodern?.sourceName, rendererPackage.sourceName);
  nativeFederationPackageRequests(manifest);
  const artifacts = manifest.ultramodern.nativeArtifacts;
  assert(
    artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts),
    'Packed Octane renderer is missing nativeArtifacts',
  );
  const hasStart = [
    '@octanejs/tanstack-start',
    ...Object.keys(startPackages),
  ].some(name =>
    [
      artifacts,
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ].some(requests => Object.hasOwn(requests ?? {}, name)),
  );
  const selectedPackages = {
    ...packages,
    ...(hasStart
      ? Object.fromEntries(
          Object.keys(startPackages).map(name => [
            name,
            ['router', `tanstack-${name.slice('@tanstack/'.length)}`],
          ]),
        )
      : {}),
  };
  assert.deepEqual(
    Object.keys(artifacts).sort(),
    Object.keys(selectedPackages).sort(),
    'Native artifacts must name the complete runtime, router, compiler, core and declared Start closure',
  );
  let nativeRelease;
  return Object.fromEntries(
    Object.entries(selectedPackages).map(([name, [repository, basename]]) => {
      const artifact = artifacts[name];
      assert(
        artifact && typeof artifact === 'object' && !Array.isArray(artifact),
      );
      assert.deepEqual(Object.keys(artifact).sort(), [
        'integrity',
        'request',
        'version',
      ]);
      assert.match(artifact.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
      assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
      assert.equal(
        Buffer.from(artifact.integrity.slice(7), 'base64').toString('base64'),
        artifact.integrity.slice(7),
      );
      const request = new URL(artifact.request);
      const prefix =
        repository === 'octane'
          ? 'ultramodern-octane-'
          : startPackages[name]
            ? `ultramodern-start-${startPackages[name]}-`
            : 'ultramodern-router-core-';
      const filename = `${basename}-${artifact.version}.tgz`;
      assert.equal(
        request.origin,
        'https://github.com',
        'Native inputs require HTTPS GitHub release archives',
      );
      assert(
        !request.username &&
          !request.password &&
          !request.search &&
          !request.hash,
      );
      const match = new RegExp(
        `^/BleedingDev/${repository}/releases/download/(${prefix}[a-f0-9]{12})/`,
      ).exec(request.pathname);
      assert(match, 'Native input must select its owning hosted release');
      assert.equal(
        request.pathname,
        `/BleedingDev/${repository}/releases/download/${match[1]}/${filename}`,
      );
      assert.equal(
        request.href,
        artifact.request,
        'Native release request must be canonical',
      );
      if (repository === 'octane') {
        nativeRelease ??= match[1];
        assert.equal(
          match[1],
          nativeRelease,
          'Native runtime, router and compiler must belong to one accepted cohort',
        );
      }
      const declarations = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
      ].filter(block => Object.hasOwn(manifest[block] ?? {}, name));
      assert(
        declarations.length,
        `${name} is missing its packed renderer request`,
      );
      for (const block of declarations)
        assert.equal(
          manifest[block][name],
          artifact.request,
          `${name} differs from its packed renderer ${block} request`,
        );
      assert.equal(
        manifest.peerDependencies?.[name],
        artifact.version,
        `${name} differs from its packed renderer peer`,
      );
      return [name, { ...artifact, filename }];
    }),
  );
}

/** Stage exact expected bytes inside this invocation's existing owned workspace. */
export async function stageNativeFederationInputs({
  rendererPackage,
  directory,
  signal,
  fetchArtifact = fetch,
}) {
  const artifacts = nativeFederationArtifacts(rendererPackage);
  assert(
    process.env.OWNED_TEMP_DIR,
    'Stage native inputs through the current owned operation',
  );
  const ownerRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  assert(path.isAbsolute(directory) && path.resolve(directory) === directory);
  assert.equal(
    fs.realpathSync(path.dirname(directory)),
    path.dirname(directory),
  );
  assert(
    inside(ownerRoot, directory),
    'Native inputs must belong to the current owned operation',
  );
  signal?.throwIfAborted();
  fs.mkdirSync(directory);
  try {
    const inputs = {};
    for (const [name, artifact] of Object.entries(artifacts)) {
      signal?.throwIfAborted();
      const response = await fetchArtifact(artifact.request, { signal });
      assert(
        response.ok,
        `${name} native archive fetch failed: HTTP ${response.status}`,
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      assert(
        bytes.length <= 128 * 1024 * 1024,
        `${name} native archive exceeds the admission limit`,
      );
      assert.equal(
        `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        artifact.integrity,
        `${name} native archive integrity mismatch`,
      );
      const packed = inspectNpmTarball(bytes);
      assert.equal(
        packed.packageJson.name,
        name,
        'Native archive has another package identity',
      );
      assert.equal(
        packed.packageJson.version,
        artifact.version,
        'Native archive has another package version',
      );
      if (name === '@octanejs/tanstack-router')
        assert.equal(
          packed.packageJson.peerDependencies?.['@tanstack/router-core'],
          artifacts['@tanstack/router-core'].version,
          'Native router must require the selected exact shared core',
        );
      assertNativeStartPeers(
        packed.packageJson,
        Object.fromEntries(
          Object.entries(artifacts).map(([name, value]) => [
            name,
            value.version,
          ]),
        ),
      );
      signal?.throwIfAborted();
      const archivePath = path.join(directory, artifact.filename);
      fs.writeFileSync(archivePath, bytes, { flag: 'wx' });
      inputs[name] = {
        request: artifact.request,
        archivePath,
        integrity: artifact.integrity,
      };
    }
    const filename = path.join(directory, 'native-inputs.json');
    fs.writeFileSync(filename, `${JSON.stringify(inputs, null, 2)}\n`, {
      flag: 'wx',
    });
    return filename;
  } catch (error) {
    try {
      fs.rmSync(directory, { recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Native staging failed and could not retire its own output',
      );
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: { manifest: { type: 'string' }, out: { type: 'string' } },
  });
  assert(values.manifest && values.out, 'Pass --manifest and --out');
  const release = readReleaseManifest({ manifestPath: values.manifest });
  const rendererPackage = release.packages.find(
    item => item.sourceName === '@modern-js/renderer-octane',
  );
  assert(rendererPackage, 'Release cohort is missing its Octane renderer');
  const cancellation = new AbortController();
  const interrupts = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(event => [
    event,
    () => cancellation.abort(new Error(`Interrupted: ${event}`)),
  ]);
  for (const [event, handler] of interrupts) process.once(event, handler);
  try {
    console.log(
      await stageNativeFederationInputs({
        rendererPackage,
        directory: path.resolve(values.out),
        signal: cancellation.signal,
      }),
    );
  } finally {
    for (const [event, handler] of interrupts)
      process.removeListener(event, handler);
  }
}
