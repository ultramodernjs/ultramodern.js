import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  packArchive,
  readArchive,
} from '../../ultramodern-dependencies/test-peer-corrections/archive.mjs';
import { verifyPayload } from './correction.mjs';
import { qualifyReactRouter } from './qualify.mjs';

assert(process.env.OWNED_TEMP_DIR);
const owner = `react-router-transport-${process.pid}`;
const guardian = '/Users/satan/bin/disk-guardian-artifacts';
const options = {
  workDirectory: process.env.OWNED_TEMP_DIR,
  toolchain: {
    pnpm: process.env.REACT_ROUTER_PNPM,
    storeDirectory: process.env.REACT_ROUTER_STORE,
    sourceRepository: process.env.REACT_ROUTER_SOURCE,
  },
  lifecycle: {
    register(directory) {
      execFileSync(guardian, [
        'register',
        directory,
        '--owner',
        owner,
        '--owner-pid',
        String(process.pid),
        '--kind',
        'dependencies',
      ]);
    },
    release(directory) {
      execFileSync(guardian, ['release', directory, '--owner', owner]);
    },
  },
};
const source = await qualifyReactRouter(options);
assert(source.correctionRequired);
const original = source.artifacts[0].archiveBytes;
const transported = gzipSync(gunzipSync(original), { level: 1 });
assert(!transported.equals(original));
const core = gzipSync(gunzipSync(source.coreBytes), { level: 1 });
const packed = await qualifyReactRouter({
  ...options,
  payloads: {
    '@tanstack/react-router': transported,
    '@tanstack/router-core': core,
  },
});
assert(packed.gates.actualTransportedPayloads);
assert(packed.artifacts[0].archiveBytes.equals(transported));
assert(packed.coreBytes.equals(core));
for (const [file, payload] of [
  ['dist/esm/index.js', transported],
  ['dist/esm/router.js', core],
]) {
  const files = readArchive(payload);
  assert(files.has(file));
  files.set(file, Buffer.from('throw new Error("modified actual payload")'));
  assert.throws(
    () => verifyPayload(packArchive(files), payload),
    /payload changed/,
  );
}
console.log(
  'ACTUAL_TRANSPORT_PROOF_PASS',
  JSON.stringify({
    gates: packed.gates,
    patchSha256: packed.artifacts[0].patchSha256,
    licenseSha256: packed.artifacts[0].licenseSha256,
    sourceIntegrity: packed.artifacts[0].source.archiveIntegrity,
  }),
);
