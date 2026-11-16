import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertOwned, createPatch, tree, validateMaps } from './build.mjs';

const temporary = process.env.OWNED_TEMP_DIR;
assert(temporary, 'Run tests through owned-temp-dir --run');
function fixture(name) {
  const root = path.join(temporary, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'));
  const source = 'export const n = 1;\n';
  fs.writeFileSync(path.join(root, 'src/n.ts'), source);
  fs.writeFileSync(
    path.join(root, 'dist/n.js'),
    'export const n = 1;\n//# sourceMappingURL=n.js.map',
  );
  fs.writeFileSync(
    path.join(root, 'dist/n.js.map'),
    JSON.stringify({
      version: 3,
      file: 'n.js',
      sources: ['../src/n.ts'],
      sourcesContent: [source],
      names: [],
      mappings: 'AAAA',
    }),
  );
  return root;
}
test('portable map with actual owning source passes', () =>
  assert.equal(validateMaps(fixture('valid')), 1));
test('stale embedded source is rejected', () => {
  const root = fixture('stale');
  fs.writeFileSync(path.join(root, 'src/n.ts'), 'export const n = 2;');
  assert.throws(() => validateMaps(root));
});
test('absolute source map path is rejected', () => {
  const root = fixture('absolute');
  const file = path.join(root, 'dist/n.js.map');
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  map.sources = [path.join(root, 'src/n.ts')];
  fs.writeFileSync(file, JSON.stringify(map));
  assert.throws(() => validateMaps(root));
});
test('missing emitted source-map reference is rejected', () => {
  const root = fixture('missing');
  fs.writeFileSync(path.join(root, 'dist/n.js'), 'export const n=1;');
  assert.throws(() => validateMaps(root));
});
test('rebuild target outside operation-owned temp is rejected', () =>
  assert.throws(() => assertOwned('/Users/satan/workspace')));
test('tree digest catches package byte changes', () => {
  const root = fixture('tree');
  const before = tree(root);
  fs.appendFileSync(path.join(root, 'dist/n.js'), '\n');
  assert.notDeepEqual(tree(root), before);
});

test('invalid mapping coordinates are rejected', () => {
  const root = fixture('bad-mapping');
  const file = path.join(root, 'dist/n.js.map');
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  map.mappings = 'AAEA';
  fs.writeFileSync(file, JSON.stringify(map));
  assert.throws(() => validateMaps(root));
});

test('missing emitted map artifact is rejected', () => {
  const root = fixture('missing-map');
  fs.unlinkSync(path.join(root, 'dist/n.js.map'));
  assert.throws(() => validateMaps(root), /missing map/);
});

test('canonical patch bytes stay the reviewed myers diff under any user git configuration', t => {
  const home = process.env.HOME;
  t.after(() => {
    process.env.HOME = home;
  });
  const expected =
    'diff --git a/index.js b/index.js\nindex 410d0bfd9cf3c89b974414cfe9b9773f39127ca1..ea8dfbc8f57a8269e4e6f9daa8f2ce9c2706a305 100644\n--- a/index.js\n+++ b/index.js\n@@ -1,10 +1,8 @@\n+y\n+z\n x\n-x\n-{\n-}\n-{\n+z\n y\n-}\n 1\n 2\n 3\n@@ -12,4 +10,4 @@ y\n 5\n 6\n 7\n-old\n+new\n';
  for (const [name, gitconfig] of [
    ['clean', undefined],
    [
      'adversarial',
      '[diff]\n\talgorithm = histogram\n\tindentHeuristic = false\n\tcontext = 1\n\tinterHunkContext = 4\n\tnoprefix = true\n[core]\n\tautocrlf = true\n[color]\n\tdiff = always\n',
    ],
  ]) {
    const work = path.join(temporary, `patch-${name}`);
    for (const [side, text] of [
      ['a', 'x\nx\n{\n}\n{\ny\n}\n1\n2\n3\n4\n5\n6\n7\nold\n'],
      ['b', 'y\nz\nx\nz\ny\n1\n2\n3\n4\n5\n6\n7\nnew\n'],
      ['home', undefined],
    ]) {
      fs.mkdirSync(path.join(work, side), { recursive: true });
      if (text) fs.writeFileSync(path.join(work, side, 'index.js'), text);
    }
    if (gitconfig)
      fs.writeFileSync(path.join(work, 'home/.gitconfig'), gitconfig);
    process.env.HOME = path.join(work, 'home');
    const destination = path.join(work, 'canonical.patch');
    createPatch(path.join(work, 'a'), path.join(work, 'b'), destination);
    assert.equal(fs.readFileSync(destination, 'utf8'), expected);
    if (!gitconfig) continue;
    const ambient = spawnSync('git', ['diff', '--no-index', 'a', 'b'], {
      cwd: work,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8',
    }).stdout;
    assert.notEqual(
      ambient.slice(ambient.indexOf('@@')),
      expected.slice(expected.indexOf('@@')),
      'control: an unpinned diff of this fixture has other hunks',
    );
  }
});
