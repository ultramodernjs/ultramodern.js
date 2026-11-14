import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureOctaneCompilerInputs } from './octane-compiler-inputs.mjs';

assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
const renderer = '@modern-js/renderer-octane';
const ownDeps = ['@modern-js/app-tools-extensions', 'tsrs', '@effect/tsgo'];
const nativeDeps = [
  '@tanstack/router-core',
  '@octanejs/tanstack-router',
  'octane',
];

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'octane-inputs-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }
  const app = path.join(root, 'workspace/apps/octane');
  const workspace = path.join(root, 'workspace');
  write(path.join(app, 'package.json'), '{"name":"fixture","private":true}');
  for (const directory of [workspace, app]) {
    write(path.join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    write(path.join(directory, 'tsconfig.json'), '{"compilerOptions":{}}');
  }
  write(path.join(workspace, 'package.json'), '{"name":"workspace"}');
  write(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  function install(owner, name, version, tag) {
    const location = path.join(root, 'store', tag, name);
    write(
      path.join(location, 'package.json'),
      JSON.stringify({
        name,
        version,
        exports: { '.': './index.js', './package.json': './package.json' },
      }),
    );
    write(
      path.join(location, 'index.js'),
      "throw new Error('Must never execute installed packages');",
    );
    write(
      path.join(location, 'dist/types/index.d.ts'),
      'export declare const value: string;',
    );
    write(path.join(location, 'src/index.gts'), 'export const value = 1;');
    const link = path.join(owner, 'node_modules', name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(location, link, 'dir');
    return location;
  }
  const rendererRoot = install(app, renderer, '1.0.0', 'renderer');
  const expected = { [renderer]: rendererRoot };
  for (const name of ownDeps) {
    expected[name] = install(rendererRoot, name, '2.0.0', 'renderer-owned');
    install(app, name, '9.0.0', 'wrong-app');
  }
  for (const name of nativeDeps) {
    expected[name] = install(app, name, '3.0.0', 'app-owned');
    install(rendererRoot, name, '9.0.0', 'wrong-renderer');
  }
  return { root, app, workspace, rendererRoot, expected, write };
}

test('deterministic hashes include installed source/declarations and use the correct owners', t => {
  const f = fixture(t);
  const capture = captureOctaneCompilerInputs(f.app);
  assert.deepEqual(captureOctaneCompilerInputs(f.app), capture);
  const alias = path.join(f.root, 'app-alias');
  fs.symlinkSync(f.app, alias, 'dir');
  assert.deepEqual(captureOctaneCompilerInputs(alias), capture);
  assert.equal(capture.node, process.version);
  assert.equal(capture.platform, process.platform);
  assert.equal(capture.arch, process.arch);
  assert.equal(capture.appRoot, fs.realpathSync(f.app));
  assert.equal(capture.workspace.root, fs.realpathSync(f.workspace));
  assert.equal(capture.app.files.length, 3);
  assert.equal(capture.workspace.files.length, 4);
  for (const [name, location] of Object.entries(f.expected)) {
    const actual = capture.packages[name];
    assert.equal(actual.root, fs.realpathSync(location));
    assert.equal(
      actual.version,
      name === renderer ? '1.0.0' : ownDeps.includes(name) ? '2.0.0' : '3.0.0',
    );
    assert.deepEqual(
      actual.files.map(file => path.relative(actual.root, file.path)),
      ['dist/types/index.d.ts', 'index.js', 'src/index.gts'],
    );
    for (const file of [actual.manifest, ...actual.files]) {
      assert.equal(
        file.sha256,
        createHash('sha256').update(fs.readFileSync(file.path)).digest('hex'),
      );
    }
  }
  assert(!JSON.stringify(capture).includes('Must never execute'));
});

test('changed inputs change hashes, but nested dependencies, symlinks and secrets are ignored', t => {
  const f = fixture(t);
  const before = captureOctaneCompilerInputs(f.app);
  const declaration = path.join(f.rendererRoot, 'dist/types/index.d.ts');
  f.write(declaration, 'export declare const value: number;');
  const changed = captureOctaneCompilerInputs(f.app);
  assert.notEqual(
    changed.packages[renderer].files[0].sha256,
    before.packages[renderer].files[0].sha256,
  );
  const lock = path.join(f.workspace, 'pnpm-lock.yaml');
  f.write(lock, 'lockfileVersion: 10');
  const relocked = captureOctaneCompilerInputs(f.app);
  assert.notDeepEqual(relocked.workspace, changed.workspace);
  for (const directory of [f.app, f.workspace, f.rendererRoot]) {
    f.write(path.join(directory, '.env'), 'SECRET=do-not-read');
    f.write(
      path.join(directory, '.npmrc'),
      '//registry/:_authToken=do-not-read',
    );
    f.write(
      path.join(directory, 'node_modules/hidden/index.js'),
      'ignored dependency',
    );
  }
  f.write(
    path.join(f.rendererRoot, 'src/node_modules/hidden.d.ts'),
    'ignored nested dependency',
  );
  const outside = f.write(path.join(f.root, 'outside.js'), 'ignored symlink');
  fs.symlinkSync(outside, path.join(f.rendererRoot, 'linked.js'));
  fs.symlinkSync(
    path.dirname(outside),
    path.join(f.rendererRoot, 'linked-directory'),
    'dir',
  );
  // A matching extension must not make an .env file eligible.
  f.write(
    path.join(f.rendererRoot, '.env.js'),
    'secret executable configuration',
  );
  assert.deepEqual(captureOctaneCompilerInputs(f.app), relocked);
});

test('required dependency or version metadata errors are never replaced by another package', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.rendererRoot, 'node_modules/tsrs'));
  assert.throws(
    () => captureOctaneCompilerInputs(f.app),
    /Required installed dependency tsrs cannot resolve/u,
  );
  // Leave a valid app-owned tsrs in place: it must not be used as a fallback.
  fs.symlinkSync(
    f.expected.tsrs,
    path.join(f.rendererRoot, 'node_modules/tsrs'),
    'dir',
  );
  f.write(path.join(f.expected.octane, 'package.json'), '{"name":"octane"}');
  assert.throws(
    () => captureOctaneCompilerInputs(f.app),
    /Invalid installed package metadata for octane/u,
  );
});

