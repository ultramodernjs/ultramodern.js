import { getRequestEvent, httpHeader, httpStatus, ssr } from '@solidjs/web';
import {
  createComponent,
  createMemo,
  createRoot,
  Loading,
  onCleanup,
} from 'solid-js';
import { createRequestSession } from '../../../renderer-core/src/session/request';
import type {
  DocumentCachePolicy,
  ResponseHeaders,
} from '../../../renderer-core/src/session/types';
import {
  renderApplication,
  renderCSRDocument,
  respondApplicationResponse,
  runApplicationRequest,
} from '../../src/server';

const sampledTraceparent =
  '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';

function sessionFor(
  input: {
    status?: number;
    headers?: ResponseHeaders;
    cache?: DocumentCachePolicy;
    requestHeaders?: HeadersInit;
  } = {},
) {
  const session = createRequestSession({
    request: new Request('https://metadata.test/', {
      headers: input.requestHeaders,
    }),
    identity: {
      renderer: 'solid',
      appId: 'metadata',
      entryName: 'main',
      protocolVersion: 1,
      buildId: 'native',
    },
    platform: { kind: 'node', bindings: {} },
  });
  session.resolveResponse({
    kind: 'document',
    status: input.status ?? 200,
    headers: [
      ['content-type', 'text/html; charset=utf-8'],
      ...(input.headers ?? []),
    ],
    cache: input.cache ?? { mode: 'public', maxAgeSeconds: 60 },
  });
  return session;
}

function nativeStub() {
  const event = getRequestEvent();
  if (!event) throw new Error('Expected the real native request event.');
  return Object.getOwnPropertyDescriptor(event, 'response')!.value;
}

