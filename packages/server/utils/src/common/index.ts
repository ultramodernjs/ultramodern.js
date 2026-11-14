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

/** A parsed JSON tsconfig, with paths based at its owning config file. */
export interface ServerCompilerConfig {
  compilerOptions?: {
    allowJs?: boolean;
    baseUrl?: string;
    composite?: boolean;
    declaration?: boolean;
    declarationMap?: boolean;
    emitDeclarationOnly?: boolean;
    experimentalDecorators?: boolean;
    incremental?: boolean;
    jsx?: string;
    moduleResolution?: string;
    noEmit?: boolean;
    noEmitOnError?: boolean;
    outDir?: string;
    paths?: Record<string, string[]>;
    rootDir?: string;
    tsBuildInfoFile?: string;
    [option: string]: unknown;
  };
  files?: string[];
  include?: string[];
  references?: Array<{ path: string }>;
}

/** Config parsing, checking and declarations must belong to one compiler. */
export interface ServerCompiler {
  command: {
    executable: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
  };
  readConfig: (tsconfigPath: string) => Promise<ServerCompilerConfig>;
  /** Rslib-compatible module exporting version, with adjacent getExePath.js. */
  typescriptPath: string;
  dispose?: () => Promise<void>;
}

export interface CompileOptions {
  /** Omit to retain the stable TypeScript compiler shipped by server-utils. */
  compiler?: (appDirectory: string) => ServerCompiler | Promise<ServerCompiler>;
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
