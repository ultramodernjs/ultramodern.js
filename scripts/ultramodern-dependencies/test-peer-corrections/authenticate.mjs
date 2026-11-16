import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';

const keys = JSON.parse(
  fs.readFileSync(new URL('./registry-signing-keys.json', import.meta.url)),
);
export function authenticateArchive(identity, archiveBytes) {
  assert.equal(
    `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`,
    identity.integrity,
    `${identity.name}: upstream SHA512 mismatch`,
  );
  const data = Buffer.from(
    `${identity.name}@${identity.version}:${identity.integrity}`,
  );
  const signature = identity.signatures.find(signature => {
    const key = keys.find(
      key => key.keyid === signature.keyid && key.expires === null,
    );
    return (
      key &&
      verify(
        'sha256',
        data,
        createPublicKey({
          key: Buffer.from(key.key, 'base64'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(signature.sig, 'base64'),
      )
    );
  });
  assert(signature, `${identity.name}: npm registry signature not verified`);
  return {
    ...identity,
    archiveBytes: Buffer.from(archiveBytes),
    authentication: {
      scheme: 'npm-registry-ecdsa-sha256+sha512',
      keyid: signature.keyid,
    },
  };
}
