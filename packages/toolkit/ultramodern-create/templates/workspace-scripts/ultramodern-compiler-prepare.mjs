#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceRoot = resolve(
  process.env.ULTRAMODERN_WORKSPACE_ROOT ?? process.cwd(),
);
const require = createRequire(join(workspaceRoot, 'package.json'));
const tsrsManifestPath = require.resolve('tsrs/package.json');
const tsrs = JSON.parse(readFileSync(tsrsManifestPath, 'utf8'));
if (
  tsrs.name !== 'tsrs' ||
  typeof tsrs.version !== 'string' ||
  !tsrs.optionalDependencies ||
  typeof tsrs.optionalDependencies !== 'object' ||
  Array.isArray(tsrs.optionalDependencies) ||
  Object.keys(tsrs.optionalDependencies).length === 0
) {
  throw new Error(`Invalid tsrs platform metadata: ${tsrsManifestPath}`);
}
// Let the installed tsrs release choose its host/libc identity. An omitted
// platform is unsupported. Missing artifacts for a supported host must fail
// through the official proxy, never trigger an unpatched compiler fallback.
const { getPlatformPackageName } = await import(
  pathToFileURL(join(dirname(tsrsManifestPath), 'lib/platform.js')).href
);
const platformPackage = getPlatformPackageName();
if (
  typeof platformPackage !== 'string' ||
  !platformPackage.startsWith('@tsrs/')
) {
  throw new Error(`Invalid tsrs platform identity: ${platformPackage}`);
}
const declaresTsrs = Object.hasOwn(tsrs.optionalDependencies, platformPackage);
if (
  declaresTsrs &&
  tsrs.optionalDependencies[platformPackage] !== tsrs.version
) {
  throw new Error(
    `tsrs platform dependency does not match ${tsrs.version}: ${platformPackage}`,
  );
}

const effectManifestPath = require.resolve('@effect/tsgo/package.json');
const effect = JSON.parse(readFileSync(effectManifestPath, 'utf8'));
const effectBin =
  typeof effect.bin === 'string' ? effect.bin : effect.bin?.['effect-tsgo'];
if (effect.name !== '@effect/tsgo' || typeof effectBin !== 'string') {
  throw new Error(`Invalid Effect compiler CLI metadata: ${effectManifestPath}`);
}
// @effect/tsgo@0.59.0 exports no tsrs capability API. Its CLI's
// tsrsReplacementTargets / resolveTsrs contract is narrower than tsrs itself.
const effectTsrsTargets = new Set([
  '@tsrs/darwin-arm64',
  '@tsrs/linux-x64-gnu',
  '@tsrs/linux-arm64-gnu',
]);
if (effect.version !== '0.59.0') {
  throw new Error(`Unreviewed Effect tsrs capability contract: ${effect.version}`);
}
const supportsTsrs = declaresTsrs && effectTsrsTargets.has(platformPackage);
console.info(
  supportsTsrs
    ? `[ultramodern] Validating Effect-enabled tsrs ${tsrs.version} for ${platformPackage}.`
    : `[ultramodern] ${declaresTsrs ? `@effect/tsgo@${effect.version} does not provide a tsrs replacement for ${platformPackage}` : `tsrs ${tsrs.version} does not publish ${platformPackage}`}; using Effect-Go.`,
);
const result = spawnSync(
  process.execPath,
  [
    resolve(dirname(effectManifestPath), effectBin),
    supportsTsrs ? 'tsrs' : 'tsc',
    '--version',
  ],
  {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(
  result.status ??
    (result.signal ? 128 + osConstants.signals[result.signal] : 1),
);
