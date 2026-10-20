import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertGeneratedWorkerResult } from '../../../scripts/ultramodern-renderers/native-federation-generated-worker.mjs';
import {
  authorGeneratedWorkerApplication,
  authorGeneratedWorkerRoutes,
  generatedWorkerCoordinates,
  generatedWorkerDeploymentInput,
  generatedWorkerSharedCounter,
} from './generated.mjs';

const coordinates = [
  generatedWorkerCoordinates.host,
  ...generatedWorkerCoordinates.remotes,
];
const origins = [
  'http://127.0.0.1:41000',
  'http://127.0.0.1:41001',
  'http://127.0.0.1:41002',
];
const descriptor = coordinate => ({ ...coordinate, renderer: 'octane' });
const service = (remote, host) => ({
  binding: `VERTICAL_${remote.id.replaceAll('-', '_').toUpperCase()}_WORKER`,
  service: `proof-${remote.id}`,
  fragments: (host ? ['./Route', './Widget'] : ['./Widget']).map(expose => ({
    expose,
    remote: remote.id,
    boundaryId: remote.moduleFederationName,
    path: `/{locale}/_mf/fragment/${expose.slice(2).toLowerCase()}`,
  })),
});
const browserProof = () => ({
  exactNodeAdoption: true,
  ssrBeforeHydration: true,
});
const result = () => ({
  mode: 'packed',
  generation: {
    origins: [...origins],
    workerServices: coordinates.map((coordinate, index) => ({
      id: coordinate.id,
      services:
        index === 0
          ? generatedWorkerCoordinates.remotes.map(remote =>
              service(remote, true),
            )
          : index === 1
            ? [service(generatedWorkerCoordinates.remotes[1], false)]
            : [],
    })),
    applications: coordinates.map(coordinate => ({
      ...descriptor(coordinate),
      buildIdentity: { renderer: 'octane' },
    })),
    operations: coordinates.map((coordinate, index) => ({
      operation: index ? 'vertical' : 'workspace',
      createdApps: [descriptor(coordinate)],
      warnings: [],
    })),
  },
  publications: generatedWorkerCoordinates.remotes.map((app, index) => ({
    id: app.id,
    origin: origins[index + 1],
    publicPath: `${origins[index + 1]}/`,
    remoteEntry: `${origins[index + 1]}/remoteEntry.js`,
    assets: [`${origins[index + 1]}/main.js`],
  })),
  positive: Array.from({ length: 2 }, browserProof),
  concurrent: Array.from({ length: 4 }, browserProof),
  requestDigests: Array.from({ length: 4 }, (_, index) =>
    String(index).repeat(64),
  ),
  routes: Array.from({ length: 3 }, () => ({
    adopted: true,
    nestedDisposed: true,
    observed: [
      {
        appId: 'host',
        pathname: '/',
        language: 'en',
        greeting: 'hello',
        match: { id: 'root' },
        host: {
          appId: 'host',
          pathname: '/',
          language: 'en',
          greeting: 'hello',
          match: { id: 'root' },
        },
      },
    ],
  })),
  hops: [{ routes: ['/en/'], requests: [{ method: 'POST', status: 200 }] }],
  counterCompilations: [{}, {}, {}],
  faults: [
    'unavailable',
    'headers-hang',
    'body-hang',
    'manifest-unavailable',
    'manifest-headers-hang',
    'manifest-body-hang',
    'foreign-manifest',
    'foreign-renderer',
    'foreign-request-authority',
    'foreign-response-authority',
    'foreign-native-publisher',
    'foreign-native-abi',
    'foreign-native-document',
    'foreign-native-boundary',
    'foreign-native-echo',
  ].map(mode => ({
    mode,
    proof: { browserRecovery: true, ssrElapsedMs: 100 },
    activeRequests: 0,
    cancellations: 1,
    requests: [
      {
        mode,
        method: mode.startsWith('manifest-') ? 'GET' : 'POST',
        mutation: mode,
      },
    ],
  })),
});

