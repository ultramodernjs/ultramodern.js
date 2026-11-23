import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { compatibleRequire, fs } from '@modern-js/utils';
import { createJiti, type TransformOptions } from 'jiti';
import path from 'path';

export const getConfigFilePath = (
  appDirectory: string,
  configFilePath: string | false,
) => {
  if (configFilePath === false) {
    return false;
  }
  if (path.isAbsolute(configFilePath)) {
    return configFilePath;
  }
  return path.resolve(appDirectory, configFilePath);
};

/**
 * Load a configuration file dynamically
 * @param {string} configFile - Path to the configuration file (absolute or relative)
 * @returns {any} - The loaded configuration object
 */
async function loadConfigContent<T>(configFile: string): Promise<T> {
  const isESM = process.env.MODERN_LIB_FORMAT === 'esm';
  const jitiFrom =
    // @ts-ignore
    isESM ? import.meta.url : __filename;
  const transformer = createJiti(jitiFrom, { fsCache: false });
  // Create a jiti instance
  const jiti = createJiti(jitiFrom, {
    // disable require cache to support restart CLI and read the new config
    requireCache: false,
    interopDefault: true,
    ...(!isESM && {
      // The evaluation format also depends on package.json, not just source.
      fsCache: false,
      transform: (options: TransformOptions) => {
        const filename = options.filename;
        const installedDependency = filename
          ?.split(/[\\/]/)
          .includes('node_modules');
        const packageFile =
          installedDependency && filename?.endsWith('.js')
            ? findPackageJSON(pathToFileURL(filename))
            : undefined;
        if (
          installedDependency &&
          (filename?.endsWith('.mjs') ||
            (packageFile &&
              JSON.parse(fs.readFileSync(packageFile, 'utf8'))?.type ===
                'module'))
        ) {
          // Installed ESM is immutable; Jiti still reloads local JS and TS.
          return {
            code: 'module.exports = require("node:module").createRequire(__filename)(__filename);',
          };
        }
        return { code: transformer.transform(options) };
      },
    }),
  });
  // Check if the file exists
  if (!fs.existsSync(configFile)) {
    throw new Error(`Configuration file does not exist: ${configFile}`);
  }

  try {
    const config: any = isESM
      ? await jiti.import(configFile, {})
      : jiti(configFile);

    // If the file exports as ESM, access the `default` property
    return config.default || config;
  } catch (e: any) {
    if (e instanceof Error) {
      e.message = `Get Error while loading config file: ${configFile}, please check it and retry.\n${
        e.message || ''
      }`;
    }
    throw e;
  }
}

/**
 * Parse and load user config file, support extensions like .ts, mjs, js, ejs.
 * @param appDirectory - App root directory, from which start search user config file.
 * @param configFile - Specific absolute config file path.
 * @returns Object contain config file path, user config object and dependency files used by config file.
 */
/**
 * Load a TypeScript file dynamically using jiti
 * @param {string} filePath - Path to the TypeScript file (absolute or relative)
 * @returns {any} - The loaded module object
 */
export const loadTypeScriptFile = (filePath: string): any => {
  const jiti = createJiti(__filename, {
    requireCache: false,
    interopDefault: true,
  });

  if (!fs.existsSync(filePath)) {
    throw new Error(`TypeScript file does not exist: ${filePath}`);
  }

  try {
    return jiti(filePath);
  } catch (e: any) {
    if (e instanceof Error) {
      e.message = `Get Error while loading TypeScript file: ${filePath}, please check it and retry.\n${
        e.message || ''
      }`;
    }
    throw e;
  }
};

export const loadConfig = async <T>(
  appDirectory: string,
  configFile: string | false,
): Promise<{
  packageName: string;
  configFile: string | false;
  config?: T;
  pkgConfig?: T;
}> => {
  const pkg = await compatibleRequire(
    path.resolve(appDirectory, './package.json'),
  );
  const packageName = pkg.name;

  let config: T | undefined;

  if (configFile) {
    config = await loadConfigContent<T>(configFile);
  }

  return {
    packageName,
    configFile,
    config,
  };
};
