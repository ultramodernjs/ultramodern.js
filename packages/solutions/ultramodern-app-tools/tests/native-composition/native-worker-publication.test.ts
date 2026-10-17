import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RendererBuildIdentities } from '@modern-js/app-tools-extensions/renderer-build-identity';
import type { RendererFederationCompatibility } from '@modern-js/federation-runtime/renderer-contract';
import type {
  NativeCompilerArtifactContext,
  NativeCompilerArtifacts,
} from '@modern-js/renderer-core/adapter';
import { readRendererIdentity } from '@modern-js/renderer-core/identity';
import { type Rspack, rspack } from '@rsbuild/core';
import { afterEach, describe, expect, it } from '@rstest/core';
import { createNativeWorkerFederationPlan } from '../../src/native-composition/native-worker-federation';
import {
  NativeWorkerFederationPublicationPlugin,
  nativeWorkerFederationManifestUrl,
} from '../../src/native-composition/native-worker-publication';

const compatibility: RendererFederationCompatibility = {
  profile: {
    renderer: 'octane',
    protocolVersion: 1,
    compiler: { name: '@octanejs/rspack-plugin', version: '0.2.4' },
    hydration: { name: 'octane', version: '0.13.8' },
    router: {
      name: '@octanejs/tanstack-router',
      version: '0.2.10',
      coreName: '@tanstack/router-core',
      coreVersion: '1.171.34',
    },
  },
  runtime: { name: 'octane', version: '0.13.8' },
  bootstrap: { name: '@modern-js/renderer-octane', version: '3.8.3' },
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function reverseObjectKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  );
}

