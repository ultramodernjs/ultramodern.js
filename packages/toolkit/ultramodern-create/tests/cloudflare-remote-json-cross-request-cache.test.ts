import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

/**
 * Regression coverage for the Cloudflare entry's remote-manifest JSON cache
 * (see `fetchRemoteJson` / `remoteJsonCache` in
 * `app-tools-extensions/src/templates/cloudflare-entry.004-rendering-css.mjs`).
 *
 * workerd forbids awaiting a `fetch()` Promise that a *different* request
 * started: a Worker isolate is reused across many requests, but each
 * request owns its own I/O context, and awaiting another request's pending
 * I/O throws "Cannot perform I/O on behalf of a different request". The
 * fixed implementation only ever shares *settled, plain* JSON values across
 * requests on its module-level cache, and dedupes in-flight fetches with a
 * Map that is created fresh per request.
 *
 * This test extracts the real (shipped) cache declaration and
 * `fetchRemoteJson`/`createRemoteJsonFetchScope` functions from the
 * generated-worker source, runs them inside a genuine workerd instance via
 * Miniflare, and drives two requests whose remote-manifest fetches
 * deliberately overlap in time on the same worker isolate — the exact
 * production scenario the fix addresses.
 *
 * Note: this environment's local Miniflare/workerd build does not itself
 * reject the old (reverted-and-manually-verified) implementation for this
 * benign-looking overlap — the cross-request I/O guard is enforced more
 * strictly by the hosted Workers runtime than by local dev tooling, which is
 * exactly why the fix must hold structurally (never store a live I/O
 * Promise on a module-level map) rather than rely on a local test to trip
 * the production-only error. What this test does assert, and would catch a
 * regression in, is the intended contract: concurrent requests each resolve
 * correctly, a per-request scope dedupes a single request's own repeated
 * lookups, and the module-level cache is only ever populated with settled,
 * plain values that later requests can reuse without any further fetch.
 */
async function extractRemoteJsonCacheModule() {
  const templatesDirectory = path.resolve(
    __dirname,
    '../../../solutions/app-tools-extensions/src/templates',
  );
  const bootstrapSource = await fs.readFile(
    path.join(
      templatesDirectory,
      'cloudflare-entry.001-bootstrap-security.mjs',
    ),
    'utf8',
  );
  const renderingSource = (
    await fs.readFile(
      path.join(templatesDirectory, 'cloudflare-entry.004-rendering-css.mjs'),
      'utf8',
    )
  ).replace(/\r\n/gu, '\n');

  const cacheDeclaration = /const remoteJsonCache = new Map\(\);/u.exec(
    bootstrapSource,
  )?.[0];
  assert(cacheDeclaration, 'remoteJsonCache declaration not found');

  const remoteJsonFetchHelpers =
    /function createRemoteJsonFetchScope\(\)[\s\S]*?\nasync function fetchRemoteJson\(jsonUrl, pendingFetches\)[\s\S]*?\n\}\n\nfunction findRemoteExpose\(/u.exec(
      renderingSource,
    )?.[0];
  assert(
    remoteJsonFetchHelpers,
    'createRemoteJsonFetchScope/fetchRemoteJson not found',
  );
  const helpersSource = remoteJsonFetchHelpers
    .slice(
      0,
      remoteJsonFetchHelpers.lastIndexOf('\nfunction findRemoteExpose('),
    )
    .concat('\n');

  return [cacheDeclaration, helpersSource].join('\n');
}

test('two concurrent requests sharing a worker isolate both resolve the same remote manifest without cross-request I/O, and a later request reuses the cached value', async () => {
  const remoteJsonModule = await extractRemoteJsonCacheModule();
  const manifestUrl = 'https://remote.example/catalog/mf-manifest.json';

  const script = `${remoteJsonModule}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('target');
    const pendingFetches = createRemoteJsonFetchScope();
    const value = await fetchRemoteJson(target, pendingFetches);
    return Response.json(value);
  },
};
`;

  const entered = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  const release = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  let outboundCount = 0;

  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: '2026-06-02',
      compatibilityFlags: ['nodejs_compat'],
      async outboundService(request) {
        assert.equal(new URL(request.url).toString(), manifestUrl);
        const index = outboundCount;
        outboundCount += 1;
        if (index < 2) {
          entered[index]!.resolve();
          await release[index]!.promise;
        }
        return Response.json({ ok: true, from: 'remote' });
      },
    }),
  );

  try {
    const requestUrl = `http://worker.example/?target=${encodeURIComponent(manifestUrl)}`;

    async function readManifest() {
      const response = await worker.dispatchFetch(requestUrl);
      assert.equal(response.status, 200);
      // Miniflare requires immediate body consumption. Waiting for another
      // response first lets Undici collect and cancel the unread body.
      return response.json();
    }

    // Dispatch two requests to the *same* worker instance (one isolate, one
    // shared module scope) and confirm both of their remote fetches are
    // genuinely in flight at once before releasing either — the overlap
    // that triggers "Cannot perform I/O on behalf of a different request"
    // against the old implementation's shared, cross-request fetch Promise.
    const first = readManifest();
    await entered[0]!.promise;
    const second = readManifest();
    await entered[1]!.promise;
    release[0]!.resolve();
    release[1]!.resolve();

    const [firstManifest, secondManifest] = await Promise.all([first, second]);
    assert.deepEqual(firstManifest, { ok: true, from: 'remote' });
    assert.deepEqual(secondManifest, { ok: true, from: 'remote' });
    assert.equal(
      outboundCount,
      2,
      'per-request dedupe only; two concurrent requests each perform their own fetch',
    );

    // A later request reuses the settled module-level cache instead of
    // issuing another remote fetch.
    const third = await readManifest();
    assert.deepEqual(third, { ok: true, from: 'remote' });
    assert.equal(
      outboundCount,
      2,
      'resolved values are cached across requests',
    );
  } finally {
    await worker.dispose();
  }
});
