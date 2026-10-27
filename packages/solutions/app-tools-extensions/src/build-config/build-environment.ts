import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL, type URL } from 'node:url';

// CJS and ESM consumers share the selected-cohort validator in one owning
// module, including packages whose public name changes during publication.
const owningModuleUrl =
  process.env.MODERN_LIB_FORMAT === 'esm'
    ? import.meta.url
    : pathToFileURL(__filename).href;
const owningManifest = findPackageJSON(owningModuleUrl, owningModuleUrl);
if (!owningManifest)
  throw new Error('Cannot find owning build-config package manifest');
const owningName: unknown = JSON.parse(
  readFileSync(owningManifest, 'utf8'),
).name;
if (typeof owningName !== 'string' || owningName.length === 0) {
  throw new Error(
    `Invalid owning build-config package name: ${owningManifest}`,
  );
}
const {
  effectCompilerDiscoveryFailureStage,
  resolveInstalledEffectCompiler,
  validateConfiguredEffectCompiler,
}: typeof import('./internal-effect-discovery') = createRequire(
  owningModuleUrl,
)(`${owningName}/internal-effect-discovery`);

const EFFECT_TSGO_RESOLUTION_ERROR =
  'Unable to resolve the Effect TS-Go compiler. Install "@effect/tsgo" and a native TypeScript backend for this build config, or set EFFECT_TSGO_BIN. Bundled tsrs requires matching installed tsrs metadata.';
const executableEffectTsgoCompilers = new Map<string, string>();

function effectTsgoResolutionError(
  cause: unknown,
  stage: string,
  from: string | URL,
): Error {
  const detail =
    cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return new Error(
    `${EFFECT_TSGO_RESOLUTION_ERROR}\n${stage} failed for ${String(from)}: ${detail}`,
    { cause },
  );
}

function resolveExecutableEffectTsgoCompiler(compilerPath: string): string {
  const sourcePath = realpathSync(compilerPath);
  const source = lstatSync(sourcePath);
  if (!source.isFile() || source.size === 0) {
    throw new Error(
      `Effect TS-Go compiler path is not a nonempty regular file: ${sourcePath}`,
    );
  }
  if (process.platform === 'win32') return compilerPath;

  try {
    accessSync(sourcePath, constants.X_OK);
    return compilerPath;
  } catch {
    // npm currently publishes Effect TS-Go's native Unix files without an
    // execute bit. Keep node_modules immutable and materialize a private copy.
  }

  const cachedCompiler = executableEffectTsgoCompilers.get(sourcePath);
  if (cachedCompiler) {
    try {
      accessSync(cachedCompiler, constants.X_OK);
      return cachedCompiler;
    } catch {
      executableEffectTsgoCompilers.delete(sourcePath);
    }
  }

  const compilerBytes = readFileSync(sourcePath);
  const compilerDigest = createHash('sha256')
    .update(compilerBytes)
    .digest('hex');
  const compilerDirectory = join(
    tmpdir(),
    'modern-js',
    'effect-tsgo',
    compilerDigest,
  );
  mkdirSync(compilerDirectory, { recursive: true, mode: 0o700 });
  const executableCompiler = join(compilerDirectory, basename(sourcePath));
  try {
    accessSync(executableCompiler, constants.X_OK);
  } catch {
    const temporaryCompiler = join(
      compilerDirectory,
      `.${basename(sourcePath)}.${process.pid}.tmp`,
    );
    rmSync(temporaryCompiler, { force: true });
    try {
      writeFileSync(temporaryCompiler, compilerBytes, {
        flag: 'wx',
        mode: 0o700,
      });
      chmodSync(temporaryCompiler, 0o700);
      renameSync(temporaryCompiler, executableCompiler);
    } finally {
      rmSync(temporaryCompiler, { force: true });
    }
  }
  accessSync(executableCompiler, constants.X_OK);
  executableEffectTsgoCompilers.set(sourcePath, executableCompiler);
  return executableCompiler;
}

/**
 * Reads an environment variable while keeping generated build configs free of
 * direct process access.
 */
export function getBuildConfigEnvironment(name: string): string | undefined {
  return process.env[name];
}

export type ResolveEffectTsgoCompilerOptions = {
  /** Module URL or absolute filename used to resolve the consumer's compiler. */
  from: string | URL;
};

/**
 * Resolves the Effect-enabled native executable for checking and DTS builds.
 * Use metadata-bound tsrs where both tsrs and the Effect provider support it.
 * Unsupported targets use Effect-Go. Missing supported artifacts remain fatal.
 */
export function resolveEffectTsgoCompiler(
  options: ResolveEffectTsgoCompilerOptions,
): string {
  const configuredCompiler =
    getBuildConfigEnvironment('EFFECT_TSGO_BIN')?.trim();

  if (configuredCompiler) {
    try {
      const compiler = resolveExecutableEffectTsgoCompiler(configuredCompiler);
      validateConfiguredEffectCompiler(compiler, options.from);
      return compiler;
    } catch (cause) {
      throw effectTsgoResolutionError(
        cause,
        'Configured compiler validation',
        options.from,
      );
    }
  }

  let stage = 'Package CLI resolution';
  try {
    const compiler = resolveInstalledEffectCompiler(options.from).trim();
    stage = 'Compiler backend lookup';

    if (!compiler) {
      throw new Error('Effect TS-Go discovery returned an empty compiler path');
    }
    stage = 'Compiler executable validation';
    return resolveExecutableEffectTsgoCompiler(compiler);
  } catch (cause) {
    throw effectTsgoResolutionError(
      cause,
      effectCompilerDiscoveryFailureStage(cause) ?? stage,
      options.from,
    );
  }
}
