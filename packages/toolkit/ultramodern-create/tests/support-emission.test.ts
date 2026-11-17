import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { verifySupportConsumer } from '../../../../scripts/ultramodern-publish/verify-support-consumer.mjs';
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
  createSharedPackage,
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
import {
  readBundledFrameworkManifests,
  toolingSupportDependencies,
} from '../src/ultramodern-workspace/tooling-support';
import type {
  ResolvedPackageSource,
  WorkspaceApp,
} from '../src/ultramodern-workspace/types';
import {
  assertRendererDependencies,
  assertWorkspaceRootToolingDependencies,
} from '../src/ultramodern-workspace/validation/renderer';

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

test.each(['react', 'solid', 'octane', 'none'] as const)(
  '%s importers host the exact installed tooling closure, not foreign runtimes',
  renderer => {
    const supportArtifacts = parseSupportArtifacts(descriptor());
    const source: ResolvedPackageSource = {
      strategy: 'workspace',
      modernPackageVersion: 'workspace:*',
      supportArtifacts,
    };
    const app =
      renderer === 'none'
        ? createVerticalDescriptor('orders', 4101, { preset: 'api-only' })
        : { ...shellApp, renderer };
    const rootRenderer = renderer === 'none' ? 'react' : renderer;
    const manifest = JSON.parse(
      JSON.stringify(createAppPackage('support-proof', app, source, false)),
    );
    const root = JSON.parse(
      JSON.stringify(
        createRootPackageJson('support-proof', source, [], undefined, [], {
          ...shellApp,
          renderer: rootRenderer,
        }),
      ),
    );
    const selectedSupport = (value: typeof manifest) =>
      Object.keys(supportArtifacts.packages)
        .filter(name =>
          Object.hasOwn(
            { ...value.dependencies, ...value.devDependencies },
            name,
          ),
        )
        .sort();
    assert.deepEqual(selectedSupport(root), [
      '@effect/opentelemetry',
      '@tanstack/react-router',
      'rsbuild-plugin-dts',
      'solid-js',
    ]);
    assert.deepEqual(
      selectedSupport(manifest),
      renderer === 'react'
        ? [
            '@effect/opentelemetry',
            '@tanstack/react-router',
            'rsbuild-plugin-dts',
            'solid-js',
          ]
        : ['@effect/opentelemetry', 'rsbuild-plugin-dts', 'solid-js'],
    );
    assert.doesNotThrow(() =>
      assertWorkspaceRootToolingDependencies(root, rootRenderer),
    );
    assert.doesNotThrow(() => assertRendererDependencies(manifest, renderer));
    for (const name of ['effect', '@effect/opentelemetry'])
      if (Object.hasOwn(manifest.dependencies, name))
        assert.equal(manifest.devDependencies[name], undefined);

    const shared = JSON.parse(
      JSON.stringify(
        createSharedPackage(
          'support-proof',
          'shared-contracts',
          'Contracts',
          source,
          renderer === 'none' ? 'react' : renderer,
        ),
      ),
    );
    assert.deepEqual(
      selectedSupport(shared),
      renderer === 'react' || renderer === 'none'
        ? ['@effect/opentelemetry', 'rsbuild-plugin-dts']
        : [],
    );
    if (renderer === 'react' || renderer === 'none') {
      assert.deepEqual(readSupportArtifacts(shared), supportArtifacts);
      assert.equal(
        shared.dependencies['@effect/opentelemetry'],
        supportArtifacts.packages['@effect/opentelemetry'].request,
      );
      assert.equal(
        shared.devDependencies['rsbuild-plugin-dts'],
        supportArtifacts.packages['rsbuild-plugin-dts'].request,
      );
    }
    const tokens = JSON.parse(
      JSON.stringify(
        createSharedPackage(
          'support-proof',
          'shared-design-tokens',
          'Tokens',
          source,
          renderer,
        ),
      ),
    );
    assert.deepEqual(selectedSupport(tokens), []);

    for (const group of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const wrongGroup = structuredClone(root);
      const request = wrongGroup.devDependencies['solid-js'];
      delete wrongGroup.devDependencies['solid-js'];
      wrongGroup[group] = { ...wrongGroup[group], 'solid-js': request };
      assert.throws(
        () => assertWorkspaceRootToolingDependencies(wrongGroup, rootRenderer),
        /tooling host solid-js/u,
      );
    }
    const wrongUrl = structuredClone(manifest);
    wrongUrl.devDependencies['rsbuild-plugin-dts'] =
      'https://example.com/dts.tgz';
    assert.throws(
      () => assertRendererDependencies(wrongUrl, renderer),
      /tooling host rsbuild-plugin-dts/u,
    );
    const foreign =
      renderer === 'solid' ? '@tanstack/react-router' : 'solid-js';
    const foreignRuntime = structuredClone(manifest);
    foreignRuntime.dependencies[foreign] =
      supportArtifacts.packages[foreign].request;
    assert.throws(
      () => assertRendererDependencies(foreignRuntime, renderer),
      /foreign renderer package/u,
    );
    const arbitraryHost = structuredClone(manifest);
    arbitraryHost.devDependencies['foreign-ui'] =
      `npm:${foreign}@${supportArtifacts.packages[foreign].version}`;
    assert.throws(
      () => assertRendererDependencies(arbitraryHost, renderer),
      /foreign renderer package/u,
    );
    arbitraryHost.devDependencies['foreign-ui'] = 'catalog:foreign';
    assert.throws(
      () =>
        assertRendererDependencies(arbitraryHost, renderer, undefined, {
          catalogs: {
            foreign: {
              'foreign-ui': `npm:${foreign}@${supportArtifacts.packages[foreign].version}`,
            },
          },
        }),
      /foreign renderer package/u,
    );
  },
);

