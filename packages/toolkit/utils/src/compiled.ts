import { createRequire } from 'node:module';
import { Import } from './import';

export { default as dotenv } from 'dotenv';
export { default as address, ip } from '../compiled/address/index.mjs';
export { default as browserslist } from '../compiled/browserslist';
export { default as chalk } from '../compiled/chalk/index.mjs';
export { Command, program } from '../compiled/commander/index.mjs';
export { default as debug } from '../compiled/debug';

import _dotenvExpand from '../compiled/dotenv-expand';
export const { expand: dotenvExpand } = _dotenvExpand;
export { execa, execaSync } from '../compiled/execa/index.mjs';
export { filesize } from '../compiled/filesize/index.mjs';
export { default as fs } from '../compiled/fs-extra';
export { glob } from '../compiled/glob/index.mjs';
export { gzipSize } from '../compiled/gzip-size/index.mjs';
export * as yaml from '../compiled/js-yaml/index.mjs';
export { default as json5 } from '../compiled/json5';
export { default as lodash } from '../compiled/lodash';
export { default as minimist } from '../compiled/minimist';
export { nanoid } from '../compiled/nanoid/index.mjs';
export { default as ora } from '../compiled/ora/index.mjs';
export { default as pkgUp } from '../compiled/pkg-up/index.js';
export { default as semver } from '../compiled/semver';
export { default as slash } from '../compiled/slash/index.mjs';
export { default as stripAnsi } from '../compiled/strip-ansi/index.mjs';
export { default as upath } from '../compiled/upath/index.mjs';
export { default as urlJoin } from '../compiled/url-join/index.mjs';

type SignaleModule = typeof import('../compiled/signale').default;

export type {
  ChokidarOptions as WatchOptions,
  FSWatcher,
} from '../compiled/chokidar/index.mjs';
export type { ExecaError } from '../compiled/execa/index.mjs';
export type { GlobOptions } from '../compiled/glob/index.mjs';
export type SignaleOptions = SignaleModule['SignaleOptions'];

/**
 * Lazy import some expensive modules that will slow down startup speed.
 * Notice that `csmith-tools build` can not bundle lazy imported modules.
 */
const getNodeRequire = () => createRequire(import.meta.url);
export const mime: typeof import('../compiled/mime-types') = Import.lazy(
  '../compiled/mime-types',
  getNodeRequire,
);
export const chokidar: typeof import('../compiled/chokidar/index.mjs') =
  Import.lazy('../compiled/chokidar/index.mjs', getNodeRequire);
export const signale: SignaleModule = Import.lazy(
  '../compiled/signale',
  getNodeRequire,
);
export const Signale: SignaleModule['Signale'] = Import.lazy(
  '../compiled/signale',
  () => moduleName => getNodeRequire()(moduleName).Signale,
);
export const inquirer: typeof import('../compiled/inquirer').default =
  Import.lazy(
    '../compiled/inquirer',
    () => name => getNodeRequire()(name).default,
  );
