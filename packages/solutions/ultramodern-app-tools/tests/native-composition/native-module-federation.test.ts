import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rspack } from '@rsbuild/core';
import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import { resolveRendererFederationCompatibility } from '../../src/native-composition/module-federation-renderer-plugin';
import {
  createNativeClientFederationOptions,
  createNativeRuntimeRemotes,
  createNativeServerFederationOptions,
  createNativeSharedConfig,
  findNativeFederationConfig,
  loadNativeFederationConfig,
  NATIVE_FEDERATION_HYDRATION_MODULE,
  NativeFederationDevOriginPlugin,
  NativeFederationSharedOwnersPlugin,
  nativeFederationHydrationSource,
  nativeFederationRuntimePluginSource,
  nativeModuleFederationPlugin,
  readNativeFederationRemotes,
  resolveNativeSharedBindings,
  resolveNativeSharedVersions,
  sharedPackageName,
  withNativeServerContainer,
} from '../../src/native-composition/native-module-federation';
import { assertCapturedRenderer } from '../../src/native-composition/renderer-selection';
import { resolveManifestRecoveryRuntimePlugin } from '../../src/renderers/react/module-federation-recovery-plugin';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mf-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

const manifestRemote = 'remote@https://remote.example/mf-manifest.json';
const nativeRenderers = ['solid', 'octane'] as const;
type NativeRenderer = (typeof nativeRenderers)[number];

