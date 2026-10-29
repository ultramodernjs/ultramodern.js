import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type {
  AppNormalizedConfig,
  AppTools,
  AppUserConfig,
} from '@modern-js/app-tools';
import { assertRendererFederationCompatibility } from '@modern-js/federation-runtime/renderer-contract';
import { type CLIPluginAPI, createPluginManager } from '@modern-js/plugin';
import {
  createContext,
  initAppContext,
  initPluginAPI,
} from '@modern-js/plugin/cli';
import { logger } from '@modern-js/utils';
import {
  createRsbuild,
  type RsbuildConfig,
  type RsbuildPlugin,
  type Rspack,
  rspack,
} from '@rsbuild/core';
import { describe, expect, it, rstest } from '@rstest/core';
import { applyExternalsPlugin } from '../../../../runtime/plugin-runtime/src/document/cli';
import {
  type ReactRuntimeConfig,
  validateRedactConfig,
} from '../../src/native-composition/redact-config';
import { REACT_CLI_PLUGIN_NAMES } from '../../src/native-composition/renderer-selection';
import { composeReactRenderer } from '../../src/renderers/react/composition';
import {
  resolveReactFederationCompatibility,
  withReactRuntimeShared,
} from '../../src/renderers/react/module-federation';
import {
  assertRedactPatch,
  createRedactBuilderPlugin,
  REDACT_ALIASES,
  REDACT_PATCH_MARKER,
  redactArtifactDigest,
  resolveRedactAliases,
  ultramodernRedactIntegrationPlugin,
} from '../../src/renderers/react/redact-integration-plugin';

const require = createRequire(import.meta.url);
const frameworkRequire = createRequire(require.resolve('../../package.json'));
const ignorePatch = () => {};
// The aliased sidecar keeps its physical directory; JSON doubles `\` on Windows.
const redactSidecarModule = /@bleedingdev[\\/]+tanstack-redact[\\/]+dist[\\/]/;

async function cliConfig(input: ReactRuntimeConfig) {
  const manager = createPluginManager<CLIPluginAPI<AppTools>>();
  manager.addPlugins([ultramodernRedactIntegrationPlugin()]);
  const plugins = manager.getPlugins();
  const config = {
    server: {},
    builderPlugins: [],
    ...input,
  } as AppNormalizedConfig;
  const context = await createContext<AppTools>({
    appContext: initAppContext<AppTools>({
      packageName: 'redact-proof',
      command: 'build',
      configFile: false,
      appDirectory: __dirname,
      metaName: 'modern-js',
      plugins,
    }),
    config: input as AppUserConfig,
    normalizedConfig: config,
  });
  const api = initPluginAPI({ context, pluginManager: manager });
  context.pluginAPI = api;
  for (const plugin of plugins) await plugin.setup?.(api);
  return api.getHooks().modifyResolvedConfig.call(config);
}

async function resolveConfigs(
  options: {
    runtime?: ReactRuntimeConfig;
    environments?: RsbuildConfig['environments'];
    aliases?: unknown;
    externals?: Rspack.Configuration['externals'];
    assertPatch?: () => void;
  } = {},
) {
  const pins: RsbuildPlugin = {
    name: 'fixture:cloudflare-and-source-build-react-pins',
    setup(api) {
      api.modifyBundlerChain(chain => {
        chain.resolve.alias.set('react$', '/real-react/index.js');
        chain.resolve.alias.set('react-dom$', '/real-react-dom/index.js');
        chain.resolve.alias.set(
          'react-dom/server.edge$',
          '/real-react-dom/server.edge.js',
        );
      });
      api.modifyRspackConfig(config => {
        config.resolve ??= {};
        if (options.aliases)
          config.resolve.alias = options.aliases as NonNullable<
            typeof config.resolve
          >['alias'];
        if (options.externals) config.externals = options.externals;
      });
    },
  };
  const builder = await createRsbuild({
    cwd: __dirname,
    config: {
      mode: 'production',
      environments: options.environments ?? {
        client: { output: { target: 'web' } },
      },
      source: { entry: { index: import.meta.filename } },
      tools: { htmlPlugin: false },
      plugins: [
        pins,
        createRedactBuilderPlugin(options.runtime ?? {}, {
          assertPatch: options.assertPatch ?? ignorePatch,
        }),
      ],
    },
  });
  return { builder, configs: await builder.initConfigs() };
}

const aliasMap = (config: Rspack.Configuration) => {
  const aliases = config.resolve?.alias;
  return Array.isArray(aliases)
    ? Object.fromEntries(
        aliases.map(item => [
          `${item.name}${item.onlyModule ? '$' : ''}`,
          item.alias,
        ]),
      )
    : aliases;
};

