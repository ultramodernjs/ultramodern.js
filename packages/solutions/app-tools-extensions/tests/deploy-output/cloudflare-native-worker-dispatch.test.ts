import fs from 'node:fs/promises';
import path from 'node:path';
import { dispatchNativeWorkerRequest } from '../../../../runtime/renderer-core/src/server/worker';

type Renderer = 'react' | 'solid' | 'octane';
type WorkerModule = Record<string, unknown>;
type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};
type Worker = {
  fetch(
    request: Request,
    env?: Record<string, unknown>,
    ctx?: ExecutionContext,
  ): Promise<Response>;
};

const route = {
  urlPath: '/',
  entryName: 'main',
  entryPath: 'html/main/index.html',
  isSSR: true,
  worker: 'worker/main.js',
  workerExists: true,
};
const identity = (renderer: Renderer) => ({
  renderer,
  appId: 'native-worker-fixture',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'fixture-build',
});
const nativeResources = (renderer: Renderer) => ({
  schema: 'ultramodern-native-worker-resources',
  version: 1,
  renderer,
  entries: {
    main: {
      assets: [{ kind: 'script', href: '/static/js/main.js' }],
      nativeManifest: { compiler: 'fixture' },
      serverConfig: { ssr: 'stream' },
    },
  },
});

let templateSource: string;
beforeAll(async () => {
  const directory = path.resolve(__dirname, '../../src/templates');
  const filenames = (await fs.readdir(directory))
    .filter(filename => /^cloudflare-entry\.\d{3}-.*\.mjs$/.test(filename))
    .sort();
  templateSource = (
    await Promise.all(
      filenames.map(filename =>
        fs.readFile(path.join(directory, filename), 'utf8'),
      ),
    )
  ).join('\n');
});

function emittedWorker(
  manifest: Record<string, unknown>,
  loaders: Record<string, () => Promise<WorkerModule>>,
): Worker {
  const source = templateSource
    .replace('export const modernWorkerManifest', 'const modernWorkerManifest')
    .replace('export default {', 'const worker = {');
  return new Function(
    'p_workerManifest',
    'p_workerModuleLoaders',
    `${source}\nreturn worker;`,
  )(
    {
      routeSpec: { routes: [route] },
      resources: {
        routeManifest: 'routes-manifest.json',
        loadableStats: 'loadable-stats.json',
      },
      // A native build's manifest names its native-document renderer.
      renderer: {
        name: Object.values(
          manifest.rendererIdentities as Record<string, { renderer: string }>,
        )[0].renderer,
        nativeDocuments: true,
        rsc: false,
      },
      ...manifest,
    },
    loaders,
  ) as Worker;
}

function assetBinding(served: string[] = []) {
  return {
    async fetch(request: Request) {
      const pathname = new URL(request.url).pathname;
      served.push(pathname);
      return new Response(
        pathname.endsWith('.json') ? '{}' : `asset:${pathname}`,
        { headers: { 'content-type': 'text/plain' } },
      );
    },
  };
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    context: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    },
  };
}

/** A native bundle: the same handler the Node host loads, plus the dispatcher. */
function nativeBundle(
  renderer: Renderer,
  handler: (request: Request, context: any) => Response | Promise<Response>,
) {
  return {
    rendererIdentity: identity(renderer),
    nativeRequestHandler: handler,
    nativeCSRRequestHandler: handler,
    dispatchNativeWorkerRequest,
  };
}

