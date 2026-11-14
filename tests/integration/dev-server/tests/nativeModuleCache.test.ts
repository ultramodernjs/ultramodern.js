import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const owner = pathToFileURL(
  path.resolve(
    __dirname,
    '../../../../packages/solutions/app-tools-extensions/src/config/native-module-cache.ts',
  ),
).href;

test('invalidates native server importers without reloading unchanged modules', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import fs from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeModuleCache } from ${JSON.stringify(owner)};

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-server-cache-')));
const write = (name, text) => fs.writeFileSync(path.join(directory, name), text);
const require = createRequire(path.join(directory, 'package.json'));
let hooks;
let cache;
try {
  write('package.json', '{}');
  write('leaf.ts', 'export const value: string = "v1";');
  write('middle.ts', 'export { value } from "./leaf.ts";');
  write('stable.ts', 'export const identity = {};');
  write('root.ts', 'import { value } from "./middle.ts"; import { identity } from "./stable.ts"; export const metadata = { url: import.meta.url, filename: import.meta.filename }; export default { value, identity };');
  write('legacy.cjs', '"use strict"; module.exports = { filename: __filename, strict: (function () { return this; })(), value: "v1" };');
  write('other.ts', 'export const identity = {};');
  fs.mkdirSync(path.join(directory, 'node_modules'));
  write('node_modules/vendor.mjs', 'export const identity = {};');
  cache = createNativeModuleCache(directory);
  hooks = registerHooks({ resolve: cache.resolve, load: cache.load });
  const root = path.join(directory, 'root.ts');
  const first = require(root).default;
  const firstMetadata = require(root).metadata;
  const legacy = require(path.join(directory, 'legacy.cjs'));
  const other = await import(pathToFileURL(path.join(directory, 'other.ts')));
  const vendor = await import(pathToFileURL(path.join(directory, 'node_modules/vendor.mjs')));
  assert.equal(first.value, 'v1');
  assert.strictEqual(require(root).default, first);

  write('leaf.ts', 'export const value: string = "v2";');
  channel('modern-js:dev:invalidate').publish(path.join(directory, 'leaf.ts'));
  const second = require(root).default;
  assert.equal(second.value, 'v2');
  assert.notStrictEqual(second, first);
  assert.strictEqual(second.identity, first.identity);
  assert.strictEqual(require(root).default, second);
  assert.strictEqual((await import(pathToFileURL(root))).default, second);
  assert.deepEqual(require(root).metadata, firstMetadata);
  assert.equal(fs.existsSync(require(root).metadata.filename), true);

  write('legacy.cjs', '"use strict"; module.exports = { filename: __filename, strict: (function () { return this; })(), value: "v2" };');
  channel('modern-js:dev:invalidate').publish(path.join(directory, 'legacy.cjs'));
  assert.equal(require(path.join(directory, 'legacy.cjs')).value, 'v2');
  assert.equal(require(path.join(directory, 'legacy.cjs')).filename, legacy.filename);
  assert.equal(require(path.join(directory, 'legacy.cjs')).strict, undefined);

  write('leaf.ts', 'export const value: string = "v3";');
  channel('modern-js:dev:invalidate').publish(path.join(directory, 'leaf.ts'));
  assert.equal(require(root).default.value, 'v3');
  assert.strictEqual(require(root).default.identity, first.identity);

  write('root.ts', 'import { identity } from "./stable.ts"; export default { identity, edited: true };');
  channel('modern-js:dev:invalidate').publish(root);
  const rewritten = require(root).default;
  assert.equal(rewritten.edited, true);
  assert.strictEqual(rewritten.identity, first.identity);
  write('leaf.ts', 'export const value: string = "v4";');
  channel('modern-js:dev:invalidate').publish(path.join(directory, 'leaf.ts'));
  assert.strictEqual(require(root).default, rewritten);
  assert.strictEqual(await import(pathToFileURL(path.join(directory, 'other.ts'))), other);
  channel('modern-js:dev:invalidate').publish(path.join(directory, 'node_modules/vendor.mjs'));
  assert.strictEqual(await import(pathToFileURL(path.join(directory, 'node_modules/vendor.mjs'))), vendor);
  console.log('native server cache: PASS');
} finally {
  hooks?.deregister();
  cache?.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
}
`,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('native server cache: PASS');
});