test('canonical dependency aliases and packages hiding their manifest resolve without loading entries', t => {
  const f = fixture(t);
  for (const name of [renderer, ownDeps[0]]) {
    const manifest = path.join(f.expected[name], 'package.json');
    const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    metadata.name = `@bleedingdev/modern-js-${name.slice('@modern-js/'.length)}`;
    f.write(manifest, JSON.stringify(metadata));
  }
  const manifest = path.join(f.expected.octane, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  metadata.exports = { '.': './dist/cjs/index.cjs' };
  f.write(manifest, JSON.stringify(metadata));
  f.write(
    path.join(f.expected.octane, 'dist/cjs/package.json'),
    '{"type":"commonjs"}',
  );
  f.write(
    path.join(f.expected.octane, 'dist/cjs/index.cjs'),
    "throw new Error('Never load this entry');",
  );
  const captured = captureOctaneCompilerInputs(f.app);
  assert.equal(
    captured.packages[renderer].name,
    '@bleedingdev/modern-js-renderer-octane',
  );
  assert.equal(
    captured.packages[ownDeps[0]].name,
    '@bleedingdev/modern-js-app-tools-extensions',
  );
  assert.equal(
    captured.packages.octane.manifest.path,
    fs.realpathSync(manifest),
  );
});

test('CLI emits only the captured JSON for its positional appRoot', t => {
  const f = fixture(t);
  const stdout = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('./octane-compiler-inputs.mjs', import.meta.url)),
      f.app,
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(stdout), captureOctaneCompilerInputs(f.app));
});
