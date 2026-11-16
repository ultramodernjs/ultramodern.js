import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectNpmTarball } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { verifyArtifact } from './authenticate.mjs';
import { createPatch, rebuild, tree, validateMaps } from './build.mjs';
import { versions } from './inputs.mjs';
import { port } from './port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const temporary = process.env.OWNED_TEMP_DIR;
assert(
  temporary && path.isAbsolute(temporary),
  'Run using owned-temp-dir --run',
);
const artifacts = path.join(temporary, 'artifacts');
fs.mkdirSync(artifacts);
const owner = `otel-corrections-${process.pid}`;
const guardian = '/Users/satan/bin/disk-guardian-artifacts';
const portable = process.env.OTEL_PORTABLE === '1';
function artifactCommand(args) {
  if (!portable) execFileSync(guardian, args);
}
let sourceArchiveBytes;
const modules = path.join(artifacts, 'fixture/node_modules');
const builds = new Set();
function registerBuild(build) {
  artifactCommand([
    'register',
    build,
    '--owner',
    owner,
    '--owner-pid',
    String(process.pid),
    '--kind',
    'build',
  ]);
  builds.add(build);
}
fs.mkdirSync(modules, { recursive: true });
artifactCommand([
  'register',
  modules,
  '--owner',
  owner,
  '--owner-pid',
  String(process.pid),
  '--kind',
  'dependencies',
]);
function run(command, args, cwd, fail = false) {
  if (command === 'pnpm') {
    command = process.env.OTEL_PNPM_BINARY ?? command;
    if (process.env.OTEL_STORE_DIRECTORY && args[0] === 'install')
      args = [...args, '--store-dir', process.env.OTEL_STORE_DIRECTORY];
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
      BFF_TELEMETRY_SOURCE: path.join(artifacts, 'fixture/bff-telemetry.ts'),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  console.log(output);
  if (command === 'pnpm' && fs.existsSync(modules))
    artifactCommand([
      'register',
      modules,
      '--owner',
      owner,
      '--owner-pid',
      String(process.pid),
      '--kind',
      'dependencies',
    ]);
  if (!fail)
    assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
  return { status: result.status, output };
}
try {
  const authenticated = [];
  const expectedIdentities = JSON.parse(
    fs.readFileSync(path.join(here, 'registry-identities.json'), 'utf8'),
  );
  const keys = (
    await (await fetch('https://registry.npmjs.org/-/npm/v1/keys')).json()
  ).keys;
  for (const identity of expectedIdentities) {
    const { name, version } = identity;
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    );
    assert(response.ok);
    const metadata = await response.json();
    const bytes = Buffer.from(
      await (await fetch(metadata.dist.tarball)).arrayBuffer(),
    );
    assert.equal(metadata.dist.integrity, identity.integrity);
    assert.equal(metadata.dist.tarball, identity.tarball);
    verifyArtifact(metadata, bytes, keys);
    if (versions[name]) {
      const latest = await (
        await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
        )
      ).json();
      assert.equal(
        latest.version,
        version,
        `${name}: latest changed; refresh and requalify`,
      );
    } else {
      assert.match(
        metadata.peerDependencies['@opentelemetry/api'],
        /<1\.10\.0/,
      );
    }
    authenticated.push({
      name,
      version,
      integrity: metadata.dist.integrity,
      tarball: metadata.dist.tarball,
    });
    if (name === '@effect/opentelemetry') {
      sourceArchiveBytes = bytes;
      fs.mkdirSync(path.join(artifacts, 'original'));
      execFileSync(
        'tar',
        ['-xz', '--strip-components=1', '-C', path.join(artifacts, 'original')],
        { input: bytes },
      );
    }
  }
  console.log('AUTHENTICATED', JSON.stringify(authenticated));
  const dependencies = { ...versions };
  delete dependencies.typescript;
  delete dependencies['@types/node'];
  const fixture = path.join(artifacts, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  const manifest = {
    packageManager: 'pnpm@12.21.0',
    private: true,
    type: 'module',
    dependencies,
    devDependencies: {
      typescript: versions.typescript,
      '@types/node': versions['@types/node'],
    },
  };
  const writeManifest = () =>
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify(manifest, null, 2),
    );
  fs.writeFileSync(
    path.join(fixture, 'pnpm-workspace.yaml'),
    'packages: []\nstrictPeerDependencies: true\nautoInstallPeers: false\npackageImportMethod: clone-or-copy\n',
  );
  writeManifest();
  const before = run(
    'pnpm',
    ['install', '--ignore-scripts', '--no-frozen-lockfile'],
    fixture,
    true,
  );
  assert.notEqual(
    before.status,
    0,
    'uncorrected strict fixture must reject latest tuple',
  );
  assert.match(before.output, /ERR_PNPM_PEER_DEP_ISSUES/);
  assert.match(before.output, /sdk-logs|sdk-metrics|resources/);
  const pristine = path.join(artifacts, 'pristine');
  fs.cpSync(path.join(artifacts, 'original'), pristine, { recursive: true });
  const corrected = path.join(artifacts, 'corrected');
  fs.cpSync(path.join(artifacts, 'original'), corrected, { recursive: true });
  execFileSync('git', ['apply', path.join(here, 'source.patch')], {
    cwd: corrected,
  });
  const ported = path.join(artifacts, 'ported');
  fs.cpSync(path.join(artifacts, 'original'), ported, { recursive: true });
  port(ported);
  for (const file of [
    'src/NodeSdk.ts',
    'src/WebSdk.ts',
    'src/OtelLogger.ts',
    'src/internal/metrics.ts',
    'package.json',
  ])
    assert.equal(
      fs.readFileSync(path.join(corrected, file), 'utf8'),
      fs.readFileSync(path.join(ported, file), 'utf8'),
      `source patch/port disagree: ${file}`,
    );
  manifest.dependencies['@effect/opentelemetry'] = 'file:../corrected';
  writeManifest();
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], fixture);
  // Compile the complete owning package source; no declaration or library-check suppression.
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: false,
      declaration: true,
      noEmitOnError: true,
      rewriteRelativeImportExtensions: true,
      outDir: 'dist',
      rootDir: 'src',
      types: ['node'],
    },
    include: ['src/**/*.ts'],
  };
  const original = path.join(artifacts, 'original');
  fs.writeFileSync(
    path.join(original, 'tsconfig.json'),
    JSON.stringify(tsconfig),
  );
  fs.symlinkSync(
    path.join(fixture, 'node_modules'),
    path.join(original, 'node_modules'),
    'dir',
  );
  const sourceBefore = run(
    path.join(fixture, 'node_modules/.bin/tsc'),
    ['-p', path.join(original, 'tsconfig.json')],
    fixture,
    true,
  );
  assert.notEqual(
    sourceBefore.status,
    0,
    'metadata-only correction must fail source checking',
  );
  assert.match(sourceBefore.output, /LoggerProviderConfig/);
  assert.match(sourceBefore.output, /InstrumentDescriptor/);
  assert.match(sourceBefore.output, /sdk-trace-node/);
  const runtimeBefore = run(
    'node',
    [
      '--input-type=module',
      '-e',
      'await import(' +
        JSON.stringify(path.join(original, 'dist/NodeSdk.js')) +
        ')',
    ],
    fixture,
    true,
  );
  assert.notEqual(
    runtimeBefore.status,
    0,
    'metadata-only correction must fail runtime importing removed trace package',
  );
  assert.match(runtimeBefore.output, /ERR_MODULE_NOT_FOUND/);
  const mapCount = rebuild(corrected, modules, registerBuild);
  const repeated = path.join(artifacts, 'repeated');
  fs.cpSync(pristine, repeated, { recursive: true });
  port(repeated);
  rebuild(repeated, modules, registerBuild);
  assert.deepEqual(
    tree(corrected),
    tree(repeated),
    'independent corrected rebuild differs',
  );
  const canonical = path.resolve(
    here,
    '../../../patches/@effect__opentelemetry@4.1.4.patch',
  );
  const generatedPatch = path.join(artifacts, 'canonical.patch');
  const patchSha = createPatch(pristine, corrected, generatedPatch);
  if (process.argv.includes('--write-patch'))
    fs.copyFileSync(generatedPatch, canonical);
  assert.equal(
    fs.readFileSync(canonical, 'utf8'),
    fs.readFileSync(generatedPatch, 'utf8'),
    'canonical patch differs; explicit --write-patch regenerates',
  );
  const reconstructed = path.join(artifacts, 'reconstructed');
  fs.cpSync(pristine, reconstructed, { recursive: true });
  execFileSync(
    'git',
    ['apply', '--check', '--whitespace=error-all', canonical],
    { cwd: reconstructed },
  );
  execFileSync('git', ['apply', canonical], { cwd: reconstructed });
  assert.deepEqual(
    tree(reconstructed),
    tree(corrected),
    'canonical reconstruction byte mismatch',
  );
  validateMaps(reconstructed);
  const originalManifest = JSON.parse(
    fs.readFileSync(path.join(pristine, 'package.json'), 'utf8'),
  );
  const correctedManifest = JSON.parse(
    fs.readFileSync(path.join(reconstructed, 'package.json'), 'utf8'),
  );
  for (const key of [
    'name',
    'version',
    'exports',
    'files',
    'license',
    'type',
    'engines',
  ])
    assert.deepEqual(correctedManifest[key], originalManifest[key]);
  for (const file of Object.keys(tree(pristine)).filter(
    file =>
      !file.startsWith('dist/') &&
      !file.startsWith('src/') &&
      file !== 'package.json',
  ))
    assert.equal(tree(pristine)[file], tree(reconstructed)[file], file);
  const packed = path.join(artifacts, 'packed');
  fs.mkdirSync(packed);
  run(
    'npm',
    ['pack', '--ignore-scripts', '--pack-destination', packed],
    reconstructed,
  );
  const tarball = fs.readdirSync(packed).find(file => file.endsWith('.tgz'));
  assert(tarball);
  const unpacked = path.join(artifacts, 'unpacked');
  fs.mkdirSync(unpacked);
  execFileSync('tar', [
    '-xzf',
    path.join(packed, tarball),
    '--strip-components=1',
    '-C',
    unpacked,
  ]);
  assert.deepEqual(
    tree(unpacked),
    tree(reconstructed),
    'npm pack changed corrected layout',
  );
  validateMaps(unpacked);
  const transported = process.env.OTEL_TRANSPORT_ARCHIVE;
  if (transported) {
    assert(path.resolve(transported).startsWith(temporary + '/'));
    const actual = path.join(artifacts, 'actual-transport');
    fs.mkdirSync(actual);
    const inspected = inspectNpmTarball(fs.readFileSync(transported));
    assert.equal(inspected.packageJson.name, '@effect/opentelemetry');
    assert.equal(inspected.packageJson.version, '4.1.4');
    for (const file of inspected.files) {
      const absolute = path.join(actual, file.path);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, inspected.fileContents.get(file.path), {
        flag: 'wx',
        mode: file.mode & 0o777,
      });
    }
    assert.deepEqual(
      tree(actual),
      tree(reconstructed),
      'transported OTel layout differs from owning rebuild',
    );
    validateMaps(actual);
  }
  manifest.dependencies['@effect/opentelemetry'] = transported
    ? 'file:' + transported
    : 'file:../packed/' + tarball;
  writeManifest();
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], fixture);
  run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile'], fixture);
  assert.deepEqual(
    tree(fs.realpathSync(path.join(modules, '@effect/opentelemetry'))),
    tree(reconstructed),
    'installed packed package byte mismatch',
  );
  console.log(
    JSON.stringify({
      canonicalPatchSha256: patchSha,
      maps: mapCount,
      files: Object.keys(tree(unpacked)).length,
      independentRebuildIdentical: true,
      reconstructionIdentical: true,
      packedLayoutIdentical: true,
    }),
  );
  const lock = fs.readFileSync(path.join(fixture, 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(
    lock,
    /sdk-trace-(base|node|web)|@opentelemetry\/[^'\s]+@2\./,
  );
  fs.copyFileSync(
    path.join(here, 'runtime.ts'),
    path.join(fixture, 'runtime.ts'),
  );
  fs.writeFileSync(
    path.join(fixture, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: ['node'],
      },
      include: ['runtime.ts'],
    }),
  );
  run(
    path.join(fixture, 'node_modules/.bin/tsc'),
    ['-p', path.join(fixture, 'tsconfig.json')],
    fixture,
  );
  fs.copyFileSync(
    fileURLToPath(
      new URL(
        '../../../packages/server/bff-effect/src/data-platform/batch/telemetry.ts',
        import.meta.url,
      ),
    ),
    path.join(fixture, 'bff-telemetry.ts'),
  );
  run('node', ['runtime.ts'], fixture);
  if (process.env.OTEL_RECEIPT_FILE) {
    assert(process.env.OTEL_RECEIPT_FILE.startsWith(temporary + '/'));
    fs.writeFileSync(
      process.env.OTEL_RECEIPT_FILE,
      JSON.stringify({
        sourceArchiveBytes: sourceArchiveBytes.toString('base64'),
        builtPatchBytes: fs.readFileSync(canonical).toString('base64'),
        licenseBytes: fs
          .readFileSync(path.join(pristine, 'LICENSE'))
          .toString('base64'),
      }),
    );
  }
  console.log(
    'PASS: exact latest tuple, strict peers, owning source/declarations, runtime',
  );
} finally {
  for (const build of builds) {
    artifactCommand(['release', build, '--owner', owner]);
    artifactCommand(['cleanup', '--only', build, '--no-caches', '--apply']);
  }
  artifactCommand(['release', modules, '--owner', owner]);
  artifactCommand(['cleanup', '--only', modules, '--no-caches', '--apply']);
}
