import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reconcile } from './reconcile-manifests.mjs';

test('reconciliation does not restore the retired Rslib 1.0.3 hold across fifty compiler consumers', {
  skip: process.platform === 'win32',
}, () => {
  assert.ok(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir --run');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'rslib-rule-'),
  );
  try {
    const manifests = Array.from(
      { length: 50 },
      (_, index) => `packages/p${index}/package.json`,
    );
    for (const [index, file] of manifests.entries()) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(
        path.join(root, file),
        JSON.stringify({
          name: `@fixture/p${index}`,
          devDependencies: {
            '@rslib/core': '1.0.3',
            '@module-federation/enhanced': 'npm:@bleedingdev/mf-enhanced@2.9.5',
            '@module-federation/modern-js-v3':
              'npm:@bleedingdev/mf-modern-js-v3@2.9.6',
            '@swc/core': '1.16.22',
            '@types/node': '^26.6.6',
          },
        }),
      );
      fs.writeFileSync(
        path.join(root, path.dirname(file), 'rslib.config.mts'),
        '',
      );
    }
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!${process.execPath}\nif (process.argv[2] === 'ls-files') process.stdout.write(${JSON.stringify(manifests.join('\0') + '\0')});\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./reconcile-manifests.mjs', import.meta.url)),
        'base',
        'fork',
        'upstream',
        '--write',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const file of manifests) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, file)));
      assert.equal(manifest.devDependencies['@rslib/core'], '1.0.7', file);
      assert.equal(
        manifest.devDependencies['@module-federation/enhanced'],
        'npm:@bleedingdev/mf-enhanced@2.9.5',
        file,
      );
      assert.equal(
        manifest.devDependencies['@module-federation/modern-js-v3'],
        'npm:@bleedingdev/mf-modern-js-v3@2.9.6',
        file,
      );
      assert.equal(manifest.devDependencies['@swc/core'], '1.16.22', file);
      assert.equal(manifest.devDependencies['@types/node'], '^26.6.6', file);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
