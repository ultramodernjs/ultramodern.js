import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import {
  applyExactPatch,
  packFiles,
} from '../ultramodern-artifacts/reconstruct.mjs';
import { buildEnvironment } from '../ultramodern-dependencies/otel-corrections/portable.mjs';
import { authenticateArchive } from '../ultramodern-dependencies/test-peer-corrections/authenticate.mjs';
import {
  inputs,
  inspectSupportTarball,
  supportProtocol as protocol,
} from './protocol.mjs';

const name = 'rsbuild-plugin-dts';
const root = fileURLToPath(new URL('../../', import.meta.url));
const identity = JSON.parse(
  fs.readFileSync(new URL('./dts-plugin-registry.json', import.meta.url)),
);
// Exact consumer toolchain; Rslib and its own plugin dependency stay unpatched.
const fixtureDependencies = Object.freeze({
  '@rslib/core': '1.0.7',
  '@rsbuild/core': '2.3.3',
  tsrs: '0.25.0-ts7.1.0-beta',
  '@effect/tsgo': '0.70.0',
});
const declaration =
  "export const greet = (name: string): string => 'hi ' + name;\n";
const cases = {
  declaration,
  'compiler-error': "export const count: number = 'not a number';\n",
  // Type-checks cleanly; naming dts-inner is only required to emit declarations.
  'emit-only':
    "import { make } from 'dts-outer';\nexport const value = make();\n",
};
const localPackages = {
  'dts-inner': {
    'package.json': {
      name: 'dts-inner',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    },
    'index.d.ts': "export interface Inner {\n  readonly kind: 'inner';\n}\n",
    'index.js': 'export {};\n',
  },
  'dts-outer': {
    'package.json': {
      name: 'dts-outer',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
      dependencies: { 'dts-inner': 'file:../dts-inner' },
    },
    'index.d.ts':
      "import type { Inner } from 'dts-inner';\nexport declare function make(): Inner;\n",
    'index.js': "export const make = () => ({ kind: 'inner' });\n",
  },
};

function readTree(directory, relative = '', files = new Map()) {
  for (const entry of fs.readdirSync(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) readTree(directory, file, files);
    else {
      assert(entry.isFile(), `${file}: regular package file required`);
      files.set(file, fs.readFileSync(path.join(directory, file)));
    }
  }
  return files;
}
function writeFiles(directory, files) {
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(directory, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
}
// pnpm links dependency bins under an installed package's own node_modules;
// npm archives cannot contain that directory, so everything else must match.
function installedDigests(directory) {
  const files = readTree(directory);
  for (const file of files.keys())
    if (file.startsWith('node_modules/')) files.delete(file);
  return digests(files);
}
const digests = files =>
  Object.fromEntries(
    [...files]
      .map(([file, bytes]) => [file, protocol.sha256(bytes)])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );

// Rebuild the corrected npm layout with the generic release mechanism: exact
// authenticated bytes plus the canonical patch, no offset or fuzz.
function reconstruct(original, patch, directory) {
  for (const file of original.files) {
    const absolute = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, original.fileContents.get(file.path), {
      flag: 'wx',
      mode: file.mode & 0o777,
    });
  }
  applyExactPatch(patch, directory);
  const files = readTree(directory);
  return {
    files,
    archive: packFiles(
      new Map(
        [...files].map(([file, bytes]) => [
          file,
          { bytes, mode: fs.statSync(path.join(directory, file)).mode },
        ]),
      ),
    ),
  };
}

