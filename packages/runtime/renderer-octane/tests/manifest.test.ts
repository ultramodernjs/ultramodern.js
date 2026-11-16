import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { describe, expect, test } from '@rstest/core';
import {
  OCTANE_COMPILER_VERSION,
  OCTANE_RUNTIME_VERSION,
  validateOctaneModuleManifest,
} from '../src/manifest';
import { octaneProfile } from '../src/plugin/profile';

const identity: RendererIdentity = {
  renderer: 'octane',
  appId: 'store',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'source-profile-build-a',
};
const nativeHydrationBuildId = 'native-client-compilation-b';
const emittedSourceSha256 = 'b'.repeat(64);
const assetSha256 = 'c'.repeat(64);

function createSource() {
  return {
    resource: 'src/App.tsrx',
    canonicalId: 'store:src/App.tsrx',
    moduleId: './src/App.tsrx',
    transformKind: 'compile' as const,
    emittedSourceSha256,
    assets: ['static/js/main.js'],
  };
}

function createManifest() {
  return {
    schemaVersion: 1 as const,
    renderer: 'octane' as const,
    runtimeVersion: OCTANE_RUNTIME_VERSION,
    compilerVersion: OCTANE_COMPILER_VERSION,
    rendererIdentity: { ...identity },
    nativeHydrationBuildId,
    sourceModules: [createSource()],
    assets: [{ file: 'static/js/main.js', sha256: assetSha256 }],
  };
}