test('generated Worker receipts require public generation plus the entire independent native matrix', () => {
  const qualified = assertGeneratedWorkerResult(result());
  assert.equal(qualified.generatedPublicWorkspace, true);
  assert.equal(qualified.ssrBeforeHydration, true);
  assert.equal(Object.hasOwn(qualified, 'streaming'), false);
  for (const mutate of [
    value => value.generation.operations.pop(),
    value => {
      value.generation.workerServices[0].services.push(
        value.generation.workerServices[0].services[0],
      );
    },
    value => {
      value.generation.workerServices[0].services[0].fragments.shift();
    },
    value => {
      value.generation.workerServices[0].services[0].binding = 'FOREIGN_WORKER';
    },
    value => {
      value.generation.workerServices[1].services[0].fragments.push({
        expose: './Route',
      });
    },
    value => {
      value.generation.applications[1].id = 'foreign-remote';
    },
    value => {
      value.generation.applications[1].directory = 'apps/foreign';
    },
    value => {
      value.generation.operations[1].createdApps[0].directory = 'apps/foreign';
    },
    value => {
      value.generation.operations[1].createdApps[0].renderer = 'solid';
    },
    value => {
      value.generation.operations[1].warnings.push({ message: 'not complete' });
    },
    value => {
      value.generation.applications[0].buildIdentity.renderer = 'solid';
    },
    value => {
      value.publications[0].publicPath = 'http://127.0.0.1:49999/';
    },
    value => {
      value.publications[0].origin = 'http://127.0.0.1:49999';
    },
    value => {
      value.publications[0].assets[0] = 'https://foreign.invalid/main.js';
    },
    value => {
      value.publications[0].remoteEntry = 'https://foreign.invalid/entry.js';
    },
    value => {
      value.publications[0].assets = [];
    },
    value => {
      value.requestDigests[0] = value.requestDigests[1];
    },
    value => {
      value.positive[0].ssrBeforeHydration = false;
    },
    value => {
      value.faults[1].cancellations = 0;
    },
    value => {
      value.generation.operations[0].operation = 'fixture';
    },
    value => {
      value.concurrent[0].exactNodeAdoption = false;
    },
    value => {
      value.faults.find(
        item => item.mode === 'body-hang',
      ).proof.browserRecovery = false;
    },
    value => {
      value.faults.find(
        item => item.mode === 'headers-hang',
      ).proof.ssrElapsedMs = 5000;
    },
    value => value.faults.pop(),
    value => {
      value.mode = 'source';
    },
  ]) {
    const incomplete = result();
    mutate(incomplete);
    assert.throws(() => assertGeneratedWorkerResult(incomplete));
  }
});

test('explicit route authoring extends native topology bindings without changing default fragments', () => {
  const defaults = generatedWorkerCoordinates.remotes.map(remote =>
    service(remote, false),
  );
  const config = {
    server: { ssr: true },
    deploy: { worker: { name: 'proof-host', services: defaults } },
  };
  const original = structuredClone(config);
  const authored = authorGeneratedWorkerRoutes(
    config,
    generatedWorkerCoordinates.remotes,
  );
  assert.deepEqual(config, original);
  assert.equal(authored.server, config.server);
  assert.equal(authored.deploy.worker.name, config.deploy.worker.name);
  for (const [index, binding] of authored.deploy.worker.services.entries()) {
    assert.deepEqual(
      {
        ...binding,
        fragments: binding.fragments.toSorted((a, b) =>
          a.expose.localeCompare(b.expose),
        ),
      },
      service(generatedWorkerCoordinates.remotes[index], true),
    );
    assert.equal(binding.fragments[0], defaults[index].fragments[0]);
  }
  assert.equal(authorGeneratedWorkerRoutes(config, []), config);
  assert.throws(
    () =>
      authorGeneratedWorkerRoutes(
        {
          deploy: {
            worker: { services: [defaults[0], defaults[0], defaults[1]] },
          },
        },
        generatedWorkerCoordinates.remotes,
      ),
    /Expected at most one topology-owned Worker binding/u,
  );
});

test('route authoring follows public generation before remotes and Worker name overrides exist', () => {
  const remotes = generatedWorkerCoordinates.remotes;
  for (let count = 0; count <= remotes.length; count++) {
    const defaults = remotes.slice(0, count).map(remote => ({
      ...service(remote, false),
      service: remote.id,
    }));
    const config = { deploy: { worker: { services: defaults } } };
    const authored = authorGeneratedWorkerRoutes(config, remotes);
    assert.equal(authored.deploy.worker.services.length, count);
    assert.deepEqual(config.deploy.worker.services, defaults);
    for (const [index, binding] of authored.deploy.worker.services.entries()) {
      assert.equal(binding.service, remotes[index].id);
      assert.equal(binding.binding, defaults[index].binding);
      assert.deepEqual(
        binding.fragments.map(fragment => fragment.expose),
        ['./Widget', './Route'],
      );
      assert.equal(binding.fragments[0], defaults[index].fragments[0]);
      assert.deepEqual(
        binding.fragments[1],
        service(remotes[index], true).fragments[0],
      );
    }
  }
  const incomplete = result();
  incomplete.generation.workerServices[0].services.pop();
  assert.throws(() => assertGeneratedWorkerResult(incomplete));
});

