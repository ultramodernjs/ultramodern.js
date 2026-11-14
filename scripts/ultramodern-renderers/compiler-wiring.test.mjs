// Fake-only wiring checks. Native compiler contracts live in compiler-execution.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { parseSync, types } from '@babel/core';
import { octaneTypecheckEvidenceEnv } from './octane-cli-evidence.mjs';
import { diagnoseOctaneTypecheck } from './octane-router-probe.mjs';

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
const compilerInputSteps = [];
types.traverseFast(releaseAst, node => {
  if (
    types.isCallExpression(node) &&
    types.isIdentifier(node.callee, { name: 'step' }) &&
    types.isTemplateLiteral(node.arguments[0]) &&
    node.arguments[0].quasis.at(-1)?.value.cooked === ' typecheck'
  ) {
    typecheckSteps.push(node.arguments[1]);
  }
  if (
    types.isCallExpression(node) &&
    types.isIdentifier(node.callee, { name: 'step' }) &&
    types.isTemplateLiteral(node.arguments[0]) &&
    node.arguments[0].quasis.at(-1)?.value.cooked === ' compiler inputs'
  ) {
    compilerInputSteps.push(node.arguments[1]);
    assert.equal(
      releaseSource.slice(node.arguments[2].start, node.arguments[2].end),
      "ready && renderer === 'octane'",
    );
  }
});
assert.equal(
  typecheckSteps.length,
  1,
  'The packed release must typecheck each renderer',
);
assert.equal(compilerInputSteps.length, 1);
test('packed Octane records installed compiler inputs without replacing its typecheck', async () => {
  const callback = compilerInputSteps[0];
  const createInputs = compileFunction(
    `return (${releaseSource.slice(callback.start, callback.end)});`,
    ['sh', 'process', 'path', 'root', 'appRoot', 'env', 'renderer'],
  );
  const appRoot = path.join(root, 'control-consumer', 'octane');
  const env = { CONTROL_REGISTRY: 'packed-cohort' };
  const calls = [];
  await createInputs(
    async (...args) => calls.push(args),
    process,
    path,
    root,
    appRoot,
    env,
    'octane',
  )();
  assert.deepEqual(calls, [
    [
      process.execPath,
      [
        path.join(
          root,
          'scripts/ultramodern-renderers/octane-compiler-inputs.mjs',
        ),
        appRoot,
      ],
      { cwd: appRoot, env, log: 'octane-compiler-inputs' },
    ],
  ]);
});
// Execute the production phase body without running the release CLI's installs,
// builds or servers. Only the external command runner is replaced by a control.
const callback = typecheckSteps[0];
const createTypecheck = compileFunction(
  `return (${releaseSource.slice(callback.start, callback.end)});`,
  ['sh', 'process', 'appRoot', 'env', 'renderer'],
  {
    contextExtensions: [
      {
        diagnoseOctaneTypecheck,
        octaneTypecheckEvidenceEnv,
        path,
        root,
        logs: path.join(root, 'control-logs'),
      },
    ],
  },
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

test('packed Octane probes native declarations on failure but preserves failed acceptance', async () => {
  const failure = new Error('TS2536');
  const calls = [];
  const run = createTypecheck(
    async (command, args, options) => {
      calls.push([command, args, options]);
      if (command === 'pnpm') throw failure;
    },
    process,
    root,
    {},
    'octane',
  );
  await assert.rejects(run, error => error === failure);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], process.execPath);
  assert.deepEqual(calls[1][1], [
    path.join(root, 'scripts/ultramodern-renderers/octane-router-probe.mjs'),
    root,
  ]);
  assert.equal(calls[1][2].log, 'octane-native-router-probe');
});

test('packed hosted Octane injects original CLI evidence only into the public command', async () => {
  const calls = [];
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    NODE_OPTIONS: '--no-warnings',
  };
  const appRoot = path.join(root, 'control-consumer/octane');
  await createTypecheck(
    async (...args) => calls.push(args),
    process,
    appRoot,
    env,
    'octane',
  )();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['pnpm', ['run', 'typecheck']]);
  assert.equal(calls[0][2].env.ULTRAMODERN_OCTANE_EVIDENCE_APP, appRoot);
  assert.equal(
    calls[0][2].env.ULTRAMODERN_OCTANE_EVIDENCE_LOG,
    path.join(root, 'control-logs/octane-typecheck-original'),
  );
  assert.match(calls[0][2].env.NODE_OPTIONS, /^--no-warnings --import=/u);
  assert.equal(env.NODE_OPTIONS, '--no-warnings');
});

test('navigation gives each of eight original invocations a retained log prefix and still stops at first failure', async () => {
  const source = readFileSync(
    new URL(
      '../../tests/ultramodern-renderers/i18n/navigation-installed.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    sourceType: 'module',
  });
  const batches = [];
  types.traverseFast(ast, node => {
    if (
      types.isCallExpression(node) &&
      types.isIdentifier(node.callee, { name: 'qualifyOctaneBatch' })
    )
      batches.push(node.arguments[0]);
  });
  assert.equal(batches.length, 1);
  const { qualifyOctaneBatch } = await import('./octane-router-probe.mjs');
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
  const temporary = '/retained';
  const appRoot = '/retained/disposable/app';
  const create = compileFunction(
    `return (${source.slice(batches[0].start, batches[0].end)});`,
    ['command'],
    {
      contextExtensions: [
        {
          pnpm: '/fake/pnpm',
          appRoot,
          temporary,
          env,
          path,
          octaneTypecheckEvidenceEnv,
        },
      ],
    },
  );
  const calls = [];
  await qualifyOctaneBatch(create(async (...args) => calls.push(args)));
  assert.equal(calls.length, 8);
  for (let index = 0; index < calls.length; index++) {
    assert.deepEqual(calls[index].slice(0, 4), [
      '/fake/pnpm',
      ['run', 'typecheck'],
      appRoot,
      `octane-typecheck-${index + 1}`,
    ]);
    assert.equal(
      calls[index][4].commandEnv.ULTRAMODERN_OCTANE_EVIDENCE_LOG,
      `/retained/logs/octane-typecheck-original-${index + 1}`,
    );
  }
  const failure = new Error('original failed');
  let count = 0;
  await assert.rejects(
    qualifyOctaneBatch(
      create(async () => {
        count++;
        throw failure;
      }),
    ),
    error => error === failure,
  );
  assert.equal(count, 1);
  assert(
    !source.includes("'--resolve-compiler'"),
    'No resolver version probe before originals',
  );
});
