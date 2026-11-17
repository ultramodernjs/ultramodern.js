import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pollRegistryPropagation,
  registryPropagationDelaysMs,
} from '../lib/prepare-bleedingdev-packages/registry-propagation.mjs';

// The cohort verifier and the sidecar lane both run this schedule after the
// unrollbackable publish. If it gives up before npm has propagated a freshly
// published version, a complete publish is reported as a failure (run
// 34689880072: one cohort packument lagged for more than 360s; run
// 36137116871: a sidecar became readable minutes after a 90s window).
test('post-publish propagation schedule outlasts npm packument propagation', () => {
  const delays = [...registryPropagationDelaysMs];
  // The poller sleeps once between each pair of reads: every delay is spent.
  const spentMs = delays.reduce((sum, delay) => sum + delay, 0);
  assert.ok(
    spentMs >= 840_000,
    `propagation waits ${spentMs}ms; npm has needed more than 420s`,
  );
  // Front-loaded: a package that is already coherent is accepted in seconds.
  assert.ok(delays[0] <= 2000);
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(delays[index] >= delays[index - 1], 'delays never shrink');
  }
  assert.ok(Math.max(...delays) <= 20_000, 'reads stay at most 20s apart');
});

test('propagation poller spends the schedule, then reports the last pending state', async () => {
  const waits = [];
  const outcome = await pollRegistryPropagation(
    async attempt => ({ detail: `pending ${attempt}`, settled: false }),
    {
      delaysMs: [1, 2, 3],
      wait: async ms => {
        waits.push(ms);
      },
    },
  );
  assert.deepEqual(outcome, {
    attempts: 4,
    detail: 'pending 4',
    firstDetail: 'pending 1',
    settled: false,
  });
  assert.deepEqual(waits, [1, 2, 3]);
});

test('propagation poller settles without waiting further and never retries a throw', async () => {
  const waits = [];
  const wait = async ms => {
    waits.push(ms);
  };
  let reads = 0;
  const settled = await pollRegistryPropagation(
    async () => {
      reads += 1;
      return reads < 3
        ? { detail: 'absent', settled: false }
        : { settled: true, value: 'dist' };
    },
    { wait },
  );
  assert.deepEqual(settled, {
    attempts: 3,
    firstDetail: 'absent',
    settled: true,
    value: 'dist',
  });
  assert.deepEqual(waits, registryPropagationDelaysMs.slice(0, 2));

  waits.length = 0;
  await assert.rejects(
    pollRegistryPropagation(
      async () => {
        throw new Error('integrity drift');
      },
      { wait },
    ),
    /integrity drift/u,
  );
  assert.deepEqual(waits, [], 'a terminal probe failure never sleeps');
});

