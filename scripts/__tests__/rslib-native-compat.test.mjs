import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { getDtsCompilerOptions } from '../tsrs-dts/rslib-options.mjs';

// Explicit clean-room input: this suite neither installs nor downloads tools.
// Its caller owns the fixture, dependency tree, and emitted outputs.
const root = process.env.RSLIB_NATIVE_COMPAT_ROOT;

test('Rslib 1.0.7 checks and emits declarations through the unchanged native adapter', {
  skip: !root,
}, async () => {
  assert.ok(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir --run');
  const temporaryRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  const fixtureRoot = fs.realpathSync(root);
  assert.ok(
    fixtureRoot === temporaryRoot ||
      fixtureRoot.startsWith(`${temporaryRoot}${path.sep}`),
    'The fixture must belong to the current temporary lease',
  );
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const rslib = JSON.parse(read('node_modules/@rslib/core/package.json'));
  assert.equal(rslib.version, '1.0.7');
  const require = createRequire(
    fs.realpathSync(path.join(root, 'node_modules/@rslib/core/package.json')),
  );
  const pluginRoot = path.resolve(
    path.dirname(require.resolve('rsbuild-plugin-dts')),
    '..',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'))).version,
    '1.0.7',
  );
  const { resolveDtsGenerationBackend } = await import(
    pathToFileURL(path.join(pluginRoot, 'dist/5.js')).href
  );
  for (const [options, version, expected] of [
    [
      { typescriptPath: '/custom/version.cjs', tsgo: true },
      '7.1.0-beta',
      'ts7-executable',
    ],
    [{ tsgo: true }, '7.1.0-beta', 'api-new'],
    [{ typescriptPath: '/custom/version.cjs' }, '7.1.0-beta', 'api-new'],
    [{ tsgo: true }, '7.0.2', 'ts7-executable'],
    [{}, '6.0.3', 'api-old'],
  ]) {
    assert.equal(resolveDtsGenerationBackend(options, version), expected);
  }
  assert.throws(() =>
    resolveDtsGenerationBackend(
      { tsgo: true, typescriptPath: '/custom/version.cjs' },
      '6.0.3',
    ),
  );
  assert.throws(() =>
    resolveDtsGenerationBackend(
      { tsgo: false, typescriptPath: '/custom/version.cjs' },
      '7.1.0-beta',
    ),
  );
  const compiler = path.join(root, 'scripts/tsrs-dts/version.cjs');
  const dts = getDtsCompilerOptions({
    ULTRAMODERN_DTS_COMPILER_MODULE: compiler,
  });
  assert.equal(dts.tsgo, true);
  assert.equal(dts.typescriptPath, compiler);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'rslib.config.mjs'),
    `export default ${JSON.stringify({
      performance: { buildCache: false },
      lib: [
        {
          format: 'cjs',
          bundle: false,
          source: { entry: { index: './src/index.ts' } },
          output: { distPath: { root: './dist/cjs' } },
          dts: {
            abortOnError: true,
            bundle: false,
            distPath: './dist/types',
            ...dts,
          },
        },
      ],
    })};\n`,
  );
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ESNext',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        rootDir: './src',
        skipLibCheck: true,
        plugins: [
          {
            name: '@effect/language-service',
            diagnosticSeverity: { floatingEffect: 'error' },
          },
        ],
      },
      include: ['src'],
    }),
  );
  const build = source => {
    fs.writeFileSync(path.join(root, 'src/index.ts'), source);
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'node_modules/@rslib/core/bin/rslib.js'), 'build'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, TSRS_CHECKER_ASSIGNMENT: 'go' },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const valid = build('export const value: string = "native";\n');
  assert.equal(valid.status, 0, valid.output);
  assert.match(read('dist/types/index.d.ts'), /value: string/u);
  assert.match(read('dist/cjs/index.cjs'), /native/u);

  const invalid = build('export const value: string = 42;\n');
  assert.notEqual(invalid.status, 0, invalid.output);
  assert.match(invalid.output, /TS2322/u);

  const floating = build(
    'import { Effect } from "effect";\nEffect.succeed("floating");\n',
  );
  assert.notEqual(floating.status, 0, floating.output);
  assert.match(floating.output, /377001/u);
  console.log(
    'Real Rslib/native adapter: emitted JS/types; TS2322 and Effect 377001 rejected.',
  );
});
