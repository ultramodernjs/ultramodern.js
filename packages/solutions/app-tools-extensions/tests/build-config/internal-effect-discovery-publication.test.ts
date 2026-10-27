import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const packageRoot = resolve(__dirname, '../..');
const repositoryRoot = resolve(packageRoot, '../../..');

const consumerSource = `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const proof = JSON.parse(readFileSync(new URL('./proof.json', import.meta.url), 'utf8'));
let discoverySpawns = 0;
const execute = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (args?.length === 1 && args[0] === '--version') return execute(file, args, options);
  discoverySpawns += 1;
  throw new Error('Published Effect discovery must not spawn its provider');
};
syncBuiltinESMExports();
const esmConfig = await import('@ultramodern/app-tools-extensions/config');
const cjsConfig = require('@ultramodern/app-tools-extensions/config');
const esmSelection = await import('@ultramodern/app-tools-extensions/internal-effect-discovery');
const cjsSelection = require('@ultramodern/app-tools-extensions/internal-effect-discovery');
assert.equal(esmSelection.default, cjsSelection);
const packageDirectory = join(fixtureRoot, 'node_modules/@ultramodern/app-tools-extensions');
const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));

assert.equal(manifest.name, '@ultramodern/app-tools-extensions');
assert.equal(existsSync(join(fixtureRoot, 'node_modules/@modern-js/app-tools-extensions')), false);
assert.throws(() => require.resolve('@modern-js/app-tools-extensions/config'), { code: 'MODULE_NOT_FOUND' });
assert.equal(require.resolve('@ultramodern/app-tools-extensions/config'), join(packageDirectory, 'dist/cjs/config.js'));
assert.equal(fileURLToPath(import.meta.resolve('@ultramodern/app-tools-extensions/config')), join(packageDirectory, 'dist/esm-node/config.mjs'));
assert.notEqual(cjsConfig.resolveEffectTsgoCompiler, esmConfig.resolveEffectTsgoCompiler);
assert.equal(require.resolve('@ultramodern/app-tools-extensions/internal-effect-discovery'), join(packageDirectory, 'dist/cjs/build-config/internal-effect-discovery.js'));
assert.equal(fileURLToPath(import.meta.resolve('@ultramodern/app-tools-extensions/internal-effect-discovery')), require.resolve('@ultramodern/app-tools-extensions/internal-effect-discovery'));
assert.equal(cjsSelection.resolveInstalledEffectCompiler(import.meta.url), proof.artifactPath);
const cjsCompiler = cjsConfig.resolveEffectTsgoCompiler({ from: import.meta.url });
const esmCompiler = esmConfig.resolveEffectTsgoCompiler({ from: import.meta.url });
assert.equal(cjsConfig.resolveEffectTsgoCompiler({ from: import.meta.url }), cjsCompiler);
assert.equal(cjsCompiler, esmCompiler);
accessSync(cjsCompiler, constants.X_OK);
const digest = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');
assert.equal(digest(proof.nativeCompilerPath), proof.nativeCompilerDigest);
assert.equal(digest(proof.artifactPath), proof.artifactDigest);
assert.equal(digest(cjsCompiler), proof.artifactDigest);
assert.deepEqual(readFileSync(cjsCompiler), readFileSync(proof.artifactPath));
assert.equal(discoverySpawns, 0);
const resolvedCompiler = realpathSync(cjsCompiler);
assert.ok(resolvedCompiler === proof.artifactPath || resolvedCompiler.startsWith(join(fixtureRoot, 'native-cache') + sep));
`;

