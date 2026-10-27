import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { type Rspack, rspack } from '@rsbuild/core';
import { NativeFederationDevAssetsPlugin } from '../../src/native-composition/native-federation-dev-assets';

test('hot graph publication does not read the previous runtime hash', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        'native-hot-public-path-',
      ),
    ),
  );
  let compiler: Rspack.Compiler | null = null;
  try {
    const publicPath = 'http://localhost:43123/assets/';
    fs.writeFileSync(
      path.join(root, 'entry.js'),
      'globalThis.fixture = true;\n',
    );
    compiler = rspack({
      context: root,
      mode: 'development',
      devtool: false,
      entry: { test_remote: './entry.js' },
      output: { path: path.join(root, 'dist'), publicPath },
      plugins: [
        new NativeFederationDevAssetsPlugin('test_remote', {
          browserManifest: 'mf-manifest.json',
        }),
        {
          apply(current) {
            current.hooks.thisCompilation.tap(
              'FixtureGraphManifest',
              compilation => {
                compilation.hooks.processAssets.tap(
                  {
                    name: 'FixtureManifest',
                    stage: rspack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
                  },
                  () =>
                    compilation.emitAsset(
                      'mf-manifest.json',
                      new rspack.sources.RawSource(
                        JSON.stringify({
                          metaData: { name: 'test_remote', publicPath },
                        }),
                      ),
                    ),
                );
              },
            );
          },
        },
      ],
    });
    if (!compiler) throw new Error('Fixture compiler was not created');
    const fixtureCompiler = compiler;
    const stats = await new Promise<Rspack.Stats>((resolve, reject) => {
      fixtureCompiler.run((error, result) => {
        if (error) return reject(error);
        if (!result || result.hasErrors())
          return reject(
            new Error(result?.toString() ?? 'Missing compiler stats'),
          );
        resolve(result);
      });
    });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'dist/mf-manifest.json'), 'utf8'),
    );
    expect(manifest.metaData.publicPath).toContain(stats.compilation.fullHash);
    const emitted = fs.readFileSync(
      path.join(root, 'dist/test_remote.js'),
      'utf8',
    );
    // Read the final emitted assignment, not the early runtimeModule hook
    // snapshot, which Rspack regenerates during full hashing.
    const source = emitted
      .match(/__webpack_require__\.p\s*=\s*[^;\n]+;/gu)
      ?.at(-1);
    if (!source) throw new Error('Graph publicPath assignment was not emitted');
    // HMR can execute this module before installing the new native hash
    // getter. The graph coordinate must still match the compiled manifest.
    const runtime = { h: () => 'previous-runtime-hash', p: '' };
    vm.runInNewContext(source, { __webpack_require__: runtime });
    expect(runtime.p).toBe(manifest.metaData.publicPath);
  } finally {
    try {
      if (compiler) {
        const fixtureCompiler = compiler;
        await new Promise<void>((resolve, reject) => {
          fixtureCompiler.close(error => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
