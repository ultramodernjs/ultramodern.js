import type { SerializedServerGlobalVars } from '@modern-js/plugin-bff-extensions/server-global-vars';
import { fs } from '@modern-js/utils';

const RELEASE_IDENTITY_GLOBAL_NAMES = [
  'ULTRAMODERN_BUILD_MARKER',
  'ULTRAMODERN_SOURCE_REVISION',
  'ULTRAMODERN_RELEASE_VERSION',
] as const;

const JAVASCRIPT_FILE = /\.(?:c|m)?js$/u;

/** Finalizes globals in exactly the files the server compiler emitted. */
export const transformServerGlobalVars = (
  emittedFiles: readonly string[],
  globalVars: SerializedServerGlobalVars,
) =>
  Promise.resolve().then(() => {
    if (Object.keys(globalVars).length === 0) {
      return undefined;
    }

    const files = emittedFiles.filter(filename =>
      JAVASCRIPT_FILE.test(filename),
    );
    const releaseIdentityBanner = RELEASE_IDENTITY_GLOBAL_NAMES.every(name =>
      Object.hasOwn(globalVars, name),
    )
      ? // String statements, so a following "use strict" stays in the prologue.
        `${RELEASE_IDENTITY_GLOBAL_NAMES.map(name => `${globalVars[name]};`).join('')}\n`
      : '';

    return Promise.all(
      files.map(filename =>
        fs.readFile(filename, 'utf8').then(source => {
          const sourceMapFilename = `${filename}.map`;
          return fs.pathExists(sourceMapFilename).then(sourceMapExists => {
            const inputSourceMapPromise: Promise<string | undefined> =
              sourceMapExists
                ? fs.readFile(sourceMapFilename, 'utf8')
                : Promise.resolve(undefined);

            return inputSourceMapPromise.then(async inputSourceMap => {
              const { transform } = await import('@swc/core');
              return transform(`${releaseIdentityBanner}${source}`, {
                filename,
                inputSourceMap,
                sourceMaps: sourceMapExists,
                jsc: {
                  parser: {
                    syntax: 'ecmascript',
                  },
                  preserveAllComments: true,
                  target: 'es2024',
                  transform: {
                    optimizer: {
                      globals: {
                        vars: globalVars,
                      },
                    },
                  },
                },
              }).then(result =>
                fs.writeFile(filename, result.code).then(() => {
                  if (
                    sourceMapExists &&
                    result.map !== undefined &&
                    result.map.length > 0
                  ) {
                    return fs.writeFile(sourceMapFilename, result.map);
                  }
                  return undefined;
                }),
              );
            });
          });
        }),
      ),
    ).then(() => undefined);
  });
