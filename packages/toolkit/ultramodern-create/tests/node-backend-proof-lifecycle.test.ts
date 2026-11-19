import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMicroVerticalReleaseEnvelope } from '@modern-js/app-tools-extensions/release-envelope';
import { leasePort } from '../../../../scripts/ultramodern-production-readiness/renderer-mf-lifecycle-proof/port-lease.mjs';
import { reactReleaseUi } from '../../../solutions/app-tools-extensions/tests/renderer-release-fixture';
import {
  createRpcClientFile,
  createRpcContractFile,
} from '../src/ultramodern-workspace/api/rpc';

test('Node proof consumes the real API-only envelope and rejects changed artifacts', async () => {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'node-proof-api-envelope-'),
  );
  const targetDirectory = path.join(workspaceRoot, 'verticals/catalog/dist');
  const priorRoot = process.env.ULTRAMODERN_WORKSPACE_ROOT;
  try {
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, 'package.json'),
      '{"type":"module"}',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'verticals/catalog/package.json'),
      '{"name":"@test/catalog","version":"1.0.0"}',
    );
    const content = new Map([
      ['api/index.js', 'exports.api = true;'],
      ['backend-mf-manifest.json', '{"name":"catalog"}'],
      ['backendRemoteEntry.cjs', 'module.exports = {};'],
    ]);
    for (const [logicalPath, bytes] of content) {
      const artifactPath = path.join(targetDirectory, logicalPath);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, bytes);
    }
    const envelope = await createMicroVerticalReleaseEnvelope({
      artifactRoot: targetDirectory,
      target: 'node',
      identity: {
        unitId: 'test/catalog',
        buildMarker: '0123456789abcdef',
        sourceRevision: 'a'.repeat(40),
        releaseVersion: '1.0.0',
      },
      artifacts: [
        { logicalPath: 'api/index.js', runtime: 'nodejs' },
        {
          logicalPath: 'backend-mf-manifest.json',
          runtime: 'module-federation-manifest',
        },
        { logicalPath: 'backendRemoteEntry.cjs', runtime: 'nodejs' },
      ],
      surfaces: {
        uiClient: [],
        ssr: [],
        apiBackend: ['api/index.js'],
        backendFederation: {
          manifest: 'backend-mf-manifest.json',
          container: 'backendRemoteEntry.cjs',
        },
      },
    });
    const envelopePath = path.join(
      targetDirectory,
      'release/microvertical-release-envelope.json',
    );
    fs.mkdirSync(path.dirname(envelopePath), { recursive: true });
    fs.writeFileSync(envelopePath, JSON.stringify(envelope));
    process.env.ULTRAMODERN_WORKSPACE_ROOT = workspaceRoot;
    const proof = await import(
      `${pathToFileURL(path.resolve(__dirname, '../templates/workspace-scripts/proof-node-backend-federation.mjs')).href}?apiOnly=${Date.now()}`
    );
    const topology = {
      verticals: [
        {
          id: 'catalog',
          kind: 'vertical',
          path: 'verticals/catalog',
          package: '@test/catalog',
          surfaceProfile: 'api-only',
          api: { bff: { prefix: '/catalog-api' }, stem: 'catalog' },
          backendFederation: { name: 'verticalCatalogBackend' },
          cloudflare: { publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_CATALOG' },
        },
      ],
    };
    const overlay = {
      ports: { catalog: 3021 },
      serverExecution: {
        catalog: {
          node: {
            manifestUrl: 'http://localhost:3021/backend-mf-manifest.json',
            containerEntry: 'http://localhost:3021/backendRemoteEntry.cjs',
            remoteType: 'commonjs-module',
          },
        },
      },
    };
    const [app] = proof.topologyApps(topology, overlay, undefined, {});
    assert.equal(app.apiOnly, true);
    assert.equal(app.portEnv, 'VERTICAL_CATALOG_PORT');
    const [dynamicApp] = proof.topologyApps(topology, overlay, undefined, {
      VERTICAL_CATALOG_PORT: '49152',
      ULTRAMODERN_PUBLIC_URL_CATALOG: 'http://127.0.0.1:49152',
    });
    assert.equal(dynamicApp.port, 49152);
    assert.equal(
      dynamicApp.manifestUrl,
      'http://127.0.0.1:49152/backend-mf-manifest.json',
    );
    assert.equal(
      dynamicApp.containerEntry,
      'http://127.0.0.1:49152/backendRemoteEntry.cjs',
    );
    assert.throws(
      () =>
        proof.topologyApps(topology, overlay, undefined, {
          VERTICAL_CATALOG_PORT: '65536',
        }),
      /missing its declared path, port or Node server execution/u,
    );
    const customOverlay = {
      ...overlay,
      serverExecution: {
        catalog: {
          node: {
            ...overlay.serverExecution.catalog.node,
            manifestUrl: 'https://custom.example.test/backend-mf-manifest.json',
          },
        },
      },
    };
    const [customApp] = proof.topologyApps(topology, customOverlay, undefined, {
      VERTICAL_CATALOG_PORT: '49152',
      ULTRAMODERN_PUBLIC_URL_CATALOG: 'http://127.0.0.1:49152',
    });
    assert.equal(
      customApp.manifestUrl,
      'https://custom.example.test/backend-mf-manifest.json',
    );
    assert.equal(
      customApp.containerEntry,
      'http://127.0.0.1:49152/backendRemoteEntry.cjs',
    );
    customOverlay.serverExecution.catalog.node.manifestUrl =
      'https://localhost:3021/backend-mf-manifest.json';
    const [httpsApp] = proof.topologyApps(topology, customOverlay, undefined, {
      VERTICAL_CATALOG_PORT: '49152',
    });
    assert.equal(
      httpsApp.manifestUrl,
      'https://localhost:3021/backend-mf-manifest.json',
    );
    customOverlay.serverExecution.catalog.node.manifestUrl =
      'http://user:pass@localhost:3021/backend-mf-manifest.json';
    const [authenticatedApp] = proof.topologyApps(
      topology,
      customOverlay,
      undefined,
      { VERTICAL_CATALOG_PORT: '49152' },
    );
    assert.equal(
      authenticatedApp.manifestUrl,
      'http://user:pass@localhost:3021/backend-mf-manifest.json',
    );
    const binding = await proof.readBoundReleaseEnvelope(app, 'dist');
    assert.deepEqual(binding.envelope.surfaces.uiClient, []);
    assert.equal(Object.hasOwn(binding.envelope, 'ui'), false);

    fs.writeFileSync(
      path.join(targetDirectory, 'api/index.js'),
      'exports.api = frue;',
    );
    await assert.rejects(
      () => proof.readBoundReleaseEnvelope(app, 'dist'),
      /envelope SHA-256/u,
    );
    fs.writeFileSync(
      path.join(targetDirectory, 'api/index.js'),
      content.get('api/index.js')!,
    );

    fs.writeFileSync(
      envelopePath,
      JSON.stringify({
        ...envelope,
        surfaces: { ...envelope.surfaces, uiClient: ['api/index.js'] },
      }),
    );
    await assert.rejects(
      () => proof.readBoundReleaseEnvelope(app, 'dist'),
      /empty UI\/client and SSR/u,
    );
    fs.writeFileSync(envelopePath, JSON.stringify({ ...envelope, ui: null }));
    await assert.rejects(
      () => proof.readBoundReleaseEnvelope(app, 'dist'),
      /ui is forbidden for an API-only release/u,
    );
  } finally {
    if (priorRoot === undefined) {
      delete process.env.ULTRAMODERN_WORKSPACE_ROOT;
    } else {
      process.env.ULTRAMODERN_WORKSPACE_ROOT = priorRoot;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Node proof verifies UI renderer identity, profile and router bindings with the current envelope owner', async () => {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'node-proof-ui-envelope-'),
  );
  const targetDirectory = path.join(workspaceRoot, 'verticals/catalog/dist');
  const priorRoot = process.env.ULTRAMODERN_WORKSPACE_ROOT;
  try {
    const files = {
      'ui/main.js': 'globalThis.catalog = true;',
      'ssr/index.js': 'exports.render = () => "catalog";',
      'api/index.js': 'exports.api = true;',
      'backend-mf-manifest.json': '{"name":"catalog"}',
      'backendRemoteEntry.cjs': 'module.exports = {};',
    };
    for (const [logicalPath, bytes] of Object.entries(files)) {
      const artifactPath = path.join(targetDirectory, logicalPath);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, bytes);
    }
    const ui = reactReleaseUi('catalog-build', 'catalog');
    const envelope = await createMicroVerticalReleaseEnvelope({
      artifactRoot: targetDirectory,
      target: 'node',
      identity: {
        unitId: 'test/catalog',
        buildMarker: 'catalog-build',
        sourceRevision: 'a'.repeat(40),
        releaseVersion: '1.0.0',
      },
      ui,
      artifacts: Object.keys(files).map(logicalPath => ({
        logicalPath,
        runtime: logicalPath.startsWith('ui/')
          ? 'browser'
          : logicalPath.endsWith('.json')
            ? 'module-federation-manifest'
            : 'nodejs',
      })),
      surfaces: {
        uiClient: ['ui/main.js'],
        ssr: ['ssr/index.js'],
        apiBackend: ['api/index.js'],
        backendFederation: {
          manifest: 'backend-mf-manifest.json',
          container: 'backendRemoteEntry.cjs',
        },
      },
    });
    const envelopePath = path.join(
      targetDirectory,
      'release/microvertical-release-envelope.json',
    );
    fs.mkdirSync(path.dirname(envelopePath), { recursive: true });
    fs.writeFileSync(envelopePath, JSON.stringify(envelope));
    process.env.ULTRAMODERN_WORKSPACE_ROOT = workspaceRoot;
    const proof = await import(
      `${pathToFileURL(path.resolve(__dirname, '../templates/workspace-scripts/proof-node-backend-federation.mjs')).href}?ui=${Date.now()}`
    );
    const app = {
      id: 'catalog',
      directory: 'verticals/catalog',
      apiOnly: false,
      rendererProfile: ui.rendererProfile,
    };
    const binding = await proof.readBoundReleaseEnvelope(app, 'dist');
    assert.deepEqual(binding.envelope.ui, ui);
    assert.equal(
      binding.manifestArtifact.logicalPath,
      'backend-mf-manifest.json',
    );
    assert.equal(
      binding.containerArtifact.logicalPath,
      'backendRemoteEntry.cjs',
    );
    assert.deepEqual(
      binding.apiBackendArtifacts.map(artifact => artifact.logicalPath),
      ['api/index.js'],
    );
    await assert.rejects(
      () =>
        proof.readBoundReleaseEnvelope(
          { ...app, rendererProfile: undefined },
          'dist',
        ),
      /requires its resolved renderer profile/u,
    );
    await assert.rejects(
      () =>
        proof.readBoundReleaseEnvelope(
          {
            ...app,
            rendererProfile: {
              ...ui.rendererProfile,
              hydration: { ...ui.rendererProfile.hydration, version: '19.3.1' },
            },
          },
          'dist',
        ),
      /rendererProfile\.hydration\.version/u,
    );
    for (const invalidUi of [
      {
        ...ui,
        rendererIdentity: { ...ui.rendererIdentity, buildId: 'wrong-build' },
      },
      { ...ui, routerBindings: {} },
    ]) {
      fs.writeFileSync(
        envelopePath,
        JSON.stringify({ ...envelope, ui: invalidUi }),
      );
      await assert.rejects(
        () => proof.readBoundReleaseEnvelope(app, 'dist'),
        /buildId must match|must include the primary/u,
      );
    }
    fs.writeFileSync(
      envelopePath,
      JSON.stringify({ ...envelope, ui: undefined }),
    );
    await assert.rejects(
      () => proof.readBoundReleaseEnvelope(app, 'dist'),
      /envelope\.ui must be an object/u,
    );
  } finally {
    if (priorRoot === undefined) {
      delete process.env.ULTRAMODERN_WORKSPACE_ROOT;
    } else {
      process.env.ULTRAMODERN_WORKSPACE_ROOT = priorRoot;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    label: 'root public artifact URLs',
    manifestPath: '/backend-mf-manifest.json',
    containerPath: '/backendRemoteEntry.cjs',
  },
  {
    label: 'prefixed public artifact URLs with query and fragment',
    manifestPath: '//edge/catalog/backend-mf-manifest.json?revision=1#manifest',
    containerPath: '//edge/catalog/backendRemoteEntry.cjs?revision=1#entry',
  },
])(
  'Node backend proof composes public runtime owners with $label',
  ({ manifestPath, containerPath }) => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'node-backend-proof-runtime-'),
    );
    try {
      fs.writeFileSync(
        path.join(workspaceRoot, 'package.json'),
        '{"type":"module"}',
      );
      const scope = path.join(workspaceRoot, 'node_modules/@modern-js');
      fs.mkdirSync(scope, { recursive: true });
      for (const [name, relativePath] of [
        ['plugin-bff-extensions', '../../../cli/plugin-bff-extensions'],
        ['bff-effect', '../../../server/bff-effect'],
        ['app-tools-extensions', '../../../solutions/app-tools-extensions'],
      ]) {
        fs.symlinkSync(
          path.resolve(__dirname, relativePath),
          path.join(scope, name),
          'dir',
        );
      }
      fs.symlinkSync(
        path.resolve(
          __dirname,
          '../../../server/bff-effect/node_modules/effect',
        ),
        path.join(workspaceRoot, 'node_modules/effect'),
        'dir',
      );
      const catalogDirectory = path.join(workspaceRoot, 'verticals/catalog');
      fs.mkdirSync(path.join(catalogDirectory, 'shared'), { recursive: true });
      fs.writeFileSync(
        path.join(catalogDirectory, 'package.json'),
        JSON.stringify({
          name: '@test/catalog',
          version: '1.0.0',
          exports: { './api/rpc-client': './shared/catalog-rpc-client.ts' },
        }),
      );
      const catalogApi = {
        id: 'catalog',
        api: {
          consumedBy: [],
          prefix: '/catalog-api',
          protocol: 'rpc' as const,
          stem: 'catalog',
        },
      };
      fs.writeFileSync(
        path.join(catalogDirectory, 'shared/rpc.ts'),
        createRpcContractFile(catalogApi),
      );
      fs.writeFileSync(
        path.join(catalogDirectory, 'shared/catalog-rpc-client.ts'),
        createRpcClientFile(catalogApi, './rpc.ts'),
      );

      const proofUrl = pathToFileURL(
        path.resolve(
          __dirname,
          '../templates/workspace-scripts/proof-node-backend-federation.mjs',
        ),
      ).href;
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.cwd() + '/package.json');
const proof = await import(${JSON.stringify(proofUrl)});
const { validateNodeBackendFederationProofResult } = await import(${JSON.stringify(
            pathToFileURL(
              path.resolve(
                __dirname,
                '../../../../scripts/ultramodern-production-readiness/browser-smoke/backend-proof-contract.mjs',
              ),
            ).href,
          )});
