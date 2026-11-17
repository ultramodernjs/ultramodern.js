import {
  compileServerSources,
  type ServerCompilationResult,
  type ServerCompileConfig,
  type ServerCompileOptions,
} from '@modern-js/app-tools-extensions/server-compiler';
import * as path from 'path';

export interface Pattern {
  from: string;
  to: string;
  tsconfigPath?: string;
}

export type IConfig = ServerCompileConfig;

export type CompileOptions = ServerCompileOptions;

export type CompileFunc = (
  appDirectory: string,
  modernConfig: IConfig,
  compileOptions: CompileOptions,
) => Promise<ServerCompilationResult>;

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
  const { sourceDirs, distDir } = compileOptions;
  validateAbsolutePaths(
    sourceDirs,
    dir => `source dir ${dir} is not an absolute path.`,
  );
  validateAbsolutePath(distDir, `dist dir ${distDir} is not an absolute path.`);

  return compileServerSources(appDirectory, modernConfig, compileOptions);
};
