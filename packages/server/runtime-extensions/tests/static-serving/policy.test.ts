import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { compatPlugin, createServerBase } from '@modern-js/server-core';
import { serverStaticPlugin } from '@modern-js/server-core/node';
import { fs } from '@modern-js/utils';
import {
  createImmutableAssetStat,
  IMMUTABLE_ASSET_STAT_LIMIT,
} from '../../src/static-serving/immutableAssetStat';
import staticServingExtensionsPlugin from '../../src/static-serving/plugin';
import { getDefaultAppContext, getDefaultConfig } from '../helpers';

const tempDirs: string[] = [];
const bytes = Buffer.from('globalThis.asset = true;');

const createTempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modern-static-policy-'));
  tempDirs.push(dir);
  return dir;
};

const createFixture = async () => {
  const pwd = await createTempDir();
  const outside = await createTempDir();
  const filename = path.join(pwd, 'static/asset.js');
  await mkdir(path.dirname(filename), { recursive: true });
  await mkdir(path.join(pwd, 'public'), { recursive: true });
  await writeFile(filename, bytes);
  await writeFile(`${filename}.br`, brotliCompressSync(bytes));
  await writeFile(`${filename}.gz`, gzipSync(bytes));
  await writeFile(path.join(outside, 'private.txt'), 'private');
  await symlink(
    path.join(outside, 'private.txt'),
    path.join(pwd, 'public/escape.txt'),
  );
  const server = createServerBase({
    config: getDefaultConfig(),
    pwd,
    routes: [],
    appContext: getDefaultAppContext(),
  });
  server.addPlugins([
    compatPlugin(),
    staticServingExtensionsPlugin(),
    serverStaticPlugin(),
  ]);
  await server.init();
  const request = (pathname: string, encoding: string) =>
    server.request(pathname, {
      headers: new Headers({ 'accept-encoding': encoding }),
    });
  return { pwd, filename, request };
};

const countCalls = (method: 'stat' | 'pathExists', match: string[]) => {
  let calls = 0;
  const original = fs[method] as (...args: unknown[]) => unknown;
  rstest.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
    if (match.includes(String(args[0]))) {
      calls++;
    }
    return original.apply(fs, args);
  }) as never);
  return () => calls;
};

beforeEach(() => {
  rstest.stubEnv('NODE_ENV', 'production');
});

afterEach(async () => {
  rstest.restoreAllMocks();
  rstest.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  );
});

describe('default static asset policy', () => {
  it('looks files up and negotiates variants on every request', async () => {
    const { filename, request } = await createFixture();
    const stats = countCalls('stat', [filename]);
    const probes = countCalls('pathExists', [
      `${filename}.br`,
      `${filename}.gz`,
    ]);

    await request('/static/asset.js', 'identity');
    const afterFirst = stats();
    await Promise.all(
      Array.from({ length: 4 }, () => request('/static/asset.js', 'identity')),
    );
    expect(stats()).toBeGreaterThan(afterFirst);
    expect(probes()).toBe(10);

    const compressed = await request('/static/asset.js', 'br, gzip');
    expect(compressed.headers.get('content-encoding')).toBe('br');
    expect(compressed.headers.get('vary')).toContain('Accept-Encoding');
  });
});

