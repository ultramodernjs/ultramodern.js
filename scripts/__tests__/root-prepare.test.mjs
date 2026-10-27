import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function prepareFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-prepare-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const { scripts } = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'root-prepare-fixture', private: true, scripts }),
  );
  fs.mkdirSync(path.join(tmp, 'scripts'));
  fs.copyFileSync(
    path.join(repoRoot, 'scripts/prepare-effect-compiler.mjs'),
    path.join(tmp, 'scripts/prepare-effect-compiler.mjs'),
  );
  const compilerTemplate = path.join(
    tmp,
    'packages/toolkit/ultramodern-create/templates/workspace-scripts/ultramodern-compiler-prepare.mjs',
  );
  fs.mkdirSync(path.dirname(compilerTemplate), { recursive: true });
  // Compiler metadata and native diagnostics have their own integration tests.
  // This fixture checks that the real root wrapper invokes validation in the
  // fresh checkout and forwards its result without starting a framework build.
  fs.writeFileSync(
    compilerTemplate,
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../../../../../compiler-invocation.json', import.meta.url), JSON.stringify({
  cwd: process.cwd(),
  workspaceRoot: process.env.ULTRAMODERN_WORKSPACE_ROOT,
}));
process.exit(Number(process.env.ROOT_PREPARE_COMPILER_STATUS ?? 0));
`,
  );
  // Copy only the tracked hooks: the generated `.husky/_` must come from
  // `prepare`, not from the repo's own install.
  fs.cpSync(path.join(repoRoot, '.husky'), path.join(tmp, '.husky'), {
    recursive: true,
    filter: source => source !== path.join(repoRoot, '.husky/_'),
  });
  assert.equal(fs.existsSync(path.join(tmp, '.husky/_')), false);
  assert.equal(
    spawnSync('git', ['init', '-q'], { cwd: tmp }).status,
    0,
    'git init failed',
  );

  const fakeBin = path.join(tmp, 'fake-bin');
  const nxMarker = path.join(tmp, 'nx-was-spawned');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, 'nx'),
    `#!/bin/sh\ntouch '${nxMarker}'\nexit 1\n`,
    { mode: 0o755 },
  );

  const env = { ...process.env };
  delete env.HUSKY;
  env.PATH = [
    fakeBin,
    path.join(repoRoot, 'node_modules/.bin'),
    process.env.PATH,
  ].join(path.delimiter);

  return {
    tmp,
    nxMarker,
    run: (compilerStatus = 0) =>
      spawnSync(scripts.prepare, {
        cwd: tmp,
        env: {
          ...env,
          ROOT_PREPARE_COMPILER_STATUS: String(compilerStatus),
        },
        shell: true,
        encoding: 'utf8',
      }),
  };
}

// `pnpm install` installs hooks and validates the compiler. Building the
// framework remains the explicit `pnpm prepare-build:local` operation.
test('root prepare installs hooks and validates the compiler without starting an nx build', t => {
  const { tmp, nxMarker, run } = prepareFixture(t);
  const result = run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(
    fs.existsSync(path.join(tmp, '.husky/_/pre-commit')),
    'prepare must install the husky pre-commit hook',
  );
  assert.equal(
    fs.existsSync(nxMarker),
    false,
    'prepare must not spawn nx; run `pnpm prepare-build:local` explicitly',
  );
  const invocation = JSON.parse(
    fs.readFileSync(path.join(tmp, 'compiler-invocation.json'), 'utf8'),
  );
  assert.equal(fs.realpathSync(invocation.cwd), fs.realpathSync(tmp));
  assert.equal(fs.realpathSync(invocation.workspaceRoot), fs.realpathSync(tmp));
});

test('root prepare preserves compiler validation failures without starting an nx build', t => {
  const { tmp, nxMarker, run } = prepareFixture(t);
  const result = run(2);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.ok(fs.existsSync(path.join(tmp, 'compiler-invocation.json')));
  assert.equal(fs.existsSync(nxMarker), false);
});
