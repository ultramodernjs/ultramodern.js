import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const template = new URL(
  '../templates/workspace-scripts/proof-workerd-ssr.mjs',
  import.meta.url,
);
const { withWorkerdTargetServers: withTargets } = await import(template);

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
const close = server => new Promise(resolve => server.close(resolve));
const unusedPorts = async () => {
  const servers = [http.createServer(), http.createServer()];
  try {
    await Promise.all(servers.map(server => listen(server, 0)));
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(close));
  }
};
const appsFor = ports =>
  ports.map((port, index) => ({
    id: `app${index}`,
    kind: index ? 'vertical' : 'shell',
    port,
    wrangler: { name: `app${index}` },
  }));
const assertReleased = async ports => {
  for (const port of ports) {
    const server = http.createServer();
    try {
      await listen(server, port);
    } finally {
      await close(server);
    }
  }
};
const fixture = { kvSeeds: [] };
const workers = [0, 1].map(index => ({
  name: `app${index}`,
  modules: true,
  compatibilityDate: '2026-10-12',
  script: `export default { fetch(request) { return new Response('app${index}:' + new URL(request.url).pathname); } };`,
}));

test('real Miniflare loopback cannot take a later frontend; same listeners dispatch and close', async () => {
  const ports = await unusedPorts();
  const apps = appsFor(ports);
  const originalListen = net.Server.prototype.listen;
  let competingListener;
  let collision;
  // Force the actual Miniflare loopback allocator to consider the later target.
  // A real bind, not a mocked EADDRINUSE. On rejection retain its normal port-0 allocation.
  net.Server.prototype.listen = function (...args) {
    if (!competingListener && args[0] === 0 && typeof args[1] === 'string') {
      competingListener = this;
      assert.ok(
        this instanceof http.Server,
        'Miniflare uses a real HTTP loopback',
      );
      assert.match(new Error().stack, /#startLoopbackServer/);
      // Model an ephemeral allocator selecting this candidate only if it is free.
      const probe = net.createServer();
      probe.once('error', error => {
        collision = error;
        originalListen.call(this, ...args);
      });
      originalListen.call(probe, ports[1], args[1], () => {
        probe.close(() =>
          originalListen.call(this, ports[1], args[1], args[2]),
        );
      });
      return this;
    }
    return originalListen.apply(this, args);
  };
  let runtime;
  try {
    await withTargets(apps, async targets => {
      for (const port of ports) {
        const response = await fetch(`http://127.0.0.1:${port}`);
        assert.equal(response.status, 503);
      }
      runtime = new Miniflare(
        convertV4MiniflareOptions({ host: '127.0.0.1', workers }),
      );
      await runtime.ready;
      assert.ok(
        competingListener,
        'real Miniflare internal listener attempted allocation',
      );
      const failedServices = new Set();
      await targets.start(runtime, failedServices, workers, fixture);
      assert.deepEqual(
        targets.targetUrls,
        Object.fromEntries(
          apps.map(app => [app.id, `http://127.0.0.1:${app.port}`]),
        ),
      );
      assert.equal(
        collision?.code,
        'EADDRINUSE',
        'frontend owned port before Miniflare allocation',
      );
      for (const [index, port] of ports.entries()) {
        const response = await fetch(
          `http://127.0.0.1:${port}/actual-dispatch`,
        );
        assert.equal(response.status, 200);
        assert.equal(await response.text(), `app${index}:/actual-dispatch`);
      }
      const fault = await fetch(
        `http://127.0.0.1:${ports[0]}/_ultramodern-proof/service-binding-fault`,
        {
          method: 'POST',
          body: JSON.stringify({ appId: 'app1', failed: true }),
        },
      );
      assert.equal(fault.status, 200);
      assert.deepEqual(await fault.json(), { failed: true, service: 'app1' });
      assert.ok(failedServices.has('app1'));
      await targets.stop();
      await targets.stop();
    });
  } finally {
    net.Server.prototype.listen = originalListen;
    await runtime?.dispose();
  }
  await assertReleased(ports);
});

test('occupied target fails without stealing it and releases earlier reservations', async () => {
  const ports = await unusedPorts();
  const foreign = http.createServer((_, response) => response.end('foreign'));
  await listen(foreign, ports[1]);
  try {
    await assert.rejects(
      withTargets(appsFor(ports), async () =>
        assert.fail('runtime creation must not run'),
      ),
      { code: 'EADDRINUSE' },
    );
    assert.equal(
      await (await fetch(`http://127.0.0.1:${ports[1]}`)).text(),
      'foreign',
    );
    await assertReleased([ports[0]]);
  } finally {
    await close(foreign);
  }
});

test('early configuration/runtime failure releases every frontend without fake readiness', async () => {
  const ports = await unusedPorts();
  await assert.rejects(
    withTargets(appsFor(ports), async () => {
      const response = await fetch(`http://127.0.0.1:${ports[0]}`);
      assert.equal(response.status, 503);
      throw new Error('early configuration failure');
    }),
    /early configuration failure/,
  );
  await assertReleased(ports);
  await assert.rejects(
    withTargets(appsFor(ports), async targets => {
      await targets.start(
        {},
        new Set(),
        [workers[0], { ...workers[1], script: 'invalid worker !' }],
        fixture,
      );
      assert.fail('invalid runtime must not become ready');
    }),
    { code: 'ERR_RUNTIME_FAILURE' },
  );
  await assertReleased(ports);
});
