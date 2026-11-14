import { fs } from '@modern-js/utils';
import { spawn } from 'child_process';
import path from 'path';
import type { ServerCompiler, ServerCompilerConfig } from '../common';

type TypeScriptPackageJson = {
  name?: string;
  version?: string;
  bin?: { tsc?: string };
};

// Distinguishes concurrent compiles within the same process (plugin-bff and
// app-tools both call into this compiler) so their temp configs cannot clash.
let resolvedConfigCount = 0;

/**
 * Write a one-shot tsconfig for type-checking (and, when the app asks for
 * declarations, declaration emit) of exactly the server source directories.
 * JavaScript is emitted by Rslib, so nothing here shapes runtime output.
 */
export const createResolvedTsgoConfig = async (
  appDirectory: string,
  tsconfigPath: string,
  sourceDirs: string[],
  tsgoBinPath: string | Pick<ServerCompiler, 'readConfig'>,
  excludeFiles: string[] = [],
) => {
  const tsconfigDir = path.dirname(tsconfigPath);
  const config: ServerCompilerConfig =
    typeof tsgoBinPath === 'string'
      ? JSON.parse(
          (
            await runTsgo(tsgoBinPath, ['--showConfig', '-p', tsconfigPath], {
              cwd: tsconfigDir,
            })
          ).stdout,
        )
      : await tsgoBinPath.readConfig(tsconfigPath);

  config.compilerOptions ??= {};
  const options = config.compilerOptions;
  options.rootDir = appDirectory;
  options.composite = false;
  options.declarationMap = false;
  options.incremental = false;
  // Rslib's declaration emit reads this config; the type check passes --noEmit.
  options.noEmit = options.declaration !== true;
  // Server sources may import TSX; `jsx` unset fails every such import.
  options.jsx ??= 'react-jsx';
  if (config.extends) {
    // Deletion would restore the authored values through inheritance.
    options.emitDeclarationOnly = false;
    options.outDir = null;
    options.tsBuildInfoFile = null;
  } else {
    delete options.emitDeclarationOnly;
    delete options.outDir;
    delete options.tsBuildInfoFile;
  }
  // `--showConfig` emits `files` relative to the tsconfig directory.
  config.files = filterSourceFiles(
    tsconfigDir,
    sourceDirs,
    config.files,
    excludeFiles,
  );
  config.include = [];
  // Project references make TS-Go require declaration outputs of sibling
  // workspace packages that this check never builds (TS6305 on a clean
  // checkout). Their sources stay reachable through module resolution.
  delete config.references;

  // TS-Go v7 removed baseUrl. Rebase `paths` onto the tsconfig directory so
  // TS-Go and Rspack's tsconfig resolver both see the mapping the app wrote.
  if (options.baseUrl != null) {
    const baseUrl = path.resolve(tsconfigDir, options.baseUrl);
    if (options.paths) {
      options.paths = Object.fromEntries(
        Object.entries(options.paths).map(([key, targets]) => [
          key,
          targets.map(target => {
            const relative = path
              .relative(tsconfigDir, path.resolve(baseUrl, target))
              .split(path.sep)
              .join(path.posix.sep);
            return relative.startsWith('.') ? relative : `./${relative}`;
          }),
        ]),
      );
    }
    if (config.extends) options.baseUrl = null;
    else delete options.baseUrl;
  }
  if (
    ['node', 'node10'].includes(String(options.moduleResolution).toLowerCase())
  ) {
    if (config.extends) options.moduleResolution = null;
    else delete options.moduleResolution;
  }

  // Keep the generated config beside the app tsconfig so the relative `files`
  // and `paths` entries emitted by `--showConfig` keep the same base directory.
  const resolvedConfigPath = path.join(
    tsconfigDir,
    `.tsgo.${process.pid}.${resolvedConfigCount++}.resolved.json`,
  );
  await fs.writeFile(resolvedConfigPath, JSON.stringify(config, null, 2));

  return { config, resolvedConfigPath };
};

