import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Use the built utility in a fresh Node process so Rstest's require/import
// hooks and earlier module evaluations cannot change the loader behavior.
const utilityPaths = {
  cjs: path.resolve(__dirname, '../dist/cjs/cli/require.js'),
  esm: path.resolve(__dirname, '../dist/esm-node/cli/require.mjs'),
};

describe('compatibleRequire with native Node loaders', () => {
  let fixtureDirectory: string;

  beforeEach(() => {
    fixtureDirectory = mkdtempSync(
      path.join(tmpdir(), 'modern-compatible-require #%-'),
    );
  });

  afterEach(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  const fixture = (name: string, source: string) => {
    const modulePath = path.join(fixtureDirectory, name);
    writeFileSync(modulePath, source);
    return modulePath;
  };

  const runInNode = (
    modulePath: string,
    assertions: string,
    flags: string[] = [],
    format: 'cjs' | 'esm' = 'cjs',
  ) => {
    execFileSync(
      process.execPath,
      [
        ...flags,
        '-e',
        `const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const modulePath = process.argv[2];
(async () => {
  const { compatibleRequire } = ${format === 'esm' ? 'await import(pathToFileURL(process.argv[1]).href)' : 'require(process.argv[1])'};
  ${assertions}
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});`,
        utilityPaths[format],
        modulePath,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          NODE_OPTIONS: '',
          MODERN_LIB_FORMAT: format,
        },
      },
    );
  };

  it('loads an ordinary CommonJS module', () => {
    const modulePath = fixture(
      'plugin.cjs',
      "module.exports = { name: 'commonjs-plugin' };",
    );

    runInNode(
      modulePath,
      "assert.deepEqual(await compatibleRequire(modulePath), { name: 'commonjs-plugin' });",
    );
  });

  it('preserves a require error without executing the module again', () => {
    const modulePath = fixture(
      'throwing.cjs',
      `globalThis.executions = (globalThis.executions || 0) + 1;
const cause = new Error('native addon permission check failed');
const error = new Error('real error from plugin', { cause });
error.code = 'ERR_DLOPEN_FAILED';
globalThis.pluginError = error;
throw error;`,
    );

    runInNode(
      modulePath,
      `await assert.rejects(compatibleRequire(modulePath), error => error === globalThis.pluginError);
assert.equal(globalThis.executions, 1);`,
    );
  });

  it.each(['null', 'undefined'])('preserves a thrown %s value', value => {
    const modulePath = fixture('throwing.cjs', `throw ${value};`);

    runInNode(
      modulePath,
      `await assert.rejects(compatibleRequire(modulePath), error => error === ${value});`,
    );
  });

  describe('ESM library format', () => {
    it.each(['null', 'false', '0', "''"])(
      'preserves the ESM default export %s',
      value => {
        const modulePath = fixture('default.mjs', `export default ${value};`);
        runInNode(
          modulePath,
          `assert.equal(await compatibleRequire(modulePath), ${value});`,
          [],
          'esm',
        );
      },
    );

    it('keeps a genuine ESM default object intact', () => {
      const modulePath = fixture(
        'default.mjs',
        'export default { __esModule: true, default: 42 };',
      );
      runInNode(
        modulePath,
        `assert.deepEqual(await compatibleRequire(modulePath), {
  __esModule: true, default: 42,
});`,
        [],
        'esm',
      );
    });

    it('unwraps transpiled CommonJS defaults without looping on cycles', () => {
      const modulePath = fixture(
        'default.cjs',
        `const value = { name: 'cyclic' };
value.__esModule = true;
value.default = value;
module.exports = { __esModule: true, default: value };`,
      );
      runInNode(
        modulePath,
        `const value = await compatibleRequire(modulePath);
assert.equal(value.name, 'cyclic');
assert.equal(value.default, value);`,
        [],
        'esm',
      );
    });

    it('preserves a CommonJS namespace when interop is disabled', () => {
      const modulePath = fixture(
        'namespace.cjs',
        'module.exports = { __esModule: true, default: 42 };',
      );
      runInNode(
        modulePath,
        `const namespace = await compatibleRequire(modulePath, false);
assert.deepEqual(namespace.default, { __esModule: true, default: 42 });`,
        [],
        'esm',
      );
    });
  });

  describe.each([
    { mode: 'require(esm) enabled', flags: [] },
    {
      mode: 'require(esm) disabled',
      flags: ['--no-experimental-require-module'],
    },
  ])('$mode', ({ flags }) => {
    it.each(['synchronous', 'top-level await'])(
      'loads a %s ESM module from a path containing URL-sensitive characters',
      kind => {
        const modulePath = fixture(
          'plugin #%.mjs',
          `${kind === 'top-level await' ? 'await Promise.resolve();' : ''}
export default { name: 'esm-plugin' };`,
        );

        runInNode(
          modulePath,
          "assert.deepEqual(await compatibleRequire(modulePath), { name: 'esm-plugin' });",
          flags,
        );
      },
    );

    it('preserves the module namespace when interop is disabled', () => {
      const modulePath = fixture(
        'namespace #%.mjs',
        `await Promise.resolve();
export const named = 42;
export default { name: 'esm-plugin' };`,
      );

      runInNode(
        modulePath,
        `const namespace = await compatibleRequire(modulePath, false);
assert.deepEqual(namespace.default, { name: 'esm-plugin' });
assert.equal(namespace.named, 42);`,
        flags,
      );
    });

    it('reports the actual error thrown after top-level await', () => {
      const modulePath = fixture(
        'throwing #%.mjs',
        `await Promise.resolve();
throw new Error('real asynchronous plugin error');`,
      );

      runInNode(
        modulePath,
        `await assert.rejects(compatibleRequire(modulePath), {
  message: 'real asynchronous plugin error',
});`,
        flags,
      );
    });
  });
});
