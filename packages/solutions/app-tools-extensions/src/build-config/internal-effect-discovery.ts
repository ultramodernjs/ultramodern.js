import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, type URL } from 'node:url';

const EFFECT_TSGO_PACKAGE = '@effect/tsgo';
const EFFECT_TSGO_BIN = 'effect-tsgo';
const NATIVE_TYPESCRIPT_PACKAGES = ['typescript', '@typescript/native'];
// @effect/tsgo@0.59.0 exports no tsrs capability API. Keep this exact contract
// aligned with its CLI's tsrsReplacementTargets / resolveTsrs, not tsrs's list.
const EFFECT_TSRS_PROVIDER_VERSION = '0.59.0';
const EFFECT_TSRS_TARGETS = new Set([
  '@tsrs/darwin-arm64',
  '@tsrs/linux-x64-gnu',
  '@tsrs/linux-arm64-gnu',
]);
type PackageJson = {
  name?: string;
  bin?: Record<string, string> | string;
  version?: string;
  gitHead?: string;
  tsrs?: { typescriptVersion?: string; typescriptCommit?: string };
  optionalDependencies?: Record<string, string>;
};
type TsrsPackageJson = PackageJson & {
  version: string;
  tsrs: { typescriptVersion: string; typescriptCommit: string };
};
const failureStages = new WeakMap<object, string>();
const reportedUnsupportedTsrsTargets = new Set<string>();
export function effectCompilerDiscoveryFailureStage(
  error: unknown,
): string | undefined {
  return error && typeof error === 'object'
    ? failureStages.get(error)
    : undefined;
}

function resolveEffectTsgoPackage(from: string | URL): {
  packageJsonPath: string;
  packageJson: PackageJson;
  cliPath: string;
} {
  const projectRequire = createRequire(from);
  const packageJsonPath = projectRequire.resolve(
    `${EFFECT_TSGO_PACKAGE}/package.json`,
  );
  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, 'utf-8'),
  ) as PackageJson;
  const bin =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[EFFECT_TSGO_BIN];

  if (!bin) {
    throw new Error(
      `Resolved ${EFFECT_TSGO_PACKAGE} package has no ${EFFECT_TSGO_BIN} bin: ${packageJsonPath}`,
    );
  }

  const cliPath = realpathSync(resolve(dirname(packageJsonPath), bin));
  if (!lstatSync(cliPath).isFile())
    throw new Error(`Effect TS-Go CLI is not a regular file: ${cliPath}`);
  return { packageJsonPath, packageJson, cliPath };
}

function isAbsentPackage(
  projectRequire: NodeJS.Require,
  from: string | URL,
  packageName: string,
  error: unknown,
): boolean {
  const filename =
    typeof from === 'string' && !from.startsWith('file:')
      ? from
      : fileURLToPath(from);
  if (
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== 'MODULE_NOT_FOUND' ||
    ('path' in error && error.path !== undefined) ||
    error.message.split('\n')[0] !==
      `Cannot find module '${packageName}/package.json'` ||
    !('requireStack' in error) ||
    !Array.isArray(error.requireStack) ||
    error.requireStack[0] !== filename
  ) {
    return false;
  }
  for (const searchDirectory of projectRequire.resolve.paths(packageName) ??
    []) {
    try {
      lstatSync(join(searchDirectory, packageName));
      return false;
    } catch (presenceError) {
      if (
        !(presenceError instanceof Error) ||
        !('code' in presenceError) ||
        !['ENOENT', 'ENOTDIR'].includes(String(presenceError.code))
      ) {
        throw presenceError;
      }
    }
  }
  return true;
}

