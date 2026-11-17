import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assetFilename,
  repository,
  repositoryId,
  workflow,
} from '../../native-artifacts/protocol.mjs';
import { releaseRecipe } from '../../native-artifacts/recipes.mjs';
import { reconstruct } from '../../native-artifacts/reconstruct.mjs';
import { packages, source } from '../inputs.mjs';
import { buildEnvironment, qualifyRuntimeTree } from '../qualify-runtime.mjs';
import { applyExactPatch } from '../reconstruct.mjs';

const serializers = process.argv.includes('--serializers');
const receiptFilename = serializers
  ? 'serializer-receipt.json'
  : 'receipt.json';
const here = path.dirname(fileURLToPath(import.meta.url));
const owning = path.dirname(here);
const repo = path.resolve(owning, '../../..');
const expectedPatch =
  'c005016a3c6a15a76cbb52ecf0c80f409878f13d68894fa67c50daf490f8c9d8';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const integrity = bytes =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
assert(
  process.env.OWNED_TEMP_DIR,
  'Run via owned-temp-dir --need-gib 20 --run octane-oxc-latest -- node <this-file>',
);
const work = fs.realpathSync(process.env.OWNED_TEMP_DIR);
const owner = `octane-oxc-latest-${process.pid}`;
const pnpm =
  process.env.PNPM_BINARY ??
  '/Users/satan/.local/share/mise/installs/pnpm/12.21.0/pnpm';
const registered = new Set();
const run = (command, args, cwd = work, extra = {}) =>
  execFileSync(command, args, {
    cwd,
    env: buildEnvironment(),
    stdio: 'inherit',
    maxBuffer: 32 * 1024 ** 2,
    ...extra,
  });
