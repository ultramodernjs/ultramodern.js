import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPlugins, type ProdServerOptions } from '@modern-js/prod-server';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { createServerBase } from '@modern-js/server-core';
import { nativeServerPlugin } from '../../src/native-composition/native-server-plugin';

const identity: RendererIdentity = {
  renderer: 'octane',
  appId: 'federation-remote',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'production-build',
};
const roots: string[] = [];
const servers: ReturnType<typeof createServerBase>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.dispose()));
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })),
  );
});

/** The emitted output of a native SSR remote: browser and Node containers. */
async function writeRemoteOutput(pwd: string) {
  const files: Record<string, string> = {
    'mf-manifest.json': JSON.stringify({
      metaData: {
        publicPath: 'http://localhost:3043/',
        remoteEntry: { path: '', name: 'remoteEntry.js', type: 'global' },
        ssrRemoteEntry: {
          path: '',
          name: 'remoteEntry.js',
          type: 'commonjs-module',
        },
        ssrPublicPath: 'http://localhost:3043/bundles/',
      },
      exposes: [
        {
          assets: {
            js: { sync: ['static/js/async/__federation_expose_Widget.js'] },
            css: { sync: ['static/css/async/widget.css'] },
          },
        },
      ],
    }),
    'remoteEntry.js': 'var verticalOctane = {};',
    'static/js/async/__federation_expose_Widget.js': 'export {};',
    'static/css/async/widget.css': '.widget{}',
    'bundles/mf-manifest.json': JSON.stringify({
      metaData: { publicPath: 'http://localhost:3043/bundles/' },
      exposes: [
        { assets: { js: { sync: ['__federation_expose_Widget.js'] } } },
      ],
    }),
    'bundles/remoteEntry.js': 'module.exports = { container: true };',
    'bundles/__federation_expose_Widget.js': 'module.exports = {};',
    'bundles/main.js': `require('node:fs').writeFileSync(${JSON.stringify(path.join(pwd, 'render-imported'))}, 'loaded'); module.exports = { secret: "server-only" };`,
  };
  for (const [name, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(pwd, name)), { recursive: true });
    await fs.writeFile(path.join(pwd, name), source);
  }
}

async function serveNativeRemote() {
  const pwd = await fs.mkdtemp(path.join(os.tmpdir(), 'um-native-serve-'));
  roots.push(pwd);
  await writeRemoteOutput(pwd);
  const options = {
    pwd,
    appContext: { appDirectory: pwd, apiDirectory: '', lambdaDirectory: '' },
    routes: [
      {
        urlPath: '/',
        entryName: 'main',
        entryPath: 'main.html',
        bundle: 'bundles/main.js',
        isSSR: true,
      },
    ],
    config: {
      html: {},
      output: {},
      source: {},
      tools: {},
      server: { logger: false, ssr: true },
      bff: {},
      dev: {},
      security: {},
    },
    plugins: [
      nativeServerPlugin({
        renderer: 'octane',
        entries: { main: identity },
        cacheAllowed: true,
        assetManifestFile: 'renderer-assets.json',
      }),
    ],
  } as unknown as ProdServerOptions;
  const server = createServerBase(options);
  servers.push(server);
  await applyPlugins(server, options);
  await server.init();
  return { server, pwd };
}

describe('native production federation assets', () => {
  it('keeps render bundles unloaded while serving assets in lazy mode', async () => {
    rstest.stubEnv('NODE_ENV', 'production');
    rstest.stubEnv('MODERN_SERVER_RENDER_RESOURCES', 'lazy');
    try {
      const { server, pwd } = await serveNativeRemote();
      const imported = path.join(pwd, 'render-imported');
      await expect(fs.access(imported)).rejects.toThrow();

      const response = await server.request('/remoteEntry.js');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('var verticalOctane = {};');
      await expect(fs.access(imported)).rejects.toThrow();
    } finally {
      rstest.unstubAllEnvs();
    }
  });

  it('serves the browser container, its manifest and chunks with federation CORS', async () => {
    const { server } = await serveNativeRemote();

    const manifest = await server.request('/mf-manifest.json');
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toMatch(/^application\/json/);
    expect(manifest.headers.get('access-control-allow-origin')).toBe('*');
    expect(manifest.headers.get('cache-control')).toContain('no-store');
    expect((await manifest.json()).metaData.ssrPublicPath).toBe(
      'http://localhost:3043/bundles/',
    );

    for (const [pathname, type] of [
      ['/remoteEntry.js', /^text\/javascript/],
      ['/static/js/async/__federation_expose_Widget.js', /^text\/javascript/],
      ['/static/css/async/widget.css', /^text\/css/],
    ] as const) {
      const response = await server.request(pathname);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(type);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('serves the Node container a server-rendering host loads, not the app server bundle', async () => {
    const { server } = await serveNativeRemote();

    for (const pathname of [
      '/bundles/remoteEntry.js',
      '/bundles/__federation_expose_Widget.js',
    ]) {
      const response = await server.request(pathname);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/javascript/);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
    expect(await (await server.request('/bundles/remoteEntry.js')).text()).toBe(
      'module.exports = { container: true };',
    );

    const privateBundle = await server.request('/bundles/main.js');
    expect(await privateBundle.text()).not.toContain('server-only');
  });
});