const runtime = await proof.importBackendFederationRuntime();
const federation = await import(pathToFileURL(require.resolve('@modern-js/plugin-bff-extensions/backend-federation-manifest/node')).href);
const effect = await import(pathToFileURL(require.resolve('@modern-js/bff-effect/effect')).href);
assert.equal(federation.createEffectBffTestHandler, undefined);
assert.equal(runtime.loadBackendFederatedEffectApiFromManifest, federation.loadBackendFederatedEffectApiFromManifest);
assert.equal(runtime.createEffectBffTestHandler, effect.createEffectBffTestHandler);
const { Effect, HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, Layer, Rpc, RpcGroup, Schema, defineEffectBff } = await import(
  '@modern-js/bff-effect/effect-edge'
);
const api = HttpApi.make('ProofApi').add(
  HttpApiGroup.make('proof').add(
    HttpApiEndpoint.get('ready', '/ready', { success: Schema.Struct({ status: Schema.String }) }),
  ),
);
const handlers = HttpApiBuilder.group(api, 'proof', group =>
  group.handle('ready', () => Effect.succeed({ status: 'ready' })),
);
const layer = HttpApiBuilder.layer(api).pipe(Layer.provide(handlers));
const handler = await runtime.createEffectBffTestHandler({ module: { api, layer }, prefix: '/proof-api' });
try {
  const response = await handler.handler(new Request('http://localhost/proof-api/ready'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready' });
} finally {
  await handler.dispose();
}

// A real owned server + native federation loader, using public-addressed bytes.
const { createMicroVerticalReleaseEnvelope } = await import('@modern-js/app-tools-extensions/release-envelope');
const output = path.join(process.cwd(), 'verticals/catalog/.output');
fs.mkdirSync(path.join(output, 'api'), { recursive: true });
fs.writeFileSync(path.join(output, 'package.json'), '{"type":"commonjs"}');
function makeRestBackend({ Effect, HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpRouter, HttpServerResponse, OpenApi, Layer, Schema, defineEffectBff }) {
  const marker = {
    unitId: 'test/catalog', build: 'catalog-build', buildMarker: 'catalog-build',
    packageName: '@test/catalog', version: '1.0.0', sourceRevision: 'a'.repeat(40),
  };
  const api = HttpApi.make('CatalogApi').add(HttpApiGroup.make('catalog').add(
    HttpApiEndpoint.get('readiness', '/catalog/readiness', { success: Schema.Unknown }),
    HttpApiEndpoint.get('list', '/catalog/items', { success: Schema.Unknown }),
  ));
  const handlers = HttpApiBuilder.group(api, 'catalog', group => group
    .handle('readiness', () => Effect.succeed({ marker, status: 'ready' }))
    .handle('list', () => Effect.succeed({ items: [{ id: 'starter-catalog' }] })),
  );
  const layer = HttpApiBuilder.layer(api).pipe(Layer.provide(handlers));
  const runtime = defineEffectBff({ api, layer: Layer.mergeAll(layer,
    HttpRouter.add('GET', '/openapi.json', HttpServerResponse.jsonUnsafe(OpenApi.fromApi(api)))),
  });
  return {
    api, runtime, contract: { servicePrefix: '/catalog-api' },
    backendFederationContract: {
      name: 'verticalCatalogBackend', role: 'microvertical-server',
      strictEffectApproach: true, runtimeFramework: 'effect',
      compatibility: {
        build: marker.build, unitId: marker.unitId, packageName: marker.packageName,
        contractVersion: 'microvertical-server-effect-v1', nodeAdapterVersion: 'backend-mf-effect-v2',
      },
    },
  };
}
const declaredOrigin = 'https://catalog.example.test';
const declaredManifestPath = ${JSON.stringify(manifestPath)};
const declaredContainerPath = ${JSON.stringify(containerPath)};
const marker = { unitId: 'test/catalog', buildMarker: 'catalog-build', packageName: '@test/catalog', version: '1.0.0', sourceRevision: 'a'.repeat(40) };
const manifest = {
  schemaVersion: 1, id: 'verticalCatalogBackend', name: 'verticalCatalogBackend',
  version: '1.0.0', buildVersion: marker.buildMarker,
  metaData: {
    name: 'verticalCatalogBackend',
    buildInfo: { buildName: marker.packageName, buildVersion: marker.buildMarker },
    remoteEntry: { name: 'backendRemoteEntry.cjs', type: 'commonjs-module' },
  },
  entry: { url: declaredOrigin + declaredContainerPath, type: 'commonjs-module' },
  exposes: [{ name: './effect-api', path: './effect-api' }],
  backendFederation: {
    name: 'verticalCatalogBackend', role: 'microvertical-server', runtimeFramework: 'effect', strictEffectApproach: true,
    contractVersion: 'microvertical-server-effect-v1', nodeAdapterVersion: 'backend-mf-effect-v2',
    manifestUrl: declaredOrigin + declaredManifestPath, containerEntry: declaredOrigin + declaredContainerPath,
    readinessPath: '/catalog-api/catalog/readiness', expose: './effect-api',
    deliveryUnit: { ...marker, schemaVersion: 1, kind: 'microvertical-delivery-unit' },
    versionBoundary: { packageName: marker.packageName, version: marker.version, buildVersion: marker.buildMarker, deliveryUnit: { unitId: marker.unitId, buildMarker: marker.buildMarker, sourceRevision: marker.sourceRevision } },
  },
};
const containerSource = 'module.exports = { init() {}, async get() { const make = ' + makeRestBackend.toString() +
  '; const loaded = make(await import(' + JSON.stringify(pathToFileURL(require.resolve('@modern-js/bff-effect/effect-edge')).href) +
  ')); return () => loaded; } };';
fs.writeFileSync(path.join(output, 'backendRemoteEntry.cjs'), containerSource);
manifest.entry.sha256 = createHash('sha256').update(containerSource).digest('hex');
manifest.entry.byteLength = Buffer.byteLength(containerSource);
fs.writeFileSync(path.join(output, 'backend-mf-manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(output, 'api/index.js'), 'exports.api = true;');
fs.writeFileSync(path.join(output, 'ultramodern-build.json'), JSON.stringify({ deliveryUnit: marker }));
const envelope = await createMicroVerticalReleaseEnvelope({
  artifactRoot: output, target: 'node',
  identity: { unitId: marker.unitId, buildMarker: marker.buildMarker, sourceRevision: marker.sourceRevision, releaseVersion: marker.version },
  artifacts: [
    { logicalPath: 'api/index.js', runtime: 'nodejs' },
    { logicalPath: 'backend-mf-manifest.json', runtime: 'module-federation-manifest' },
    { logicalPath: 'backendRemoteEntry.cjs', runtime: 'nodejs' },
  ],
  surfaces: { uiClient: [], ssr: [], apiBackend: ['api/index.js'],
    backendFederation: { manifest: 'backend-mf-manifest.json', container: 'backendRemoteEntry.cjs' } },
});
fs.mkdirSync(path.join(output, 'release'), { recursive: true });
fs.writeFileSync(path.join(output, 'release/microvertical-release-envelope.json'), JSON.stringify(envelope));
fs.writeFileSync(path.join(output, 'index.js'), [
  "const fs = require('node:fs'); const http = require('node:http');",
  '(async () => {',
  'const { createEffectBffTestHandler } = await import(' + JSON.stringify(pathToFileURL(require.resolve('@modern-js/bff-effect/effect')).href) + ');',
  "const loaded = (await require('./backendRemoteEntry.cjs').get('./effect-api'))();",
  "const handler = await createEffectBffTestHandler({ module: loaded.runtime, prefix: '/catalog-api' });",
  'http.createServer(async (request, response) => {',
  "fs.appendFileSync('requests.jsonl', JSON.stringify({ host: request.headers.host, route: request.url }) + String.fromCharCode(10));",
  "if (fs.existsSync('redirect-path') && fs.readFileSync('redirect-path', 'utf8') === request.url) {",
  "response.writeHead(307, { location: 'http://127.0.0.1:' + process.env.PORT + '/escaped' }); response.end(); return; }",
  "if (['/backend-mf-manifest.json', '/backendRemoteEntry.cjs'].includes(request.url)) { response.end(fs.readFileSync('.' + request.url)); return; }",
  "const result = await handler.handler(new Request('http://127.0.0.1' + request.url));",
  'response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));',
  "}).listen(Number(process.env.PORT), '127.0.0.1');",
  '})();',
].join(String.fromCharCode(10)));
const { leasePort } = await import(${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../../../../scripts/ultramodern-production-readiness/renderer-mf-lifecycle-proof/port-lease.mjs')).href)});
const restLease = await leasePort();
const [restApp] = proof.topologyApps({ verticals: [{
  id: 'catalog', kind: 'vertical', path: 'verticals/catalog', package: '@test/catalog',
  surfaceProfile: 'api-only', deliveryUnit: marker, api: { bff: { prefix: '/catalog-api' } },
  cloudflare: { publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_CATALOG', jsonSmokeChecks: [
    { route: '/catalog-api/catalog/readiness', expect: { status: 'ready' } },
    { route: '/catalog-api/catalog/items', expect: { 'items.0.id': 'starter-catalog' } },
    { route: '/catalog-api/openapi.json', expect: { openapi: '3.1.0' } },
  ] },
}] }, { ports: { catalog: 3021 }, serverExecution: { catalog: { node: {
  manifestUrl: 'http://localhost:3021' + declaredManifestPath,
  containerEntry: 'http://localhost:3021' + declaredContainerPath,
} } } }, undefined, { VERTICAL_CATALOG_PORT: String(restLease.port), ULTRAMODERN_PUBLIC_URL_CATALOG: declaredOrigin });
await restLease.release();
const readRequests = () => fs.readFileSync(path.join(output, 'requests.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).map(line => JSON.parse(line));
const restRuntime = await proof.startNodeRuntime(restApp, '.output', { startupTimeoutMs: 5000 });
try {
  const result = await proof.proveBackend(restApp, runtime, '.output');
  const validation = validateNodeBackendFederationProofResult(result);
  assert.equal(validation.ok, true, validation.failures.join('; '));
  assert.equal(result.status, 'pass');
  assert.equal(result.manifestUrl, manifest.backendFederation.manifestUrl);
  assert.equal(result.containerEntry, manifest.entry.url);
  assert.equal(result.liveArtifacts.manifest.url, restApp.manifestUrl);
  assert.equal(result.liveArtifacts.manifest.transportUrl, 'http://127.0.0.1:' + restApp.port + '/backend-mf-manifest.json');
  assert.equal(result.liveArtifacts.container.url, declaredOrigin + declaredContainerPath);
  assert.equal(result.liveArtifacts.container.transportUrl, 'http://127.0.0.1:' + restApp.port + '/backendRemoteEntry.cjs');
  assert.equal(result.smokeChecks.length, 3);
  assert.deepEqual(readRequests().map(request => request.route), [
    '/backend-mf-manifest.json', '/backend-mf-manifest.json', '/backendRemoteEntry.cjs', '/catalog-api/catalog/readiness',
  ]);
  assert.ok(readRequests().every(request => request.host === '127.0.0.1:' + restApp.port));
  // Existing mode invokes this same path without a separate readiness wait.
  const existingResult = await proof.proveBackend(restApp, runtime, '.output');
  assert.equal(existingResult.status, 'pass');
  assert.deepEqual(readRequests().slice(-3).map(request => request.route), [
    '/backend-mf-manifest.json', '/backendRemoteEntry.cjs', '/catalog-api/catalog/readiness',
  ]);
  assert.ok(readRequests().every(request => request.host === '127.0.0.1:' + restApp.port));
  const count = readRequests().length;
  await assert.rejects(proof.proveBackend({ ...restApp, manifestUrl: 'https://wrong.example.test' + declaredManifestPath }, runtime, '.output'), /backend manifest URL/);
  await assert.rejects(proof.proveBackend({ ...restApp, containerEntry: 'https://wrong.example.test' + declaredContainerPath }, runtime, '.output'), /backend manifest entry URL/);
  if (declaredContainerPath.includes('#')) {
    await assert.rejects(proof.proveBackend({ ...restApp, containerEntry: restApp.containerEntry.replace('#entry', '#wrong') }, runtime, '.output'), /backend manifest entry URL/);
    await assert.rejects(proof.proveBackend({ ...restApp, manifestUrl: restApp.manifestUrl.replace('revision=1', 'revision=2') }, runtime, '.output'), /backend manifest URL/);
  }
  assert.equal(readRequests().length, count, 'wrong declared identities must fail before fetching');
  for (const route of ['/backend-mf-manifest.json', '/backendRemoteEntry.cjs', '/catalog-api/catalog/readiness']) {
    fs.writeFileSync(path.join(output, 'redirect-path'), route);
    await assert.rejects(proof.proveBackend(restApp, runtime, '.output'), /fetch failed/);
    assert.equal(readRequests().at(-1).route, route);
    assert.ok(!readRequests().some(request => request.route === '/escaped'));
  }
  fs.rmSync(path.join(output, 'redirect-path'));
  for (const route of ['/other-api/readiness', '//catalog.example.test/catalog-api/readiness', '/catalog-api/../other-api/readiness']) {
    await assert.rejects(proof.proveBackend({ ...restApp, smokeChecks: [{ route }] }, runtime, '.output'), /unsupported or cross-app/);
  }
  const misboundUrl = declaredOrigin + '/edge/backend-mf-manifest.json?revision=1#entry';
  await assert.rejects(proof.fetchBoundArtifact({ ...restApp, containerEntry: misboundUrl }, misboundUrl, result.liveArtifacts.container, 'container'), /unsupported Node proof artifact URL/);
  for (const url of [declaredOrigin + '/other/backendRemoteEntry.cjs', 'https://other.example.test/backendRemoteEntry.cjs']) {
    await assert.rejects(proof.fetchBoundArtifact(restApp, url, result.liveArtifacts.container, 'container'), /unsupported Node proof artifact URL/);
  }
} finally {
  await proof.stopNodeRuntime(restRuntime);
}
// Readiness must also reject redirects, not follow even to another local path.
fs.writeFileSync(path.join(output, 'redirect-path'), '/backend-mf-manifest.json');
const beforeRedirectReadiness = readRequests().length;
await assert.rejects(proof.startNodeRuntime(restApp, '.output', { startupTimeoutMs: 750 }), /did not serve/);
assert.ok(readRequests().length > beforeRedirectReadiness, 'readiness redirect was actually served');
assert.ok(!readRequests().some(request => request.route === '/escaped'));

const Item = Schema.Struct({ id: Schema.String, title: Schema.String });
const taggedErrorSchema = Schema.TaggedError;
class CatalogNotFoundRpc extends taggedErrorSchema()('CatalogNotFoundRpc', { id: Schema.String }) {}
const group = RpcGroup.make(
  Rpc.make('list', { payload: { limit: Schema.optional(Schema.Number) }, success: Schema.Struct({ items: Schema.Array(Item) }) }),
  Rpc.make('get', { error: CatalogNotFoundRpc, payload: { id: Schema.String }, success: Item }),
);
const rpcLayer = group.toLayer(group.of({
  get: ({ id }) => id === 'starter-catalog'
    ? Effect.succeed({ id, title: 'Catalog' })
    : Effect.fail(new CatalogNotFoundRpc({ id })),
  list: () => Effect.succeed({ items: [{ id: 'starter-catalog', title: 'Catalog' }] }),
}));
const rpcRuntime = defineEffectBff({
  api: HttpApi.make('RpcTransport'),
  layer: Layer.empty,
  rpc: { group, layer: rpcLayer, path: '/rpc', serialization: 'json' },
});
const rpcHandler = await runtime.createEffectBffTestHandler({ module: rpcRuntime, prefix: '/catalog-api' });
const requests = [];
let redirectRpcAt = 0;
const server = createServer(async (request, response) => {
  requests.push({ host: request.headers.host, route: request.url, method: request.method });
  if (requests.length === redirectRpcAt) {
    response.writeHead(307, { location: 'http://127.0.0.1:' + server.address().port + '/escaped' });
    response.end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const webResponse = await rpcHandler.handler(new Request(
      'http://127.0.0.1' + request.url,
      { method: request.method, headers: request.headers, body: body.length ? body : undefined, duplex: 'half' },
    ));
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const port = server.address().port;
  const proofApp = {
    id: 'catalog',
    directory: 'verticals/catalog',
    packageName: '@test/catalog',
    manifestUrl: 'https://catalog.example.test/backend-mf-manifest.json',
    containerEntry: 'https://catalog.example.test/backendRemoteEntry.cjs',
    port,
    apiPrefix: '/catalog-api',
    rpcPath: '/catalog-api/rpc',
    rpcSerialization: 'json',
    smokeChecks: [{
      id: 'catalog-rpc-smoke', route: '/catalog-api/rpc',
      body: { id: 'catalog-proof', method: 'list', params: { limit: 1 } },
      expect: { id: 'catalog-proof', 'result.items.0.id': 'starter-catalog' },
    }],
  };
  const loadedRpc = { api: group, contract: { group: 'catalog', path: '/catalog-api/rpc', protocol: 'rpc', serialization: 'json' } };
  const manifest = { backendFederation: { rpcPath: '/catalog-api/rpc', rpcSerialization: 'json' } };
  const releaseBinding = { envelope: { envelopeDigest: 'proof-digest' }, apiBackendArtifacts: [] };
  await assert.rejects(
    proof.proveLiveRpcApi(proofApp, loadedRpc, { backendFederation: { ...manifest.backendFederation, rpcPath: '/wrong/rpc' } }, releaseBinding),
    new RegExp('RPC contract/manifest path'),
  );
  await assert.rejects(
    proof.proveLiveRpcApi(proofApp, loadedRpc, { backendFederation: { ...manifest.backendFederation, rpcSerialization: 'ndjson' } }, releaseBinding),
    new RegExp('RPC contract/manifest serialization'),
  );
  await assert.rejects(
    proof.proveLiveRpcApi(proofApp, { ...loadedRpc, contract: { ...loadedRpc.contract, group: 'other' } }, manifest, releaseBinding),
    new RegExp('public RPC client contract'),
  );
  const proofResult = await proof.proveLiveRpcApi(proofApp, loadedRpc, manifest, releaseBinding);
  assert.equal(proofResult.status, 'pass');
  assert.equal(proofResult.method, 'RPC');
  assert.deepEqual(proofResult.operations.map(operation => operation.method), ['list', 'get', 'get']);
  assert.equal(proofResult.operations[2].errorTag, 'CatalogNotFoundRpc');
  assert.equal(proofResult.url, 'http://127.0.0.1:' + port + '/catalog-api/rpc');
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ({
    host: '127.0.0.1:' + port, route: '/catalog-api/rpc/', method: 'POST',
  })));
  for (const operationIndex of [1, 2, 3]) {
    redirectRpcAt = requests.length + operationIndex;
    await assert.rejects(proof.proveLiveRpcApi(proofApp, loadedRpc, manifest, releaseBinding));
    assert.equal(requests.length, redirectRpcAt, 'RPC redirect must not be followed');
    assert.ok(!requests.some(request => request.route === '/escaped'));
  }
  const crossAppPath = '/other-api/rpc';
  await assert.rejects(proof.proveLiveRpcApi(
    { ...proofApp, rpcPath: crossAppPath, smokeChecks: [{ ...proofApp.smokeChecks[0], route: crossAppPath }] },
    { ...loadedRpc, contract: { ...loadedRpc.contract, path: crossAppPath } },
    { backendFederation: { ...manifest.backendFederation, rpcPath: crossAppPath } }, releaseBinding,
  ), /unsupported or cross-app/);
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rpcHandler.dispose();
}
`,
        ],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            NODE_PATH: '',
            ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot,
          },
          stdio: 'pipe',
        },
      );
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test('Node backend proof owns the runtime lifecycle for built MicroVerticals', async () => {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'node-backend-proof-lifecycle-'),
  );
  const appDirectory = path.join(workspaceRoot, 'verticals/catalog/.output');
  const lease = await leasePort();
  const { port } = lease;
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(appDirectory, 'index.js'),
    [
      "const http = require('node:http');",
      'const port = Number(process.env.VERTICAL_CATALOG_PORT);',
      'http.createServer((_request, response) => {',
      "  response.writeHead(200, { 'content-type': 'application/json' });",
      '  response.end(JSON.stringify({ port: process.env.PORT }));',
      "}).listen(port, '127.0.0.1');",
      '',
    ].join('\n'),
  );

  const proofModule = (await import(
    pathToFileURL(
      path.resolve(
        __dirname,
        '../templates/workspace-scripts/proof-node-backend-federation.mjs',
      ),
    ).href
  )) as {
    resolveNodeProofServerMode?: (
      env: Record<string, string | undefined>,
    ) => 'existing' | 'owned';
    startNodeRuntime?: (
      app: Record<string, unknown>,
      target: string,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    stopNodeRuntime?: (runtime: Record<string, unknown>) => Promise<void>;
  };

  try {
    assert.equal(proofModule.resolveNodeProofServerMode!({}), 'owned');
    assert.equal(
      proofModule.resolveNodeProofServerMode!({
        ULTRAMODERN_NODE_PROOF_SERVER_MODE: 'existing',
      }),
      'existing',
    );
    assert.throws(
      () =>
        proofModule.resolveNodeProofServerMode!({
          ULTRAMODERN_NODE_PROOF_SERVER_MODE: 'disabled',
        }),
      /ULTRAMODERN_NODE_PROOF_SERVER_MODE/u,
    );
    // Unbind in the statement before the runtime that binds this port starts.
    await lease.release();
    const runtime = await proofModule.startNodeRuntime!(
      {
        id: 'catalog',
        directory: 'verticals/catalog',
        manifestUrl: 'https://catalog.example.test/backend-mf-manifest.json',
        port,
        portEnv: 'VERTICAL_CATALOG_PORT',
      },
      '.output',
      {
        startupTimeoutMs: 5_000,
        workspaceRoot,
      },
    );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { port: String(port) });
    } finally {
      await proofModule.stopNodeRuntime!(runtime);
    }

    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Node backend proof passes exact verified container bytes to the loader', async () => {
  const proofModule = (await import(
    pathToFileURL(
      path.resolve(
        __dirname,
        '../templates/workspace-scripts/proof-node-backend-federation.mjs',
      ),
    ).href
  )) as {
    fetchBoundArtifact?: (
      app: Record<string, unknown>,
      url: string,
      artifact: Record<string, unknown>,
      label: string,
      fetchImpl: typeof fetch,
    ) => Promise<{ bytes: Buffer; evidence: Record<string, unknown> }>;
    loadBackendFromVerifiedArtifacts?: (options: {
      app: Record<string, unknown>;
      buildIdentity: Record<string, unknown>;
      container: { bytes: Buffer };
      loadImpl: (options: Record<string, unknown>) => Promise<unknown>;
      manifest: { bytes: Buffer };
    }) => Promise<unknown>;
  };

  const manifestBytes = Buffer.from(
    JSON.stringify({
      backendFederation: { runtimeFramework: 'effect' },
      entry: { url: 'https://example.test/backendRemoteEntry.cjs' },
    }),
  );
  const verifiedContainerBytes = Buffer.from(
    "module.exports = { verified: 'executed' };",
  );
  const changedSecondFetchBytes = Buffer.from(
    "module.exports = { attacker: 'executed' };",
  );
  const bodies = [
    manifestBytes,
    verifiedContainerBytes,
    changedSecondFetchBytes,
  ];
  let networkFetchCount = 0;
  const fetchImpl = async () => {
    const body = bodies[networkFetchCount];
    networkFetchCount += 1;
    return new Response(body, { status: 200 });
  };
  const digest = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex');
  const app = {
    backendName: 'verticalCatalogBackend',
    containerEntry: 'https://example.test/backendRemoteEntry.cjs',
    id: 'catalog',
    port: 3021,
    manifestUrl: 'https://example.test/backend-mf-manifest.json',
  };
  const manifest = await proofModule.fetchBoundArtifact!(
    app,
    app.manifestUrl,
    {
      byteLength: manifestBytes.byteLength,
      logicalPath: 'backend-mf-manifest.json',
      sha256: digest(manifestBytes),
    },
    'backend manifest',
    fetchImpl,
  );
  const container = await proofModule.fetchBoundArtifact!(
    app,
    app.containerEntry,
    {
      byteLength: verifiedContainerBytes.byteLength,
      logicalPath: 'backendRemoteEntry.cjs',
      sha256: digest(verifiedContainerBytes),
    },
    'backend container',
    fetchImpl,
  );
  const delivered = await proofModule.loadBackendFromVerifiedArtifacts!({
    app,
    buildIdentity: {
      buildVersion: 'catalog-build',
      packageName: '@example/catalog',
      unitId: 'catalog',
    },
    container,
    manifest,
    async loadImpl(options) {
      const entryPolicy = options.entryPolicy as {
        fetch: (url: string) => Promise<Response>;
      };
      const response = await entryPolicy.fetch(app.containerEntry);
      return Buffer.from(await response.arrayBuffer()).toString('utf8');
    },
  });

  assert.equal(delivered, verifiedContainerBytes.toString('utf8'));
  assert.equal(networkFetchCount, 2);
  assert.notEqual(delivered, changedSecondFetchBytes.toString('utf8'));
});
