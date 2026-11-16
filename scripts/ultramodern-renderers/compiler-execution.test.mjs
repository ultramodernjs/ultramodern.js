import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import provider from '../tsrs-dts/compiler.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const solidRoot = path.join(root, 'packages/runtime/renderer-solid');
const solidManifest = JSON.parse(
  readFileSync(path.join(solidRoot, 'package.json'), 'utf8'),
);
// Each `&&` step is one direct compiler invocation over its own project.
const solidTypeChecks = solidManifest.scripts['test:types']
  .split(' && ')
  .map(step => step.split(/\s+/u));

for (const [command, ...args] of solidTypeChecks) {
  test(`Solid ${args[2]} executes the verified Effect compiler`, () => {
    assert.equal(command, 'node');
    assert.equal(
      path.resolve(solidRoot, args[0]),
      path.join(root, 'scripts/with-effect-tsrs.mjs'),
    );
    assert.equal(args[1], '--project');
    const result = spawnSync(process.execPath, [...args, '--version'], {
      cwd: solidRoot,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`+effect-tsgo.${provider.effectVersion}`));
    if (provider.getCompilerPolicy().backend === 'tsrs') {
      assert.ok(result.stdout.includes(`tsrs ${provider.tsrsVersion}`));
    }
  });

  test(`Solid ${args[2]} type contracts pass without emitting`, () => {
    const result = spawnSync(process.execPath, [...args, '--noEmit'], {
      cwd: solidRoot,
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

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

for (const [directory, script] of [
  ['packages/runtime/render', 'test'],
  ...['mf-host', 'mf-remote', 'mf-remote-2'].map(name => [
    `tests/integration/routes-tanstack-mf/${name}`,
    'typecheck',
  ]),
]) {
  const cwd = path.join(root, directory);
  const manifest = JSON.parse(
    readFileSync(path.join(cwd, 'package.json'), 'utf8'),
  );
  // The render test command continues with Rstest after its real type check.
  const [prefix] = manifest.scripts[script].split(' && ');
  const [command, ...args] = prefix.split(/\s+/u);

  test(`${directory} direct type check selects the Effect compiler`, () => {
    assert.equal(command, 'node');
    assert.equal(
      path.resolve(cwd, args[0]),
      path.join(root, 'scripts/with-effect-tsrs.mjs'),
    );
    assert.equal(args[1], '--project');
    const result = spawnSync(process.execPath, [...args, '--version'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`+effect-tsgo.${provider.effectVersion}`));
  });

  test(`${directory} direct type check accepts its real project`, () => {
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
