import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const adapter = path.join(workspace, 'packages/runtime/renderer-octane');
const require = createRequire(path.join(adapter, 'package.json'));
const directory = path.join(adapter, 'src/plugin');
const { OctaneCompilerManifestPlugin } = require(
  path.join(directory, 'compiler-manifest.cjs'),
);

function emitManifest(versions, validateManifest) {
  const emitted = new Map();
  const hash = 'actual-native-compilation';
  const chunk = { files: ['main.js'], getAllReferencedChunks: () => [] };
  const identity = {
    renderer: 'octane',
    appId: 'version-binding-test',
    entryName: 'main',
    protocolVersion: 1,
    buildId: 'source-build-identity',
  };
  const source = value => ({
    source: () => value,
    buffer: () => Buffer.from(value),
  });
  const compilation = {
    errors: [],
    hash,
    modules: [],
    // Ordinary application control: no Module Federation container entries.
    entries: new Map(),
    entrypoints: new Map([['main', { chunks: [chunk] }]]),
    getAsset(file) {
      return {
        source: source(
          file === 'octane-client-build.json'
            ? JSON.stringify({ version: 1, buildId: hash })
            : 'console.log("native output");',
        ),
      };
    },
    emitAsset(file, asset) {
      emitted.set(file, JSON.parse(asset.source()));
    },
    hooks: {
      processAssets: {
        tap(_options, callback) {
          callback();
        },
      },
    },
  };
  const plugin = new OctaneCompilerManifestPlugin({
    ...versions,
    emitClientManifest: true,
    root: workspace,
    rendererIdentities: () => ({ main: identity }),
    manifestFilename: name => `${name}.json`,
    validateManifest,
  });
  plugin.apply({
    options: { module: { rules: [] } },
    hooks: {
      normalModuleFactory: { tap() {} },
      thisCompilation: {
        tap(_name, callback) {
          callback(compilation);
        },
      },
    },
    webpack: {
      Compilation: { PROCESS_ASSETS_STAGE_REPORT: 0 },
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
  });
  return emitted.get('main.json');
}

test('the owning manifest producer forwards selected SDK versions', () => {
  for (const versions of [
    { runtimeVersion: '0.7.1+selected.first', compilerVersion: '0.1.55' },
    { runtimeVersion: '0.7.1+selected.second', compilerVersion: '0.1.56' },
  ]) {
    const manifest = emitManifest(versions, candidate => {
      assert.equal(candidate.runtimeVersion, versions.runtimeVersion);
      assert.equal(candidate.compilerVersion, versions.compilerVersion);
    });
    assert.equal(manifest.runtimeVersion, versions.runtimeVersion);
    assert.equal(manifest.compilerVersion, versions.compilerVersion);
  }
});

test('a stale SDK version is rejected before the manifest is emitted', () => {
  assert.throws(
    () =>
      emitManifest(
        { runtimeVersion: '0.7.1', compilerVersion: '0.1.55' },
        candidate => assert.equal(candidate.runtimeVersion, '0.7.1+selected'),
      ),
    /0\.7\.1/u,
  );
});

test('the factory binds canonical versions only to its owning manifest plugin', async () => {
  const rsbuild = path.dirname(require.resolve('@rsbuild/core/package.json'));
  const { createJiti } = await import(
    pathToFileURL(path.join(rsbuild, 'compiled/jiti/lib/jiti.mjs'))
  );
  const jiti = createJiti(import.meta.url, {
    tryNative: false,
    alias: {
      '@modern-js/renderer-octane/manifest': path.join(
        workspace,
        'packages/runtime/renderer-octane/src/manifest.ts',
      ),
    },
  });
  const { createOctaneCompilerPlugin } = await jiti.import(
    path.join(directory, 'compiler.ts'),
  );
  const { OCTANE_RUNTIME_VERSION, OCTANE_COMPILER_VERSION } = await jiti.import(
    path.join(adapter, 'src/manifest.ts'),
  );
  const compiler = createOctaneCompilerPlugin({
    rendererIdentities: () => ({}),
    workerEnvironmentName: 'workerSSR',
  });
  let config;
  compiler.setup({
    context: { rootPath: adapter },
    modifyRsbuildConfig() {},
    modifyRspackConfig(callback) {
      config = { target: 'web' };
      callback(config, { environment: { name: 'client' } });
    },
  });
  assert.equal(config.plugins.length, 2);
  const native = config.plugins[0];
  const manifest = config.plugins[1];
  assert.equal(Object.hasOwn(native.options, 'runtimeVersion'), false);
  assert.equal(Object.hasOwn(native.options, 'compilerVersion'), false);
  assert.equal(manifest.options.runtimeVersion, OCTANE_RUNTIME_VERSION);
  assert.equal(manifest.options.compilerVersion, OCTANE_COMPILER_VERSION);
});

test('the factory uses the application compiler rather than the SDK compiler', async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'octane-app-compiler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
  const compiler = path.join(root, 'node_modules/@octanejs/rspack-plugin');
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(
    path.join(compiler, 'index.js'),
    `exports.inferRspackEnvironment = () => 'client';
exports.OctaneRspackPlugin = class ApplicationCompiler {
  constructor(options) { this.options = options; }
};`,
  );
  const rsbuild = path.dirname(require.resolve('@rsbuild/core/package.json'));
  const { createJiti } = await import(
    pathToFileURL(path.join(rsbuild, 'compiled/jiti/lib/jiti.mjs'))
  );
  const { createOctaneCompilerPlugin } = await createJiti(import.meta.url, {
    tryNative: false,
  }).import(path.join(directory, 'compiler.ts'));
  let config;
  createOctaneCompilerPlugin({ rendererIdentities: () => ({}) }).setup({
    context: { rootPath: root },
    modifyRsbuildConfig() {},
    modifyRspackConfig(callback) {
      config = { target: 'web' };
      callback(config, { environment: { name: 'client' } });
    },
  });
  assert.equal(config.plugins[0].constructor.name, 'ApplicationCompiler');
  assert.equal(config.plugins[0].options.root, root);
});
