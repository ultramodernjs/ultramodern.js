import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  inputs,
  supportProtocol as protocol,
} from '../../../../scripts/ultramodern-support-artifacts/protocol.mjs';
import { solidProfile } from '../../../runtime/renderer-solid/src/plugin/profile';
import { readWorkspacePackageSource } from '../src/ultramodern-tooling/config/metadata';
import {
  createVerticalDescriptor,
  shellApp,
} from '../src/ultramodern-workspace/descriptors';
import {
  appDependencies,
  createAppPackage,
  createRootPackageJson,
} from '../src/ultramodern-workspace/package-json';
import {
  parseSupportArtifacts,
  readSupportArtifacts,
  resolvePackageSource,
  selectSupportRequests,
} from '../src/ultramodern-workspace/package-source';
import { resolveRendererGenerationAdapter } from '../src/ultramodern-workspace/renderer-generations';
import * as rendererProfile from '../src/ultramodern-workspace/renderer-profile';
import { getRendererGenerationProfile } from '../src/ultramodern-workspace/renderer-profile';
import type {
  ResolvedPackageSource,
  WorkspaceApp,
} from '../src/ultramodern-workspace/types';
import { assertRendererDependencies } from '../src/ultramodern-workspace/validation/renderer';

// Synthetic authority only; no production URL or descriptor is activated.
function descriptor() {
  const source = 'a'.repeat(40);
  const producer = {
    repository: protocol.repository,
    repositoryId: protocol.repositoryId,
    workflow: protocol.workflow,
    source,
    runId: 1,
    runAttempt: 1,
    tag: `support-artifacts-${source}-1-1`,
  };
  return protocol.descriptorFor({
    protocol: protocol.protocol,
    producer,
    packages: Object.fromEntries(
      Object.entries(protocol.cohort).map(([name, version]) => [
        name,
        {
          version,
          request: protocol.releaseUrl(
            producer,
            protocol.assetFilename(name, version),
          ),
          integrity: protocol.integrity(Buffer.from(name)),
          upstream: inputs[name].upstream,
          patchSha256: inputs[name].patchSha256,
        },
      ]),
    ),
  });
}

