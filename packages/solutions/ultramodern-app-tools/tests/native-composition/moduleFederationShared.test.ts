import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import type { AppTools } from '@modern-js/app-tools';
import { type CLIPluginAPI, createPluginManager } from '@modern-js/plugin';
import {
  createContext,
  initAppContext,
  initPluginAPI,
} from '@modern-js/plugin/cli';
import {
  defineConfig,
  presetUltramodern,
  resolveUltramodernConfig,
} from '@modern-js/ultramodern-app-tools';
import { createRsbuild, type RspackChain, rspack } from '@rsbuild/core';
import { transformSync } from 'esbuild';
import {
  resolveFrameworkSharedPackages,
  resolveManifestRecoveryRuntimePlugin,
  ultramodernModuleFederationSharedPlugin,
  withFrameworkShared,
  withReactJsxRuntimeShared,
  withRuntimePlugin,
} from '../../src/renderers/react/module-federation-shared-plugin';

/** An app directory that installs only `@modern-js/runtime` at 9.9.9. */
const createAppDirectory = () => {
  const appDirectory = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'ultramodern-mf-shared-')),
  );
  const runtimeDirectory = path.join(
    appDirectory,
    'node_modules/@modern-js/runtime',
  );
  mkdirSync(runtimeDirectory, { recursive: true });
  writeFileSync(
    path.join(runtimeDirectory, 'package.json'),
    JSON.stringify({
      name: '@modern-js/runtime',
      version: '9.9.9',
      exports: {
        '.': './index.js',
        './context': { types: './context.d.ts', default: './context.js' },
        './package.json': './package.json',
        // The app aliases these to its own generated registry.
        './registry': { types: './registry.d.ts' },
        './registry/*': { types: './registry.d.ts' },
      },
    }),
  );
  return { appDirectory, runtimeDirectory };
};

/** Install a `@modern-js/federation-runtime` exposing the recovery plugin. */
const installFederationRuntime = (appDirectory: string) => {
  const directory = path.join(
    appDirectory,
    'node_modules/@modern-js/federation-runtime',
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: '@modern-js/federation-runtime',
      version: '9.9.9',
      exports: {
        './manifest-recovery-runtime-plugin': {
          node: { require: './recovery.js' },
          default: './recovery.mjs',
        },
      },
    }),
  );
  writeFileSync(path.join(directory, 'recovery.js'), '');
  return path.join(directory, 'recovery.js');
};

const runtimeShare = {
  '@modern-js/runtime/context': {
    requiredVersion: '9.9.9',
    singleton: true,
    treeShaking: false,
  },
};

const jsxRuntimes = (requiredVersion?: string) => ({
  'react/jsx-dev-runtime': {
    ...(requiredVersion ? { requiredVersion } : {}),
    singleton: true,
    treeShaking: false,
  },
  'react/jsx-runtime': {
    ...(requiredVersion ? { requiredVersion } : {}),
    singleton: true,
    treeShaking: false,
  },
});

const applicationRequire = createRequire(
  path.resolve(
    __dirname,
    '../../../../../tests/integration/routes-tanstack-mf/mf-remote/package.json',
  ),
);
const native = applicationRequire('@module-federation/modern-js-v3');
const nativeRequire = createRequire(
  applicationRequire.resolve('@module-federation/modern-js-v3/ssr-plugin'),
);
const routerName = '@tanstack/react-router';
const consumerManifest = applicationRequire('./package.json');
const routerArtifact =
  consumerManifest.ultramodern.supportArtifacts.packages[routerName];

