import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { verifyArtifact } from './authenticate.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const bytes = Buffer.from('real fixture artifact');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const name = '@fixture/otel';
const version = '1.0.0';
const signature = sign(
  'sha256',
  Buffer.from(`${name}@${version}:${integrity}`),
  privateKey,
).toString('base64');
const metadata = {
  name,
  version,
  dist: { integrity, signatures: [{ keyid: 'fixture-key', sig: signature }] },
};
const keys = [
  {
    keyid: 'fixture-key',
    key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  },
];

test('accepts matching bytes signed for exact package identity', () => {
  verifyArtifact(metadata, bytes, keys);
});
test('rejects mutated bytes', () => {
  assert.throws(() =>
    verifyArtifact(metadata, Buffer.from('changed artifact'), keys),
  );
});
test('rejects signature replay under another package identity', () => {
  assert.throws(
    () => verifyArtifact({ ...metadata, name: '@fixture/replay' }, bytes, keys),
    /invalid npm registry signature/,
  );
});
test('rejects unknown signing keys', () => {
  assert.throws(
    () => verifyArtifact(metadata, bytes, []),
    /invalid npm registry signature/,
  );
});
test('rejects unsigned artifacts', () => {
  assert.throws(
    () => verifyArtifact({ ...metadata, dist: { integrity } }, bytes, keys),
    /unsigned registry metadata/,
  );
});
