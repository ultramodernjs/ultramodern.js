import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  qualifyHeldRead,
  readHeldReadRecipeBytes,
} from './qualify-held-read.mjs';

function fixture(t) {
  const parent = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'held-read-api-'),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return {
    parent,
    workDirectory: path.join(parent, 'work'),
    storeDirectory: path.join(parent, 'external-store'),
    recipeBytes: readHeldReadRecipeBytes(),
  };
}

test('importing the portable qualifier needs no root dependencies or host environment', t => {
  const { parent } = fixture(t);
  const file = path.join(parent, 'qualify-held-read.mjs');
  fs.copyFileSync(new URL('./qualify-held-read.mjs', import.meta.url), file);
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const api = await import(${JSON.stringify(pathToFileURL(file).href)}); if(typeof api.qualifyHeldRead !== 'function') process.exit(2);`,
    ],
    { cwd: parent, encoding: 'utf8', env: { PATH: process.env.PATH } },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('the API rejects an existing work directory without touching it', async t => {
  const options = fixture(t);
  fs.mkdirSync(options.workDirectory);
  fs.writeFileSync(
    path.join(options.workDirectory, 'preserve'),
    'owned by someone else',
  );
  await assert.rejects(qualifyHeldRead(options), /fresh and operation-owned/u);
  assert.equal(
    fs.readFileSync(path.join(options.workDirectory, 'preserve'), 'utf8'),
    'owned by someone else',
  );
});

test('broad selector, version and integrity mutations fail before any command or fetch', async t => {
  const options = fixture(t);
  for (const mutate of [
    value => {
      value.serializerOverrides = { seroval: '1.8.1' };
    },
    value => {
      value.dependencies['solid-js'].version = '2.0.0-rc.15';
    },
    value => {
      value.dependencies.typescript.integrity = 'sha512-wrong';
    },
  ]) {
    const recipe = JSON.parse(options.recipeBytes);
    mutate(recipe);
    await assert.rejects(
      qualifyHeldRead({
        ...options,
        recipeBytes: JSON.stringify(recipe),
        run: () => {
          throw Error('must not execute');
        },
      }),
      /reviewed dependency identities/u,
    );
    assert.equal(fs.existsSync(options.workDirectory), false);
  }
});

test('install failure removes only the operation directory and preserves the external store', async t => {
  const options = fixture(t);
  fs.mkdirSync(options.storeDirectory);
  fs.writeFileSync(path.join(options.storeDirectory, 'preserve'), 'store');
  await assert.rejects(
    qualifyHeldRead({
      ...options,
      run: (_command, args) =>
        args[0] === '--version'
          ? {
              status: 0,
              stdout: _command === process.execPath ? 'v26.13.1' : '12.21.0',
            }
          : { status: 17, stdout: 'controlled install failure', stderr: '' },
    }),
    /controlled install failure/u,
  );
  assert.equal(fs.existsSync(options.workDirectory), false);
  assert.equal(
    fs.readFileSync(path.join(options.storeDirectory, 'preserve'), 'utf8'),
    'store',
  );
});

test('lifecycle release failure still removes every operation-owned byte', async t => {
  const options = fixture(t);
  await assert.rejects(
    qualifyHeldRead({
      ...options,
      run: (command, args) => ({
        status: 0,
        stdout:
          args[0] === '--version'
            ? command === process.execPath
              ? 'v26.13.1'
              : '12.21.0'
            : '',
      }),
      lifecycle: {
        register() {
          throw Error('register failure');
        },
        release() {
          throw Error('release failure');
        },
      },
    }),
    /release failure/u,
  );
  assert.equal(fs.existsSync(options.workDirectory), false);
});

test('the portable module contains no root policy, dependency or private host imports', () => {
  const source = fs.readFileSync(
    new URL('./qualify-held-read.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /\/Users\/|with-effect-tsrs|renderer-solid\/package\.json|from ['"]yaml/u,
  );
});

test('real qualification works from a copied bare module closure and returns bytes after cleanup', {
  skip: !process.env.SOLID_HELD_READ_REAL,
}, async t => {
  const { parent } = fixture(t);
  assert(
    process.env.PNPM_STORE_DIR,
    'Real qualification needs an explicit external store',
  );
  const closure = path.join(parent, 'bare');
  fs.mkdirSync(closure);
  for (const filename of [
    'qualify-held-read.mjs',
    'held-read-runtime.mjs',
    'held-read-public-api.ts',
    'held-read-source.patch',
    'held-read-declarations.patch',
    'held-read-provenance.json',
    'held-read-recipe.json',
  ])
    fs.copyFileSync(
      new URL(filename, import.meta.url),
      path.join(closure, filename),
    );
  const api = await import(
    pathToFileURL(path.join(closure, 'qualify-held-read.mjs'))
  );
  const workDirectory = path.join(parent, 'real-work');
  const result = await api.qualifyHeldRead({
    workDirectory,
    storeDirectory: process.env.PNPM_STORE_DIR,
    recipeBytes: api.readHeldReadRecipeBytes(),
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.evidence.checks.length, 5);
  assert.equal(result.evidence.effectCompiler.status, 'pending');
  assert.equal(fs.existsSync(workDirectory), false);
  assert.equal(
    createHash('sha256').update(result.sourceArchive.bytes).digest('hex'),
    result.sourceArchive.sha256,
  );
  assert.equal(
    createHash('sha256').update(result.license.bytes).digest('hex'),
    result.license.sha256,
  );
  for (const item of Object.values(result.patches))
    assert.equal(
      createHash('sha256').update(item.bytes).digest('hex'),
      item.sha256,
    );
});

test('packed gate rejects integrity and identity drift before any operation', async t => {
  const { qualifyHeldReadPacked } = await import('./qualify-held-read.mjs');
  const options = fixture(t);
  const payload = Buffer.from('actual bytes');
  for (const manifest of [
    { name: 'solid-js', version: '2.0.0-rc.22', integrity: 'sha512-wrong' },
    { name: 'other', version: '2.0.0-rc.22' },
  ])
    await assert.rejects(
      qualifyHeldReadPacked({
        workDirectory: options.workDirectory,
        toolchain: { storeDirectory: options.storeDirectory },
        recipeBytes: options.recipeBytes,
        payloads: new Map([['solid-js', payload]]),
        manifest,
      }),
    );
  assert.equal(fs.existsSync(options.workDirectory), false);
});

test('real packed gate installs supplied bytes and rejects a runtime-altered archive', {
  skip: !process.env.SOLID_HELD_READ_REAL,
}, async t => {
  const { qualifyHeldReadPacked } = await import('./qualify-held-read.mjs');
  const { parent, recipeBytes } = fixture(t);
  let payload;
  await qualifyHeldRead({
    workDirectory: path.join(parent, 'source'),
    storeDirectory: process.env.PNPM_STORE_DIR,
    recipeBytes,
    run(command, args, options) {
      const result = spawnSync(command, args, options);
      if (command === 'tar' && args[0] === '-czf')
        payload = fs.readFileSync(args[1]);
      return result;
    },
  });
  assert(Buffer.isBuffer(payload));
  const call = (bytes, work) =>
    qualifyHeldReadPacked({
      workDirectory: path.join(parent, work),
      toolchain: {
        node: process.execPath,
        pnpm: 'pnpm',
        storeDirectory: process.env.PNPM_STORE_DIR,
      },
      recipeBytes,
      payloads: new Map([['solid-js', bytes]]),
      manifest: {
        name: 'solid-js',
        version: '2.0.0-rc.22',
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      },
    });
  const result = await call(payload, 'packed');
  assert.equal(result.evidence.transport.installedActualPayload, true);
  assert.equal(fs.existsSync(path.join(parent, 'packed')), false);
  const mutation = path.join(parent, 'mutation');
  fs.mkdirSync(mutation);
  fs.writeFileSync(path.join(mutation, 'input.tgz'), payload);
  assert.equal(
    spawnSync('tar', ['-xzf', 'input.tgz'], { cwd: mutation }).status,
    0,
  );
  fs.appendFileSync(
    path.join(mutation, 'package/dist/server.js'),
    '\nthrow Error("runtime mutation");',
  );
  assert.equal(
    spawnSync('tar', ['-czf', 'changed.tgz', 'package'], { cwd: mutation })
      .status,
    0,
  );
  await assert.rejects(
    call(fs.readFileSync(path.join(mutation, 'changed.tgz')), 'mutated-packed'),
    /canonical source-generated correction/u,
  );
  assert.equal(fs.existsSync(path.join(parent, 'mutated-packed')), false);
});
