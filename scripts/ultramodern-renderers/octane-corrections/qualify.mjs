import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assetFilename } from '../native-artifacts/protocol.mjs';
import { packFiles } from '../native-artifacts/reconstruct.mjs';
import { cohort, references } from './inputs.mjs';

export function installRouterRenderSnapshot({ here, sourcePackage }) {
  const bytes = fs.readFileSync(path.join(here, 'routerRenderSnapshot.ts.txt'));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    references.snapshotSourceSha256,
    'Immutable router snapshot payload differs from the canonical source',
  );
  fs.writeFileSync(
    path.join(sourcePackage, 'src/ssr/routerRenderSnapshot.ts'),
    bytes,
  );
}

export async function qualify({
  work,
  sourceRoot,
  corrected,
  here,
  run,
  disk,
  register,
  applyExactPatch,
  verifyIntegrity,
  packedDirectory,
  assertSameLayout,
}) {
  const repository = path.resolve(here, '../../..');
  const corePatch = path.join(
    repository,
    'patches/@tanstack__router-core@1.171.39.patch',
  );
  assert(
    fs.existsSync(corePatch),
    'Parent must supply the qualified router-core canonical patch',
  );
  const response = await fetch(
    'https://registry.npmjs.org/@tanstack/router-core/-/router-core-1.171.39.tgz',
    { signal: AbortSignal.timeout(30000) },
  );
  assert(response.ok);
  const coreBytes = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(
    coreBytes,
    'sha512-qUhoJ0meuSUqGYQbHbcJYdASr06YtK+bulbj6vtrhKYFkLgkSsZ6tXmMyym7sFxiSJSPYgasgozrL01LyyR/6A==',
  );
  fs.writeFileSync(path.join(work, 'core.tgz'), coreBytes);
  const core = path.join(work, 'core');
  fs.mkdirSync(core);
  run(
    'tar',
    ['-xzf', path.join(work, 'core.tgz'), '--strip-components=1', '-C', core],
    work,
  );
  applyExactPatch(core, corePatch);
  const pack = directory =>
    packFiles(
      new Map(
        fs
          .readdirSync(directory, { recursive: true })
          .filter(file => fs.lstatSync(path.join(directory, file)).isFile())
          .map(file => [
            file,
            {
              bytes: fs.readFileSync(path.join(directory, file)),
              mode: fs.statSync(path.join(directory, file)).mode,
            },
          ]),
      ),
    );
  let correctedCoreBytes = pack(core);
  if (packedDirectory) {
    correctedCoreBytes = fs.readFileSync(
      path.join(
        packedDirectory,
        assetFilename('@tanstack/router-core', '1.171.39'),
      ),
    );
    const transported = path.join(work, 'transported-core');
    fs.mkdirSync(transported);
    const archive = path.join(work, 'transported-core.tgz');
    fs.writeFileSync(archive, correctedCoreBytes);
    run(
      'tar',
      ['-xzf', archive, '--strip-components=1', '-C', transported],
      work,
    );
    assertSameLayout(transported, core);
  }
  const adapterBytes = packedDirectory
    ? fs.readFileSync(
        path.join(
          packedDirectory,
          assetFilename('@octanejs/tanstack-router', '0.3.4'),
        ),
      )
    : pack(corrected);
  const { qualifySharedCorePeer } = await import(
    './qualify-shared-core-peer.mjs'
  );
  qualifySharedCorePeer({
    work,
    adapterBytes,
    coreBytes: correctedCoreBytes,
    run: (command, args, cwd, options = {}) =>
      run(command, args, cwd, { ...options, stdio: 'pipe', encoding: 'utf8' }),
    disk,
    register,
  });
  const deps = path.join(work, 'dependencies');
  fs.mkdirSync(deps);
  fs.writeFileSync(
    path.join(deps, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          ...cohort,
          '@tanstack/router-core': 'file:../core',
          octane: '0.18.0',
          '@tsrx/core': '0.6.1',
          vite: '8.0.16',
          vitest: '4.1.10',
          esbuild: '0.28.1',
          '@volar/language-core': '2.4.28',
          '@volar/typescript': '2.4.28',
          'es-module-lexer': '1.7.0',
          esrap: '2.4.0',
        },
      },
      null,
      2,
    ),
  );
  disk();
  register(path.join(deps, 'node_modules'), 'dependencies');
  run(
    'pnpm',
    [
      'install',
      '--ignore-scripts',
      '--config.manage-package-manager-versions=false',
      '--store-dir',
      '/Users/satan/.pnpm-store',
      '--config.package-import-method=clone-or-copy',
    ],
    deps,
  );
  register(path.join(deps, 'node_modules'), 'dependencies');
  // Operation-owned module links, never links to someone else's writable tree.
  const modules = path.join(deps, 'node_modules');
  fs.symlinkSync(modules, path.join(sourceRoot, 'node_modules'));
  fs.symlinkSync(modules, path.join(corrected, 'node_modules'));
  fs.symlinkSync(modules, path.join(work, 'node_modules'));
  const sourcePackage = path.join(sourceRoot, 'packages/tanstack-router');
  installRouterRenderSnapshot({ here, sourcePackage });
  fs.appendFileSync(
    path.join(sourcePackage, 'src/index.ts'),
    "\nexport * from './ssr/routerRenderSnapshot';\n",
  );
  fs.appendFileSync(
    path.join(sourcePackage, 'src/ssr/server.ts'),
    "\nexport * from './routerRenderSnapshot';\n",
  );
  for (const [mode, pkg] of [
    ['source', sourcePackage],
    ['packed', corrected],
  ]) {
    const tests = path.join(work, `${mode}-tests`);
    fs.mkdirSync(tests);
    fs.cpSync(path.join(here, 'tests'), tests, { recursive: true });
    const config = path.join(work, `${mode}.config.mjs`);
    fs.writeFileSync(
      config,
      `import { defineConfig } from 'vitest/config';
import { octane } from ${JSON.stringify(path.join(sourceRoot, 'packages/octane/src/compiler/vite.js'))};
export default defineConfig({ plugins: [octane({ssr:true})], resolve: { alias: [
{find:/^@octanejs\\/tanstack-router\\/history$/,replacement:${JSON.stringify(path.join(pkg, 'src/history.ts'))}},
{find:/^@octanejs\\/tanstack-router$/,replacement:${JSON.stringify(path.join(pkg, 'src/index.ts'))}}
]}, test:{environment:'node',include:[${JSON.stringify(`${tests}/router-render-snapshot.test.ts`)}],maxWorkers:1} });`,
    );
    run(
      process.execPath,
      [path.join(modules, 'vitest/vitest.mjs'), 'run', '--config', config],
      work,
    );
  }
  console.log(
    `Adapter source+packed 59/59 each; router-core correction SHA256 ${createHash('sha256').update(fs.readFileSync(corePatch)).digest('hex')}`,
  );
}
