import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  OctaneCompilerManifestPlugin,
} = require('../src/plugin/compiler-manifest.cjs');
// The hook model invokes the normally built public admission implementation,
// rather than replacing its source/asset validation with a shape stub.
const { validateOctaneModuleManifest } = require('../dist/cjs/manifest.js');
const sha256 = source => createHash('sha256').update(source).digest('hex');

function compileManifest({
  containerType = 'container entry',
  sharedAndRepeatedVisits = false,
} = {}) {
  const root = '/authored/workspace/verticals/catalog';
  const identity = entryName => ({
    renderer: 'octane',
    appId: 'catalog',
    entryName,
    protocolVersion: 1,
    buildId: `catalog-${entryName}`,
  });
  const chunk = (file, referenced = []) => ({
    files: new Set([file]),
    getAllReferencedChunks: () => new Set(referenced),
  });
  const shared = sharedAndRepeatedVisits
    ? chunk('static/js/shared.js')
    : undefined;
  const sharedReferences = shared ? [shared] : [];
  const exposed = chunk('static/js/Widget.js');
  const container = chunk('remoteEntry.js', [exposed, ...sharedReferences]);
  const main = chunk('static/js/main.js', sharedReferences);
  const admin = chunk('static/js/admin.js', sharedReferences);
  const module = (relative, selectedChunk) => ({
    resource: path.resolve(root, relative),
    identifier: () => relative,
    originalSource: () => ({
      buffer: () => Buffer.from(`compiled ${relative}`),
    }),
    buildInfo: {
      octane: {
        canonicalId: `catalog:${relative}`,
        transformKind: 'compile',
        serverRpc: false,
      },
    },
    selectedChunk,
  });
  const modules = [
    module('src/routes/page.tsx', main),
    module('../../shared/Counter.tsx', exposed),
    module('src/admin/Admin.tsx', admin),
  ];
  if (shared) {
    modules.push(module('src/shared/Format.ts', shared));
    // Rspack can enumerate a module both directly and through concatenation.
    // Repeated visits must not duplicate native provenance or chunk hashes.
    modules.push(modules[1], modules[3]);
  }
  const emitted = new Map();
  const assets = new Map(
    [main, admin, container, exposed, ...sharedReferences].flatMap(selected =>
      [...selected.files].map(file => [
        file,
        { source: { buffer: () => Buffer.from(`asset ${file}`) } },
      ]),
    ),
  );
  assets.set('octane-client-build.json', {
    source: {
      source: () => JSON.stringify({ version: 1, buildId: 'native-hash' }),
    },
  });
  let publish;
  const compilation = {
    hash: 'native-hash',
    errors: [],
    modules,
    entries: new Map([
      ['main', { dependencies: [{ type: 'entry' }] }],
      ['admin', { dependencies: [{ type: 'entry' }] }],
      ['catalogContainer', { dependencies: [{ type: containerType }] }],
    ]),
    entrypoints: new Map([
      ['main', { chunks: [main] }],
      ['admin', { chunks: [admin] }],
      ['catalogContainer', { chunks: [container] }],
    ]),
    chunkGraph: {
      getModuleChunksIterable: module => [module.selectedChunk],
      getModuleId: module => module.identifier(),
    },
    hooks: {
      processAssets: {
        tap: (_options, callback) => {
          publish = callback;
        },
      },
    },
    getAsset: file => assets.get(file),
    emitAsset: (file, source) => emitted.set(file, JSON.parse(source.source())),
  };
  let onCompilation;
  const compiler = {
    hooks: {
      normalModuleFactory: { tap: () => {} },
      thisCompilation: {
        tap: (_name, callback) => {
          onCompilation = callback;
        },
      },
    },
    webpack: {
      Compilation: { PROCESS_ASSETS_STAGE_REPORT: 5000 },
      sources: {
        RawSource: class {
          constructor(value) {
            this.value = value;
          }
          source() {
            return this.value;
          }
        },
      },
    },
  };
  new OctaneCompilerManifestPlugin({
    root,
    emitClientManifest: true,
    runtimeVersion: '0.13.8',
    compilerVersion: '0.2.4',
    rendererIdentities: () => ({
      main: identity('main'),
      admin: identity('admin'),
    }),
    manifestFilename: entryName => `native-${entryName}.json`,
    validateManifest: validateOctaneModuleManifest,
  }).apply(compiler);
  onCompilation(compilation);
  publish();
  return { emitted, modules };
}

