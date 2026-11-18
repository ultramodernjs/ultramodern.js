import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createRequire,
  stripTypeScriptTypes,
  syncBuiltinESMExports,
} from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const effectVersion = '0.70.0';
const tsrsVersion = '0.25.0-ts7.1.0-beta';
const typescriptCommit = '3e9236361fa97a9e6c685f4833ac457ae2d8c50a';
const goodVersion = `Version 7.1.0-beta+effect-tsgo.${effectVersion} (tsrs ${tsrsVersion}, microsoft/TypeScript@${typescriptCommit.slice(0, 12)})`;
const packageRoot = new URL('../../', import.meta.url);

function write(filename, content) {
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, content);
}

// Node strips types only; no compiler, package build, or native process runs.
function sourceModule(name, format) {
  let code = stripTypeScriptTypes(
    readFileSync(new URL(`src/build-config/${name}.ts`, packageRoot), 'utf8'),
  );
  if (format === 'cjs') {
    const exported = [...code.matchAll(/export function (\w+)/g)].map(
      match => match[1],
    );
    code = code
      .replace(
        /import\s+\{([^}]+)\}\s+from\s+(['"][^'"]+['"]);/g,
        'const {$1} = require($2);',
      )
      .replaceAll('import.meta.url', 'pathToFileURL(__filename).href')
      .replaceAll('export function ', 'function ');
    code += `\nmodule.exports = {${exported.join(',')}};\n`;
  }
  return code;
}

