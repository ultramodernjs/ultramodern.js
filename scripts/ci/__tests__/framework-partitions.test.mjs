import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = stripTypeScriptTypes(
  fs.readFileSync(
    new URL('../../../tests/rstest.config.mts', import.meta.url),
    'utf8',
  ),
)
  .replace("import { defineConfig } from '@rstest/core';", '')
  .replace('export default defineConfig(', 'globalThis.config = defineConfig(');

function selection(platform, suite) {
  const context = {
    __dirname: 'tests',
    process: { platform, env: { MODERN_TEST_FRAMEWORK_SUITE: suite } },
    defineConfig: value => value,
  };
  vm.runInNewContext(source, context);
  return JSON.parse(JSON.stringify(context.config));
}

test('packed generators run on both systems; each generated app runtime has one Linux owner', () => {
  for (const [suite, fixture] of [
    ['generator-bff', 'create-bff-runtime'],
    ['generator-workspace', 'create-ultramodern-workspace'],
  ]) {
    const pattern = `integration/${fixture}/tests/*.test.ts`;
    const runtime = `integration/${fixture}/tests/runtime.test.ts`;
    for (const platform of ['linux', 'win32']) {
      const generated = selection(platform, suite);
      assert.deepEqual(generated.include, [pattern]);
      assert.equal(generated.exclude.includes(runtime), platform === 'win32');
      assert.ok(selection(platform, 'core').exclude.includes(pattern));
      assert.equal(
        selection(platform, 'full').exclude.includes(runtime),
        platform === 'win32',
      );
      assert.ok(
        !selection(platform, 'core').exclude.includes(
          'integration/bff-effect/tests/index.test.ts',
        ),
      );
    }
  }
});

test('unknown partitions fail rather than silently skipping coverage', () => {
  assert.throws(
    () => selection('linux', 'unknown'),
    /Unknown MODERN_TEST_FRAMEWORK_SUITE/,
  );
});
