import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPlugins, type ProdServerOptions } from '@modern-js/prod-server';
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
import { ultramodernServerPlugin } from '../src/serverPlugin';
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
  rstest.unstubAllGlobals();
  rstest.unstubAllEnvs();
  await rm(pwd, { recursive: true, force: true });
});

describe('render resource policy', () => {
  it.each(['eager', 'lazy'])(
    'provides resources and remote CSS to configured page middleware in %s mode',
    async loading => {
      rstest.stubEnv('MODERN_SERVER_RENDER_RESOURCES', loading);
      pwd = await mkdtemp(path.join(os.tmpdir(), 'modern-resource-assembly-'));
      await fs.outputFile(
        path.join(pwd, route.bundle!),
        "exports.owner = 'fixture';",
      );
      await fs.outputFile(
        path.join(pwd, route.entryPath),
        '<html>owner</html>',
      );
      await fs.outputFile(path.join(pwd, 'static/client.js'), 'client');
      await fs.outputJson(path.join(pwd, 'mf-manifest.json'), {
        remotes: [{ entry: 'https://remote.example.com/mf-manifest.json' }],
      });
      rstest.stubGlobal('fetch', async () =>
        Response.json({
          metaData: { publicPath: 'https://remote.example.com/' },
          exposes: [{ assets: { css: { sync: ['static/remote.css'] } } }],
        }),
      );
      const options: ProdServerOptions = {
        pwd,
        serverConfigPath: path.join(pwd, 'modern.server.js'),
        routes: [route],
        appContext: { ...getDefaultAppContext(), appDirectory: pwd },
        config: {
          ...getDefaultConfig(),
          server: { logger: false, ssr: true },
        },
        plugins: [ultramodernServerPlugin()],
        serverConfig: {
          middlewares: [
            {
              name: 'fixture-api',
              path: '/api/*',
              handler: async c => c.text('api'),
            },
          ],
          renderMiddlewares: [
            {
              name: 'configured-page-consumer',
              handler: async c => {
                const manifest = c.get('serverManifest');
                return c.json({
                  owner: manifest?.renderBundles?.main?.owner ?? null,
                  templates: Object.values(c.get('templates') ?? {}),
                  css: manifest?.moduleFederationCssAssets ?? [],
                });
              },
            },
          ],
        },
      };
      const server = createServerBase(options);
      try {
        await applyPlugins(server, options);
        await server.init();
        expect(await (await server.request('/api/ping')).text()).toBe('api');
        expect(await (await server.request('/static/client.js')).text()).toBe(
          'client',
        );
        if (loading === 'lazy') expect(bundles).toEqual([]);

        const response = await server.request('/document');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          owner: 'fixture',
          templates: ['<html>owner</html>'],
          css: ['https://remote.example.com/static/remote.css'],
        });
      } finally {
        await server.dispose();
      }
    },
  );

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
