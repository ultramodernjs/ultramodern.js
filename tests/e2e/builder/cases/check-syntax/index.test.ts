import { expect, test } from '@playwright/test';
import type { RsbuildConfig } from '@rsbuild/core';
import { build, proxyConsole } from '@scripts/shared';
import path from 'path';

function getCommonBuildConfig(cwd: string): RsbuildConfig {
  return {
    source: {
      exclude: [path.resolve(cwd, './src/test.js')],
    },
  };
}

test('should throw error when exist syntax errors', async () => {
  const { restore } = proxyConsole();
  const cwd = path.join(__dirname, 'fixtures/basic');
  await expect(
    build({
      cwd,
      entry: { index: path.resolve(cwd, './src/index.js') },
      builderConfig: {
        ...getCommonBuildConfig(cwd),
        security: {
          checkSyntax: true,
        },
        output: {
          overrideBrowserslist: ['chrome 40'],
          minify: false,
        },
      },
    }),
  ).rejects.toThrowError('incompatible syntax');
  restore();
});

test('should not throw error when the file is excluded', async () => {
  const cwd = path.join(__dirname, 'fixtures/basic');
  await expect(
    build({
      cwd,
      entry: { index: path.resolve(cwd, './src/index.js') },
      builderConfig: {
        ...getCommonBuildConfig(cwd),
        security: {
          checkSyntax: {
            exclude: /src\/test/,
          },
        },
      },
    }),
  ).resolves.toBeTruthy();
});

test('should not throw error when the targets are support es6', async () => {
  const cwd = path.join(__dirname, 'fixtures/basic');
  const targets = ['chrome >= 60', 'edge >= 15'];

  await expect(
    build({
      cwd,
      entry: { index: path.resolve(cwd, './src/index.js') },
      builderConfig: {
        ...getCommonBuildConfig(cwd),
        security: {
          checkSyntax: {
            targets,
          },
        },
        output: {
          overrideBrowserslist: targets,
        },
      },
    }),
  ).resolves.toBeTruthy();
});

test('should throw error when using optional chaining and target is es6 browsers', async () => {
  const { restore } = proxyConsole();
  const cwd = path.join(__dirname, 'fixtures/esnext');

  await expect(
    build({
      cwd,
      entry: { index: path.resolve(cwd, './src/index.js') },
      builderConfig: {
        ...getCommonBuildConfig(cwd),
        security: {
          checkSyntax: {
            targets: ['chrome >= 53'],
          },
        },
        output: {
          // Preserve optional chaining without emitting newer runtime syntax.
          overrideBrowserslist: ['chrome 80'],
        },
      },
    }),
  ).rejects.toThrowError('incompatible syntax');

  restore();
});

test('should not throw error when using optional chaining and ecmaVersion is 2020', async () => {
  const cwd = path.join(__dirname, 'fixtures/esnext');

  await expect(
    build({
      cwd,
      entry: { index: path.resolve(cwd, './src/index.js') },
      builderConfig: {
        ...getCommonBuildConfig(cwd),
        security: {
          checkSyntax: {
            ecmaVersion: 2020,
          },
        },
        output: {
          overrideBrowserslist: ['chrome 80'],
        },
      },
    }),
  ).resolves.toBeTruthy();
});
