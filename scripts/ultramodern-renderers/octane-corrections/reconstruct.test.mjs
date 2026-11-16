import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packages, references, source } from './inputs.mjs';
import {
  applyExactPatch,
  assertIdentity,
  assertSameTree,
  digest,
  verifyIntegrity,
} from './reconstruct.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'octane-correction-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('pinned exact identities and authored port hash', () => {
  assert.equal(source.commit, '4c35afcdca0f4889921612fc462e6aabe507d78d');
  assert.deepEqual(
    packages.map(p => [p.name, p.version]),
    [
      ['octane', '0.18.0'],
      ['@octanejs/tanstack-router', '0.3.4'],
      ['@octanejs/rspack-plugin', '0.2.10'],
    ],
  );
  assert.equal(
    digest(
      fs.readFileSync(
        new URL('./routerRenderSnapshot.ts.txt', import.meta.url),
      ),
    ),
    references.snapshotSourceSha256,
  );
});
test('integrity rejection is on bytes, not mutable registry metadata', () => {
  const bytes = Buffer.from('archive');
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  verifyIntegrity(bytes, sri);
  assert.throws(
    () => verifyIntegrity(Buffer.from('modified'), sri),
    /integrity/i,
  );
});
test('original package names and versions cannot be substituted', t => {
  const dir = fixture(t);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'renamed-sidecar', version: '0.3.4' }),
  );
  assert.throws(() => assertIdentity(dir, packages[1]));
});
test('complete package comparison detects removed and altered files', t => {
  const dir = fixture(t);
  const a = path.join(dir, 'a'),
    b = path.join(dir, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'runtime.js'), 'real build');
  fs.writeFileSync(path.join(b, 'runtime.js'), 'real build');
  assertSameTree(a, b);
  fs.writeFileSync(path.join(b, 'runtime.js'), 'invented dist');
  assert.throws(() => assertSameTree(a, b));
  fs.unlinkSync(path.join(b, 'runtime.js'));
  assert.throws(() => assertSameTree(a, b));
});
test('patch checker rejects even a clean offset application', t => {
  const dir = fixture(t),
    patch = path.join(dir, 'change.patch');
  fs.writeFileSync(
    path.join(dir, 'input'),
    'prefix\nzero\none\ntwo\nthree\nfour\n',
  );
  fs.writeFileSync(
    patch,
    'diff --git a/input b/input\n--- a/input\n+++ b/input\n@@ -2,3 +2,3 @@\n one\n-two\n+changed\n three\n',
  );
  assert.throws(() => applyExactPatch(dir, patch), /offset/i);
  assert.equal(
    fs.readFileSync(path.join(dir, 'input'), 'utf8'),
    'prefix\nzero\none\ntwo\nthree\nfour\n',
  );
});
