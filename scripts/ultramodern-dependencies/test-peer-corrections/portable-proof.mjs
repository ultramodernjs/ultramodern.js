import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const owned = process.env.OWNED_TEMP_DIR;
assert(
  owned && process.env.PEER_CORRECTIONS_STORE,
  'caller-owned scratch and external store required',
);
const here = path.dirname(fileURLToPath(import.meta.url));
// Copy only this owned source subtree outside the checkout: no root dependencies.
const detached = path.join(owned, 'detached-source');
fs.cpSync(here, detached, { recursive: true });
const { qualifyPeerCorrections } = await import(
  pathToFileURL(path.join(detached, 'qualify.mjs'))
);
const { readArchive, packArchive } = await import(
  pathToFileURL(path.join(detached, 'archive.mjs'))
);
const { authenticateArchive } = await import(
  pathToFileURL(path.join(detached, 'authenticate.mjs'))
);
const registrations = [];
const lifecycle = {
  register(directory) {
    registrations.push(directory);
    if (process.env.ARTIFACT_GUARDIAN)
      execFileSync(process.env.ARTIFACT_GUARDIAN, [
        'register',
        directory,
        '--owner',
        `peer-proof-${process.pid}`,
        '--owner-pid',
        String(process.pid),
        '--kind',
        'dependencies',
      ]);
  },
  release(directory) {
    if (process.env.ARTIFACT_GUARDIAN)
      execFileSync(process.env.ARTIFACT_GUARDIAN, [
        'release',
        directory,
        '--owner',
        `peer-proof-${process.pid}`,
      ]);
  },
};
const toolchain = { storeDirectory: process.env.PEER_CORRECTIONS_STORE };
const options = { workDirectory: owned, toolchain, lifecycle };
const produced = await qualifyPeerCorrections(options);
assert.equal(produced.artifacts.length, 3);
const payloads = Object.fromEntries(
  produced.artifacts.map(artifact => {
    // Preserve file bytes, change transport bytes: the verifier must test and
    // return this actual archive, not repack a substitute from source.
    const transported = gzipSync(gunzipSync(artifact.archiveBytes), {
      level: 1,
    });
    assert.notDeepEqual(transported, artifact.archiveBytes);
    return [artifact.name, transported];
  }),
);
const cache = new Map(
  produced.upstreams.map(item => [item.tarball, item.archiveBytes]),
);
options.fetchBytes = async url => {
  assert(cache.has(url));
  return cache.get(url);
};
const verified = await qualifyPeerCorrections({ ...options, payloads });
assert(verified.gates.transportedPayloads);
for (const artifact of verified.artifacts)
  assert.deepEqual(artifact.archiveBytes, payloads[artifact.name]);
for (const upstream of produced.upstreams) {
  assert.throws(
    () =>
      authenticateArchive(
        { ...upstream, signatures: [] },
        upstream.archiveBytes,
      ),
    /signature not verified/,
  );
  assert.throws(
    () => authenticateArchive(upstream, Buffer.from('corrupt')),
    /SHA512 mismatch/,
  );
}
const files = readArchive(payloads['ioredis-mock']);
files.set(
  'lib/index.js',
  Buffer.from('throw new Error("transport corruption")'),
);
await assert.rejects(
  qualifyPeerCorrections({
    ...options,
    payloads: { ...payloads, 'ioredis-mock': packArchive(files) },
    log: () => {},
  }),
  /payload changed lib\/index.js/,
);
await assert.rejects(
  qualifyPeerCorrections({
    ...options,
    payloads: { ...payloads, extra: Buffer.alloc(0) },
  }),
  /exactly metadata3/,
);
await assert.rejects(
  qualifyPeerCorrections({
    ...options,
    fetchBytes: async () => Buffer.from('bad upstream'),
    log: () => {},
  }),
  /SHA512 mismatch/,
);
for (const directory of registrations)
  assert(!fs.existsSync(directory), 'scratch cleaned on success and rejection');
console.log(
  'PASS detached clean-host producer + actual differently encoded transported archives + corrupt payload/signature/SHA512 controls + cleanup on every path',
);
