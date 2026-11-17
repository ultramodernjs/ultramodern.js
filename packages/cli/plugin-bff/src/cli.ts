// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off processEnv:off strictBooleanExpressions:off unnecessaryArrowBlock:off
import type {
  AfterBffCompileFn,
  AppTools,
  BeforeBffCompileFn,
  CliPlugin,
  ModifyBffClientArtifactsFn,
  ModifyBffGeneratedEntriesFn,
} from '@modern-js/app-tools';
import { ApiRouter } from '@modern-js/bff-core';
import { createAsyncHook } from '@modern-js/plugin';
import type { ServerRoute } from '@modern-js/types';
import { normalizeOutputPath } from '@modern-js/utils';
import path from 'path';
import { createCompressConfig } from './cli/compress';
import { createBffGenerator } from './cli/generator';
import { getPrimaryPrefix } from './cli/prefix';
import { isWatchableBffFile } from './cli/watch';

export const bffPlugin = (): CliPlugin<AppTools> => ({
  name: '@modern-js/plugin-bff',
  registryHooks: {
    onBeforeBffCompile: createAsyncHook<BeforeBffCompileFn>(),
    onAfterBffCompile: createAsyncHook<AfterBffCompileFn>(),
    modifyBffClientArtifacts: createAsyncHook<ModifyBffClientArtifactsFn>(),
    modifyBffGeneratedEntries: createAsyncHook<ModifyBffGeneratedEntriesFn>(),
  },
  setup: api => {
    {
      const appContext = api.getAppContext();
      const userRuntimeFramework = api.getConfig()?.bff?.runtimeFramework;
      api.updateAppContext({
        ...appContext,
        bffRuntimeFramework: userRuntimeFramework ?? 'hono',
        // Every BFF build compiles the server roots with its own sources.
        serverCompileOwner: '@modern-js/plugin-bff',
      });
    }

    const { compileApi, handleCrossProjectInvocation } =
      createBffGenerator(api);

    const isHono = () => {
      const { bffRuntimeFramework } = api.getAppContext();
      return bffRuntimeFramework === 'hono';
    };

    api.config(async () => {
      const devServer = api.getConfig()?.tools?.devServer;
      const prefix = api.getConfig()?.bff?.prefix;

      const compress = createCompressConfig(devServer, prefix);

      return {
        tools: {
          devServer: {
            compress,
          },
          bundlerChain: (chain, { CHAIN_ID, isServer }) => {
            const { port, appDirectory, apiDirectory, lambdaDirectory } =
              api.getAppContext();
            const modernConfig = api.getNormalizedConfig();
            const { bff } = modernConfig || {};
            const prefix = getPrimaryPrefix(bff?.prefix);
            const httpMethodDecider = bff?.httpMethodDecider;

            const apiRouter = new ApiRouter({
              apiDir: apiDirectory,
              appDir: appDirectory,
              lambdaDir: lambdaDirectory,
              prefix,
              httpMethodDecider,
              isBuild: true,
            });

            const lambdaDir = apiRouter.getLambdaDir();
            const existLambda = apiRouter.isExistLambda();

            const apiRegexp = new RegExp(
              normalizeOutputPath(`${apiDirectory}${path.sep}.*(.[tj]s)$`),
            );

            const name = isServer ? 'server' : 'client';
            const sourceExt =
              process.env.MODERN_LIB_FORMAT === 'esm' ? 'mjs' : 'js';
            const loaderPath = path.join(__dirname, `loader.${sourceExt}`);
            chain.module.rule(CHAIN_ID.RULE.JS).exclude.add(apiRegexp);
            chain.module
              .rule('js-bff-api')
              .test(apiRegexp)
              .use('custom-loader')
              .loader(loaderPath.replace(/\\/g, '/'))
              .options({
                prefix,
                appDir: appDirectory,
                apiDir: apiDirectory,
                lambdaDir,
                existLambda,
                port,
                requestId: bff?.requestId,
                target: name,
                // Internal field
                requestCreator: (bff as any)?.requestCreator,
                clientCodegenPlugin: bff?.clientCodegenPlugin,
                httpMethodDecider,
              });
          },
        },
      };
    });

    api.modifyServerRoutes(({ routes }) => {
      const modernConfig = api.getNormalizedConfig();

      const { bff } = modernConfig || {};
      const prefix = bff?.prefix || '/api';

      const prefixList: string[] = [];

      if (Array.isArray(prefix)) {
        prefixList.push(...prefix);
      } else {
        prefixList.push(prefix);
      }
      const apiServerRoutes = prefixList.map(pre => ({
        urlPath: pre,
        isApi: true,
        entryPath: '',
        isSPA: false,
        isSSR: false,
      })) as ServerRoute[];

      if (!isHono() && bff?.enableHandleWeb) {
        return {
          routes: (
            routes.map(route => {
              return {
                ...route,
                isApi: true,
              };
            }) as ServerRoute[]
          ).concat(apiServerRoutes),
        };
      }

      return { routes: routes.concat(apiServerRoutes) };
    });

    api._internalServerPlugins(({ plugins }) => {
      plugins.push({
        name: '@modern-js/plugin-bff/server-plugin',
      });
      return { plugins };
    });

    api.onBeforeDev(async () => {
      await handleCrossProjectInvocation();
    });

    api.onAfterBuild(async () => {
      await compileApi('build');
      await handleCrossProjectInvocation(true);
    });

    api.addWatchFiles(async () => {
      const appContext = api.getAppContext();
      const config = api.getNormalizedConfig();

      if (config?.bff?.crossProject) {
        return [appContext.apiDirectory, appContext.sharedDirectory].filter(
          Boolean,
        ) as string[];
      } else {
        return [];
      }
    });

    api.onFileChanged(async e => {
      const { filename, eventType, isPrivate } = e;
      const { appDirectory, apiDirectory, sharedDirectory } =
        api.getAppContext();
      const relativeApiPath = path.relative(appDirectory, apiDirectory);
      const relativeSharedPath = sharedDirectory
        ? path.relative(appDirectory, sharedDirectory)
        : '';
      const isApiFile = filename.startsWith(`${relativeApiPath}/`);
      const isSharedFile = relativeSharedPath
        ? filename.startsWith(`${relativeSharedPath}/`)
        : false;
      if (
        !isPrivate &&
        (eventType === 'add' ||
          eventType === 'change' ||
          eventType === 'unlink') &&
        (isApiFile || isSharedFile) &&
        isWatchableBffFile(filename)
      ) {
        await handleCrossProjectInvocation();
      }
    });
  },
});

export default bffPlugin;
