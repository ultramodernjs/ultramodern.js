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

export default (): CliPlugin<AppTools> => ({
  name: '@modern-js/server-build',

  setup(api) {
    api.onAfterBuild(async () => {
      const { appDirectory, distDirectory, metaName, moduleType } =
        api.getAppContext();
      if (
        !checkHasCache(appDirectory) &&
        !checkHasConfig(appDirectory, metaName)
      ) {
        return;
      }
      const modernConfig = api.getNormalizedConfig();

      const distDir = path.resolve(distDirectory);
      const serverDir = path.resolve(appDirectory, SERVER_DIR);
      const sharedDir = path.resolve(appDirectory, SHARED_DIR);
      const tsconfigPath = resolveServerTsconfig(
        appDirectory,
        modernConfig?.server?.tsconfigPath,
      );

      const sourceDirs = [];
      if (fs.existsSync(serverDir)) {
        sourceDirs.push(serverDir);

        // compile the sharedDir only when serverDir exists
        if (fs.existsSync(sharedDir)) {
          sourceDirs.push(sharedDir);
        }
      }

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
            excludeFiles: api.getAppContext().serverCompileExcludedFiles,
          },
        );
      }
    });
  },
});
