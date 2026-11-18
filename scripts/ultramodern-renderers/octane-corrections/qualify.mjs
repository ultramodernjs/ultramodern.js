import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assetFilename } from '../native-artifacts/protocol.mjs';
import { packFiles } from '../native-artifacts/reconstruct.mjs';
import { cohort, references } from './inputs.mjs';
import {
  assertSharedCoreManifest,
  defaultOctaneCandidate,
  sharedCoreCandidate,
  sharedCoreVersion,
} from './shared-core-peer.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
/** Node's package lookup from a directory, without consulting exports maps. */
export function installedPackage(from, name) {
  for (let directory = path.resolve(from); ; ) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json')))
      return fs.realpathSync(candidate);
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `${from}: ${name} is not installed`);
    directory = parent;
  }
}
/** The owning source tree is the exact candidate octane + adapter release. */
export function assertCandidateSource(sourceRoot, pinned) {
  for (const [directory, item] of [
    ['packages/octane', pinned.octane],
    ['packages/tanstack-router', pinned.adapter],
  ]) {
    const manifest = readJson(path.join(sourceRoot, directory, 'package.json'));
    assert.equal(manifest.name, item.name, `${directory}: owning package`);
    assert.equal(
      manifest.version,
      item.version,
      `${pinned.candidate}: source ${item.name} is not ${item.version}`,
    );
  }
}

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
  octaneCandidate = defaultOctaneCandidate,
}) {
  // Reject an unknown candidate before any fetch, install or write.
  sharedCoreCandidate(octaneCandidate);
  const { qualifySharedCorePeer, pinnedAdapterCandidate, lockedIntegrity } =
    await import('./qualify-shared-core-peer.mjs');
  const pinned = pinnedAdapterCandidate(octaneCandidate);
  assertCandidateSource(sourceRoot, pinned);
  const correctedManifest = readJson(path.join(corrected, 'package.json'));
  assertSharedCoreManifest(correctedManifest, octaneCandidate);
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
  const coreManifest = readJson(path.join(core, 'package.json'));
  assert.equal(coreManifest.name, '@tanstack/router-core');
  assert.equal(coreManifest.version, sharedCoreVersion);
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
          assetFilename('@octanejs/tanstack-router', pinned.adapterVersion),
        ),
      )
    : pack(corrected);
  const peer = qualifySharedCorePeer({
    work,
    adapterBytes,
    coreBytes: correctedCoreBytes,
    run: (command, args, cwd, options = {}) =>
      run(command, args, cwd, { ...options, stdio: 'pipe', encoding: 'utf8' }),
    disk,
    register,
    octaneCandidate,
  });
  // The peer controls inspected exactly the adapter and Core this suite runs.
  assert.deepEqual(
    peer.adapterManifest,
    correctedManifest,
    'Shared-core controls inspected another adapter than the owning suite',
  );
  assert.deepEqual(
    peer.coreManifest,
    coreManifest,
    'Shared-core controls inspected another Core than the owning suite',
  );
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
          octane: pinned.octane.version,
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
  // The npm octane runtime is the candidate's exact pinned tarball, matching
  // the source-tree compiler the Vite plugin loads below.
  assert.equal(
    lockedIntegrity(
      fs.readFileSync(path.join(deps, 'pnpm-lock.yaml'), 'utf8'),
      'octane',
      pinned.octane.version,
    ),
    pinned.octane.integrity,
    `octane@${pinned.octane.version} is not the pinned npm tarball`,
  );
  const installedOctane = fs.realpathSync(path.join(modules, 'octane'));
  assert.equal(
    readJson(path.join(installedOctane, 'package.json')).version,
    pinned.octane.version,
  );
  const installedCore = fs.realpathSync(
    path.join(modules, '@tanstack/router-core'),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(installedCore, 'package.json')),
    fs.readFileSync(path.join(core, 'package.json')),
    'Owning suite must install the inspected corrected Core',
  );
  fs.symlinkSync(modules, path.join(sourceRoot, 'node_modules'));
  fs.symlinkSync(modules, path.join(corrected, 'node_modules'));
  fs.symlinkSync(modules, path.join(work, 'node_modules'));
  const sourcePackage = path.join(sourceRoot, 'packages/tanstack-router');
  // Source and packed adapters share one physical Core and octane runtime.
  for (const pkg of [sourcePackage, corrected])
    for (const [name, expected] of [
      ['@tanstack/router-core', installedCore],
      ['octane', installedOctane],
    ])
      assert.equal(
        installedPackage(pkg, name),
        expected,
        `${pkg}: ${name} is not the shared installation`,
      );
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
    `${octaneCandidate} adapter ${pinned.adapterVersion} on octane ${pinned.octane.version}: source+packed 59/59 each; router-core correction SHA256 ${createHash('sha256').update(fs.readFileSync(corePatch)).digest('hex')}`,
  );
}
