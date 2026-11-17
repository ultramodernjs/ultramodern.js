import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as nativeProtocol from '../../../../scripts/ultramodern-renderers/native-artifacts/protocol.mjs';
import {
  inputs,
  supportProtocol,
} from '../../../../scripts/ultramodern-support-artifacts/protocol.mjs';
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
  type NativeArtifacts,
  parseNativeArtifacts,
  parseSupportArtifacts,
  readNativeArtifacts,
  resolvePackageSource,
  selectNativeCoreRequest,
} from '../src/ultramodern-workspace/package-source';
import { getRendererGenerationProfile } from '../src/ultramodern-workspace/renderer-profile';
import type {
  ResolvedPackageSource,
  WorkspaceApp,
} from '../src/ultramodern-workspace/types';
import {
  assertRendererDependencies,
  assertWorkspaceRootToolingDependencies,
} from '../src/ultramodern-workspace/validation/renderer';

const core = '@tanstack/router-core';

// Synthetic authorities only; no production URL or descriptor is activated.
function nativeDescriptor(seed = 'f'): NativeArtifacts {
  const producer = {
    repository: nativeProtocol.repository,
    repositoryId: nativeProtocol.repositoryId,
    workflow: nativeProtocol.workflow,
    source: seed.repeat(40),
    runId: 7,
    runAttempt: 1,
    tag: `native-renderers-${seed.repeat(40)}-7-1`,
  };
  return nativeProtocol.descriptorFor({
    protocol: nativeProtocol.protocol,
    producer,
    packages: Object.fromEntries(
      Object.entries(nativeProtocol.cohort).map(([name, version]) => [
        name,
        {
          version,
          request: nativeProtocol.releaseUrl(
            producer,
            nativeProtocol.assetFilename(name, version),
          ),
          integrity: nativeProtocol.integrity(Buffer.from(`${seed}${name}`)),
          upstream: {
            request: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
            integrity: nativeProtocol.integrity(Buffer.from(name)),
            repository: 'unit/control',
            commit: 'b'.repeat(40),
            sourceArchiveIntegrity: nativeProtocol.integrity(
              Buffer.from('source'),
            ),
            licenseSha256: 'c'.repeat(64),
          },
          patchSha256: 'd'.repeat(64),
        },
      ]),
    ),
  });
}

