import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function importWithoutDependencies(module) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { isBuiltin, registerHooks } from 'node:module';
        registerHooks({
          resolve(specifier, context, next) {
            if (!isBuiltin(specifier) &&
                !specifier.startsWith('.') &&
                !specifier.startsWith('/') &&
                !specifier.startsWith('file:'))
              throw new Error('External dependency before installation: ' + specifier);
            return next(specifier, context);
          },
        });
        await import(${JSON.stringify(new URL(module, import.meta.url).href)});
      `,
    ],
    { encoding: 'utf8' },
  );
}

test('receipt verification loads before any dependency installation', () => {
  const result = importWithoutDependencies('../run-release-acceptance.mjs');
  assert.equal(result.status, 0, result.stderr);
});

test('the former eager workspace admission import requires installed dependencies', () => {
  const result = importWithoutDependencies('../verify-support-workspace.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /External dependency before installation: yaml/u);
});
