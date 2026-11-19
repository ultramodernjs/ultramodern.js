import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createUltramodernBuildArtifact,
  type DeliveryUnitRecord,
} from '@modern-js/backend-federation-contracts';
import { loadBackendFederatedEffectApiFromManifest } from '@modern-js/plugin-bff-extensions/backend-federation-manifest/node';
import { Effect, ManagedRuntime } from 'effect';
import { HttpApi } from 'effect/http-api';
import backendFederationBuildPlugin, {
  emitBackendFederationArtifacts,
} from '../../src/backend-federation-build';
import { findBackendFederationApp } from '../../src/backend-federation-build/config';
import {
  reactReleaseUi,
  uiBuildArtifactOptions,
} from '../renderer-release-fixture';

const temporaryDirectories: string[] = [];

const createTempDir = async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'modern-backend-mf-'),
  );
  temporaryDirectories.push(directory);
  return directory;
};

const writeJson = async (filePath: string, value: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const createBuildArtifact = (overrides: Record<string, unknown> = {}) => {
  const deliveryUnit: DeliveryUnitRecord = {
    schemaVersion: 1,
    kind: 'microvertical-delivery-unit',
    appId: 'explore',
    unitId: 'tractor-store-vertical-demo/explore',
    packageName: '@tractor-store-vertical-demo/explore',
    version: '0.1.0',
    sourceRevision: 'workspace',
    buildMarker: 'tractor-explore-build-1234',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    ...overrides,
  };

  return createUltramodernBuildArtifact(
    deliveryUnit,
    uiBuildArtifactOptions(deliveryUnit.buildMarker, deliveryUnit.appId),
  );
};

type WorkspaceOptions = {
  apiProtocol?: 'rest' | 'rpc';
  artifactOverrides?: Record<string, unknown>;
  backendBase?: string;
  topologyDeliveryUnit?: Record<string, unknown>;
  distName?: string;
  effectApiSource?: string;
  appId?: string;
  containerMinify?: unknown;
};

const createWorkspace = async ({
  apiProtocol = 'rest',
  artifactOverrides = {},
  backendBase = 'http://localhost:3021',
  topologyDeliveryUnit,
  distName = 'dist',
  effectApiSource = 'export const backendFederationContract = {};\n',
  appId = 'explore',
  containerMinify,
}: WorkspaceOptions = {}) => {
  const workspaceRoot = await createTempDir();
  const appDirectory = path.join(workspaceRoot, 'verticals/explore');
  const distDirectory = path.join(appDirectory, distName);
  await fs.mkdir(path.join(appDirectory, 'api'), { recursive: true });
  await fs.mkdir(path.join(appDirectory, 'shared'), { recursive: true });
  await fs.symlink(
    path.resolve(__dirname, '../../node_modules'),
    path.join(appDirectory, 'node_modules'),
    'dir',
  );
  await fs.writeFile(
    path.join(appDirectory, 'api/effect-api.ts'),
    effectApiSource,
  );
  await fs.writeFile(
    path.join(appDirectory, 'backend-federation.config.ts'),
    'export default {};\n',
  );
  await writeJson(
    path.join(appDirectory, 'shared/ultramodern-build.json'),
    createBuildArtifact(artifactOverrides),
  );
  await writeJson(path.join(appDirectory, 'package.json'), {
    name: '@tractor-store-vertical-demo/explore',
    version: '0.1.0',
    ...(containerMinify === undefined
      ? {}
      : { modernjs: { backendFederation: { containerMinify } } }),
  });
  await writeJson(
    path.join(workspaceRoot, 'topology/reference-topology.json'),
    {
      shell: { id: 'shell', kind: 'shell', path: 'shell' },
      verticals: [
        {
          id: appId,
          domain: 'explore',
          kind: 'vertical',
          package: '@tractor-store-vertical-demo/explore',
          path: 'verticals/explore',
          cloudflare: { publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_EXPLORE' },
          api: {
            bff: { prefix: '/explore-api' },
            ...(apiProtocol === 'rpc'
              ? {
                  protocol: 'rpc',
                  rpcPath: '/explore-api/rpc',
                  rpcSerialization: 'json',
                }
              : {}),
            stem: 'explore',
          },
          moduleFederation: {
            name: 'verticalExplore',
            manifestUrl: `${backendBase}/mf-manifest.json`,
          },
          backendFederation: {
            name: 'verticalExploreBackend',
            versionBoundary: {
              ui: { manifestUrl: `${backendBase}/mf-manifest.json` },
            },
            executionSurfaces: {
              node: {
                remoteName: 'verticalExploreBackend',
                manifestUrl: `${backendBase}/backend-mf-manifest.json`,
                containerEntry: `${backendBase}/backendRemoteEntry.cjs`,
                remoteType: 'commonjs-module',
              },
            },
          },
          ...(topologyDeliveryUnit
            ? { deliveryUnit: topologyDeliveryUnit }
            : {}),
        },
      ],
    },
  );
  await writeJson(
    path.join(workspaceRoot, 'topology/local-overlays/development.json'),
    {
      ports: { explore: 3021 },
      manifests: { explore: `${backendBase}/mf-manifest.json` },
      serverExecution: {
        explore: {
          node: {
            remoteName: 'verticalExploreBackend',
            manifestUrl: `${backendBase}/backend-mf-manifest.json`,
            containerEntry: `${backendBase}/backendRemoteEntry.cjs`,
            remoteType: 'commonjs-module',
          },
        },
      },
    },
  );
  return { appDirectory, distDirectory, workspaceRoot };
};

const withSourceRevision = async <T>(
  revision: string,
  callback: () => Promise<T>,
) => {
  const previous = process.env.ULTRAMODERN_SOURCE_REVISION;
  process.env.ULTRAMODERN_SOURCE_REVISION = revision;
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.ULTRAMODERN_SOURCE_REVISION;
    } else {
      process.env.ULTRAMODERN_SOURCE_REVISION = previous;
    }
  }
};

