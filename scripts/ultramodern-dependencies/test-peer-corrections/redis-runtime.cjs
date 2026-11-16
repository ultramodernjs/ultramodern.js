const assert = require('node:assert/strict');
const { once } = require('node:events');
const Redis = require('ioredis-mock');
async function main() {
  const redis = new Redis('redis://localhost:16379/9');
  const clients = [redis];
  try {
    await redis.flushall();
    assert.equal(await redis.set('counter', '1'), 'OK');
    assert.equal(await redis.incr('counter'), 2);
    assert.equal(await redis.get('counter'), '2');
    await new Promise((resolve, reject) =>
      redis.get('counter', (err, value) => {
        if (err) return reject(err);
        try {
          assert.equal(value, '2');
          resolve();
        } catch (error) {
          reject(error);
        }
      }),
    );
    assert.deepEqual(await redis.pipeline().set('p', '4').get('p').exec(), [
      [null, 'OK'],
      [null, '4'],
    ]);
    assert.deepEqual(
      await redis.multi().incr('counter').get('counter').exec(),
      [
        [null, 3],
        [null, '3'],
      ],
    );
    await redis.hset('hash', 'field', 'value');
    assert.deepEqual(await redis.hgetall('hash'), { field: 'value' });
    await redis.set('buffer', Buffer.from('bytes'));
    assert.deepEqual(await redis.getBuffer('buffer'), Buffer.from('bytes'));
    assert.equal(
      await redis.eval('return redis.call("GET", KEYS[1])', 1, 'counter'),
      '3',
    );
    redis.defineCommand('readKey', {
      numberOfKeys: 1,
      lua: 'return redis.call("GET", KEYS[1])',
    });
    assert.equal(await redis.readKey('counter'), '3');
    const duplicate = redis.duplicate();
    clients.push(duplicate);
    assert.equal(await duplicate.get('counter'), '3');
    await redis.watch('counter');
    await duplicate.set('counter', '9');
    assert.equal(await redis.multi().set('counter', '10').exec(), null);
    assert.equal(await redis.get('counter'), '9');
    await duplicate.subscribe('channel');
    const message = once(duplicate, 'message');
    assert.equal(await redis.publish('channel', 'hello'), 1);
    assert.deepEqual(await message, ['channel', 'hello']);
    await duplicate.unsubscribe('channel');
    await redis.set('expired', 'x', 'PX', 5);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await redis.get('expired'), null);
    const cluster = new Redis.Cluster([{ host: 'localhost', port: 16380 }], {
      redisOptions: { db: 10 },
    });
    clients.push(cluster, ...cluster.nodes());
    assert.equal(await cluster.set('cluster', 'yes'), 'OK');
    assert.equal(await cluster.get('cluster'), 'yes');
    assert.equal(cluster.nodes().length, 1);
    console.log(
      'PASS Redis: URL parsing, promises/callbacks, pipeline, transaction/watch, hash, buffers, Lua/custom command, duplicate, pub/sub, TTL, cluster',
    );
  } finally {
    await redis.flushall();
    for (const client of clients) client.disconnect();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
