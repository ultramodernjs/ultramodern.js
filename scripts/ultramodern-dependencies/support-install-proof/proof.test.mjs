import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { authenticate, policy } from './proof.mjs';

test('authentication rejects changed bytes and wrong digest', () => {
  const bytes = Buffer.from('control only; not production payload');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  authenticate(bytes, integrity);
  assert.throws(
    () => authenticate(Buffer.from('changed'), integrity),
    /integrity mismatch/,
  );
  assert.throws(
    () => authenticate(bytes, 'sha512-wrong'),
    /integrity mismatch/,
  );
});

test('proof keeps exotic and trust protection with no peer suppression', () => {
  const yaml = policy('https://registry.npmjs.org/', '/external/shared/store');
  assert.match(yaml, /blockExoticSubdeps: true/);
  assert.match(yaml, /trustPolicy: no-downgrade/);
  assert.match(yaml, /strictPeerDependencies: true/);
  assert.match(yaml, /packageImportMethod: clone-or-copy/);
  assert.doesNotMatch(yaml, /allowedVersions|overrides|ignore|exclude/i);
});
