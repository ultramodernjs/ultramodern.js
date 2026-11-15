#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (!process.env.OWNED_TEMP_DIR || !existsSync(process.env.OWNED_TEMP_DIR))
  throw new Error(
    'Compiler contract fixtures require an existing OWNED_TEMP_DIR',
  );

const result = spawnSync(
  process.execPath,
  [
    '--test',
    'packages/solutions/app-tools-extensions/tests/compiler-payload/resolve.test.cjs',
    'scripts/ultramodern-publish/__tests__/stage-effect-compiler-payload.test.mjs',
    'scripts/__tests__/effect-tsrs-provider.test.mjs',
    'packages/solutions/app-tools-extensions/tests/build-config/owned-effect-discovery.test.mjs',
  ],
  {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: 'inherit',
    env: process.env,
  },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.error || result.signal ? 1 : (result.status ?? 1);
