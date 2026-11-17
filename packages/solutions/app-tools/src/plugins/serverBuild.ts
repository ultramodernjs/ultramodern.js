import { compile } from '@modern-js/server-utils';
import {
  getMeta,
  resolveServerTsconfig,
  SERVER_DIR,
  SHARED_DIR,
} from '@modern-js/utils';
import fs from 'fs';
import path from 'path';
import type { AppTools, CliPlugin } from '../types';

function checkHasCache(appDir: string) {
  const tsFilepath = path.resolve(appDir, SERVER_DIR, 'cache.ts');
  const jsfilepath = path.resolve(appDir, SERVER_DIR, 'cache.js');

  return fs.existsSync(tsFilepath) || fs.existsSync(jsfilepath);
}

function checkHasConfig(appDir: string, metaName = 'modern-js') {
  const meta = getMeta(metaName);

  const tsFilepath = path.resolve(appDir, SERVER_DIR, `${meta}.server.ts`);
  const jsfilepath = path.resolve(appDir, SERVER_DIR, `${meta}.server.js`);

  return fs.existsSync(tsFilepath) || fs.existsSync(jsfilepath);
}

function getServerSourceDirs(appDirectory: string, metaName?: string) {
  if (!checkHasCache(appDirectory) && !checkHasConfig(appDirectory, metaName)) {
    return [];
  }
  const serverDir = path.resolve(appDirectory, SERVER_DIR);
  const sharedDir = path.resolve(appDirectory, SHARED_DIR);

  const sourceDirs = [];
  if (fs.existsSync(serverDir)) {
    sourceDirs.push(serverDir);

    // compile the sharedDir only when serverDir exists
    if (fs.existsSync(sharedDir)) {
      sourceDirs.push(sharedDir);
    }
  }
  return sourceDirs;
}

export default (): CliPlugin<AppTools> => ({
  name: '@modern-js/server-build',

  setup(api) {
    api.updateAppContext({
      resolveServerCompileSourceDirs: () => {
        const { appDirectory, metaName } = api.getAppContext();
        return getServerSourceDirs(appDirectory, metaName);
      },
    });

    api.onAfterBuild(async () => {
      const {
        appDirectory,
        distDirectory,
        metaName,
        moduleType,
        serverCompileOwner,
      } = api.getAppContext();
      // The owner compiles these roots within its own single compilation.
      if (serverCompileOwner !== undefined) {
        return;
      }
      const modernConfig = api.getNormalizedConfig();

      const distDir = path.resolve(distDirectory);
      const tsconfigPath = resolveServerTsconfig(
        appDirectory,
        modernConfig?.server?.tsconfigPath,
      );

      const sourceDirs = getServerSourceDirs(appDirectory, metaName);

      const { alias } = modernConfig.source;

      if (sourceDirs.length > 0) {
        await compile(
          appDirectory,
          { alias, sourceMap: modernConfig.output?.sourceMap },
          {
            sourceDirs,
            distDir,
            tsconfigPath,
            moduleType,
            compiler: modernConfig.tools.serverCompiler,
            excludeFiles: api.getAppContext().serverCompileExcludedFiles,
          },
        );
      }
    });
  },
});