describe('native Solid response metadata before session commit', () => {
  test('an undeclared native status preserves the prepared route 404', async () => {
    const session = sessionFor({ status: 404 });
    const response = await renderApplication({
      session,
      view: () => {
        httpHeader('x-native', 'present');
        return ssr('<p>missing</p>');
      },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-native')).toBe('present');
    expect(session.committedPolicy?.status).toBe(404);
    await response.text();
    expect((await session.completion).cacheEligible).toBe(false);
  });

  test('explicit native status and ordinary headers win before cleanup and commit', async () => {
    const session = sessionFor({
      headers: [['x-owner', 'prepared']],
      requestHeaders: { traceparent: sampledTraceparent },
    });
    let cleanup = 0;
    let stub: ReturnType<typeof nativeStub>;
    const response = await renderApplication({
      session,
      view: () => {
        stub = nativeStub();
        httpStatus(422);
        httpHeader('x-owner', 'native');
        onCleanup(() => cleanup++);
        return ssr('<p>invalid</p>');
      },
    });
    expect(response.status).toBe(422);
    expect(response.headers.get('x-owner')).toBe('native');
    expect(response.headers.get('server-timing')).toContain(
      'traceparent;desc="00-0123456789abcdef0123456789abcdef-',
    );
    expect(stub.headers.get).toBe(Headers.prototype.get);
    expect(stub.committed).toBe(true);
    expect(session.committedPolicy?.cache.mode).toBe('no-store');
    await response.text();
    expect(cleanup).toBe(1);
    expect(stub.status).toBe(422);
    expect(stub.headers.get('x-owner')).toBe('native');
  });

  test('appends each native cookie after the prepared cookie without comma folding', async () => {
    const first = 'first=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/';
    const session = sessionFor({ headers: [['set-cookie', first]] });
    const response = await renderApplication({
      session,
      view: () => {
        httpHeader('set-cookie', 'second=2; Path=/', { append: true });
        httpHeader('set-cookie', 'third=3; HttpOnly; Path=/', { append: true });
        return ssr('<p>cookies</p>');
      },
    });
    expect(response.headers.getSetCookie()).toEqual([
      first,
      'second=2; Path=/',
      'third=3; HttpOnly; Path=/',
    ]);
    expect(
      session.committedPolicy?.headers.filter(
        ([name]) => name === 'set-cookie',
      ),
    ).toHaveLength(3);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await response.text();
    expect((await session.completion).cacheEligible).toBe(false);
  });

  test('keeps loader and component Content-Security-Policy fields', async () => {
    const session = sessionFor({
      headers: [
        ['content-security-policy', "default-src 'self'"],
        ['content-security-policy-report-only', "img-src 'self'"],
        ['link', '<https://cdn.test>; rel=preconnect'],
      ],
    });
    const response = await renderApplication({
      session,
      view: () => {
        httpHeader('content-security-policy', "script-src 'self'");
        httpHeader('content-security-policy-report-only', "style-src 'self'");
        httpHeader('link', '</c.css>; rel=preload; as=style');
        return ssr('<p>csp</p>');
      },
    });
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self', script-src 'self'",
    );
    expect(response.headers.get('content-security-policy-report-only')).toBe(
      "img-src 'self', style-src 'self'",
    );
    expect(response.headers.get('link')).toBe(
      '<https://cdn.test>; rel=preconnect, </c.css>; rel=preload; as=style',
    );
    await response.text();
  });

  test('keeps original and native Vary dimensions when native declarations overwrite', async () => {
    const session = sessionFor({ headers: [['vary', 'Accept-Encoding']] });
    const response = await renderApplication({
      session,
      view: () => {
        httpHeader('vary', 'Accept-Language');
        return ssr('<p>vary</p>');
      },
    });
    expect(response.headers.get('vary')).toBe(
      'Accept-Encoding, Accept-Language',
    );
    await response.text();
  });

  test.each([
    {
      original: 'no-store',
      native: 'public, max-age=900',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'no-store',
      mode: 'no-store',
    },
    {
      original: 'no-cache',
      native: 'public, max-age=900',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'no-store',
      mode: 'no-store',
    },
    {
      original: 'private',
      native: 'public, max-age=900',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'private, max-age=0, must-revalidate',
      mode: 'private',
    },
    {
      original: 'public, max-age=12',
      native: 'public, max-age=900',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'public, max-age=12, s-maxage=12, must-revalidate',
      mode: 'public',
    },
    {
      original: 'public, max-age=900',
      native: 'public, max-age=9, s-maxage=4',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'public, max-age=4, s-maxage=4, must-revalidate',
      mode: 'public',
    },
    {
      original: 'public, max-age=900',
      native: 'public, max-age=900',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'public, max-age=60, s-maxage=60, must-revalidate',
      mode: 'public',
    },
    {
      original: 'public, max-age=-1',
      native: 'public, max-age=900',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'no-store',
      mode: 'no-store',
    },
    {
      original: 'public, max-age=1, max-age=2',
      native: 'public, max-age=900',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'no-store',
      mode: 'no-store',
    },
    {
      original: 'public, max-age=900',
      native: 'public, s-maxage=invalid',
      cache: { mode: 'public' as const, maxAgeSeconds: 60 },
      expected: 'no-store',
      mode: 'no-store',
    },
    {
      original: 'public, max-age=900',
      native: 'public, max-age=900',
      cache: { mode: 'no-store' as const },
      expected: 'no-store',
      mode: 'no-store',
    },
    {
      original: 'public, max-age=900',
      native: 'public, max-age=900',
      cache: { mode: 'private' as const },
      expected: 'private, max-age=0, must-revalidate',
      mode: 'private',
    },
  ])(
    'intersects original policy and both Cache-Control declarations: $original / $native / $mode',
    async input => {
      const session = sessionFor({
        headers: [['cache-control', input.original]],
        cache: input.cache,
      });
      const response = await renderApplication({
        session,
        view: () => {
          httpHeader('cache-control', input.native);
          return ssr('<p>cache</p>');
        },
      });
      expect(response.headers.get('cache-control')).toBe(input.expected);
      expect(session.committedPolicy?.cache.mode).toBe(input.mode);
      await response.text();
      expect((await session.completion).cacheEligible).toBe(
        input.mode === 'public',
      );
    },
  );

  test('a prior Vary star and non-HTML representation cannot be upgraded by native headers', async () => {
    const session = sessionFor({
      headers: [
        ['vary', '*'],
        ['content-type', 'application/json'],
      ],
    });
    const response = await renderApplication({
      session,
      view: () => {
        httpHeader('vary', 'Accept');
        httpHeader('content-type', 'text/html');
        return ssr('<p>private</p>');
      },
    });
    expect(response.headers.get('vary')).toBe('*, Accept');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await response.text();
    expect((await session.completion).cacheEligible).toBe(false);
  });

  test('terminal data status, Location, and protocol headers stay authoritative', async () => {
    const session = sessionFor();
    const response = await runApplicationRequest(session, () =>
      createRoot(dispose => {
        session.registerCleanup(dispose);
        httpStatus(503, 'Native server failure');
        httpHeader('location', '/native');
        httpHeader('content-type', 'text/html');
        httpHeader('x-server-function-format', 'native-format');
        httpHeader('x-native', 'gap');
        httpHeader('set-cookie', 'native=1; Path=/', { append: true });
        return respondApplicationResponse(
          session,
          new Response('public-data', {
            status: 409,
            statusText: 'Public conflict',
            headers: {
              location: '/data',
              'content-type': 'application/json',
              'x-server-function-format': 'data-format',
            },
          }),
        );
      }),
    );
    expect(response.status).toBe(409);
    expect(response.statusText).toBe('Public conflict');
    expect(session.committedPolicy?.statusText).toBe('Public conflict');
    expect(response.headers.get('location')).toBe('/data');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-server-function-format')).toBe(
      'data-format',
    );
    expect(response.headers.get('x-native')).toBe('gap');
    expect(response.headers.getSetCookie()).toEqual(['native=1; Path=/']);
    expect(session.ownsResponseBody(response)).toBe(true);
    expect(await response.text()).toBe('public-data');
  });

  test('a bodyless terminal outcome excludes native representation and redirect gaps', async () => {
    const session = sessionFor();
    const response = await runApplicationRequest(session, () =>
      createRoot(dispose => {
        session.registerCleanup(dispose);
        httpHeader('content-type', 'text/html');
        httpHeader('content-length', '100');
        httpHeader('location', '/late');
        httpHeader('x-server-function-error', 'native');
        httpHeader('x-native', 'present');
        return respondApplicationResponse(
          session,
          new Response(null, { status: 204 }),
        );
      }),
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    for (const name of [
      'content-type',
      'content-length',
      'location',
      'x-server-function-error',
    ])
      expect(response.headers.has(name)).toBe(false);
    expect(response.headers.get('x-native')).toBe('present');
    expect((await session.completion).state).toBe('completed');
  });

  test.each([204, 205, 304])(
    'native HTTP %i abandons pending SSR without starting a document transport',
    async status => {
      const session = sessionFor();
      let resolve!: (value: string) => void;
      const future = new Promise<string>(accept => {
        resolve = accept;
      });
      let cleanup = 0;
      const response = await renderApplication({
        session,
        view: () => {
          httpStatus(status);
          onCleanup(() => cleanup++);
          const value = createMemo(async () => future);
          return createComponent(Loading, {
            fallback: ssr('<p>pending</p>'),
            get children() {
              return ssr(['<p>', '</p>'], () => value());
            },
          });
        },
      });
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(session.committedPolicy?.kind).toBe('terminal');
      expect((await session.completion).state).toBe('completed');
      expect(cleanup).toBe(1);
      resolve('late');
      await future;
      await Promise.resolve();
      expect(cleanup).toBe(1);
      expect(session.state).toBe('completed');
    },
  );

  test('native precommit Location produces a real redirect and disposes once', async () => {
    const session = sessionFor();
    let cleanup = 0;
    const response = await renderApplication({
      session,
      view: () => {
        httpStatus(307);
        httpHeader('location', '/native-target');
        onCleanup(() => cleanup++);
        return ssr('<p>must not send</p>');
      },
    });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/native-target');
    expect(response.body).toBeNull();
    expect(response.headers.get('content-type')).toBeNull();
    expect((await session.completion).cacheEligible).toBe(false);
    expect(cleanup).toBe(1);
  });

  test('CSR folds native metadata on the same request event before its static body', async () => {
    const session = sessionFor();
    const response = await runApplicationRequest(session, () =>
      createRoot(dispose => {
        session.registerCleanup(dispose);
        httpStatus(201);
        httpHeader('x-csr', 'native');
        return renderCSRDocument({ session });
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('x-csr')).toBe('native');
    const html = await response.text();
    const bootstrap =
      /<script[^>]*id="__ULTRAMODERN_RENDERER__"[^>]*>(.*?)<\/script>/su.exec(
        html,
      )![1];
    expect(JSON.parse(bootstrap)).toMatchObject({ hydrating: false });
    expect((await session.completion).cacheEligible).toBe(false);
  });

  test.each(['status', 'statusText', 'headers', 'committed'])(
    'rejects a rewritten native %s accessor without invoking it',
    async field => {
      const session = sessionFor();
      let getterCalls = 0;
      await expect(
        renderApplication({
          session,
          view: () => {
            Object.defineProperty(nativeStub(), field, {
              get() {
                getterCalls++;
                return 'private';
              },
            });
            return ssr('<p>public</p>');
          },
        }),
      ).rejects.toThrow(`Cannot redefine property: ${field}`);
      expect(getterCalls).toBe(0);
      expect(session.committedPolicy).toBeUndefined();
      expect((await session.completion).state).toBe('failed');
    },
  );

  test.each(['status', 'statusText', 'headers', 'committed'])(
    'rejects a native %s accessor substituted after an awaited shell resource without invoking it',
    async field => {
      const session = sessionFor();
      let getterCalls = 0;
      let cleanup = 0;
      await expect(
        renderApplication({
          session,
          view: () => {
            onCleanup(() => cleanup++);
            const value = createMemo(async () => {
              await Promise.resolve();
              Object.defineProperty(nativeStub(), field, {
                get() {
                  getterCalls++;
                  return 'private';
                },
              });
              return 'public';
            });
            return ssr(['<p>', '</p>'], () => value());
          },
        }),
      ).rejects.toThrow(`Cannot redefine property: ${field}`);
      expect(getterCalls).toBe(0);
      expect(session.committedPolicy).toBeUndefined();
      expect((await session.completion).state).toBe('failed');
      expect(cleanup).toBe(1);
    },
  );

  test('rejects a replacement native Headers object and overridden cookie getter before reading', async () => {
    const first = sessionFor();
    await expect(
      renderApplication({
        session: first,
        view: () => {
          nativeStub().headers = new Headers();
          return ssr('public');
        },
      }),
    ).rejects.toThrow(TypeError);
    expect((await first.completion).state).toBe('failed');
    const second = sessionFor();
    let calls = 0;
    await expect(
      renderApplication({
        session: second,
        view: () => {
          Object.defineProperty(nativeStub().headers, 'getSetCookie', {
            get() {
              calls++;
              return () => ['private'];
            },
          });
          return ssr('public');
        },
      }),
    ).rejects.toThrow('Headers methods cannot be replaced');
    expect(calls).toBe(0);
    expect(second.committedPolicy).toBeUndefined();
    expect((await second.completion).state).toBe('failed');
  });

  test.each([
    'response accessor',
    'replacement response',
    'replacement Headers',
    'Headers.get accessor',
  ])(
    'rejects %s before native sampled-trace reads, including after an awaited shell resource',
    async target => {
      for (const awaited of [false, true]) {
        const session = sessionFor({
          requestHeaders: {
            traceparent: sampledTraceparent,
          },
        });
        let calls = 0;
        let cleanup = 0;
        const substitute = () => {
          const event = getRequestEvent();
          if (!event) throw new Error('Expected the native request event.');
          const stub = nativeStub();
          const getter = () => {
            calls++;
            return Headers.prototype.get;
          };
          switch (target) {
            case 'response accessor':
              Object.defineProperty(event, 'response', {
                get() {
                  calls++;
                  return stub;
                },
              });
              break;
            case 'replacement response':
              event.response = Object.defineProperty({ ...stub }, 'headers', {
                get() {
                  calls++;
                  return stub.headers;
                },
              });
              break;
            case 'replacement Headers':
              stub.headers = Object.defineProperty(new Headers(), 'get', {
                get: getter,
              });
              break;
            case 'Headers.get accessor':
              Object.defineProperty(stub.headers, 'get', { get: getter });
              break;
            default:
              throw new Error(`Unknown metadata substitution: ${target}`);
          }
          return 'public';
        };
        await expect(
          renderApplication({
            session,
            view: () => {
              onCleanup(() => cleanup++);
              if (!awaited) return ssr(substitute());
              const value = createMemo(async () => {
                await Promise.resolve();
                return substitute();
              });
              return ssr(['<p>', '</p>'], () => value());
            },
          }),
        ).rejects.toThrow(TypeError);
        expect(calls).toBe(0);
        expect(session.committedPolicy).toBeUndefined();
        expect((await session.completion).state).toBe('failed');
        expect(cleanup).toBe(1);
      }
    },
  );

  test('native statusText reaches the frozen policy and owning response', async () => {
    const session = sessionFor();
    const response = await renderApplication({
      session,
      view: () => {
        httpStatus(422, 'Native invalid');
        return ssr('invalid');
      },
    });
    expect(response.statusText).toBe('Native invalid');
    expect(session.committedPolicy?.statusText).toBe('Native invalid');
    expect(await response.text()).toBe('invalid');
  });

  test('malformed native statusText fails before claiming the document stream', async () => {
    const session = sessionFor();
    await expect(
      renderApplication({
        session,
        view: () => {
          httpStatus(422, 'Invalid\r\nstatus');
          return ssr('invalid');
        },
      }),
    ).rejects.toThrow();
    expect(session.committedPolicy).toBeUndefined();
    expect((await session.completion).state).toBe('failed');
  });

  test('status and cookies set after an awaited shell resource commit with the shell', async () => {
    const session = sessionFor();
    const response = await renderApplication({
      session,
      view: () => {
        const value = createMemo(async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          httpStatus(404);
          httpHeader('set-cookie', 'late=1; Path=/', { append: true });
          return 'missing';
        });
        return ssr(['<p>', '</p>'], () => value());
      },
    });
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual(['late=1; Path=/']);
    expect(session.committedPolicy?.status).toBe(404);
    expect(await response.text()).toContain('missing');
    expect((await session.completion).state).toBe('completed');
  });

  test('a redirect declared after an awaited shell resource is delivered bodyless', async () => {
    const session = sessionFor();
    let cleanup = 0;
    const response = await renderApplication({
      session,
      view: () => {
        onCleanup(() => cleanup++);
        const value = createMemo(async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          httpStatus(303);
          httpHeader('location', '/login');
          return 'redirecting';
        });
        return ssr(['<p>', '</p>'], () => value());
      },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
    expect(response.body).toBeNull();
    expect(session.committedPolicy?.kind).toBe('terminal');
    expect((await session.completion).state).toBe('completed');
    expect(cleanup).toBe(1);
  });

  test('late native Headers writes report and cannot change the delivered response', async () => {
    const session = sessionFor();
    let stub: ReturnType<typeof nativeStub>;
    const response = await renderApplication({
      session,
      view: () => {
        stub = nativeStub();
        httpHeader('x-before', 'present');
        return ssr('public');
      },
    });
    const original = console.error;
    const reports: unknown[][] = [];
    const spy = rstest.spyOn(console, 'error').mockImplementation((...args) => {
      reports.push(args);
      original(...args);
    });
    try {
      try {
        stub.headers.set('x-after', 'forbidden');
      } catch (error) {
        expect(String(error)).toContain('LATE_HEADER_WRITE');
      }
      expect(reports.flat().join(' ')).toContain('LATE_HEADER_WRITE');
      expect(stub.headers.has('x-after')).toBe(false);
      expect(response.headers.has('x-after')).toBe(false);
      expect(
        session.committedPolicy?.headers.some(([name]) => name === 'x-after'),
      ).toBe(false);
      await response.text();
    } finally {
      spy.mockRestore();
    }
  });
});