describe('native Module Federation configuration', () => {
  it('finds exactly one module-federation config file', () => {
    expect(findNativeFederationConfig(app({}))).toBeUndefined();
    const root = app({ 'module-federation.config.ts': 'export default {}' });
    expect(findNativeFederationConfig(root)).toBe(
      path.join(root, 'module-federation.config.ts'),
    );
    expect(() =>
      findNativeFederationConfig(
        app({
          'module-federation.config.ts': '',
          'module-federation.config.mjs': '',
        }),
      ),
    ).toThrow('choose one configuration file');
  });

  it('loads TypeScript options and rejects renderer-owned options', async () => {
    const root = app({
      'module-federation.config.ts': `const name: string = 'host';
export default { name, remotes: { remote: '${manifestRemote}' } };`,
      'owned.mjs': `export default { name: 'host', library: { type: 'var' } };`,
      'startup.mjs': `export default { name: 'host', experiments: { asyncStartup: false } };`,
      'nameless.mjs': 'export default {};',
      'direct.mjs': `export default { name: 'host', remotes: { remote: 'remote@https://remote.example/remoteEntry.js' } };`,
    });
    await expect(
      loadNativeFederationConfig(
        path.join(root, 'module-federation.config.ts'),
      ),
    ).resolves.toEqual({ name: 'host', remotes: { remote: manifestRemote } });
    await expect(
      loadNativeFederationConfig(path.join(root, 'owned.mjs')),
    ).rejects.toThrow('library is owned by the native renderer');
    await expect(
      loadNativeFederationConfig(path.join(root, 'startup.mjs')),
    ).rejects.toThrow('asyncStartup is owned');
    await expect(
      loadNativeFederationConfig(path.join(root, 'nameless.mjs')),
    ).rejects.toThrow('container name');
    await expect(
      loadNativeFederationConfig(path.join(root, 'direct.mjs')),
    ).rejects.toThrow('must name its native manifest');
  });

  it('reads manifest remotes in record, object and array form', () => {
    expect(
      readNativeFederationRemotes({
        remotes: {
          remote: manifestRemote,
          catalog: { name: 'catalog', entry: '/catalog/mf-manifest.json' },
        },
      }),
    ).toEqual({
      remote: manifestRemote,
      catalog: 'catalog@/catalog/mf-manifest.json',
    });
    expect(readNativeFederationRemotes({ remotes: [manifestRemote] })).toEqual({
      remote: manifestRemote,
    });
  });

  it('keeps a prototype-named shared package as an own registration', () => {
    const versions = resolveNativeSharedVersions(
      'solid',
      path.resolve(__dirname, '../..'),
    );
    for (const shared of [
      ['__proto__'],
      { ['__proto__']: { singleton: true } },
    ]) {
      const result = createNativeSharedConfig('solid', shared, versions);
      expect(Object.hasOwn(result, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(Object.keys(result)).toContain('__proto__');
    }
  });

  it('keeps a prototype-named remote alias as an own registration', () => {
    const remote = '__proto__@https://remote.test/mf-manifest.json';
    for (const remotes of [
      [remote],
      JSON.parse(`{"__proto__": ${JSON.stringify(remote)}}`),
    ]) {
      const result = readNativeFederationRemotes({ remotes });
      expect(Object.keys(result)).toEqual(['__proto__']);
      expect(createNativeRuntimeRemotes(result)).toEqual([
        {
          name: '__proto__',
          alias: '__proto__',
          entry: 'https://remote.test/mf-manifest.json',
        },
      ]);
    }
  });

  const versions = (renderer: NativeRenderer = 'solid') =>
    resolveNativeSharedVersions(renderer, path.resolve(__dirname, '../..'));

  it.each(['client', 'server'] as const)(
    'keeps %s native serializer resolution outside global federation aliases',
    environment => {
      const bindings = resolveNativeSharedBindings(
        'solid',
        path.resolve(__dirname, '../..'),
        environment,
      );
      for (const name of ['seroval', 'seroval-plugins']) {
        expect(bindings.aliases).not.toHaveProperty(`${name}$`);
        expect(bindings.imports).not.toHaveProperty(name);
        expect(bindings.versions).not.toHaveProperty(name);
      }
      expect(bindings.versions['solid-js']).toBe('2.0.0-rc.15');
      expect(bindings.versions['@solidjs/web']).toBe('2.0.0-rc.15');
      expect(bindings.aliases['@solidjs/web$']).toBe(
        bindings.imports['@solidjs/web'],
      );
    },
  );

  it.each(nativeRenderers)(
    '%s pins singletons to installed versions, not manifest ranges',
    renderer => {
      expect(sharedPackageName('@modern-js/renderer-core/')).toBe(
        '@modern-js/renderer-core',
      );
      expect(sharedPackageName('solid-js')).toBe('solid-js');
      const installed = versions(renderer);
      const runtime = renderer === 'solid' ? 'solid-js' : 'octane';
      expect(installed[runtime]).toBe(
        renderer === 'solid' ? '2.0.0-rc.15' : '0.13.8',
      );
      expect(installed['@modern-js/renderer-core/']).toMatch(/^\d+\.\d+\.\d+/u);
      expect(() => resolveNativeSharedVersions(renderer, os.tmpdir())).toThrow(
        'cannot find the installed',
      );
    },
  );

  it.each(nativeRenderers)(
    'owns %s runtime singletons and keeps authored shares',
    renderer => {
      const runtime = renderer === 'solid' ? 'solid-js' : 'octane';
      const shared = createNativeSharedConfig(
        renderer,
        { lodash: {} },
        versions(renderer),
      );
      expect(shared.lodash).toEqual({});
      expect(shared[runtime]).toEqual({
        singleton: true,
        strictVersion: true,
        requiredVersion: versions(renderer)[runtime],
        version: versions(renderer)[runtime],
        eager: false,
      });
      expect(() =>
        createNativeSharedConfig(
          renderer,
          { [runtime]: { singleton: false } },
          versions(renderer),
        ),
      ).toThrow(`${runtime} is a ${renderer} runtime singleton`);
    },
  );

  it('shares the Octane compiler entries and SDK contexts with the host', () => {
    const installed = versions('octane');
    const shared = createNativeSharedConfig('octane', undefined, installed);
    for (const key of [
      'octane',
      'octane/',
      'octane/server',
      'octane/internal/client',
      'octane/internal/server',
      'octane/internal/context',
      'octane/signals',
      'octane/hydration/streamed-signals',
      'octane/internal/signal-read',
      'octane/signals/client',
      'octane/signals/server',
      'octane/profiling',
      '@modern-js/renderer-octane/client',
      '@octanejs/tanstack-router',
      '@octanejs/tanstack-router/',
      '@modern-js/renderer-octane',
      '@modern-js/renderer-octane/',
      '@modern-js/renderer-octane/router',
      '@modern-js/renderer-octane/federation',
      '@modern-js/renderer-core',
      '@modern-js/renderer-core/',
      '@tanstack/router-core',
      '@tanstack/history',
    ]) {
      expect(shared[key]).toEqual({
        singleton: true,
        strictVersion: true,
        requiredVersion: installed[key],
        version: installed[key],
        eager: false,
      });
    }
    expect(installed['@tanstack/router-core']).toBe('1.171.34');
    expect(installed['@tanstack/history']).toBe('1.162.4');
    // Localization is optional; its context belongs to the shared SDK prefix.
    expect(shared.i18next).toBeUndefined();
    expect(shared['@modern-js/i18n-runtime-extensions']).toBeUndefined();
    const server = createNativeSharedConfig(
      'octane',
      undefined,
      installed,
      undefined,
      'server',
    );
    const client = createNativeSharedConfig(
      'octane',
      undefined,
      installed,
      undefined,
      'client',
    );
    expect(server['@modern-js/renderer-octane/client']).toBeUndefined();
    expect(server['octane/signals/client']).toBeUndefined();
    expect(client['octane/signals/server']).toBeUndefined();
    expect(client['octane/internal/server']).toBeUndefined();
    for (const key of [
      '@modern-js/renderer-octane/i18n',
      '@octanejs/tanstack-router/ssr/server',
      'octane/signals/server',
    ]) {
      expect(() =>
        createNativeSharedConfig(
          'octane',
          { [key]: { singleton: false } },
          installed,
        ),
      ).toThrow(`${key} is a octane runtime singleton`);
    }
  });

  it('pins Octane shares to its selected owners when the consumer has foreign copies', () => {
    const root = app({
      'package.json': '{}',
      ...Object.fromEntries(
        ['octane', '@tanstack/router-core', '@tanstack/history', 'seroval'].map(
          name => [
            `node_modules/${name}/package.json`,
            JSON.stringify({
              name,
              version: '99.0.0',
              exports: {
                '.': './foreign.js',
                './foreign': './foreign.js',
              },
            }),
          ],
        ),
      ),
    });
    fs.mkdirSync(path.join(root, 'node_modules/@modern-js'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.resolve(__dirname, '../../../../runtime/renderer-octane'),
      path.join(root, 'node_modules/@modern-js/renderer-octane'),
    );
    const installed = resolveNativeSharedVersions('octane', root);
    expect(installed.octane).toBe('0.13.8');
    expect(installed['@tanstack/router-core']).toBe('1.171.34');
    expect(installed['@tanstack/history']).toBe('1.162.4');
    expect(installed.seroval).toBe('1.6.9');
    const bindings = resolveNativeSharedBindings('octane', root, 'server');
    const selected = fs.realpathSync(
      path.resolve(
        __dirname,
        '../../../../runtime/renderer-octane/node_modules/octane',
      ),
    );
    expect(bindings.imports.octane).toBe(
      path.join(selected, 'dist/node/server/index.js'),
    );
    expect(bindings.imports['octane/signals/server']).toBe(
      path.join(selected, 'dist/node/signals/server.js'),
    );
    for (const imported of Object.values(bindings.imports)) {
      expect(imported.startsWith(root)).toBe(false);
      expect(imported).not.toContain('/dist/cjs/');
    }
    expect(bindings.aliases['octane/foreign$']).toBeUndefined();
    expect(bindings.aliases['octane/jsx-runtime$']).toBeUndefined();
    const shared = createNativeSharedConfig(
      'octane',
      undefined,
      bindings.versions,
      bindings,
      'server',
    );
    expect(shared['octane/signals/server']).toMatchObject({
      import: bindings.imports['octane/signals/server'],
      version: installed.octane,
    });
  });

  it('resolves canonical SDK shares through a published npm alias owner', async () => {
    const owner = 'node_modules/@modern-js/renderer-octane';
    const root = app({
      [`${owner}/package.json`]: JSON.stringify({
        name: '@bleedingdev/modern-js-renderer-octane',
        version: '3.8.3',
        type: 'module',
        exports: Object.fromEntries(
          ['.', './router', './federation', './client'].map(key => [
            key,
            { import: './published.mjs' },
          ]),
        ),
      }),
      [`${owner}/published.mjs`]:
        'export const selected = "published-alias-owner";',
    });
    fs.symlinkSync(
      path.resolve(
        __dirname,
        '../../../../runtime/renderer-octane/node_modules',
      ),
      path.join(root, owner, 'node_modules'),
    );
    const bindings = resolveNativeSharedBindings('octane', root, 'client');
    for (const request of [
      '@modern-js/renderer-octane',
      '@modern-js/renderer-octane/router',
      '@modern-js/renderer-octane/federation',
      '@modern-js/renderer-octane/client',
    ]) {
      expect(bindings.imports[request]).toBe(
        fs.realpathSync(path.join(root, owner, 'published.mjs')),
      );
      expect(bindings.aliases[`${request}$`]).toBe(bindings.imports[request]);
    }
    expect(
      (
        await import(
          pathToFileURL(bindings.imports['@modern-js/renderer-octane']).href
        )
      ).selected,
    ).toBe('published-alias-owner');
  });

  it('uses one selected native server hook scope across all required providers', async () => {
    const bindings = resolveNativeSharedBindings(
      'octane',
      path.resolve(__dirname, '../..'),
      'server',
    );
    const server = await import(pathToFileURL(bindings.imports.octane).href);
    const internal = await import(
      pathToFileURL(bindings.imports['octane/internal/server']).href
    );
    const signals = await import(
      pathToFileURL(bindings.imports['octane/signals/server']).href
    );
    internal.enableServerSignalBindings();
    const slot = server.hookSlots(1);
    expect(
      server.renderToString(() => {
        internal.beginNativeReadScope(undefined, 1);
        return signals.useSignal$('selected-native-owner', slot).get();
      }).html,
    ).toBe('selected-native-owner');
    const client = resolveNativeSharedBindings(
      'octane',
      path.resolve(__dirname, '../..'),
      'client',
    );
    const selected = fs.realpathSync(
      path.resolve(
        __dirname,
        '../../../../runtime/renderer-octane/node_modules/octane',
      ),
    );
    expect(client.imports['octane/signals/client']).toBe(
      path.join(selected, 'dist/signals/client.js'),
    );
    expect(client.imports.octane).toBe(path.join(selected, 'dist/index.js'));
    expect(client.imports['octane/signals/server']).toBeUndefined();
  });

  it('keeps prefix consumption on selected physical bytes despite broad foreign aliases', async () => {
    const root = app({
      'package.json': '{}',
      'node_modules/octane/package.json': JSON.stringify({
        name: 'octane',
        version: '99.0.0',
        exports: { './profiling': './foreign.js', './foreign': './foreign.js' },
      }),
      'node_modules/octane/foreign.js': 'export const foreign = true;',
    });
    fs.mkdirSync(path.join(root, 'node_modules/@modern-js'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.resolve(__dirname, '../../../../runtime/renderer-octane'),
      path.join(root, 'node_modules/@modern-js/renderer-octane'),
    );
    const bindings = resolveNativeSharedBindings('octane', root, 'client');
    const foreign = path.join(root, 'node_modules/octane');
    const compile = async (request: string, commonjs = false) => {
      const compiler = rspack({
        mode: 'none',
        context: root,
        target: 'web',
        entry: `data:text/javascript,${commonjs ? `const api=require(${JSON.stringify(request)});` : `import * as api from ${JSON.stringify(request)};`}globalThis.__nativeProvider=api;`,
        module: { rules: [{ scheme: 'data', type: 'javascript/auto' }] },
        resolve: {
          alias: { octane: foreign },
          byDependency: {
            esm: { alias: { octane: foreign } },
            commonjs: { alias: { octane: foreign } },
          },
        },
        plugins: [
          new rspack.sharing.SharePlugin({
            shared: {
              'octane/': {
                singleton: true,
                strictVersion: true,
                requiredVersion: bindings.versions['octane/'],
                version: bindings.versions['octane/'],
              },
            },
          }),
          new NativeFederationSharedOwnersPlugin(
            'octane',
            root,
            'client',
            bindings,
          ),
          {
            apply(compiler) {
              compiler.hooks.shouldEmit.tap('no-test-output', () => false);
            },
          },
        ],
      });
      try {
        const stats = await new Promise<any>((resolve, reject) =>
          compiler.run((error, stats) =>
            error ? reject(error) : resolve(stats),
          ),
        );
        return {
          errors: stats.toJson({ all: false, errors: true }).errors,
          modules: [...stats.compilation.modules].map(module =>
            module.identifier(),
          ),
        };
      } finally {
        await new Promise<void>((resolve, reject) =>
          compiler.close(error => (error ? reject(error) : resolve())),
        );
      }
    };
    for (const commonjs of [false, true]) {
      const valid = await compile('octane/profiling', commonjs);
      expect(valid.errors).toEqual([]);
      expect(valid.modules).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^consume shared module \(default\) octane\/profiling@/u,
          ),
        ]),
      );
      expect(valid.modules).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^provide shared module \(default\) octane\/profiling@/u,
          ),
        ]),
      );
      expect(
        valid.modules.some(module =>
          module.includes(bindings.imports['octane/profiling']),
        ),
      ).toBe(true);
      expect(valid.modules.some(module => module.includes(foreign))).toBe(
        false,
      );
    }
    const unknown = await compile('octane/foreign');
    expect(unknown.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            'singleton octane/foreign has no runtime export in its selected owner',
          ),
        }),
      ]),
    );
    expect(unknown.modules.some(module => module.includes(foreign))).toBe(
      false,
    );
  });

  it.each(nativeRenderers)(
    '%s publishes an ESM container with a bootstrap startup',
    renderer => {
      const options = createNativeClientFederationOptions(
        renderer,
        { name: 'remote', exposes: { './Widget': './src/Widget.tsx' } },
        versions(renderer),
      );
      expect(options).toMatchObject({
        name: 'remote',
        filename: 'remoteEntry.js',
        library: { type: 'module' },
        runtime: false,
        shareStrategy: 'loaded-first',
        manifest: true,
        dts: false,
        experiments: { asyncStartup: false },
      });
    },
  );

  it.each(nativeRenderers)(
    '%s treats an empty exposes as a host without a server container',
    renderer => {
      for (const exposes of [{}, []])
        expect(
          createNativeClientFederationOptions(
            renderer,
            { name: 'host', exposes },
            versions(renderer),
            undefined,
            'bundles',
          ).manifest,
        ).toBe(true);
      expect(
        createNativeClientFederationOptions(
          renderer,
          { name: 'remote', exposes: { './Widget': './src/Widget.tsx' } },
          versions(renderer),
          undefined,
          'bundles',
        ).manifest,
      ).toMatchObject({ additionalData: expect.any(Function) });
    },
  );

  it.each(nativeRenderers)(
    '%s publishes a Node container whose shares wait for the host scope',
    renderer => {
      const options = createNativeServerFederationOptions(
        renderer,
        {
          name: 'remote',
          exposes: { './Widget': './src/Widget.tsx' },
          remotes: { other: manifestRemote },
        },
        versions(renderer),
        ['/node/runtimePlugin.js', '/generated/native-runtime.server.mjs'],
      );
      expect(options).toMatchObject({
        name: 'remote',
        filename: 'remoteEntry.js',
        library: { type: 'commonjs-module', name: 'remote' },
        remoteType: 'script',
        shareStrategy: 'loaded-first',
        manifest: true,
        dts: false,
        runtimePlugins: [
          resolveManifestRecoveryRuntimePlugin(import.meta.url),
          '/node/runtimePlugin.js',
          '/generated/native-runtime.server.mjs',
        ],
        experiments: { asyncStartup: false, optimization: { target: 'node' } },
      });
      expect(options.remotes).toBeUndefined();
      expect(
        (options.shared as Record<string, any>)[
          renderer === 'solid' ? 'solid-js' : 'octane'
        ],
      ).toMatchObject({
        singleton: true,
        eager: false,
      });
    },
  );

  it.each(
    nativeRenderers.flatMap(renderer =>
      ['string', 'tuple'].map(form => ({ renderer, form })),
    ),
  )(
    'rejects $form duplicate manifest recovery for $renderer',
    ({ renderer, form }) => {
      const recovery = resolveManifestRecoveryRuntimePlugin(import.meta.url);
      expect(() =>
        createNativeServerFederationOptions(
          renderer,
          {
            name: 'host',
            runtimePlugins: [form === 'tuple' ? [recovery, {}] : recovery],
          },
          versions(renderer),
          ['/node/runtimePlugin.js'],
        ),
      ).toThrow('manifest recovery has duplicate registration ownership');
    },
  );

  it('names the server container in the browser manifest', async () => {
    const manifest = withNativeServerContainer(
      {
        additionalData: ({ stats }: { stats: any }) => ({
          ...stats,
          authored: true,
        }),
      },
      'bundles',
      'remoteEntry.js',
    );
    const stats = await (manifest.additionalData as any)({
      stats: { metaData: { publicPath: 'https://remote.example/' } },
    });
    expect(stats).toEqual({
      authored: true,
      metaData: {
        publicPath: 'https://remote.example/',
        ssrPublicPath: 'https://remote.example/bundles/',
        ssrRemoteEntry: {
          name: 'remoteEntry.js',
          path: '',
          type: 'commonjs-module',
        },
      },
    });
    expect(() => withNativeServerContainer(false, 'bundles', 'r.js')).toThrow(
      'native manifest publication',
    );
    const client = createNativeClientFederationOptions(
      'solid',
      { name: 'remote', exposes: { './Widget': './src/Widget.tsx' } },
      versions(),
      undefined,
      'bundles',
    );
    expect(typeof (client.manifest as any).additionalData).toBe('function');
  });

  it('bounds native server HTTP headers and bodies and preserves caller aborts', async () => {
    const file = path.join(app({}), 'native-server-transport.mjs');
    fs.writeFileSync(
      file,
      nativeFederationRuntimePluginSource([], {
        // Long enough for a cold runner's first connection to answer /ok;
        // /hang and /body still exceed it.
        requestTimeout: 1_000,
      }),
    );
    const { default: createPlugin } = await import(pathToFileURL(file).href);
    const plugin = createPlugin();
    const server = createServer((request, response) => {
      if (request.url === '/hang') return;
      if (request.url === '/body') {
        response.writeHead(200);
        response.flushHeaders();
        return;
      }
      if (request.url === '/status') {
        response.writeHead(503).end('SSR container unavailable');
        return;
      }
      response.end('native response');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing test server address');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await expect((await plugin.fetch(`${origin}/ok`)).text()).resolves.toBe(
        'native response',
      );
      await expect(plugin.fetch(`${origin}/status`)).rejects.toMatchObject({
        status: 503,
      });
      await expect(plugin.fetch(`${origin}/hang`)).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      const body = await plugin.fetch(`${origin}/body`);
      await expect(body.text()).rejects.toMatchObject({ name: 'TimeoutError' });
      const controller = new AbortController();
      const reason = new Error('caller stopped');
      controller.abort(reason);
      await expect(
        plugin.fetch(`${origin}/hang`, { signal: controller.signal }),
      ).rejects.toBe(reason);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });

  it('keeps the native browser runtime off the server fetch transport', async () => {
    const file = path.join(app({}), 'native-client-transport.mjs');
    fs.writeFileSync(file, nativeFederationRuntimePluginSource([]));
    const { default: createPlugin } = await import(pathToFileURL(file).href);
    expect(createPlugin().fetch).toBeUndefined();
    expect(() =>
      nativeFederationRuntimePluginSource([], { requestTimeout: 0 }),
    ).toThrow('server requestTimeout must be a positive integer');
  });

  it('hydrates a remote through the host the server document names', async () => {
    const file = path.join(app({}), NATIVE_FEDERATION_HYDRATION_MODULE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, nativeFederationHydrationSource);
    const host = (name: string) => ({
      name,
      loadRemote: rstest.fn(async () => ({ default: () => name })),
    });
    const first = host('first');
    const second = host('second');
    const globals = globalThis as { __FEDERATION__?: unknown };
    const previous = globals.__FEDERATION__;
    // Two co-located hosts in one realm, as Module Federation registers them.
    globals.__FEDERATION__ = { __INSTANCES__: [first, second] };
    try {
      const module = await import(
        `${pathToFileURL(file).href}?id=remote%2FWidget&host=second`
      );
      expect(module.default()).toBe('second');
      expect(second.loadRemote).toHaveBeenCalledWith('remote/Widget');
      expect(first.loadRemote).not.toHaveBeenCalled();
      await expect(
        import(`${pathToFileURL(file).href}?id=remote%2FWidget&host=missing`),
      ).rejects.toThrow('the missing federation runtime has not started');
    } finally {
      globals.__FEDERATION__ = previous;
    }
  });
});

