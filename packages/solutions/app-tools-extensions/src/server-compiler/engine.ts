import os from 'node:os';
import path from 'node:path';
import { fs, logger, mergeAlias, semver } from '@modern-js/utils';
import type { LibConfig, RslibConfig, Rspack } from '@rslib/core';
import {
  createResolvedTsgoConfig,
  getTsgoBinPath,
  getTsgoModulePath,
  runTsgo,
} from './tsgo';
import type {
  DeclarationPluginOptions,
  ServerCompilationResult,
  ServerCompileConfig,
  ServerCompileOptions,
  ServerCompiler,
  ServerCompilerConfig,
} from './types';

const SCRIPT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const DECLARATION_RE = /\.d\.[cm]?ts$/u;
const TS_RE = /\.[cm]?tsx?$/u;

const toPosix = (file: string) => file.split(path.sep).join(path.posix.sep);

// Rslib reads bundleless entries as globs; BFF routes such as `[id].ts` are
// literal names.
const escapeGlob = (file: string) =>
  file.replace(/[\\()[\]{}*?!+@|]/gu, '\\$&');
const RESOLVED_CONFIG_RE = /\.tsgo\.\d+\.\d+\.resolved\.json$/u;

const walk = async (dir: string): Promise<string[]> => {
  if (!(await fs.pathExists(dir))) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(entry => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : walk(file);
      }
      return [file];
    }),
  );
  return files.flat();
};

const isScript = (file: string) =>
  SCRIPT_RE.test(file) && !DECLARATION_RE.test(file);

// Node picks the module format from the extension, so sources keep theirs:
// `.mts`/`.mjs` emit ESM `.mjs`, `.cts`/`.cjs` emit CommonJS `.cjs`, and
// everything else emits `.js` in the app's own format.
type OutputExtension = '.js' | '.mjs' | '.cjs';
const OUTPUT_EXTENSIONS: readonly OutputExtension[] = ['.js', '.mjs', '.cjs'];
const outputExtension = (file: string): OutputExtension =>
  /\.m[jt]s$/u.test(file) ? '.mjs' : /\.c[jt]s$/u.test(file) ? '.cjs' : '.js';
const emittedName = (file: string) =>
  `${file.replace(SCRIPT_RE, '')}${outputExtension(file)}`;

const validateAbsolute = (files: readonly string[], kind: string) => {
  for (const file of files) {
    if (!path.isAbsolute(file)) {
      throw new Error(`${kind} ${file} is not an absolute path.`);
    }
  }
};

const collectSources = async (sourceDirs: string[], excludeFiles: string[]) => {
  const excluded = new Set(excludeFiles.map(file => path.normalize(file)));
  return (await Promise.all(sourceDirs.map(walk)))
    .flat()
    .filter(file => isScript(file) && !excluded.has(path.normalize(file)));
};

const groupSources = (appDirectory: string, files: Iterable<string>) => {
  const outputs = new Map<string, string>();
  const groups: Record<OutputExtension, string[]> = {
    '.js': [],
    '.mjs': [],
    '.cjs': [],
  };
  for (const file of files) {
    const output = emittedName(file);
    const existing = outputs.get(output);
    if (existing) {
      throw new Error(
        `"${existing}" and "${file}" both compile to "${toPosix(path.relative(appDirectory, output))}". Rename one of them.`,
      );
    }
    outputs.set(output, file);
    groups[outputExtension(file)].push(file);
  }
  return groups;
};

type ResolvedAlias = Record<string, string[]>;

// Relative alias targets are written relative to the app, as in every other
// Modern.js build; the resolver needs them absolute.
const resolveAlias = (
  appDirectory: string,
  alias: ServerCompileConfig['alias'],
): ResolvedAlias =>
  Object.fromEntries(
    Object.entries(mergeAlias(alias)).map(([key, target]) => [
      key,
      ([] as string[])
        .concat(target)
        .map(value =>
          value.startsWith('.') ? path.resolve(appDirectory, value) : value,
        ),
    ]),
  );