/** Register native MF and apply the actual final browser/server options hook. */
async function finalFederationOptions(
  appDirectory: string,
  mfConfig: Record<string, unknown>,
  secondary = true,
) {
  const priorSSR = process.env.MF_SSR_PRJ;
  try {
    const manager = createPluginManager<CLIPluginAPI<AppTools>>();
    manager.addPlugins([
      native.moduleFederationPlugin({
        config: native.createModuleFederationConfig({
          name: 'shellSuperApp',
          remotes: {},
          ...mfConfig,
          dts: false,
        }),
        ssr: true,
        secondarySharedTreeShaking: secondary,
      }),
      ultramodernModuleFederationSharedPlugin(),
    ]);
    const plugins = manager.getPlugins();
    const config = await resolveUltramodernConfig(
      defineConfig({
        server: { ssr: true },
        source: { enableAsyncEntry: true },
      }),
      { env: 'production', command: 'build' },
    );
    const context = await createContext<AppTools>({
      appContext: initAppContext({
        packageName: 'artifact-share-consumer',
        appDirectory,
        configFile: false,
        command: 'build',
        metaName: 'modern-js',
        plugins,
      }),
      config,
      normalizedConfig: config,
    });
    const api = initPluginAPI({ context, pluginManager: manager });
    for (const plugin of plugins) await plugin.setup?.(api);
    const finalOptions: ReturnType<
      typeof native.createModuleFederationConfig
    >[] = [];
    const rsbuild = await createRsbuild({
      cwd: appDirectory,
      rsbuildConfig: {
        source: { entry: { index: './src/index.js' } },
        environments: {
          client: { output: { target: 'web' } },
          ssr: { output: { target: 'node' } },
        },
        tools: {
          bundlerChain: async (chain, utils) => {
            await context.hooks.modifyBundlerChain.call(chain, utils);
            for (const id of [
              'plugin-module-federation',
              'plugin-module-federation-server',
            ]) {
              if (!chain.plugins.has(id)) continue;
              let [options] = chain.plugin(id).get('args');
              while (options.mfConfig) options = options.mfConfig;
              finalOptions.push(options);
            }
          },
        },
      },
    });
    await rsbuild.initConfigs();
    expect(finalOptions).toHaveLength(2);
    return finalOptions;
  } finally {
    if (priorSSR === undefined) delete process.env.MF_SSR_PRJ;
    else process.env.MF_SSR_PRJ = priorSSR;
  }
}

function consumeRouterShare(share: object, version: string) {
  const { createInstance } = nativeRequire('@module-federation/runtime');
  const name = `authored-shell-share-${randomUUID()}`;
  const provider = { router: 'actual native MF provider' };
  const runtime = createInstance({
    name,
    shared: {
      [routerName]: {
        version,
        scope: name,
        lib: () => provider,
        shareConfig: share,
      },
    },
  });
  expect(runtime.loadShareSync(routerName)()).toBe(provider);
}

it('normalizes authored Shell artifact shares through final native MF options', async () => {
  // The authored OntOS helper passes the dependency request through verbatim.
  const createSharedRuntimeConfig = (versions: Record<string, string>) => ({
    [routerName]: {
      requiredVersion: versions[routerName],
      singleton: true,
      strictVersion: true,
      treeShaking: false,
    },
  });
  const shared = createSharedRuntimeConfig(consumerManifest.dependencies);
  const original = JSON.stringify(shared);
  expect(shared[routerName].requiredVersion).toBe(routerArtifact.request);
  const appDirectory = path.dirname(
    applicationRequire.resolve('./package.json'),
  );
  const options = await finalFederationOptions(appDirectory, { shared });
  for (const config of options) {
    const share = config.shared[routerName];
    // Feed final plugin options, not a separately normalized test value, to MF.
    consumeRouterShare(share, '1.170.46');
    expect(() => consumeRouterShare(share, '1.170.47')).toThrow(
      /does not satisfy the requirement/u,
    );
    expect(share).toEqual({
      ...shared[routerName],
      requiredVersion: '1.170.46',
    });
  }
  expect(JSON.stringify(shared)).toBe(original);
});