async function compile(
  options: {
    staleClientHash?: boolean;
    missingClientArtifact?: boolean;
    missingPublication?: boolean;
    duplicatePublication?: boolean;
    reorderedRenderer?: boolean;
    conflictingRenderer?: boolean;
    publicPath?: string;
    manifestAssetName?: string;
  } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'native-worker-publication-'),
  );
  directories.push(directory);
  fs.writeFileSync(
    path.join(directory, 'entry.mjs'),
    'export const value = 1;',
  );
  const buildId = 'a'.repeat(64);
  const identities: RendererBuildIdentities = {
    buildId,
    profileKey: 'b'.repeat(64),
    sourceRevision: 'workspace',
    identities: {
      main: {
        renderer: 'octane',
        protocolVersion: 1,
        appId: 'catalog',
        entryName: 'main',
        buildId,
      },
    },
    routerBindings: {},
  };
  const plan = createNativeWorkerFederationPlan({
    authored: {
      name: 'catalog_remote',
      exposes: { './Widget': './entry.mjs' },
    },
    appDirectory: directory,
    remote: 'vertical-catalog',
    exposeEntryNames: { './Widget': 'main' },
    fragments: [
      {
        remote: 'vertical-catalog',
        expose: './Widget',
        boundaryId: 'catalog_remote',
        paths: { default: '/_mf/fragment/widget' },
      },
    ],
    compatibility,
    identities,
  });
  const validationContexts: NativeCompilerArtifactContext[] = [];
  const artifacts: NativeCompilerArtifacts = {
    clientManifestFile: entryName => `fixture-native-client.${entryName}.json`,
    async validateClientManifest(value, identity, context) {
      validationContexts.push(context);
      if (
        !value ||
        typeof value !== 'object' ||
        !('identity' in value) ||
        !('hydrationBuildId' in value)
      )
        throw new Error('fixture native client artifact is incomplete');
      readRendererIdentity(value.identity, identity);
      if (value.hydrationBuildId !== context.compilationHash)
        throw new Error(
          'fixture native publisher hash differs from the CLIENT compilation',
        );
      if (typeof value.hydrationBuildId !== 'string')
        throw new Error('fixture native publisher hash is missing');
      return {
        nativeManifest: value,
        hydrationBuildId: value.hydrationBuildId,
      };
    },
    isMutableDevelopmentAsset: () => false,
  };
  const output = path.join(directory, 'dist');
  const compiler = rspack({
    context: directory,
    mode: 'none',
    target: 'webworker',
    entry: './entry.mjs',
    output: { path: output, filename: 'main.js' },
    optimization: { minimize: false },
    plugins: [
      {
        apply(compiler: Rspack.Compiler) {
          compiler.hooks.thisCompilation.tap(
            'FixtureNativeArtifactProducer',
            compilation => {
              compilation.hooks.processAssets.tap(
                {
                  name: 'FixtureNativeArtifactProducer',
                  stage:
                    compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT +
                    1,
                },
                () => {
                  if (!options.missingClientArtifact)
                    compilation.emitAsset(
                      artifacts.clientManifestFile('main'),
                      new compiler.webpack.sources.RawSource(
                        JSON.stringify({
                          identity: plan.renderer.identities.main,
                          hydrationBuildId: options.staleClientHash
                            ? 'stale-client-compilation'
                            : compilation.hash,
                        }),
                      ),
                    );
                  if (!options.missingPublication) {
                    const renderer = options.conflictingRenderer
                      ? {
                          ...plan.renderer,
                          identities: {
                            main: {
                              ...plan.renderer.identities.main,
                              buildId: 'c'.repeat(64),
                            },
                          },
                        }
                      : options.reorderedRenderer
                        ? reverseObjectKeys(plan.renderer)
                        : plan.renderer;
                    compilation.emitAsset(
                      options.manifestAssetName ?? 'mf-manifest.json',
                      new compiler.webpack.sources.RawSource(
                        JSON.stringify({
                          metaData: {
                            publicPath:
                              options.publicPath ??
                              'https://catalog.example/client/',
                            ultramodernRenderer: renderer,
                            ...(options.duplicatePublication
                              ? { ultramodernWorkerFederation: {} }
                              : {}),
                          },
                        }),
                      ),
                    );
                  }
                },
              );
            },
          );
        },
      },
      new NativeWorkerFederationPublicationPlugin(() => plan, artifacts),
    ],
  });
  let emitted = false;
  compiler.hooks.emit.tap('FixtureEmissionProbe', () => {
    emitted = true;
  });
  try {
    const result = await new Promise<{
      error: Error | null;
      stats?: Rspack.Stats;
    }>(resolve => {
      compiler.run((error, stats) => resolve({ error, stats }));
    });
    return { ...result, emitted, output, plan, validationContexts };
  } finally {
    await new Promise<void>((resolve, reject) =>
      compiler.close(error => (error ? reject(error) : resolve())),
    );
  }
}

describe('native Worker client publication emission', () => {
  it('binds the validated native CLIENT hash after artifacts finish, independent of renderer source identity', async () => {
    const result = await compile();
    expect(result.error).toBeNull();
    if (!result.stats) throw new Error('client compilation has no stats');
    expect(result.stats.hasErrors()).toBe(false);
    expect(result.emitted).toBe(true);
    expect(result.validationContexts).toEqual([
      {
        compilationHash: result.stats.compilation.hash,
        development: false,
      },
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.output, 'mf-manifest.json'), 'utf8'),
    );
    const native =
      manifest.metaData.ultramodernWorkerFederation.exposes['./Widget'].native;
    expect(native).toEqual({
      publisherBuildId: result.stats.compilation.hash,
      runtimeABI: 1,
    });
    expect(native.publisherBuildId).not.toBe(
      result.plan.renderer.identities.main.buildId,
    );
    expect(manifest.metaData.ultramodernRenderer).toEqual(result.plan.renderer);
  });

  it('accepts equivalent canonical renderer metadata with reordered object fields', async () => {
    const result = await compile({ reorderedRenderer: true });
    expect(result.error).toBeNull();
    expect(result.stats?.hasErrors()).toBe(false);
    expect(result.emitted).toBe(true);
  });

  it('derives deployment authority from the completed emitted MF public path and actual asset name', async () => {
    const assetName = 'manifests/catalog-mf.json';
    const result = await compile({
      publicPath: 'https://completed.example/releases/catalog/',
      manifestAssetName: assetName,
    });
    expect(result.error).toBeNull();
    expect(result.emitted).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.output, assetName), 'utf8'),
    );
    expect(nativeWorkerFederationManifestUrl(assetName, manifest)).toBe(
      'https://completed.example/releases/catalog/manifests/catalog-mf.json',
    );
  });

  it.each([
    {
      options: { staleClientHash: true },
      reason: 'publisher hash differs from the CLIENT compilation',
    },
    {
      options: { missingClientArtifact: true },
      reason: 'completed client artifact for main',
    },
    {
      options: { missingPublication: true },
      reason: 'finalized Module Federation manifest publication',
    },
    {
      options: { duplicatePublication: true },
      reason: 'duplicate metadata ownership',
    },
    {
      options: { conflictingRenderer: true },
      reason: 'finalized renderer contract',
    },
  ])(
    'rejects invalid publication before emission: $reason',
    async ({ options, reason }) => {
      const result = await compile(options);
      const failure =
        result.error?.message ??
        result.stats?.toString({ all: false, errors: true }) ??
        '';
      expect(failure).toContain(reason);
      expect(result.emitted).toBe(false);
      expect(fs.existsSync(result.output)).toBe(false);
    },
  );
});

