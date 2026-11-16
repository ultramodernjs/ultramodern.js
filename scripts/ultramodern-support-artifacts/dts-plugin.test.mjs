import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import inventory from '../../packages/toolkit/ultramodern-create/src/ultramodern-workspace/patch-inventory.ts';
import { inputs, supportProtocol as p } from './protocol.mjs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url));

test('rsbuild-plugin-dts input is the signed npm source and exact canonical patch', () => {
  const input = inputs['rsbuild-plugin-dts'];
  const identity = JSON.parse(read('./dts-plugin-registry.json'));
  assert.deepEqual(Object.keys(input.upstream).sort(), [
    'archiveRoot',
    'integrity',
    'kind',
    'licensePath',
    'licenseSha256',
    'request',
    'sourceArchiveIntegrity',
  ]);
  assert.equal(input.upstream.kind, 'authenticated-npm-source');
  assert.equal(identity.tarball, input.upstream.request);
  assert.equal(identity.integrity, input.upstream.integrity);
  assert.equal(input.upstream.sourceArchiveIntegrity, input.upstream.integrity);
  const keys = JSON.parse(
    read(
      '../ultramodern-dependencies/test-peer-corrections/registry-signing-keys.json',
    ),
  );
  const data = Buffer.from(
    `${identity.name}@${identity.version}:${identity.integrity}`,
  );
  assert(
    identity.signatures.some(signature => {
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
    }),
    'npm registry signature',
  );
  const patch = read(`../../${input.patchPath}`);
  assert.equal(p.sha256(patch), input.patchSha256);
  // Producer input only: never projected into repository patchedDependencies.
  const entry = inventory.find(
    item =>
      item.packageName === 'rsbuild-plugin-dts' &&
      item.version === input.version,
  );
  assert.equal(entry?.path, input.patchPath);
  assert.equal(entry.sha256, input.patchSha256);
  assert.equal(entry.repository, false);
  assert.equal(entry.workspace, null);
});
