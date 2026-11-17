import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from '@rstest/core';

const sourceUrl = pathToFileURL(
  path.resolve(__dirname, '../src/server-global-vars.ts'),
).href;
const serializerUrl = pathToFileURL(
  path.resolve(
    __dirname,
    '../../plugin-bff-extensions/src/server-global-vars/index.ts',
  ),
).href;

const prelude = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const nativeLoads = [];
const nativeLoadAttempts = [];
const originalDlopen = process.dlopen;
process.dlopen = function (...args) {
  nativeLoadAttempts.push(args[1]);
  const result = Reflect.apply(originalDlopen, this, args);
  nativeLoads.push(args[1]);
  return result;
};
const { serializeServerGlobalVars } = await import(${JSON.stringify(serializerUrl)});
const { transformServerGlobalVars } = await import(${JSON.stringify(sourceUrl)});
const swcLoads = (loads = nativeLoads) => loads.filter(filename =>
  path.basename(filename).startsWith('swc.') && filename.endsWith('.node'),
);
assert.deepEqual(swcLoads(nativeLoadAttempts), [], 'source import must not attempt native SWC loading');
`;

const runNativeCase = (script: string) => {
  const directory = mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? tmpdir(), 'server-global-vars-'),
  );
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `${prelude}\n${script}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          BFF_GLOBAL_VARS_TEST_DIRECTORY: directory,
          NODE_OPTIONS: '',
          SWC_BINARY_PATH: '',
        },
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('cold source import and non-transform APIs leave native SWC unloaded', () => {
  runNativeCase(`
const directory = process.env.BFF_GLOBAL_VARS_TEST_DIRECTORY;
const globals = serializeServerGlobalVars((_config, context) => ({ context }));
assert.deepEqual(globals, { context: '{"env":"server","target":"node"}' });
const emitted = path.join(directory, 'emitted.js');
await writeFile(emitted, 'module.exports = GLOBAL_VALUE;');
const emptyGlobals = transformServerGlobalVars([emitted], {});
assert.ok(emptyGlobals instanceof Promise);
assert.equal(await emptyGlobals, undefined);
assert.equal(await transformServerGlobalVars([], globals), undefined);
assert.equal(await transformServerGlobalVars([path.join(directory, 'emitted.d.ts')], globals), undefined);
// A reported emitted file that does not exist is an inconsistent compile result.
await assert.rejects(transformServerGlobalVars([path.join(directory, 'missing.js')], globals));
assert.deepEqual(swcLoads(nativeLoadAttempts), [], 'serialization and empty outputs must stay cold');
`);
});

test('the owning transform loads native SWC and preserves global replacement semantics', () => {
  runNativeCase(`
const directory = process.env.BFF_GLOBAL_VARS_TEST_DIRECTORY;
const nested = path.join(directory, 'nested');
await mkdir(nested);
const filename = path.join(directory, 'entry.cjs');
const source = [
  '// ULTRAMODERN_BUILD_MARKER remains a comment.',
  "const literal = 'ULTRAMODERN_BUILD_MARKER';",
  'module.exports = {',
  '  marker: ULTRAMODERN_BUILD_MARKER,',
  '  revision: ULTRAMODERN_SOURCE_REVISION,',
  '  release: ULTRAMODERN_RELEASE_VERSION,',
  '  settings: BUILD_SETTINGS,',
  '  literal,',
  '  nearMatch: typeof ULTRAMODERN_BUILD_MARKER_NEAR_MATCH,',
  '};',
  '',
].join('\\n');
await writeFile(filename, source);
const originalSourceMap = JSON.stringify({
  version: 3,
  file: 'entry.cjs',
  sources: ['original-entry.cjs'],
  sourcesContent: [source],
  names: [],
  mappings: source.split('\\n').map((_, index) => index === 0 ? 'AAAA' : 'AACA').join(';'),
});
await writeFile(filename + '.map', originalSourceMap);
const esmFilename = path.join(nested, 'entry.mjs');
await writeFile(esmFilename, 'export const marker = ULTRAMODERN_BUILD_MARKER;\\n');
const strictFilename = path.join(nested, 'strict.cjs');
await writeFile(strictFilename, "'use strict';\\nmodule.exports = function () { return this; };\\n");
const untouchedFilename = path.join(nested, 'readme.txt');
await writeFile(untouchedFilename, 'ULTRAMODERN_BUILD_MARKER');
const expected = {
  marker: 'catalog-build-2026.12.03+"exact"',
  revision: 'release/erp-10@4f2a9c7',
  release: '1.2.3-release.4',
  settings: { nullable: null, enabled: true, labels: ['tractor', 'český'] },
  literal: 'ULTRAMODERN_BUILD_MARKER',
  nearMatch: 'undefined',
};
const globals = serializeServerGlobalVars({
  ULTRAMODERN_BUILD_MARKER: expected.marker,
  ULTRAMODERN_SOURCE_REVISION: expected.revision,
  ULTRAMODERN_RELEASE_VERSION: expected.release,
  BUILD_SETTINGS: expected.settings,
});
assert.deepEqual(swcLoads(), []);
// Exactly the emitted inventory: files beside it are not walked into.
const unreported = path.join(nested, 'unreported.js');
await writeFile(unreported, 'module.exports = ULTRAMODERN_BUILD_MARKER;\\n');
const transformed = transformServerGlobalVars(
  [filename, esmFilename, strictFilename, untouchedFilename],
  globals,
);
assert.ok(transformed instanceof Promise);
assert.equal(await transformed, undefined);
assert.ok(swcLoads().some(filename => filename.endsWith('.node')), 'real SWC native binding must execute');
const require = createRequire(import.meta.url);
assert.deepEqual(require(filename), expected);
assert.equal((await import(pathToFileURL(esmFilename).href)).marker, expected.marker);
assert.equal(require(strictFilename)(), undefined, 'the release banner must keep "use strict" in the prologue');
const code = await readFile(filename, 'utf8');
assert.ok(code.includes('// ULTRAMODERN_BUILD_MARKER remains a comment.'));
assert.ok(code.includes('ULTRAMODERN_BUILD_MARKER_NEAR_MATCH'));
assert.equal(await readFile(untouchedFilename, 'utf8'), 'ULTRAMODERN_BUILD_MARKER');
assert.equal(await readFile(unreported, 'utf8'), 'module.exports = ULTRAMODERN_BUILD_MARKER;\\n');
const transformedSourceMap = await readFile(filename + '.map', 'utf8');
assert.notEqual(transformedSourceMap, originalSourceMap);
const sourceMap = JSON.parse(transformedSourceMap);
assert.equal(sourceMap.version, 3);
assert.ok(sourceMap.sources.some(source => source.endsWith('original-entry.cjs')));
assert.ok(sourceMap.mappings.length > 0);
assert.deepEqual(sourceMap.sourcesContent, [source]);
`);
});

test('native transform failures reject the original asynchronous API', () => {
  runNativeCase(`
const filename = path.join(process.env.BFF_GLOBAL_VARS_TEST_DIRECTORY, 'invalid.js');
const source = 'const = GLOBAL_VALUE;';
await writeFile(filename, source);
const transformed = transformServerGlobalVars(
  [filename],
  serializeServerGlobalVars({ GLOBAL_VALUE: 'value' }),
);
assert.ok(transformed instanceof Promise);
await assert.rejects(transformed);
assert.ok(swcLoads().some(filename => filename.endsWith('.node')));
assert.equal(await readFile(filename, 'utf8'), source);
`);
});