const fixtureSource = `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourcePackageRoot, generatorRoot, rewritePath, consumerSource] = process.argv.slice(1);
const { rewritePackageJson } = await import(pathToFileURL(rewritePath).href);
const sourceManifest = JSON.parse(readFileSync(join(sourcePackageRoot, 'package.json'), 'utf8'));
const generatorManifest = JSON.parse(readFileSync(join(generatorRoot, 'package.json'), 'utf8'));
const fixtureRoot = realpathSync(mkdtempSync(join(process.env.OWNED_TEMP_DIR ?? tmpdir(), 'renamed-effect-discovery-')));
let cleaned = false;
const cleanup = () => {
  if (!cleaned) {
    cleaned = true;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
};
const signalHandlers = new Map();
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  const handler = () => { cleanup(); process.exit(exitCode); };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

try {
  const installedDirectory = join(fixtureRoot, 'node_modules/@ultramodern/app-tools-extensions');
  mkdirSync(installedDirectory, { recursive: true });
  // Exercise the ordinary producer's bytes. The fixture never transpiles or patches them.
  cpSync(join(sourcePackageRoot, 'dist'), join(installedDirectory, 'dist'), { recursive: true });
  const publishedManifest = structuredClone(sourceManifest);
  const sourceNames = new Set([sourceManifest.name, ...['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(block => Object.keys(sourceManifest[block] ?? {})).filter(name => name.startsWith('@modern-js/'))]);
  const version = sourceManifest.version + '-ultramodern.discovery-test';
  rewritePackageJson(publishedManifest, sourceManifest.name, {
    scope: 'ultramodern',
    prefix: '',
    version,
    dependencyVersion: version,
    homepage: sourceManifest.homepage,
    bugsUrl: sourceManifest.bugs.url,
    repositoryUrl: sourceManifest.repository.url,
  }, sourceNames);
  assert.equal(publishedManifest.name, '@ultramodern/app-tools-extensions');
  assert.equal(JSON.stringify(publishedManifest.exports).includes('modern:source'), false);
  assert.equal(publishedManifest.exports['./internal-effect-discovery'].import, publishedManifest.exports['./internal-effect-discovery'].require);
  assert.equal(publishedManifest.dependencies['@modern-js/surface-resolution'], 'npm:@ultramodern/surface-resolution@' + version);
  writeFileSync(join(installedDirectory, 'package.json'), JSON.stringify(publishedManifest));

  const linkDependency = (ownerRoot, name) => {
    const sourceDirectory = realpathSync(join(ownerRoot, 'node_modules', name));
    const sourcePackageJson = JSON.parse(readFileSync(join(sourceDirectory, 'package.json'), 'utf8'));
    const destination = join(fixtureRoot, 'node_modules', name);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(sourceDirectory, destination, 'dir');
    assert.equal(realpathSync(destination), sourceDirectory);
    return { sourceDirectory, sourcePackageJson };
  };
  // Canonical dependency keys still use the exact owning package's installed cohort.
  for (const name of new Set([...Object.keys(sourceManifest.dependencies), ...Object.keys(sourceManifest.peerDependencies ?? {})])) {
    assert.notEqual(name, sourceManifest.name);
    linkDependency(sourcePackageRoot, name);
  }

  const compilerCohort = {};
  for (const name of ['@effect/tsgo', 'typescript', 'tsrs']) {
    const installation = linkDependency(generatorRoot, name);
    const specification = generatorManifest.dependencies[name];
    const installedVersion = installation.sourcePackageJson.version;
    assert.equal(specification, installedVersion, name + ' must match the generator exact dependency');
    compilerCohort[name] = installation;
  }
  const effect = compilerCohort['@effect/tsgo'];
  const tsrs = compilerCohort.tsrs;
  const { getPlatformPackageName } = await import(pathToFileURL(join(tsrs.sourceDirectory, 'lib/platform.js')).href);
  // Upstream tsrs support does not imply that Effect ships its replacement.
  // This independent expectation matches the official 0.59.0 CLI targets.
  assert.equal(effect.sourcePackageJson.version, '0.59.0');
  const nativeName = getPlatformPackageName();
  const supported = tsrs.sourcePackageJson.optionalDependencies[nativeName] === tsrs.sourcePackageJson.version
    && ['@tsrs/darwin-arm64', '@tsrs/linux-x64-gnu', '@tsrs/linux-arm64-gnu'].includes(nativeName);
  const native = compilerCohort.typescript;
  const effectPlatformManifest = createRequire(join(effect.sourceDirectory, 'package.json')).resolve('@effect/tsgo-' + process.platform + '-' + process.arch + '/package.json');
  const nativePlatformManifest = createRequire(join(native.sourceDirectory, 'package.json')).resolve('@typescript/typescript-' + process.platform + '-' + process.arch + '/package.json');
  const upstream = JSON.parse(readFileSync(join(dirname(effectPlatformManifest), 'lib/upstream.json'), 'utf8'));
  assert.equal(upstream.schemaVersion, 5);
  assert.equal(upstream.components.tsrs[tsrs.sourcePackageJson.version].typescript.version, tsrs.sourcePackageJson.tsrs.typescriptVersion);
  assert.equal(upstream.components.tsrs[tsrs.sourcePackageJson.version].typescript.gitHead, tsrs.sourcePackageJson.tsrs.typescriptCommit);
  const binaryName = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
  const artifactPath = realpathSync(supported
    ? join(dirname(effectPlatformManifest), 'artifacts/tsrs', tsrs.sourcePackageJson.version, process.platform === 'win32' ? 'tsrs.exe' : 'tsrs')
    : join(dirname(effectPlatformManifest), 'lib', binaryName));
  const nativeCompilerPath = supported
    ? realpathSync((await import(pathToFileURL(join(tsrs.sourceDirectory, 'lib/getExePath.js')).href)).default())
    : realpathSync(join(dirname(nativePlatformManifest), 'lib', binaryName));
  const digest = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');
  const proof = {
    artifactPath,
    nativeCompilerPath,
    artifactDigest: digest(artifactPath),
    nativeCompilerDigest: digest(nativeCompilerPath),
  };
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      [publishedManifest.name]: version,
      ...Object.fromEntries(['@effect/tsgo', 'typescript', 'tsrs'].map(name => [name, generatorManifest.dependencies[name]])),
    },
  }));
  writeFileSync(join(fixtureRoot, 'proof.json'), JSON.stringify(proof));
  const consumerFile = join(fixtureRoot, 'consumer.mjs');
  writeFileSync(consumerFile, consumerSource);
  const nativeCache = join(fixtureRoot, 'native-cache');
  mkdirSync(nativeCache);
  const environment = { ...process.env, TMPDIR: nativeCache, TMP: nativeCache, TEMP: nativeCache };
  delete environment.EFFECT_TSGO_BIN;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  execFileSync(process.execPath, [consumerFile], {
    cwd: fixtureRoot,
    env: environment,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 20_000,
  });
} finally {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  cleanup();
}
`;

test('renamed standalone publication selects the same native artifact through public CJS and native ESM config', () => {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      fixtureSource,
      packageRoot,
      resolve(repositoryRoot, 'packages/toolkit/ultramodern-create'),
      resolve(
        repositoryRoot,
        'scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/rewrite.mjs',
      ),
      consumerSource,
    ],
    {
      cwd: packageRoot,
      env: environment,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 25_000,
    },
  );
});
