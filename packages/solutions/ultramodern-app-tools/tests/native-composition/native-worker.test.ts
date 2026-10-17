import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RendererIdentity } from '@modern-js/renderer-core';
import type { NativeCompilerArtifacts } from '@modern-js/renderer-core/adapter';
import { resolveRendererFederationCompatibility } from '../../src/native-composition/module-federation-renderer-plugin';
import {
  isNativeWorkerBuild,
  nativeWorkerEntrySource,
  nativeWorkerEnvironment,
  writeNativeWorkerResources,
} from '../../src/native-composition/native-worker';
import { createNativeWorkerFederationPlan } from '../../src/native-composition/native-worker-federation';

const identity: RendererIdentity = {
  renderer: 'solid',
  appId: 'native-worker',
  entryName: 'index',
  protocolVersion: 1,
  buildId: 'b'.repeat(64),
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true })),
  );
});

function compilerArtifacts(
  validated: { nativeManifest: unknown; hydrationBuildId?: string },
  calls: unknown[][] = [],
): NativeCompilerArtifacts {
  return {
    routerFrameworks: ['solid'],
    clientManifestFile: entryName => `fixture-manifest.${entryName}.json`,
    async validateClientManifest(...args) {
      calls.push(args);
      return validated;
    },
    isMutableDevelopmentAsset: () => false,
  };
}

