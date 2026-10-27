import { fileURLToPath } from 'node:url';
import { defineConfig, type RslibConfig } from '@rslib/core';
import { getDtsCompilerOptions } from '../../../scripts/tsrs-dts/rslib-options.mjs';

function nativeBindingTools(server: boolean): RslibConfig['tools'] {
  return {
    rspack(config) {
      config.module ??= { rules: [] };
      config.module.rules ??= [];
      config.module.rules.push({
        enforce: 'pre',
        test: /\.[cm]?[jt]sx?$/,
        include: fileURLToPath(new URL('./src', import.meta.url)),
        // The build-side adapter is plain Node TypeScript.
        exclude: fileURLToPath(new URL('./src/plugin', import.meta.url)),
        use: [
          {
            loader: fileURLToPath(
              new URL('./native-loader.cjs', import.meta.url),
            ),
            options: { server },
          },
        ],
      });
    },
  };
}

const source = {
  entry: { index: ['./src/**/*.{ts,tsx}'] },
};

const attribution = [
  { from: './src/router-binding/LICENSE', to: './router-binding/' },
  {
    from: './src/router-binding/PROVENANCE.json',
    to: './router-binding/PROVENANCE.json',
  },
];

// Runtime imports stay external so client and server resolve the same native
// Solid instance as the application's renderer-specific compilation.
export default defineConfig({
  performance: { buildCache: false },
  lib: [
    {
      id: 'esm-node',
      format: 'esm',
      syntax: 'es2022',
      bundle: false,
      outBase: './src',
      autoExtension: true,
      source,
      tools: nativeBindingTools(true),
      output: {
        target: 'node',
        distPath: { root: './dist/esm-node' },
        copy: attribution,
      },
      dts: {
        abortOnError: true,
        bundle: false,
        distPath: './dist/types',
        ...getDtsCompilerOptions(),
      },
    },
    {
      id: 'esm-web',
      format: 'esm',
      syntax: 'es2022',
      bundle: false,
      outBase: './src',
      autoExtension: true,
      source: {
        entry: {
          index: [
            './src/**/*.{ts,tsx}',
            '!./src/server.ts',
            '!./src/entry-server.tsx',
            '!./src/native-promise-serialization.ts',
            '!./src/plugin/**',
          ],
        },
      },
      tools: nativeBindingTools(false),
      output: {
        target: 'web',
        distPath: { root: './dist/esm' },
        copy: attribution,
      },
      dts: false,
    },
  ],
});