it('normalizes unchanged generated Catalog config at the same native boundary', async () => {
  const filename = applicationRequire.resolve('./module-federation.config.ts');
  const source = readFileSync(filename, 'utf8');
  const module: { exports: { default: Record<string, unknown> } } = {
    exports: { default: {} },
  };
  vm.runInNewContext(
    transformSync(source, {
      format: 'cjs',
      loader: 'ts',
      define: {
        'import.meta.url': JSON.stringify(pathToFileURL(filename).href),
      },
    }).code,
    { module, exports: module.exports, require: applicationRequire },
  );
  const config = module.exports.default;
  const original = JSON.stringify(config);
  const manifestBefore = readFileSync(
    applicationRequire.resolve('./package.json'),
    'utf8',
  );
  const options = await finalFederationOptions(path.dirname(filename), config);
  for (const final of options) {
    const share = final.shared[routerName];
    expect(share.requiredVersion).toBe('1.170.46');
    expect(share.singleton).toBe(true);
    expect(share.treeShaking).toBe(false);
    consumeRouterShare({ ...share, strictVersion: true }, '1.170.46');
    expect(() =>
      consumeRouterShare({ ...share, strictVersion: true }, '1.170.47'),
    ).toThrow(/does not satisfy the requirement/u);
    expect(final.exposes).toEqual(config.exposes);
  }
  expect(JSON.stringify(config)).toBe(original);
  expect(readFileSync(filename, 'utf8')).toBe(source);
  expect(
    readFileSync(applicationRequire.resolve('./package.json'), 'utf8'),
  ).toBe(manifestBefore);
});

it('preserves authored ranges and sharing fields in record and array native options', async () => {
  const appDirectory = path.dirname(
    applicationRequire.resolve('./package.json'),
  );
  const router = {
    requiredVersion: '~1.170.0',
    singleton: true,
    strictVersion: true,
    import: routerName,
    shareKey: routerName,
    shareScope: 'authored',
    treeShaking: false,
    eager: false,
  };
  for (const secondary of [true, false]) {
    for (const shared of [
      {
        [routerName]: router,
        untouched: { requiredVersion: false },
        shorthand: '^1.0.0',
        file: { requiredVersion: 'file:../authored' },
        tag: { requiredVersion: 'next' },
      },
      ['untouched', { [routerName]: router }],
    ]) {
      const before = JSON.stringify(shared);
      const options = await finalFederationOptions(
        appDirectory,
        { shared },
        secondary,
      );
      for (const final of options) {
        const shares = Array.isArray(final.shared)
          ? Object.assign(
              {},
              ...final.shared.filter(entry => typeof entry === 'object'),
            )
          : final.shared;
        expect(shares[routerName]).toEqual(router);
        if (!Array.isArray(shared)) {
          expect(shares.untouched).toEqual(shared.untouched);
          expect(shares.shorthand).toBe(shared.shorthand);
          expect(shares.file).toEqual(shared.file);
          expect(shares.tag).toEqual(shared.tag);
        }
        consumeRouterShare(shares[routerName], '1.170.46');
        expect(() => consumeRouterShare(shares[routerName], '1.171.0')).toThrow(
          /does not satisfy the requirement/u,
        );
        expect(Array.isArray(final.shared)).toBe(Array.isArray(shared));
      }
      expect(JSON.stringify(shared)).toBe(before);
    }
  }
});

it('normalizes admitted artifacts without changing import, shareKey or array sharing policy', async () => {
  const appDirectory = path.dirname(
    applicationRequire.resolve('./package.json'),
  );
  const router = {
    requiredVersion: routerArtifact.request,
    singleton: true,
    strictVersion: true,
    import: routerName,
    shareKey: 'authored-router-key',
    treeShaking: false,
    eager: false,
  };
  const shared = ['untouched', { routerAlias: router }];
  const before = JSON.stringify(shared);
  const options = await finalFederationOptions(appDirectory, { shared });
  for (const final of options) {
    expect(final.shared[0]).toBe('untouched');
    expect(final.shared[1]).toEqual({
      routerAlias: { ...router, requiredVersion: '1.170.46' },
    });
  }
  expect(JSON.stringify(shared)).toBe(before);
});