test('each document authenticates the same-compilation MF expose closure without another document', () => {
  const { emitted, modules } = compileManifest();
  const main = emitted.get('native-main.json');
  const admin = emitted.get('native-admin.json');
  assert.deepEqual(
    main.assets.map(asset => asset.file),
    ['remoteEntry.js', 'static/js/Widget.js', 'static/js/main.js'],
  );
  assert.deepEqual(
    admin.assets.map(asset => asset.file),
    ['remoteEntry.js', 'static/js/Widget.js', 'static/js/admin.js'],
  );
  assert.equal(main.rendererIdentity.entryName, 'main');
  assert.equal(admin.rendererIdentity.entryName, 'admin');
  assert(
    !main.sourceModules.some(
      source => source.resource === 'src/admin/Admin.tsx',
    ),
  );
  assert(
    !admin.sourceModules.some(
      source => source.resource === 'src/routes/page.tsx',
    ),
  );
  for (const manifest of [main, admin]) {
    const counter = manifest.sourceModules.find(
      source => source.resource === '../../shared/Counter.tsx',
    );
    assert(
      counter,
      'The exposed native Counter must have provenance in its publication.',
    );
    assert.equal(counter.canonicalId, 'catalog:../../shared/Counter.tsx');
    assert.equal(counter.transformKind, 'compile');
    assert.equal(
      counter.emittedSourceSha256,
      sha256(modules[1].originalSource().buffer()),
    );
    assert.deepEqual(counter.assets, ['static/js/Widget.js']);
    for (const asset of manifest.assets)
      assert.equal(asset.sha256, sha256(`asset ${asset.file}`));
  }
});

test('an ordinary entry named as a container cannot expand native provenance', () => {
  const { emitted } = compileManifest({ containerType: 'entry' });
  assert.deepEqual(
    emitted.get('native-main.json').assets.map(asset => asset.file),
    ['static/js/main.js'],
  );
  assert.deepEqual(
    emitted.get('native-admin.json').assets.map(asset => asset.file),
    ['static/js/admin.js'],
  );
  for (const manifest of emitted.values())
    assert(
      !manifest.sourceModules.some(
        source => source.resource === '../../shared/Counter.tsx',
      ),
    );
});

test('shared chunks and repeated native module visits retain unique validated provenance', () => {
  const { emitted } = compileManifest({ sharedAndRepeatedVisits: true });
  for (const [filename, manifest] of emitted) {
    assert.equal(
      new Set(manifest.assets.map(asset => asset.file)).size,
      manifest.assets.length,
    );
    assert.equal(
      manifest.sourceModules.filter(
        source => source.resource === '../../shared/Counter.tsx',
      ).length,
      1,
    );
    const shared = manifest.sourceModules.filter(
      source => source.resource === 'src/shared/Format.ts',
    );
    assert.equal(shared.length, 1);
    assert.deepEqual(shared[0].assets, ['static/js/shared.js']);
    assert.equal(
      manifest.assets.find(asset => asset.file === 'static/js/shared.js')
        .sha256,
      sha256('asset static/js/shared.js'),
    );
    const foreignDocument =
      filename === 'native-main.json'
        ? 'static/js/admin.js'
        : 'static/js/main.js';
    assert(!manifest.assets.some(asset => asset.file === foreignDocument));
  }
});
