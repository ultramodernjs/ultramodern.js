import {
  RSLIB_CODE_ENTRY_GLOB,
  rslibConfig,
  ts7DtsConfig,
} from '@modern-js/rslib';
import { defineConfig } from '@rslib/core';

export default defineConfig({
  ...rslibConfig,
  lib: rslibConfig.lib.map(lib =>
    lib.id === 'esm-web'
      ? {
          ...lib,
          source: {
            ...lib.source,
            entry: {
              index: [
                RSLIB_CODE_ENTRY_GLOB,
                '!./src/static-serving/**',
                '!./src/render-resources/**',
                '!./src/bff-policy/node.ts',
                '!./src/bff-policy/operationContracts.ts',
                '!./src/bff-policy/resolveCrossProjectPolicy.ts',
              ],
            },
          },
        }
      : lib.id === 'esm-node'
        ? {
            ...lib,
            dts: {
              ...ts7DtsConfig,
              autoExtension: true,
              distPath: './dist/types-esm',
            },
          }
        : lib,
  ),
});
