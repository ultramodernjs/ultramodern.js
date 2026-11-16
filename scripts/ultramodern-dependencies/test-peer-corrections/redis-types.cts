import RedisMock = require('ioredis-mock');

import type { Cluster, Redis, RedisOptions } from 'ioredis';

const options: RedisOptions = { lazyConnect: true, db: 2 };
const redis: Redis = new RedisMock(options);
const duplicate: Redis = redis.duplicate();
const cluster: Cluster = new RedisMock.Cluster(
  [{ host: 'localhost', port: 6379 }],
  { redisOptions: options },
);
const value: Promise<string | null> = redis.get('key');
const buffer: Promise<Buffer | null> = redis.getBuffer('key');
const result = redis.pipeline().set('key', 'value').get('key').exec();
redis.get('key', (error, reply) => {
  if (error) throw error;
  const text: string | null | undefined = reply;
  return text;
});
redis.defineCommand('readKey', {
  numberOfKeys: 1,
  lua: 'return redis.call("GET", KEYS[1])',
});
void [duplicate, cluster, value, buffer, result];