test('renamed-package CJS/ESM layout and source discovery share owned selection before official paths', async () => {
  assert.ok(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir --run');
  const root = mkdtempSync(
    join(process.env.OWNED_TEMP_DIR, 'consumer-resolver-'),
  );
  const previousEnv = { ...process.env };
  const execute = childProcess.execFileSync;
  const calls = [];
  let version = goodVersion;
  childProcess.execFileSync = (file, args) => {
    calls.push({ file, args });
    assert.deepEqual(args, ['--version']);
    return version;
  };
  syncBuiltinESMExports();
  try {
    delete process.env.EFFECT_TSGO_BIN;
    delete process.env.TSRS_BINARY;
    process.env.MODERN_LIB_FORMAT = 'esm';
    const owner = join(root, 'node_modules/@bleedingdev/app-tools-extensions');
    const executable = join(owner, 'compiler/native/tsrs');
    write(executable, 'tiny owned artifact, never executed');
    const owned = {
      kind: 'owned',
      executable,
      effectVersion,
      tsrsVersion,
      typescriptCommit,
      typescriptVersion: '7.1.0-beta',
      artifactSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      target: 'darwin-arm64',
      distribution: 'ultramodern-effect-tsrs',
    };
    write(
      join(owner, 'package.json'),
      JSON.stringify({
        name: '@bleedingdev/app-tools-extensions',
        exports: {
          './internal-effect-payload': {
            import: './compiler/resolve.cjs',
            require: './compiler/resolve.cjs',
          },
          './internal-effect-discovery': {
            import: './dist/cjs/internal-effect-discovery.cjs',
            require: './dist/cjs/internal-effect-discovery.cjs',
          },
        },
      }),
    );
    // A tiny fake models only the shared resolver's boundary contract, not its
    // payload validation. Its tests belong to the payload worker.
    write(
      join(owner, 'compiler/resolve.cjs'),
      `
      exports.selection = ${JSON.stringify(owned)};
      exports.calls = [];
      exports.resolveOwnedEffectCompiler = options => {
        exports.calls.push(options);
        if (exports.failure) throw new Error(exports.failure);
        if (exports.selection.kind === 'owned') {
          for (const candidate of [options.configuredExecutable, process.env.EFFECT_TSGO_BIN, process.env.TSRS_BINARY]) {
            if (candidate && candidate !== exports.selection.executable) throw new Error('Override escapes owned identity');
          }
        }
        return exports.selection;
      };
    `,
    );
    for (const format of ['cjs', 'esm']) {
      for (const name of ['internal-effect-discovery', 'build-environment']) {
        write(
          join(
            owner,
            `dist/${format}/${name}.${format === 'cjs' ? 'cjs' : 'mjs'}`,
          ),
          sourceModule(name, format),
        );
      }
    }
    write(
      join(owner, 'src/build-config/internal-effect-discovery.mjs'),
      sourceModule('internal-effect-discovery', 'esm'),
    );
    const require = createRequire(join(root, 'consumer.cjs'));
    const helper = require('@bleedingdev/app-tools-extensions/internal-effect-payload');
    const importedHelper = await import(
      pathToFileURL(join(owner, 'compiler/resolve.cjs')).href
    );
    assert.equal(importedHelper.default, helper);
    const cjsDiscovery = require('@bleedingdev/app-tools-extensions/internal-effect-discovery');
    const sourceDiscovery = await import(
      pathToFileURL(
        join(owner, 'src/build-config/internal-effect-discovery.mjs'),
      ).href
    );
    const cjsBuild = require(join(owner, 'dist/cjs/build-environment.cjs'));
    const esmBuild = await import(
      pathToFileURL(join(owner, 'dist/esm/build-environment.mjs')).href
    );
    const from = pathToFileURL(join(root, 'consumer.mjs'));
    const cache = join(root, 'cache');
    process.env.TMPDIR = cache;
    process.env.TMP = cache;
    process.env.TEMP = cache;
    const mode = statSync(executable).mode;
    const consumers = [
      () => cjsDiscovery.resolveInstalledEffectCompiler(from, 'tsrs'),
      () => sourceDiscovery.resolveInstalledEffectCompiler(from, 'tsrs'),
      () => cjsBuild.resolveEffectTsgoCompiler({ from }),
      () => esmBuild.resolveEffectTsgoCompiler({ from }),
      () => cjsBuild.resolveEffectTsrsCompiler({ from }),
      () => esmBuild.resolveEffectTsrsCompiler({ from }),
      () => {
        cjsDiscovery.validateConfiguredEffectCompiler(executable, from, 'tsrs');
        return executable;
      },
    ];
    for (const consumer of consumers) assert.equal(consumer(), executable);
    assert.equal(calls.length, consumers.length);
    assert.ok(calls.every(call => call.file === executable));
    assert.ok(helper.calls.every(call => call.from === from));
    assert.equal(statSync(executable).mode, mode);
    assert.equal(
      readFileSync(executable, 'utf8'),
      'tiny owned artifact, never executed',
    );
    assert.equal(existsSync(cache), false);
    assert.equal(existsSync(join(root, 'node_modules/@effect')), false);

    for (const variable of ['EFFECT_TSGO_BIN', 'TSRS_BINARY']) {
      process.env[variable] = executable;
      for (const consumer of consumers) assert.equal(consumer(), executable);
      process.env[variable] = '/outside/compiler';
      const count = calls.length;
      for (const consumer of consumers) assert.throws(consumer);
      assert.equal(calls.length, count, 'escaping override never executes');
      delete process.env[variable];
    }
    for (const invalid of [
      'Version 7.1.0-beta',
      goodVersion.replace('0.70.0', '0.66.0'),
      goodVersion.replace('0.25.0', '0.20.0'),
      goodVersion.replace(typescriptCommit.slice(0, 12), '0'.repeat(12)),
    ]) {
      version = invalid;
      for (const consumer of consumers) assert.throws(consumer);
    }
    version = goodVersion;
    for (const failure of [
      'Malformed owned manifest',
      'Owned executable mode invalid',
    ]) {
      helper.failure = failure;
      const count = calls.length;
      for (const consumer of consumers) assert.throws(consumer);
      assert.equal(calls.length, count);
      assert.equal(existsSync(cache), false);
    }
    helper.failure = undefined;
    helper.selection = { kind: 'absent' };
    // Missing payload still reaches official discovery; strict mode never
    // invents an owned compiler or substitutes Go for an unsupported API.
    assert.throws(
      () => cjsDiscovery.resolveInstalledEffectCompiler(from),
      /Cannot find module '@effect\/tsgo\/package.json'/,
    );
    assert.throws(
      () => esmBuild.resolveEffectTsrsCompiler({ from }),
      /Unable to resolve an executable Effect tsrs API provider/,
    );
    // Ordinary official Go discovery still works when the payload is absent.
    const effectPlatform = `@effect/tsgo-${process.platform}-${process.arch}`;
    const nativePlatform = `@typescript/typescript-${process.platform}-${process.arch}`;
    const goBinary = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
    const nativeCommit = 'c'.repeat(40);
    const json = (name, value) =>
      write(
        join(root, 'node_modules', name, 'package.json'),
        JSON.stringify(value),
      );
    json('@effect/tsgo', {
      name: '@effect/tsgo',
      version: effectVersion,
      bin: { 'effect-tsgo': 'cli.cjs' },
    });
    write(
      join(root, 'node_modules/@effect/tsgo/cli.cjs'),
      'throw new Error("never execute provider");',
    );
    json('typescript', {
      name: 'typescript',
      version: '7.0.2',
      gitHead: nativeCommit,
    });
    json(nativePlatform, {
      name: nativePlatform,
      version: '7.0.2',
      gitHead: nativeCommit,
    });
    write(
      join(root, 'node_modules', nativePlatform, 'lib', goBinary),
      'unpatched native fake',
    );
    json(effectPlatform, { name: effectPlatform, version: effectVersion });
    write(
      join(root, 'node_modules', effectPlatform, 'lib/upstream.json'),
      JSON.stringify({
        schemaVersion: 5,
        tags: { typescript: { latest: '7.0.2' } },
        components: {
          typescript: {
            '7.0.2': { gitHead: nativeCommit, provider: 'typescript-go' },
          },
        },
      }),
    );
    const official = join(
      root,
      'node_modules',
      effectPlatform,
      'lib',
      goBinary,
    );
    write(official, 'official Go fake');
    assert.equal(cjsDiscovery.resolveInstalledEffectCompiler(from), official);
    assert.throws(
      () => cjsDiscovery.resolveInstalledEffectCompiler(from, 'tsrs'),
      /Effect-Go cannot provide this API/,
    );
  } finally {
    childProcess.execFileSync = execute;
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env))
      if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the declared root cohort resolves the real shared CJS helper without dist bootstrap', async () => {
  assert.ok(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir --run');
  const root = mkdtempSync(join(process.env.OWNED_TEMP_DIR, 'source-root-'));
  const previousEnv = { ...process.env };
  const execute = childProcess.execFileSync;
  childProcess.execFileSync = () => goodVersion;
  syncBuiltinESMExports();
  try {
    delete process.env.EFFECT_TSGO_BIN;
    delete process.env.TSRS_BINARY;
    process.env.MODERN_LIB_FORMAT = 'esm';
    const owner = join(root, 'packages/solutions/app-tools-extensions');
    const source = JSON.parse(
      readFileSync(new URL('compiler/source.json', packageRoot), 'utf8'),
    );
    const target = `${process.platform}-${process.arch}`;
    assert.ok(
      source.targets.includes(target),
      'focused fixture needs a declared target',
    );
    for (const filename of ['resolve.cjs', 'source.json', 'constraint.patch']) {
      write(
        join(owner, 'compiler', filename),
        readFileSync(new URL(`compiler/${filename}`, packageRoot)),
      );
    }
    const payload = join(owner, 'compiler/payload');
    const binary = `${target}/tsrs${process.platform === 'win32' ? '.exe' : ''}`;
    const files = [
      binary,
      `${target}/lib.d.ts`,
      `${target}/notices/LICENSE-Effect`,
      `${target}/notices/LICENSE-tsrs`,
      `${target}/notices/LICENSE-TypeScript`,
      `${target}/notices/THIRD-PARTY-NOTICES`,
    ].map(filename => {
      const bytes = Buffer.from(`tiny fake ${filename}\n`);
      const filenamePath = join(payload, filename);
      mkdirSync(dirname(filenamePath), { recursive: true });
      writeFileSync(filenamePath, bytes, {
        mode: filename === binary ? 0o755 : 0o644,
      });
      return {
        path: filename,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        executable: filename === binary,
      };
    });
    write(
      join(payload, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        source,
        producer: {
          repository: 'ultramodernjs/ultramodern.js',
          workflow: 'effect-compiler-payload.yml',
          runId: '1',
          runAttempt: '1',
          sourceCommit: 'a'.repeat(40),
        },
        targets: { [target]: { executable: binary, files } },
      }),
    );
    const tsrsTarget = `@tsrs/${target}${process.platform === 'linux' ? '-gnu' : ''}`;
    const rootRequire = createRequire(
      new URL('../../../package.json', packageRoot),
    );
    const installedTypeScript = rootRequire('typescript/package.json');
    const manifests = {
      '@effect/tsgo': { name: '@effect/tsgo', version: effectVersion },
      tsrs: {
        name: 'tsrs',
        version: tsrsVersion,
        tsrs: {
          typescriptVersion: source.typescript.version,
          typescriptCommit,
        },
        optionalDependencies: { [tsrsTarget]: tsrsVersion },
      },
      typescript: {
        name: 'typescript',
        version: installedTypeScript.version,
        gitHead: installedTypeScript.gitHead,
      },
    };
    for (const [name, manifest] of Object.entries(manifests))
      write(
        join(root, 'node_modules', name, 'package.json'),
        JSON.stringify(manifest),
      );
    write(
      join(root, 'node_modules/tsrs/lib/platform.js'),
      `exports.getPlatformPackageName = () => ${JSON.stringify(tsrsTarget)};`,
    );
    const providerFile = join(root, 'scripts/tsrs-dts/compiler.cjs');
    write(
      providerFile,
      readFileSync(
        new URL('../../../scripts/tsrs-dts/compiler.cjs', packageRoot),
        'utf8',
      ),
    );
    const require = createRequire(join(root, 'consumer.cjs'));
    const provider = require(providerFile);
    const executable = join(payload, binary);
    assert.equal(provider.getExePath(), executable);
    assert.equal(
      provider.getCompilerPolicy().distribution,
      'ultramodern-effect-tsrs',
    );
    assert.equal(existsSync(join(owner, 'dist')), false);
    write(
      join(owner, 'package.json'),
      JSON.stringify({
        name: '@bleedingdev/app-tools-extensions',
        exports: {
          './internal-effect-payload': {
            import: './compiler/resolve.cjs',
            require: './compiler/resolve.cjs',
          },
        },
      }),
    );
    const discoveryFile = join(owner, 'src/build-config/discovery.mjs');
    write(discoveryFile, sourceModule('internal-effect-discovery', 'esm'));
    const discovery = await import(pathToFileURL(discoveryFile).href);
    const from = pathToFileURL(join(root, 'consumer.mjs'));
    assert.equal(
      discovery.resolveInstalledEffectCompiler(from, 'tsrs'),
      provider.getExePath(),
    );
    assert.equal(
      discovery.resolveInstalledEffectCompiler(from.href, 'tsrs'),
      executable,
    );
    for (const variable of ['EFFECT_TSGO_BIN', 'TSRS_BINARY']) {
      process.env[variable] = executable;
      assert.equal(
        discovery.resolveInstalledEffectCompiler(from, 'tsrs'),
        executable,
      );
      assert.equal(provider.getExePath(), executable);
      process.env[variable] = process.execPath;
      assert.throws(() =>
        discovery.resolveInstalledEffectCompiler(from, 'tsrs'),
      );
      assert.throws(() => provider.getExePath());
      delete process.env[variable];
    }
    assert.equal(
      existsSync(join(root, 'node_modules/@effect', `tsgo-${target}`)),
      false,
    );
    assert.equal(existsSync(join(owner, 'dist')), false);
  } finally {
    childProcess.execFileSync = execute;
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env))
      if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