// Same invocation-private adapter as the app-tools native server compiler:
// the version module reports tsrs's embedded TypeScript and getExePath selects
// the metadata-bound Effect tsrs executable. Nothing is copied or relabelled.
function nativeAdapter({ fixture, directory, run, env }) {
  const fixtureRequire = createRequire(path.join(fixture, 'package.json'));
  const tsrs = JSON.parse(
    fs.readFileSync(fixtureRequire.resolve('tsrs/package.json')),
  );
  assert.equal(tsrs.version, fixtureDependencies.tsrs);
  assert.match(tsrs.tsrs.typescriptVersion, /^7\.1\.\d+(?:-[\w.]+)?$/u);
  assert.match(tsrs.tsrs.typescriptCommit, /^[a-f\d]{40}$/u);
  const effectManifest = fixtureRequire.resolve('@effect/tsgo/package.json');
  const effect = JSON.parse(fs.readFileSync(effectManifest));
  assert.equal(effect.version, fixtureDependencies['@effect/tsgo']);
  const platformName = `@effect/tsgo-${process.platform}-${process.arch}`;
  const platformManifest = createRequire(effectManifest).resolve(
    `${platformName}/package.json`,
  );
  const platform = JSON.parse(fs.readFileSync(platformManifest));
  assert.equal(platform.name, platformName);
  assert.equal(platform.version, effect.version);
  const upstream = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(platformManifest), 'lib/upstream.json'),
    ),
  );
  const component = upstream.components?.tsrs?.[tsrs.version];
  assert.equal(upstream.schemaVersion, 5);
  assert.match(component?.gitHead ?? '', /^[a-f\d]{40}$/u);
  assert.equal(component.typescript?.version, tsrs.tsrs.typescriptVersion);
  assert.equal(component.typescript.gitHead, tsrs.tsrs.typescriptCommit);
  const executable = path.join(
    path.dirname(platformManifest),
    'artifacts/tsrs',
    tsrs.version,
    process.platform === 'win32' ? 'tsrs.exe' : 'tsrs',
  );
  const stamp = run(executable, ['--version'], fixture, env);
  assert.equal(stamp.status, 0, stamp.output);
  const match =
    /\+effect-tsgo\.([\d.]+) \(tsrs ([^,]+), microsoft\/TypeScript@([a-f\d]{12,})\)\s*$/u.exec(
      stamp.output,
    );
  assert(match, `unstamped Effect tsrs: ${stamp.output}`);
  assert.equal(match[1], effect.version);
  assert.equal(match[2], tsrs.version);
  assert(tsrs.tsrs.typescriptCommit.startsWith(match[3]));
  fs.mkdirSync(directory);
  writeFiles(directory, {
    'package.json': '{"type":"commonjs"}\n',
    'compiler.cjs': `exports.version = ${JSON.stringify(tsrs.tsrs.typescriptVersion)};\n`,
    'getExePath.js': `module.exports = () => {\n  process.env.TSRS_CHECKER_ASSIGNMENT = "go";\n  return ${JSON.stringify(executable)};\n};\n`,
  });
  return { executable, typescriptPath: path.join(directory, 'compiler.cjs') };
}

/**
 * Closed rsbuild-plugin-dts@1.0.7 qualifier. Source mode authenticates the
 * npm source and reconstructs the corrected archive; packed mode installs the
 * actual transported archive. Both prove, with unchanged @rslib/core 1.0.7 and
 * the real Effect tsrs TypeScript 7.1 adapter, that the registry plugin fails
 * on typescript/sync while the corrected plugin emits declarations and still
 * reports compiler and declaration-emit diagnostics.
 */
