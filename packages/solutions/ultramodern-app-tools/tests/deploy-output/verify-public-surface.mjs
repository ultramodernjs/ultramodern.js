import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './verify-selected-builder.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDirectory, '../../../app-tools');
const deploymentTemplates = [
  'netlify-entry.cjs',
  'netlify-entry.mjs',
  'node-entry.cjs',
  'node-entry.mjs',
  'vercel-entry.cjs',
  'vercel-entry.mjs',
];

for (const format of ['cjs', 'esm-node']) {
  assert.deepEqual(
    readdirSync(
      join(packageRoot, 'dist', format, 'plugins/deploy/platforms/templates'),
    ).sort(),
    deploymentTemplates,
  );
}

console.log('Verified app-tools built deployment templates.');
