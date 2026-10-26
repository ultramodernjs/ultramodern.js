import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getBuildConfigEnvironment,
  resolveEffectTsgoCompiler,
} from '../../src/build-config/public';

const nativePlatformName = `@typescript/typescript-${process.platform}-${process.arch}`;
const effectPlatformName = `@effect/tsgo-${process.platform}-${process.arch}`;
const compilerBasename = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
const nativeGitHead = '2bd066d87f5bafd315be9f40889d0a60b9e58e0b';
const nativeVersion = '7.0.2';
const nextNativeVersion = '7.1.0';
const fixtureRequire = createRequire(import.meta.url);
const effectVersion = JSON.parse(
  readFileSync(fixtureRequire.resolve('@effect/tsgo/package.json'), 'utf8'),
).version;
const tsrsManifestPath = fixtureRequire.resolve('tsrs/package.json');
const tsrsManifest = JSON.parse(readFileSync(tsrsManifestPath, 'utf8'));
const tsrsRequire = createRequire(tsrsManifestPath);
const { getPlatformPackageName } = tsrsRequire(
  join(dirname(tsrsManifestPath), 'lib/platform.js'),
) as { getPlatformPackageName: () => string };
const tsrsSupported =
  [
    '@tsrs/darwin-arm64',
    '@tsrs/linux-x64-gnu',
    '@tsrs/linux-arm64-gnu',
  ].includes(getPlatformPackageName()) &&
  tsrsManifest.optionalDependencies[getPlatformPackageName()] ===
    tsrsManifest.version;
const tsrsTest = tsrsSupported ? test : test.skip;

test('resolves the repository root origin to its actual declared Effect compiler cohort', async () => {
  const from = join(import.meta.dirname, '../../../../../package.json');
  const rootRequire = createRequire(from);
  const root = JSON.parse(readFileSync(from, 'utf8'));
  const effect = rootRequire('@effect/tsgo/package.json');
  const tsrs = rootRequire('tsrs/package.json');
  assert.equal(effect.version, root.devDependencies['@effect/tsgo']);
  assert.equal(tsrs.version, root.devDependencies.tsrs);
  await withEnvironment('EFFECT_TSGO_BIN', undefined, () =>
    withEnvironment('TSRS_BINARY', undefined, () => {
      const compiler = resolveEffectTsgoCompiler({ from });
      const version = execFileSync(compiler, ['--version'], {
        encoding: 'utf8',
      });
      assert.ok(version.includes(`+effect-tsgo.${effect.version}`));
      if (tsrsSupported) assert.ok(version.includes(`tsrs ${tsrs.version}`));
    }),
  );
});

async function withEnvironment<T>(
  name: string,
  value: string | undefined,
  action: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env[name];

  try {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function withWorkingDirectory<T>(directory: string, action: () => T): T {
  const previous = process.cwd();

  try {
    process.chdir(directory);
    return action();
  } finally {
    process.chdir(previous);
  }
}

// The latest TypeScript replacement ships in lib/, every other version under
// artifacts/typescript/<version>/.
function effectCompilerPath(
  directory: string,
  version = nativeVersion,
): string {
  const platformDirectory = join(directory, 'node_modules', effectPlatformName);
  return version === nativeVersion
    ? join(platformDirectory, 'lib', compilerBasename)
    : join(
        platformDirectory,
        'artifacts/typescript',
        version,
        compilerBasename,
      );
}

function effectMetadataPath(directory: string): string {
  return join(
    directory,
    'node_modules',
    effectPlatformName,
    'lib/upstream.json',
  );
}

function writeEffectTsgoPackage(directory: string): void {
  const packageDirectory = join(directory, 'node_modules/@effect/tsgo');
  mkdirSync(join(packageDirectory, 'bin'), { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: '@effect/tsgo',
      version: effectVersion,
      bin: { 'effect-tsgo': './bin/effect-tsgo.js' },
      exports: { './package.json': './package.json' },
      optionalDependencies: { [effectPlatformName]: effectVersion },
    }),
  );
  writeFileSync(
    join(packageDirectory, 'bin/effect-tsgo.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'cli-started'))}, 'unexpected spawn');\nthrow new Error('Effect discovery must not execute its CLI');\n`,
  );
  writeTypeScriptPackage(
    join(directory, 'node_modules/typescript'),
    nativeVersion,
  );
  writeNativePlatformPackage(
    join(directory, 'node_modules', nativePlatformName),
  );
  const platformDirectory = join(directory, 'node_modules', effectPlatformName);
  mkdirSync(join(platformDirectory, 'lib'), { recursive: true });
  writeFileSync(
    join(platformDirectory, 'package.json'),
    JSON.stringify({
      name: effectPlatformName,
      version: effectVersion,
      os: [process.platform],
      cpu: [process.arch],
      exports: { './package.json': './package.json' },
    }),
  );
  writeFileSync(
    effectMetadataPath(directory),
    JSON.stringify({
      schemaVersion: 5,
      tags: { typescript: { latest: nativeVersion } },
      components: {
        typescript: {
          [nativeVersion]: {
            gitHead: nativeGitHead,
            provider: 'typescript-go',
          },
        },
      },
    }),
  );
}

function writeTypeScriptPackage(directory: string, version: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'typescript',
      version,
      gitHead: nativeGitHead,
      bin: { tsc: './bin/tsc' },
      optionalDependencies: { [nativePlatformName]: version },
      exports: { './package.json': './package.json' },
    }),
  );
}

