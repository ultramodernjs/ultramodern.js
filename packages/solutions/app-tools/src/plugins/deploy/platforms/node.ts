import { createRequire } from 'node:module';
import path from 'node:path';
import { traceDeployFiles } from '@modern-js/app-tools-extensions/deploy-output/trace-files';
import {
  chalk,
  fs as fse,
  removeModuleSyncFromExports,
} from '@modern-js/utils';
import { readTemplate, resolveESMDependency } from '../utils';
import { generateHandler } from '../utils/generator';
import type { CreatePreset } from './platform';

export const createNodePreset: CreatePreset = ({
  appContext,
  modernConfig,
}) => {
  const { appDirectory, distDirectory, moduleType, serverPlugins } = appContext;
  const isEsmProject = moduleType === 'module';

  const outputDirectory = path.join(appDirectory, '.output');
  const staticDirectory = path.join(outputDirectory, 'static');
  const entryFilePath = path.join(outputDirectory, 'index.js');
  return {
    async prepare() {
      await fse.remove(outputDirectory);
    },
    async writeOutput() {
      await fse.copy(distDirectory, outputDirectory, {
        filter: src => {
          const relativePath = path
            .relative(distDirectory, src)
            .replace(/\\/gu, '/');
          return (
            relativePath !== 'release' && !relativePath.startsWith('release/')
          );
        },
      });
    },
    async genEntry() {
      const template = await readTemplate(
        `node-entry.${isEsmProject ? 'mjs' : 'cjs'}`,
      );

      const code = await generateHandler({
        template,
        appContext,
        config: modernConfig,
        isESM: isEsmProject,
      });

      await fse.writeFile(entryFilePath, code);
    },
    async end() {
      const filter = (filePath: string) => {
        return (
          !filePath.startsWith(staticDirectory) && !filePath.endsWith('.map')
        );
      };
      // Because @modern-js/prod-server is an implicit dependency of the entry, so we add it to the include here.
      const entry = isEsmProject
        ? await resolveESMDependency('@modern-js/prod-server')
        : require.resolve('@modern-js/prod-server');
      const requireFromApp = createRequire(
        path.join(appDirectory, 'package.json'),
      );
      const pluginEntries = new Set<string>();
      for (const plugin of serverPlugins) {
        for (const specifier of plugin.includeEntries ?? []) {
          pluginEntries.add(requireFromApp.resolve(specifier));
          if (!isEsmProject) continue;
          // The generated ESM server uses Node import conditions when
          // resolving plugin options at runtime. Trace that export as
          // well as the require branch used by the native deploy pass.
          pluginEntries.add(
            await resolveESMDependency(specifier, appDirectory),
          );
        }
      }
      // ndepe is heavy and only needed by `modern deploy`, so load it lazily.
      const { nodeDepEmit: handleDependencies } = await import('ndepe');
      await handleDependencies({
        traceFiles: traceDeployFiles,
        appDir: appDirectory,
        sourceDir: outputDirectory,
        includeEntries: [entry, ...pluginEntries],
        copyWholePackage(pkgName) {
          return pkgName === '@modern-js/utils';
        },
        entryFilter: filter,
        transformPackageJson: ({ pkgJSON }) => {
          if (!pkgJSON.exports) {
            return pkgJSON;
          }

          return {
            ...pkgJSON,
            exports: removeModuleSyncFromExports(
              pkgJSON.exports as Record<string, any>,
            ),
          };
        },
      });
      console.log(
        'Static directory:',
        chalk.blue(
          path.relative(appDirectory, staticDirectory).replace(/\\/g, '/'),
        ),
      );
      console.log(
        `You can preview this build by`,
        chalk.blue('node .output/index'),
      );
    },
  };
};
