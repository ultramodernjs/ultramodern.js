const { readFileSync, statSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');

const tsrsManifestPath = require.resolve('tsrs/package.json');
const tsrs = JSON.parse(readFileSync(tsrsManifestPath, 'utf8'));
const effectManifestPath = require.resolve('@effect/tsgo/package.json');
const effect = JSON.parse(readFileSync(effectManifestPath, 'utf8'));
if (
  tsrs.name !== 'tsrs' ||
  typeof tsrs.version !== 'string' ||
  typeof tsrs.tsrs?.typescriptVersion !== 'string' ||
  !/^7\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tsrs.tsrs.typescriptVersion) ||
  !tsrs.version.endsWith(`-ts${tsrs.tsrs.typescriptVersion}`) ||
  !/^[a-f\d]{40}$/.test(tsrs.tsrs?.typescriptCommit ?? '') ||
  !tsrs.optionalDependencies ||
  typeof tsrs.optionalDependencies !== 'object' ||
  Array.isArray(tsrs.optionalDependencies) ||
  Object.keys(tsrs.optionalDependencies).length === 0
) {
  throw new Error(`Invalid tsrs platform metadata: ${tsrsManifestPath}`);
}
if (effect.name !== '@effect/tsgo' || typeof effect.version !== 'string') {
  throw new Error(`Invalid Effect compiler metadata: ${effectManifestPath}`);
}
// @effect/tsgo@0.59.0 exports no tsrs capability API. These are its CLI's
// tsrsReplacementTargets / resolveTsrs targets, not all upstream tsrs targets.
const effectTsrsTargets = new Set([
  '@tsrs/darwin-arm64',
  '@tsrs/linux-x64-gnu',
  '@tsrs/linux-arm64-gnu',
]);
const reportedUnsupportedTargets = new Set();

function getCompilerPolicy(platform = process.platform, arch = process.arch) {
  if (effect.version !== '0.59.0') {
    throw new Error(
      `Unreviewed Effect tsrs capability contract: ${effect.version}`,
    );
  }
  const { getPlatformPackageName } = require(
    join(dirname(tsrsManifestPath), 'lib/platform.js'),
  );
  const nativePackage = getPlatformPackageName(platform, arch);
  if (
    typeof nativePackage !== 'string' ||
    !nativePackage.startsWith('@tsrs/')
  ) {
    throw new Error(`Invalid tsrs platform identity: ${nativePackage}`);
  }
  const version = tsrs.optionalDependencies?.[nativePackage];
  if (version === undefined) {
    return { backend: 'effect-go', nativePackage };
  }
  if (version !== tsrs.version) {
    throw new Error(
      `Native tsrs dependency does not match ${tsrs.version}: ${nativePackage}`,
    );
  }
  if (!effectTsrsTargets.has(nativePackage)) {
    return { backend: 'effect-go', nativePackage };
  }
  return { backend: 'tsrs', nativePackage };
}

function getExePath() {
  if (process.env.EFFECT_TSGO_BIN) return process.env.EFFECT_TSGO_BIN;
  const policy = getCompilerPolicy();
  if (policy.backend === 'effect-go') {
    if (!reportedUnsupportedTargets.has(policy.nativePackage)) {
      reportedUnsupportedTargets.add(policy.nativePackage);
      console.warn(
        `[ultramodern] No declared tsrs replacement for ${policy.nativePackage} in @effect/tsgo@${effect.version}; using Effect-Go.`,
      );
    }
    return require('@effect/tsgo/lib/getExePath').default();
  }
  const effectRequire = createRequire(effectManifestPath);
  const nativeManifestPath = effectRequire.resolve(
    `@effect/tsgo-${process.platform}-${process.arch}/package.json`,
  );
  const nativeRoot = dirname(nativeManifestPath);
  const native = JSON.parse(readFileSync(nativeManifestPath, 'utf8'));
  const upstream = JSON.parse(
    readFileSync(join(nativeRoot, 'lib/upstream.json'), 'utf8'),
  );
  const component = upstream.components?.tsrs?.[tsrs.version];
  if (
    native.name !== `@effect/tsgo-${process.platform}-${process.arch}` ||
    native.version !== effect.version ||
    upstream.schemaVersion !== 5 ||
    !/^[a-f\d]{40}$/.test(component?.gitHead ?? '') ||
    component?.typescript?.version !== tsrs.tsrs?.typescriptVersion ||
    component?.typescript?.gitHead !== tsrs.tsrs?.typescriptCommit
  ) {
    throw new Error(
      `Effect ${effect.version} does not provide matching tsrs ${tsrs.version}.`,
    );
  }
  const executable = join(
    nativeRoot,
    'artifacts/tsrs',
    tsrs.version,
    process.platform === 'win32' ? 'tsrs.exe' : 'tsrs',
  );
  const file = statSync(executable);
  if (!file.isFile() || file.size === 0) {
    throw new Error(
      `Effect tsrs executable is not a nonempty file: ${executable}`,
    );
  }
  return executable;
}

module.exports = {
  getCompilerPolicy,
  getExePath,
  effectVersion: effect.version,
  tsrsVersion: tsrs.version,
  typescriptCommit: tsrs.tsrs.typescriptCommit,
  typescriptVersion:
    getCompilerPolicy().backend === 'tsrs'
      ? tsrs.tsrs.typescriptVersion
      : require('typescript/package.json').version,
};