const disk = () => {
  const stat = fs.statfsSync(work);
  assert(
    stat.bavail * stat.bsize >= 20 * 1024 ** 3,
    'Below 20 GiB: stop allocation',
  );
};
const register = directory => {
  fs.mkdirSync(directory, { recursive: true });
  run('/Users/satan/bin/disk-guardian-artifacts', [
    'register',
    directory,
    '--owner',
    owner,
    '--owner-pid',
    String(process.pid),
    '--kind',
    'dependencies',
    '--grace-hours',
    '24',
  ]);
  registered.add(directory);
};
const extract = (archive, directory) => {
  fs.mkdirSync(directory, { recursive: true });
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', directory]);
};
const installArgs = [
  'install',
  '--strict-peer-dependencies',
  '--config.auto-install-peers=false',
  '--config.manage-package-manager-versions=false',
  '--store-dir',
  '/Users/satan/.pnpm-store',
  '--config.package-import-method=clone-or-copy',
];
function consumer(name, dependencies) {
  disk();
  const directory = path.join(work, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module', dependencies }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'pnpm-workspace.yaml'),
    'packages: []\nautoInstallPeers: false\nstrictPeerDependencies: true\nblockExoticSubdeps: true\nallowBuilds:\n  esbuild: true\npackageImportMethod: clone-or-copy\n',
  );
  register(path.join(directory, 'node_modules'));
  return directory;
}
function reject(directory) {
  const result = spawnSync(pnpm, installArgs, {
    cwd: directory,
    env: buildEnvironment(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 ** 2,
  });
  const log = `${result.stdout}\n${result.stderr}`;
  fs.writeFileSync(path.join(work, `${path.basename(directory)}.log`), log);
  assert.notEqual(
    result.status,
    0,
    'An incompatible OXC peer must fail strict install',
  );
  assert.match(log, /ERR_PNPM_PEER_DEP_ISSUES/);
  assert.match(log, /@tsrx\/oxc/);
  console.log(
    'EXPECTED STRICT REJECTION',
    path.basename(directory),
    log.slice(-1800),
  );
}
const receipt = {
  schemaVersion: 1,
  testedAt: new Date().toISOString(),
  status: 'RUNNING',
  patchSha256: expectedPatch,
  sourceCommit: source.commit,
  gates: [],
};
fs.writeFileSync(
  path.join(here, receiptFilename),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
try {
  disk();
  assert.equal(process.versions.node, '26.13.1');
  assert.equal(
    run(pnpm, ['--version'], work, { stdio: 'pipe', encoding: 'utf8' }).trim(),
    '12.21.0',
  );
  const latest = await (
    await fetch('https://registry.npmjs.org/@tsrx%2Foxc/latest')
  ).json();
  assert.equal(
    latest.version,
    '0.24.0',
    'Latest changed: qualify the new actual release, do not silently retain 0.24',
  );
  receipt.oxc = { version: latest.version, integrity: latest.dist.integrity };
  const recipe = releaseRecipe();
  assert.equal(recipe.packages.octane.patchSha256, expectedPatch);
  const patchBefore = fs.readFileSync(recipe.packages.octane.patchPath);
  const directory = path.join(work, 'actual-four');
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], repo, {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  await reconstruct({
    recipe,
    directory,
    producer: {
      repository,
      repositoryId,
      workflow,
      source: sourceCommit,
      runId: 1,
      runAttempt: 1,
      tag: `native-renderers-${sourceCommit}-1-1`,
    },
  });
  const archive = path.join(directory, assetFilename('octane', '0.18.0'));
  receipt.recipePatches = Object.fromEntries(
    Object.entries(recipe.packages).map(([name, item]) => [
      name,
      item.patchSha256,
    ]),
  );
  receipt.archiveIntegrity = integrity(fs.readFileSync(archive));
  const packed = path.join(work, 'packed');
  extract(archive, packed);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packed, 'package.json')),
  );
  assert.equal(manifest.peerDependencies['@tsrx/oxc'], '^0.24.0');
  receipt.gates.push(
    'exact existing four-package recipe reconstructed; corrected Octane peer already ^0.24.0',
  );
  console.log(
    'EXACT EXISTING PATCH ALREADY ADMITS 0.24',
    receipt.archiveIntegrity,
  );
  const upstreamInput = packages.find(item => item.name === 'octane');
  const upstreamBytes = Buffer.from(
    await (await fetch(upstreamInput.url)).arrayBuffer(),
  );
  assert.equal(integrity(upstreamBytes), upstreamInput.integrity);
  const upstreamArchive = path.join(work, 'upstream.tgz');
  fs.writeFileSync(upstreamArchive, upstreamBytes);
  reject(
    consumer('upstream-024-rejected', {
      octane: `file:${upstreamArchive}`,
      '@tsrx/oxc': '0.24.0',
    }),
  );
  receipt.gates.push(
    'actual registry Octane + OXC 0.24 strict install rejects stale exact 0.23 peer',
  );
  reject(
    consumer('corrected-023-rejected', {
      octane: `file:${archive}`,
      '@tsrx/oxc': '0.23.0',
    }),
  );
  receipt.gates.push(
    'actual corrected Octane + incompatible OXC 0.23 strict install rejects',
  );
  const dependencies = {
    octane: `file:${archive}`,
    '@tsrx/oxc': '0.24.0',
    '@tsrx/core': '0.6.1',
    typescript: '7.0.2',
    'typescript-classic': 'npm:typescript@5.9.3',
    'typescript-native': 'npm:typescript@7.1.0-dev.20260921.1',
    vite: '8.0.16',
    vitest: '4.1.10',
    jsdom: '30.0.1',
    esbuild: '0.28.2',
    devalue: '6.0.3',
    react: '19.3.1',
    'react-dom': '19.3.1',
    esrap: '2.4.0',
    'es-module-lexer': '1.7.0',
    '@volar/language-core': '2.4.28',
    '@volar/typescript': '2.4.28',
  };
  if (serializers)
    Object.assign(dependencies, {
      '@tanstack/router-core': `file:${path.join(directory, assetFilename('@tanstack/router-core', '1.171.39'))}`,
      '@octanejs/tanstack-router': `file:${path.join(directory, assetFilename('@octanejs/tanstack-router', '0.3.4'))}`,
      '@tanstack/store': '0.11.2',
      '@tanstack/history': '1.162.5',
      seroval: '1.8.1',
      'seroval-plugins': '1.8.0',
    });
  const installed = consumer('corrected-024', dependencies);
  run(pnpm, installArgs, installed);
  register(path.join(installed, 'node_modules'));
  const modules = path.join(installed, 'node_modules');
  const installedOctane = fs.realpathSync(path.join(modules, 'octane'));
  const actualFiles = fs
    .readdirSync(packed, { recursive: true })
    .filter(f => fs.lstatSync(path.join(packed, f)).isFile());
  for (const name of actualFiles)
    assert.deepEqual(
      fs.readFileSync(path.join(installedOctane, name)),
      fs.readFileSync(path.join(packed, name)),
      name,
    );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(modules, '@tsrx/oxc/package.json')))
      .version,
    '0.24.0',
  );
  fs.rmSync(modules, { recursive: true, force: true });
  register(modules);
  run(pnpm, [...installArgs, '--frozen-lockfile'], installed);
  register(modules);
  for (const name of actualFiles)
    assert.deepEqual(
      fs.readFileSync(path.join(installedOctane, name)),
      fs.readFileSync(path.join(packed, name)),
      name,
    );
  receipt.gates.push(
    `normal + frozen strict pnpm12 installs; ${actualFiles.length} installed Octane files byte-matched actual archive`,
  );
  const sourceBytes = Buffer.from(
    await (await fetch(source.url)).arrayBuffer(),
  );
  assert.equal(sha256(sourceBytes), source.sha256);
  const sourceArchive = path.join(work, 'source.tgz');
  fs.writeFileSync(sourceArchive, sourceBytes);
  const root = path.join(work, 'source');
  extract(sourceArchive, root);
  receipt.sourceCorrections = {};
  for (const name of [
    'runtime-source.patch',
    'typescript-compat/typescript-source.patch',
    'typescript-compat/native-signals-source.patch',
    'typescript-compat/volar-core-source.patch',
    'runtime-tests.patch',
    'rspack-source.patch',
    'rspack-tests.patch',
  ]) {
    receipt.sourceCorrections[name] = sha256(
      fs.readFileSync(path.join(owning, name)),
    );
    applyExactPatch(root, path.join(owning, name));
  }
  fs.symlinkSync(modules, path.join(root, 'node_modules'));
  // Existing owning API runs real compilation and runtime behavior against both trees.
  for (const target of [undefined, installedOctane]) {
    qualifyRuntimeTree(root, modules, target, run, {
      suites: [
        'packages/octane/tests/hydration/external-snapshot-server-boundary.test.ts',
      ],
    });
    receipt.gates.push(
      `${target ? 'actual installed packed' : 'corrected source'} owning runtime/compiler boundary suite`,
    );
  }
  if (serializers) {
    const { qualifySerializers } = await import('./serializers.mjs');
    await qualifySerializers({
      root,
      modules,
      installed,
      work,
      run,
      receipt,
      here,
      directory,
    });
  }
  if (!serializers) {
    const compilerConfig = path.join(root, 'oxc-compiler.config.mjs');
    const compilerSuites = [
      'parser-parity',
      'style-syntax-fallback',
      'compile-errors',
      'typescript-runtime-lowering',
      'native-change-compiler',
    ];
    fs.writeFileSync(
      compilerConfig,
      `import{defineConfig}from'vitest/config';import{octane}from${JSON.stringify(path.join(root, 'packages/octane/src/compiler/vite.js'))};export default defineConfig({plugins:[octane()],resolve:{alias:[{find:/^typescript$/,replacement:${JSON.stringify(path.join(modules, 'typescript-classic/lib/typescript.js'))}}]},test:{environment:'jsdom',include:${JSON.stringify(compilerSuites.map(name => `packages/octane/tests/compiler/${name}.test.ts`))},maxWorkers:1}});`,
    );
    run(
      process.execPath,
      [
        path.join(modules, 'vitest/vitest.mjs'),
        'run',
        '--config',
        compilerConfig,
      ],
      root,
    );
    receipt.gates.push(
      'unchanged owning source compiler suites: ' + compilerSuites.join(', '),
    );
  }
  run(
    process.execPath,
    [path.join(owning, 'qualify-required-apis.mjs'), installed],
    work,
    { env: { ...buildEnvironment(), OWNED_TEMP_DIR: work } },
  );
  receipt.gates.push(
    'actual installed packed runtime APIs + stable TS7.0.2 text facts',
  );
  fs.writeFileSync(
    path.join(installed, 'consumer.ts'),
    `import {compile} from 'octane/compiler';\nimport {createTextTypeProject} from 'octane/compiler/typescript';\nconst result = compile('export function App() {return <p>hello</p>}', '/App.tsx');\nconst code: string = result.code;\nconst createProject: typeof createTextTypeProject = createTextTypeProject;\nexport {code,createProject};\n`,
  );
  if (serializers)
    fs.appendFileSync(
      path.join(installed, 'consumer.ts'),
      `
import {crossSerializeAsync} from 'seroval';
import {ReadableStreamPlugin} from 'seroval-plugins/web';
import {hydrate} from '@tanstack/router-core/ssr/client';
import type {AnyRouter} from '@tanstack/router-core';
const serialized: Promise<string> = crossSerializeAsync({stream:new ReadableStream<string>()},{plugins:[ReadableStreamPlugin]});
function restore(router:AnyRouter):ReturnType<typeof hydrate>{return hydrate(router)}
export {serialized,restore};
`,
    );
  fs.writeFileSync(
    path.join(installed, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ['consumer.ts'],
    }),
  );
  run(
    path.join(modules, '.bin/tsc'),
    ['-p', 'tsconfig.json', '--pretty', 'false'],
    installed,
  );
  receipt.gates.push(
    'stable TS7.0.2 strict noEmit skipLibCheck:false consumer of actual packed compiler declarations',
  );
  if (serializers)
    receipt.gates.push(
      'strict stable TS7.0.2 noEmit skipLibCheck:false Seroval+web plugin+router hydrate declarations',
    );
  assert.deepEqual(
    fs.readFileSync(recipe.packages.octane.patchPath),
    patchBefore,
    'Frozen patch must remain unchanged',
  );
  receipt.correction =
    'none: existing pinned owning patch already corrects exact 0.23 peer to ^0.24.0';
  receipt.notClaimed = [
    'full hydration rerun',
    'new owning build',
    'hosted acceptance',
    'publication',
    'parent updater/root integration',
  ];
  receipt.status = 'PASS';
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  fs.writeFileSync(path.join(here, receiptFilename), text);
  console.log(text);
} catch (error) {
  receipt.status = 'FAIL';
  receipt.error = error.message;
  fs.writeFileSync(
    path.join(here, receiptFilename),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  throw error;
} finally {
  for (const directory of registered)
    run('/Users/satan/bin/disk-guardian-artifacts', [
      'release',
      directory,
      '--owner',
      owner,
    ]);
}