it('passes build-level Worker federation authority and services with the selected document resources', async () => {
  const renderer = 'octane';
  const staleManifestUrl = 'https://stale-entry.invalid/mf-manifest.json';
  const entry = {
    ...nativeResources(renderer).entries.main,
    // Build-level routing authority must override a stale per-entry carrier.
    workerFederationManifestUrl: staleManifestUrl,
  };
  const fragment = {
    expose: './Widget',
    boundaryId: 'remote-a-widget',
    paths: { en: '/_mf/widget/en' },
  };
  const federationResources = {
    workerFederation: {
      renderer: {
        schema: 'ultramodern.renderer-federation',
        schemaVersion: 1,
        profile: {
          renderer,
          protocolVersion: 1,
          compiler: { name: '@octanejs/rspack-plugin', version: '0.2.4' },
          hydration: { name: 'octane', version: '0.13.8' },
          router: { name: '@octanejs/tanstack-router', version: '0.2.10' },
        },
        runtime: { name: 'octane', version: '0.13.8' },
        bootstrap: { name: '@modern-js/renderer-octane', version: '3.8.3' },
        identities: { main: identity(renderer) },
      },
      worker: {
        schema: 'ultramodern.worker-federation',
        schemaVersion: 1,
        remote: 'native-worker-fixture',
        exposes: {
          './Widget': {
            entryName: 'main',
            boundaryId: 'native-widget',
            paths: { en: '/_mf/native-widget/en' },
            native: { publisherBuildId: 'client-compilation', runtimeABI: 1 },
          },
        },
      },
    },
    workerFederationManifestUrl: 'https://example.com/mf-manifest.json',
    workerFederationServices: [
      {
        remote: 'remote-a',
        alias: 'remoteA',
        manifestUrl: 'https://remote-a.example/mf-manifest.json',
        binding: 'REMOTE_A_WORKER',
        fragments: [fragment],
      },
    ],
  };
  const env = { ASSETS: assetBinding(), REMOTE_A_WORKER: { fetch } };
  let observed: unknown;
  const worker = emittedWorker(
    {
      rendererIdentities: {
        main: identity(renderer),
        other: { ...identity(renderer), entryName: 'other' },
      },
      nativeRenderer: {
        ...nativeResources(renderer),
        ...federationResources,
        entries: {
          main: entry,
          other: {
            assets: [{ kind: 'script', href: '/static/js/other.js' }],
            nativeManifest: { compiler: 'other-fixture' },
            serverConfig: { ssr: false },
          },
        },
      },
    },
    {
      [route.worker]: async () => ({
        ...nativeBundle(renderer, () => new Response('native document')),
        dispatchNativeWorkerRequest(
          request: Request,
          options: Parameters<typeof dispatchNativeWorkerRequest>[1],
        ) {
          observed = options.resources;
          expect(options.bindings).toBe(env);
          return dispatchNativeWorkerRequest(request, options);
        },
      }),
    },
  );
  const response = await worker.fetch(
    new Request('https://example.com/'),
    env,
    executionContext().context,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('native document');
  expect(observed).toEqual({ ...entry, ...federationResources });
  expect(entry).not.toHaveProperty('workerFederationServices');
  expect(entry.workerFederationManifestUrl).toBe(staleManifestUrl);
});

describe.each(['solid', 'octane'] as const)(
  '%s native worker dispatch',
  renderer => {
    it('streams the native document with env and ctx as the worker platform', async () => {
      const { pending, context } = executionContext();
      const env = { ASSETS: assetBinding(), DB: { name: 'd1' } };
      let observed: any;
      let release!: () => void;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      const worker = emittedWorker(
        {
          rendererIdentities: { main: identity(renderer) },
          nativeRenderer: nativeResources(renderer),
        },
        {
          [route.worker]: async () =>
            nativeBundle(renderer, (request, nativeContext) => {
              observed = {
                url: request.url,
                platform: nativeContext.session.platform,
                assets: nativeContext.assets,
                nativeManifest: nativeContext.nativeManifest,
                serverConfig: nativeContext.serverConfig,
              };
              const encoder = new TextEncoder();
              return new Response(
                new ReadableStream({
                  async start(controller) {
                    controller.enqueue(encoder.encode('<html><body>shell'));
                    await held;
                    controller.enqueue(encoder.encode(' late</body></html>'));
                    controller.close();
                  },
                }),
                { headers: { 'content-type': 'text/html; charset=utf-8' } },
              );
            }),
        },
      );
      const response = await worker.fetch(
        new Request('https://example.com/items/1?__loader=x'),
        env,
        context,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      );
      expect(response.headers.has('content-length')).toBe(false);
      expect(response.headers.has('content-encoding')).toBe(false);
      expect(
        JSON.parse(response.headers.get('x-ultramodern-renderer-identity')!),
      ).toEqual(identity(renderer));
      expect(observed.platform.kind).toBe('worker');
      expect(observed.platform.bindings).toBe(env);
      expect(observed.assets).toEqual([
        { kind: 'script', href: '/static/js/main.js' },
      ]);
      expect(observed.nativeManifest).toEqual({ compiler: 'fixture' });
      expect(observed.serverConfig).toEqual({ ssr: 'stream', forceCSR: false });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe('<html><body>shell');
      release();
      let rest = '';
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        rest += new TextDecoder().decode(part.value);
      }
      expect(rest).toBe(' late</body></html>');
      expect(pending).toHaveLength(1);
      await expect(pending[0]).resolves.toMatchObject({ state: 'completed' });
    });

    it.each(['x-rsc-tree', 'x-rsc-action'])(
      'rejects %s before importing the native bundle',
      async header => {
        let evaluations = 0;
        const worker = emittedWorker(
          {
            rendererIdentities: { main: identity(renderer) },
            nativeRenderer: nativeResources(renderer),
          },
          {
            [route.worker]: async () => {
              evaluations += 1;
              return {};
            },
          },
        );
        const response = await worker.fetch(
          new Request('https://example.com/', { headers: { [header]: '1' } }),
          { ASSETS: assetBinding() },
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          code: 'unsupported-renderer-capability',
          capability: 'rsc',
        });
        expect(evaluations).toBe(0);
      },
    );

    it('leaves locale resolution to the native handler', async () => {
      const requests: string[] = [];
      const worker = emittedWorker(
        {
          rendererIdentities: { main: identity(renderer) },
          nativeRenderer: nativeResources(renderer),
          i18n: {
            entries: {
              main: {
                languages: ['en-US', 'fr-FR'],
                fallbackLanguage: 'fr-FR',
              },
            },
          },
        },
        {
          [route.worker]: async () =>
            nativeBundle(renderer, request => {
              requests.push(request.url);
              return new Response('native', {
                headers: { 'content-type': 'text/html; charset=utf-8' },
              });
            }),
        },
      );
      const response = await worker.fetch(
        new Request('https://example.com/items', {
          headers: { 'accept-language': 'en' },
        }),
        { ASSETS: assetBinding() },
        executionContext().context,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('native');
      expect(requests).toEqual(['https://example.com/items']);
    });

    it('merges configured route response headers into the native response', async () => {
      const worker = emittedWorker(
        {
          rendererIdentities: { main: identity(renderer) },
          nativeRenderer: nativeResources(renderer),
          routeSpec: {
            routes: [
              {
                ...route,
                responseHeaders: {
                  'x-route': 'configured',
                  'content-type': 'application/json',
                  'content-length': '0',
                  'content-encoding': 'gzip',
                  'server-timing': 'route;dur=1',
                  link: '</r.css>; rel=preload; as=style',
                  'content-security-policy': "script-src 'self'",
                  vary: 'Origin',
                },
              },
            ],
          },
        },
        {
          [route.worker]: async () =>
            nativeBundle(
              renderer,
              () =>
                new Response('native', {
                  headers: {
                    'content-type': 'text/html; charset=utf-8',
                    'content-security-policy': "default-src 'self'",
                    'server-timing': 'render;dur=2',
                    link: '<https://cdn.test>; rel=preconnect',
                    vary: 'Cookie',
                  },
                }),
            ),
        },
      );
      const response = await worker.fetch(
        new Request('https://example.com/items'),
        { ASSETS: assetBinding() },
        executionContext().context,
      );
      expect(response.headers.get('x-route')).toBe('configured');
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'self', script-src 'self'",
      );
      expect(response.headers.get('vary')).toBe('Cookie, Origin');
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      );
      expect(response.headers.get('server-timing')).toBe(
        'render;dur=2, route;dur=1',
      );
      expect(response.headers.get('link')).toBe(
        '<https://cdn.test>; rel=preconnect, </r.css>; rel=preload; as=style',
      );
      expect(await response.text()).toBe('native');
    });

    it('answers loader requests through the native dispatcher, not the legacy route-data worker', async () => {
      const urls: string[] = [];
      const legacy = rstest.fn(async () => ({}));
      const worker = emittedWorker(
        {
          rendererIdentities: { main: identity(renderer) },
          nativeRenderer: nativeResources(renderer),
          routeSpec: {
            routes: [{ ...route, routeDataWorker: 'worker/main-data.js' }],
          },
        },
        {
          'worker/main-data.js': legacy,
          [route.worker]: async () =>
            nativeBundle(renderer, request => {
              urls.push(request.url);
              return Response.json({ native: true });
            }),
        },
      );
      const response = await worker.fetch(
        new Request('https://example.com/items?__loader=page'),
        { ASSETS: assetBinding() },
        executionContext().context,
      );
      expect(await response.json()).toEqual({ native: true });
      expect(urls).toEqual(['https://example.com/items?__loader=page']);
      expect(legacy).not.toHaveBeenCalled();
    });

    it('writes a non-ASCII renderer identity as an ASCII header', async () => {
      const unicode = { ...identity(renderer), appId: '店舗-🛒' };
      const worker = emittedWorker(
        {
          rendererIdentities: { main: unicode },
          nativeRenderer: nativeResources(renderer),
        },
        {
          [route.worker]: async () =>
            nativeBundle(
              renderer,
              () =>
                new Response('native', {
                  headers: { 'content-type': 'text/html; charset=utf-8' },
                }),
            ),
        },
      );
      const response = await worker.fetch(
        new Request('https://example.com/items'),
        { ASSETS: assetBinding() },
        executionContext().context,
      );
      const header = response.headers.get('x-ultramodern-renderer-identity')!;
      expect(/^[\x20-\x7e]*$/u.test(header)).toBe(true);
      expect(JSON.parse(header)).toEqual(unicode);
    });

    it('passes HEAD to the native dispatcher unchanged', async () => {
      const methods: string[] = [];
      const worker = emittedWorker(
        {
          rendererIdentities: { main: identity(renderer) },
          nativeRenderer: nativeResources(renderer),
        },
        {
          [route.worker]: async () =>
            nativeBundle(renderer, request => {
              methods.push(request.method);
              return new Response('native', {
                headers: { 'content-type': 'text/html; charset=utf-8' },
              });
            }),
        },
      );
      const response = await worker.fetch(
        new Request('https://example.com/items', { method: 'HEAD' }),
        { ASSETS: assetBinding() },
        executionContext().context,
      );
      expect(response.status).toBe(200);
      expect(methods).toEqual(['HEAD']);
    });

    it('serves static assets without the native bundle', async () => {
      const served: string[] = [];
      const worker = emittedWorker(
        {
          rendererIdentities: { main: identity(renderer) },
          nativeRenderer: nativeResources(renderer),
        },
        {
          [route.worker]: async () => {
            throw new Error('asset requests must not import the SSR bundle');
          },
        },
      );
      const response = await worker.fetch(
        new Request('https://example.com/static/js/main.js'),
        { ASSETS: assetBinding(served) },
      );
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('asset:/static/js/main.js');
      expect(served).toEqual(['/static/js/main.js']);
    });

    it('turns a pre-commit native failure into a controlled 500', async () => {
      const errors: unknown[] = [];
      const originalError = console.error;
      console.error = (error: unknown) => errors.push(error);
      try {
        const worker = emittedWorker(
          {
            rendererIdentities: { main: identity(renderer) },
            nativeRenderer: nativeResources(renderer),
          },
          {
            [route.worker]: async () =>
              nativeBundle(renderer, () => {
                throw new Error('native handler failed');
              }),
          },
        );
        const response = await worker.fetch(
          new Request('https://example.com/'),
          {
            ASSETS: assetBinding(),
          },
        );
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
          code: 'native-render-failed',
          entryName: 'main',
        });
        expect(String(errors[0])).toContain('native handler failed');
      } finally {
        console.error = originalError;
      }
    });

    it('rejects a native route whose build has no worker resources', async () => {
      const worker = emittedWorker(
        { rendererIdentities: { main: identity(renderer) } },
        {
          [route.worker]: async () => {
            throw new Error('missing resources must not import the bundle');
          },
        },
      );
      const response = await worker.fetch(new Request('https://example.com/'), {
        ASSETS: assetBinding(),
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        code: 'missing-native-renderer-resources',
        entryName: 'main',
      });
    });
  },
);
