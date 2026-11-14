import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { parseSync, types } from '@babel/core';
import provider from '../tsrs-dts/compiler.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const releaseSource = readFileSync(
  new URL('./release.mjs', import.meta.url),
  'utf8',
);
const releaseAst = parseSync(releaseSource, {
  babelrc: false,
  configFile: false,
  sourceType: 'module',
});
const typecheckSteps = [];
types.traverseFast(releaseAst, node => {
  if (
    types.isCallExpression(node) &&
    types.isIdentifier(node.callee, { name: 'step' }) &&
    types.isTemplateLiteral(node.arguments[0]) &&
    node.arguments[0].quasis.at(-1)?.value.cooked === ' typecheck'
  ) {
    typecheckSteps.push(node.arguments[1]);
  }
});
assert.equal(
  typecheckSteps.length,
  1,
  'The packed release must typecheck each renderer',
);
// Execute the production phase body without running the release CLI's installs,
// builds or servers. Only the external command runner is replaced by a control.
const callback = typecheckSteps[0];
const createTypecheck = compileFunction(
  `return (${releaseSource.slice(callback.start, callback.end)});`,
  ['sh', 'process', 'appRoot', 'env', 'renderer'],
);

for (const renderer of ['react', 'solid', 'octane']) {
  test(`packed ${renderer} acceptance runs the installed app's compiler script`, async () => {
    const appRoot = path.join(root, 'control-consumer', renderer);
    const env = { CONTROL_REGISTRY: 'packed-cohort' };
    const calls = [];
    const run = createTypecheck(
      async (...args) => calls.push(args),
      process,
      appRoot,
      env,
      renderer,
    );
    await run();
    assert.deepEqual(calls, [
      [
        'pnpm',
        ['run', 'typecheck'],
        { cwd: appRoot, env, log: `${renderer}-typecheck` },
      ],
    ]);
  });
}

test('packed typechecking does not hide an installed compiler failure', async () => {
  const failure = new Error('installed compiler rejected the fixture');
  const run = createTypecheck(
    async () => {
      throw failure;
    },
    process,
    root,
    {},
    'solid',
  );
  await assert.rejects(run, error => error === failure);
});

const solidRoot = path.join(root, 'packages/runtime/renderer-solid');
const solidManifest = JSON.parse(
  readFileSync(path.join(solidRoot, 'package.json'), 'utf8'),
);
const [command, ...args] = solidManifest.scripts['test:types'].split(/\s+/u);

test('Solid source type tests execute the verified Effect compiler', () => {
  const result = spawnSync(
    command === 'node' ? process.execPath : command,
    [...args, '--version'],
    { cwd: solidRoot, encoding: 'utf8', timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`+effect-tsgo.${provider.effectVersion}`));
  if (provider.getCompilerPolicy().backend === 'tsrs') {
    assert.ok(result.stdout.includes(`tsrs ${provider.tsrsVersion}`));
  }
});

test('Solid source type contracts pass without emitting', () => {
  const result = spawnSync(
    command === 'node' ? process.execPath : command,
    [...args, '--noEmit'],
    { cwd: solidRoot, encoding: 'utf8', timeout: 60000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// TypeScript is a declared SDK peer identity, not the selected checker.
test('Octane and its native i18n factory share the same peer-bound i18next types', () => {
  const octane = createRequire(
    path.join(root, 'packages/runtime/renderer-octane/package.json'),
  );
  const nativeI18n = createRequire(
    path.join(root, 'packages/runtime/i18n-extensions/package.json'),
  );
  assert.equal(
    realpathSync(octane.resolve('i18next/package.json')),
    realpathSync(nativeI18n.resolve('i18next/package.json')),
  );
});
