import { copySync, readFileSync, statSync, writeFileSync } from 'fs-extra';
import { dirname, join } from 'path';
import type { TaskConfig } from './types';

export const ROOT_DIR = join(__dirname, '..', '..', '..');
export const PACKAGES_DIR = join(ROOT_DIR, 'packages');
export const DIST_DIR = 'compiled';

export const DEFAULT_EXTERNALS = {
  // External caniuse-lite data, so users can update it manually.
  'caniuse-lite': 'caniuse-lite',
  '/^caniuse-lite(/.*)/': 'caniuse-lite$1',
  // External webpack, it's hard to bundle.
  webpack: 'webpack',
  '/^webpack(/.*)/': 'webpack$1',
  // External lodash because lots of packages will depend on it.
  lodash: '@modern-js/utils/lodash',
  '/^lodash(/.*)/': 'lodash$1',
  // ncc bundled wrong package.json, using external to avoid this problem
  './package.json': './package.json',
  '../package.json': './package.json',
  '../../package.json': './package.json',
  postcss: 'postcss',
  '@babel/core': '@babel/core',
  '@babel/types': '@babel/types',
  '@babel/parser': '@babel/parser',
  '@babel/runtime': '@babel/runtime',
  '/^@babel/runtime(/.*)/': '@babel/runtime$1',
};

export const TASKS: TaskConfig[] = [
  {
    packageDir: 'toolkit/utils',
    packageName: '@modern-js/utils',
    dependencies: [
      // zero dependency
      'address',
      'filesize',
      'minimist',
      'pkg-up',
      'commander',
      {
        name: 'import-lazy',
        afterBundle(task) {
          // import-lazy drops `new.target`, so a subclass of a lazy export
          // (`class Derived extends Signale`) loses its prototype. Forward it.
          const entry = join(task.distPath, 'index.js');
          const source = readFileSync(entry, 'utf8');
          const construct =
            /construct:\((\w+),(\w+)\)=>\{(\w+)=lazy\(\3,(\w+),(\w+)\);return Reflect\.construct\(\3,\2\)\}/;
          if (!construct.test(source)) {
            throw new Error(
              'import-lazy construct trap changed; review the newTarget fix',
            );
          }
          writeFileSync(
            entry,
            source.replace(
              construct,
              'construct:($1,$2,newTarget)=>{$3=lazy($3,$4,$5);return Reflect.construct($3,$2,newTarget)}',
            ),
          );
        },
      },
      'dotenv-expand',
      'url-join',
      'slash',
      'nanoid',
      'upath',
      // a few dependencies
      'debug',
      {
        name: 'lodash',
        emitDts: false,
        externals: { lodash: 'lodash' },
        emitFiles: [
          {
            path: 'index.js',
            content: "module.exports = require('lodash');\n",
          },
          { path: 'index.mjs', content: "export * from 'lodash-es';\n" },
        ],
        afterBundle(task) {
          copySync(
            dirname(require.resolve('@types/lodash/package.json')),
            task.distPath,
            {
              filter: file =>
                statSync(file).isDirectory() || file.endsWith('.d.ts'),
            },
          );
        },
      },
      {
        name: 'semver',
        emitDts: false,
        afterBundle(task) {
          copySync(
            dirname(require.resolve('@types/semver/package.json')),
            task.distPath,
            {
              filter: file =>
                statSync(file).isDirectory() || file.endsWith('.d.ts'),
            },
          );
        },
      },
      'js-yaml',
      'mime-types',
      'strip-ansi',
      'gzip-size',
      {
        name: 'json5',
        externals: {
          minimist: '../minimist',
        },
      },
      // some dependencies
      'glob',
      'chalk',
      {
        name: 'signale',
        packageJsonField: ['options'],
      },
      'execa',
      'fs-extra',
      'browserslist',
      'chokidar',
      'ora',
      'inquirer',
      {
        name: 'tsconfig-paths',
        emitFiles: [
          {
            path: 'index.mjs',
            content:
              "import paths from './index.js';\nexport const { register, loadConfig, createMatchPath, matchFromAbsolutePaths, createMatchPathAsync, matchFromAbsolutePathsAsync } = paths;\n",
          },
        ],
        externals: {
          json5: '../json5',
          minimist: '../minimist',
        },
      },
    ],
  },
];
