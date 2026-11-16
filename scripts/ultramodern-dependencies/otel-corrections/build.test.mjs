import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertOwned, tree, validateMaps } from './build.mjs';

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
