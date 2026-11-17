// Port claims let renderer feature rows run side by side: a claimed port is
// its owner's from allocation until free(), bound or not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claimPort,
  claimPortAt,
  claimPorts,
  ephemeralPortFloor,
} from '../ultramodern-production-readiness/renderer-mf-lifecycle-proof/port-lease.mjs';

const leaseModule = fileURLToPath(
  new URL(
    '../ultramodern-production-readiness/renderer-mf-lifecycle-proof/port-lease.mjs',
    import.meta.url,
  ),
);
const claimFile = port =>
  path.join(
    process.platform === 'win32' ? os.tmpdir() : '/tmp',
    'ultramodern-port-claims',
    String(port),
  );

const listen = port =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
const close = server => new Promise(resolve => server.close(resolve));

/** A port this test owns exclusively, given back so the test can reclaim it. */
async function unclaimedPort() {
  const claim = await claimPort();
  await claim.free();
  return claim.port;
}

test('claims lie below the ephemeral range and are distinct', async () => {
  const set = await claimPorts(6);
  try {
    assert.equal(new Set(set.ports).size, 6);
    for (const port of set.ports) {
      assert(port >= 20_000 && port < ephemeralPortFloor());
      assert.equal(fs.readFileSync(claimFile(port), 'utf8'), `${process.pid}`);
    }
  } finally {
    await set.free();
  }
  for (const port of set.ports) assert(!fs.existsSync(claimFile(port)));
});

test('a released claim stays owned until free, and its owner can bind it again and again', async () => {
  const claim = await claimPort();
  const { port } = claim;
  assert.equal(claim.bound, true);
  await assert.rejects(listen(port), { code: 'EADDRINUSE' });
  await claim.release();
  assert.equal(claim.bound, false);
  assert.equal(claim.claimed, true);
  // Unbound, yet no claimer may take it: the owner's server binds it, stops,
  // and binds it again (a restarted dev server).
  assert.equal(await claimPortAt(port), undefined);
  await close(await listen(port));
  assert.equal(await claimPortAt(port), undefined);
  await close(await listen(port));
  await claim.free();
  assert.equal(claim.claimed, false);
  const again = await claimPortAt(port);
  assert(again, 'A freed port can be claimed again');
  await again.free();
});

test('a port bound by a process that does not claim is never claimed', async () => {
  const port = await unclaimedPort();
  const foreign = await listen(port);
  try {
    assert.equal(await claimPortAt(port), undefined);
    assert(!fs.existsSync(claimFile(port)), 'A refused claim leaves no file');
  } finally {
    await close(foreign);
  }
});

test('a claim whose owner died is taken over; a live owner keeps it', async () => {
  const port = await unclaimedPort();
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(dead.status, 0);
  fs.writeFileSync(claimFile(port), `${dead.pid}`, { flag: 'wx' });
  const taken = await claimPortAt(port);
  assert(taken, 'A stale claim must not lose the port forever');
  assert.equal(fs.readFileSync(claimFile(port), 'utf8'), `${process.pid}`);
  await taken.free();
  // A claim held by a live process (here: this one, as a sibling would) stays.
  fs.writeFileSync(claimFile(port), `${process.pid}`, { flag: 'wx' });
  try {
    assert.equal(await claimPortAt(port), undefined);
  } finally {
    fs.rmSync(claimFile(port));
  }
});

test('claims are exclusive across processes and given back when the owner exits', async () => {
  const port = await unclaimedPort();
  const owner = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { claimPortAt } = await import(${JSON.stringify(leaseModule)});
       const claim = await claimPortAt(${port});
       if (!claim) process.exit(3);
       await claim.release();
       const { readFileSync } = await import('node:fs');
       process.stdout.write(readFileSync(${JSON.stringify(claimFile(port))}, 'utf8'));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(owner.status, 0, owner.stderr);
  // The child held the claim while it ran ...
  assert.equal(owner.stdout, `${owner.pid}`);
  // ... and its exit, without free(), gave the port back.
  assert(!fs.existsSync(claimFile(port)));
  const mine = await claimPortAt(port);
  assert(mine);
  try {
    const sibling = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { claimPortAt } = await import(${JSON.stringify(leaseModule)});
         process.exit((await claimPortAt(${port})) ? 4 : 0);`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(sibling.status, 0, 'A sibling process took a claimed port');
    await mine.release();
    const unbound = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { claimPortAt } = await import(${JSON.stringify(leaseModule)});
         process.exit((await claimPortAt(${port})) ? 4 : 0);`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      unbound.status,
      0,
      'A sibling process took a released, still claimed port',
    );
  } finally {
    await mine.free();
  }
});
