import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { resolveBrowserDependencyRoot } from './browser-dependencies.mjs';

assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');

function graph(t, { transitive = false } = {}) {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'browser-resolution-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = path.join(root, 'workspace/tests');
  const core = path.join(root, 'external-store/core');
  const playwright = path.join(root, 'external-store/playwright');
  fs.mkdirSync(owner, { recursive: true });
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(
    path.join(core, 'package.json'),
    JSON.stringify({
      name: 'playwright-core',
      version: '1.64.1',
      exports: { '.': './index.cjs', './package.json': './package.json' },
    }),
  );
  fs.writeFileSync(
    path.join(core, 'index.cjs'),
    "throw new Error('Resolution must not execute browser package code');\n",
  );
  const link = (parent, name, target) => {
    const location = path.join(parent, 'node_modules', name);
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.symlinkSync(target, location, 'dir');
  };
  if (transitive) {
    fs.mkdirSync(playwright, { recursive: true });
    fs.writeFileSync(
      path.join(playwright, 'package.json'),
      JSON.stringify({ name: 'playwright', version: '1.64.1' }),
    );
    link(owner, 'playwright', playwright);
    link(playwright, 'playwright-core', core);
  } else link(owner, 'playwright-core', core);
  return { root, owner, core };
}

test('resolves a direct installed browser package in an external virtual store', t => {
  const supplied = graph(t);
  const resolved = resolveBrowserDependencyRoot(supplied.owner);
  assert.equal(resolved, supplied.core);
  assert.equal(
    createRequire(path.join(resolved, 'package.json')).resolve(
      'playwright-core',
    ),
    path.join(supplied.core, 'index.cjs'),
  );
  assert(!fs.existsSync(path.join(supplied.owner, 'node_modules/.pnpm')));
});

test('follows Playwright owning dependency when strict pnpm hides its core', t => {
  const supplied = graph(t, { transitive: true });
  assert.throws(
    () =>
      createRequire(path.join(supplied.owner, 'package.json')).resolve(
        'playwright-core',
      ),
    { code: 'MODULE_NOT_FOUND' },
  );
  assert.equal(resolveBrowserDependencyRoot(supplied.owner), supplied.core);
});

test('a missing explicit dependency owner fails without scanning unrelated packages', t => {
  const supplied = graph(t);
  const absent = path.join(supplied.root, 'isolated');
  fs.mkdirSync(absent);
  assert.throws(() => resolveBrowserDependencyRoot(absent), {
    message: /No installed Playwright.*--browser-dependency-root/u,
  });
});
