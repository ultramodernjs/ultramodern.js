const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { resolvePackage } = require('./resolve-package.cjs');
const fixtureRequire = createRequire(
  path.join(process.argv[2], 'package.json'),
);
const WebSocket = fixtureRequire('isomorphic-ws');
const NativeWebSocket = fixtureRequire('ws');
assert.equal(
  WebSocket,
  NativeWebSocket,
  'Node wrapper must expose the actual ws implementation',
);
assert.equal(resolvePackage(fixtureRequire, 'ws').manifest.version, '8.23.0');
assert.equal(
  resolvePackage(fixtureRequire, 'isomorphic-ws').manifest.peerDependencies.ws,
  '*',
);
const timeout = setTimeout(() => {
  console.error('websocket runtime timeout');
  process.exit(1);
}, 10000);
let client;
const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
(async () => {
  await once(server, 'listening');
  const connection = once(server, 'connection');
  client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const [peer] = await connection;
  await once(client, 'open');
  const serverMessage = once(peer, 'message');
  client.send('client-to-server');
  const [received] = await serverMessage;
  assert.equal(received.toString(), 'client-to-server');
  const clientMessage = once(client, 'message');
  peer.send('server-to-client');
  assert.equal((await clientMessage)[0].toString(), 'server-to-client');
  const serverPong = once(peer, 'pong');
  peer.ping('server-ping');
  assert.equal((await serverPong)[0].toString(), 'server-ping');
  const clientPong = once(client, 'pong');
  client.ping('client-ping');
  assert.equal((await clientPong)[0].toString(), 'client-ping');
  const serverClose = once(peer, 'close');
  const clientClose = once(client, 'close');
  client.close(1000, 'qualified');
  for (const closed of await Promise.all([serverClose, clientClose])) {
    assert.equal(closed[0], 1000);
    assert.equal(closed[1].toString(), 'qualified');
  }
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  console.log(
    JSON.stringify({
      version: '8.23.0',
      wrapperIdentity: true,
      bidirectionalSend: true,
      bidirectionalPingPong: true,
      close: { code: 1000, reason: 'qualified' },
    }),
  );
})()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(timeout);
    client?.terminate();
    for (const peer of server.clients) peer.terminate();
    server.close();
  });
