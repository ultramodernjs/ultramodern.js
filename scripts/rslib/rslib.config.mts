import { defineConfig } from '@rslib/core';

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
        ...(process.env.ULTRAMODERN_DTS_COMPILER_MODULE
          ? {
              tsgo: true,
              typescriptPath: process.env.ULTRAMODERN_DTS_COMPILER_MODULE,
            }
          : {}),
      },
      autoExtension: true,
    },
  ],
});