test('registry readers drain concurrent work before reporting the first input failure', async () => {
  const { mapWithConcurrency } = await import(
    '../lib/prepare-bleedingdev-packages/registry-read.mjs'
  );
  const completed = [];
  let release;
  const pending = mapWithConcurrency([0, 1, 2], 2, async index => {
    if (index === 0) throw new Error('first package');
    if (index === 1)
      await new Promise(resolve => {
        release = resolve;
      });
    completed.push(index);
  });
  let settled = false;
  const rejected = assert.rejects(pending, /first package/).then(() => {
    settled = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await rejected;
  assert.deepEqual(completed.sort(), [1, 2]);
});

test('registry reads distinguish absent, throttled and malformed state', async () => {
  const { lookupRegistryPackument, resolveRegistryPackageDist } = await import(
    '../lib/prepare-bleedingdev-packages/registry-read.mjs'
  );
  const pkg = '@bleedingdev/modern-js-runtime';
  const read = (output, options = {}) =>
    resolveRegistryPackageDist(pkg, '1.0.0', {
      run: async () => {
        if (output instanceof Error) throw output;
        return { stdout: output };
      },
      ...options,
    });
  assert.equal(
    await read(new Error('E404 Not Found'), { optional: true }),
    null,
  );
  await assert.rejects(
    read(new Error('E429 Too Many Requests'), { optional: true }),
    /uncertain/,
  );
  await assert.rejects(read('[]', { optional: true }), /invalid registry dist/);
  const dist = { shasum: 'exact', integrity: 'exact' };
  assert.deepEqual(await read(JSON.stringify(dist)), dist);
  for (const status of [404, 429]) {
    const delays = [];
    let requests = 0;
    await assert.rejects(
      lookupRegistryPackument(pkg, {
        fetchImpl: async () => {
          requests += 1;
          return { ok: false, status };
        },
        wait: async delay => {
          delays.push(delay);
        },
      }),
      status === 404 ? /HTTP 404/ : /stayed throttled/,
    );
    assert.equal(requests, status === 404 ? 1 : 4);
    assert.deepEqual(delays, status === 404 ? [] : [1000, 2000, 3000]);
  }
});

// The post-publish probe waits for a version npm has just accepted. A CDN or
// npm-cache copy of the packument never shows it, so every read must bypass
// caches and still see the fresh version while cached requests get stale data.
// registry.npmjs.org answers a plain packument GET from its CDN copy whatever
// cache-control the client sends; only the `?write=true` packument reaches
// the origin.
test('post-publish registry lookups read the origin, not a cached packument', async () => {
  const { lookupRegistryDistTag, lookupRegistryPackageDist } = await import(
    '../lib/prepare-bleedingdev-packages/registry-read.mjs'
  );
  const pkg = '@bleedingdev/modern-js-runtime';
  const freshDist = { integrity: 'sha512-fresh', shasum: 'fresh' };
  const stale = {
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { dist: { integrity: 'old', shasum: 'old' } } },
  };
  const fresh = {
    'dist-tags': { latest: '1.0.1' },
    versions: { ...stale.versions, '1.0.1': { dist: freshDist } },
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(url);
    const bypassesCache =
      new URL(url).searchParams.get('write') === 'true' &&
      init?.cache === 'no-store' &&
      init?.headers?.['cache-control'] === 'no-cache';
    return { ok: true, json: async () => (bypassesCache ? fresh : stale) };
  };
  assert.deepEqual(
    await lookupRegistryPackageDist(pkg, '1.0.1', { fetchImpl }),
    freshDist,
  );
  assert.equal(
    await lookupRegistryDistTag(pkg, 'latest', { fetchImpl }),
    '1.0.1',
  );
  assert.deepEqual(requests, [
    `https://registry.npmjs.org/${encodeURIComponent(pkg)}?write=true`,
    `https://registry.npmjs.org/${encodeURIComponent(pkg)}?write=true`,
  ]);

  const absent = { fetchImpl: async () => ({ ok: false, status: 404 }) };
  assert.equal(await lookupRegistryPackageDist(pkg, '1.0.1', absent), null);
  assert.equal(await lookupRegistryDistTag(pkg, 'latest', absent), undefined);
  assert.equal(
    await lookupRegistryPackageDist(pkg, '9.9.9', { fetchImpl }),
    null,
    'an absent version of a present package is not published yet',
  );
});

test('registry reads retry a network reset that undici reports only on the cause', async () => {
  const { lookupRegistryPackageDist } = await import(
    '../lib/prepare-bleedingdev-packages/registry-read.mjs'
  );
  const dist = { integrity: 'sha512-fresh', shasum: 'fresh' };
  let requests = 0;
  const delays = [];
  const found = await lookupRegistryPackageDist(
    '@bleedingdev/modern-js-runtime',
    '1.0.1',
    {
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('read ECONNRESET'), {
              code: 'ECONNRESET',
            }),
          });
        }
        return {
          ok: true,
          json: async () => ({
            'dist-tags': { latest: '1.0.1' },
            versions: { '1.0.1': { dist } },
          }),
        };
      },
      wait: async delay => {
        delays.push(delay);
      },
    },
  );
  assert.deepEqual(found, dist);
  assert.equal(requests, 2);
  assert.deepEqual(delays, [1000]);
});
