import type {
  SourceNormalizedConfig,
  ToolsNormalizedConfig,
} from '@modern-js/server-core';
import { fs, logger } from '@modern-js/utils';
import type { LibConfig } from '@rslib/core';
import * as path from 'path';

export interface Pattern {
  from: string;
  to: string;
  tsconfigPath?: string;
}

export interface IConfig {
  alias?: SourceNormalizedConfig['alias'];
  sourceMap?: NonNullable<LibConfig['output']>['sourceMap'];
}

export interface CompileOptions {
  sourceDirs: string[];
  distDir: string;
  /** Absolute files excluded as roots; imported dependencies remain checked. */
  excludeFiles?: string[];
  tsconfigPath?: string;
  moduleType?: 'module' | 'commonjs';
  throwErrorInsteadOfExit?: boolean;
}

export type CompileFunc = (
  appDirectory: string,
  modernConfig: IConfig,
  compileOptions: CompileOptions,
) => Promise<void>;

export const FILE_EXTENSIONS = ['.js', '.ts', '.mjs', '.ejs'];

const validateAbsolutePath = (filename: string, message: string) => {
  if (!path.isAbsolute(filename)) {
    throw new Error(message);
  }
};

const validateAbsolutePaths = (
  filenames: string[],
  messageFunc: (filename: string) => string,
) => {
  filenames.forEach(filename =>
    validateAbsolutePath(filename, messageFunc(filename)),
  );
};

export const compile: CompileFunc = async (
  appDirectory,
  modernConfig,
  compileOptions,
) => {
  const {
    sourceDirs,
    distDir,
    excludeFiles = [],
    tsconfigPath,
  } = compileOptions;
  validateAbsolutePaths(
    sourceDirs,
    dir => `source dir ${dir} is not an absolute path.`,
  );
  validateAbsolutePath(distDir, `dist dir ${distDir} is not an absolute path.`);
  validateAbsolutePaths(
    excludeFiles,
    file => `excluded file ${file} is not an absolute path.`,
  );

  if (!tsconfigPath) {
    return;
  }
  const { compileServerSources } = await import('../compilers/rslib');
  try {
    await compileServerSources(appDirectory, modernConfig, {
      ...compileOptions,
      tsconfigPath,
    });
  } catch (error) {
    if (compileOptions.throwErrorInsteadOfExit) {
      throw error;
    }
    logger.error(error);
    process.exit(1);
  }
};