// Rspack alias keys match the whole request (`key$`) or a path prefix (`key`).
const matchAlias = (alias: ResolvedAlias, request: string) => {
  for (const [key, targets] of Object.entries(alias)) {
    const exact = key.endsWith('$');
    const name = exact ? key.slice(0, -1) : key;
    if (request === name || (!exact && request.startsWith(`${name}/`))) {
      return { targets, rest: request.slice(name.length) };
    }
  }
  return undefined;
};

const isBareSpecifier = (specifier: string) =>
  !/^[./]/u.test(specifier) && !path.isAbsolute(specifier);

const relativeSpecifier = (from: string, to: string) => {
  const relative = toPosix(path.relative(from, to));
  return relative.startsWith('.') ? relative : `./${relative}`;
};

type Resolve = (context: string, request: string) => Promise<string>;

/**
 * Where one import of an app module leads. Rspack has already applied
 * `source.alias` and tsconfig `paths` when it resolves, so discovery and
 * emit classify every request identically.
 */
type ImportTarget =
  | { kind: 'entry' }
  | { kind: 'unresolved'; request: string }
  /** Packages and files outside the app stay imports of themselves. */
  | { kind: 'external'; request: string; resolved: string }
  | { kind: 'script'; resolved: string }
  | { kind: 'asset'; resolved: string };

const classifyImport = async (
  appDirectory: string,
  data: Rspack.ExternalItemFunctionData,
): Promise<ImportTarget & { resolve?: Resolve }> => {
  const { request, context, contextInfo, getResolve } = data;
  if (!request || !context || !contextInfo?.issuer || !getResolve) {
    return { kind: 'entry' };
  }
  const resolve = getResolve() as Resolve;
  const resolved = await resolve(context, request).catch(() => '');
  if (!resolved) {
    return { kind: 'unresolved', request, resolve };
  }
  // `path.relative` across Windows drives returns an absolute path.
  const fromApp = path.relative(appDirectory, resolved);
  if (
    fromApp.startsWith('..') ||
    path.isAbsolute(fromApp) ||
    resolved.includes(`${path.sep}node_modules${path.sep}`)
  ) {
    return { kind: 'external', request, resolved, resolve };
  }
  return isScript(resolved)
    ? { kind: 'script', resolved }
    : { kind: 'asset', resolved };
};

/**
 * Discovery: every import Rspack follows from the roots, recorded while it
 * builds one non-emitting bundle per output format. App scripts are followed
 * (aliases, cycles and all); packages, outside files and assets are not.
 */
