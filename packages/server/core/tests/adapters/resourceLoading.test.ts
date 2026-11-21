import os from 'node:os';
import path from 'node:path';
import type { ServerRoute } from '@modern-js/types';
import { fs } from '@modern-js/utils';
import {
  injectResourcePlugin,
  serverStaticPlugin,
} from '../../src/adapters/node/plugins';
import type {
  RenderBundleLoad,
  ServerRenderResourceOptions,
} from '../../src/adapters/node/plugins/resource';
import { createDefaultPlugins, renderPlugin } from '../../src/plugins';
import { createServerBase } from '../../src/serverBase';
import type { ServerPlugin } from '../../src/types';
import { getDefaultAppContext, getDefaultConfig } from '../helpers';

type Loads = { render: number; loader: number };
const counters = globalThis as typeof globalThis & {
  __resourceLoads?: Record<string, Loads>;
};

const route: ServerRoute = {
  urlPath: '/',
  entryName: 'main',
  entryPath: 'html/main/index.html',
  bundle: 'bundles/main.js',
  isSSR: true,
};

let pwd: string;
let fixture = 0;

async function createFixture({ renderBundle = true } = {}) {
  pwd = await fs.mkdtemp(path.join(os.tmpdir(), 'modern-resources-'));
  const id = String(fixture++);
  counters.__resourceLoads = {
    ...counters.__resourceLoads,
    [id]: { render: 0, loader: 0 },
  };
  if (renderBundle) {
    await fs.outputFile(
      path.join(pwd, route.bundle!),
      `globalThis.__resourceLoads[${JSON.stringify(id)}].render++; exports.owner = 'fixture';`,
    );
  }
  await fs.outputFile(
    path.join(pwd, 'bundles/main-server-loaders.js'),
    `exports.loadModules = async () => { globalThis.__resourceLoads[${JSON.stringify(id)}].loader++; return { ready: true }; };`,
  );
  await fs.outputFile(path.join(pwd, route.entryPath), '<html>owner</html>');
  await fs.outputFile(path.join(pwd, 'static/client.js'), 'client');
  return () => counters.__resourceLoads![id];
}

async function createResourceServer(
  renderResources?: ServerRenderResourceOptions,
) {
  const seen: unknown[] = [];
  const server = createServerBase({
    routes: [route],
    config: getDefaultConfig(),
    pwd,
    appContext: getDefaultAppContext(),
  });
  const fixturePlugin: ServerPlugin = {
    name: 'fixture-resources',
    setup(api) {
      if (renderResources) {
        api.updateServerContext({ renderResources });
      }
      api.onPrepare(() => {
        const { middlewares } = api.getServerContext();
        // Stands in for the BFF handler, which answers before page routes.
        middlewares.push({
          name: 'fixture-api',
          path: '/api/*',
          handler: async c => c.text('api'),
        });
      });
    },
  };
  const documentPlugin: ServerPlugin = {
    name: 'fixture-document',
    setup(api) {
      api.onPrepare(() => {
        api.getServerContext().renderMiddlewares.push({
          name: 'fixture-document',
          handler: async c => {
            const manifest = c.get('serverManifest');
            const templates = c.get('templates');
            seen.push(manifest, templates);
            return c.json({
              owner: manifest.renderBundles?.main?.owner,
              loader: manifest.loaderBundles?.main?.ready,
              template: Object.values(templates)[0],
            });
          },
        });
      });
    },
  };
  server.addPlugins([
    ...createDefaultPlugins({ logger: false }),
    fixturePlugin,
    injectResourcePlugin(),
    documentPlugin,
    serverStaticPlugin(),
    renderPlugin(),
  ]);
  await server.init();
  return { server, seen };
}

function observeBundles() {
  const loads: Array<RenderBundleLoad & { outcome?: string }> = [];
  const onBundleLoad: ServerRenderResourceOptions['onBundleLoad'] = bundle => {
    const load: (typeof loads)[number] = { ...bundle };
    loads.push(load);
    return outcome => {
      load.outcome = outcome;
    };
  };
  return { loads, onBundleLoad };
}

beforeEach(() => {
  rstest.stubEnv('NODE_ENV', 'production');
});

afterEach(async () => {
  rstest.unstubAllEnvs();
  await fs.remove(pwd);
});

describe('lazy render resources', () => {
  it('leaves BFF and static requests without render imports', async () => {
    const loads = await createFixture();
    const observed = observeBundles();
    const { server } = await createResourceServer({
      loading: 'lazy',
      onBundleLoad: observed.onBundleLoad,
    });

    expect(await (await server.request('/api/ping', {}, {})).text()).toBe(
      'api',
    );
    expect(
      await (await server.request('/static/client.js', {}, {})).text(),
    ).toBe('client');
    expect(loads()).toEqual({ render: 0, loader: 0 });
    expect(observed.loads).toEqual([]);
  });

  it('shares one load across concurrent first renders', async () => {
    const loads = await createFixture();
    const observed = observeBundles();
    const { server, seen } = await createResourceServer({
      loading: 'lazy',
      onBundleLoad: observed.onBundleLoad,
    });

    const responses = await Promise.all(
      ['/document', '/document', '/other'].map(pathname =>
        server.request(pathname, {}, {}),
      ),
    );
    for (const response of responses) {
      expect(await response.json()).toEqual({
        owner: 'fixture',
        loader: true,
        template: '<html>owner</html>',
      });
    }
    expect(loads()).toEqual({ render: 1, loader: 1 });
    expect(new Set(seen).size).toBe(2);
    expect(observed.loads).toEqual([
      {
        filepath: path.join(pwd, route.bundle!),
        requestPath: '/document',
        outcome: 'loaded',
      },
      {
        filepath: path.join(pwd, 'bundles/main-server-loaders.js'),
        requestPath: '/document',
        outcome: 'loaded',
      },
    ]);
  });

  it('keeps loading per request during development', async () => {
    rstest.stubEnv('NODE_ENV', 'development');
    const loads = await createFixture();
    const { server, seen } = await createResourceServer({ loading: 'lazy' });

    await server.request('/document', {}, {});
    await server.request('/document', {}, {});
    expect(loads().loader).toBe(2);
    expect(seen[0]).not.toBe(seen[2]);
  });
});

describe('eager render resources', () => {
  it('reports warmup imports without a request path', async () => {
    await createFixture();
    const observed = observeBundles();
    await createResourceServer({ onBundleLoad: observed.onBundleLoad });

    expect(observed.loads).toEqual([
      { filepath: path.join(pwd, route.bundle!), outcome: 'loaded' },
      {
        filepath: path.join(pwd, 'bundles/main-server-loaders.js'),
        outcome: 'loaded',
      },
    ]);
  });

  it('still fails preparation when a required SSR bundle is missing', async () => {
    await createFixture({ renderBundle: false });
    rstest.spyOn(console, 'error').mockImplementation(() => {});
    const observed = observeBundles();

    await expect(
      createResourceServer({ onBundleLoad: observed.onBundleLoad }),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' });
    expect(observed.loads).toContainEqual({
      filepath: path.join(pwd, route.bundle!),
      outcome: 'failed',
    });
  });
});