function supportDescriptor() {
  const source = 'a'.repeat(40);
  const producer = {
    repository: supportProtocol.repository,
    repositoryId: supportProtocol.repositoryId,
    workflow: supportProtocol.workflow,
    source,
    runId: 1,
    runAttempt: 1,
    tag: `support-artifacts-${source}-1-1`,
  };
  return parseSupportArtifacts(
    supportProtocol.descriptorFor({
      protocol: supportProtocol.protocol,
      producer,
      packages: Object.fromEntries(
        Object.entries(supportProtocol.cohort).map(([name, version]) => [
          name,
          {
            version,
            request: supportProtocol.releaseUrl(
              producer,
              supportProtocol.assetFilename(name, version),
            ),
            integrity: supportProtocol.integrity(Buffer.from(name)),
            upstream: inputs[name].upstream,
            patchSha256: inputs[name].patchSha256,
          },
        ]),
      ),
    }),
  );
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const supportArtifacts = supportDescriptor();
// The script-side protocol validates; the runtime parser is under test.
const nativeArtifacts = nativeProtocol.validateDescriptor(
  nativeDescriptor(),
) as NativeArtifacts;
const pin = nativeArtifacts.packages[core];
const source = (
  strategy: ResolvedPackageSource['strategy'],
  native: NativeArtifacts | null = nativeArtifacts,
): ResolvedPackageSource => ({
  strategy,
  modernPackageVersion: 'workspace:*',
  supportArtifacts,
  ...(native ? { nativeArtifacts: native } : {}),
});
const remote = createVerticalDescriptor('catalog', 4101);
const uiRemote = createVerticalDescriptor('cart', 4102, { preset: 'ui-only' });
const apiOnly = createVerticalDescriptor('orders', 4103, {
  preset: 'api-only',
});
const react = getRendererGenerationProfile('react');

test.each(['workspace', 'install'] as const)(
  '%s React shell, remotes and root host the admitted native Core with its descriptor',
  strategy => {
    for (const app of [shellApp, remote, uiRemote]) {
      const manifest = json(
        createAppPackage('native-proof', app, source(strategy), false),
      );
      assert.equal(manifest.dependencies[core], pin.request, app.id);
      assert.equal(manifest.devDependencies[core], undefined, app.id);
      assert.deepEqual(readNativeArtifacts(manifest), nativeArtifacts);
      // Support pins and the exact TanStack adapter remain unchanged.
      assert.equal(
        manifest.dependencies['@tanstack/react-router'],
        supportArtifacts.packages['@tanstack/react-router'].request,
      );
      assert.deepEqual(manifest.ultramodern.supportArtifacts, supportArtifacts);
      assert.equal(
        manifest.dependencies['@modern-js/plugin-tanstack'],
        strategy === 'install' ? 'catalog:ultramodern' : 'workspace:*',
      );
      assert.doesNotThrow(() =>
        assertRendererDependencies(manifest, 'react', react),
      );
    }
    const root = json(
      createRootPackageJson('native-proof', source(strategy), [remote]),
    );
    assert.equal(root.devDependencies[core], pin.request);
    assert.deepEqual(readNativeArtifacts(root), nativeArtifacts);
    assert.doesNotThrow(() =>
      assertWorkspaceRootToolingDependencies(root, 'react'),
    );
  },
);

test('API-only units and shared packages install no Core peer owner and record no native authority', () => {
  for (const manifest of [
    createAppPackage('native-proof', apiOnly, source('workspace'), false),
    createSharedPackage(
      'native-proof',
      'shared-contracts',
      'Contracts',
      source('workspace'),
    ),
    createSharedPackage(
      'native-proof',
      'shared-design-tokens',
      'Tokens',
      source('workspace'),
    ),
  ].map(json)) {
    for (const group of ['dependencies', 'devDependencies'])
      assert.equal(manifest[group]?.[core], undefined, manifest.name);
    assert.equal(manifest.ultramodern?.nativeArtifacts, undefined);
    assert.doesNotThrow(() => assertRendererDependencies(manifest, 'none'));
  }
  const unrelated = json(
    createAppPackage('native-proof', apiOnly, source('workspace'), false),
  );
  unrelated.ultramodern.nativeArtifacts = nativeArtifacts;
  assert.throws(
    () => assertRendererDependencies(unrelated, 'none'),
    /records a native descriptor without an installed @tanstack\/router-core owner/u,
  );
});

test('without a native descriptor the React projection keeps its registry Core peer', () => {
  for (const app of [shellApp, remote]) {
    const manifest = json(
      createAppPackage('native-proof', app, source('workspace', null), false),
    );
    const withNative = json(
      createAppPackage('native-proof', app, source('workspace'), false),
    );
    delete withNative.dependencies[core];
    delete withNative.ultramodern.nativeArtifacts;
    assert.deepEqual(manifest, withNative);
    assert.deepEqual(manifest.ultramodern, { supportArtifacts });
    assert.doesNotThrow(() =>
      assertRendererDependencies(manifest, 'react', react),
    );
  }
  const root = json(
    createRootPackageJson('native-proof', source('workspace', null)),
  );
  assert.equal(root.devDependencies[core], undefined);
  assert.deepEqual(root.ultramodern, { supportArtifacts });
});

test('native renderer generations keep their own Core selection', () => {
  for (const renderer of ['octane', 'solid'] as const) {
    const app: WorkspaceApp = { ...shellApp, renderer };
    const generation = getRendererGenerationProfile(renderer);
    const manifest = json(
      createAppPackage('native-proof', app, source('workspace'), false),
    );
    assert.deepEqual(
      manifest,
      json(
        createAppPackage('native-proof', app, source('workspace', null), false),
      ),
    );
    assert.equal(manifest.dependencies[core], generation.dependencies[core]);
    assert.equal(manifest.ultramodern?.nativeArtifacts, undefined);
    const root = json(
      createRootPackageJson(
        'native-proof',
        source('workspace'),
        [],
        undefined,
        [],
        app,
      ),
    );
    assert.equal(root.devDependencies[core], pin.request);
    assert.deepEqual(readNativeArtifacts(root), nativeArtifacts);
    assert.doesNotThrow(() =>
      assertWorkspaceRootToolingDependencies(root, renderer),
    );
    delete root.devDependencies[core];
    delete root.ultramodern.nativeArtifacts;
    assert.deepEqual(
      root,
      json(
        createRootPackageJson(
          'native-proof',
          source('workspace', null),
          [],
          undefined,
          [],
          app,
        ),
      ),
    );
  }
});

test('invalid, mixed and unadmitted native Core authority is rejected', () => {
  for (const mutate of [
    (value: any) => delete value.packages[core],
    (value: any) => (value.packages.extra = value.packages[core]),
    (value: any) => (value.packages[core].version = '1.171.38'),
    (value: any) =>
      (value.packages[core].request = value.packages[core].request.replace(
        'native-renderers-',
        'support-artifacts-',
      )),
    (value: any) => (value.packages[core].upstream.extra = true),
    (value: any) =>
      (value.packages[core].upstream.request =
        'https://example.com/router-core.tgz'),
    (value: any) => (value.producer.workflow = supportProtocol.workflow),
    (value: any) => (value.protocol = 'ultramodern.native-artifacts.v2'),
    (value: any) =>
      (value.manifest.request = 'https://example.com/native.json'),
  ]) {
    const value = nativeDescriptor();
    mutate(value);
    assert.throws(() => parseNativeArtifacts(value));
  }
  assert.throws(() =>
    readNativeArtifacts({ ultramodern: { nativeArtifacts: null } }),
  );
  const foreign = nativeDescriptor('e').packages[core];
  assert.throws(
    () => selectNativeCoreRequest({ [core]: foreign.request }, nativeArtifacts),
    /differs from native descriptor/u,
  );
  assert.throws(
    () => selectNativeCoreRequest({ [core]: pin.request }, undefined),
    /requires native descriptor/u,
  );
  assert.deepEqual(selectNativeCoreRequest({ [core]: '1.171.39' }, undefined), {
    [core]: '1.171.39',
  });

  const emitted = json(
    createAppPackage('native-proof', shellApp, source('workspace'), false),
  );
  const registry = structuredClone(emitted);
  registry.dependencies[core] = pin.version;
  const mixed = structuredClone(emitted);
  mixed.dependencies[core] = foreign.request;
  const unrecorded = structuredClone(emitted);
  delete unrecorded.ultramodern.nativeArtifacts;
  const missing = structuredClone(emitted);
  delete missing.dependencies[core];
  for (const [manifest, message] of [
    [registry, /must use the exact native Core request/u],
    [mixed, /must use the exact native Core request|differs from native/u],
    [unrecorded, /requires native descriptor/u],
    [missing, /must host the admitted native @tanstack\/router-core/u],
  ] as const) {
    assert.throws(
      () => assertRendererDependencies(manifest, 'react', react),
      message,
    );
    assert.throws(() => assertRendererDependencies(manifest, 'react'));
  }
});

test('the shipped generator projects its admitted native Core into React consumers', () => {
  const require = createRequire(import.meta.url);
  const shipped = resolvePackageSource({
    targetDir: os.tmpdir(),
    packageName: 'native-proof',
    modernVersion: 'workspace:*',
    packageSource: { strategy: 'workspace' },
  });
  assert(
    shipped.nativeArtifacts,
    'generator manifest carries native authority',
  );
  const tanstack = JSON.parse(
    fs.readFileSync(
      require.resolve('@modern-js/plugin-tanstack/package.json'),
      'utf8',
    ),
  );
  // The adapter's exact peer is the descriptor version; consumers select its archive.
  assert.equal(
    tanstack.peerDependencies[core],
    shipped.nativeArtifacts.packages[core].version,
  );
  assert.equal(
    appDependencies('native-proof', shipped, shellApp)[core],
    shipped.nativeArtifacts.packages[core].request,
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-core-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify(createRootPackageJson('native-proof', shipped)),
    );
    assert.deepEqual(
      readWorkspacePackageSource(directory).nativeArtifacts,
      shipped.nativeArtifacts,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
