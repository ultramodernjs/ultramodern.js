#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import compilerProvider from './tsrs-dts/compiler.cjs';

const { getExePath, getCompilerPolicy, effectVersion, tsrsVersion } =
  compilerProvider;
const policy = getCompilerPolicy();
const compiler = getExePath();
const version = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
const effectStamp = /^Version \S+\+effect-tsgo\.([\d.]+)(?:\s|$)/u.exec(
  version.stdout?.trim() ?? '',
);
const tsrsStamp =
  /\(tsrs ([^,]+), microsoft\/TypeScript@([a-f\d]+)\)\s*$/u.exec(
    version.stdout ?? '',
  );
if (
  version.error ||
  version.status !== 0 ||
  effectStamp?.[1] !== effectVersion ||
  (policy.backend === 'tsrs' &&
    (!tsrsStamp ||
      tsrsStamp[1] !== tsrsVersion ||
      tsrsStamp[2].length < 12 ||
      !compilerProvider.typescriptCommit.startsWith(tsrsStamp[2])))
) {
  console.error(
    `Effect-enabled compiler ${effectVersion} is required. Check the installed @effect/tsgo and tsrs versions.`,
  );
  process.exit(1);
}
if (policy.backend === 'effect-go') {
  console.error(
    `The Effect tsrs replacement is unavailable for ${policy.nativePackage}; using the Effect-Go compiler.`,
  );
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
    TSRS_CHECKER_ASSIGNMENT: process.env.TSRS_CHECKER_ASSIGNMENT || 'locality',
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
