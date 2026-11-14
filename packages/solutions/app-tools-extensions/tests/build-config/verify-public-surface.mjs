import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tsgoInvocation from '../../../../../scripts/lib/tsgo-invocation.js';

const { createTsgoInvocation } = tsgoInvocation;
const require = createRequire(import.meta.url);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDirectory, '../..');

try {
  const tsgo = createTsgoInvocation({
    args: ['-p', join(testDirectory, 'tsconfig.public-surface-consumer.json')],
    requireFrom: require,
  });
  execFileSync(tsgo.command, tsgo.argv, {
    cwd: packageRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
} catch (error) {
  const output = [error?.message, error?.stdout, error?.stderr]
    .filter(Boolean)
    .map(value => value.toString())
    .join('\n');
  assert.fail(`Public config type consumer failed to compile.\n${output}`);
}

const cjsCompiler = require('@modern-js/app-tools-extensions/build-config');
const esmCompiler = await import(
  '@modern-js/app-tools-extensions/build-config'
);
for (const surface of [cjsCompiler, esmCompiler]) {
  assert.equal(typeof surface.resolveEffectTsrsCompiler, 'function');
}

for (const surface of [
  require('@modern-js/app-tools-extensions/native-server-compiler'),
  await import('@modern-js/app-tools-extensions/native-server-compiler'),
]) {
  assert.equal(typeof surface.nativeServerCompiler, 'function');
}

const cjsConfig = require('@modern-js/app-tools-extensions/config');
const esmConfig = await import('@modern-js/app-tools-extensions/config');

for (const surface of [cjsConfig, esmConfig]) {
  assert.equal(typeof surface.getBuildConfigEnvironment, 'function');
  // Deploy environment owns Zephyr's ZE_FAIL_BUILD; config never leases
  // process-global environment.
  assert.equal('withBuildConfigEnvironment' in surface, false);
}
assert.deepEqual(
  Object.getOwnPropertySymbols(process).filter(symbol =>
    symbol.description?.startsWith('@modern-js/app-tools/'),
  ),
  [],
);

console.log(
  'Verified @modern-js/app-tools-extensions/config built public surface.',
);
