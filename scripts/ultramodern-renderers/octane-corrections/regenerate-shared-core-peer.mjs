// Deterministic full npm-layout recipe. Historical source correction is immutable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { integrity, sha256 } from '../native-artifacts/protocol.mjs';
import { applyExactPatch } from '../native-artifacts/reconstruct.mjs';
import {
  builtPatch,
  unpackNpm,
} from '../native-artifacts/source-qualification.mjs';
import { packages } from './inputs.mjs';
import {
  assertSharedCoreManifest,
  sharedCoreManifest,
} from './shared-core-peer.mjs';

export async function regenerate(work) {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const item = packages.find(item => item.name === '@octanejs/tanstack-router');
  const response = await fetch(item.url);
  assert(response.ok);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(integrity(bytes), item.integrity);
  const original = path.join(work, 'original');
  unpackNpm(bytes, original);
  assert.deepEqual(
    fs.readFileSync(path.join(original, 'package.json')),
    Buffer.from(
      JSON.parse(
        fs.readFileSync(
          path.join(import.meta.dirname, 'upstream-adapter-package.json'),
        ),
      ),
    ),
  );
  const corrected = path.join(work, 'corrected');
  fs.cpSync(original, corrected, { recursive: true });
  const historical = fs.readFileSync(
    path.join(repo, 'patches/@octanejs__tanstack-router@0.3.4.patch'),
  );
  assert.equal(
    sha256(historical),
    'c82cc89c373d23b42b24cb9eb5d748940170b76895bd94139d538ceeebe6af9b',
  );
  applyExactPatch(historical, corrected);
  const manifest = sharedCoreManifest(
    JSON.parse(fs.readFileSync(path.join(original, 'package.json'))),
  );
  assertSharedCoreManifest(manifest);
  fs.writeFileSync(
    path.join(corrected, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return builtPatch(original, corrected);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Use owned-temp-dir --run native-peer-regenerate -- node .../regenerate-shared-core-peer.mjs [--write]',
  );
  const bytes = await regenerate(process.env.OWNED_TEMP_DIR);
  const output = new URL(
    '../../../patches/@octanejs__tanstack-router@0.3.4.shared-core-peer.patch',
    import.meta.url,
  );
  if (process.argv.includes('--write')) fs.writeFileSync(output, bytes);
  else assert.deepEqual(bytes, fs.readFileSync(output));
  console.log(`Shared-core canonical patch SHA256 ${sha256(bytes)}`);
}
