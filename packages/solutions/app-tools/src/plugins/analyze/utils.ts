import {
  getCommand,
  JS_EXTENSIONS,
  normalizeToPosixPath,
} from '@modern-js/utils';
import { init, parse } from 'es-module-lexer';
import { transform } from 'esbuild';
import fs from 'fs';
import path from 'path';

export const walkDirectory = (dir: string): string[] => {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, dirent.name);
      // Only stat symlinks, so they are followed like before.
      const isDirectory = dirent.isSymbolicLink()
        ? fs.statSync(filePath).isDirectory()
        : dirent.isDirectory();
      if (isDirectory) {
        walk(filePath);
      } else {
        files.push(filePath);
      }
    }
  };
  walk(dir);
  return files;
};

export const replaceWithAlias = (
  base: string,
  filePath: string,
  alias: string,
) => {
  if (filePath.includes(base)) {
    return normalizeToPosixPath(
      path.join(alias, path.relative(base, filePath)),
    );
  } else {
    return filePath;
  }
};

export const parseModule = async ({
  source,
  filename,
}: {
  source: string;
  filename: string;
}) => {
  let content = source;

  if (JS_EXTENSIONS.some(ext => filename.endsWith(ext))) {
    const ext = path.extname(filename);
    const result = await transform(content, {
      sourcefile: filename,
      format: 'esm',
      loader:
        ext === '.ts'
          ? 'ts'
          : ext === '.tsx'
            ? 'tsx'
            : ext === '.jsx'
              ? 'jsx'
              : 'js',
      target: 'es2022',
      tsconfigRaw: {
        compilerOptions: {
          experimentalDecorators: true,
        },
      },
    });
    content = result.code;
  }

  await init();
  return parse(content);
};

export const getServerCombinedModuleFile = (
  internalDirectory: string,
  entryName: string,
) => {
  return path.join(internalDirectory, entryName, 'server-loader-combined.js');
};

export const checkIsBuildCommands = () => {
  const buildCommands = [
    'dev',
    'start',
    'build',
    'inspect',
    'deploy',
    'dev-worker',
  ];
  const command = getCommand();

  return buildCommands.includes(command);
};

export const checkIsServeCommand = () => {
  const command = getCommand();

  return command === 'serve';
};

export const isSubDirOrEqual = (parent: string, child: string): boolean => {
  if (parent === child) {
    return true;
  }
  const relative = path.relative(parent, child);
  const isSubdir =
    relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return Boolean(isSubdir);
};
