// The one loopback port allocator for every proof, test harness and fixture.
//
// It lives in its own leaf module, importing Node builtins only, because the
// publish lane runs scripts/ultramodern-publish/run-release-acceptance.mjs in
// bare checkouts with no dependency install: anything that module can reach
// statically must resolve without node_modules. Importing the lease from
// renderer-mf-lifecycle-proof/runtime.mjs instead pulls in that module's
// `yaml` closure and breaks those jobs with ERR_MODULE_NOT_FOUND.
import assert from 'node:assert/strict';
import net from 'node:net';

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