describe('Octane compiler manifest admission', () => {
  test('pins the ABI of the native runtime and compiler that applications install', () => {
    expect(OCTANE_RUNTIME_VERSION).toBe(octaneProfile.hydration.version);
    expect(OCTANE_COMPILER_VERSION).toBe(octaneProfile.compiler.version);
  });

  test('authenticates native compilation separately from the source/profile build', () => {
    const input = createManifest();
    const admitted = validateOctaneModuleManifest(
      input,
      identity,
      nativeHydrationBuildId,
    );
    expect(admitted).toEqual(input);
    expect(admitted.rendererIdentity.buildId).toBe('source-profile-build-a');
    expect(admitted.nativeHydrationBuildId).toBe('native-client-compilation-b');
    expect(validateOctaneModuleManifest(input, identity)).toBe(admitted);
    expect(validateOctaneModuleManifest(admitted, identity)).toBe(admitted);
    expect(() =>
      validateOctaneModuleManifest(admitted, {
        ...identity,
        buildId: 'another-source-build',
      }),
    ).toThrow('conflicts with the application build');
    expect(() =>
      validateOctaneModuleManifest(input, identity, identity.buildId),
    ).toThrow('native hydration build differs from the compiled client');
    expect(() =>
      validateOctaneModuleManifest(input, identity, 'another-native-build'),
    ).toThrow('native hydration build differs from the compiled client');
  });

  test('admits external native sources and the released compiler transform kinds', () => {
    const input = {
      ...createManifest(),
      sourceModules: [
        createSource(),
        {
          ...createSource(),
          resource: '../node_modules/octane/src/slots.tsrx?native',
          canonicalId: 'octane:slots',
          moduleId: 42,
          transformKind: 'slots',
        },
        {
          ...createSource(),
          resource: 'src/client-only.tsx',
          canonicalId: 'store:client-only',
          transformKind: 'client-only-stub',
        },
      ],
    };
    expect(
      validateOctaneModuleManifest(input, identity, nativeHydrationBuildId),
    ).toEqual(input);
  });

  test.each([
    ['schema version', { schemaVersion: 2 }],
    ['renderer', { renderer: 'solid' }],
    ['runtime pin', { runtimeVersion: '0.7.2' }],
    ['compiler pin', { compilerVersion: '0.1.56' }],
  ])('rejects a conflicting %s', (_name, conflict) => {
    expect(() =>
      validateOctaneModuleManifest(
        { ...createManifest(), ...conflict },
        identity,
      ),
    ).toThrow('compiler manifest ABI conflicts with the application');
  });

  test.each([
    ['application', { appId: 'another-app' }],
    ['entry', { entryName: 'admin' }],
    ['source/profile build', { buildId: 'another-source-profile-build' }],
  ])('rejects a conflicting %s identity', (_name, conflict) => {
    expect(() =>
      validateOctaneModuleManifest(
        {
          ...createManifest(),
          rendererIdentity: { ...identity, ...conflict },
        },
        identity,
      ),
    ).toThrow('Renderer identity conflicts with the application build');
  });

  // Identity record validation is covered by renderer-core's identity tests.
  test('rejects an invalid application identity before admitting a compiler envelope', () => {
    expect(() =>
      validateOctaneModuleManifest(createManifest(), {
        ...identity,
        renderer: 'solid',
      }),
    ).toThrow('Octane renderer identity');
  });

  test.each([undefined, null, '', '   ', 42])(
    'rejects a missing or invalid native compilation identity %s',
    invalid => {
      expect(() =>
        validateOctaneModuleManifest(
          { ...createManifest(), nativeHydrationBuildId: invalid },
          identity,
        ),
      ).toThrow('native client compilation identity');
    },
  );

  test.each(['', '   '])(
    'rejects an empty expected native identity %s',
    invalid => {
      expect(() =>
        validateOctaneModuleManifest(createManifest(), identity, invalid),
      ).toThrow('native client compilation identity');
    },
  );

  test.each([
    ['envelope', { ...createManifest(), extra: true }],
    [
      'source',
      {
        ...createManifest(),
        sourceModules: [{ ...createSource(), extra: true }],
      },
    ],
    [
      'asset',
      {
        ...createManifest(),
        assets: [
          { file: 'static/js/main.js', sha256: assetSha256, extra: true },
        ],
      },
    ],
  ])('rejects unknown %s fields', (_name, input) => {
    expect(() => validateOctaneModuleManifest(input, identity)).toThrow(
      'unknown field',
    );
  });

  test.each([
    ['null', null],
    ['array', []],
    ['string', 'manifest'],
  ])('rejects a malformed %s envelope', (_name, input) => {
    expect(() => validateOctaneModuleManifest(input, identity)).toThrow(
      'Malformed Octane compiler manifest object',
    );
  });

  test.each([
    ['source', { ...createManifest(), sourceModules: [null] }],
    ['asset', { ...createManifest(), assets: [[]] }],
  ])('rejects a malformed %s record', (_name, input) => {
    expect(() => validateOctaneModuleManifest(input, identity)).toThrow(
      'Malformed Octane compiler manifest object',
    );
  });

  test.each([
    ['assets', []],
    ['assets', undefined],
    ['sourceModules', []],
    ['sourceModules', undefined],
  ])('rejects absent %s provenance', (field, value) => {
    expect(() =>
      validateOctaneModuleManifest(
        { ...createManifest(), [field]: value },
        identity,
      ),
    ).toThrow(/no emitted JavaScript closure|no authenticated native sources/);
  });

  test.each([
    '/main.js',
    'static\\main.js',
    '../main.js',
    'static/../main.js',
    './main.js',
    'static//main.js',
    'main.css',
    'main.js\0',
  ])('rejects an unsafe emitted asset path %s', file => {
    expect(() =>
      validateOctaneModuleManifest(
        { ...createManifest(), assets: [{ file, sha256: assetSha256 }] },
        identity,
      ),
    ).toThrow('Invalid Octane emitted asset digest');
  });

  test.each([
    '',
    'A'.repeat(64),
    'g'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
  ])('rejects an invalid SHA-256 digest %s', sha256 => {
    expect(() =>
      validateOctaneModuleManifest(
        {
          ...createManifest(),
          assets: [{ file: 'static/js/main.js', sha256 }],
        },
        identity,
      ),
    ).toThrow('Invalid Octane emitted asset digest');
    expect(() =>
      validateOctaneModuleManifest(
        {
          ...createManifest(),
          sourceModules: [{ ...createSource(), emittedSourceSha256: sha256 }],
        },
        identity,
      ),
    ).toThrow('Invalid Octane native source-to-asset provenance');
  });

  test('rejects duplicate emitted assets and duplicate source resources', () => {
    const input = createManifest();
    expect(() =>
      validateOctaneModuleManifest(
        { ...input, assets: [...input.assets, ...input.assets] },
        identity,
      ),
    ).toThrow('Invalid Octane emitted asset digest');
    expect(() =>
      validateOctaneModuleManifest(
        { ...input, sourceModules: [createSource(), createSource()] },
        identity,
      ),
    ).toThrow('Invalid Octane native source-to-asset provenance');
  });

  test.each([
    ['absolute resource', { resource: '/src/App.tsrx' }],
    ['backslash resource', { resource: 'src\\App.tsrx' }],
    ['empty resource', { resource: '' }],
    ['NUL resource', { resource: 'src/App.tsrx\0' }],
    ['empty canonical identity', { canonicalId: '   ' }],
    ['empty module identity', { moduleId: '' }],
    ['nonfinite module identity', { moduleId: Number.NaN }],
    ['object module identity', { moduleId: {} }],
    ['unknown transform', { transformKind: 'transpile' }],
    ['empty asset references', { assets: [] }],
    ['undeclared asset reference', { assets: ['static/js/other.js'] }],
    ['nonstring asset reference', { assets: [42] }],
    [
      'duplicate asset references',
      { assets: ['static/js/main.js', 'static/js/main.js'] },
    ],
  ])('rejects invalid source provenance with %s', (_name, invalid) => {
    expect(() =>
      validateOctaneModuleManifest(
        {
          ...createManifest(),
          sourceModules: [{ ...createSource(), ...invalid }],
        },
        identity,
      ),
    ).toThrow('Invalid Octane native source-to-asset provenance');
  });

  test('returns a deeply frozen clone immune to caller mutation', () => {
    const input = createManifest();
    const expected = createManifest();
    const admitted = validateOctaneModuleManifest(input, identity);
    expect(admitted).not.toBe(input);
    expect(admitted.rendererIdentity).not.toBe(input.rendererIdentity);
    expect(admitted.sourceModules).not.toBe(input.sourceModules);
    expect(admitted.sourceModules[0]).not.toBe(input.sourceModules[0]);
    expect(admitted.sourceModules[0].assets).not.toBe(
      input.sourceModules[0].assets,
    );
    expect(admitted.assets).not.toBe(input.assets);
    expect(admitted.assets[0]).not.toBe(input.assets[0]);
    for (const value of [
      admitted,
      admitted.rendererIdentity,
      admitted.sourceModules,
      admitted.sourceModules[0],
      admitted.sourceModules[0].assets,
      admitted.assets,
      admitted.assets[0],
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }

    input.rendererIdentity.buildId = 'tampered-source-build';
    input.nativeHydrationBuildId = 'tampered-native-build';
    input.sourceModules[0].resource = 'tampered.tsrx';
    input.sourceModules[0].assets.push('tampered.js');
    input.sourceModules.push(createSource());
    input.assets[0].file = 'tampered.js';
    input.assets[0].sha256 = 'e'.repeat(64);
    input.assets.push({ file: 'extra.js', sha256: assetSha256 });
    expect(admitted).toEqual(expected);
  });
});
