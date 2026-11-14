import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcile } from './reconcile-manifests.mjs';

test('adopts upstream fixes without downgrading accepted fork dependencies', () => {
  const result = reconcile(
    {
      version: '3.9.2',
      dependencies: { build: '2.2.0', parser: '^7.0.0', helper: '^1.0.0' },
    },
    {
      version: '3.9.3',
      dependencies: { build: '2.2.13', parser: '^8.0.7', helper: '^1.5.0' },
    },
    {
      version: '3.11.3',
      dependencies: { build: '2.3.2', parser: '^7.29.12', helper: '^1.1.0' },
    },
  );
  assert.deepEqual(result, {
    version: '3.11.3',
    dependencies: { build: '2.3.2', parser: '^8.0.7', helper: '^1.5.0' },
  });
});

test('retains compiled exports, native declaration pipeline and strict peer contract', () => {
  const fork = {
    scripts: { build: 'rslib build' },
    exports: { '.': './dist/esm/index.mjs' },
    peerDependencies: { react: '^19.3.1' },
  };
  const result = reconcile(
    {
      scripts: { build: 'old' },
      exports: {},
      peerDependencies: { react: '>=18.3.1' },
    },
    fork,
    {
      scripts: { build: 'rs lib' },
      exports: { '.': './src/index.ts' },
      peerDependencies: { react: '>=18.3.1' },
    },
  );
  assert.deepEqual(result, fork);
});

test('takes genuinely new upstream functionality and removes unchanged legacy fields', () => {
  assert.deepEqual(
    reconcile(
      { dependencies: { obsolete: '1.0.0' } },
      { dependencies: { obsolete: '1.0.0', forkExtension: 'workspace:*' } },
      { dependencies: { mcp: '^2.0.4' } },
    ),
    { dependencies: { forkExtension: 'workspace:*', mcp: '^2.0.4' } },
  );
});
