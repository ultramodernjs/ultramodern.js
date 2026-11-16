import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import inventory from '../../packages/toolkit/ultramodern-create/src/ultramodern-workspace/patch-inventory.ts';

const root = new URL('../../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root));
const recipes = JSON.parse(read('scripts/ultramodern-supply/sidecars.json'));
const workspace = parse(read('pnpm-workspace.yaml').toString());

test('published MF aliases retain their canonical corrections without unused upstream patch selectors', () => {
  for (const name of [
    'bridge-react',
    'dts-plugin',
    'enhanced',
    'manifest',
    'modern-js-v3',
    'node',
    'rspack',
    'runtime-core',
  ]) {
    const packageName = `@module-federation/${name}`;
    const patch = inventory.find(item => item.packageName === packageName);
    const recipe = recipes.find(item => item.upstream.name === packageName);
    assert.equal(patch.repository, false, packageName);
    assert.equal(
      Object.hasOwn(
        workspace.patchedDependencies,
        `${packageName}@${patch.version}`,
      ),
      false,
      packageName,
    );
    assert.equal(recipe.patch.inventory, `${packageName}@${patch.version}`);
    assert.equal(recipe.fork.name, `@bleedingdev/mf-${name}`);
    assert.equal(
      createHash('sha256').update(read(patch.path)).digest('hex'),
      patch.sha256,
      packageName,
    );
  }
  for (const name of [
    'rsbuild-plugin-dts',
    'braces',
    '@module-federation/sdk',
  ]) {
    const patch = inventory.find(item => item.packageName === name);
    assert.equal(patch.repository, true, name);
    assert.equal(
      workspace.patchedDependencies[`${name}@${patch.version}`],
      patch.path,
      name,
    );
  }
});
