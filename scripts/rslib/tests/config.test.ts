import { expect, test } from '@rstest/core';
import mcpConfig from '../../../packages/toolkit/mcp-apps/rslib.config.mts';
import { getDtsCompilerOptions } from '../../tsrs-dts/rslib-options.mjs';
import { rslibConfig } from '../src';

test('direct builds select the Effect declaration adapter without a launcher environment', () => {
  expect(getDtsCompilerOptions({})).toEqual({
    tsgo: true,
    typescriptPath: require.resolve('@scripts/effect-tsrs-dts/version.cjs'),
  });
  expect(
    getDtsCompilerOptions({
      ULTRAMODERN_DTS_COMPILER_MODULE: '/selected/compiler.cjs',
    }),
  ).toEqual({ tsgo: true, typescriptPath: '/selected/compiler.cjs' });
});

test('generates shared declarations from a single library target', () => {
  const declarationTargets = rslibConfig.lib.filter(config => config.dts);

  expect(declarationTargets).toHaveLength(1);
  expect(declarationTargets[0]).toMatchObject({
    id: 'cjs-node',
    dts: {
      abortOnError: true,
      bundle: false,
      distPath: './dist/types',
      ...getDtsCompilerOptions(),
    },
  });
});

test('MCP libraries retain node and browser output with checked declarations', () => {
  expect(
    mcpConfig.lib.map(config => ({
      format: config.format,
      target: config.output.target,
      directory: config.output.distPath.root,
    })),
  ).toEqual([
    { format: 'esm', target: 'node', directory: 'dist/esm-node' },
    { format: 'cjs', target: 'node', directory: 'dist/cjs' },
    { format: 'esm', target: 'web', directory: 'dist/esm' },
  ]);

  const declarationTargets = mcpConfig.lib.filter(config => config.dts);
  expect(declarationTargets).toHaveLength(1);
  for (const config of declarationTargets) {
    expect(config.dts).toEqual({
      abortOnError: true,
      bundle: false,
      distPath: 'dist/types',
      ...getDtsCompilerOptions(),
    });
  }
});

test('preserves all JavaScript output targets', () => {
  expect(
    rslibConfig.lib.map(config => ({
      id: config.id,
      format: config.format,
      distPath: config.output?.distPath,
    })),
  ).toEqual([
    { id: 'esm-node', format: 'esm', distPath: { root: './dist/esm-node' } },
    { id: 'esm-web', format: 'esm', distPath: { root: './dist/esm' } },
    { id: 'cjs-node', format: 'cjs', distPath: { root: './dist/cjs' } },
  ]);
});
