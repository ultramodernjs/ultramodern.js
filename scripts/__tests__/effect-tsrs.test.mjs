import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const adapter = fileURLToPath(
  new URL('../tsrs-dts/version.cjs', import.meta.url),
);
const provider = require('../tsrs-dts/compiler.cjs');

test('DTS adapter reports the embedded TypeScript version and resolves Effect tsrs', async () => {
  assert.equal(require(adapter).version, provider.typescriptVersion);
  assert.match(require(adapter).version, /^7\./);
  const { default: getExePath } = await import('../tsrs-dts/getExePath.js');
  const result = spawnSync(getExePath(), ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(`+effect-tsgo.${provider.effectVersion}`));
});

test('compiler launcher selects locality assignment and the supported Rslib adapter', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/with-effect-tsrs.mjs',
      process.execPath,
      '--input-type=module',
      '-e',
      'console.log(JSON.stringify({ assignment: process.env.TSRS_CHECKER_ASSIGNMENT, adapter: process.env.ULTRAMODERN_DTS_COMPILER_MODULE, compiler: process.env.EFFECT_TSGO_BIN }))',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.assignment, 'locality');
  assert.equal(value.adapter, adapter);
  assert.equal(value.compiler, provider.getExePath());
});

test('compiler policy distinguishes unpublished targets from broken installs', () => {
  assert.equal(
    provider.getCompilerPolicy('unsupported-os', 'x64').backend,
    'effect-go',
  );
  assert.equal(provider.getCompilerPolicy('darwin', 'arm64').backend, 'tsrs');
});

test('compiler launcher preserves explicit assignment and defaults empty assignment', () => {
  for (const [assignment, expected] of [
    ['go', 'go'],
    ['', 'locality'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/with-effect-tsrs.mjs',
        process.execPath,
        '-e',
        'console.log(process.env.TSRS_CHECKER_ASSIGNMENT)',
      ],
      {
        cwd: root,
        env: { ...process.env, TSRS_CHECKER_ASSIGNMENT: assignment },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});

test('compiler launcher reuses the calling package manager', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/with-effect-tsrs.mjs',
      'pnpm',
      '--input-type=module',
      '-e',
      'console.log(process.execPath)',
    ],
    {
      cwd: root,
      env: { ...process.env, npm_execpath: process.execPath },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.execPath);
});

test('compiler launcher rejects a binary without the Effect patch', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/with-effect-tsrs.mjs', process.execPath, '-e', 'process.exit(0)'],
    {
      cwd: root,
      env: { ...process.env, EFFECT_TSGO_BIN: process.execPath },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Effect-enabled compiler .* is required/);
});
