import { afterEach, describe, expect, it } from '@rstest/core';
import { createDataClient } from '../../src/data/client';
import {
  createDataResponse,
  deferData,
  normalizeDataResult,
} from '../../src/data/server';
import {
  encodeStaticDataPayload,
  PRERENDERED_DOCUMENT_META,
  STATIC_DATA_PAYLOAD_MAX_BYTES,
  type StaticDataPayload,
  staticDataPayloadPath,
} from '../../src/data/static';
import {
  DATA_CONTENT_TYPE,
  DATA_STREAM_CONTENT_TYPE,
} from '../../src/data/types';
import type { RendererIdentity } from '../../src/identity';

const identity: RendererIdentity = {
  renderer: 'solid',
  appId: 'app',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'build-1',
};

function prerenderedDocument(prerendered: boolean) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        prerendered && selector === `meta[name="${PRERENDERED_DOCUMENT_META}"]`
          ? {}
          : null,
    },
  });
}

async function payloadFor(value: unknown): Promise<StaticDataPayload> {
  const response = createDataResponse(
    await normalizeDataResult(value),
    identity,
    { routeId: 'products/(id)/page', operation: 'loader' },
  );
  return {
    status: response.status,
    contentType: DATA_CONTENT_TYPE,
    body: await response.text(),
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

describe('static loader payloads', () => {
  it('maps a document path and route ID to a filesystem-safe payload URL', () => {
    expect(staticDataPayloadPath('/', 'page')).toBe(
      '/__ultramodern-data/cGFnZQ.json',
    );
    expect(staticDataPayloadPath('/items/42', 'items/(id)/page')).toBe(
      '/items/42/__ultramodern-data/aXRlbXMvKGlkKS9wYWdl.json',
    );
    expect(staticDataPayloadPath('/items/42/', 'items/(id)/page')).toBe(
      '/items/42/__ultramodern-data/aXRlbXMvKGlkKS9wYWdl.json',
    );
  });

  it('replays a prerendered payload without a server data request', async () => {
    prerenderedDocument(true);
    const payload = await payloadFor({ name: 'tractor' });
    const requested: string[] = [];
    const client = createDataClient('products/(id)/page', identity, {
      fetch: (async (input: Request | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        requested.push(url);
        return Response.json(payload);
      }) as typeof fetch,
    });
    const outcome = await client.loader({
      request: new Request('https://example.test/products/7'),
    });
    expect(outcome).toMatchObject({
      kind: 'success',
      value: { name: 'tractor' },
    });
    expect(requested).toEqual([
      `https://example.test${staticDataPayloadPath('/products/7', 'products/(id)/page')}`,
    ]);
  });

  it('stores only deferred payloads the client can replay, however many frames they have', async () => {
    prerenderedDocument(true);
    const deferredPayload = async (frames: number) => {
      const chunk = 'x'.repeat(700 * 1024);
      const response = createDataResponse(
        await normalizeDataResult(
          deferData(
            { critical: true },
            Object.fromEntries(
              Array.from({ length: frames }, (_, index) => [
                `part${index}`,
                Promise.resolve(chunk),
              ]),
            ),
          ),
        ),
        identity,
        { routeId: 'products/(id)/page', operation: 'loader' },
      );
      return {
        status: response.status,
        contentType: DATA_STREAM_CONTENT_TYPE,
        body: await response.text(),
      } satisfies StaticDataPayload;
    };
    // Each frame is within the per-frame limit; together they are not.
    const oversized = await deferredPayload(10);
    expect(oversized.body.length).toBeGreaterThan(
      STATIC_DATA_PAYLOAD_MAX_BYTES,
    );
    expect(() => encodeStaticDataPayload(oversized)).toThrow(
      /exceeds the \d+ bytes the data client replays/,
    );
    const fitting = encodeStaticDataPayload(await deferredPayload(3));
    const client = createDataClient('products/(id)/page', identity, {
      fetch: (async () =>
        new Response(fitting, {
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    const outcome = await client.loader({
      request: new Request('https://example.test/products/7'),
    });
    const value = (outcome as { value: Record<string, unknown> }).value;
    expect(value.critical).toBe(true);
    expect(await value.part2).toHaveLength(700 * 1024);
  });

  it('stops waiting for a static payload fetch that ignores the aborted loader', async () => {
    prerenderedDocument(true);
    const controller = new AbortController();
    let fetching!: () => void;
    const started = new Promise<void>(resolve => {
      fetching = resolve;
    });
    const client = createDataClient('products/(id)/page', identity, {
      fetch: (() => {
        fetching();
        return new Promise<never>(() => {});
      }) as typeof fetch,
    });
    const loading = client.loader({
      request: new Request('https://example.test/products/7', {
        signal: controller.signal,
      }),
    });
    await started;
    controller.abort(new Error('superseded'));
    await expect(loading).rejects.toThrow('superseded');
  });

  it('cancels a pending static payload body when the loader aborts', async () => {
    prerenderedDocument(true);
    const controller = new AbortController();
    let cancelled: unknown;
    let reading!: () => void;
    const bodyReadStarted = new Promise<void>(resolve => {
      reading = resolve;
    });
    const requested: string[] = [];
    const client = createDataClient('products/(id)/page', identity, {
      fetch: (async (input: Request | URL) => {
        requested.push(String(input instanceof Request ? input.url : input));
        // A body that is not coupled to the request signal.
        return new Response(
          new ReadableStream(
            {
              start(source) {
                source.enqueue(new TextEncoder().encode('{"status":'));
              },
              pull() {
                reading();
              },
              cancel(reason) {
                cancelled = reason;
              },
            },
            // Do not prefetch. Pull marks the pending read after the first chunk.
            { highWaterMark: 0 },
          ),
        );
      }) as typeof fetch,
    });
    const loading = client.loader({
      request: new Request('https://example.test/products/7', {
        signal: controller.signal,
      }),
    });
    await bodyReadStarted;
    const reason = new Error('superseded');
    controller.abort(reason);
    await expect(loading).rejects.toThrow('superseded');
    expect(cancelled).toBe(reason);
    // An aborted read never falls back to a server data request.
    expect(requested).toHaveLength(1);
  });

  it('falls back to the server request when a payload is missing or the document is live', async () => {
    const payload = await payloadFor({ name: 'live' });
    for (const prerendered of [true, false]) {
      prerenderedDocument(prerendered);
      const requested: string[] = [];
      const client = createDataClient('products/(id)/page', identity, {
        fetch: (async (input: Request | URL) => {
          const url = new URL(
            String(input instanceof Request ? input.url : input),
          );
          requested.push(url.pathname + url.search);
          if (url.pathname.includes('__ultramodern-data'))
            return new Response('missing', { status: 404 });
          return new Response(payload.body, {
            headers: { 'content-type': payload.contentType },
          });
        }) as typeof fetch,
      });
      const outcome = await client.loader({
        request: new Request('https://example.test/products/7'),
      });
      expect(outcome).toMatchObject({
        kind: 'success',
        value: { name: 'live' },
      });
      expect(requested.at(-1)).toBe(
        '/products/7?__loader=products%2F%28id%29%2Fpage&__ssrDirect=true',
      );
      expect(requested.length).toBe(prerendered ? 2 : 1);
    }
  });

  it('never replays a search-dependent loader from static output', async () => {
    prerenderedDocument(true);
    const payload = await payloadFor({ name: 'search' });
    const requested: string[] = [];
    const client = createDataClient('products/(id)/page', identity, {
      fetch: (async (input: Request | URL) => {
        requested.push(String(input instanceof Request ? input.url : input));
        return new Response(payload.body, {
          headers: { 'content-type': payload.contentType },
        });
      }) as typeof fetch,
    });
    await client.loader({
      request: new Request('https://example.test/products/7?sort=asc'),
    });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('__loader=');
  });
});
