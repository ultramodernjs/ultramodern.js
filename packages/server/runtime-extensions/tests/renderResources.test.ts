import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createDefaultPlugins,
  createServerBase,
  renderPlugin,
  type ServerPlugin,
} from '@modern-js/server-core';
import { injectResourcePlugin } from '@modern-js/server-core/node';
import type { ServerRoute } from '@modern-js/types';
import { fs } from '@modern-js/utils';
import {
  type RenderBundleLoadEvent,
  renderBundleLoadChannel,
  type ServerRequestTrace,
  serverRequestChannel,
} from '../src/render-resources';
import { injectRenderResourcesPlugin } from '../src/render-resources/plugin';
import { getDefaultAppContext, getDefaultConfig } from './helpers';

const route: ServerRoute = {
  urlPath: '/',
  entryName: 'main',
  entryPath: 'html/main/index.html',
  bundle: 'bundles/main.js',
  isSSR: true,
};

let pwd: string;
const bundles: RenderBundleLoadEvent[] = [];
const requests: Array<{
  phase: string;
  trace: ServerRequestTrace;
  seen: ServerRequestTrace;
}> = [];
const onBundle = (event: RenderBundleLoadEvent) => {
  bundles.push(event);
};
// Copy each publication: tracing mutates its shared context as it settles.
const requestObserver = {
  start: (trace: ServerRequestTrace) =>
    requests.push({ phase: 'start', trace, seen: { ...trace } }),
  asyncEnd: (trace: ServerRequestTrace) =>
    requests.push({ phase: 'end', trace, seen: { ...trace } }),
};

async function createServer() {
  pwd = await mkdtemp(path.join(os.tmpdir(), 'modern-render-resources-'));
  await fs.outputFile(
    path.join(pwd, route.bundle!),
    "exports.owner = 'fixture';",
  );
  await fs.outputFile(path.join(pwd, route.entryPath), '<html>owner</html>');
  const server = createServerBase({
    routes: [route],
    config: getDefaultConfig(),
    pwd,
    appContext: getDefaultAppContext(),
  });
  const fixture: ServerPlugin = {
    name: 'fixture-api-and-document',
    setup(api) {
      api.onPrepare(() => {
        const { middlewares, renderMiddlewares } = api.getServerContext();
        middlewares.push({
          name: 'fixture-api',
          path: '/api/*',
          handler: async c => c.text('api'),
        });
        renderMiddlewares.push({
          name: 'fixture-document',
          handler: async c =>
            c.text(c.get('serverManifest').renderBundles?.main?.owner),
        });
      });
    },
  };
  server.addPlugins([
    ...createDefaultPlugins({ logger: false }),
    injectRenderResourcesPlugin(),
    injectResourcePlugin(),
    fixture,
    renderPlugin(),
  ]);
  await server.init();
  return server;
}

beforeEach(() => {
  rstest.stubEnv('NODE_ENV', 'production');
  renderBundleLoadChannel.subscribe(onBundle);
  serverRequestChannel.subscribe(requestObserver);
});

afterEach(async () => {
  renderBundleLoadChannel.unsubscribe(onBundle);
  serverRequestChannel.unsubscribe(requestObserver);
  bundles.length = 0;
  requests.length = 0;
  rstest.unstubAllEnvs();
  await rm(pwd, { recursive: true, force: true });
});

describe('render resource policy', () => {
  it('defers production bundle imports to the first render when lazy', async () => {
    rstest.stubEnv('MODERN_SERVER_RENDER_RESOURCES', 'lazy');
    const server = await createServer();

    expect(await (await server.request('/api/ping', {}, {})).text()).toBe(
      'api',
    );
    expect(bundles).toEqual([]);

    const pages = await Promise.all(
      ['/document?id=1', '/document'].map(pathname =>
        server.request(pathname, {}, {}),
      ),
    );
    expect(await Promise.all(pages.map(page => page.text()))).toEqual([
      'fixture',
      'fixture',
    ]);
    expect(bundles).toEqual([
      {
        distDirectory: pwd,
        filepath: path.join(pwd, route.bundle!),
        durationMs: expect.any(Number),
        outcome: 'loaded',
        triggerPath: '/document',
      },
    ]);
    expect(bundles[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports eager warmup imports as startup loads', async () => {
    await createServer();
    expect(bundles).toEqual([
      expect.objectContaining({
        filepath: path.join(pwd, route.bundle!),
        outcome: 'loaded',
        triggerPath: '<startup>',
      }),
    ]);
  });

  it('traces each request from entry until it settles', async () => {
    const server = await createServer();
    await server.request('/api/ping?first=1', {}, {});

    expect(requests.map(({ phase, seen }) => [phase, seen])).toEqual([
      ['start', { distDirectory: pwd, path: '/api/ping' }],
      [
        'end',
        expect.objectContaining({ distDirectory: pwd, path: '/api/ping' }),
      ],
    ]);
    expect(requests[0].trace).toBe(requests[1].trace);
  });
});