test('installed optional peers require direct physical hosts; development owners do not', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'support-peer-bundle-'),
  );
  const write = (relative: string, manifest: unknown) => {
    const filename = path.join(directory, relative, 'package.json');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(manifest));
  };
  try {
    const support = parseSupportArtifacts(descriptor());
    write('.', {
      name: '@modern-js/ultramodern-create',
      dependencies: {
        '@modern-js/fixture-tools': 'workspace:*',
        '@modern-js/fixture-renderer': 'workspace:*',
      },
    });
    write('node_modules/@modern-js/fixture-tools', {
      name: '@modern-js/fixture-tools',
      peerDependencies: {
        '@modern-js/fixture-renderer': 'workspace:*',
        'rsbuild-plugin-dts': '1.0.7',
      },
      peerDependenciesMeta: {
        '@modern-js/fixture-renderer': { optional: true },
      },
      devDependencies: { '@modern-js/test-tools': 'workspace:*' },
      ultramodern: { supportArtifacts: support },
    });
    write('node_modules/@modern-js/fixture-renderer', {
      name: '@modern-js/fixture-renderer',
      peerDependencies: { 'solid-js': '2.0.0-rc.22' },
      ultramodern: { supportArtifacts: support },
    });
    write('node_modules/@modern-js/test-tools', {
      name: '@modern-js/test-tools',
      peerDependencies: { '@rstest/core': '0.12.6' },
    });
    const direct = { '@modern-js/fixture-tools': 'workspace:*' };
    const manifests = readBundledFrameworkManifests(directory);
    assert.deepEqual(toolingSupportDependencies(direct, support, manifests), {
      'rsbuild-plugin-dts': support.packages['rsbuild-plugin-dts'].request,
      'solid-js': support.packages['solid-js'].request,
    });
    const require = createRequire(
      path.join(
        directory,
        'node_modules/@modern-js/fixture-tools/package.json',
      ),
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          require.resolve('@modern-js/fixture-renderer/package.json'),
          'utf8',
        ),
      ).peerDependencies['solid-js'],
      '2.0.0-rc.22',
    );
    for (const name of ['solid-js', 'rsbuild-plugin-dts'] as const) {
      write(`node_modules/${name}`, {
        name,
        version: support.packages[name].version,
        main: './index.js',
      });
      fs.writeFileSync(
        path.join(directory, 'node_modules', name, 'index.js'),
        '',
      );
    }
    const consumer = {
      name: '@synthetic/app',
      ultramodern: { supportArtifacts: support },
      devDependencies: {
        ...direct,
        'rsbuild-plugin-dts': support.packages['rsbuild-plugin-dts'].request,
      },
    };
    write('app', consumer);
    const authenticationBoundary = new Error('reached archive authentication');
    let authenticationCalls = 0;
    const verify = () =>
      verifySupportConsumer({
        root: path.join(directory, 'app'),
        descriptor: support,
        readGithub: async () => {
          authenticationCalls++;
          throw authenticationBoundary;
        },
        fetchArtifact: async () => {
          authenticationCalls++;
          throw authenticationBoundary;
        },
      });
    await assert.rejects(
      verify,
      /solid-js: owner closure requires a selected direct host/u,
    );
    assert.equal(authenticationCalls, 0);
    write('app', {
      ...consumer,
      devDependencies: {
        ...consumer.devDependencies,
        ...toolingSupportDependencies(direct, support, manifests),
      },
    });
    await assert.rejects(verify, error => error === authenticationBoundary);
    assert.ok(
      authenticationCalls > 0,
      'The exact direct hosts must pass the unmodified installed-graph gate',
    );
    write('node_modules/@modern-js/fixture-duplicate', {
      name: '@modern-js/fixture-duplicate',
      peerDependencies: { 'solid-js': '2.0.0-rc.22' },
      ultramodern: { supportArtifacts: support },
    });
    write('node_modules/@modern-js/fixture-duplicate/node_modules/solid-js', {
      name: 'solid-js',
      version: '2.0.0-rc.22',
      main: './index.js',
    });
    fs.writeFileSync(
      path.join(
        directory,
        'node_modules/@modern-js/fixture-duplicate/node_modules/solid-js/index.js',
      ),
      '',
    );
    write('node_modules/@modern-js/fixture-tools', {
      name: '@modern-js/fixture-tools',
      peerDependencies: {
        '@modern-js/fixture-duplicate': 'workspace:*',
        'rsbuild-plugin-dts': '1.0.7',
      },
      peerDependenciesMeta: {
        '@modern-js/fixture-duplicate': { optional: true },
      },
      ultramodern: { supportArtifacts: support },
    });
    await assert.rejects(
      verify,
      /wrong physical peer \/ duplicate support correction/u,
    );
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: '@modern-js/ultramodern-create',
        dependencies: { '@modern-js/fixture-tools': 'workspace:*' },
      }),
    );
    assert.deepEqual(
      toolingSupportDependencies(
        direct,
        support,
        readBundledFrameworkManifests(directory),
      ),
      {
        'rsbuild-plugin-dts': support.packages['rsbuild-plugin-dts'].request,
      },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
    // Installed tooling owns peers even when this app does not compile a BFF.
    const emitted = JSON.parse(JSON.stringify({ root, importer }));
    for (const name of ['rsbuild-plugin-dts', '@effect/opentelemetry']) {
      for (const manifest of [emitted.root, emitted.importer])
        assert.equal(
          { ...manifest.devDependencies, ...manifest.dependencies }[name],
          supportArtifacts.packages[name].request,
        );
    }
    // The generator requires both native adapters and the React tooling.
    // Their runtime peers need root hosts independent of the app renderer.
    for (const name of ['solid-js', '@tanstack/react-router'])
      assert.equal(
        emitted.root.devDependencies[name],
        supportArtifacts.packages[name].request,
      );
    for (const name of ['@rstest/core', 'ioredis-mock', '@types/ioredis-mock'])
      assert.equal(emitted.root.devDependencies[name], undefined);
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