it('uses the admitted native artifact cohort without package-specific exceptions', async () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
  );
  const name = '@tanstack/router-core';
  const artifact = manifest.ultramodern.nativeArtifacts.packages[name];
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'um-mf-native-pin-')),
  );
  try {
    const installed = path.join(root, 'node_modules', name);
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'native-artifact-consumer',
        devDependencies: { [name]: artifact.request },
      }),
    );
    writeFileSync(
      path.join(installed, 'package.json'),
      JSON.stringify({
        name,
        version: artifact.version,
      }),
    );
    const shared = {
      [name]: {
        requiredVersion: artifact.request,
        singleton: true,
        strictVersion: true,
      },
    };
    for (const final of await finalFederationOptions(root, { shared })) {
      expect(final.shared[name]).toEqual({
        ...shared[name],
        requiredVersion: artifact.version,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects unadmitted URLs, mismatched dependency requests and missing or invalid installed identity', async () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'um-mf-artifact-evidence-')),
  );
  const installed = path.join(root, 'node_modules', routerName);
  try {
    const cases = [
      {
        request: routerArtifact.request,
        installed: { name: routerName, version: '1.170.47' },
      },
      {
        request: routerArtifact.request,
        installed: { name: 'foreign-router', version: '1.170.46' },
      },
      {
        request: routerArtifact.request,
        installed: { name: routerName, version: 'invalid' },
      },
      { request: routerArtifact.request, installed: undefined },
      {
        request: '~1.170.0',
        installed: { name: routerName, version: '1.170.46' },
      },
      {
        request: 'https://untrusted.example/router.tgz',
        installed: { name: routerName, version: '1.170.46' },
      },
      {
        request: routerArtifact.request.replace('bea0d22f', 'aaa0d22f'),
        installed: { name: routerName, version: '1.170.46' },
      },
    ];
    for (const candidate of cases) {
      rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
      const manifest = structuredClone(consumerManifest);
      manifest.dependencies[routerName] = candidate.request;
      // Forging consumer metadata cannot admit a different artifact request.
      manifest.ultramodern.supportArtifacts.packages[routerName].request =
        candidate.request;
      const manifestSource = JSON.stringify(manifest);
      writeFileSync(path.join(root, 'package.json'), manifestSource);
      if (candidate.installed) {
        mkdirSync(installed, { recursive: true });
        writeFileSync(
          path.join(installed, 'package.json'),
          JSON.stringify(candidate.installed),
        );
      }
      const shared = {
        [routerName]: {
          requiredVersion: candidate.request.startsWith('https:')
            ? candidate.request
            : routerArtifact.request,
          singleton: true,
          strictVersion: true,
          treeShaking: false,
        },
      };
      const before = JSON.stringify(shared);
      await expect(finalFederationOptions(root, { shared })).rejects.toThrow(
        /artifact requiredVersion|Invalid installed framework manifest/u,
      );
      expect(JSON.stringify(shared)).toBe(before);
      expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(
        manifestSource,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Module Federation React JSX runtime sharing', () => {
  it('shares both JSX runtimes at the shared React version', () => {
    const react = { requiredVersion: '19.2.0', singleton: true };
    expect(withReactJsxRuntimeShared({ react })).toEqual({
      react,
      ...jsxRuntimes('19.2.0'),
    });
    expect(withReactJsxRuntimeShared({ react: '^19.2.0' })).toEqual({
      react: '^19.2.0',
      ...jsxRuntimes('^19.2.0'),
    });
    expect(withReactJsxRuntimeShared(['react'])).toEqual([
      'react',
      jsxRuntimes(),
    ]);
  });

  it('keeps explicit entries and leaves apps without shared React alone', () => {
    const shared = {
      react: { singleton: true },
      'react/jsx-runtime': { eager: true },
      'react/jsx-dev-runtime': { eager: true },
    };
    expect(withReactJsxRuntimeShared(shared)).toBe(shared);
    const withoutReact = { lodash: { singleton: true } };
    expect(withReactJsxRuntimeShared(withoutReact)).toBe(withoutReact);
    expect(withReactJsxRuntimeShared(undefined)).toBeUndefined();
  });

  it('runs after the federation plugins register their chain entries', () => {
    const manager = createPluginManager();
    manager.addPlugins([
      ultramodernModuleFederationSharedPlugin(),
      { name: '@modern-js/plugin-module-federation-ssr' },
      { name: '@modern-js/plugin-module-federation' },
    ]);
    expect(manager.getPlugins().at(-1)?.name).toBe(
      '@modern-js/ultramodern-module-federation-shared',
    );
  });

  it('shares the exported framework subpaths at the installed version', () => {
    const { appDirectory, runtimeDirectory } = createAppDirectory();
    try {
      const packages = resolveFrameworkSharedPackages(appDirectory);
      expect(packages).toEqual([
        expect.objectContaining({
          prefix: '@modern-js/runtime/',
          version: '9.9.9',
          requests: ['@modern-js/runtime/context'],
          directory: runtimeDirectory,
          contextsRequest: '@modern-js/runtime/context',
        }),
      ]);
      expect(withFrameworkShared({ react: '^19' }, packages)).toEqual({
        react: '^19',
        ...runtimeShare,
      });
      expect(withFrameworkShared(undefined, packages)).toEqual(runtimeShare);
      const explicit = { '@modern-js/runtime/context': { eager: true } };
      expect(withFrameworkShared(explicit, packages)).toBe(explicit);
    } finally {
      rmSync(appDirectory, { recursive: true, force: true });
    }
  });

  // A library that imports the JSX runtime without declaring `react` gives
  // Module Federation no description file to infer a required version from.
  // A JSX runtime share without one warns "No required version specified";
  // the preset's entries carry the shared React version, so none is inferred.
  it('never leaves a JSX runtime share to infer its required version', async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'ultramodern-mf-jsx-')),
    );
    const library = path.join(root, 'node_modules/jsx-library');
    mkdirSync(library, { recursive: true });
    writeFileSync(
      path.join(library, 'package.json'),
      JSON.stringify({ name: 'jsx-library', version: '1.0.0' }),
    );
    writeFileSync(
      path.join(library, 'index.js'),
      `import { jsx } from 'react/jsx-runtime';\nexport const Title = () => jsx('h1', {});\n`,
    );
    writeFileSync(
      path.join(root, 'widget.js'),
      `export { Title } from 'jsx-library';\n`,
    );
    const build = (shared: object) =>
      new Promise<string[]>((resolve, reject) => {
        rspack({
          context: root,
          mode: 'development',
          devtool: false,
          target: 'node',
          entry: {},
          output: { path: path.join(root, 'dist') },
          resolve: {
            modules: [
              'node_modules',
              path.resolve(__dirname, '../../node_modules'),
            ],
          },
          plugins: [
            new rspack.container.ModuleFederationPlugin({
              name: 'remote',
              filename: 'remoteEntry.js',
              exposes: { './widget': './widget.js' },
              shared: shared as never,
            }),
          ],
        }).run((error, stats) => {
          if (error) return reject(error);
          resolve(
            stats!
              .toJson({ all: false, warnings: true })
              .warnings!.map(warning => warning.message),
          );
        });
      });
    const react = { requiredVersion: '19.2.0', singleton: true };
    try {
      expect(await build(withReactJsxRuntimeShared({ react }))).toEqual([]);
      // The same share without a version is what warns.
      expect(
        await build({ react, 'react/jsx-runtime': { singleton: true } }),
      ).toEqual([expect.stringContaining('No required version specified')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites the browser and server federation plugin options', async () => {
    const { appDirectory } = createAppDirectory();
    let modifyBundlerChain: ((chain: RspackChain) => void) | undefined;
    ultramodernModuleFederationSharedPlugin().setup({
      getAppContext: () => ({ appDirectory }),
      modifyBundlerChain: (handler: typeof modifyBundlerChain) => {
        modifyBundlerChain = handler;
      },
    } as any);
    const react = { requiredVersion: '19.2.0', singleton: true };
    const rsbuild = await createRsbuild({
      rsbuildConfig: {
        source: { entry: { index: './src/index.js' } },
        tools: {
          bundlerChain: chain => {
            chain
              .plugin('plugin-module-federation')
              .use(rspack.container.ModuleFederationPlugin, [
                { name: 'host', shared: { react } },
              ]);
            chain.plugin('plugin-module-federation-server').use(
              class TreeShakingSharedPlugin {
                constructor(readonly options: unknown) {}
                apply() {}
              },
              [{ mfConfig: { name: 'host', shared: { react } } }],
            );
            modifyBundlerChain!(chain);
          },
        },
      },
    });
    const [config] = await rsbuild.initConfigs();
    const browser = config.plugins!.find(
      plugin => plugin instanceof rspack.container.ModuleFederationPlugin,
    ) as any;
    const server = config.plugins!.find(
      plugin => plugin?.constructor.name === 'TreeShakingSharedPlugin',
    ) as any;
    rmSync(appDirectory, { recursive: true, force: true });
    expect(browser._options.shared).toEqual({
      react,
      ...jsxRuntimes('19.2.0'),
      ...runtimeShare,
    });
    expect(server.options.mfConfig.shared).toEqual({
      react,
      ...jsxRuntimes('19.2.0'),
      ...runtimeShare,
    });
    // A host starts without loading remote entries it has not rendered.
    expect(browser._options.shareStrategy).toBe('loaded-first');
    expect(server.options.mfConfig.shareStrategy).toBe('loaded-first');
  });

  it('keeps an authored share strategy', async () => {
    const { appDirectory } = createAppDirectory();
    let modifyBundlerChain: ((chain: RspackChain) => void) | undefined;
    ultramodernModuleFederationSharedPlugin().setup({
      getAppContext: () => ({ appDirectory }),
      modifyBundlerChain: (handler: typeof modifyBundlerChain) => {
        modifyBundlerChain = handler;
      },
    } as any);
    const rsbuild = await createRsbuild({
      rsbuildConfig: {
        source: { entry: { index: './src/index.js' } },
        tools: {
          bundlerChain: chain => {
            chain
              .plugin('plugin-module-federation')
              .use(rspack.container.ModuleFederationPlugin, [
                { name: 'host', shareStrategy: 'version-first' },
              ]);
            modifyBundlerChain!(chain);
          },
        },
      },
    });
    const [config] = await rsbuild.initConfigs();
    rmSync(appDirectory, { recursive: true, force: true });
    const browser = config.plugins!.find(
      plugin => plugin instanceof rspack.container.ModuleFederationPlugin,
    ) as any;
    expect(browser._options.shareStrategy).toBe('version-first');
  });

  it('registers the manifest-recovery runtime plugin on the server federation plugin only', async () => {
    const { appDirectory } = createAppDirectory();
    const cwd = process.cwd();
    try {
      expect(resolveManifestRecoveryRuntimePlugin(appDirectory)).toBe(
        undefined,
      );
      const recovery = installFederationRuntime(appDirectory);
      // Resolution follows the app directory, whatever the working directory.
      process.chdir(tmpdir());
      expect(resolveManifestRecoveryRuntimePlugin(appDirectory)).toBe(recovery);

      let modifyBundlerChain: ((chain: RspackChain) => void) | undefined;
      ultramodernModuleFederationSharedPlugin().setup({
        getAppContext: () => ({ appDirectory }),
        modifyBundlerChain: (handler: typeof modifyBundlerChain) => {
          modifyBundlerChain = handler;
        },
      } as any);
      const rsbuild = await createRsbuild({
        cwd,
        rsbuildConfig: {
          source: { entry: { index: './src/index.js' } },
          tools: {
            bundlerChain: chain => {
              chain
                .plugin('plugin-module-federation')
                .use(rspack.container.ModuleFederationPlugin, [
                  { name: 'host', runtimePlugins: ['./app-plugin.js'] },
                ]);
              chain
                .plugin('plugin-module-federation-server')
                .use(rspack.container.ModuleFederationPlugin, [
                  {
                    name: 'host',
                    runtimePlugins: ['./app-plugin.js'],
                  },
                ]);
              modifyBundlerChain!(chain);
            },
          },
        },
      });
      const [config] = await rsbuild.initConfigs();
      const [browser, server] = config.plugins!.filter(
        plugin => plugin instanceof rspack.container.ModuleFederationPlugin,
      ) as any[];
      expect(browser._options.runtimePlugins).toEqual(['./app-plugin.js']);
      expect(server._options.runtimePlugins).toEqual([
        './app-plugin.js',
        recovery,
      ]);
      // An app that registered it explicitly keeps a single entry.
      expect(withRuntimePlugin([[recovery, {}]], recovery)).toEqual([
        [recovery, {}],
      ]);
    } finally {
      process.chdir(cwd);
      rmSync(appDirectory, { recursive: true, force: true });
    }
  });

  it('is contributed by presetUltramodern ahead of app plugins', () => {
    const appPlugin = { name: 'app-plugin' };
    expect(
      presetUltramodern({ plugins: [appPlugin] }).plugins?.map(
        plugin => plugin.name,
      ),
    ).toEqual([
      '@modern-js/ultramodern-module-federation-shared',
      'app-plugin',
    ]);
  });
});
