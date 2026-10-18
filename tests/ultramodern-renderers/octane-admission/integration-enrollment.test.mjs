import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = path.join(
  root,
  'tests/integration/renderer-octane/tests/index.test.ts',
);
const specs = path.join(root, 'tests/integration/renderer-specs/specs.ts');
const timeout = path.join(root, 'tests/utils/setSuiteTimeout.ts');
const mock = source => `data:text/javascript,${encodeURIComponent(source)}`;

// Registration runs the authored entry and shared specs, but never their hooks
// or browser/build bodies. Fail if enrollment starts an execution dependency.
const unavailable = name =>
  `export function ${name}() { throw new Error('Enrollment must not execute ${name}'); }`;

test('the ordinary Octane suite enrolls its original state-preserving HMR spec', async () => {
  const registered = [];
  const globals = [
    'test',
    'describe',
    'beforeAll',
    'afterAll',
    'beforeEach',
    'afterEach',
  ];
  const previous = new Map(
    globals.map(name => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const register = (skipped, name, body, limit) =>
    registered.push({ skipped, name, body, limit });
  globalThis.test = (name, body, limit) => register(false, name, body, limit);
  globalThis.test.skip = (name, body, limit) =>
    register(true, name, body, limit);
  globalThis.describe = (_name, body) => body();
  for (const name of globals.slice(2)) globalThis[name] = () => {};
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.endsWith('/renderer-specs/specs'))
        return { shortCircuit: true, url: pathToFileURL(specs).href };
      if (specifier.endsWith('/setSuiteTimeout'))
        return { shortCircuit: true, url: pathToFileURL(timeout).href };
      if (specifier === 'puppeteer')
        return { shortCircuit: true, url: mock('export default {};') };
      if (specifier.endsWith('/modernTestUtils'))
        return {
          shortCircuit: true,
          url: mock(
            [
              'getPort',
              'killApp',
              'launchApp',
              'launchOptions',
              'modernBuild',
              'modernServe',
              'runModernCommand',
            ]
              .map(unavailable)
              .join('\n'),
          ),
        };
      if (specifier.endsWith('/bundle-check.mjs'))
        return { shortCircuit: true, url: mock(unavailable('checkBundle')) };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (
        [entry, specs, timeout].some(file => pathToFileURL(file).href === url)
      ) {
        const source = stripTypeScriptTypes(
          readFileSync(fileURLToPath(url), 'utf8'),
        );
        return {
          shortCircuit: true,
          format: 'module',
          source: `const __dirname = ${JSON.stringify(path.dirname(fileURLToPath(url)))};\n${source}`,
        };
      }
      return next(url, context);
    },
  });
  try {
    await import(pathToFileURL(entry).href);
    const hmr = registered.filter(row => row.name.startsWith('dev-hmr'));
    assert.equal(hmr.length, 1);
    assert.equal(hmr[0].name, 'dev-hmr');
    assert.equal(hmr[0].skipped, false);
    assert.equal(typeof hmr[0].body, 'function');
    assert.equal(hmr[0].limit, 150_000);
    assert.equal(registered.length, 21);
    assert.deepEqual(
      registered.filter(row => row.skipped),
      [],
    );
  } finally {
    hooks.deregister();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