export async function qualifyDtsPlugin({
  workDirectory,
  toolchain,
  payload,
  run: spawn = spawnSync,
  log = console.log,
  fetchBytes = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert(response.ok, `fetch ${url}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
}) {
  assert(path.isAbsolute(workDirectory), 'absolute workDirectory required');
  assert(
    toolchain && path.isAbsolute(toolchain.storeDirectory),
    'external storeDirectory required',
  );
  assert(payload === undefined || Buffer.isBuffer(payload));
  const input = inputs[name];
  assert.equal(input.version, protocol.cohort[name]);
  assert.equal(identity.name, name);
  assert.equal(identity.version, input.version);
  assert.equal(identity.tarball, input.upstream.request);
  assert.equal(identity.integrity, input.upstream.integrity);
  assert.equal(input.upstream.kind, 'authenticated-npm-source');
  assert.equal(input.upstream.sourceArchiveIntegrity, input.upstream.integrity);
  const patch = fs.readFileSync(path.join(root, input.patchPath));
  assert.equal(protocol.sha256(patch), input.patchSha256, 'canonical patch');
  fs.mkdirSync(workDirectory, { recursive: true });
  const work = fs.realpathSync(workDirectory);
  fs.mkdirSync(toolchain.storeDirectory, { recursive: true });
  const store = fs.realpathSync(toolchain.storeDirectory);
  assert(
    store !== work && !store.startsWith(work + path.sep),
    'store must be external to workDirectory',
  );
  const node = toolchain.node ?? process.execPath;
  const pnpm = toolchain.pnpm ?? 'pnpm';
  const temporary = fs.mkdtempSync(path.join(work, 'dts-plugin-'));
  const fixture = path.join(temporary, 'fixture');
  const environment = {
    ...buildEnvironment(),
    CI: 'true',
    TMPDIR: temporary,
  };
  const run = (command, args, cwd, env = environment) => {
    const result = spawn(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert(!result.error, String(result.error));
    const output = stripVTControlCharacters(
      `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
    if (output) log(output);
    return { status: result.status, output };
  };
  try {
    writeFiles(fixture, {
      'package.json': { private: true, packageManager: 'pnpm@12.21.0' },
    });
    assert.equal(
      run(pnpm, ['--version'], fixture).output.trim(),
      '12.21.0',
      'pinned pnpm toolchain required',
    );
    const sourceArchiveBytes = Buffer.from(
      await fetchBytes(input.upstream.request),
    );
    assert.equal(
      authenticateArchive(identity, sourceArchiveBytes).authentication.scheme,
      'npm-registry-ecdsa-sha256+sha512',
    );
    const original = inspectSupportTarball(sourceArchiveBytes);
    assert.equal(original.packageJson.name, name);
    const licenseBytes = original.fileContents.get(input.upstream.licensePath);
    assert(licenseBytes, 'npm license required');
    assert.equal(protocol.sha256(licenseBytes), input.upstream.licenseSha256);
    const corrected = reconstruct(
      original,
      patch,
      path.join(temporary, 'corrected'),
    );
    const archive = payload ?? corrected.archive;
    assert.equal(
      protocol.integrity(archive),
      protocol.integrity(corrected.archive),
      'actual payload differs from exact reconstruction',
    );
    const archivePath = path.join(temporary, `${name}-corrected.tgz`);
    fs.writeFileSync(archivePath, archive);

    for (const [directory, files] of Object.entries(localPackages))
      writeFiles(path.join(fixture, directory), files);
    writeFiles(fixture, {
      'package.json': {
        private: true,
        type: 'module',
        packageManager: 'pnpm@12.21.0',
        dependencies: {
          ...fixtureDependencies,
          [name]: `file:${archivePath}`,
          'dts-outer': 'file:./dts-outer',
        },
      },
      'pnpm-workspace.yaml':
        'packages: []\nstrictPeerDependencies: true\nautoInstallPeers: false\npackageImportMethod: clone-or-copy\n',
    });
    const install = run(
      pnpm,
      [
        'install',
        '--ignore-scripts',
        '--no-frozen-lockfile',
        '--store-dir',
        store,
      ],
      fixture,
    );
    assert.equal(install.status, 0, install.output);

    // Raw control is Rslib's own registry dependency; the corrected plugin is
    // the fixture's direct archive dependency. Both are byte-authenticated.
    const fixtureRequire = createRequire(path.join(fixture, 'package.json'));
    const rslibManifest = fs.realpathSync(
      fixtureRequire.resolve('@rslib/core/package.json'),
    );
    assert.equal(
      JSON.parse(fs.readFileSync(rslibManifest)).version,
      fixtureDependencies['@rslib/core'],
    );
    const rslibRequire = createRequire(rslibManifest);
    assert.equal(
      fs.realpathSync(rslibRequire.resolve('@rsbuild/core')),
      fs.realpathSync(fixtureRequire.resolve('@rsbuild/core')),
      'corrected plugin peer must be the Rsbuild instance Rslib uses',
    );
    const plugins = {
      raw: fs.realpathSync(rslibRequire.resolve(name)),
      corrected: fs.realpathSync(fixtureRequire.resolve(name)),
    };
    const packageDirectory = entry => path.resolve(entry, '../..');
    assert.notEqual(
      packageDirectory(plugins.raw),
      packageDirectory(plugins.corrected),
    );
    assert.deepEqual(
      installedDigests(packageDirectory(plugins.raw)),
      digests(original.fileContents),
      'installed raw plugin differs from authenticated npm source',
    );
    assert.deepEqual(
      installedDigests(packageDirectory(plugins.corrected)),
      digests(corrected.files),
      'installed corrected plugin differs from its archive',
    );

    const adapter = nativeAdapter({
      fixture,
      directory: path.join(temporary, 'adapter'),
      run,
      env: environment,
    });
    const build = (plugin, caseName) => {
      const app = path.join(fixture, 'cases', caseName);
      fs.rmSync(app, { recursive: true, force: true });
      writeFiles(app, {
        'package.json': {
          name: `dts-${caseName}`,
          private: true,
          type: 'module',
        },
        'tsconfig.json': {
          compilerOptions: {
            declaration: true,
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2022',
            strict: true,
            types: [],
            rootDir: 'src',
          },
          include: ['src'],
        },
        'src/index.ts': cases[caseName],
      });
      const result = run(
        node,
        [
          fileURLToPath(new URL('./dts-plugin-build.mjs', import.meta.url)),
          fixture,
          plugins[plugin],
          adapter.typescriptPath,
          app,
        ],
        app,
      );
      const emitted = path.join(app, 'dist/types/index.d.ts');
      return {
        ...result,
        app,
        declaration: fs.existsSync(emitted)
          ? fs.readFileSync(emitted, 'utf8')
          : null,
      };
    };

    const raw = build('raw', 'declaration');
    assert.notEqual(raw.status, 0, 'registry plugin must fail on TS 7.1');
    assert.match(raw.output, /typescript\/sync/u);
    assert.equal(raw.declaration, null);

    const emitted = build('corrected', 'declaration');
    assert.equal(emitted.status, 0, emitted.output);
    assert.equal(
      emitted.declaration,
      'export declare const greet: (name: string) => string;\n',
    );

    const compilerError = build('corrected', 'compiler-error');
    assert.notEqual(compilerError.status, 0, 'compiler errors must abort');
    assert.match(
      compilerError.output,
      /error TS2322: Type 'string' is not assignable to type 'number'/u,
    );

    const emitOnly = build('corrected', 'emit-only');
    const check = run(
      adapter.executable,
      ['-p', 'tsconfig.json', '--noEmit', '--declaration', 'false'],
      emitOnly.app,
      { ...environment, TSRS_CHECKER_ASSIGNMENT: 'go' },
    );
    assert.equal(check.status, 0, 'emit-only fixture must type-check');
    assert.notEqual(emitOnly.status, 0, 'declaration diagnostics must abort');
    assert.match(
      emitOnly.output,
      /error TS2883: The inferred type of 'value' cannot be named [^\n]*dts-inner/u,
    );
    log(
      `PASS ${name}@${input.version}: authenticated npm source, exact patch, raw typescript/sync failure, corrected ${payload ? 'transported' : 'reconstructed'} declarations and diagnostics`,
    );
    return {
      sourceArchiveBytes,
      builtPatchBytes: patch,
      licenseBytes,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