const toPosix = (file: string) => file.split(path.sep).join(path.posix.sep);

const filterSourceFiles = (
  tsconfigDir: string,
  sourceDirs: string[],
  files: string[] = [],
  excludeFiles: string[] = [],
) => {
  const sourcePosixPaths = sourceDirs.map(toPosix);
  const excludedPaths = new Set(
    excludeFiles.map(file => toPosix(path.normalize(file))),
  );

  return files.filter(fileName => {
    const absoluteFileName = toPosix(path.resolve(tsconfigDir, fileName));
    if (excludedPaths.has(absoluteFileName)) {
      return false;
    }
    return (
      fileName.endsWith('.d.ts') ||
      sourcePosixPaths.some(sourceDir => absoluteFileName.includes(sourceDir))
    );
  });
};

export const runTsgo = (
  tsgoBinPath: string | ServerCompiler['command'],
  args: string[],
  options: {
    cwd: string;
    reject?: boolean;
  },
) =>
  new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      const command =
        typeof tsgoBinPath === 'string'
          ? { executable: process.execPath, args: [tsgoBinPath] }
          : tsgoBinPath;
      const child = spawn(command.executable, [...command.args, ...args], {
        cwd: options.cwd,
        ...(typeof tsgoBinPath === 'string' ? {} : { env: tsgoBinPath.env }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', data => {
        stdout += data;
      });
      child.stderr.on('data', data => {
        stderr += data;
      });
      child.on('error', reject);
      child.on('close', code => {
        const result = { stdout, stderr, code: code ?? 1 };
        if (options.reject !== false && result.code !== 0) {
          reject(
            new Error(stderr || stdout || `tsgo exited with ${result.code}`),
          );
          return;
        }
        resolve(result);
      });
    },
  );

// Resolve the stable compiler from the app first, then this package's declared
// production dependency. The `resolvePaths` parameter exists for tests.
const resolveTypeScriptPackage = (resolvePaths: string[]) => {
  try {
    return require.resolve('typescript/package.json', { paths: resolvePaths });
  } catch {
    throw new Error(
      'TypeScript 7.0.2 could not be found! Please install "typescript@7.0.2" in your project to type-check BFF/server code.',
    );
  }
};

export const getTsgoBinPath = (
  appDirectory: string,
  resolvePaths: string[] = [appDirectory, __dirname],
) => {
  const pkgPath = resolveTypeScriptPackage(resolvePaths);
  const pkgDir = path.dirname(pkgPath);
  const pkg: TypeScriptPackageJson = require(pkgPath);
  if (pkg.name !== 'typescript' || pkg.version !== '7.0.2') {
    throw new Error(
      `Server compilation requires typescript@7.0.2; found ${pkg.name ?? 'unnamed package'}@${pkg.version ?? 'unknown version'} at ${pkgPath}.`,
    );
  }
  if (typeof pkg.bin?.tsc !== 'string' || !pkg.bin.tsc) {
    throw new Error(`typescript@7.0.2 declares no tsc executable: ${pkgPath}.`);
  }
  const binPath = path.resolve(pkgDir, pkg.bin.tsc);
  const relativeBinPath = path.relative(pkgDir, binPath);
  if (
    relativeBinPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeBinPath) ||
    !fs.existsSync(binPath) ||
    !fs.statSync(binPath).isFile()
  ) {
    throw new Error(
      `typescript@7.0.2 declared tsc executable is missing or outside its package: ${binPath}.`,
    );
  }
  return binPath;
};

/**
 * The TypeScript 7 package entry that Rslib's declaration emitter loads to read the
 * compiler version and locate its executable.
 */
export const getTsgoModulePath = (
  appDirectory: string,
  resolvePaths: string[] = [appDirectory, __dirname],
) => {
  resolveTypeScriptPackage(resolvePaths);
  return require.resolve('typescript', { paths: resolvePaths });
};
