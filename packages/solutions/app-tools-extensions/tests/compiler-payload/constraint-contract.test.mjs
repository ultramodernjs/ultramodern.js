import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

const compiler = new URL('../../compiler/', import.meta.url);
const patch = fs.readFileSync(new URL('constraint.patch', compiler), 'utf8');
const source = JSON.parse(
  fs.readFileSync(new URL('source.json', compiler), 'utf8'),
);

// This guards the correction being shipped, not native compiler behavior.
// The hosted retained-checker test separately exercises actual diagnostics.
function assertScopedIdentityCorrection(text) {
  assert.match(
    text,
    /\+ {8}if t\.flags\(\)\.intersects\(TypeFlags::IndexedAccess\) \{/u,
  );
  assert.match(
    text,
    /\+ {16}\.intersects\(TypeFlags::TypeParameter \| TypeFlags::Conditional\)/u,
  );
  assert.match(text, /\+ {16}identity = RecursionId::Type\(target\);/u);
  assert.match(
    text,
    /^ {9}if stack\.len < 10 \|\| stack\.len < 50 && !stack\.contains\(identity\) \{$/mu,
  );
  const removals = text.split('\n').filter(line => /^-[^-]/u.test(line));
  assert.deepEqual(removals, [
    '-        let identity = get_recursion_identity(self, t);',
    '-fn get_recursion_identity_target(c: &mut Checker, t: P<Type>) -> P<Type> {',
  ]);
}

test('owned compiler pins the released Effect/tsrs component and embedded TypeScript identities', () => {
  assert.deepEqual(source.effect, {
    baseVersion: '0.73.2',
    baseCommit: 'ec0221e2bf7a3fe867b1157ca598816314ee2ca1',
  });
  assert.deepEqual(source.tsrs, {
    version: '7.1.0-beta.tsrs3',
    sourceCommit: 'eba9b2b796ef5e4a80b793e0b94b72bc7d4a9c05',
  });
  assert.deepEqual(source.typescript, {
    version: '7.1.0-beta',
    sourceCommit: '3e9236361fa97a9e6c685f4833ac457ae2d8c50a',
  });
  assert.equal(source.optimization, 'none');
  assert.deepEqual(source.targets, [
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
    'win32-x64',
  ]);
  assert.equal(
    createHash('sha256').update(patch).digest('hex'),
    source.patchSha256,
  );
});

test('shipped correction retains indexed parameter OR conditional identity and unchanged recursion limits', () => {
  assertScopedIdentityCorrection(patch);
  for (const mutation of [
    patch.replace(' | TypeFlags::Conditional', ''),
    patch.replace('TypeFlags::IndexedAccess', 'TypeFlags::TypeParameter'),
    patch.replace(
      'RecursionId::Type(target)',
      'get_recursion_identity(self, target)',
    ),
    patch.replace('stack.len < 50', 'stack.len < 100'),
  ]) {
    assert.throws(() => assertScopedIdentityCorrection(mutation));
  }
});