function writeNativePlatformPackage(
  directory: string,
  version = nativeVersion,
): void {
  mkdirSync(join(directory, 'lib'), { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: nativePlatformName,
      version,
      gitHead: nativeGitHead,
      os: [process.platform],
      cpu: [process.arch],
      exports: { './package.json': './package.json' },
    }),
  );
  writeFileSync(
    join(directory, 'lib', compilerBasename),
    'native TypeScript compiler\n',
  );
}

function writeCompiler(compilerPath: string, mode: number): void {
  mkdirSync(join(compilerPath, '..'), { recursive: true });
  writeFileSync(
    compilerPath,
    `#!/usr/bin/env node\nconsole.log('fixture compiler');\n`,
  );
  chmodSync(compilerPath, mode);
}

function writeTsrsPackage(directory: string): string {
  const owner = join(directory, 'node_modules/tsrs');
  mkdirSync(join(owner, 'lib'), { recursive: true });
  writeFileSync(join(owner, 'package.json'), JSON.stringify(tsrsManifest));
  copyFileSync(
    join(dirname(tsrsManifestPath), 'lib/platform.js'),
    join(owner, 'lib/platform.js'),
  );
  // Bundled discovery must not resolve, execute, or mutate the installed
  // native tsrs binary. The official provider proxy does not need it either.
  writeFileSync(
    join(owner, 'lib/getExePath.js'),
    'throw new Error("Installed tsrs binary must not be used");',
  );
  const effectManifest = fixtureRequire.resolve('@effect/tsgo/package.json');
  const effectPlatformManifest = createRequire(effectManifest).resolve(
    `${effectPlatformName}/package.json`,
  );
  const metadata = JSON.parse(
    readFileSync(
      join(dirname(effectPlatformManifest), 'lib/upstream.json'),
      'utf8',
    ),
  );
  writeFileSync(effectMetadataPath(directory), JSON.stringify(metadata));
  const relativeArtifact = join(
    'artifacts/tsrs',
    tsrsManifest.version,
    process.platform === 'win32' ? 'tsrs.exe' : 'tsrs',
  );
  const compiler = join(
    directory,
    'node_modules',
    effectPlatformName,
    relativeArtifact,
  );
  mkdirSync(dirname(compiler), { recursive: true });
  symlinkSync(
    join(dirname(effectPlatformManifest), relativeArtifact),
    compiler,
    'file',
  );
  return compiler;
}

