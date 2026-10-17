import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileSystemRouteIR } from '@modern-js/renderer-core/data';
import { rspack } from '@rsbuild/core';
import {
  discoverNativeFileSystemRoutes,
  emitNativeApplicationModule,
} from '../../src/native-composition/native-routes';

describe('native filesystem route source emission', () => {
  const fixtures: string[] = [];
  afterEach(async () => {
    await Promise.all(
      fixtures
        .splice(0)
        .map(directory => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  async function fixture(files: readonly string[]) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ultramodern-native-routes-'),
    );
    fixtures.push(directory);
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(directory, file),
        'export default function NativeView() {}',
      );
    }
    return directory;
  }

  it('preserves layout hierarchy, pathless, dotted, optional, splat and native extension references', async () => {
    const routesDirectory = await fixture([
      'layout.tsrx',
      'layout.data.ts',
      'layout.head.ts',
      'page.tsrx',
      'page.search.ts',
      'page.head.ts',
      '__auth/layout.tsrx',
      '__auth/[id]$/page.tsrx',
      '__auth/[id$]/page.tsrx',
      'user.profile/page.tsrx',
      'user.profile/loading.tsrx',
      'user.profile/error.tsrx',
      'user.profile/not-found.tsrx',
      '$.tsrx',
      'assets/mark.svg',
      'components/Helper.tsx',
    ]);
    const [root] = await discoverNativeFileSystemRoutes({
      routesDirectory,
      entryName: 'admin',
      extensions: ['.tsrx', '.tsx', '.ts'],
    });
    expect(root).toMatchObject({ id: 'admin_layout', path: '/', isRoot: true });
    expect(root.file).toBe(path.join(routesDirectory, 'layout.tsrx'));
    expect(root.modules?.data).toBe(
      path.join(routesDirectory, 'layout.data.ts'),
    );
    expect(root.modules?.head).toBe(
      path.join(routesDirectory, 'layout.head.ts'),
    );
    expect(root.children.find(route => route.index)?.modules?.search).toBe(
      path.join(routesDirectory, 'page.search.ts'),
    );
    expect(root.children.find(route => route.index)?.modules?.head).toBe(
      path.join(routesDirectory, 'page.head.ts'),
    );
    const pathless = root.children.find(
      route => route.id === 'admin___auth/layout',
    )!;
    expect(pathless.path).toBeUndefined();
    expect(
      pathless.children.find(route => route.id === 'admin___auth/(id)$/layout'),
    ).toMatchObject({
      id: 'admin___auth/(id)$/layout',
      path: ':id?',
    });
    expect(
      pathless.children.find(route => route.id === 'admin___auth/(id$)/layout'),
    ).toMatchObject({
      id: 'admin___auth/(id$)/layout',
      path: ':id?',
    });
    const dotted = root.children.find(route => route.path === 'user/profile')!;
    expect(dotted.modules).toMatchObject({
      loading: path.join(routesDirectory, 'user.profile/loading.tsrx'),
      error: path.join(routesDirectory, 'user.profile/error.tsrx'),
      notFound: path.join(routesDirectory, 'user.profile/not-found.tsrx'),
    });
    expect(root.children.find(route => route.path === '*')).toMatchObject({
      id: 'admin_$',
    });
    expect(root.children).toHaveLength(4);
  });

  it('rejects ambiguous source modules instead of silently choosing one compiler input', async () => {
    const routesDirectory = await fixture([
      'layout.tsx',
      'page.tsx',
      'page.tsrx',
    ]);
    await expect(
      discoverNativeFileSystemRoutes({
        routesDirectory,
        entryName: 'main',
        extensions: ['.tsx', '.tsrx'],
      }),
    ).rejects.toThrow('Ambiguous native route module');
  });

  it('rejects unsupported static optional notation before emitting a literal question-mark route', async () => {
    const routesDirectory = await fixture(['layout.tsx', 'product$/page.tsx']);
    await expect(
      discoverNativeFileSystemRoutes({
        routesDirectory,
        entryName: 'main',
        extensions: ['.tsx', '.ts'],
      }),
    ).rejects.toThrow('require a bracketed parameter: product$');
  });

  it('separates server data source from the client graph and preserves native data authorization metadata', async () => {
    const routesDirectory = await fixture([
      'layout.tsx',
      'page.tsx',
      'page.data.ts',
      'page.head.ts',
      'not-found.tsx',
      '[product]/page.tsx',
      '[product]/page.data.ts',
      '[product]/page.data.client.ts',
    ]);
    const routes = await discoverNativeFileSystemRoutes({
      routesDirectory,
      entryName: 'main',
      extensions: ['.tsx', '.ts'],
    });
    const client = emitNativeApplicationModule({
      routes,
      mode: 'client',
      basePath: '/admin',
    });
    const server = emitNativeApplicationModule({
      routes,
      mode: 'server',
      basePath: '/admin',
    });
    expect(client).not.toContain(
      JSON.stringify(path.join(routesDirectory, 'page.data.ts')),
    );
    expect(client).not.toContain(
      JSON.stringify(path.join(routesDirectory, '[product]/page.data.ts')),
    );
    expect(client).toContain(
      JSON.stringify(
        path.join(routesDirectory, '[product]/page.data.client.ts'),
      ),
    );
    expect(client).toContain('server-data:page');
    expect(client).toContain(
      'export const serverDataRoutes = ["page","(product)/page"];',
    );
    expect(server).toContain(
      JSON.stringify(path.join(routesDirectory, 'page.data.ts')),
    );
    // Server structure names the client loader file but never imports it.
    expect(server).not.toContain(
      `from ${JSON.stringify(path.join(routesDirectory, '[product]/page.data.client.ts'))}`,
    );
    expect(server).not.toContain('serverDataRoutes');
    for (const source of [client, server]) {
      expect(source).toContain('export const basePath = "/admin";');
      expect(source).toMatch(/notFoundComponent: routeModule\d+/u);
      expect(source).toMatch(/head: routeModule\d+/u);
      // The application module carries data and imports, never runtime code.
      expect(source).not.toMatch(/@modern-js|function |=>/u);
    }
  });

  it('keeps prototype-named route ids as own route map entries', async () => {
    const routes: FileSystemRouteIR[] = [
      {
        id: '__proto__',
        file: '/app/proto.tsx',
        modules: { data: '/app/proto.data.ts' },
        children: [],
      },
      { id: 'constructor', file: '/app/constructor.tsx', children: [] },
    ];
    const { code } = await rspack.experiments.swc.transform(
      emitNativeApplicationModule({ routes, mode: 'server', basePath: '/' }),
      {
        jsc: { parser: { syntax: 'ecmascript' }, target: 'es2022' },
        module: { type: 'commonjs' },
      },
    );
    const sources: Record<string, unknown> = {
      '/app/proto': { __esModule: true, default: 'ProtoView' },
      '/app/proto.data': { __esModule: true, loader: 'protoLoader' },
      '/app/constructor': { __esModule: true, default: 'ConstructorView' },
    };
    const application: Record<string, any> = {};
    new Function('require', 'exports', code)((name: string) => {
      if (name in sources) return sources[name];
      throw new Error(`Unexpected generated import: ${name}`);
    }, application);
    expect(Object.keys(application.routeModules)).toEqual([
      '__proto__',
      'constructor',
    ]);
    expect(Object.getPrototypeOf(application.routeModules)).toBeNull();
    const own = (map: object) =>
      Object.getOwnPropertyDescriptor(map, '__proto__')?.value;
    expect(own(application.routeModules).component).toBe(sources['/app/proto']);
    expect(Object.keys(application.dataModules)).toEqual(['__proto__']);
    expect(own(application.dataModules)).toBe(sources['/app/proto.data']);
    // A route without data finds nothing, not an Object.prototype member.
    expect(application.dataModules.constructor).toBeUndefined();
  });

  it.each(['client', 'server'] as const)(
    'emits bundler-resolvable TypeScript requests while retaining %s source identities',
    mode => {
      const routes = [
        {
          id: 'layout',
          file: '/source/routes/layout.tsx',
          modules: {
            head: '/source/routes/page.head.ts',
            search: '/source/routes/page.head.ts',
            data: '/source/routes/page.data.ts',
            clientData: '/source/routes/page.data.client.ts',
            loading: '/source/routes/loading.tsrx',
          },
          children: [],
        },
      ];
      const source = emitNativeApplicationModule({
        routes,
        mode,
        basePath: '/',
      });
      expect(source).toContain(
        'import * as routeModule0 from "/source/routes/layout";',
      );
      expect(source).toContain(
        'import * as routeModule1 from "/source/routes/loading.tsrx";',
      );
      expect(source).toContain(
        'import * as routeModule2 from "/source/routes/page.head";',
      );
      expect(
        source.match(/from "\/source\/routes\/page\.head";/gu),
      ).toHaveLength(1);
      expect(source).toContain(
        `import * as routeModule3 from "/source/routes/page.data${mode === 'client' ? '.client' : ''}";`,
      );
      expect(source).not.toMatch(/from "[^"\n]+\.tsx?"/u);
      // Route provenance keeps the selected files. Only executable requests use
      // bundler resolution, without opting applications into TS extension imports.
      expect(source).toContain('"file": "/source/routes/layout.tsx"');
      expect(source).toContain('"head": "/source/routes/page.head.ts"');
      expect(source).toContain('"loading": "/source/routes/loading.tsrx"');
      if (mode === 'client') {
        expect(source).toContain('"data": "server-data:layout"');
        expect(source).not.toContain('from "/source/routes/page.data"');
      }
    },
  );

  it('rejects an application module without its analyzed base path', () => {
    expect(() =>
      emitNativeApplicationModule({ routes: [], mode: 'server', basePath: '' }),
    ).toThrow('analyzed public base path');
  });
});