function expectCanonical(config: Rspack.Configuration) {
  const aliases = aliasMap(config);
  for (const [from, to] of Object.entries(REDACT_ALIASES)) {
    expect(aliases?.[`${from}$`]).toBe(frameworkRequire.resolve(to));
    expect(aliases?.[`${to}$`]).toBe(frameworkRequire.resolve(to));
  }
}

describe('default React runtime composition', () => {
  it('registers the fork integration in every React composition, not a template', async () => {
    const composition = composeReactRenderer();
    expect(composition.usePlugins?.map(plugin => plugin.name)).toContain(
      '@modern-js/ultramodern-redact-integration',
    );
    expect(REACT_CLI_PLUGIN_NAMES).toContain(
      '@modern-js/ultramodern-redact-integration',
    );
    const resolved = await cliConfig({});
    expect(resolved.builderPlugins).toMatchObject([
      { name: 'ultramodern:react:redact' },
    ]);
  });

  it('uses the public plugin CSR path and framework-owned runtime without app dependencies', async () => {
    const { configs } = await resolveConfigs();
    expectCanonical(configs[0]);
    expect(
      configs[0].plugins?.filter(
        plugin => plugin?.constructor.name === 'NormalModuleReplacementPlugin',
      ),
    ).toHaveLength(1);
  });

  it('aliases every entry in client, Node SSR and Cloudflare web-target workerSSR after existing pins', async () => {
    const { configs } = await resolveConfigs({
      environments: {
        client: { output: { target: 'web' } },
        server: { output: { target: 'node' } },
        workerSSR: {
          output: { target: 'web', module: true },
          source: { define: { 'process.env.NODE_ENV': '"production"' } },
        },
      },
    });
    expect(configs).toHaveLength(3);
    for (const config of configs) expectCanonical(config);
    const worker = configs.find(config => config.name === 'workerSSR');
    expect(
      worker?.plugins?.some(
        plugin => plugin?.constructor.name === 'DefinePlugin',
      ),
    ).toBe(true);
  });

  it.each([false, { viewTransitions: true }])(
    'handles redact=%j',
    async redact => {
      const { configs } = await resolveConfigs({ runtime: { redact } });
      if (redact === false) {
        expect(aliasMap(configs[0])?.react$).toBe('/real-react/index.js');
        expect((await cliConfig({ redact })).builderPlugins).toMatchObject([
          { name: 'ultramodern:react:runtime-cache' },
        ]);
      } else {
        expectCanonical(configs[0]);
        expect(
          configs[0].plugins?.some(
            plugin =>
              plugin?.constructor.name === 'NormalModuleReplacementPlugin',
          ),
        ).toBe(false);
      }
    },
  );

  it('separates persistent caches from real React and retains authored cache options', async () => {
    const environments = {
      client: {
        output: { target: 'web' as const },
        performance: {
          buildCache: {
            cacheDigest: ['consumer'],
            cacheDirectory: '/tmp/redact-cache-unit',
          },
        },
      },
      server: {
        output: { target: 'node' as const },
        performance: { buildCache: false as const },
      },
    };
    const enabled = await resolveConfigs({ environments });
    const disabled = await resolveConfigs({
      environments,
      runtime: { redact: false },
    });
    const enabledCache =
      enabled.builder.getNormalizedConfig().environments.client.performance
        .buildCache;
    const disabledCache =
      disabled.builder.getNormalizedConfig().environments.client.performance
        .buildCache;
    expect(enabledCache).toMatchObject({
      cacheDirectory: '/tmp/redact-cache-unit',
      cacheDigest: expect.arrayContaining([
        'consumer',
        REDACT_PATCH_MARKER,
        redactArtifactDigest(),
      ]),
    });
    expect(disabledCache).toMatchObject({
      cacheDirectory: '/tmp/redact-cache-unit',
      cacheDigest: expect.arrayContaining([
        'consumer',
        'ultramodern:real-react-cache:v1',
      ]),
    });
    expect(
      disabledCache && typeof disabledCache === 'object'
        ? disabledCache.cacheDigest
        : [],
    ).not.toContain(REDACT_PATCH_MARKER);
    expect(
      enabled.builder.getNormalizedConfig().environments.server.performance
        .buildCache,
    ).toBe(false);
    expect(
      enabled.configs.find(config => config.name === 'client')?.cache,
    ).not.toEqual(
      disabled.configs.find(config => config.name === 'client')?.cache,
    );
  });

  it('invalidates runtime identity when same-version patch bytes change behind an unchanged alias entry', () => {
    const root = mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'redact-artifact-'),
    );
    const directory = path.join(root, 'dist');
    try {
      const manifest = path.join(root, 'package.json');
      writeFileSync(
        manifest,
        JSON.stringify({ name: '@tanstack/redact', version: '0.2.1' }),
      );
      mkdirSync(path.join(directory, 'dom/features'), { recursive: true });
      writeFileSync(
        path.join(directory, 'index.js'),
        `${REDACT_PATCH_MARKER}\nexport * from './dom/features/runtime.js';\n`,
      );
      const transitive = path.join(directory, 'dom/features/runtime.js');
      writeFileSync(transitive, 'export const revision = "A";\n');
      const before = redactArtifactDigest(directory);
      expect(redactArtifactDigest(directory)).toBe(before);
      writeFileSync(transitive, 'export const revision = "B";\n');
      expect(redactArtifactDigest(directory)).not.toBe(before);
      // Restored bytes have the same content identity, independent of mtimes.
      writeFileSync(transitive, 'export const revision = "A";\n');
      expect(redactArtifactDigest(directory)).toBe(before);
      writeFileSync(
        manifest,
        JSON.stringify({
          name: '@tanstack/redact',
          version: '0.2.1',
          exports: './dist/other.js',
        }),
      );
      expect(redactArtifactDigest(directory)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the entire RSC app on real React and explains why once', async () => {
    const log = rstest.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const runtime = { server: { rsc: true } };
      expect((await cliConfig(runtime)).builderPlugins).toMatchObject([
        { name: 'ultramodern:react:runtime-cache' },
      ]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('Flight');
      const { configs } = await resolveConfigs({
        runtime,
        environments: {
          client: {},
          server: { output: { target: 'node' } },
          workerSSR: {},
        },
      });
      for (const config of configs)
        expect(aliasMap(config)?.react$).toBe('/real-react/index.js');
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    { unrelated: '/preserved.js', react$: '/wrong.js' },
    [
      { name: 'unrelated', alias: '/preserved.js', onlyModule: true },
      { name: 'react', alias: '/wrong.js', onlyModule: true },
      { name: 'duplicates', alias: '/one.js' },
      { name: 'duplicates', alias: '/two.js' },
      { name: 'ignored', alias: false },
    ],
  ])(
    'preserves unrelated aliases without the public plugin numeric-key corruption',
    async aliases => {
      const { configs } = await resolveConfigs({ aliases });
      expectCanonical(configs[0]);
      if (Array.isArray(aliases)) {
        expect(configs[0].resolve?.alias).toMatchObject({
          unrelated$: '/preserved.js',
          duplicates: ['/one.js', '/two.js'],
          ignored: false,
        });
        expect(aliasMap(configs[0])).not.toHaveProperty('0');
      } else expect(aliasMap(configs[0])?.unrelated).toBe('/preserved.js');
    },
  );

  it('bundles React, ReactDOM and canonical Redact instead of Node externals', async () => {
    const external = rstest.fn((_data, callback) =>
      callback(undefined, 'commonjs unrelated'),
    );
    const { configs } = await resolveConfigs({
      environments: { server: { output: { target: 'node' } }, client: {} },
      externals: [
        {
          react: 'react',
          'react-dom/server': 'react-dom/server',
          '@tanstack/redact': '@tanstack/redact',
          unrelated: 'unrelated',
        },
        /^react/,
        external,
      ],
    });
    const externals = configs.find(config => config.name === 'server')
      ?.externals as unknown[];
    expect(externals[0]).toEqual({ unrelated: 'unrelated' });
    for (const request of [
      'react',
      'react/jsx-runtime',
      'react-dom/server',
      '@tanstack/redact/server',
    ]) {
      for (const item of externals.filter(item => typeof item === 'function')) {
        const callback = rstest.fn();
        await item({ request }, callback);
        expect(callback).toHaveBeenCalledWith();
      }
    }
    expect(external).not.toHaveBeenCalled();
    const callback = rstest.fn();
    await (externals[2] as typeof external)({ request: 'unrelated' }, callback);
    expect(external).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(undefined, 'commonjs unrelated');
  });

  it('rejects a missing patch marker with an actionable opt-out', async () => {
    expect(() =>
      assertRedactPatch((() => '// unpatched\n') as typeof readFileSync),
    ).toThrow('redact: false');
    expect(() =>
      assertRedactPatch(
        (() => `${REDACT_PATCH_MARKER}\n`) as typeof readFileSync,
      ),
    ).not.toThrow();
    await expect(
      resolveConfigs({
        assertPatch: () =>
          assertRedactPatch((() => 'missing') as typeof readFileSync),
      }),
    ).rejects.toThrow('reviewed SSR patch');
  });

  it.each([
    null,
    'false',
    0,
    [],
    { viewTransitions: 'yes' },
    { enabled: true },
    { skipPatch: true },
  ])('rejects invalid redact=%j', async redact => {
    expect(() => validateRedactConfig(redact)).toThrow('redact must be');
    await expect(cliConfig({ redact } as ReactRuntimeConfig)).rejects.toThrow(
      'redact must be',
    );
  });
});

describe('federation runtime identity', () => {
  it('shares the effective Redact runtime when installed through the fork npm alias', () => {
    const root = realpathSync(
      mkdtempSync(
        path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'redact-alias-'),
      ),
    );
    try {
      const owner = path.join(root, 'node_modules/@tanstack/redact');
      mkdirSync(owner, { recursive: true });
      writeFileSync(
        path.join(owner, 'package.json'),
        JSON.stringify({
          name: '@bleedingdev/tanstack-redact',
          version: '0.2.1',
          exports: { '.': './index.js', './*': './index.js' },
        }),
      );
      writeFileSync(path.join(owner, 'index.js'), 'module.exports = {};');
      const aliasedRequire = createRequire(path.join(root, 'package.json'));
      const compatibility = resolveReactFederationCompatibility(
        {},
        aliasedRequire,
      );
      expect(compatibility.runtime).toEqual({
        name: '@tanstack/redact',
        version: '0.2.1',
      });
      expect(compatibility.profile.hydration).toEqual(compatibility.runtime);
      expect(() =>
        assertRendererFederationCompatibility(
          compatibility,
          resolveReactFederationCompatibility(),
        ),
      ).not.toThrow();
      expect(() =>
        assertRendererFederationCompatibility(
          compatibility,
          resolveReactFederationCompatibility({ redact: false }),
        ),
      ).toThrow();
      const aliases = resolveRedactAliases(aliasedRequire);
      const shared = withReactRuntimeShared({}, compatibility, aliasedRequire);
      expect(Object.keys(shared)).toHaveLength(Object.keys(aliases).length);
      const reactSpelling = (request: string) => {
        const target =
          REDACT_ALIASES[request as keyof typeof REDACT_ALIASES] ?? request;
        return Object.entries(REDACT_ALIASES).find(
          ([, to]) => to === target,
        )![0];
      };
      for (const request of Object.keys(aliases).map(key => key.slice(0, -1))) {
        expect(shared[request]).toMatchObject({
          import: path.join(owner, 'index.js'),
          shareKey: reactSpelling(request),
          version: '0.2.1',
          requiredVersion: '0.2.1',
          singleton: true,
          strictVersion: true,
        });
      }
      expect(shared.react).toEqual(shared['@tanstack/redact']);
      expect(shared['react-dom/client']).toEqual(
        shared['@tanstack/redact/dom-client'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects mixed host/remote runtimes in both directions before container init', () => {
    const redact = resolveReactFederationCompatibility();
    const react = resolveReactFederationCompatibility({ redact: false });
    const rsc = resolveReactFederationCompatibility({ server: { rsc: true } });
    expect(redact.runtime).toEqual({
      name: '@tanstack/redact',
      version: '0.2.1',
    });
    expect(redact.profile.hydration).toEqual(redact.runtime);
    expect(react.runtime.name).toBe('react');
    expect(rsc).toEqual(react);
    expect(() =>
      assertRendererFederationCompatibility(redact, react),
    ).toThrow();
    expect(() =>
      assertRendererFederationCompatibility(react, redact),
    ).toThrow();
    expect(() =>
      assertRendererFederationCompatibility(redact, redact),
    ).not.toThrow();
  });

  it('uses React share keys and the real Redact version, preserving other shares', () => {
    const shared = withReactRuntimeShared(
      {
        unrelated: { singleton: false },
        react: { requiredVersion: '^19.0.0' },
      },
      resolveReactFederationCompatibility(),
    );
    expect(shared.unrelated).toEqual({ singleton: false });
    const aliases = resolveRedactAliases();
    for (const request of Object.keys(aliases).map(key => key.slice(0, -1))) {
      expect(shared[request]).toMatchObject({
        version: '0.2.1',
        requiredVersion: '0.2.1',
        strictVersion: true,
        singleton: true,
        import: aliases[`${request}$`],
      });
    }
    // React-governed hosts keep their share keys; Redact spellings join them.
    expect(shared.react).toMatchObject({ shareKey: 'react' });
    expect(shared['@tanstack/redact']).toMatchObject({ shareKey: 'react' });
    expect(shared['use-sync-external-store/shim']).toMatchObject({
      shareKey: 'react',
    });
    expect(shared['react-dom/client']).toMatchObject({
      shareKey: 'react-dom/client',
    });
    expect(shared['@tanstack/redact/dom-client']).toMatchObject({
      shareKey: 'react-dom/client',
    });
    expect(shared['react-dom/server.edge']).toMatchObject({
      shareKey: 'react-dom/server',
    });
    expect(() =>
      withReactRuntimeShared(
        { react: { shareKey: 'foreign-react' } },
        resolveReactFederationCompatibility(),
      ),
    ).toThrow('cannot mix');
  });
});

describe('real Rspack module graph', () => {
  it.each(['web', 'node', 'web-worker'] as const)(
    'bundles Redact without real React or runtime externals for %s',
    async target => {
      const { configs } = await resolveConfigs({
        environments: {
          [target === 'web-worker' ? 'workerSSR' : 'proof']: {
            output: { target },
          },
        },
        aliases:
          target === 'web'
            ? [{ name: 'unrelated', alias: '/preserved.js', onlyModule: true }]
            : undefined,
        externals: {
          react: 'commonjs react',
          'react-dom/server': 'commonjs react-dom/server',
        },
      });
      const config = configs[0];
      config.entry = {
        index:
          'data:text/javascript,' +
          encodeURIComponent(
            `import { createElement, useId } from 'react'; import { renderToString } from 'react-dom/server'; export const rendered = renderToString(createElement('div', null, typeof useId));`,
          ),
      };
      config.optimization = {
        ...config.optimization,
        minimize: false,
        concatenateModules: false,
      };
      config.cache = false;
      const compiler = rspack(config);
      compiler.hooks.shouldEmit.tap('no-test-artifacts', () => false);
      try {
        const stats = await new Promise<Rspack.Stats>((resolve, reject) =>
          compiler.run((error, result) =>
            error
              ? reject(error)
              : result
                ? resolve(result)
                : reject(new Error('No stats')),
          ),
        );
        const details = stats.toJson({
          all: false,
          modules: true,
          errors: true,
          nestedModules: true,
        });
        expect(details.errors).toEqual([]);
        const serialized = JSON.stringify(details.modules);
        expect(serialized).toMatch(redactSidecarModule);
        expect(serialized).not.toContain('external "react');
        expect(serialized).not.toContain('/react/cjs/');
        expect(serialized).not.toContain('/react-dom/cjs/');
      } finally {
        await new Promise<void>((resolve, reject) =>
          compiler.close(error => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it('keeps custom Document child compiler externals from selecting real React', async () => {
    const { configs } = await resolveConfigs({
      environments: { proof: { output: { target: 'node' } } },
    });
    const config = configs[0];
    config.entry = {};
    config.optimization = {
      ...config.optimization,
      minimize: false,
      concatenateModules: false,
    };
    config.cache = false;
    let resources: string[] = [];
    config.plugins ??= [];
    config.plugins.push({
      apply(compiler) {
        compiler.hooks.make.tapAsync(
          'document-fixture',
          (compilation, done) => {
            const child = compilation.createChildCompiler(
              'modernjs-document-proof',
              { filename: 'document.js' },
              [],
            );
            child.options.target = 'node';
            child.options.resolve = { ...compiler.options.resolve };
            applyExternalsPlugin(child, compiler);
            new rspack.EntryPlugin(
              compiler.context,
              'data:text/javascript,' +
                encodeURIComponent(
                  `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; export const html = renderToStaticMarkup(createElement('div'));`,
                ),
              { name: 'document' },
            ).apply(child);
            child.runAsChild((error, _entries, result) => {
              if (result)
                resources = [...result.modules].map(module =>
                  module.identifier(),
                );
              done(error ?? undefined);
            });
          },
        );
      },
    });
    const compiler = rspack(config);
    compiler.hooks.shouldEmit.tap('no-test-artifacts', () => false);
    try {
      const stats = await new Promise<Rspack.Stats>((resolve, reject) =>
        compiler.run((error, result) =>
          error
            ? reject(error)
            : result
              ? resolve(result)
              : reject(new Error('No stats')),
        ),
      );
      expect(stats.toJson({ all: false, errors: true }).errors).toEqual([]);
      expect(resources.join('\n')).toMatch(redactSidecarModule);
      expect(
        resources.some(
          resource => resource.startsWith('external') && /react/.test(resource),
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        compiler.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});