describe('native Worker finalized manifest URL', () => {
  it.each([
    {
      publicPath: 'https://catalog.example',
      assetName: 'mf-manifest.json',
      expected: 'https://catalog.example/mf-manifest.json',
    },
    {
      publicPath: 'https://catalog.example/',
      assetName: 'mf-manifest.json',
      expected: 'https://catalog.example/mf-manifest.json',
    },
    {
      publicPath: 'https://catalog.example/releases/catalog',
      assetName: 'catalog-mf.json',
      expected: 'https://catalog.example/releases/catalog/catalog-mf.json',
    },
    {
      publicPath: 'https://catalog.example/releases/catalog/',
      assetName: 'federation/catalog-mf.json',
      expected:
        'https://catalog.example/releases/catalog/federation/catalog-mf.json',
    },
  ])(
    'combines the emitted $publicPath directory and $assetName',
    ({ publicPath, assetName, expected }) => {
      expect(
        nativeWorkerFederationManifestUrl(assetName, {
          metaData: { publicPath },
        }),
      ).toBe(expected);
    },
  );

  it.each([
    undefined,
    null,
    {},
    { metaData: undefined },
    { metaData: {} },
    { metaData: { publicPath: undefined } },
    { metaData: { publicPath: 1 } },
  ])('rejects a missing completed MF public path: %j', manifest => {
    expect(() =>
      nativeWorkerFederationManifestUrl('mf-manifest.json', manifest),
    ).toThrow('completed MF public path');
  });

  it.each([
    '',
    'auto',
    '/client/',
    '//catalog.example/client/',
    'file:///client/',
    'https://user:secret@catalog.example/client/',
    'https://catalog.example/client/#other',
    'https://catalog.example/client?revision=one',
    'https://catalog.example/client/?revision=one',
  ])('rejects relative or unsafe emitted public paths: %s', publicPath => {
    expect(() =>
      nativeWorkerFederationManifestUrl('mf-manifest.json', {
        metaData: { publicPath },
      }),
    ).toThrow();
  });

  it.each([
    '',
    '/mf-manifest.json',
    '../mf-manifest.json',
    'federation/../mf-manifest.json',
    'federation/%2e%2e/mf-manifest.json',
    'federation/%252e%252e/mf-manifest.json',
    'federation\\mf-manifest.json',
    'mf-manifest.json?other',
    'mf-manifest.json#other',
    'https://foreign.example/mf-manifest.json',
  ])('rejects unsafe or missing compiler asset paths: %s', assetName => {
    expect(() =>
      nativeWorkerFederationManifestUrl(assetName, {
        metaData: { publicPath: 'https://catalog.example/client/' },
      }),
    ).toThrow();
  });
});
