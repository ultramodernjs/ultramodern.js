// Consumer: publish-bleedingdev.yml prepare-release build.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '../build-bleedingdev-packages.mjs');

test('release builds propagate the actual Effect tsrs compiler and DTS adapter', async t => {
  const { createReleaseBuildCommand } = await import(
    '../build-bleedingdev-packages.mjs'
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'modern-release-build-compiler-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageManager = path.join(root, 'pnpm.cjs');
  fs.writeFileSync(
    packageManager,
    `console.log(JSON.stringify({
      args: process.argv.slice(2),
      compiler: process.env.EFFECT_TSGO_BIN,
      assignment: process.env.TSRS_CHECKER_ASSIGNMENT,
      adapter: process.env.ULTRAMODERN_DTS_COMPILER_MODULE
    }));\n`,
  );
  const command = createReleaseBuildCommand([
    '@modern-js/app-tools-extensions',
  ]);
  const result = spawnSync(command.executable, command.args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      TSRS_CHECKER_ASSIGNMENT: '',
      npm_execpath: packageManager,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const selected = JSON.parse(result.stdout);
  assert.equal(selected.assignment, 'locality');
  assert.equal(
    path.basename(selected.compiler),
    process.platform === 'win32' ? 'tsrs.exe' : 'tsrs',
  );
  assert.match(selected.adapter, /scripts[/\\]tsrs-dts[/\\]version\.cjs$/);
  assert.deepEqual(selected.args, [
    'exec',
    'nx',
    'run-many',
    '-t',
    'build',
    '-p',
    '@modern-js/app-tools-extensions',
    '--maxParallel=8',
    '--skipNxCache',
    '--skipRemoteCache',
  ]);
});

test('release build rejects dirty source before inspecting Nx projects', t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'modern-release-build-dirty-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  const buildCallLog = path.join(root, 'build-calls.log');
  fs.mkdirSync(binDir);
  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(
    fakeGit,
    [
      '#!/bin/sh',
      'if [ "$1" = "rev-parse" ]; then',
      "  printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      '  exit 0',
      'fi',
      'if [ "$1" = "status" ]; then',
      "  printf '?? untracked.txt\\0'",
      '  exit 0',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fakeGit, 0o755);
  const fakePnpm = path.join(binDir, 'pnpm');
  fs.writeFileSync(
    fakePnpm,
    [
      '#!/bin/sh',
      'printf \'invoked\\n\' >> "$BUILD_CALL_LOG"',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fakePnpm, 0o755);

  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      BUILD_CALL_LOG: buildCallLog,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release source worktree is not clean/i);
  assert.match(result.stderr, /untracked\.txt/);
  assert.equal(fs.existsSync(buildCallLog), false, 'pnpm must not be invoked');
});
