import { expect, it } from '@rstest/core';
import path from 'path';

const workspace = path.resolve(__dirname, '../../..');
const loader = '@rsbuild/core/compiled/css-loader/index.js';

it('collapses workspace pnpm paths without adding a workspace prefix', () => {
  expect(
    path.join(
      workspace,
      'node_modules/.pnpm/@rsbuild+core@2.3.2/node_modules',
      loader,
    ),
  ).toMatchInlineSnapshot(
    `"<PNPM_INNER>/@rsbuild/core/compiled/css-loader/index.js"`,
  );
});

it('collapses global pnpm store paths to the same dependency token', () => {
  expect(
    `/external/pnpm/store/v11/links/@rsbuild/core/2.3.2/hash/node_modules/${loader}`,
  ).toMatchInlineSnapshot(
    `"<PNPM_INNER>/@rsbuild/core/compiled/css-loader/index.js"`,
  );
});

it('preserves workspace paths outside the pnpm store', () => {
  expect(
    path.join(workspace, 'packages/cli/builder/src/index.ts'),
  ).toMatchInlineSnapshot(`"<WORKSPACE>/packages/cli/builder/src/index.ts"`);
});

it('still normalizes generated tsgo config hashes', () => {
  expect(
    path.join(workspace, '.modern-js/tsgo/tsconfig.123456789a.json'),
  ).toMatchInlineSnapshot(`"<WORKSPACE>/.modern-js/tsgo/tsconfig.<hash>.json"`);
});
