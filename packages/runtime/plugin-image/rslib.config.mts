import { defineConfig } from '@rslib/core';
import { getDtsCompilerOptions } from '../../../scripts/tsrs-dts/rslib-options.mjs';

export default defineConfig({
  lib: [
    {
      format: 'esm',
      syntax: 'es2021',
      dts: {
        ...getDtsCompilerOptions(),
      },
      source: {
        entry: { runtime: 'src/runtime.ts' },
      },
    },
    {
      format: 'cjs',
      syntax: 'es2021',
      source: {
        entry: { index: 'src/cli.ts' },
      },
    },
  ],
});
