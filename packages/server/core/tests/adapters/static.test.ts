import os from 'node:os';
import path from 'node:path';
import type { ServerRoute } from '@modern-js/types';
import { fs } from '@modern-js/utils';
import { Hono } from 'hono';
import { createStaticMiddleware } from '../../src/adapters/node/plugins/static';

const jsContent = 'console.log("hello");\n'.repeat(100);

describe('static middleware', () => {
  let pwd: string;
  let hasSymlink = true;

  beforeAll(async () => {
    pwd = await fs.mkdtemp(path.join(os.tmpdir(), 'modern-static-'));
    await fs.outputFile(path.join(pwd, 'static/js/main.js'), jsContent);
    await fs.ensureDir(path.join(pwd, 'static/js/dir.js'));
    try {
      await fs.symlink(
        path.join(pwd, 'static/js/main.js'),
        path.join(pwd, 'static/js/link.js'),
      );
    } catch {
      // Platform without symlink permission (e.g. some Windows CI).
      hasSymlink = false;
    }
    await fs.outputFile(path.join(pwd, 'public/robots.txt'), 'robots');
    await fs.outputFile(path.join(pwd, 'public/docs.txt'), 'docs');
    await fs.outputFile(path.join(pwd, 'public/guide.txt'), 'guide');
  });

  afterAll(async () => {
    await fs.remove(pwd);
  });

  const createRoutes = (): ServerRoute[] => [
    { urlPath: '/', entryName: 'main', entryPath: 'html/main/index.html' },
    {
      urlPath: '/robots.txt',
      entryPath: 'public/robots.txt',
      isSSR: false,
      responseHeaders: { 'x-public': '1' },
    },
    { urlPath: '/docs', entryPath: 'public/docs.txt' },
    { urlPath: '/docs/guide', entryPath: 'public/guide.txt' },
    { urlPath: '/ssr', entryPath: 'public/robots.txt', isSSR: true },
  ];

  const createApp = (routes: ServerRoute[]) => {
    const app = new Hono();
    app.use(
      createStaticMiddleware({
        pwd,
        routes,
        output: {},
        html: {},
        server: {},
      }) as any,
    );
    app.all('*', c => c.text('fallback', 404));
    return app;
  };

  it('should serve public files with route headers', async () => {
    const app = createApp(createRoutes());
    const res = await app.request('/robots.txt');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('robots');
    expect(res.headers.get('content-type')).toMatch('text/plain');
    expect(res.headers.get('x-public')).toBe('1');
  });

  it('should match the longest public route first', async () => {
    const app = createApp(createRoutes());
    expect(await (await app.request('/docs/guide')).text()).toBe('guide');
    expect(await (await app.request('/docs/other')).text()).toBe('docs');
  });

  it('should ignore ssr routes and call next when no public route matches', async () => {
    const app = createApp(createRoutes());
    const ssr = await app.request('/ssr');
    expect(ssr.status).toBe(404);
    expect(await ssr.text()).toBe('fallback');
    const missing = await app.request('/missing.png');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('fallback');
  });

  it('should not mutate the shared routes array', async () => {
    const routes = createRoutes();
    const snapshot = [...routes];
    const app = createApp(routes);
    await app.request('/docs/guide');
    await app.request('/missing.png');
    expect(routes).toEqual(snapshot);
    routes.forEach((route, index) => {
      expect(route).toBe(snapshot[index]);
    });
  });

  it('should serve static files with content headers', async () => {
    const app = createApp(createRoutes());
    const res = await app.request('/static/js/main.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch('text/javascript');
    expect(res.headers.get('content-length')).toBe(
      String(Buffer.byteLength(jsContent)),
    );
    expect(await res.text()).toBe(jsContent);
  });

  it('should report the size of the symlink target', async ctx => {
    if (!hasSymlink) {
      ctx.skip();
    }
    const app = createApp(createRoutes());
    const res = await app.request('/static/js/link.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(
      String(Buffer.byteLength(jsContent)),
    );
    expect(await res.text()).toBe(jsContent);
  });

  it('should call next for missing static files and directories', async () => {
    const app = createApp(createRoutes());
    for (const pathname of ['/static/js/missing.js', '/static/js/dir.js']) {
      const res = await app.request(pathname);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-length')).toBeNull();
      expect(await res.text()).toBe('fallback');
    }
  });

  it('looks up matched static files through the extension stat, after containment', async () => {
    const looked: string[] = [];
    const hidden = path.join(pwd, 'static/js/main.js');
    const app = new Hono();
    app.use(
      createStaticMiddleware({
        pwd,
        routes: createRoutes(),
        output: {},
        html: {},
        server: {},
        stat: async filename => {
          looked.push(filename);
          return filename === hidden ? null : fs.stat(filename);
        },
      }) as any,
    );
    app.all('*', c => c.text('fallback', 404));
    await fs.outputFile(path.join(pwd, 'static/js/other.js'), jsContent);

    expect(await (await app.request('/static/js/main.js')).text()).toBe(
      'fallback',
    );
    const traversal = await app.request('/static/%2e%2e/%2e%2e/secret.js');
    expect(traversal.status).toBe(404);
    expect(looked).toEqual([hidden]);
    // The lookup only answers existence; native headers and body remain.
    const res = await app.request('/static/js/other.js');
    expect(res.headers.get('content-type')).toMatch('text/javascript');
    expect(res.headers.get('content-length')).toBe(
      String(Buffer.byteLength(jsContent)),
    );
    expect(await res.text()).toBe(jsContent);
    expect(looked).toEqual([hidden, path.join(pwd, 'static/js/other.js')]);
  });

  it('gates extension responders on the extension stat', async () => {
    const respondAsset = rstest.fn(() => undefined);
    const app = new Hono();
    app.use(
      createStaticMiddleware({
        pwd,
        routes: createRoutes(),
        output: {},
        html: {},
        server: {},
        stat: async () => null,
        respondAsset,
      }) as any,
    );
    app.all('*', c => c.text('fallback', 404));
    expect(await (await app.request('/static/js/main.js')).text()).toBe(
      'fallback',
    );
    expect(respondAsset).not.toHaveBeenCalled();
  });

  it('should only stat a cached static file once per request', async () => {
    const app = createApp(createRoutes());
    await app.request('/static/js/main.js');

    const stat = rstest.spyOn(fs, 'stat');
    const lstat = rstest.spyOn(fs, 'lstat');
    const pathExists = rstest.spyOn(fs, 'pathExists');
    try {
      const res = await app.request('/static/js/main.js');
      expect(await res.text()).toBe(jsContent);
      expect(stat).toHaveBeenCalledTimes(1);
      expect(lstat).not.toHaveBeenCalled();
      expect(pathExists).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      lstat.mockRestore();
      pathExists.mockRestore();
    }
  });
});