describe('native Module Federation plugin', () => {
  type Hook = (...args: any[]) => any;
  function setup(
    renderer: 'solid' | 'octane',
    appDirectory: string,
    config: Record<string, unknown> = {},
    context: Record<string, unknown> = {},
  ) {
    const hooks: Record<string, Hook> = {};
    const internalDirectory = path.join(
      appDirectory,
      'node_modules/.modern-js',
    );
    const api = new Proxy(
      {
        getAppContext: () => ({ appDirectory, internalDirectory, ...context }),
        getNormalizedConfig: () => config,
      },
      {
        get: (target, key: string) =>
          key in target
            ? target[key as keyof typeof target]
            : (hook: Hook) => {
                hooks[key] = hook;
              },
      },
    );
    nativeModuleFederationPlugin(renderer).setup!(api as never);
    return hooks;
  }

  function chain(entries: Record<string, string[]> = {}) {
    const uses: unknown[][] = [];
    const entry = (name: string) => ({
      values: () => entries[name],
      clear: () => {
        entries[name] = [];
      },
      add: (value: string) => entries[name].push(value),
    });
    return {
      uses,
      entries,
      chain: {
        plugin: (key: string) => ({
          use: (Plugin: unknown, args: unknown[]) =>
            uses.push([key, Plugin, args]),
        }),
        target: (value: string) => uses.push(['target', value]),
        entryPoints: { entries: () => ({ ...entries }) },
        entry,
      },
    };
  }

  function installPackages(
    root: string,
    node = false,
    renderer: NativeRenderer = 'solid',
  ) {
    const enhanced = path.join(
      root,
      'node_modules/@module-federation/enhanced',
    );
    fs.mkdirSync(enhanced, { recursive: true });
    fs.writeFileSync(
      path.join(enhanced, 'package.json'),
      JSON.stringify({
        name: '@module-federation/enhanced',
        exports: { './rspack': './rspack.cjs' },
      }),
    );
    fs.writeFileSync(
      path.join(enhanced, 'rspack.cjs'),
      'exports.ModuleFederationPlugin = class ModuleFederationPlugin {};',
    );
    if (node) {
      const directory = path.join(root, 'node_modules/@module-federation/node');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({
          name: '@module-federation/node',
          exports: { './runtimePlugin': './runtimePlugin.js' },
        }),
      );
      fs.writeFileSync(path.join(directory, 'runtimePlugin.js'), '');
    }
    fs.mkdirSync(path.join(root, 'node_modules/@modern-js'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.resolve(__dirname, `../../../../runtime/renderer-${renderer}`),
      path.join(root, `node_modules/@modern-js/renderer-${renderer}`),
    );
  }

  it.each(nativeRenderers)(
    'installs a Node container on an SSR %s host',
    async renderer => {
      const root = app({
        'package.json': '{}',
        'module-federation.config.mjs': `export default { name: 'host', remotes: { remote: '${manifestRemote}' } };`,
      });
      installPackages(root, true, renderer);
      const hooks = setup(renderer, root, { server: { ssr: true } });
      const server = chain();
      await hooks.modifyBundlerChain(server.chain, {
        environment: { name: 'server' },
      });
      expect(server.uses).toContainEqual(['target', 'async-node']);
      const [, , [options]] = server.uses.find(
        ([key]) => key === 'plugin-module-federation',
      ) as [string, unknown, [any]];
      expect(options.library).toEqual({
        type: 'commonjs-module',
        name: 'host',
      });
      expect(options.runtimePlugins).toEqual([
        resolveManifestRecoveryRuntimePlugin(import.meta.url),
        fs.realpathSync(
          path.join(
            root,
            'node_modules/@module-federation/node/runtimePlugin.js',
          ),
        ),
        path.join(
          root,
          'node_modules/.modern-js/federation/native-runtime.server.mjs',
        ),
      ]);
      // The client emits the hydration module the server document names.
      const client = chain();
      await hooks.modifyBundlerChain(client.chain, {
        environment: { name: 'client' },
      });
      expect(client.uses.map(([name]) => name)).toEqual([
        'ultramodern-federation-shared-owners',
        'plugin-module-federation',
        'ultramodern-federation-hydration-module',
      ]);
      // Server assets keep the client public path; the container gets its own.
      const config: any = { output: { publicPath: '/' } };
      await hooks.modifyRspackConfig(config, {
        environment: { name: 'server' },
      });
      expect(config.output.publicPath).toBe('/bundles/');
      expect(config.module.generator['asset/resource'].publicPath).toBe('/');
    },
  );

  it.each([
    { name: 'host', remotes: { remote: manifestRemote } },
    { name: 'remote', exposes: { './Widget': './src/Widget.tsrx' } },
  ])(
    'publishes only browser containers for a native Worker $name',
    async authored => {
      const root = app({
        'package.json': '{}',
        'module-federation.config.mjs': `export default ${JSON.stringify(authored)};`,
      });
      // Workers have their own static expose registry and service bindings.
      // Neither the native Worker compiler nor the unused Node compilation
      // should resolve @module-federation/node or load remote Node containers.
      installPackages(root, false, 'octane');
      const hooks = setup('octane', root, {
        deploy: { target: 'cloudflare', worker: { ssr: true } },
        server: { ssr: true },
      });
      const client = chain();
      await hooks.modifyBundlerChain(client.chain, {
        environment: { name: 'client' },
      });
      expect(client.uses.map(([name]) => name)).toEqual([
        'ultramodern-federation-shared-owners',
        'plugin-module-federation',
      ]);
      const [, , [options]] = client.uses.find(
        ([key]) => key === 'plugin-module-federation',
      ) as [string, unknown, [any]];
      expect(options.name).toBe(authored.name);
      expect(options.exposes).toEqual(authored.exposes);
      expect(options.library).toEqual({ type: 'module' });
      // No ssrRemoteEntry/ssrPublicPath advertises a nonexistent Node container.
      expect(options.manifest).toBe(true);
      expect(options.runtimePlugins).toEqual([
        path.join(
          root,
          'node_modules/.modern-js/federation/native-runtime.mjs',
        ),
      ]);
      for (const name of ['workerSSR', 'server']) {
        const compiler = chain();
        await hooks.modifyBundlerChain(compiler.chain, {
          environment: { name },
        });
        expect(compiler.uses).toEqual([]);
        const config = { output: { publicPath: '/' } };
        await hooks.modifyRspackConfig(config, {
          environment: { name },
        });
        expect(config).toEqual({ output: { publicPath: '/' } });
      }
      expect(
        fs.existsSync(
          path.join(
            root,
            'node_modules/.modern-js/federation/native-runtime.server.mjs',
          ),
        ),
      ).toBe(false);
    },
  );

  it('rejects a Solid Worker without a native snapshot transport', async () => {
    const root = app({
      'module-federation.config.mjs': `export default { name: 'host' };`,
    });
    const hooks = setup('solid', root, {
      deploy: { target: 'cloudflare', worker: { ssr: true } },
    });
    const client = chain();
    await expect(
      hooks.modifyBundlerChain(client.chain, {
        environment: { name: 'client' },
      }),
    ).rejects.toThrow('has no native Worker snapshot federation transport');
    expect(client.uses).toEqual([]);
    expect(
      fs.existsSync(path.join(root, 'node_modules/.modern-js/federation')),
    ).toBe(false);
  });

  it.each(nativeRenderers)(
    'registers %s graph refresh only in the Node development runtime',
    async renderer => {
      const root = app({
        'package.json': '{}',
        'module-federation.config.mjs': `export default { name: 'host', remotes: { remote: '${manifestRemote}' } };`,
      });
      installPackages(root, true, renderer);
      const refresh = createRequire(import.meta.url).resolve(
        '@modern-js/federation-runtime/native-dev-refresh-runtime-plugin',
      );
      for (const command of ['dev', 'build']) {
        const hooks = setup(
          renderer,
          root,
          { server: { ssr: true } },
          { command },
        );
        for (const name of ['client', 'server']) {
          const configured = chain();
          await hooks.modifyBundlerChain(configured.chain, {
            environment: { name },
          });
          const [, , [options]] = configured.uses.find(
            ([key]) => key === 'plugin-module-federation',
          ) as [string, unknown, [any]];
          const registration = options.runtimePlugins.find(
            (plugin: unknown) => Array.isArray(plugin) && plugin[0] === refresh,
          );
          if (command === 'dev' && name === 'server')
            expect(registration).toEqual([
              refresh,
              {
                remotes: [
                  {
                    name: 'remote',
                    alias: 'remote',
                    entry: 'https://remote.example/mf-manifest.json',
                  },
                ],
                revisionHeader: 'x-ultramodern-mf-revision',
                requestTimeout: 3000,
                shared: expect.arrayContaining(
                  renderer === 'octane'
                    ? [
                        'octane/server',
                        'octane/internal/server',
                        'octane/signals/server',
                        '@modern-js/renderer-octane/',
                        '@modern-js/renderer-core/',
                      ]
                    : [
                        'solid-js',
                        '@solidjs/web',
                        '@solidjs/signals',
                        '@modern-js/renderer-solid/federation',
                        '@modern-js/renderer-core/',
                      ],
                ),
              },
            ]);
          else expect(registration).toBeUndefined();
        }
      }
    },
  );

  it('allows private compiler discovery but rejects a live dev compiler without an origin', () => {
    const callbacks: Record<string, () => void> = {};
    let address: { hostname: string; port: number; https: boolean } | undefined;
    const compiler: any = {
      options: { output: { publicPath: '/base/' } },
      hooks: Object.fromEntries(
        ['beforeRun', 'watchRun'].map(name => [
          name,
          {
            tap: (_: string, callback: () => void) => {
              callbacks[name] = callback;
            },
          },
        ]),
      ),
    };
    expect(() =>
      new NativeFederationDevOriginPlugin(() => address).apply(compiler),
    ).not.toThrow();
    for (const hook of ['beforeRun', 'watchRun']) {
      compiler.options.output.publicPath = '/base/';
      expect(() => callbacks[hook]()).toThrow('dev server address');
      address = { hostname: '127.0.0.1', port: 59937, https: false };
      expect(() => callbacks[hook]()).toThrow(
        'live dev compiler must publish its resolved server origin',
      );
      compiler.options.output.publicPath = 'http://127.0.0.1:59937/base/';
      expect(() => callbacks[hook]()).not.toThrow();
      address = undefined;
    }
  });

  it('publishes actual dev addresses on browser and server containers', async () => {
    const root = app({
      'module-federation.config.mjs': `export default { name: 'host' };`,
    });
    const hooks = setup(
      'octane',
      root,
      { server: { ssr: true } },
      {
        command: 'dev',
        builder: {
          context: {
            devServer: { hostname: '127.0.0.1', port: 59937, https: false },
          },
        },
      },
    );
    for (const name of ['client', 'server']) {
      const config: any = { output: { publicPath: '/base/' } };
      await hooks.modifyRspackConfig(config, {
        environment: { name, config: { dev: { assetPrefix: true } } },
      });
      expect(config.output.publicPath).toBe(
        `http://127.0.0.1:59937/base/${name === 'server' ? 'bundles/' : ''}`,
      );
      if (name === 'server')
        expect(config.module.generator['asset/resource'].publicPath).toBe(
          'http://127.0.0.1:59937/base/',
        );
    }
  });

  it.each(nativeRenderers)(
    'keeps a client-only %s host off the server compilation',
    async renderer => {
      const root = app({
        'package.json': '{}',
        'module-federation.config.mjs': `export default { name: 'host', remotes: { remote: '${manifestRemote}' } };`,
      });
      installPackages(root, false, renderer);
      const hooks = setup(renderer, root, { server: { ssr: false } });
      const server = chain();
      await hooks.modifyBundlerChain(server.chain, {
        environment: { name: 'server' },
      });
      expect(server.uses).toEqual([]);
    },
  );

  it.each(nativeRenderers)(
    'requires @module-federation/node for %s server containers',
    async renderer => {
      const root = app({
        'package.json': '{}',
        'module-federation.config.mjs': `export default { name: 'remote', exposes: { './Widget': './Widget.tsx' } };`,
        // Block the test runner's ambient package lookup outside the application.
        'node_modules/@module-federation/node/package.json': JSON.stringify({
          name: '@module-federation/node',
          exports: {},
        }),
      });
      installPackages(root, false, renderer);
      const hooks = setup(renderer, root);
      await expect(
        hooks.modifyBundlerChain(chain().chain, {
          environment: { name: 'server' },
        }),
      ).rejects.toThrow('install @module-federation/node');
    },
  );

  it.each(nativeRenderers)(
    'starts %s client entries through a federation bootstrap',
    async renderer => {
      const root = app({
        'package.json': '{}',
        'module-federation.config.mjs': `export default { name: 'host', remotes: { remote: '${manifestRemote}' } };`,
      });
      installPackages(root, false, renderer);
      const generated = path.join(
        root,
        `node_modules/.modern-js/${renderer}/index/index.ts`,
      );
      fs.mkdirSync(path.dirname(generated), { recursive: true });
      const hooks = setup(renderer, root);
      const client = chain({ index: ['core-js/polyfill', generated] });
      await hooks.modifyBundlerChain(client.chain, {
        environment: { name: 'client' },
      });
      const [, Plugin, [options]] = client.uses.find(
        ([key]) => key === 'plugin-module-federation',
      ) as [string, any, [any]];
      expect(Plugin.name).toBe('ModuleFederationPlugin');
      expect(options).toMatchObject({
        name: 'host',
        library: { type: 'module' },
      });
      // Remotes register at runtime through the generated runtime plugin.
      expect(options.remotes).toBeUndefined();
      const runtimePlugin = path.join(
        root,
        'node_modules/.modern-js/federation/native-runtime.mjs',
      );
      expect(options.runtimePlugins).toEqual([runtimePlugin]);
      const { default: plugin } = await import(
        `${pathToFileURL(runtimePlugin).href}?test`
      );
      const origin = {};
      const args = plugin().beforeInit({
        origin,
        userOptions: {
          remotes: [
            { name: 'other', alias: 'other', entry: '/other/mf-manifest.json' },
          ],
        },
      });
      expect(args.userOptions.remotes).toEqual([
        { name: 'other', alias: 'other', entry: '/other/mf-manifest.json' },
        {
          name: 'remote',
          alias: 'remote',
          entry: 'https://remote.example/mf-manifest.json',
        },
      ]);
      const bootstrap = path.join(
        path.dirname(generated),
        'index.federation.js',
      );
      expect(client.entries.index).toEqual(['core-js/polyfill', bootstrap]);
      expect(fs.readFileSync(bootstrap, 'utf8')).toBe(
        `import(${JSON.stringify(generated)});\n`,
      );
    },
  );

  it.each(nativeRenderers)(
    'is inert for %s without a configuration file',
    async renderer => {
      const hooks = setup(renderer, app({}));
      const client = chain();
      await hooks.modifyBundlerChain(client.chain, {
        environment: { name: 'client' },
      });
      expect(client.uses).toEqual([]);
    },
  );

  it.each(nativeRenderers)(
    'requires @module-federation/enhanced for a %s application',
    async renderer => {
      const hooks = setup(
        renderer,
        app({
          'package.json': '{}',
          'module-federation.config.mjs': 'export default { name: "x" }',
          'node_modules/@module-federation/enhanced/package.json':
            JSON.stringify({
              name: '@module-federation/enhanced',
              exports: {},
            }),
        }),
      );
      await expect(
        hooks.modifyBundlerChain(chain().chain, {
          environment: { name: 'client' },
        }),
      ).rejects.toThrow('install @module-federation/enhanced');
    },
  );
});

describe('native renderer federation identity', () => {
  it.each(nativeRenderers)(
    'resolves the %s tuple from installed renderer owners',
    renderer => {
      const compatibility = resolveRendererFederationCompatibility(renderer);
      expect(compatibility.profile.renderer).toBe(renderer);
      expect(compatibility.runtime.name).toBe(
        renderer === 'solid' ? 'solid-js' : 'octane',
      );
      expect(compatibility.bootstrap.name).toBe(
        `@modern-js/renderer-${renderer}`,
      );
      expect(compatibility.profile.hydration.name).toBe(
        renderer === 'solid' ? '@solidjs/web' : 'octane',
      );
    },
  );

  it('keeps Module Federation application SSR React-only', () => {
    expect(() =>
      assertCapturedRenderer(
        {
          renderer: 'solid',
          server: { ssr: { moduleFederationAppSSR: true } },
        } as never,
        'solid',
      ),
    ).toThrow('does not support Module Federation application SSR');
  });
});
