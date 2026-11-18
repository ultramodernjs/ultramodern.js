import { globSync, readFileSync, statSync } from 'node:fs';
import { compatibleRequire } from '@modern-js/utils';
import path from 'path';
import { INDEX_SUFFIX } from './constants';
import type { APIHandlerInfo } from './types';

type MaybeAsync<I> = I | Promise<I>;
export type NormalHandler = (...args: any[]) => any;
export type Handler<I, O> = (input: I) => MaybeAsync<O>;

type IgnoreRule = { glob: string; negated: boolean; directoryOnly: boolean };

// Lines of every .gitignore inside `dir`, rebased onto `dir`. Ignore files
// above `dir` are not read: built API handlers live in gitignored dist folders.
const readIgnoreRules = (dir: string): IgnoreRule[] =>
  globSync('**/.gitignore', {
    cwd: dir,
    exclude: ['**/node_modules', '**/flow-typed', '**/coverage'],
  }).flatMap(file => {
    const base = path.dirname(file).split(path.sep).join('/');
    return readFileSync(path.join(dir, file), 'utf8')
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const negated = line.startsWith('!');
        const pattern = negated ? line.slice(1) : line;
        const body = pattern.replace(/\/$/, '');
        return {
          // A line without an inner slash matches at any depth below its file.
          glob: path.posix.join(base, body.includes('/') ? '' : '**', body),
          negated,
          directoryOnly: pattern.endsWith('/'),
        };
      });
  });

// As in git, the last matching line wins and nothing below an ignored
// directory comes back.
const isIgnored = (rules: IgnoreRule[], file: string) => {
  const segments = file.split(path.sep);
  return segments.some((_, index) => {
    const target = segments.slice(0, index + 1).join('/');
    const isDirectory = index < segments.length - 1;
    return rules.reduce(
      (ignored, rule) =>
        (isDirectory || !rule.directoryOnly) &&
        path.matchesGlob(target, rule.glob)
          ? !rule.negated
          : ignored,
      false,
    );
  });
};

export const getFiles = (
  lambdaDir: string,
  rules: string | string[],
): string[] => {
  const patterns = typeof rules === 'string' ? [rules] : rules;
  const ignoreRules = readIgnoreRules(lambdaDir);
  return globSync(
    patterns.filter(rule => !rule.startsWith('!')),
    {
      cwd: lambdaDir,
      exclude: patterns
        .filter(rule => rule.startsWith('!'))
        .map(rule => rule.slice(1)),
    },
  )
    .filter(
      file =>
        statSync(path.join(lambdaDir, file), {
          throwIfNoEntry: false,
        })?.isFile() && !isIgnored(ignoreRules, file),
    )
    .map(file => path.resolve(lambdaDir, file));
};

export const getPathFromFilename = (
  baseDir: string,
  filename: string,
): string => {
  const relativeName = filename.substring(baseDir.length);
  const relativePath = relativeName.split('.').slice(0, -1).join('.');

  const nameSplit = relativePath.split(path.sep).map(item => {
    if (item.length > 2) {
      if (item.startsWith('[') && item.endsWith(']')) {
        return `:${item.substring(1, item.length - 1)}`;
      }
    }

    return item;
  });

  const name = nameSplit.join('/');

  const finalName = name.endsWith(INDEX_SUFFIX)
    ? name.substring(0, name.length - INDEX_SUFFIX.length)
    : name;

  return clearRouteName(finalName);
};

const clearRouteName = (routeName: string): string => {
  let finalRouteName = routeName.trim();

  if (!finalRouteName.startsWith('/')) {
    finalRouteName = `/${finalRouteName}`;
  }

  if (finalRouteName.length > 1 && finalRouteName.endsWith('/')) {
    finalRouteName = finalRouteName.substring(0, finalRouteName.length - 1);
  }

  return finalRouteName;
};

export const isHandler = (input: any): input is Handler<any, any> =>
  input && typeof input === 'function';

const isFunction = (input: any): input is (...args: any) => any =>
  input && {}.toString.call(input) === '[object Function]';

export const requireHandlerModule = async (modulePath: string) => {
  const module = await compatibleRequire(modulePath, false);
  if (isFunction(module)) {
    return { default: module };
  }
  return module;
};

const routeValue = (routePath: string) => {
  if (routePath.includes(':')) {
    return 11;
  }
  return 1;
};

export const sortRoutes = (apiHandlers: APIHandlerInfo[]) => {
  return apiHandlers.sort((handlerA, handlerB) => {
    return routeValue(handlerA.routeName) - routeValue(handlerB.routeName);
  });
};
