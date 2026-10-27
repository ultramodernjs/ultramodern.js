import type {
  AppTools,
  BffCompilation,
  BffGeneration,
} from '@modern-js/app-tools';
import { ApiRouter } from '@modern-js/bff-core';
import type { CLIPluginAPI } from '@modern-js/plugin';
import { compile } from '@modern-js/server-utils';
import {
  type Alias,
  API_DIR,
  fs,
  upath as path,
  resolveServerTsconfig,
  SHARED_DIR,
} from '@modern-js/utils';
import type { ConfigChain } from '@rsbuild/core';
import clientGenerator from '../utils/clientGenerator';
import pluginGenerator, { renderBffPlugin } from '../utils/pluginGenerator';
import runtimeGenerator, { renderBffRuntime } from '../utils/runtimeGenerator';
import { getPrimaryPrefix } from './prefix';

const RUNTIME_CREATE_REQUEST = '@modern-js/plugin-bff/client';

export const createBffGenerator = (api: CLIPluginAPI<AppTools>) => {
  const compileApi = async () => {
    const {
      appDirectory,
      distDirectory,
      apiDirectory,
      sharedDirectory,
      moduleType,
    } = api.getAppContext();
    const config = api.getNormalizedConfig();
    const distDir = path.resolve(distDirectory);
    const apiDir = apiDirectory || path.resolve(appDirectory, API_DIR);
    const sharedDir = sharedDirectory || path.resolve(appDirectory, SHARED_DIR);
    const tsconfigPath = resolveServerTsconfig(
      appDirectory,
      config.server?.tsconfigPath,
    );
    const sourceDirs: string[] = [];
    for (const directory of [apiDir, sharedDir]) {
      if (await fs.pathExists(directory)) sourceDirs.push(directory);
    }
    if (sourceDirs.length === 0) return;
    const combinedAlias = ([] as unknown[])
      .concat(config.source.alias ?? [])
      .concat(config.resolve.alias ?? []) as ConfigChain<Alias>;
    const context: BffCompilation = {
      appDirectory,
      apiDirectory: apiDir,
      sourceDirectories: sourceDirs,
      outputDirectories: sourceDirs.map(directory =>
        path.resolve(distDir, path.relative(appDirectory, directory)),
      ),
      distDirectory: distDir,
      tsconfigPath,
      moduleType,
    };
    const hooks = api.getHooks();
    await hooks.onBeforeBffCompile.call(context);
    await compile(
      appDirectory,
      { alias: combinedAlias, sourceMap: config.output?.sourceMap },
      {
        sourceDirs,
        distDir,
        tsconfigPath,
        moduleType,
        excludeFiles: api.getAppContext().serverCompileExcludedFiles,
        throwErrorInsteadOfExit: true,
      },
    );
    await hooks.onAfterBffCompile.call(context);
  };

  const generate = async () => {
    const { appDirectory, apiDirectory, lambdaDirectory, port, packageName } =
      api.getAppContext();
    const config = api.getNormalizedConfig();
    const relativeDistPath = config.output?.distPath?.root || 'dist';
    const bff = config.bff;
    const prefix = getPrimaryPrefix(bff?.prefix);
    const apiRouter = new ApiRouter({
      apiDir: apiDirectory,
      appDir: appDirectory,
      lambdaDir: lambdaDirectory,
      prefix,
      httpMethodDecider: bff?.httpMethodDecider,
      isBuild: true,
    });
    const lambdaDir = apiRouter.getLambdaDir();
    const packageJson = await fs.readJSON(
      path.resolve(appDirectory, 'package.json'),
    );
    const generation: BffGeneration = {
      appDirectory,
      apiDirectory,
      lambdaDirectory: lambdaDir,
      existLambda: apiRouter.isExistLambda(),
      apiFiles: apiRouter.getApiFiles(),
      relativeDistPath,
      prefix,
      port,
      requestId: bff?.requestId || packageJson.name || packageName || 'default',
      requestCreator: bff?.requestCreator,
      httpMethodDecider: bff?.httpMethodDecider,
    };
    const pluginOptions = {
      prefix,
      appDirectory,
      relativeDistPath,
      relativeApiPath: path.relative(appDirectory, apiDirectory),
      relativeLambdaPath: path.relative(appDirectory, lambdaDir),
    };
    const runtimeOptions = {
      runtime: bff?.runtimeCreateRequest || RUNTIME_CREATE_REQUEST,
      appDirectory,
      relativeDistPath,
    };
    const hooks = api.getHooks();
    await clientGenerator(
      {
        prefix,
        appDir: appDirectory,
        apiDir: apiDirectory,
        lambdaDir,
        existLambda: generation.existLambda,
        apiFiles: [...generation.apiFiles],
        port,
        requestId: generation.requestId,
        requestCreator: generation.requestCreator,
        clientCodegenPlugin: bff?.clientCodegenPlugin,
        httpMethodDecider: generation.httpMethodDecider,
        relativeDistPath,
        relativeApiPath: pluginOptions.relativeApiPath,
      },
      {
        generation,
        modifyArtifacts: async context => {
          const result = await hooks.modifyBffClientArtifacts.call(context);
          if (result.generation !== generation)
            throw new Error(
              'modifyBffClientArtifacts must preserve generation identity.',
            );
          return result;
        },
        beforePublish: async () => {
          const entries = await hooks.modifyBffGeneratedEntries.call({
            generation,
            plugin: await renderBffPlugin(pluginOptions),
            runtime: renderBffRuntime(runtimeOptions),
            packageDependencies: {},
          });
          if (entries.generation !== generation)
            throw new Error(
              'modifyBffGeneratedEntries must preserve generation identity.',
            );
          await pluginGenerator(pluginOptions, entries.plugin);
          await runtimeGenerator(runtimeOptions, entries.runtime);
          return entries.packageDependencies;
        },
      },
    );
  };

  const handleCrossProjectInvocation = async (isBuild = false) => {
    if (api.getNormalizedConfig().bff?.crossProject !== true) return;
    if (!isBuild) await compileApi();
    await generate();
  };
  return { compileApi, generate, handleCrossProjectInvocation };
};
