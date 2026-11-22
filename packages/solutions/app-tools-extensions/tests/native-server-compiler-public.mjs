import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tsgoInvocation from '../../../../scripts/lib/tsgo-invocation.js';

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

const fixture = mkdtempSync(
  join(dirname(fileURLToPath(import.meta.url)), '.server-compiler-types-'),
);
try {
  writeFileSync(
    join(fixture, 'consumer.ts'),
    `import type {
  DeclarationPluginOptions,
  ServerCompileConfig,
  ServerCompiler,
} from '@modern-js/app-tools-extensions/server-compiler/types';
import type { OutputConfig, RsbuildPlugin } from '@rsbuild/core';
import type { PluginDtsOptions } from 'rsbuild-plugin-dts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type DeclarationOptions = Assert<Equal<
  DeclarationPluginOptions,
  Required<Pick<PluginDtsOptions, 'distPath' | 'abortOnError' | 'redirect'>>
>>;
export type SourceMap = Assert<Equal<
  ServerCompileConfig['sourceMap'],
  OutputConfig['sourceMap']
>>;
export type DeclarationPlugin = Assert<Equal<
  ReturnType<ServerCompiler['declarationPlugin']>,
  RsbuildPlugin | Promise<RsbuildPlugin>
>>;
`,
  );
  writeFileSync(
    join(fixture, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'Preserve',
        moduleResolution: 'Bundler',
        noEmit: true,
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: false,
        types: ['node'],
      },
      files: ['consumer.ts'],
    }),
  );
  const compiler = tsgoInvocation.createTsgoInvocation({
    requireFrom: require,
    args: ['-p', join(fixture, 'tsconfig.json'), '--pretty', 'false'],
  });
  execFileSync(compiler.command, compiler.argv, { stdio: 'pipe' });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log('Verified strict public server compiler option types.');
