import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');

test('the canonical owning source patch exposes only the existing heldRead re-export', () => {
  const patch = read('./held-read-source.patch');
  assert.deepEqual(
    patch
      .split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++')),
    [
      '+  heldRead,',
      '+export { setSwapHook, isHidden } from "@solidjs/signals";',
    ],
  );
  assert.deepEqual(
    patch
      .split('\n')
      .filter(line => line.startsWith('-') && !line.startsWith('---')),
    ['-export { setSwapHook, isHidden, heldRead } from "@solidjs/signals";'],
  );
  assert.match(patch, /a\/packages\/solid\/src\/index\.ts/u);
});

test('the declaration correction is exactly the source-generated heldRead export, without invented signatures', () => {
  const patch = read('./held-read-declarations.patch');
  const before = patch
    .split('\n')
    .filter(line => line.startsWith('-') && !line.startsWith('---'));
  const after = patch
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'));
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(
    after[0].slice(1).replace('getOwner, heldRead,', 'getOwner,'),
    before[0].slice(1),
  );
  assert.match(after[0], /from "@solidjs\/signals"/u);
  assert.doesNotMatch(patch, /declare function|any|package\.json|dist\//u);
});

test('correction provenance locks source and generated declaration bytes separately from publication', () => {
  const provenance = JSON.parse(read('./held-read-provenance.json'));
  assert.equal(provenance.status, 'source-correction-qualified-not-published');
  assert.equal(
    provenance.source.commit,
    '221b5f99faf0f47dbe6d5c4c6cb77661053e44b8',
  );
  for (const [name, digest] of Object.entries(provenance.patches)) {
    assert.equal(
      createHash('sha256')
        .update(read(`./${name}`))
        .digest('hex'),
      digest,
      name,
    );
  }
  assert.deepEqual(provenance.runtimeChanges, []);
  assert.equal(provenance.compiler.version, '7.0.2');
  assert.equal(provenance.compiler.skipLibCheck, false);
});