function resolveNativeTypeScriptPackage(from: string | URL): string {
  const projectRequire = createRequire(from);
  for (const packageName of NATIVE_TYPESCRIPT_PACKAGES) {
    let packageJsonPath: string;
    try {
      packageJsonPath = projectRequire.resolve(`${packageName}/package.json`);
    } catch (error) {
      if (isAbsentPackage(projectRequire, from, packageName, error)) {
        continue;
      }
      throw error;
    }
    const packageJson = JSON.parse(
      readFileSync(packageJsonPath, 'utf-8'),
    ) as PackageJson;
    const major = packageJson.version?.match(
      /^(\d+)\.\d+\.\d+(?:[-+].*)?$/u,
    )?.[1];
    if (!major) {
      throw new Error(
        `Resolved TypeScript package has no valid version: ${packageJsonPath}`,
      );
    }
    if (Number(major) >= 7) {
      return packageJsonPath;
    }
  }
  throw new Error(
    `No native TypeScript backend is installed for ${String(from)}. Install typescript >=7 or @typescript/native.`,
  );
}

function resolveNativeTypeScriptManifest(from: string | URL): string {
  const packageJsonPath = resolveNativeTypeScriptPackage(from);
  const directory = dirname(packageJsonPath);
  // Keep the selected backend bound to its own installation, including the
  // canonical-package precedence used by the provider.
  const discoveryPackage = resolveNativeTypeScriptPackage(
    join(directory, '__ultramodern_effect_backend__.cjs'),
  );
  if (realpathSync(discoveryPackage) !== realpathSync(packageJsonPath)) {
    throw new Error(
      `Effect discovery would select a different native TypeScript installation from ${directory}: ${discoveryPackage}`,
    );
  }
  return packageJsonPath;
}

function readCompilerArtifact(filename: string): string {
  const canonicalPath = realpathSync(filename);
  const stats = lstatSync(canonicalPath);
  if (!stats.isFile())
    throw new Error(`Compiler artifact is not a regular file: ${filename}`);
  if (stats.size === 0)
    throw new Error(`Compiler artifact is empty: ${filename}`);
  return canonicalPath;
}

function resolveTsrsManifest(from: string | URL): string | undefined {
  const projectRequire = createRequire(from);
  try {
    return projectRequire.resolve('tsrs/package.json');
  } catch (error) {
    if (isAbsentPackage(projectRequire, from, 'tsrs', error)) return undefined;
    throw error;
  }
}