async function distFixture() {
  const distDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'native-worker-resources-'),
  );
  directories.push(distDirectory);
  await fs.writeFile(
    path.join(distDirectory, 'renderer-assets.json'),
    JSON.stringify({
      schema: 'ultramodern-renderer-assets',
      version: 1,
      renderer: 'solid',
      entries: {
        index: {
          rendererIdentity: identity,
          assets: [{ kind: 'script', href: '/static/js/index.js' }],
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(distDirectory, 'fixture-manifest.index.json'),
    JSON.stringify({ compiled: true }),
  );
  return distDirectory;
}

describe('native Cloudflare worker build', () => {
  it('builds a worker only for the Cloudflare target with worker SSR', () => {
    expect(
      isNativeWorkerBuild({
        deploy: { target: 'cloudflare', worker: { ssr: true } },
      }),
    ).toBe(true);
    expect(isNativeWorkerBuild({ deploy: { target: 'cloudflare' } })).toBe(
      false,
    );
    expect(
      isNativeWorkerBuild({
        deploy: { target: 'node', worker: { ssr: true } },
      }),
    ).toBe(false);
  });

  it('re-exports the native handler with the worker dispatcher', () => {
    expect(nativeWorkerEntrySource('./index.server')).toBe(
      `export * from "./index.server";
export { dispatchNativeWorkerRequest } from '@modern-js/renderer-core/server';
`,
    );
  });

  it('keeps framework worker entries named like Object.prototype members', () => {
    const environment = nativeWorkerEnvironment(
      {
        source: {
          entry: {
            index: '/app/index.server.jsx',
            constructor: '/app/workers/constructor.ts',
            toString: '/app/workers/to-string.ts',
          },
        },
      },
      { index: '/generated/solid/index/index.worker.ts' },
    );
    expect(environment.source?.entry).toEqual({
      index: '/generated/solid/index/index.worker.ts',
      constructor: '/app/workers/constructor.ts',
      toString: '/app/workers/to-string.ts',
    });
  });

  it('replaces page entries, keeps framework worker entries and emits a web module', () => {
    const authored = () => undefined;
    const environment = nativeWorkerEnvironment(
      {
        output: { target: 'web-worker' },
        source: {
          entry: {
            index: '/app/index.server.jsx',
            __modern_bff_effect: '/app/api/index.ts?modern-bff-runtime',
          },
        },
        tools: { bundlerChain: authored },
      },
      { index: '/generated/solid/index/index.worker.ts' },
    );
    expect(environment.source?.entry).toEqual({
      index: '/generated/solid/index/index.worker.ts',
      __modern_bff_effect: '/app/api/index.ts?modern-bff-runtime',
    });
    expect(environment.output).toMatchObject({ target: 'web', module: true });
    expect(environment.tools?.htmlPlugin).toBe(false);
    const chains = environment.tools?.bundlerChain as unknown[];
    expect(chains).toHaveLength(2);
    expect(chains[1]).toBe(authored);
  });

  it('writes build-validated document inputs beside the worker bundle', async () => {
    const distDirectory = await distFixture();
    const calls: unknown[][] = [];
    await writeNativeWorkerResources({
      renderer: 'solid',
      distDirectory,
      clientOutputDirectory: distDirectory,
      metaName: 'modern-js',
      config: {
        server: { ssr: { mode: 'stream', forceCSR: true } as never },
        security: { nonce: 'fixture-nonce' },
      },
      identities: { index: identity },
      compilerArtifacts: compilerArtifacts(
        { nativeManifest: { validated: true }, hydrationBuildId: 'hydration' },
        calls,
      ),
      workerEntryFiles: { index: ['worker/index.js'] },
    });
    expect(calls).toEqual([
      [{ compiled: true }, identity, { development: false }],
    ]);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(distDirectory, 'worker/native-renderer.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      schema: 'ultramodern-native-worker-resources',
      version: 1,
      renderer: 'solid',
      entries: {
        index: {
          assets: [{ kind: 'script', href: '/static/js/index.js' }],
          nativeManifest: { validated: true },
          hydrationBuildId: 'hydration',
          serverConfig: { ssr: 'stream' },
          csrFallbackHeader: 'x-modern-ssr-fallback',
          nonce: 'fixture-nonce',
        },
      },
    });
  });

  it('binds completed Worker publication to the validated native client hash', async () => {
    const distDirectory = await distFixture();
    const plan = createNativeWorkerFederationPlan({
      authored: {
        name: 'nativeWorkerContainer',
        exposes: { './Widget': './Widget.tsx' },
      },
      appDirectory: distDirectory,
      remote: 'native-worker',
      exposeEntryNames: { './Widget': 'index' },
      fragments: [
        {
          remote: 'native-worker',
          expose: './Widget',
          boundaryId: 'nativeWorkerContainer',
          paths: { default: '/_mf/fragment/widget' },
        },
      ],
      compatibility: resolveRendererFederationCompatibility('solid'),
      identities: {
        identities: { index: identity },
        buildId: identity.buildId,
        profileKey: 'profile',
        sourceRevision: 'revision',
        routerBindings: {},
      },
    });
    const calls: unknown[][] = [];
    const options = {
      renderer: 'solid' as const,
      distDirectory,
      clientOutputDirectory: distDirectory,
      metaName: 'modern-js',
      config: { server: { ssr: true } },
      identities: { index: identity },
      compilerArtifacts: compilerArtifacts(
        {
          nativeManifest: { validated: true },
          hydrationBuildId: 'actual-client-hash',
        },
        calls,
      ),
      workerEntryFiles: { index: ['worker/index.js'] },
      workerFederation: {
        plan,
        services: [],
        manifestUrl: 'https://worker.example/mf-manifest.json',
      },
    };
    await expect(writeNativeWorkerResources(options)).rejects.toThrow(
      'completed client compilation',
    );
    await writeNativeWorkerResources({
      ...options,
      clientCompilationHash: 'actual-client-hash',
    });
    expect(calls[0]?.[2]).toEqual({
      development: false,
      compilationHash: 'actual-client-hash',
    });
    const resources = JSON.parse(
      await fs.readFile(
        path.join(distDirectory, 'worker/native-renderer.json'),
        'utf8',
      ),
    );
    expect(
      resources.workerFederation.worker.exposes['./Widget'].native,
    ).toEqual({ publisherBuildId: 'actual-client-hash', runtimeABI: 1 });
    expect(
      resources.workerFederation.worker.exposes['./Widget'].native
        .publisherBuildId,
    ).not.toBe(identity.buildId);
    expect(resources.workerFederation.renderer.identities.index).toEqual(
      identity,
    );
    expect(resources.workerFederationManifestUrl).toBe(
      'https://worker.example/mf-manifest.json',
    );
  });

  it.each([
    [[]],
    [['worker/other.js']],
    [['worker/index.js', 'worker/__modern_worker_shared.js']],
  ])('rejects a worker entry emitted as %j', async files => {
    const distDirectory = await distFixture();
    await expect(
      writeNativeWorkerResources({
        renderer: 'solid',
        distDirectory,
        clientOutputDirectory: distDirectory,
        metaName: 'modern-js',
        config: { server: { ssr: true } },
        identities: { index: identity },
        compilerArtifacts: compilerArtifacts({ nativeManifest: {} }),
        workerEntryFiles: { index: files },
      }),
    ).rejects.toThrow('must emit exactly worker/index.js');
    await expect(
      fs.stat(path.join(distDirectory, 'worker/native-renderer.json')),
    ).rejects.toThrow('ENOENT');
  });
});