for (const format of ['cjs', 'esm-node']) {
  test(`loads ${format} config from a renamed package with URL-sensitive paths`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-tools-owning-url #%-'));
    const moduleFilename =
      format === 'cjs' ? 'build-environment.js' : 'build-environment.mjs';
    const builtDirectory = join(import.meta.dirname, '../../dist');

    try {
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: '@ultramodern/renamed-build-config',
          exports: {
            './internal-effect-discovery': './internal-effect-discovery.cjs',
          },
        }),
      );
      copyFileSync(
        join(builtDirectory, format, 'build-config', moduleFilename),
        join(directory, moduleFilename),
      );
      copyFileSync(
        join(builtDirectory, 'cjs/build-config/internal-effect-discovery.js'),
        join(directory, 'internal-effect-discovery.cjs'),
      );
      const environment = {
        ...process.env,
        BUILD_CONFIG_PACKAGE_URL_FIXTURE: 'recognized',
      };
      delete environment.NODE_OPTIONS;
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import assert from 'node:assert/strict';
            import { createRequire } from 'node:module';
            const [format, filename] = process.argv.slice(1);
            const config = format === 'cjs'
              ? createRequire(import.meta.url)(filename)
              : await import(filename);
            assert.equal(config.getBuildConfigEnvironment('BUILD_CONFIG_PACKAGE_URL_FIXTURE'), 'recognized');
          `,
          format,
          format === 'cjs'
            ? join(directory, moduleFilename)
            : pathToFileURL(join(directory, moduleFilename)).href,
        ],
        { env: environment, encoding: 'utf8', stdio: 'pipe' },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('reads build config environment without process-global state', async () => {
  await withEnvironment('ZE_FAIL_BUILD', 'true', () => {
    assert.equal(getBuildConfigEnvironment('ZE_FAIL_BUILD'), 'true');
  });
  await withEnvironment('ZE_FAIL_BUILD', undefined, () => {
    assert.equal(getBuildConfigEnvironment('ZE_FAIL_BUILD'), undefined);
  });
  assert.deepEqual(
    Object.getOwnPropertySymbols(process).filter(symbol =>
      symbol.description?.startsWith('@modern-js/app-tools/'),
    ),
    [],
  );
});

test('resolves only the packaged TypeScript compiler with Oxlint installed', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-oxlint-'),
  );
  const compilerPath = effectCompilerPath(directory);

  try {
    writeEffectTsgoPackage(directory);
    writeCompiler(compilerPath, 0o700);
    // `effect-tsgo get-exe-path` discovered every integration first, so an
    // Oxlint without a musl binding failed the TypeScript lookup on Alpine.
    for (const [name, version] of [
      ['oxlint', '1.85.0'],
      ['oxlint-tsgolint', '7.0.2003'],
    ]) {
      mkdirSync(join(directory, 'node_modules', name), { recursive: true });
      writeFileSync(
        join(directory, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, version }),
      );
    }

    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.equal(
        resolveEffectTsgoCompiler({
          from: pathToFileURL(join(directory, 'modern.config.ts')),
        }),
        realpathSync(compilerPath),
      );
      assert.equal(existsSync(join(directory, 'cli-started')), false);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repairs Unix execute bits and preserves Windows package paths without mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'app-tools-effect-tsgo-mode-'));
  const compilerPath = effectCompilerPath(directory);
  const temporaryRoot = join(directory, 'tmp');

  try {
    mkdirSync(temporaryRoot);
    writeCompiler(compilerPath, 0o600);
    writeEffectTsgoPackage(directory);
    await withEnvironment('TMPDIR', temporaryRoot, () =>
      withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
        const firstResolution = resolveEffectTsgoCompiler({
          from: pathToFileURL(join(directory, 'modern.config.ts')),
        });
        const secondResolution = resolveEffectTsgoCompiler({
          from: pathToFileURL(join(directory, 'modern.config.ts')),
        });

        if (process.platform === 'win32') {
          assert.equal(firstResolution, compilerPath);
        } else {
          assert.notEqual(firstResolution, compilerPath);
          accessSync(firstResolution, constants.X_OK);
          assert.throws(() => accessSync(compilerPath, constants.X_OK));
        }
        assert.equal(secondResolution, firstResolution);
        assert.equal(
          readFileSync(firstResolution, 'utf-8'),
          readFileSync(compilerPath, 'utf-8'),
        );
        // Windows needs Node for this JS fixture; Unix must execute the repaired file.
        assert.equal(
          execFileSync(
            process.platform === 'win32' ? process.execPath : firstResolution,
            process.platform === 'win32' ? [firstResolution] : [],
            { encoding: 'utf-8' },
          ).trim(),
          'fixture compiler',
        );
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deduplicates Unix executable copies while retaining native Windows paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'app-tools-effect-tsgo-cache-'));
  const firstPackage = join(directory, 'first');
  const secondPackage = join(directory, 'second');
  const temporaryRoot = join(directory, 'tmp');
  const firstCompiler = effectCompilerPath(firstPackage);
  const secondCompiler = effectCompilerPath(secondPackage);

  try {
    mkdirSync(temporaryRoot);
    writeCompiler(firstCompiler, 0o600);
    writeCompiler(secondCompiler, 0o600);
    writeEffectTsgoPackage(firstPackage);
    writeEffectTsgoPackage(secondPackage);

    await withEnvironment('TMPDIR', temporaryRoot, () =>
      withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
        const firstResolution = resolveEffectTsgoCompiler({
          from: pathToFileURL(join(firstPackage, 'modern.config.ts')),
        });
        const secondResolution = resolveEffectTsgoCompiler({
          from: pathToFileURL(join(secondPackage, 'modern.config.ts')),
        });

        if (process.platform === 'win32') {
          assert.equal(firstResolution, firstCompiler);
          assert.equal(secondResolution, secondCompiler);
        } else {
          assert.equal(secondResolution, firstResolution);
          accessSync(firstResolution, constants.X_OK);
        }
        for (const resolvedCompiler of [firstResolution, secondResolution]) {
          assert.equal(
            execFileSync(process.execPath, [resolvedCompiler], {
              encoding: 'utf-8',
            }).trim(),
            'fixture compiler',
          );
        }
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects an executable override that is not an Effect-enabled compiler', async () => {
  await withEnvironment('EFFECT_TSGO_BIN', process.execPath, () => {
    assert.throws(
      () => resolveEffectTsgoCompiler({ from: import.meta.url }),
      /Configured compiler validation failed.*Effect-enabled native compiler/su,
    );
  });
});

tsrsTest(
  'prefers verified bundled tsrs using real capability metadata from the requesting origin',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-tools-effect-tsrs-'));
    try {
      writeEffectTsgoPackage(directory);
      const compiler = writeTsrsPackage(directory);
      await withEnvironment('EFFECT_TSGO_BIN', undefined, () =>
        withEnvironment('TSRS_BINARY', undefined, () => {
          assert.equal(
            resolveEffectTsgoCompiler({
              from: join(directory, 'modern.config.ts'),
            }),
            realpathSync(compiler),
          );
          assert.equal(existsSync(join(directory, 'cli-started')), false);
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

tsrsTest(
  'validates explicit and TSRS_BINARY selections with truthful aliases without changing assignment in the parent',
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'app-tools-effect-tsrs-override-'),
    );
    try {
      writeEffectTsgoPackage(directory);
      const compiler = writeTsrsPackage(directory);
      const manifestFile = join(directory, 'node_modules/tsrs/package.json');
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      manifest.name = '@ont-os/tsrs-candidate';
      writeFileSync(manifestFile, JSON.stringify(manifest));
      const renamed = join(directory, 'selected-compiler');
      symlinkSync(compiler, renamed, 'file');
      const from = join(directory, 'modern.config.ts');
      await withEnvironment(
        'TSRS_CHECKER_ASSIGNMENT',
        'round-robin',
        async () => {
          await withEnvironment('EFFECT_TSGO_BIN', renamed, () => {
            assert.equal(resolveEffectTsgoCompiler({ from }), renamed);
          });
          await withEnvironment('EFFECT_TSGO_BIN', undefined, () =>
            withEnvironment('TSRS_BINARY', renamed, () => {
              assert.equal(
                resolveEffectTsgoCompiler({ from }),
                realpathSync(renamed),
              );
            }),
          );
          assert.equal(process.env.TSRS_CHECKER_ASSIGNMENT, 'round-robin');
        },
      );
      await withEnvironment('EFFECT_TSGO_BIN', undefined, () =>
        withEnvironment('TSRS_BINARY', process.execPath, () => {
          assert.throws(
            () => resolveEffectTsgoCompiler({ from }),
            /Native tsrs validation failed.*Effect-enabled tsrs/su,
          );
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

for (const mutation of [
  'target-version',
  'embedded-commit',
  'missing-artifact',
  'unpatched',
] as const) {
  tsrsTest(
    `does not fall back to TypeScript when installed tsrs has ${mutation}`,
    async () => {
      const directory = mkdtempSync(
        join(tmpdir(), 'app-tools-effect-tsrs-invalid-'),
      );
      try {
        writeEffectTsgoPackage(directory);
        const compiler = writeTsrsPackage(directory);
        // A fallback artifact exists, but must never hide a broken tsrs selection.
        writeCompiler(effectCompilerPath(directory), 0o700);
        if (mutation === 'target-version') {
          const filename = join(directory, 'node_modules/tsrs/package.json');
          const manifest = JSON.parse(readFileSync(filename, 'utf8'));
          manifest.optionalDependencies[getPlatformPackageName()] = '0.17.0';
          writeFileSync(filename, JSON.stringify(manifest));
        } else if (mutation === 'embedded-commit') {
          const filename = effectMetadataPath(directory);
          const metadata = JSON.parse(readFileSync(filename, 'utf8'));
          metadata.components.tsrs[tsrsManifest.version].typescript.gitHead =
            'f'.repeat(40);
          writeFileSync(filename, JSON.stringify(metadata));
        } else if (mutation === 'missing-artifact') {
          rmSync(dirname(compiler), { recursive: true, force: true });
        } else {
          rmSync(compiler);
          writeCompiler(compiler, 0o700);
        }
        await withEnvironment('EFFECT_TSGO_BIN', undefined, () =>
          withEnvironment('TSRS_BINARY', undefined, () => {
            assert.throws(
              () =>
                resolveEffectTsgoCompiler({
                  from: join(directory, 'modern.config.ts'),
                }),
              /Native tsrs (?:package resolution|validation) failed/u,
            );
          }),
        );
        assert.equal(existsSync(join(directory, 'cli-started')), false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

for (const target of [
  '@tsrs/win32-x64',
  '@tsrs/darwin-x64',
  '@tsrs/linux-x64-musl',
  '@tsrs/linux-arm64-musl',
]) {
  test(`selects Effect-Go when Effect does not package declared tsrs target ${target}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-tools-effect-go-host-'));
    try {
      writeEffectTsgoPackage(directory);
      writeCompiler(effectCompilerPath(directory), 0o700);
      const owner = join(directory, 'node_modules/tsrs');
      mkdirSync(join(owner, 'lib'), { recursive: true });
      const manifest = {
        ...tsrsManifest,
        optionalDependencies: { ...tsrsManifest.optionalDependencies },
      };
      manifest.optionalDependencies[target] = tsrsManifest.version;
      writeFileSync(join(owner, 'package.json'), JSON.stringify(manifest));
      writeFileSync(
        join(owner, 'lib/platform.js'),
        `export const getPlatformPackageName = () => ${JSON.stringify(target)};`,
      );
      writeFileSync(
        join(owner, 'lib/getExePath.js'),
        'throw new Error("Unsupported tsrs resolver must not run");',
      );
      await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
        assert.equal(
          resolveEffectTsgoCompiler({
            from: join(directory, 'modern.config.ts'),
          }),
          realpathSync(effectCompilerPath(directory)),
        );
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const mutation of [
  'declared-missing-binary',
  'target-version',
  'missing-helper',
  'missing-metadata',
  'empty-metadata',
]) {
  test(`does not treat ${mutation} as an unsupported tsrs host`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'app-tools-effect-tsrs-capability-'),
    );
    try {
      writeEffectTsgoPackage(directory);
      writeCompiler(effectCompilerPath(directory), 0o700);
      const owner = join(directory, 'node_modules/tsrs');
      mkdirSync(join(owner, 'lib'), { recursive: true });
      const manifest = {
        ...tsrsManifest,
        optionalDependencies: { '@tsrs/darwin-arm64': tsrsManifest.version },
      };
      if (mutation === 'target-version')
        manifest.optionalDependencies['@tsrs/darwin-arm64'] = '0.17.0';
      if (mutation === 'missing-metadata')
        delete (manifest as Partial<typeof manifest>).optionalDependencies;
      if (mutation === 'empty-metadata')
        Reflect.deleteProperty(
          manifest.optionalDependencies,
          '@tsrs/darwin-arm64',
        );
      writeFileSync(join(owner, 'package.json'), JSON.stringify(manifest));
      if (mutation !== 'missing-helper')
        writeFileSync(
          join(owner, 'lib/platform.js'),
          'export const getPlatformPackageName = () => "@tsrs/darwin-arm64";',
        );
      writeFileSync(
        join(owner, 'lib/getExePath.js'),
        'export default function getExePath() { throw new Error("Missing declared native binary"); }',
      );
      await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
        assert.throws(
          () =>
            resolveEffectTsgoCompiler({
              from: join(directory, 'modern.config.ts'),
            }),
          /Native tsrs (?:package resolution|validation) failed/u,
        );
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('resolves Effect TS-Go from the requesting module origin', async () => {
  const originDirectory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-origin-'),
  );
  const workingDirectory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-cwd-'),
  );
  const originCompilerPath = effectCompilerPath(originDirectory);
  const cwdCompilerPath = effectCompilerPath(workingDirectory);

  try {
    writeEffectTsgoPackage(originDirectory);
    writeEffectTsgoPackage(workingDirectory);
    writeCompiler(originCompilerPath, 0o700);
    writeCompiler(cwdCompilerPath, 0o700);
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      withWorkingDirectory(workingDirectory, () => {
        assert.equal(
          resolveEffectTsgoCompiler({
            from: pathToFileURL(join(originDirectory, 'modern.config.ts')),
          }),
          realpathSync(originCompilerPath),
        );
      });
    });
  } finally {
    rmSync(originDirectory, { recursive: true, force: true });
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test('selects the installed native alias from the original anchor without running the provider CLI', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-backend-'),
  );
  const appDirectory = join(directory, 'app');
  const stagingDirectory = join(directory, 'empty-stage');
  const nativeDirectory = join(directory, 'selected-native');
  const compilerPath = effectCompilerPath(appDirectory);
  try {
    mkdirSync(stagingDirectory);
    writeEffectTsgoPackage(appDirectory);
    writeTypeScriptPackage(
      join(appDirectory, 'node_modules/typescript'),
      '5.9.3',
    );
    writeTypeScriptPackage(nativeDirectory, '7.0.2');
    writeNativePlatformPackage(
      join(nativeDirectory, 'node_modules', nativePlatformName),
    );
    mkdirSync(join(appDirectory, 'node_modules/@typescript'), {
      recursive: true,
    });
    symlinkSync(
      nativeDirectory,
      join(appDirectory, 'node_modules/@typescript/native'),
      'dir',
    );
    writeCompiler(compilerPath, 0o700);
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      withWorkingDirectory(stagingDirectory, () => {
        assert.equal(
          resolveEffectTsgoCompiler({
            from: pathToFileURL(
              join(appDirectory, 'module-federation.config.ts'),
            ),
          }),
          realpathSync(compilerPath),
        );
        assert.equal(existsSync(join(appDirectory, 'cli-started')), false);
        assert.equal(process.cwd(), realpathSync(stagingDirectory));
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selects the exact canonical native version instead of another artifact with the same gitHead', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-exact-version-'),
  );
  try {
    writeEffectTsgoPackage(directory);
    writeTypeScriptPackage(
      join(directory, 'node_modules/@typescript/native'),
      nextNativeVersion,
    );
    writeCompiler(effectCompilerPath(directory), 0o700);
    writeCompiler(effectCompilerPath(directory, nextNativeVersion), 0o700);
    writeFileSync(
      effectMetadataPath(directory),
      JSON.stringify({
        schemaVersion: 5,
        tags: { typescript: { latest: nativeVersion } },
        components: {
          typescript: {
            [nextNativeVersion]: {
              gitHead: nativeGitHead,
              provider: 'typescript-go',
            },
            [nativeVersion]: {
              gitHead: nativeGitHead,
              provider: 'typescript-go',
            },
          },
        },
      }),
    );
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.equal(
        resolveEffectTsgoCompiler({
          from: pathToFileURL(join(directory, 'modern.config.ts')),
        }),
        realpathSync(effectCompilerPath(directory)),
      );
      assert.equal(existsSync(join(directory, 'cli-started')), false);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selects a non-latest native version from the versioned artifacts', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-next-version-'),
  );
  try {
    writeEffectTsgoPackage(directory);
    writeTypeScriptPackage(
      join(directory, 'node_modules/typescript'),
      nextNativeVersion,
    );
    writeNativePlatformPackage(
      join(directory, 'node_modules', nativePlatformName),
      nextNativeVersion,
    );
    writeCompiler(effectCompilerPath(directory), 0o700);
    writeCompiler(effectCompilerPath(directory, nextNativeVersion), 0o700);
    writeFileSync(
      effectMetadataPath(directory),
      JSON.stringify({
        schemaVersion: 5,
        tags: { typescript: { latest: nativeVersion } },
        components: {
          typescript: {
            [nativeVersion]: {
              gitHead: nativeGitHead,
              provider: 'typescript-go',
            },
            [nextNativeVersion]: {
              gitHead: nativeGitHead,
              provider: 'typescript-go',
            },
          },
        },
      }),
    );
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.equal(
        resolveEffectTsgoCompiler({
          from: pathToFileURL(join(directory, 'modern.config.ts')),
        }),
        realpathSync(effectCompilerPath(directory, nextNativeVersion)),
      );
      assert.equal(existsSync(join(directory, 'cli-started')), false);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves an invalid installed TypeScript package instead of choosing the alternate backend', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-invalid-backend-'),
  );
  try {
    writeEffectTsgoPackage(directory);
    writeFileSync(
      join(directory, 'node_modules/typescript/package.json'),
      '{ invalid',
    );
    writeTypeScriptPackage(
      join(directory, 'node_modules/@typescript/native'),
      '7.0.2',
    );
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.throws(
        () =>
          resolveEffectTsgoCompiler({
            from: pathToFileURL(join(directory, 'modern.config.ts')),
          }),
        error => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Native TypeScript package resolution failed/u,
          );
          assert.ok(error.cause instanceof Error);
          assert.match(error.cause.message, /package config|JSON/iu);
          return true;
        },
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a provider with no installed native backend without starting its CLI', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-no-backend-'),
  );
  try {
    writeEffectTsgoPackage(directory);
    writeTypeScriptPackage(join(directory, 'node_modules/typescript'), '5.9.3');
    // Keep the absent-backend fixture independent of the test runner's
    // workspace resolution and any inherited native compiler override.
    const environment = { ...process.env };
    for (const key of ['EFFECT_TSGO_BIN', 'NODE_OPTIONS', 'NODE_PATH']) {
      delete environment[key];
    }
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import assert from 'node:assert/strict';
          const { resolveEffectTsgoCompiler } = await import(process.argv[1]);
          assert.throws(
            () => resolveEffectTsgoCompiler({ from: process.argv[2] }),
            /Native TypeScript package resolution failed.*No native TypeScript backend/su,
          );
        `,
        pathToFileURL(
          join(
            import.meta.dirname,
            '../../dist/esm-node/build-config/build-environment.mjs',
          ),
        ).href,
        pathToFileURL(join(directory, 'modern.config.ts')).href,
      ],
      { env: environment, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
    );
    assert.equal(existsSync(join(directory, 'cli-started')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves an installed TypeScript export with a missing target instead of choosing the alternate', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-broken-export-'),
  );
  const compilerPath = effectCompilerPath(directory);
  const from = pathToFileURL(join(directory, 'modern.config.ts'));
  try {
    writeEffectTsgoPackage(directory);
    writeCompiler(compilerPath, 0o700);
    writeFileSync(
      join(directory, 'node_modules/typescript/package.json'),
      JSON.stringify({
        name: 'typescript',
        version: '7.0.2',
        exports: { './package.json': './missing.json' },
      }),
    );
    writeTypeScriptPackage(
      join(directory, 'node_modules/@typescript/native'),
      '7.0.2',
    );
    let originalError: unknown;
    try {
      createRequire(from).resolve('typescript/package.json');
    } catch (error) {
      originalError = error;
    }
    assert.ok(originalError instanceof Error);
    assert.ok('code' in originalError);
    assert.equal(originalError.code, 'MODULE_NOT_FOUND');
    assert.ok('path' in originalError);
    assert.equal(
      originalError.path,
      join(directory, 'node_modules/typescript'),
    );
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.throws(
        () => resolveEffectTsgoCompiler({ from }),
        error => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Native TypeScript package resolution failed/u,
          );
          assert.ok(error.cause instanceof Error);
          assert.equal(error.cause.message, originalError.message);
          assert.ok('code' in error.cause);
          assert.equal(error.cause.code, 'MODULE_NOT_FOUND');
          return true;
        },
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selects the actual declared generator Effect artifact from an empty staging cwd', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-real-provider-'),
  );
  try {
    const generatorDirectory = join(
      import.meta.dirname,
      '../../../../toolkit/ultramodern-create',
    );
    const generatorManifestPath = join(generatorDirectory, 'package.json');
    const generatorManifest = JSON.parse(
      readFileSync(generatorManifestPath, 'utf-8'),
    );
    const generatorRequire = createRequire(generatorManifestPath);
    const effectManifestPath = generatorRequire.resolve(
      '@effect/tsgo/package.json',
    );
    const nativeManifestPath = generatorRequire.resolve('tsrs/package.json');
    const effectManifest = JSON.parse(
      readFileSync(effectManifestPath, 'utf-8'),
    );
    const nativeManifest = JSON.parse(
      readFileSync(nativeManifestPath, 'utf-8'),
    );
    assert.equal(
      effectManifest.version,
      generatorManifest.dependencies['@effect/tsgo'],
    );
    assert.equal(nativeManifest.version, generatorManifest.dependencies.tsrs);
    assert.equal(nativeManifest.name, 'tsrs');
    assert.match(nativeManifest.tsrs.typescriptVersion, /^7\./u);
    const platformManifestPath = createRequire(effectManifestPath).resolve(
      `${effectPlatformName}/package.json`,
    );
    const upstream = JSON.parse(
      readFileSync(
        join(dirname(platformManifestPath), 'lib/upstream.json'),
        'utf8',
      ),
    );
    assert.equal(upstream.schemaVersion, 5);
    const { getPlatformPackageName: getNativeName } = createRequire(
      nativeManifestPath,
    )(join(dirname(nativeManifestPath), 'lib/platform.js'));
    const supported =
      [
        '@tsrs/darwin-arm64',
        '@tsrs/linux-x64-gnu',
        '@tsrs/linux-arm64-gnu',
      ].includes(getNativeName()) &&
      nativeManifest.optionalDependencies[getNativeName()] ===
        nativeManifest.version;
    if (supported) {
      const component = upstream.components.tsrs[nativeManifest.version];
      assert.equal(
        component.typescript.version,
        nativeManifest.tsrs.typescriptVersion,
      );
      assert.equal(
        component.typescript.gitHead,
        nativeManifest.tsrs.typescriptCommit,
      );
    }
    const expectedCompiler = supported
      ? join(
          dirname(platformManifestPath),
          'artifacts/tsrs',
          nativeManifest.version,
          process.platform === 'win32' ? 'tsrs.exe' : 'tsrs',
        )
      : join(dirname(platformManifestPath), 'lib', compilerBasename);
    const digest = (filename: string) =>
      createHash('sha256').update(readFileSync(filename)).digest('hex');
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      withWorkingDirectory(directory, () => {
        const compiler = resolveEffectTsgoCompiler({
          from: pathToFileURL(
            join(generatorDirectory, 'module-federation.config.ts'),
          ),
        });
        assert.equal(digest(compiler), digest(expectedCompiler));
        assert.deepEqual(
          readFileSync(compiler),
          readFileSync(expectedCompiler),
        );
        accessSync(compiler, constants.X_OK);
        assert.equal(process.cwd(), realpathSync(directory));
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves an installed TypeScript directory with a missing manifest', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-missing-manifest-'),
  );
  try {
    writeEffectTsgoPackage(directory);
    rmSync(join(directory, 'node_modules/typescript/package.json'));
    writeTypeScriptPackage(
      join(directory, 'node_modules/@typescript/native'),
      '7.0.2',
    );
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.throws(
        () =>
          resolveEffectTsgoCompiler({
            from: pathToFileURL(join(directory, 'modern.config.ts')),
          }),
        error => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Native TypeScript package resolution failed/u,
          );
          assert.ok(error.cause instanceof Error);
          assert.ok('code' in error.cause);
          assert.equal(error.cause.code, 'MODULE_NOT_FOUND');
          return true;
        },
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reports stable installation guidance when Effect TS-Go is unavailable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'app-tools-effect-tsgo-'));

  try {
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.throws(
        () =>
          resolveEffectTsgoCompiler({
            from: pathToFileURL(join(directory, 'modern.config.ts')),
          }),
        error => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Install "@effect\/tsgo" and a native TypeScript backend for this build config, or set EFFECT_TSGO_BIN/u,
          );
          assert.match(error.message, /Package CLI resolution failed/u);
          assert.ok(error.cause instanceof Error);
          assert.ok('code' in error.cause);
          assert.equal(error.cause.code, 'MODULE_NOT_FOUND');
          assert.ok(error.message.includes(error.cause.message));
          return true;
        },
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retains malformed Effect metadata and the requesting config origin without running the CLI', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-cli-failure-'),
  );
  const from = pathToFileURL(join(directory, 'module-federation.config.ts'));
  try {
    writeEffectTsgoPackage(directory);
    writeFileSync(effectMetadataPath(directory), '{ invalid');
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.throws(
        () => resolveEffectTsgoCompiler({ from }),
        error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Compiler backend lookup failed/u);
          assert.ok(error.message.includes(from.href));
          assert.ok(error.cause instanceof Error);
          assert.ok(error.cause instanceof SyntaxError);
          assert.equal(existsSync(join(directory, 'cli-started')), false);
          return true;
        },
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves a missing Effect artifact as a backend filesystem error', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'app-tools-effect-tsgo-executable-failure-'),
  );
  const from = pathToFileURL(join(directory, 'module-federation.config.ts'));
  try {
    writeEffectTsgoPackage(directory);
    await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
      assert.throws(
        () => resolveEffectTsgoCompiler({ from }),
        error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Compiler backend lookup failed/u);
          assert.ok(error.cause instanceof Error);
          assert.ok('code' in error.cause);
          assert.equal(error.cause.code, 'ENOENT');
          assert.ok(error.message.includes(error.cause.message));
          return true;
        },
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [name, mutation, expectedStage] of [
  [
    'native platform package name',
    (directory: string) => {
      const filename = join(
        directory,
        'node_modules',
        nativePlatformName,
        'package.json',
      );
      const manifest = JSON.parse(readFileSync(filename, 'utf8'));
      manifest.name = '@typescript/fake-platform';
      writeFileSync(filename, JSON.stringify(manifest));
    },
    'Native TypeScript package resolution',
  ],
  [
    'native platform version',
    (directory: string) => {
      writeNativePlatformPackage(
        join(directory, 'node_modules', nativePlatformName),
        '7.1.0',
      );
    },
    'Native TypeScript package resolution',
  ],
  [
    'native platform gitHead',
    (directory: string) => {
      const filename = join(
        directory,
        'node_modules',
        nativePlatformName,
        'package.json',
      );
      const manifest = JSON.parse(readFileSync(filename, 'utf8'));
      manifest.gitHead = 'f'.repeat(40);
      writeFileSync(filename, JSON.stringify(manifest));
    },
    'Native TypeScript package resolution',
  ],
  [
    'empty native artifact',
    (directory: string) => {
      writeFileSync(
        join(
          directory,
          'node_modules',
          nativePlatformName,
          'lib',
          compilerBasename,
        ),
        '',
      );
    },
    'Native TypeScript package resolution',
  ],
  [
    'Effect platform package name',
    (directory: string) => {
      const filename = join(
        directory,
        'node_modules',
        effectPlatformName,
        'package.json',
      );
      const manifest = JSON.parse(readFileSync(filename, 'utf8'));
      manifest.name = '@effect/fake-platform';
      writeFileSync(filename, JSON.stringify(manifest));
    },
    'Compiler backend lookup',
  ],
  [
    'Effect platform version',
    (directory: string) => {
      const filename = join(
        directory,
        'node_modules',
        effectPlatformName,
        'package.json',
      );
      const manifest = JSON.parse(readFileSync(filename, 'utf8'));
      manifest.version = '0.44.0';
      writeFileSync(filename, JSON.stringify(manifest));
    },
    'Compiler backend lookup',
  ],
  [
    'obsolete metadata schema',
    (directory: string) => {
      const metadata = JSON.parse(
        readFileSync(effectMetadataPath(directory), 'utf8'),
      );
      metadata.schemaVersion = 4;
      writeFileSync(effectMetadataPath(directory), JSON.stringify(metadata));
    },
    'Compiler backend lookup',
  ],
  [
    'missing latest TypeScript tag',
    (directory: string) => {
      const metadata = JSON.parse(
        readFileSync(effectMetadataPath(directory), 'utf8'),
      );
      delete metadata.tags;
      writeFileSync(effectMetadataPath(directory), JSON.stringify(metadata));
    },
    'Compiler backend lookup',
  ],
  [
    'replacement component gitHead',
    (directory: string) => {
      const metadata = JSON.parse(
        readFileSync(effectMetadataPath(directory), 'utf8'),
      );
      metadata.components.typescript[nativeVersion].gitHead = 'f'.repeat(40);
      writeFileSync(effectMetadataPath(directory), JSON.stringify(metadata));
    },
    'Compiler backend lookup',
  ],
  [
    'replacement component provider',
    (directory: string) => {
      const metadata = JSON.parse(
        readFileSync(effectMetadataPath(directory), 'utf8'),
      );
      metadata.components.typescript[nativeVersion].provider = 'typescript';
      writeFileSync(effectMetadataPath(directory), JSON.stringify(metadata));
    },
    'Compiler backend lookup',
  ],
  [
    'empty replacement artifact',
    (directory: string) => {
      writeFileSync(effectCompilerPath(directory), '');
    },
    'Compiler backend lookup',
  ],
  [
    'nonregular replacement artifact',
    (directory: string) => {
      rmSync(effectCompilerPath(directory));
      mkdirSync(effectCompilerPath(directory));
    },
    'Compiler backend lookup',
  ],
] as const) {
  test(`rejects ${name} without executing the provider CLI`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'app-tools-effect-tsgo-invalid-cohort-'),
    );
    try {
      writeEffectTsgoPackage(directory);
      writeCompiler(effectCompilerPath(directory), 0o700);
      mutation(directory);
      await withEnvironment('EFFECT_TSGO_BIN', undefined, () => {
        assert.throws(
          () =>
            resolveEffectTsgoCompiler({
              from: pathToFileURL(join(directory, 'modern.config.ts')),
            }),
          error => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(`${expectedStage} failed`));
            assert.ok(error.cause instanceof Error);
            return true;
          },
        );
        assert.equal(existsSync(join(directory, 'cli-started')), false);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
