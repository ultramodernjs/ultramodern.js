import { defineConfig } from '@rslib/core';
import { getDtsCompilerOptions } from '../../../scripts/tsrs-dts/rslib-options.mjs';

export default defineConfig({
  lib: [
    {
      format: 'esm',
      dts: {
        ...getDtsCompilerOptions(),
      },
      bundle: false,
      syntax: 'es2021',
    },
  ],
});
