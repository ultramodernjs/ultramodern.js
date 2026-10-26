#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('tsrs/package.json'));
const { default: getExePath } = await import(
  pathToFileURL(join(packageRoot, 'lib/getExePath.js')).href
);
const compiler = getExePath();
const version = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
if (
  version.error ||
  version.status !== 0 ||
  !version.stdout.includes('+effect-tsgo.0.57.0')
) {
  console.error(
    'Effect-enabled tsrs is required. Run pnpm exec effect-tsgo patch --no-typescript --tsrs.',
  );
  process.exit(1);
}
const args = process.argv.slice(2);
let command = args[0]?.startsWith('--') ? compiler : args.shift();
if (!command) {
  console.error('Usage: node scripts/with-effect-tsrs.mjs <command> [args...]');
  process.exit(1);
}
// Reuse the calling pnpm and Node instead of resolving a different proto shim.
if (command === 'pnpm' && process.env.npm_execpath) {
  const packageManager = process.env.npm_execpath;
  if (/\.[cm]?js$/.test(packageManager)) {
    command = process.execPath;
    args.unshift(packageManager);
  } else {
    command = packageManager;
  }
}
const result = spawnSync(command, args, {
  env: {
    ...process.env,
    EFFECT_TSGO_BIN: compiler,
    TSRS_CHECKER_ASSIGNMENT: 'locality',
    ULTRAMODERN_DTS_COMPILER_MODULE: join(
      dirname(fileURLToPath(import.meta.url)),
      'tsrs-dts/version.cjs',
    ),
  },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