const discoveryExternal =
  ({
    appDirectory,
    scripts,
    assets,
  }: {
    appDirectory: string;
    scripts: Set<string>;
    assets: Set<string>;
  }) =>
  async (data: Rspack.ExternalItemFunctionData) => {
    const target = await classifyImport(appDirectory, data);
    switch (target.kind) {
      case 'entry':
        return undefined;
      case 'script':
        scripts.add(target.resolved);
        return undefined;
      case 'asset':
        assets.add(target.resolved);
        return data.request;
      case 'unresolved':
      case 'external':
        return target.request;
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
  };

/**
 * Emit: point imports of other app sources at their emitted file. Everything
 * outside the app (packages, workspace dependencies) stays a bare import,
 * including packages that only the deployment runtime provides; an alias to
 * another package keeps that package, and an alias to a path points at it
 * from the output file.
 */
const emitExternal =
  ({
    appDirectory,
    distDir,
    alias,
    sources,
  }: {
    appDirectory: string;
    distDir: string;
    alias: ResolvedAlias;
    sources: ReadonlySet<string>;
  }) =>
  async (data: Rspack.ExternalItemFunctionData) => {
    const target = await classifyImport(appDirectory, data);
    const issuer = data.contextInfo?.issuer ?? '';
    switch (target.kind) {
      case 'entry':
        return undefined;
      case 'unresolved':
        // Rslib leaves an unresolvable request as written.
        return /^[./]/u.test(target.request) ? undefined : target.request;
      case 'external': {
        const aliased = matchAlias(alias, target.request);
        if (!aliased || !target.resolve || !data.context) {
          return target.request;
        }
        // An alias array falls back target by target; keep the package that
        // actually resolved.
        for (const candidate of aliased.targets.filter(isBareSpecifier)) {
          const specifier = `${candidate}${aliased.rest}`;
          if (
            (await target.resolve(data.context, specifier).catch(() => '')) ===
            target.resolved
          ) {
            return specifier;
          }
        }
        const outputDir = path.join(
          distDir,
          path.relative(appDirectory, path.dirname(issuer)),
        );
        return relativeSpecifier(outputDir, target.resolved);
      }
      case 'script':
        if (!sources.has(target.resolved)) {
          throw new Error(
            `Server compilation reached ${target.resolved} from ${issuer}, which discovery did not find.`,
          );
        }
        return relativeSpecifier(
          path.dirname(issuer),
          emittedName(target.resolved),
        );
      case 'asset':
        return relativeSpecifier(path.dirname(issuer), target.resolved);
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
  };

const LOCATED_DIAGNOSTIC =
  /^(\S.*?)(?:\(\d+,\d+\)|:\d+:\d+)(?::| -) error\b/gmu;
const GLOBAL_DIAGNOSTIC = /^error\b/mu;
const ANSI = /\u001b\[[0-9;]*m/gu;

/**
 * Located source diagnostics follow the authored `noEmitOnError` policy.
 * Everything else (config and option errors, a crash, a signal, output that
 * is not diagnostics) means there was no complete check, and always fails.
 */
const isSourceDiagnosticsOnly = (
  code: number,
  output: string,
  errorOutput: string,
) => {
  if (code !== 1 && code !== 2) return false;
  // Native checker panics share exit code 2 with source diagnostics. Never
  // hide their stderr behind diagnostics already printed to stdout.
  if (errorOutput.trim()) return false;
  const text = output.replace(ANSI, '');
  if (GLOBAL_DIAGNOSTIC.test(text)) return false;
  const files = [...text.matchAll(LOCATED_DIAGNOSTIC)].map(match => match[1]);
  return files.length > 0 && files.every(file => !/\.json$/u.test(file));
};

const nodeTargetOf = async (
  appDirectory: string,
): Promise<Rspack.Configuration['target']> => {
  const appPackage = await fs
    .readJSON(path.join(appDirectory, 'package.json'))
    .catch(() => undefined);
  const nodeEngine = appPackage?.engines?.node;
  const nodeRange =
    typeof nodeEngine === 'string' ? semver.validRange(nodeEngine) : null;
  const nodeVersion = nodeRange ? semver.minVersion(nodeRange) : null;
  return nodeVersion?.major
    ? `node${nodeVersion.major}.${nodeVersion.minor}`
    : undefined;
};

/**
 * Compile server sources with the stable TypeScript 7.0.2 compiler or the
 * supplied provider. One non-emitting Rspack pass discovers every app source
 * the roots reach, one program type-checks all of them (unless
 * `disableTsChecker` is set), and only then does one bundleless Rslib build
 * emit JavaScript and declarations.
 */
export const compileServerSources = async (
  appDirectory: string,
  config: ServerCompileConfig,
  options: ServerCompileOptions,
): Promise<ServerCompilationResult> => {
  const { sourceDirs, distDir, excludeFiles = [], tsconfigPath } = options;
  validateAbsolute(sourceDirs, 'source dir');
  validateAbsolute([distDir], 'dist dir');
  validateAbsolute(excludeFiles, 'excluded file');
  if (!tsconfigPath) {
    return { rootFiles: [], emittedFiles: [] };
  }
  try {
    const compiler = await options.compiler?.(appDirectory);
    try {
      return await compileWithCompiler(
        appDirectory,
        config,
        { ...options, excludeFiles, tsconfigPath },
        compiler,
      );
    } finally {
      await compiler?.dispose?.();
    }
  } catch (error) {
    if (options.throwErrorInsteadOfExit) {
      throw error;
    }
    logger.error(error);
    process.exit(1);
  }
};

type CompileInput = ServerCompileOptions & {
  excludeFiles: string[];
  tsconfigPath: string;
};

const compileWithCompiler = async (
  appDirectory: string,
  config: ServerCompileConfig,
  options: CompileInput,
  compiler: ServerCompiler | undefined,
): Promise<ServerCompilationResult> => {
  const selectedCompiler = compiler ?? getTsgoBinPath(appDirectory);
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), 'modern-server-compile-'),
  );
  let resolvedConfigPath: string | undefined;
  try {
    const resolved = await createResolvedTsgoConfig(
      appDirectory,
      options.tsconfigPath,
      options.sourceDirs,
      selectedCompiler,
      options.excludeFiles,
    );
    resolvedConfigPath = resolved.resolvedConfigPath;
    return await compileProgram({
      appDirectory,
      config,
      options,
      compiler,
      checker:
        typeof selectedCompiler === 'string'
          ? selectedCompiler
          : selectedCompiler.command,
      tsconfig: resolved.config,
      resolvedConfigPath,
      scratch,
    });
  } finally {
    await fs.remove(scratch);
    if (resolvedConfigPath) await fs.remove(resolvedConfigPath);
  }
};