function compilerVersion(compiler: string): string {
  return execFileSync(compiler, ['--version'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TSRS_CHECKER_ASSIGNMENT: process.env.TSRS_CHECKER_ASSIGNMENT || 'go',
    },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function tsrsPlatform(manifestPath: string): {
  manifest: TsrsPackageJson;
  nativeName: string;
  supported: boolean;
} {
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as PackageJson;
  const { getPlatformPackageName } = createRequire(manifestPath)(
    join(dirname(manifestPath), 'lib/platform.js'),
  ) as { getPlatformPackageName: () => string };
  const nativeName = getPlatformPackageName();
  const embedded = manifest.tsrs;
  if (
    typeof nativeName !== 'string' ||
    !nativeName ||
    !manifest.optionalDependencies ||
    typeof manifest.optionalDependencies !== 'object' ||
    Array.isArray(manifest.optionalDependencies) ||
    Object.keys(manifest.optionalDependencies).length === 0
  ) {
    throw new Error(`Invalid native tsrs capability metadata: ${manifestPath}`);
  }
  if (
    typeof manifest.name !== 'string' ||
    !manifest.name ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+-ts[\w.-]+$/u.test(manifest.version) ||
    typeof embedded?.typescriptVersion !== 'string' ||
    !/^7\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(embedded.typescriptVersion) ||
    !manifest.version.endsWith(`-ts${embedded.typescriptVersion}`) ||
    typeof embedded.typescriptCommit !== 'string' ||
    !/^[a-f\d]{40}$/u.test(embedded.typescriptCommit)
  ) {
    throw new Error(`Invalid native tsrs metadata: ${manifestPath}`);
  }
  const supported = Object.hasOwn(manifest.optionalDependencies, nativeName);
  if (
    supported &&
    manifest.optionalDependencies[nativeName] !== manifest.version
  ) {
    throw new Error(
      `Native tsrs target version does not match its selected package: ${manifestPath}`,
    );
  }
  return { manifest: manifest as TsrsPackageJson, nativeName, supported };
}

function resolveTsrsCompiler(
  manifestPath: string,
  effect: ReturnType<typeof resolveEffectTsgoPackage>,
  configuredCompiler?: string,
  configuredVersion?: string,
): string {
  const { manifest } = tsrsPlatform(manifestPath);
  const embedded = manifest.tsrs;
  const effectName = `@effect/tsgo-${process.platform}-${process.arch}`;
  const effectManifest = createRequire(effect.cliPath).resolve(
    `${effectName}/package.json`,
  );
  const platform = JSON.parse(
    readFileSync(effectManifest, 'utf8'),
  ) as PackageJson;
  const metadataPath = join(dirname(effectManifest), 'lib/upstream.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    schemaVersion?: number;
    components?: {
      tsrs?: Record<
        string,
        {
          gitHead?: string;
          typescript?: { version?: string; gitHead?: string };
        }
      >;
    };
  };
  const component = metadata.components?.tsrs?.[manifest.version];
  if (
    platform.name !== effectName ||
    platform.version !== effect.packageJson.version ||
    metadata.schemaVersion !== 5 ||
    !/^[a-f\d]{40}$/u.test(component?.gitHead ?? '') ||
    component?.typescript?.version !== embedded.typescriptVersion ||
    component.typescript.gitHead !== embedded.typescriptCommit
  ) {
    throw new Error(
      `Effect replacement metadata does not match tsrs: ${metadataPath}`,
    );
  }
  // This is the same metadata-bound artifact used by `effect-tsgo tsrs`.
  // The installed @tsrs binary need not be patched or written to.
  const compiler = readCompilerArtifact(
    configuredCompiler ??
      join(
        dirname(effectManifest),
        'artifacts/tsrs',
        manifest.version,
        process.platform === 'win32' ? 'tsrs.exe' : 'tsrs',
      ),
  );
  const version = configuredVersion ?? compilerVersion(compiler);
  // Check the selected executable itself, including TSRS_BINARY and explicit
  // EFFECT_TSGO_BIN paths. A package name alone cannot prove it was patched.
  const stamp =
    /\+effect-tsgo\.([\d.]+)\s+\(tsrs ([^,]+), microsoft\/TypeScript@([a-f\d]+)\)$/u.exec(
      version,
    );
  if (
    !stamp ||
    stamp[1] !== effect.packageJson.version ||
    stamp[2] !== manifest.version ||
    stamp[3].length < 12 ||
    !embedded.typescriptCommit.startsWith(stamp[3])
  ) {
    throw new Error(
      `Effect-enabled tsrs matching ${manifest.version} and @effect/tsgo@${effect.packageJson.version} is required: ${compiler}. Install matching packages or select a matching Effect-enabled candidate with EFFECT_TSGO_BIN.`,
    );
  }
  return compiler;
}

/** Explicit native binaries must still report Effect diagnostics support. */
export function validateConfiguredEffectCompiler(
  compiler: string,
  from: string | URL,
): void {
  const version = compilerVersion(compiler);
  if (
    !/^Version \d+\.\d+\.\d+[\w.-]*\+effect-tsgo\.\d+\.\d+\.\d+(?:\s|$)/u.test(
      version,
    )
  ) {
    throw new Error(
      `EFFECT_TSGO_BIN must select an Effect-enabled native compiler: ${compiler}`,
    );
  }
  if (version.includes('(tsrs ')) {
    const manifest = resolveTsrsManifest(from);
    if (!manifest)
      throw new Error(
        `Cannot validate tsrs without its installed package metadata for ${String(from)}`,
      );
    resolveTsrsCompiler(
      manifest,
      resolveEffectTsgoPackage(from),
      compiler,
      version,
    );
  }
}

/** Selects the exact native replacement without invoking the provider CLI. */
export function resolveInstalledEffectCompiler(from: string | URL): string {
  let stage = 'Package CLI resolution';
  try {
    const effect = resolveEffectTsgoPackage(from);
    stage = 'Native tsrs package resolution';
    const tsrsManifest = resolveTsrsManifest(from);
    const tsrsTarget = tsrsManifest ? tsrsPlatform(tsrsManifest) : undefined;
    if (
      tsrsTarget &&
      effect.packageJson.version !== EFFECT_TSRS_PROVIDER_VERSION
    ) {
      throw new Error(
        `Unreviewed Effect tsrs capability contract: ${effect.packageJson.version}`,
      );
    }
    const configuredTsrsCompiler = process.env.TSRS_BINARY || undefined;
    if (
      tsrsManifest &&
      tsrsTarget?.supported &&
      (configuredTsrsCompiler || EFFECT_TSRS_TARGETS.has(tsrsTarget.nativeName))
    ) {
      stage = 'Native tsrs validation';
      // TSRS_BINARY remains an explicit candidate selection. Automatic
      // discovery uses the Effect provider's bundled native replacement.
      return resolveTsrsCompiler(tsrsManifest, effect, configuredTsrsCompiler);
    }
    if (
      tsrsTarget &&
      !reportedUnsupportedTsrsTargets.has(tsrsTarget.nativeName)
    ) {
      reportedUnsupportedTsrsTargets.add(tsrsTarget.nativeName);
      console.warn(
        `[UltraModern] ${tsrsTarget.supported ? `@effect/tsgo@${effect.packageJson.version} does not provide a tsrs replacement for ${tsrsTarget.nativeName}` : `tsrs does not declare ${tsrsTarget.nativeName}`}; selecting the Effect-enabled TypeScript-Go compiler.`,
      );
    }
    stage = 'Native TypeScript package resolution';
    const typeScriptManifest = resolveNativeTypeScriptManifest(from);
    const typeScript = JSON.parse(
      readFileSync(typeScriptManifest, 'utf8'),
    ) as PackageJson;
    const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
    const nativeManifest = createRequire(typeScriptManifest).resolve(
      `${nativeName}/package.json`,
    );
    const native = JSON.parse(
      readFileSync(nativeManifest, 'utf8'),
    ) as PackageJson;
    if (
      native.name !== nativeName ||
      native.version !== typeScript.version ||
      typeof native.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(native.version) ||
      typeof native.gitHead !== 'string' ||
      !/^[a-f\d]{40}$/u.test(native.gitHead) ||
      native.gitHead !== typeScript.gitHead
    ) {
      throw new Error(
        `Native TypeScript platform does not match its selected package: ${nativeManifest}`,
      );
    }
    const binaryName = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
    readCompilerArtifact(join(dirname(nativeManifest), 'lib', binaryName));
    stage = 'Compiler backend lookup';
    const effectName = `@effect/tsgo-${process.platform}-${process.arch}`;
    const effectManifest = createRequire(effect.cliPath).resolve(
      `${effectName}/package.json`,
    );
    const platform = JSON.parse(
      readFileSync(effectManifest, 'utf8'),
    ) as PackageJson;
    if (
      platform.name !== effectName ||
      typeof effect.packageJson.version !== 'string' ||
      platform.version !== effect.packageJson.version
    ) {
      throw new Error(
        `Effect platform does not match its selected provider: ${effectManifest}`,
      );
    }
    const metadataPath = join(dirname(effectManifest), 'lib', 'upstream.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      schemaVersion?: number;
      tags?: { typescript?: { latest?: string } };
      components?: {
        typescript?: Record<string, { gitHead?: string; provider?: string }>;
      };
    };
    const component = metadata.components?.typescript?.[native.version];
    const latestTypeScript = metadata.tags?.typescript?.latest;
    if (
      metadata.schemaVersion !== 5 ||
      typeof latestTypeScript !== 'string' ||
      component?.provider !== 'typescript-go' ||
      component.gitHead !== native.gitHead
    ) {
      throw new Error(
        `Effect replacement metadata does not match the selected native TypeScript backend: ${metadataPath}`,
      );
    }
    // Same layout rule as @effect/tsgo's getExePath: the latest TypeScript
    // replacement ships in lib/, every other version under artifacts/.
    const compilerDirectory =
      native.version === latestTypeScript
        ? join(dirname(effectManifest), 'lib')
        : join(
            dirname(effectManifest),
            'artifacts',
            'typescript',
            native.version,
          );
    return readCompilerArtifact(join(compilerDirectory, binaryName));
  } catch (error) {
    if (error && typeof error === 'object' && !failureStages.has(error))
      failureStages.set(error, stage);
    throw error;
  }
}
