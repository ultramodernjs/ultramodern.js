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

test('DTS adapter reports the embedded TypeScript version and resolves Effect tsrs', async () => {
  assert.equal(require(adapter).version, require('tsrs').typescriptVersion);
  assert.match(require(adapter).version, /^7\./);
  const { default: getExePath } = await import('../tsrs-dts/getExePath.js');
  const result = spawnSync(getExePath(), ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\+effect-tsgo\.0\.57\.0/);
});

test('compiler launcher selects locality and the supported Rslib adapter', () => {
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
  assert.ok(value.compiler.endsWith('/tsrs'));
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
      env: { ...process.env, TSRS_BINARY: process.execPath },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Effect-enabled tsrs is required/);
});
