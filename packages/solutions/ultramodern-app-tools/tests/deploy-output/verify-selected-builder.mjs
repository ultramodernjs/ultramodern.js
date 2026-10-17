import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const compositionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const compositionRequire = createRequire(
  path.join(compositionRoot, 'package.json'),
);
const appToolsRequire = createRequire(
  compositionRequire.resolve('@modern-js/app-tools'),
);
const builderRequire = createRequire(appToolsRequire.resolve('@rsbuild/core'));

function packageOwner(file, name) {
  for (
    let directory = path.dirname(file);
    ;
    directory = path.dirname(directory)
  ) {
    const manifest = path.join(directory, 'package.json');
    if (
      fs.existsSync(manifest) &&
      JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name
    )
      return directory;
    assert.notEqual(
      path.dirname(directory),
      directory,
      `Missing ${name} owner`,
    );
  }
}

// This runs after the normal build in plain Node. Unlike the source unit
// runner, it cannot redirect app-root package lookup to workspace dependencies.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-builder-alias-'));
try {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      dependencies: {
        'selected-tools': 'npm:@modern-js/ultramodern-app-tools@3.8.3',
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'module-federation.config.mjs'),
    `export default { name: 'remote', exposes: { './Widget': './Widget.tsrx' }, manifest: { filePath: 'browser/meta', fileName: 'graph.json' } };`,
  );
  fs.mkdirSync(path.join(root, 'node_modules/@modern-js'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/@module-federation'), {
    recursive: true,
  });
  fs.symlinkSync(
    compositionRoot,
    path.join(root, 'node_modules/selected-tools'),
  );
  fs.symlinkSync(
    path.resolve(compositionRoot, '../../runtime/renderer-octane'),
    path.join(root, 'node_modules/@modern-js/renderer-octane'),
  );
  fs.symlinkSync(
    packageOwner(
      builderRequire.resolve('@module-federation/enhanced/rspack'),
      '@module-federation/enhanced',
    ),
    path.join(root, 'node_modules/@module-federation/enhanced'),
  );

  const applicationRequire = createRequire(path.join(root, 'package.json'));
  assert.throws(() => applicationRequire.resolve('@modern-js/app-tools'), {
    code: 'MODULE_NOT_FOUND',
  });
  const selected = applicationRequire.resolve('selected-tools');
  assert.ok(selected.startsWith(fs.realpathSync(compositionRoot) + path.sep));
  const { nativeModuleFederationPlugin } = applicationRequire(
    path.join(path.dirname(selected), 'native-module-federation.js'),
  );
  const hooks = {};
  const api = new Proxy(
    {
      getAppContext: () => ({
        appDirectory: root,
        internalDirectory: path.join(root, 'node_modules/.modern-js'),
        command: 'dev',
      }),
      getNormalizedConfig: () => ({}),
    },
    {
      get: (target, key) =>
        key in target
          ? target[key]
          : hook => {
              hooks[key] = hook;
            },
    },
  );
  nativeModuleFederationPlugin('octane').setup(api);
  const aliases = new Map();
  const plugins = new Map();
  await hooks.modifyBundlerChain(
    {
      resolve: { alias: { set: (key, value) => aliases.set(key, value) } },
      plugin: key => ({
        use: (Plugin, args) => plugins.set(key, { Plugin, args }),
      }),
      entryPoints: { entries: () => ({}) },
    },
    { environment: { name: 'client' } },
  );
  const client = path.join(
    root,
    'node_modules/.modern-js/federation/native-dev-client.mjs',
  );
  const hmr = path.join(
    path.dirname(appToolsRequire.resolve('@rsbuild/core')),
    'client/hmr.js',
  );
  assert.ok(fs.existsSync(hmr));
  assert.deepEqual([...aliases], [[`${hmr}$`, client]]);
  assert.ok(fs.readFileSync(client, 'utf8').includes('remoteName: "remote"'));
  assert.deepEqual(
    plugins.get('ultramodern-federation-dev-browser-assets')?.args,
    ['remote', { browserManifest: 'browser/meta/graph.json' }],
  );
  console.log(
    'Verified the aliased composition uses its installed builder client.',
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