test.each(['react', 'solid'] as const)(
  '%s actual root/importer manifests retain exact support authority',
  renderer => {
    const supportArtifacts = parseSupportArtifacts(descriptor());
    const source: ResolvedPackageSource = {
      strategy: 'workspace',
      modernPackageVersion: 'workspace:*',
      supportArtifacts,
    };
    const app: WorkspaceApp = {
      ...shellApp,
      renderer,
      rendererGenerationProfile:
        renderer === 'solid'
          ? resolveRendererGenerationAdapter('solid').createProfile(
              structuredClone(solidProfile),
            )
          : getRendererGenerationProfile(renderer),
    };
    // The dynamic installed-adapter loader reads pre-existing build outputs.
    // Exercise emission against its owning source profile without rebuilding.
    if (renderer === 'solid')
      rstest
        .spyOn(rendererProfile, 'resolveAppGenerationProfile')
        .mockReturnValue(app.rendererGenerationProfile);
    const root = createRootPackageJson(
      'support-proof',
      source,
      [],
      undefined,
      [],
      app,
    );
    const importer = createAppPackage('support-proof', app, source, false);
    if (renderer === 'solid') {
      const manifest = JSON.parse(JSON.stringify(importer));
      assertRendererDependencies(
        manifest,
        renderer,
        app.rendererGenerationProfile,
      );
      for (const request of ['2.0.0-rc.22', 'https://example.com/solid.tgz']) {
        manifest.dependencies['solid-js'] = request;
        assert.throws(() =>
          assertRendererDependencies(
            manifest,
            renderer,
            app.rendererGenerationProfile,
          ),
        );
      }
      delete manifest.dependencies['solid-js'];
      assert.throws(() =>
        assertRendererDependencies(
          manifest,
          renderer,
          app.rendererGenerationProfile,
        ),
      );
    }
    for (const manifest of [root, importer]) {
      assert(
        manifest && typeof manifest === 'object' && !Array.isArray(manifest),
      );
      assert.deepEqual(readSupportArtifacts(manifest), supportArtifacts);
      const dependencies =
        'dependencies' in manifest
          ? manifest.dependencies
          : manifest.devDependencies;
      assert(
        dependencies &&
          typeof dependencies === 'object' &&
          !Array.isArray(dependencies),
      );
      const name = renderer === 'solid' ? 'solid-js' : '@tanstack/react-router';
      assert.equal(dependencies[name], supportArtifacts.packages[name].request);
      if (renderer === 'react')
        assert.equal(
          dependencies['@effect/opentelemetry'],
          supportArtifacts.packages['@effect/opentelemetry'].request,
        );
    }
    // The root directly hosts app-tools-extensions' required declaration
    // plugin peer; a UI-only shell does not run the native server compiler.
    const emitted = JSON.parse(JSON.stringify({ root, importer }));
    assert.equal(
      emitted.root.devDependencies['rsbuild-plugin-dts'],
      supportArtifacts.packages['rsbuild-plugin-dts'].request,
    );
    assert.equal(
      emitted.importer.devDependencies['rsbuild-plugin-dts'],
      undefined,
    );
    assert.deepEqual(source.supportArtifacts, supportArtifacts);
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'support-emission-'),
    );
    try {
      fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify(root),
      );
      assert.deepEqual(
        readWorkspacePackageSource(directory).supportArtifacts,
        supportArtifacts,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('API apps and roots emit the admitted declaration plugin archive', () => {
  const supportArtifacts = parseSupportArtifacts(descriptor());
  const request = supportArtifacts.packages['rsbuild-plugin-dts'].request;
  for (const preset of ['full-stack', 'api-only'] as const) {
    const app = createVerticalDescriptor('orders', 4101, { preset });
    for (const strategy of ['workspace', 'install'] as const) {
      const source: ResolvedPackageSource = {
        strategy,
        modernPackageVersion: 'workspace:*',
        supportArtifacts,
      };
      const manifest = JSON.parse(
        JSON.stringify(createAppPackage('support-proof', app, source, false)),
      );
      assert.equal(manifest.devDependencies['rsbuild-plugin-dts'], request);
      assert.equal(manifest.dependencies['rsbuild-plugin-dts'], undefined);
      assert.deepEqual(readSupportArtifacts(manifest), supportArtifacts);
      const root = JSON.parse(
        JSON.stringify(
          createRootPackageJson('support-proof', source, [app], undefined),
        ),
      );
      assert.equal(root.devDependencies['rsbuild-plugin-dts'], request);
      // The emitted manifests remain valid support selections.
      assert.doesNotThrow(() =>
        selectSupportRequests(root.devDependencies, supportArtifacts),
      );
    }
  }
  const raw = JSON.parse(
    JSON.stringify(
      createAppPackage(
        'support-proof',
        createVerticalDescriptor('orders', 4101, { preset: 'api-only' }),
        { strategy: 'workspace', modernPackageVersion: 'workspace:*' },
        false,
      ),
    ),
  );
  assert.equal(raw.devDependencies['rsbuild-plugin-dts'], '1.0.7');
  assert.throws(
    () =>
      selectSupportRequests(
        { 'rsbuild-plugin-dts': '1.0.6' },
        supportArtifacts,
      ),
    /differs from support descriptor/,
  );
});

test('shipped generator selects its admitted OTel correction for an Effect BFF', () => {
  // Reads the generator's own checked-in manifest, as generation does.
  const source = resolvePackageSource({
    targetDir: os.tmpdir(),
    packageName: 'support-proof',
    modernVersion: 'workspace:*',
    packageSource: { strategy: 'workspace' },
  });
  assert(
    source.supportArtifacts,
    'generator manifest carries support authority',
  );
  const dependencies = appDependencies(
    'support-proof',
    source,
    createVerticalDescriptor('orders', 4101, { preset: 'api-only' }),
  );
  assert.equal(
    dependencies['@effect/opentelemetry'],
    source.supportArtifacts.packages['@effect/opentelemetry'].request,
  );
});

test('closed support inputs reject missing, mismatched and inactive authority', () => {
  for (const mutate of [
    value => delete value.packages['solid-js'],
    value => delete value.packages['@tanstack/react-router'],
    value => delete value.packages['rsbuild-plugin-dts'],
    value => (value.protocol = 'ultramodern.support-artifacts.v1'),
    value => (value.protocol = 'ultramodern.support-artifacts.v2'),
    value => (value.packages['rsbuild-plugin-dts'].version = '1.0.6'),
    value =>
      (value.packages['rsbuild-plugin-dts'].request = value.packages[
        'rsbuild-plugin-dts'
      ].request.replace('support-artifacts-', 'native-renderers-')),
    value => (value.packages['solid-js'].version = '2.0.0-rc.21'),
    value =>
      (value.packages['solid-js'].request = 'https://example.com/solid.tgz'),
    value => (value.manifest.request = 'https://example.com/support.json'),
    value => (value.packages.octane = value.packages['solid-js']),
  ]) {
    const value = descriptor();
    mutate(value);
    assert.throws(() => parseSupportArtifacts(value));
  }
  assert.throws(() =>
    readSupportArtifacts({ ultramodern: { supportArtifacts: null } }),
  );
  const support = parseSupportArtifacts(descriptor());
  assert.throws(() =>
    selectSupportRequests({ 'solid-js': '2.0.0-rc.21' }, support),
  );
  assert.throws(() =>
    selectSupportRequests(
      { 'solid-js': support.packages['solid-js'].request },
      undefined,
    ),
  );
  assert.equal(
    selectSupportRequests(
      { 'solid-js': support.packages['solid-js'].request },
      support,
    )['solid-js'],
    support.packages['solid-js'].request,
  );
});

test('Solid runtime uses the exact required host peer, never a private runtime dependency', () => {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(
    fs.readFileSync(
      require.resolve('@modern-js/renderer-solid/package.json'),
      'utf8',
    ),
  );
  assert.equal(manifest.dependencies['solid-js'], undefined);
  assert.equal(manifest.optionalDependencies?.['solid-js'], undefined);
  const support = parseSupportArtifacts(manifest.ultramodern.supportArtifacts);
  assert.equal(
    support.packages['solid-js'].version,
    protocol.cohort['solid-js'],
  );
  assert.equal(
    manifest.peerDependencies['solid-js'],
    support.packages['solid-js'].version,
  );
  assert.notEqual(manifest.peerDependenciesMeta?.['solid-js']?.optional, true);
  assert.equal(
    manifest.devDependencies['solid-js'],
    support.packages['solid-js'].request,
  );
});
