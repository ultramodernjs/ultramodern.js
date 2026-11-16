import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';

export function verifyArtifact(metadata, bytes, keys) {
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    metadata.dist.integrity,
  );
  assert(
    metadata.dist.signatures?.length,
    `${metadata.name}: unsigned registry metadata`,
  );
  assert(
    metadata.dist.signatures.some(signature => {
      const key = keys.find(candidate => candidate.keyid === signature.keyid);
      return (
        key &&
        verify(
          'sha256',
          Buffer.from(
            `${metadata.name}@${metadata.version}:${metadata.dist.integrity}`,
          ),
          createPublicKey({
            key: Buffer.from(key.key, 'base64'),
            format: 'der',
            type: 'spki',
          }),
          Buffer.from(signature.sig, 'base64'),
        )
      );
    }),
    `${metadata.name}: invalid npm registry signature`,
  );
}