describe('immutable assets without precompressed variants', () => {
  beforeEach(() => {
    rstest.stubEnv('MODERN_SERVER_IMMUTABLE_ASSETS', 'true');
    rstest.stubEnv('MODERN_SERVER_PRECOMPRESSED_ASSETS', 'false');
  });

  it('keeps found files and serves only identity with native headers', async () => {
    const { filename, request } = await createFixture();
    const stats = countCalls('stat', [filename]);
    const probes = countCalls('pathExists', [
      `${filename}.br`,
      `${filename}.gz`,
    ]);

    const first = await request('/static/asset.js', 'identity');
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(bytes.toString());
    expect(first.headers.get('content-length')).toBe(String(bytes.length));
    expect(first.headers.get('content-type')).toMatch(/javascript/u);
    const afterFirst = stats();
    const repeated = await Promise.all(
      Array.from({ length: 8 }, () => request('/static/asset.js', 'identity')),
    );
    expect(repeated.every(response => response.status === 200)).toBe(true);
    expect(stats()).toBe(afterFirst);

    const compressed = await request('/static/asset.js', 'br, gzip');
    expect(compressed.headers.get('content-encoding')).toBeNull();
    expect(Buffer.from(await compressed.arrayBuffer()).equals(bytes)).toBe(
      true,
    );
    expect(probes()).toBe(0);
  });

  it.each(['identity;q=0, br;q=0, gzip;q=0', 'identity;q=0, br'])(
    'still refuses identity when %s excludes it',
    async encoding => {
      const { request } = await createFixture();
      const refused = await request('/static/asset.js', encoding);
      expect(refused.status).toBe(406);
      expect(refused.headers.get('vary')).toContain('Accept-Encoding');
    },
  );

  it('looks up a missing file again and keeps native containment', async () => {
    const { pwd, request } = await createFixture();
    expect((await request('/static/new.js', 'identity')).status).toBe(404);
    await writeFile(path.join(pwd, 'static/new.js'), 'new');
    expect(await (await request('/static/new.js', 'identity')).text()).toBe(
      'new',
    );
    expect((await request('/escape.txt', 'identity')).status).toBe(404);
    expect((await request('/%2e%2e/private.txt', 'identity')).status).toBe(404);
  });

  it('keeps the federation inventory for the release', async () => {
    const pwd = await createTempDir();
    let now = 1_000;
    rstest.spyOn(Date, 'now').mockImplementation(() => now);
    const server = createServerBase({
      config: getDefaultConfig(),
      pwd,
      routes: [],
      appContext: getDefaultAppContext(),
    });
    server.addPlugins([
      compatPlugin(),
      staticServingExtensionsPlugin(),
      serverStaticPlugin(),
    ]);
    await server.init();
    expect((await server.request('/remoteEntry.js')).status).toBe(404);
    await writeFile(
      path.join(pwd, 'mf-manifest.json'),
      JSON.stringify({
        metaData: {
          publicPath: '/',
          remoteEntry: { path: '', name: 'remoteEntry.js' },
        },
      }),
    );
    await writeFile(path.join(pwd, 'remoteEntry.js'), 'export {}');
    now += 60_000;
    expect((await server.request('/remoteEntry.js')).status).toBe(404);
  });
});

describe('immutable asset stat', () => {
  it('keeps at most the limit, dropping the oldest found file', async () => {
    let stats = 0;
    rstest.spyOn(fs, 'stat').mockImplementation((async () => {
      stats++;
      return { isFile: () => true };
    }) as never);
    const stat = createImmutableAssetStat();
    for (let index = 0; index <= IMMUTABLE_ASSET_STAT_LIMIT; index++) {
      await stat(String(index));
    }
    const afterFill = stats;
    await stat(String(IMMUTABLE_ASSET_STAT_LIMIT));
    expect(stats).toBe(afterFill);
    await stat('0');
    expect(stats).toBe(afterFill + 1);
  });

  it('shares one lookup and never keeps a miss or a directory', async () => {
    let result: { isFile: () => boolean } | Error = new Error('ENOENT');
    let stats = 0;
    rstest.spyOn(fs, 'stat').mockImplementation((async () => {
      stats++;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }) as never);
    const stat = createImmutableAssetStat();
    expect(await Promise.all([stat('a'), stat('a')])).toEqual([null, null]);
    expect(stats).toBe(1);
    result = { isFile: () => false };
    await stat('a');
    await stat('a');
    expect(stats).toBe(3);
    result = { isFile: () => true };
    await stat('a');
    await stat('a');
    expect(stats).toBe(4);
  });
});
