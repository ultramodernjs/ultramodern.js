// The one loopback port allocator for every proof, test harness and fixture.
//
// It lives in its own leaf module, importing Node builtins only, because the
// publish lane runs scripts/ultramodern-publish/run-release-acceptance.mjs in
// bare checkouts with no dependency install: anything that module can reach
// statically must resolve without node_modules. Importing the lease from
// renderer-mf-lifecycle-proof/runtime.mjs instead pulls in that module's
// `yaml` closure and breaks those jobs with ERR_MODULE_NOT_FOUND.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Hold one loopback port until its owner is ready to bind it.
 *
 * Binding port 0, reading the number and closing the socket returns a port the
 * kernel is free to hand to a sibling before the child binds it; that is the
 * observed `listen EADDRINUSE: address already in use 127.0.0.1:43929`. A lease
 * keeps its socket bound, so the number cannot be issued twice, and the owner
 * calls `release()` in the statement before the spawn that binds it.
 *
 * The socket is unreferenced: a lease an aborted proof never released can
 * never keep its process alive.
 */
export async function leasePort(host = '127.0.0.1') {
  const server = net.createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  let closing;
  return {
    port,
    get bound() {
      return closing === undefined;
    },
    /** Unbind, so the next statement can hand this port to its child. */
    release() {
      return (closing ??= new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve(port))),
      ));
    },
  };
}

/**
 * Hold `count` distinct loopback ports at once. Distinctness is the kernel's:
 * every socket stays bound while the next is opened, so no two leases in a set
 * - or across concurrent sets in sibling processes - can carry one port.
 */
export async function leasePorts(count, host = '127.0.0.1') {
  assert(Number.isSafeInteger(count) && count > 0);
  const leases = [];
  try {
    while (leases.length < count) leases.push(await leasePort(host));
  } catch (error) {
    await Promise.allSettled(leases.map(lease => lease.release()));
    throw error;
  }
  const ports = leases.map(lease => lease.port);
  assert.equal(
    new Set(ports).size,
    count,
    'Held port leases must carry distinct ports',
  );
  return {
    ports,
    leases,
    get bound() {
      return leases.some(lease => lease.bound);
    },
    release: () => Promise.all(leases.map(lease => lease.release())),
  };
}

// A lease ends when its socket closes, so a port its owner binds later (a
// child server, a restarted dev server, an in-process server after a build that
// bakes the port in) is unowned in between. Proofs that run side by side share
// that window with every bind(0) and outgoing connect() of their siblings.
//
// A claim owns its port from allocation until `free()`, bound or not:
// - the port lies below the kernel's ephemeral range, so neither bind(0) nor a
//   connect() autobind can ever be handed it;
// - a claim file created with O_EXCL makes it exclusive among claimers in every
// process on this machine; a claim whose owner process died is taken over.
// The claim files live in one machine-wide directory, never under a TMPDIR a
// parent rewrote for its children.
const claimDirectory = () =>
  path.join(
    process.platform === 'win32' ? os.tmpdir() : '/tmp',
    'ultramodern-port-claims',
  );
const claimFloor = 20_000;
const ownedClaims = new Set();
let exitHookInstalled = false;

/** The first port the kernel may hand to bind(0) or connect(). */
export function ephemeralPortFloor() {
  if (process.platform !== 'linux') return 49_152; // IANA, macOS and Windows
  const [first] = fs
    .readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')
    .trim()
    .split(/\s+/u)
    .map(Number);
  assert(Number.isSafeInteger(first), 'Unreadable ephemeral port range');
  return first;
}

function claimOwnerAlive(file) {
  let pid;
  try {
    pid = Number(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return true; // freed meanwhile; skip it
    throw error;
  }
  // A claim still being written has no pid yet; it is not stale.
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function writeClaim(file) {
  try {
    fs.writeFileSync(file, `${process.pid}`, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/** Create the port's claim file, or take over one whose owner died. */
function claimFile(port) {
  const file = path.join(claimDirectory(), String(port));
  if (writeClaim(file)) return file;
  if (claimOwnerAlive(file)) return undefined;
  // One reclaimer at a time, so two cannot both remove and recreate it.
  const lock = `${file}.reclaim`;
  if (!writeClaim(lock)) return undefined;
  try {
    if (claimOwnerAlive(file)) return undefined;
    fs.rmSync(file, { force: true });
    return writeClaim(file) ? file : undefined;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function dropOwnedClaims() {
  for (const file of ownedClaims) fs.rmSync(file, { force: true });
}

/**
 * Claim `port` if no claimer owns it and nothing is bound to it; otherwise
 * return undefined. See claimPort for what a claim is.
 */
export async function claimPortAt(port, host = '127.0.0.1') {
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  fs.mkdirSync(claimDirectory(), { recursive: true });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', dropOwnedClaims);
  }
  const file = claimFile(port);
  if (!file) return undefined;
  const server = net.createServer();
  server.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    fs.rmSync(file, { force: true });
    // Bound by a process that does not claim: not ours to take.
    if (error.code === 'EADDRINUSE') return undefined;
    throw error;
  }
  ownedClaims.add(file);
  let closing;
  let freeing;
  const release = () =>
    (closing ??= new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve(port))),
    ));
  return {
    port,
    get bound() {
      return closing === undefined;
    },
    get claimed() {
      return freeing === undefined;
    },
    /** Unbind; the port stays claimed for its owner's own server. */
    release,
    /** End of use: unbind if still bound and give the port back. */
    free() {
      return (freeing ??= release().finally(() => {
        fs.rmSync(file, { force: true });
        ownedClaims.delete(file);
      }));
    },
  };
}

/**
 * Own one loopback port from allocation until `free()`. The port is bound
 * until `release()` (call it in the statement before the server that binds
 * it starts); after that it stays claimed, so the owner can bind it, stop and
 * bind it again for as long as it lives.
 */
export async function claimPort(host = '127.0.0.1') {
  const ceiling = ephemeralPortFloor();
  const size = ceiling - claimFloor;
  assert(size >= 1024, `No claimable port range below ${ceiling}`);
  const start = randomInt(size);
  for (let offset = 0; offset < size; offset += 1) {
    const claim = await claimPortAt(
      claimFloor + ((start + offset) % size),
      host,
    );
    if (claim) return claim;
  }
  throw new Error(`Every claimable port in ${claimFloor}-${ceiling} is taken`);
}

/** Claim `count` distinct ports; `free()` gives every one back. */
export async function claimPorts(count, host = '127.0.0.1') {
  assert(Number.isSafeInteger(count) && count > 0);
  const claims = [];
  try {
    while (claims.length < count) claims.push(await claimPort(host));
  } catch (error) {
    await Promise.allSettled(claims.map(claim => claim.free()));
    throw error;
  }
  return {
    ports: claims.map(claim => claim.port),
    claims,
    release: () => Promise.all(claims.map(claim => claim.release())),
    free: () => Promise.all(claims.map(claim => claim.free())),
  };
}
