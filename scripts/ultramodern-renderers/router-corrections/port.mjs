import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upstream } from './reconstruct.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reference =
  process.env.ROUTER_REFERENCE_REPOSITORY ??
  '/Users/satan/workspace/bleedingdev/projects/tanstack-router/code/router';
const source = execFileSync('git', [
  '-C',
  reference,
  'diff',
  upstream.commit,
  upstream.accepted,
  '--',
  'packages/router-core/src',
  'packages/router-core/vite.config.ts',
]);
const destination = path.join(here, 'source.patch');
if (process.argv.includes('--write')) fs.writeFileSync(destination, source);
else
  assert.deepEqual(
    fs.readFileSync(destination),
    source,
    'Source port no longer matches pinned fork behavior',
  );
for (const file of fs.readdirSync(path.join(here, 'tests'))) {
  if (file === 'dehydration-hook-loads.test.ts') continue; // Core port of Start hook tests.
  const bytes = execFileSync(
    'git',
    [
      '-C',
      reference,
      'show',
      `${upstream.accepted}:packages/router-core/tests/${file}`,
    ],
    { maxBuffer: 4 * 1024 ** 2 },
  );
  if (process.argv.includes('--write'))
    fs.writeFileSync(path.join(here, 'tests', file), bytes);
  else
    assert.deepEqual(
      fs.readFileSync(path.join(here, 'tests', file)),
      bytes,
      `Fork test changed: ${file}`,
    );
}
console.log(
  'SOURCE_PORT_PASS pinned fork corrections and focused regression fixtures',
);
