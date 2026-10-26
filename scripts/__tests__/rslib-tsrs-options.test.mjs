import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helperUrl = new URL('../tsrs-dts/rslib-options.mjs', import.meta.url);
const configUrls = [
  '../../packages/cli/adapter-rstest/rslib.config.mts',
  '../../packages/runtime/plugin-image/rslib.config.mts',
  '../../packages/runtime/renderer-solid/rslib.config.mts',
].map(relativePath => new URL(relativePath, import.meta.url).href);
const compilerModule = '/not-installed/compiler with spaces/version.cjs';

function importInChild(source, compiler) {
  const parentEnv = { ...process.env };
  const env = { ...parentEnv, NODE_DISABLE_COMPILE_CACHE: '1' };
  delete env.ULTRAMODERN_DTS_COMPILER_MODULE;
  if (compiler !== undefined) {
    env.ULTRAMODERN_DTS_COMPILER_MODULE = compiler;
  }
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { env, encoding: 'utf8' },
  );
  assert.deepEqual({ ...process.env }, parentEnv);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const [name, compiler, expected] of [
  ['unset', undefined, {}],
  ['empty', '', {}],
  [
    'configured',
    compilerModule,
    { tsgo: true, typescriptPath: compilerModule },
  ],
]) {
  test(`fresh helper import returns ${name} compiler options without resolution`, () => {
    const options = importInChild(
      `const { getDtsCompilerOptions } = await import(${JSON.stringify(helperUrl.href)});
       console.log(JSON.stringify(getDtsCompilerOptions()));`,
      compiler,
    );
    assert.deepEqual(options, expected);
  });
}

test('helper reads the supplied environment without mutation or shared results', async () => {
  const { getDtsCompilerOptions } = await import(helperUrl);
  const env = Object.freeze({
    ULTRAMODERN_DTS_COMPILER_MODULE: compilerModule,
  });
  const first = getDtsCompilerOptions(env);
  assert.deepEqual(first, { tsgo: true, typescriptPath: compilerModule });
  first.typescriptPath = 'changed';
  assert.deepEqual(getDtsCompilerOptions(env), {
    tsgo: true,
    typescriptPath: compilerModule,
  });
  assert.deepEqual(getDtsCompilerOptions(Object.freeze({})), {});
});

for (const [name, compiler] of [
  ['unset', undefined],
  ['empty', ''],
  ['configured', compilerModule],
]) {
  test(`actual Rslib configs preserve declaration settings with ${name} compiler`, {
    skip: Number(process.versions.node.split('.')[0]) < 26,
  }, () => {
    const configs = importInChild(
      `const configs = await Promise.all(
           ${JSON.stringify(configUrls)}.map(async url => (await import(url)).default),
         );
         console.log(JSON.stringify(configs));`,
      compiler,
    );
    const options = compiler ? { tsgo: true, typescriptPath: compiler } : {};
    const [adapter, image, solid] = configs;
    assert.deepEqual(adapter.lib, [
      {
        format: 'esm',
        dts: options,
        bundle: false,
        syntax: 'es2021',
      },
    ]);
    assert.deepEqual(image.lib, [
      {
        format: 'esm',
        syntax: 'es2021',
        dts: options,
        source: { entry: { runtime: 'src/runtime.ts' } },
      },
      {
        format: 'cjs',
        syntax: 'es2021',
        source: { entry: { index: 'src/cli.ts' } },
      },
    ]);
    assert.equal(solid.performance.buildCache, false);
    assert.equal(solid.lib.length, 2);
    assert.deepEqual(solid.lib[0].dts, {
      abortOnError: true,
      bundle: false,
      distPath: './dist/types',
      ...options,
    });
    assert.equal(solid.lib[1].dts, false);
    assert.equal(solid.lib[0].output.distPath.root, './dist/esm-node');
    assert.equal(solid.lib[1].output.distPath.root, './dist/esm');
    for (const lib of solid.lib) {
      assert.equal(lib.bundle, false);
      assert.equal(lib.outBase, './src');
      assert.equal(lib.autoExtension, true);
      assert.equal(lib.output.copy.length, 2);
    }
  });
}
