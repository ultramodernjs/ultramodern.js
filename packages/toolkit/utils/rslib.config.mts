import { rslibConfig } from '@modern-js/rslib';
import { defineConfig, type RslibConfig, type Rspack } from '@rslib/core';

const dependencies = [
  'address',
  'filesize',
  'minimist',
  'pkg-up',
  'commander',
  'import-lazy',
  'dotenv-expand',
  'url-join',
  'slash',
  'nanoid',
  'lodash',
  'upath',
  'debug',
  'semver',
  'js-yaml',
  'mime-types',
  'strip-ansi',
  'gzip-size',
  'json5',
  'glob',
  'chalk',
  'signale',
  'execa',
  'fs-extra',
  'browserslist',
  'chokidar',
  'globby',
  'ora',
  'inquirer',
  'tsconfig-paths',
];

const externalsMap = dependencies.map(name => ({
  name,
  regex: new RegExp(`compiled[\\/]${name}(?:[\\/]|$)`),
}));

// externalize pre-bundled dependencies
const createExternals =
  (type?: string, noESM = false): Rspack.ExternalItem =>
  ({ request }, callback) => {
    if (request) {
      for (const { name, regex } of externalsMap) {
        if (request === name) {
          throw new Error(
            `"${name}" is not allowed to be imported, use "../compiled/${name}/index.js" instead.`,
          );
        }
        if (regex.test(request)) {
          const index =
            !noESM && request.endsWith('.mjs') ? 'index.mjs' : 'index.js';
          const base = request.replace(/[/\\]index\.[cm]?js$/, '');
          const external = `${base}/${index}`;
          return callback(undefined, type ? `${type} ${external}` : external);
        }
      }
    }
    callback();
  };

const lib: RslibConfig['lib'] = rslibConfig.lib?.map(config => {
  if (config.format === 'esm') {
    return {
      ...config,
      output: {
        ...config.output,
        externals: [createExternals()],
      },
    };
  }
  if (config.format === 'cjs') {
    return {
      ...config,
      // Declarations must keep the specifiers tsgo checked. Extension
      // redirection probes dist/compiled, which the copy below writes
      // concurrently, so `.mjs` imports randomly became `.js` and loaded a
      // second, nominally distinct chokidar declaration.
      redirect: {
        ...config.redirect,
        dts: { ...config.redirect?.dts, extension: false },
      },
      output: {
        ...config.output,
        externals: [
          createExternals('commonjs', true),
          {
            'import-meta-resolve': 'var {}',
          },
        ],
        copy: [
          {
            from: './compiled',
            to: '../compiled',
          },
        ],
      },
    };
  }
  return config;
});

export default defineConfig({
  ...rslibConfig,
  lib,
});
