import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import * as native from '../../ultramodern-renderers/native-artifacts/protocol.mjs';
import { admittedRouterCore, authenticate, policy } from './proof.mjs';

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

const manifest = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../../packages/runtime/renderer-solid/package.json',
      import.meta.url,
    ),
  ),
);

test('proof installs the Core tuple the renderer records in its own admitted descriptor', () => {
  const descriptor = manifest.ultramodern.nativeArtifacts;
  assert.deepEqual(admittedRouterCore(manifest), {
    ...descriptor.packages['@tanstack/router-core'],
    producer: descriptor.producer,
  });
  assert.equal(
    admittedRouterCore(manifest).version,
    native.cohort['@tanstack/router-core'],
  );
  for (const [field, value, message] of [
    ['devDependencies', '1.171.39', /admitted Core archive/],
    ['peerDependencies', '1.171.38', /admitted Core version/],
  ]) {
    const drifted = structuredClone(manifest);
    drifted[field]['@tanstack/router-core'] = value;
    assert.throws(() => admittedRouterCore(drifted), message);
  }
  const tampered = structuredClone(manifest);
  tampered.ultramodern.nativeArtifacts.packages[
    '@tanstack/router-core'
  ].request = 'https://evil.invalid/tanstack-router-core-1.171.39.tgz';
  assert.throws(() => admittedRouterCore(tampered), /canonical request/);
});

test('proof rejects the legacy flat native artifact layout', () => {
  const pin =
    manifest.ultramodern.nativeArtifacts.packages['@tanstack/router-core'];
  const legacy = structuredClone(manifest);
  legacy.ultramodern.nativeArtifacts = {
    '@tanstack/router-core': {
      request: pin.request,
      version: pin.version,
      integrity: pin.integrity,
    },
  };
  assert.throws(() => admittedRouterCore(legacy), /native descriptor/);
});
