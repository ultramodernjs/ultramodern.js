import { defineConfig } from '@rslib/core';
import { getDtsCompilerOptions } from '../tsrs-dts/rslib-options.mjs';

export default defineConfig({
  lib: [
    {
      format: 'cjs',
      syntax: 'es2021',
      bundle: false,
      outBase: './src',
      output: {
        distPath: {
          root: './dist/cjs',
        },
        target: 'node',
      },
      dts: {
        abortOnError: true,
        bundle: false,
        distPath: './dist/types',
        ...getDtsCompilerOptions(),
      },
      autoExtension: true,
    },
  ],
});
