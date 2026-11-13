import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { compatPlugin, createServerBase } from '@modern-js/server-core';
import {
  loadServerPlugins,
  serverStaticPlugin,
} from '@modern-js/server-core/node';
import type { ServerRoute } from '@modern-js/types';
import { applyPlugins } from '../../../prod-server/src/apply';
import type { ProdServerOptions } from '../../../prod-server/src/types';
import staticServingExtensionsPlugin from '../../src/static-serving/plugin';
import { getDefaultAppContext, getDefaultConfig } from '../helpers';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'private-static-order-'));
  roots.push(root);
  await mkdir(path.join(root, 'public/static'), { recursive: true });
  await mkdir(path.join(root, 'static'));
  return root;
}
async function serverFor(
  root: string,
  routes: ServerRoute[] = [],
  prefix = '/',
) {
  const server = createServerBase({
    config: { ...getDefaultConfig(), output: { assetPrefix: prefix } },
    appContext: getDefaultAppContext(),
    pwd: root,
    routes,
  });
  // Native assembly stays untouched: the separate ServerPlugin registers during setup.
  server.addPlugins([
    compatPlugin(),
    serverStaticPlugin(),
    staticServingExtensionsPlugin(),
  ]);
  await server.init();
  return server;
}

it.each(['federation', 'public', 'generated'] as const)(
  'keeps MF/public/generated precedence when %s is the first available response',
  async winner => {
    const root = await fixture();
    await writeFile(path.join(root, 'public/shared.txt'), 'generated');
    const routes =
      winner === 'generated'
        ? []
        : ([
            {
              urlPath: '/shared.txt',
              entryPath: 'public/route.txt',
              isSSR: false,
            },
          ] as ServerRoute[]);
    if (winner !== 'generated') {
      await writeFile(path.join(root, 'public/route.txt'), 'public');
    }
    if (winner === 'federation') {
      await writeFile(
        path.join(root, 'mf-manifest.json'),
        JSON.stringify({
          metaData: { publicPath: '/', remoteEntry: { name: 'shared.txt' } },
        }),
      );
      await writeFile(path.join(root, 'shared.txt'), 'federation');
    }
    const server = await serverFor(root, routes);
    const response = await server.request('/shared.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(winner);
  },
);

it('does not serve generated or public fallback for a native static-pattern miss', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'public/static/missing.txt'), 'generated');
  await writeFile(path.join(root, 'public/fallback.txt'), 'public');
  const server = await serverFor(root, [
    {
      urlPath: '/static/missing.txt',
      entryPath: 'public/fallback.txt',
      isSSR: false,
    },
  ] as ServerRoute[]);
  expect((await server.request('/static/missing.txt')).status).toBe(404);
});

it('patches frontend manifests and native-static remote entries while bypassing compressed variants', async () => {
  const root = await fixture();
  const manifest = {
    metaData: {
      publicPath: '/',
      remoteEntry: { path: 'static', name: 'remote.js' },
    },
  };
  await writeFile(
    path.join(root, 'mf-manifest.json'),
    JSON.stringify(manifest),
  );
  await writeFile(path.join(root, 'mf-manifest.json.br'), 'must not be served');
  await writeFile(
    path.join(root, 'static/remote.js'),
    '__webpack_require__.p = "/";',
  );
  await writeFile(path.join(root, 'static/remote.js.br'), 'must not be served');
  const server = await serverFor(root, [], 'https://cdn.example/assets/');
  const manifestResponse = await server.request('/assets/mf-manifest.json', {
    headers: { 'accept-encoding': 'br', 'if-none-match': '*' },
  });
  const remoteResponse = await server.request('/assets/static/remote.js', {
    headers: { 'accept-encoding': 'br', 'if-none-match': '*' },
  });
  for (const response of [manifestResponse, remoteResponse]) {
    expect(response.headers.get('content-length')).toBe(
      String((await response.clone().arrayBuffer()).byteLength),
    );
  }
  expect((await manifestResponse.json()).metaData.publicPath).toBe(
    'http://localhost/assets/',
  );
  expect(await remoteResponse.text()).toContain(
    '__webpack_require__.p = "http://localhost/assets/";',
  );
  for (const response of [manifestResponse, remoteResponse]) {
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'GET,HEAD,OPTIONS',
    );
  }
});

it('rejects a compressed generated-public symlink escape before exposing its bytes', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'public/file.txt'), 'public');
  await writeFile(path.join(root, 'private.txt'), 'private');
  await symlink(
    path.join(root, 'private.txt'),
    path.join(root, 'public/file.txt.br'),
  );
  const server = await serverFor(root);
  const response = await server.request('/file.txt', {
    headers: { 'accept-encoding': 'br' },
  });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('private');
});

it('registers static extensions through the actual production and dev plugin assembly', async () => {
  const root = await fixture();
  const scope = path.join(root, 'node_modules/@modern-js');
  await mkdir(scope, { recursive: true });
  await symlink(
    path.resolve(__dirname, '../..'),
    path.join(scope, 'server-runtime-extensions'),
    'dir',
  );
  const original = Buffer.from('production composition body');
  const compressed = brotliCompressSync(original);
  await writeFile(path.join(root, 'static/asset.txt'), original);
  await writeFile(path.join(root, 'static/asset.txt.br'), compressed);
  await writeFile(path.join(root, 'public/generated.txt'), 'generated public');
  const options: ProdServerOptions = {
    pwd: root,
    serverConfigPath: path.join(root, 'modern.server.js'),
    appContext: { ...getDefaultAppContext(), appDirectory: root },
    config: { ...getDefaultConfig(), server: { logger: false } },
    plugins: await loadServerPlugins(
      [{ name: '@modern-js/server-runtime-extensions/server-plugin' }],
      root,
    ),
  };
  const server = createServerBase(options);
  try {
    await applyPlugins(server, options);
    await server.init();
    const response = await server.request('/static/asset.txt', {
      headers: { 'accept-encoding': 'br' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(compressed);
    expect(await (await server.request('/generated.txt')).text()).toBe(
      'generated public',
    );
  } finally {
    await server.dispose();
  }
});

it('uses served byte length when a compressed static representation is a symlink', async () => {
  const root = await fixture();
  const original = Buffer.from('representation with a symlink target');
  const compressed = brotliCompressSync(original);
  await writeFile(path.join(root, 'static/asset.txt'), original);
  await writeFile(path.join(root, 'static/compressed'), compressed);
  await symlink(
    path.join(root, 'static/compressed'),
    path.join(root, 'static/asset.txt.br'),
  );
  const server = await serverFor(root);
  const response = await server.request('/static/asset.txt', {
    headers: { 'accept-encoding': 'br' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-length')).toBe(
    String(compressed.byteLength),
  );
  expect(Buffer.from(await response.arrayBuffer())).toEqual(compressed);
});