const withEnvironment = async <T>(
  values: Record<string, string | undefined>,
  callback: () => Promise<T>,
) => {
  const previous = Object.fromEntries(
    Object.keys(values).map(name => [name, process.env[name]]),
  );
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe('backend federation build artifacts', () => {
  it.each([null, false, true, '', 'syntax', 'full', 1, {}])(
    'rejects unsupported explicit containerMinify %j at the app manifest boundary',
    async containerMinify => {
      const workspace = await createWorkspace({ containerMinify });
      await expect(
        emitBackendFederationArtifacts(
          workspace.appDirectory,
          workspace.distDirectory,
        ),
      ).rejects.toThrow(
        /package\.json.*modernjs\.backendFederation\.containerMinify.*"whitespace-syntax"/,
      );
      await expect(fs.access(workspace.distDirectory)).rejects.toThrow();
    },
  );

  it('minifies the same Effect container only when opted in without changing names, lazy exposes or metadata', async () => {
    const workspace = await createWorkspace();
    const evaluationPath = path.join(workspace.workspaceRoot, 'evaluations');
    await fs.writeFile(
      path.join(workspace.appDirectory, 'api/effect-api.ts'),
      `
import { appendFileSync } from 'node:fs';
import { Effect, Layer, ManagedRuntime } from 'effect';
appendFileSync(${JSON.stringify(evaluationPath)}, 'loaded\\n');
export function namedContainerMessage(descriptiveContainerPayload: string) {
  return Effect.succeed(descriptiveContainerPayload);
}
export class NamedContainerMessage {
  constructor(readonly message: string) {}
}
export const runtime = ManagedRuntime.make(Layer.empty);
export const backendFederationContract = {};
`,
    );
    const packagePath = path.join(workspace.appDirectory, 'package.json');
    const packageManifest = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    const generate = async () => {
      const result = await withSourceRevision('2'.repeat(40), () =>
        emitBackendFederationArtifacts(
          workspace.appDirectory,
          workspace.distDirectory,
        ),
      );
      if (!result?.deliveryUnitArtifactPath) {
        throw new Error(
          'Expected emitted container and delivery-unit artifact.',
        );
      }
      const bytes = await fs.readFile(result.containerPath);
      const manifest = JSON.parse(
        await fs.readFile(result.manifestPath, 'utf8'),
      );
      expect(manifest.entry.byteLength).toBe(bytes.byteLength);
      expect(manifest.entry.sha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      return {
        bytes,
        manifest,
        deliveryUnitArtifact: await fs.readFile(
          result.deliveryUnitArtifactPath,
          'utf8',
        ),
      };
    };
    const unminified = await generate();
    await writeJson(packagePath, {
      ...packageManifest,
      modernjs: {
        backendFederation: { containerMinify: 'whitespace-syntax' },
      },
    });
    const minified = await generate();
    expect(minified.bytes.byteLength).toBeLessThan(unminified.bytes.byteLength);
    expect((await generate()).bytes).toEqual(minified.bytes);
    await writeJson(packagePath, packageManifest);
    expect((await generate()).bytes).toEqual(unminified.bytes);
    expect(minified.deliveryUnitArtifact).toBe(unminified.deliveryUnitArtifact);
    expect({ ...minified.manifest, entry: undefined }).toEqual({
      ...unminified.manifest,
      entry: undefined,
    });
    expect({
      ...minified.manifest.entry,
      byteLength: undefined,
      sha256: undefined,
    }).toEqual({
      ...unminified.manifest.entry,
      byteLength: undefined,
      sha256: undefined,
    });
    const nodeRequire = createRequire(import.meta.url);
    for (const [name, artifact] of [
      ['unminified', unminified],
      ['minified', minified],
    ] as const) {
      const entryPath = path.join(workspace.distDirectory, `${name}.cjs`);
      await fs.writeFile(entryPath, artifact.bytes);
      const container = nodeRequire(entryPath);
      expect(container.__modernjsBackendFederation).toMatchObject({
        name: 'verticalExploreBackend',
        expose: './effect-api',
        remoteType: 'commonjs-module',
      });
      await expect(fs.access(evaluationPath)).rejects.toThrow();
      expect(() => container.get('./missing')).toThrow(/Unexpected.*expose/);
      const factory = container.get('./effect-api');
      await container.init({});
      await expect(fs.access(evaluationPath)).rejects.toThrow();
      const exposed = await factory();
      try {
        expect(await factory()).toBe(exposed);
        expect(await fs.readFile(evaluationPath, 'utf8')).toBe('loaded\n');
        expect(exposed.namedContainerMessage.name).toBe(
          'namedContainerMessage',
        );
        expect(exposed.NamedContainerMessage.name).toBe(
          'NamedContainerMessage',
        );
        expect(exposed.namedContainerMessage.toString()).toContain(
          'descriptiveContainerPayload',
        );
        expect(new exposed.NamedContainerMessage('Tractor 🚜').message).toBe(
          'Tractor 🚜',
        );
        await expect(
          exposed.runtime.runPromise(
            exposed.namedContainerMessage('Tractor 🚜'),
          ),
        ).resolves.toBe('Tractor 🚜');
        expect(exposed.backendFederationContract).toMatchObject({
          name: 'verticalExploreBackend',
          runtimeFramework: 'effect',
          strictEffectApproach: true,
          compatibility: {
            build: artifact.manifest.buildVersion,
            packageName: '@tractor-store-vertical-demo/explore',
          },
        });
      } finally {
        await exposed.runtime.dispose();
        await fs.rm(evaluationPath);
      }
    }
    console.info(
      `Effect container UTF-8 bytes: ${unminified.bytes.byteLength} -> ${minified.bytes.byteLength}`,
    );
  });

  it('requires and runs its finalized renderer resolver only after build', () => {
    const resolveRendererBuild = rstest.fn(async () => ({
      buildMarker: 'compiled-build',
      sourceRevision: 'a'.repeat(40),
      ui: reactReleaseUi('compiled-build', 'explore'),
    }));
    expect(() =>
      backendFederationBuildPlugin({ resolveRendererBuild }),
    ).toThrow(/owning metadata producer/);
    const plugin = backendFederationBuildPlugin({
      resolveRendererBuild,
      rendererBuildPlugin: '@modern-js/renderer-react-build-metadata',
    });
    expect(plugin.pre).toEqual(['@modern-js/renderer-react-build-metadata']);
    expect(plugin.required).toEqual(plugin.pre);
    const onAfterBuild = rstest.fn();
    plugin.setup({
      getAppContext: () => ({
        appDirectory: '/app',
        distDirectory: '/app/dist',
        entrypoints: [{ entryName: 'main' }],
      }),
      onAfterBuild,
    });
    expect(resolveRendererBuild).not.toHaveBeenCalled();
    expect(onAfterBuild).toHaveBeenCalledOnce();
  });

  it('stamps all actual router bindings and compiled identity into output', async () => {
    const { appDirectory, distDirectory } = await createWorkspace();
    const ui = reactReleaseUi('compiled-build', 'explore');
    const twoEntryUi = {
      ...ui,
      routerBindings: {
        ...ui.routerBindings,
        csr: { ...ui.routerBindings.main!, owner: 'second-entry-owner' },
      },
    };
    const generation = createBuildArtifact();
    await writeJson(
      path.join(appDirectory, 'shared/ultramodern-build.json'),
      createUltramodernBuildArtifact(generation.deliveryUnit, {
        ui: {
          identity: generation.surfaces.ui!.rendererIdentity,
          profile: generation.surfaces.ui!.rendererProfile,
          routerBindings: twoEntryUi.routerBindings,
        },
      }),
    );
    await emitBackendFederationArtifacts(appDirectory, distDirectory, {
      entrypoints: [
        { entryName: 'main', isMainEntry: true },
        { entryName: 'csr' },
      ],
      resolveRendererBuild: async () => ({
        buildMarker: 'compiled-build',
        sourceRevision: 'b'.repeat(40),
        ui: twoEntryUi,
      }),
    });
    const actual = JSON.parse(
      await fs.readFile(
        path.join(distDirectory, 'ultramodern-build.json'),
        'utf8',
      ),
    );
    expect(actual.deliveryUnit.buildMarker).toBe('compiled-build');
    expect(actual.deliveryUnit.sourceRevision).toBe('b'.repeat(40));
    expect(actual.surfaces.ui.routerBindings).toEqual(
      twoEntryUi.routerBindings,
    );
    expect(actual.surfaces.ui.rendererIdentity).toEqual(ui.rendererIdentity);
  });

  it('rejects finalized bindings for an unbuilt or missing actual entry before output', async () => {
    const { appDirectory, distDirectory } = await createWorkspace();
    await expect(
      emitBackendFederationArtifacts(appDirectory, distDirectory, {
        entrypoints: [{ entryName: 'main' }, { entryName: 'csr' }],
        resolveRendererBuild: async () => ({
          buildMarker: 'compiled-build',
          sourceRevision: 'b'.repeat(40),
          ui: reactReleaseUi('compiled-build', 'explore'),
        }),
      }),
    ).rejects.toThrow(/required for the expected entry/);
    await expect(
      fs.access(path.join(distDirectory, 'backendRemoteEntry.cjs')),
    ).rejects.toThrow();
  });
  it.each([undefined, 'whitespace-syntax'])(
    'serves RPC from a separately bundled Effect runtime through the host handler (containerMinify: %s)',
    async containerMinify => {
      let distDirectory = '';
      let dispatchRpc: ((request: Request) => Promise<Response>) | undefined;
      const server = http.createServer(async (request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost')
          .pathname;
        if (pathname === '/explore-api/rpc' && dispatchRpc) {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const result = await dispatchRpc(
            new Request(`http://localhost${pathname}`, {
              method: request.method,
              headers: {
                'content-type':
                  request.headers['content-type'] ?? 'application/json',
              },
              body: Buffer.concat(chunks),
            }),
          );
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
          return;
        }
        const fileName = pathname.slice(1);
        if (
          fileName !== 'backend-mf-manifest.json' &&
          fileName !== 'backendRemoteEntry.cjs'
        ) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader(
          'content-type',
          fileName.endsWith('.json') ? 'application/json' : 'text/javascript',
        );
        response.end(await fs.readFile(path.join(distDirectory, fileName)));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });

      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected backend federation test server address.');
        }
        const effectEdgePath = path.resolve(
          __dirname,
          '../../../../server/bff-effect/dist/esm-node/effect/edge.mjs',
        );
        const effectDirectory = path.dirname(effectEdgePath);
        const [hostEffect, hostModule] = await Promise.all([
          import(pathToFileURL(path.join(effectDirectory, 'index.mjs')).href),
          import(pathToFileURL(path.join(effectDirectory, 'module.mjs')).href),
        ]);
        const workspace = await createWorkspace({
          containerMinify,
          apiProtocol: 'rpc',
          backendBase: `http://127.0.0.1:${address.port}`,
          effectApiSource: `
import { defineEffectBff, Effect, HttpApi, Layer, Rpc, RpcGroup, Schema, useEffectContext } from ${JSON.stringify(effectEdgePath)};
const item = Schema.Struct({ id: Schema.String, title: Schema.String });
const notFound = Schema.TaggedError;
class ExploreNotFoundRpc extends notFound<ExploreNotFoundRpc>()('ExploreNotFoundRpc', { id: Schema.String }) {}
const items = [{ id: 'bundled-explore', title: 'Bundled Effect RPC' }];
const group = RpcGroup.make(
  Rpc.make('list', {
    payload: { limit: Schema.optional(Schema.Number) },
    success: Schema.Struct({ items: Schema.Array(item) }),
  }),
  Rpc.make('get', {
    error: ExploreNotFoundRpc,
    payload: { id: Schema.String },
    success: item,
  }),
);
const runtime = defineEffectBff({
  api: HttpApi.make('ExploreRpcTransport'),
  layer: Layer.empty,
  rpc: {
    group,
    layer: group.toLayer(group.of({
      get: ({ id }) => {
        const matched = items.find(candidate => candidate.id === id);
        return matched === undefined
          ? Effect.fail(new ExploreNotFoundRpc({ id }))
          : Effect.succeed(matched);
      },
      // Reads the request storage the host handler entered.
      list: ({ limit }) => Effect.sync(() => ({
        items: (typeof limit === 'number' ? items.slice(0, limit) : items)
          .map(entry => ({ ...entry, title: \`\${entry.title} \${useEffectContext().path}\` })),
      })),
    })),
    path: '/rpc',
    serialization: 'json',
  },
});
export const backendFederationContract = {
  name: 'verticalExploreBackend',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
};
export const api = group;
export { runtime };
export default runtime;
`,
        });
        distDirectory = workspace.distDirectory;
        await withSourceRevision('2'.repeat(40), () =>
          emitBackendFederationArtifacts(
            workspace.appDirectory,
            workspace.distDirectory,
          ),
        );
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(distDirectory, 'backend-mf-manifest.json'),
            'utf8',
          ),
        );
        const loaded = await loadBackendFederatedEffectApiFromManifest({
          hostName: `appToolsRpcHost-${Date.now()}`,
          manifestUrl: `http://127.0.0.1:${address.port}/backend-mf-manifest.json`,
          entryPolicy: {
            expected: {
              byteLength: manifest.entry.byteLength,
              entryUrl: manifest.entry.url,
              remoteName: manifest.backendFederation.name,
              sha256: manifest.entry.sha256,
            },
          },
          expected: {
            buildMarker: manifest.backendFederation.deliveryUnit.buildMarker,
            unitId: manifest.backendFederation.deliveryUnit.unitId,
          },
        });
        if (!loaded.runtime || typeof loaded.runtime !== 'object') {
          throw new Error('Expected bundled Effect runtime.');
        }
        const warnings: string[] = [];
        const edge = await hostEffect.createEffectBffTestHandler({
          module: loaded.runtime,
          prefix: '/explore-api',
          onWarning: message => warnings.push(message),
        });
        dispatchRpc = request => edge.handler(request);
        expect(warnings).toEqual([]);
        try {
          const response = await fetch(
            `http://127.0.0.1:${address.port}/explore-api/rpc`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'proof',
                method: 'list',
                params: { limit: 1 },
              }),
            },
          );
          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toEqual({
            jsonrpc: '2.0',
            id: 'proof',
            result: {
              items: [
                {
                  id: 'bundled-explore',
                  title: 'Bundled Effect RPC /explore-api/rpc',
                },
              ],
            },
          });
          expect(warnings).toEqual([]);
          const restricted = await hostModule.resolveEffectBffModuleHandler(
            loaded.runtime,
            {
              validateRequest: () => new Response('denied', { status: 403 }),
            },
          );
          if (!restricted) {
            throw new Error(
              'Expected a validator-aware bundled Effect handler.',
            );
          }
          try {
            const denied = await restricted.handler(
              new Request('http://localhost/rpc', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 'blocked',
                  method: 'list',
                  params: { limit: 1 },
                }),
              }),
            );
            expect(denied.status).toBe(403);
            await expect(denied.text()).resolves.toBe('denied');
          } finally {
            await restricted.dispose?.();
          }
        } finally {
          await edge.dispose();
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it('advertises the generated RPC route without REST-only endpoints', async () => {
    const workspace = await createWorkspace({ apiProtocol: 'rpc' });
    await withSourceRevision('2'.repeat(40), () =>
      emitBackendFederationArtifacts(
        workspace.appDirectory,
        workspace.distDirectory,
      ),
    );
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(workspace.distDirectory, 'backend-mf-manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.backendFederation).toMatchObject({
      rpcPath: '/explore-api/rpc',
      rpcSerialization: 'json',
    });
    expect(manifest.backendFederation).not.toHaveProperty('readinessPath');
    expect(manifest.backendFederation).not.toHaveProperty('openapiPath');
  });

  it('stamps the configured local port and declared public origin into native backend URLs', async () => {
    const workspace = await createWorkspace();
    await withEnvironment(
      {
        VERTICAL_EXPLORE_PORT: '49117',
        ULTRAMODERN_PUBLIC_URL_EXPLORE: undefined,
      },
      async () => {
        await withSourceRevision('2'.repeat(40), () =>
          emitBackendFederationArtifacts(
            workspace.appDirectory,
            workspace.distDirectory,
          ),
        );
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(workspace.distDirectory, 'backend-mf-manifest.json'),
            'utf8',
          ),
        );
        expect(manifest.backendFederation.manifestUrl).toBe(
          'http://localhost:49117/backend-mf-manifest.json',
        );
        expect(manifest.entry.url).toBe(
          'http://localhost:49117/backendRemoteEntry.cjs',
        );
        expect(manifest.metaData.publicPath).toBe('http://localhost:49117/');
        expect(manifest.backendFederation).toMatchObject({
          readinessPath: '/explore-api/explore/readiness',
          openapiPath: '/explore-api/openapi.json',
        });
        expect(manifest.backendFederation).not.toHaveProperty('rpcPath');
      },
    );

    await withEnvironment(
      {
        VERTICAL_EXPLORE_PORT: '49117',
        ULTRAMODERN_PUBLIC_URL_EXPLORE: 'https://deploy.example/edge/path',
      },
      async () => {
        const app = await findBackendFederationApp(
          workspace.workspaceRoot,
          workspace.appDirectory,
        );
        expect(app?.manifestUrl).toBe(
          'https://deploy.example/backend-mf-manifest.json',
        );
        expect(app?.containerEntry).toBe(
          'https://deploy.example/backendRemoteEntry.cjs',
        );
        expect(app?.uiManifestUrl).toBe(
          'https://deploy.example/mf-manifest.json',
        );
      },
    );
  });

  it('preserves authored remote URLs when the local port changes', async () => {
    const workspace = await createWorkspace({
      backendBase: 'https://custom.example.com/releases/explore',
    });
    await withEnvironment(
      {
        VERTICAL_EXPLORE_PORT: '49117',
        ULTRAMODERN_PUBLIC_URL_EXPLORE: 'https://deploy.example',
      },
      async () => {
        const app = await findBackendFederationApp(
          workspace.workspaceRoot,
          workspace.appDirectory,
        );
        expect(app?.port).toBe(49117);
        expect(app?.manifestUrl).toBe(
          'https://custom.example.com/releases/explore/backend-mf-manifest.json',
        );
        expect(app?.containerEntry).toBe(
          'https://custom.example.com/releases/explore/backendRemoteEntry.cjs',
        );
        expect(app?.uiManifestUrl).toBe(
          'https://custom.example.com/releases/explore/mf-manifest.json',
        );
      },
    );
  });

  it('keeps native URL path, query, and hash when changing its origin', async () => {
    const workspace = await createWorkspace();
    const overlayPath = path.join(
      workspace.workspaceRoot,
      'topology/local-overlays/development.json',
    );
    const overlay = JSON.parse(await fs.readFile(overlayPath, 'utf8'));
    overlay.serverExecution.explore.node.manifestUrl =
      'http://localhost:3021//edge/backend-mf-manifest.json?revision=1#manifest';
    overlay.serverExecution.explore.node.containerEntry =
      'http://localhost:3021//edge/backendRemoteEntry.cjs?revision=1#entry';
    await writeJson(overlayPath, overlay);

    await withEnvironment(
      { ULTRAMODERN_PUBLIC_URL_EXPLORE: 'https://deploy.example' },
      async () => {
        const app = await findBackendFederationApp(
          workspace.workspaceRoot,
          workspace.appDirectory,
        );
        expect(app?.manifestUrl).toBe(
          'https://deploy.example//edge/backend-mf-manifest.json?revision=1#manifest',
        );
        expect(app?.containerEntry).toBe(
          'https://deploy.example//edge/backendRemoteEntry.cjs?revision=1#entry',
        );
      },
    );
  });

  it('loads its emitted container from a verified live HTTP path', async () => {
    const publicBasePath = '/delivery/explore/assets';
    let distDirectory = '';
    const requests: string[] = [];
    const server = http.createServer(async (request, response) => {
      const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1')
        .pathname;
      requests.push(requestPath);
      const fileName = requestPath.endsWith('backend-mf-manifest.json')
        ? 'backend-mf-manifest.json'
        : requestPath.endsWith('backendRemoteEntry.cjs')
          ? 'backendRemoteEntry.cjs'
          : undefined;
      if (!fileName) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader(
        'content-type',
        fileName.endsWith('.json') ? 'application/json' : 'text/javascript',
      );
      response.end(await fs.readFile(path.join(distDirectory, fileName)));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected backend federation test server address.');
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const workspace = await createWorkspace({
        backendBase: `${origin}${publicBasePath}`,
        effectApiSource: `
export const backendFederationContract = {
  name: 'verticalExploreBackend',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
};
import { Layer, ManagedRuntime, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
export const api = HttpApi.make('ExploreApi').add(
  HttpApiGroup.make('explore').add(
    HttpApiEndpoint.get('ping', '/ping', { success: Schema.String }),
  ),
);
export const runtime = ManagedRuntime.make(Layer.empty);
export { api as nativeApi, runtime as nativeRuntime };
`,
      });
      distDirectory = workspace.distDirectory;

      await withSourceRevision('2'.repeat(40), () =>
        emitBackendFederationArtifacts(
          workspace.appDirectory,
          workspace.distDirectory,
        ),
      );
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(workspace.distDirectory, 'backend-mf-manifest.json'),
          'utf8',
        ),
      );
      const loaded = await loadBackendFederatedEffectApiFromManifest({
        hostName: `appToolsLiveHttpHost-${Date.now()}`,
        manifestUrl: `${origin}${publicBasePath}/backend-mf-manifest.json`,
        entryPolicy: {
          expected: {
            byteLength: manifest.entry.byteLength,
            entryUrl: manifest.entry.url,
            remoteName: manifest.backendFederation.name,
            sha256: manifest.entry.sha256,
          },
        },
        expected: {
          buildMarker: manifest.backendFederation.deliveryUnit.buildMarker,
          unitId: manifest.backendFederation.deliveryUnit.unitId,
        },
      });

      expect(HttpApi.isHttpApi(loaded.api)).toBe(true);
      expect(loaded.api).toBe(Reflect.get(loaded, 'nativeApi'));
      expect(loaded.runtime).toBe(Reflect.get(loaded, 'nativeRuntime'));
      if (!ManagedRuntime.isManagedRuntime(loaded.runtime)) {
        throw new Error('Expected the emitted native Effect ManagedRuntime.');
      }
      try {
        await expect(
          loaded.runtime.runPromise(Effect.succeed('emitted-live-http')),
        ).resolves.toBe('emitted-live-http');
      } finally {
        await loaded.runtime.dispose();
      }
      expect(requests).toEqual([
        `${publicBasePath}/backend-mf-manifest.json`,
        `${publicBasePath}/backendRemoteEntry.cjs`,
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects delivery-unit and generated build identity drift', async () => {
    const workspace = await createWorkspace({
      artifactOverrides: {
        build: 'tractor-explore-build-DRIFTED',
        buildMarker: 'tractor-explore-build-DRIFTED',
      },
      topologyDeliveryUnit: {
        unitId: 'tractor-store-vertical-demo/explore',
        buildMarker: 'tractor-explore-build-1234',
        sourceRevision: 'workspace',
        packageName: '@tractor-store-vertical-demo/explore',
        version: '0.1.0',
      },
    });

    await expect(
      emitBackendFederationArtifacts(
        workspace.appDirectory,
        workspace.distDirectory,
      ),
    ).rejects.toThrow(/Delivery-unit identity drift/u);
  });

  it('rejects a build artifact belonging to another vertical', async () => {
    const workspace = await createWorkspace({
      artifactOverrides: { appId: 'inventory' },
    });

    await expect(
      emitBackendFederationArtifacts(
        workspace.appDirectory,
        workspace.distDirectory,
      ),
    ).rejects.toThrow(
      /appId: topology=explore vs ultramodern-build=inventory/u,
    );
  });

  it('stays silent for an app that is not backend federated', async () => {
    const workspace = await createWorkspace();
    await fs.rm(path.join(workspace.appDirectory, 'api/effect-api.ts'));
    await expect(
      emitBackendFederationArtifacts(
        workspace.appDirectory,
        workspace.distDirectory,
      ),
    ).resolves.toBeUndefined();
    await expect(fs.access(workspace.distDirectory)).rejects.toThrow();

    await fs.rm(
      path.join(workspace.workspaceRoot, 'topology/reference-topology.json'),
    );
    await expect(
      emitBackendFederationArtifacts(
        workspace.appDirectory,
        workspace.distDirectory,
      ),
    ).resolves.toBeUndefined();
    await expect(fs.access(workspace.distDirectory)).rejects.toThrow();
  });

  it('rejects a Node backend surface that is not the CommonJS container entry', async () => {
    const workspace = await createWorkspace();
    const configPath = path.join(
      workspace.workspaceRoot,
      'topology/local-overlays/development.json',
    );
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const node = config.serverExecution.explore.node;
    node.remoteType = 'module';
    await writeJson(configPath, config);
    await expect(
      emitBackendFederationArtifacts(
        workspace.appDirectory,
        workspace.distDirectory,
      ),
    ).rejects.toThrow(/Node backend federation remoteType must/u);

    node.remoteType = 'commonjs-module';
    node.containerEntry = 'http://localhost:3021/worker.mjs';
    await writeJson(configPath, config);
    await expect(
      emitBackendFederationArtifacts(
        workspace.appDirectory,
        workspace.distDirectory,
      ),
    ).rejects.toThrow(/Node backend federation containerEntry must/u);
  });
});
