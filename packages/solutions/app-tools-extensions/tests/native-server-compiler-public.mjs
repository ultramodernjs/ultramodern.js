import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';

// Hosted CI runs this after building the package. Node's export conditions,
// rather than Rstest's modern:source condition, exercise published consumers.
const require = createRequire(import.meta.url);
const name = '@modern-js/app-tools-extensions/native-server-compiler';
const cjsPath = require.resolve(name);
assert.match(cjsPath, /[/\\]dist[/\\]cjs[/\\]native-server-compiler\.js$/u);
assert.ok(statSync(cjsPath).isFile());
const cjs = require(name);
const esm = await import(name);
assert.equal(typeof cjs.nativeServerCompiler, 'function');
assert.equal(typeof esm.nativeServerCompiler, 'function');
console.log('Verified published CJS and ESM native-server-compiler exports.');