const compileProgram = async ({
  appDirectory,
  config,
  options,
  compiler,
  checker,
  tsconfig,
  resolvedConfigPath,
  scratch,
}: {
  appDirectory: string;
  config: ServerCompileConfig;
  options: CompileInput;
  compiler: ServerCompiler | undefined;
  checker: string | ServerCompiler['command'];
  tsconfig: ServerCompilerConfig;
  resolvedConfigPath: string;
  scratch: string;
}): Promise<ServerCompilationResult> => {
  const { sourceDirs, distDir, tsconfigPath, moduleType, excludeFiles } =
    options;
  const sources = new Set(await collectSources(sourceDirs, excludeFiles));
  const compilerOptions = tsconfig.compilerOptions ?? {};
  const isChecked = (file: string) =>
    compilerOptions.allowJs === true || TS_RE.test(file);
  // Roots start from the tsconfig's files, so scripts it excludes (tests,
  // client-only code) are neither emitted nor left unchecked. JavaScript is
  // outside the program unless `allowJs` is set, and is then emitted as found.
  const tsconfigDir = path.dirname(tsconfigPath);
  const roots = new Set(
    (tsconfig.files ?? []).map(file => path.resolve(tsconfigDir, file)),
  );
  for (const file of sources) {
    if (isChecked(file) && !roots.has(path.resolve(file))) {
      sources.delete(file);
    }
  }
  const initialSources = [...sources];
  const failOnTypeError = compilerOptions.noEmitOnError !== false;
  const alias = resolveAlias(appDirectory, config.alias);
  const nodeTarget = await nodeTargetOf(appDirectory);
  const { createRslib } = await import('@rslib/core');
  const formats: Record<OutputExtension, 'esm' | 'cjs'> = {
    '.js': moduleType === 'module' ? 'esm' : 'cjs',
    '.mjs': 'esm',
    '.cjs': 'cjs',
  };
  // Discovery and emit share everything that decides how a request resolves.
  const sharedConfig = (
    distRoot: string,
    sourceMap: ServerCompileConfig['sourceMap'],
    rspack: (rspackConfig: Rspack.Configuration) => void,
  ): Omit<RslibConfig, 'lib'> => ({
    source: {
      tsconfigPath: resolvedConfigPath,
      ...(compilerOptions.experimentalDecorators
        ? { decorators: { version: 'legacy' } }
        : {}),
    },
    resolve: { alias },
    output: {
      target: 'node',
      distPath: { root: distRoot },
      cleanDistPath: false,
      sourceMap,
    },
    // Concurrent server compiles of one app would share the cache.
    performance: { buildCache: false, printFileSize: false },
    tools: {
      rspack: rspackConfig => {
        // Keep Rslib's engine-based syntax transforms, but describe the Node
        // runtime with Rspack's native target, not its browser database.
        if (nodeTarget) rspackConfig.target = nodeTarget;
        rspack(rspackConfig);
      },
    },
  });
  const libsOf = (
    groups: Record<OutputExtension, string[]>,
    lib: (extension: OutputExtension, files: string[]) => LibConfig,
  ) =>
    OUTPUT_EXTENSIONS.filter(extension => groups[extension].length > 0).map(
      extension => lib(extension, groups[extension]),
    );

  // Non-script files that app code imports, such as JSON next to a reached
  // source outside the source directories.
  const assets = new Set<string>();
  if (sources.size > 0) {
    const scripts = new Set<string>();
    const discovery = await createRslib({
      cwd: appDirectory,
      config: {
        lib: libsOf(
          groupSources(appDirectory, sources),
          (extension, files) => ({
            format: formats[extension],
            bundle: true,
            autoExtension: false,
            source: {
              entry: Object.fromEntries(
                files.map((file, index) => [`root${index}`, file]),
              ),
            },
          }),
        ),
        ...sharedConfig(
          path.join(scratch, 'discovery'),
          false,
          rspackConfig => {
            // Discovery decides every request itself, ahead of Rslib's package
            // externals, exactly as the emit below does.
            rspackConfig.externals = [
              discoveryExternal({ appDirectory, scripts, assets }),
            ];
            rspackConfig.plugins = [
              ...(rspackConfig.plugins ?? []),
              {
                apply(rspackCompiler: Rspack.Compiler) {
                  rspackCompiler.hooks.shouldEmit.tap(
                    'modern-server-discovery',
                    () => false,
                  );
                },
              },
            ];
          },
        ),
      },
    });
    await discovery.build();
    for (const file of scripts) {
      sources.add(file);
    }
  }

  // One program checks every source that will run, including those reached
  // only through `source.alias`. The declaration program is this same file.
  const checkTypes = config.disableTsChecker !== true;
  const reachedRoots = [...sources].filter(
    file => isChecked(file) && !roots.has(path.resolve(file)),
  );
  if (reachedRoots.length > 0) {
    for (const file of reachedRoots) roots.add(path.resolve(file));
    tsconfig.files = [
      ...(tsconfig.files ?? []),
      ...reachedRoots.map(file => toPosix(path.relative(tsconfigDir, file))),
    ];
  }
  // Without the checker, declarations still come from this program, unchecked.
  if (!checkTypes) {
    tsconfig.compilerOptions = { ...compilerOptions, noCheck: true };
  }
  if (reachedRoots.length > 0 || !checkTypes) {
    await fs.writeFile(resolvedConfigPath, JSON.stringify(tsconfig, null, 2));
  }
  // Declaration-only roots are still checked; an empty program is not.
  if (checkTypes && roots.size > 0) {
    const result = await runTsgo(
      checker,
      ['-p', resolvedConfigPath, '--noEmit'],
      { cwd: appDirectory, reject: false },
    );
    if (result.code !== 0) {
      const diagnostics = [result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join('\n');
      if (
        failOnTypeError ||
        !isSourceDiagnosticsOnly(result.code, result.stdout, result.stderr)
      ) {
        throw new Error(
          [
            `TS-Go type check failed with exit code ${result.code}.`,
            diagnostics,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      logger.warn(`TS-Go type check found errors:\n${diagnostics}`);
    }
  }

  const emitted = new Set<string>();
  const rootFiles = initialSources.map(file =>
    path.join(distDir, path.relative(appDirectory, emittedName(file))),
  );
  try {
    if (sources.size > 0) {
      // Declarations go to a private directory first: the plugin
      // post-processes every declaration it finds there, and what it wrote
      // is then exactly what moves into the output.
      const declarationOptions: DeclarationPluginOptions = {
        distPath: path.join(scratch, 'declarations'),
        abortOnError: failOnTypeError,
        redirect: { extension: moduleType === 'module' },
      };
      const libs = libsOf(
        groupSources(appDirectory, sources),
        (extension, files): LibConfig => ({
          format: formats[extension],
          bundle: false,
          autoExtension: false,
          outBase: appDirectory,
          source: {
            entry: {
              index: files.map(file =>
                escapeGlob(toPosix(path.relative(appDirectory, file))),
              ),
            },
          },
          output: { filename: { js: `[name]${extension}` } },
        }),
      );
      // TS-Go emits declarations for the whole program; one library runs it.
      if (compilerOptions.declaration === true && compiler) {
        libs[0].plugins = [
          await compiler.declarationPlugin(declarationOptions),
        ];
      } else if (compilerOptions.declaration === true) {
        libs[0].redirect = { dts: declarationOptions.redirect };
        libs[0].dts = {
          bundle: false,
          distPath: declarationOptions.distPath,
          tsgo: true,
          typescriptPath: getTsgoModulePath(appDirectory),
          abortOnError: declarationOptions.abortOnError,
        };
      }
      const emit = await createRslib({
        cwd: appDirectory,
        config: {
          lib: libs,
          ...sharedConfig(
            distDir,
            config.sourceMap ?? { js: 'source-map' },
            rspackConfig => {
              // Externals run in order; app imports must not reach Rslib's
              // redirect, which knows only one output extension per library.
              rspackConfig.externals = [
                emitExternal({ appDirectory, distDir, alias, sources }),
                ...[rspackConfig.externals ?? []].flat(),
              ];
              rspackConfig.plugins = [
                ...(rspackConfig.plugins ?? []),
                {
                  apply(rspackCompiler: Rspack.Compiler) {
                    rspackCompiler.hooks.afterEmit.tap(
                      'modern-server-inventory',
                      compilation => {
                        const outputPath =
                          compilation.outputOptions.path ?? distDir;
                        for (const asset of compilation.getAssets()) {
                          emitted.add(path.join(outputPath, asset.name));
                        }
                      },
                    );
                  },
                },
              ];
            },
          ),
        },
      });
      await emit.build();
      const declarationDir = declarationOptions.distPath;
      for (const file of await walk(declarationDir)) {
        const target = path.join(distDir, path.relative(declarationDir, file));
        await fs.move(file, target, { overwrite: true });
        emitted.add(target);
      }
    }
    const copies = new Map<string, string>();
    for (const sourceDir of sourceDirs) {
      for (const file of await walk(sourceDir)) {
        if (
          !SCRIPT_RE.test(file) &&
          !file.endsWith('tsconfig.json') &&
          !RESOLVED_CONFIG_RE.test(file)
        ) {
          copies.set(
            path.join(distDir, path.relative(appDirectory, file)),
            file,
          );
        }
      }
    }
    for (const asset of assets) {
      copies.set(path.join(distDir, path.relative(appDirectory, asset)), asset);
    }
    for (const [target, file] of copies) {
      await fs.copy(file, target);
      emitted.add(target);
    }
    const missing = [...sources]
      .map(file =>
        path.join(distDir, path.relative(appDirectory, emittedName(file))),
      )
      .filter(file => !emitted.has(file));
    if (missing.length > 0) {
      throw new Error(
        `Server compilation did not emit its sources: ${missing.join(', ')}`,
      );
    }
  } catch (error) {
    // A failed compilation leaves none of its own output behind.
    await Promise.all([...emitted].map(file => fs.remove(file)));
    throw error;
  }

  logger.info('Server sources compiled');
  return { rootFiles, emittedFiles: [...emitted].sort() };
};
