import path from 'node:path';
import { SERVICE_WORKER_ENVIRONMENT_NAME } from '@modern-js/builder';
import type { AppContext, CLIPluginExtends } from '@modern-js/plugin/cli';
import type { RsbuildPlugin, RspackChain } from '@rsbuild/core';

export const builderPluginAdapterBasic = <
  Options extends {
    appContext: Pick<AppContext<CLIPluginExtends>, 'metaName'> & {
      internalDirectory?: string;
    };
  },
>(
  options: Options,
): RsbuildPlugin => ({
  name: 'builder-plugin-adapter-modern-basic',

  setup(api) {
    api.modifyBundlerChain((chain, { target, CHAIN_ID, environment }) => {
      const isServiceWorker =
        environment.name === SERVICE_WORKER_ENVIRONMENT_NAME;
      const isWebTargetServiceWorker = isServiceWorker && target === 'web';

      // apply node compat
      if (target === 'node' || isServiceWorker) {
        applyNodeCompat(isServiceWorker, chain, {
          includeNodeExtensions: !isWebTargetServiceWorker,
        });
      }

      if (target === 'web' && !isServiceWorker) {
        const bareServerModuleReg = /\.(server|node)\.[tj]sx?$/;
        const depExt = process.env.MODERN_LIB_FORMAT === 'esm' ? 'mjs' : 'js';
        chain.module.rule(CHAIN_ID.RULE.JS).exclude.add(bareServerModuleReg);
        chain.module
          .rule('bare-server-module')
          .test(bareServerModuleReg)
          .use('server-module-loader')
          .loader(
            path.join(__dirname, `../loaders/serverModuleLoader.${depExt}`),
          );
      }

      const { appContext } = options;

      // Keep the array form: plugins such as Module Federation append their
      // own entries to an array, but replace a single RegExp.
      chain.watchOptions({
        ignored: [
          createWatchIgnored(
            appContext.internalDirectory ??
              path.join('node_modules', `.${appContext.metaName}`),
          ),
        ],
      });
    });

    // Use modifyRspackConfig to ensure extensionAlias has higher priority than rsbuild defaults
    api.modifyRspackConfig((config, { target, environment }) => {
      const isServiceWorker =
        environment.name === SERVICE_WORKER_ENVIRONMENT_NAME;
      const isWebTargetServiceWorker = isServiceWorker && target === 'web';

      if (target === 'node' || isServiceWorker) {
        // Define extensionAlias for server and node files
        // a .mjs file will resolve in order of .node.mjs, .server.mjs, .mjs
        const extensionAlias: Record<string, string[]> =
          isWebTargetServiceWorker
            ? {
                '.js': ['.worker.js', '.server.js', '.js'],
                '.jsx': ['.worker.jsx', '.server.jsx', '.jsx'],
                '.ts': ['.worker.ts', '.server.ts', '.ts'],
                '.tsx': ['.worker.tsx', '.server.tsx', '.tsx'],
                '.mjs': ['.worker.mjs', '.server.mjs', '.mjs'],
                '.json': ['.worker.json', '.server.json', '.json'],
              }
            : {
                '.js': ['.node.js', '.server.js', '.js'],
                '.jsx': ['.node.jsx', '.server.jsx', '.jsx'],
                '.ts': ['.node.ts', '.server.ts', '.ts'],
                '.tsx': ['.node.tsx', '.server.tsx', '.tsx'],
                '.mjs': ['.node.mjs', '.server.mjs', '.mjs'],
                '.json': ['.node.json', '.server.json', '.json'],
              };

        config.resolve ??= {};
        config.resolve.extensionAlias = {
          ...config.resolve.extensionAlias,
          ...extensionAlias,
        };
      }
    });
  },
});

/** compat some config, if target is `node` or `worker` */
function applyNodeCompat(
  isServiceWorker: boolean,
  chain: RspackChain,
  options: { includeNodeExtensions?: boolean } = {},
) {
  const { includeNodeExtensions = true } = options;
  const nodeExts = [
    '.node.js',
    '.node.jsx',
    '.node.ts',
    '.node.tsx',
    '.node.mjs',
    '.server.js',
    '.server.jsx',
    '.server.ts',
    '.server.tsx',
    '.server.mjs',
  ];
  const webWorkerExts = [
    '.worker.js',
    '.worker.jsx',
    '.worker.ts',
    '.worker.tsx',
  ];
  // apply node resolve extensions
  if (includeNodeExtensions) {
    for (const ext of nodeExts) {
      chain.resolve.extensions.prepend(ext);
    }
  }

  if (isServiceWorker) {
    for (const ext of webWorkerExts) {
      chain.resolve.extensions.prepend(ext);
    }
  }
}

// Ignore node_modules and .git, but keep watching the generated internal
// directory (`output.tempDir`), which usually lives inside node_modules.
function createWatchIgnored(internalDirectory: string) {
  const segments = internalDirectory.split(/[\\/]/);
  const index = segments.lastIndexOf('node_modules');
  const internalPath = segments
    .slice(index + 1)
    .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
  const nodeModules =
    index === -1 || !internalPath
      ? 'node_modules'
      : `node_modules(?![\\\\/]${internalPath}(?:[\\\\/]|$))`;
  return new RegExp(`[\\\\/](?:${nodeModules}|\\.git)[\\\\/]`);
}