test('public source overlays retain generated strict inputs and never author renderer identities', t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'worker-generation-input-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generatedApp = {
    ...generatedWorkerCoordinates.host,
    packageName: '@generated-worker-federation/shell-super-app',
    renderer: 'octane',
  };
  const appRoot = path.join(root, generatedApp.directory);
  fs.mkdirSync(appRoot, { recursive: true });
  const manifest = {
    name: generatedApp.packageName,
    private: true,
    modernjs: { appId: generatedApp.id },
    dependencies: {
      preserved: '1.0.0',
      '@tsrx/oxc': '0.20.0',
      '@modern-js/renderer-core': 'catalog:ultramodern',
    },
    devDependencies: { typescript: '7.0.2' },
  };
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify(manifest),
  );
  const strict = JSON.stringify({
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      exactOptionalPropertyTypes: true,
    },
  });
  fs.writeFileSync(path.join(appRoot, 'tsconfig.json'), strict);
  const modelRoot = path.join(root, 'packages/shared-contracts');
  fs.mkdirSync(modelRoot, { recursive: true });
  const modelManifest = {
    scripts: {
      typecheck:
        'ultramodern-create ultramodern typecheck --project tsconfig.json',
    },
    devDependencies: { '@effect/tsgo': '0.53.1' },
  };
  fs.writeFileSync(
    path.join(modelRoot, 'package.json'),
    JSON.stringify(modelManifest),
  );
  fs.writeFileSync(
    path.join(modelRoot, 'tsconfig.json'),
    JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        composite: true,
        declaration: true,
        emitDeclarationOnly: true,
      },
      include: ['src'],
    }),
  );
  fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true });
  const generatedEnv =
    '/// <reference types="@modern-js/ultramodern-app-tools/react-types" />\ndeclare const ULTRAMODERN_SITE_URL: string;\n';
  fs.writeFileSync(path.join(appRoot, 'src/modern-app-env.d.ts'), generatedEnv);

  const workspacePolicy = path.join(root, 'pnpm-workspace.yaml');
  fs.writeFileSync(
    workspacePolicy,
    'catalogs:\n  ultramodern:\n    "@modern-js/renderer-core": "1.0.0"\n',
  );
  const dependencies = Object.fromEntries(
    [
      '@modern-js/ultramodern-app-tools',
      '@modern-js/renderer-octane',
      '@modern-js/renderer-core',
      '@modern-js/i18n-runtime-extensions',
      'octane',
      'i18next',
    ].map(name => [name, '1.0.0']),
  );
  const overlayInput = {
    operation: 'workspace',
    outputWorkspaceRoot: root,
    generatedApp,
    origins: [
      'http://127.0.0.1:41000',
      'http://127.0.0.1:41001',
      'http://127.0.0.1:41002',
    ],
    services: {
      host: [{ binding: 'REMOTE_A' }, { binding: 'REMOTE_B' }],
      remoteA: [{ binding: 'REMOTE_B' }],
    },
    dependencies,
  };
  authorGeneratedWorkerApplication(overlayInput);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(appRoot, 'tsconfig.json'), 'utf8')),
    {
      ...JSON.parse(strict),
      references: [{ path: '../../packages/shared-counter' }],
    },
  );
  assert.equal(
    fs.readFileSync(path.join(appRoot, 'src/modern-app-env.d.ts'), 'utf8'),
    generatedEnv,
  );
  assert.match(
    fs.readFileSync(path.join(appRoot, 'src/worker-proof-env.d.ts'), 'utf8'),
    /export interface OctaneWorkerProofObservations \{.*\}\ndeclare global \{ var __octaneWorkerProof: OctaneWorkerProofObservations \| undefined; \}/u,
  );
  const sharedRoot = path.join(root, generatedWorkerSharedCounter.directory);
  const sharedManifest = JSON.parse(
    fs.readFileSync(path.join(sharedRoot, 'package.json'), 'utf8'),
  );
  assert.equal(sharedManifest.name, generatedWorkerSharedCounter.name);
  assert.deepEqual(sharedManifest.exports, { '.': './src/counter.tsx' });
  assert.deepEqual(sharedManifest.dependencies, {
    octane: dependencies.octane,
  });
  assert.deepEqual(
    sharedManifest.devDependencies,
    modelManifest.devDependencies,
  );
  const sharedConfig = JSON.parse(
    fs.readFileSync(path.join(sharedRoot, 'tsconfig.json'), 'utf8'),
  );
  assert.equal(sharedConfig.extends, '../../tsconfig.base.json');
  assert.equal(sharedConfig.compilerOptions.composite, true);
  assert.equal(sharedConfig.compilerOptions.jsxImportSource, 'octane');
  assert.deepEqual(sharedConfig.include, ['src']);
  assert.deepEqual(sharedConfig.compilerOptions.types, []);
  assert.match(
    fs.readFileSync(
      path.join(sharedRoot, generatedWorkerSharedCounter.source),
      'utf8',
    ),
    /signal\$\(3\)/u,
  );
  assert.match(
    fs.readFileSync(path.join(appRoot, 'src/components/shell.tsx'), 'utf8'),
    /from '@authored-worker\/shared-counter'/u,
  );

  const authoredManifest = JSON.parse(
    fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
  );
  assert.equal(authoredManifest.dependencies.preserved, '1.0.0');
  assert.equal(
    authoredManifest.dependencies[generatedWorkerSharedCounter.name],
    'workspace:*',
  );
  assert.equal(authoredManifest.dependencies['@tsrx/oxc'], '0.20.0');
  assert.equal(
    authoredManifest.dependencies['@modern-js/renderer-core'],
    'catalog:ultramodern',
  );
  assert.equal(authoredManifest.dependencies.i18next, dependencies.i18next);
  assert.deepEqual(authoredManifest.modernjs, manifest.modernjs);
  assert.deepEqual(authoredManifest.devDependencies, manifest.devDependencies);
  assert.equal(
    fs.existsSync(path.join(appRoot, 'shared/ultramodern-build.json')),
    false,
  );
  const authoredConfig = fs.readFileSync(
    path.join(appRoot, 'modern.config.ts'),
    'utf8',
  );
  assert.match(authoredConfig, /deployTarget: 'cloudflare'/u);
  assert.match(
    authoredConfig,
    /defineConfig\(authorGeneratedWorkerRoutes\(config,/u,
  );
  assert.match(authoredConfig, /expose: ['"]\.\/Route['"]/u);
  assert.deepEqual(
    generatedWorkerDeploymentInput(generatedApp, overlayInput.services),
    { worker: { name: `proof-${generatedApp.id}`, ssr: true } },
  );
  assert.deepEqual(
    generatedWorkerDeploymentInput(
      generatedWorkerCoordinates.remotes[0],
      overlayInput.services,
    ).worker.services,
    overlayInput.services.remoteA,
  );
  assert.match(
    fs.readFileSync(path.join(appRoot, 'src/components/shell.tsx'), 'utf8'),
    /federatedComponent<RemoteProps>/u,
  );
  for (const catalog of [
    'catalogs:\n  ultramodern:\n    "@modern-js/renderer-core": "2.0.0"\n',
    'catalogs:\n  ultramodern: {}\n',
  ]) {
    fs.writeFileSync(workspacePolicy, catalog);
    assert.throws(
      () => authorGeneratedWorkerApplication(overlayInput),
      /renderer-core must resolve to the authenticated candidate request/u,
    );
  }
});

test('vertical authoring preserves an already formatted shared Counter', t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'worker-formatted-overlay-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(
    root,
    generatedWorkerSharedCounter.directory,
    generatedWorkerSharedCounter.source,
  );
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  const formatted =
    '/* Public generator formatted this shared source. */\nexport function Counter() {\n  return <button>0</button>;\n}\n';
  fs.writeFileSync(shared, formatted);
  const generatedApp = {
    ...generatedWorkerCoordinates.remotes[0],
    renderer: 'octane',
    packageName: '@generated/remote-a',
  };
  const appRoot = path.join(root, generatedApp.directory);
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({
      name: generatedApp.packageName,
      modernjs: { appId: generatedApp.id },
      dependencies: { baseline: '1.0.0', '@tsrx/oxc': '0.20.0' },
    }),
  );
  fs.writeFileSync(
    path.join(appRoot, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }),
  );
  const config = {
    operation: 'vertical',
    outputWorkspaceRoot: root,
    generatedApp,
    origins,
    services: {
      host: [{ binding: 'REMOTE_A' }, { binding: 'REMOTE_B' }],
      remoteA: [{ binding: 'REMOTE_B' }],
    },
    dependencies: Object.fromEntries(
      [
        '@modern-js/ultramodern-app-tools',
        '@modern-js/renderer-octane',
        '@modern-js/renderer-core',
        '@modern-js/i18n-runtime-extensions',
        'octane',
        'i18next',
      ].map(name => [name, '1.0.0']),
    ),
  };
  authorGeneratedWorkerApplication(config);
  assert.equal(fs.readFileSync(shared, 'utf8'), formatted);
  fs.unlinkSync(shared);
  assert.throws(() => authorGeneratedWorkerApplication(config));
});
