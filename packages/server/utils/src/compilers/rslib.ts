import { fs, logger, mergeAlias, semver } from '@modern-js/utils';
import type { LibConfig, Rspack } from '@rslib/core';
import path from 'path';
import type { CompileOptions, IConfig } from '../common';
import {
  createResolvedTsgoConfig,
  getTsgoBinPath,
  getTsgoModulePath,
  runTsgo,
} from './tsgo';

const SCRIPT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const DECLARATION_RE = /\.d\.[cm]?ts$/u;
const TS_RE = /\.[cm]?tsx?$/u;

const toPosix = (file: string) => file.split(path.sep).join(path.posix.sep);

// Rslib reads entries as globs; BFF routes such as `[id].ts` are literal names.
const escapeGlob = (file: string) => file.replace(/[()[\]{}*?!+@]/gu, '\\$&');

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

// Node picks the module format from the extension, so sources keep theirs:
// `.mts`/`.mjs` emit ESM `.mjs`, `.cts`/`.cjs` emit CommonJS `.cjs`, and
// everything else emits `.js` in the app's own format.
type OutputExtension = '.js' | '.mjs' | '.cjs';
const outputExtension = (file: string): OutputExtension =>
  /\.m[jt]s$/u.test(file) ? '.mjs' : /\.c[jt]s$/u.test(file) ? '.cjs' : '.js';

const collectSources = async (sourceDirs: string[], excludeFiles: string[]) => {
  const excluded = new Set(excludeFiles.map(file => path.normalize(file)));
  return (await Promise.all(sourceDirs.map(walk)))
    .flat()
    .filter(
      file =>
        SCRIPT_RE.test(file) &&
        !DECLARATION_RE.test(file) &&
        !excluded.has(path.normalize(file)),
    );
};

const groupEntries = (appDirectory: string, files: Iterable<string>) => {
  const outputs = new Map<string, string>();
  const entries: Record<OutputExtension, string[]> = {
    '.js': [],
    '.mjs': [],
    '.cjs': [],
  };
  for (const file of files) {
    const extension = outputExtension(file);
    const output = `${file.replace(SCRIPT_RE, '')}${extension}`;
    const existing = outputs.get(output);
    if (existing) {
      throw new Error(
        `"${existing}" and "${file}" both compile to "${toPosix(path.relative(appDirectory, output))}". Rename one of them.`,
      );
    }
    outputs.set(output, file);
    entries[extension].push(
      escapeGlob(toPosix(path.relative(appDirectory, file))),
    );
  }
  return entries;
};

// Relative alias targets are written relative to the app, as in every other
// Modern.js build; the resolver needs them absolute.
const resolveAlias = (appDirectory: string, alias: IConfig['alias']) =>
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

const copyAssets = async (
  sourceDir: string,
  appDirectory: string,
  distDir: string,
) => {
  if (!(await fs.pathExists(sourceDir))) {
    return;
  }
  await fs.copy(
    sourceDir,
    path.join(distDir, path.relative(appDirectory, sourceDir)),
    {
      filter: src => !SCRIPT_RE.test(src) && !src.endsWith('tsconfig.json'),
    },
  );
};

type ResolvedAlias = Record<string, string[]>;

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

/**
 * Point imports of other app sources at their emitted file. Rspack has
 * already applied `source.alias` and tsconfig `paths` when it resolves, so
 * this only maps a resolved source to its output name. Everything outside
 * the app (packages, workspace dependencies) stays a bare import, including
 * packages that only the deployment runtime provides; an alias to another
 * package keeps that package, and an alias to a path points at it from the
 * output file.
 */
const importEmittedFile =
  ({
    appDirectory,
    distDir,
    alias,
    sources,
    reached,
    assets,
  }: {
    appDirectory: string;
    distDir: string;
    alias: ResolvedAlias;
    sources: Set<string>;
    reached: Set<string>;
    assets: Set<string>;
  }) =>
  async ({
    request,
    context,
    contextInfo,
    getResolve,
  }: Rspack.ExternalItemFunctionData) => {
    if (!request || !context || !contextInfo?.issuer || !getResolve) {
      return undefined;
    }
    const resolve = getResolve() as (
      context: string,
      request: string,
    ) => Promise<string>;
    const resolved = await resolve(context, request).catch(() => '');
    if (!resolved) {
      return /^[./]/u.test(request) ? undefined : request;
    }
    // `path.relative` across Windows drives returns an absolute path.
    const fromApp = path.relative(appDirectory, resolved);
    if (
      fromApp.startsWith('..') ||
      path.isAbsolute(fromApp) ||
      resolved.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      const aliased = matchAlias(alias, request);
      if (!aliased) {
        return request;
      }
      // An alias array falls back target by target; keep the package that
      // actually resolved.
      for (const target of aliased.targets.filter(isBareSpecifier)) {
        const specifier = `${target}${aliased.rest}`;
        if ((await resolve(context, specifier).catch(() => '')) === resolved) {
          return specifier;
        }
      }
      const outputDir = path.join(
        distDir,
        path.relative(appDirectory, path.dirname(contextInfo.issuer)),
      );
      return relativeSpecifier(outputDir, resolved);
    }
    const script = SCRIPT_RE.test(resolved) && !DECLARATION_RE.test(resolved);
    if (script && !sources.has(resolved)) {
      reached.add(resolved);
    }
    if (!script) {
      assets.add(resolved);
    }
    const emitted = script
      ? `${resolved.replace(SCRIPT_RE, '')}${outputExtension(resolved)}`
      : resolved;
    return relativeSpecifier(path.dirname(contextInfo.issuer), emitted);
  };

/**
 * Compile server sources file-by-file with Rslib (bundleless, Node target).
 * Rspack resolves `source.alias` and tsconfig `paths` while it emits, so the
 * output specifiers and source maps are right the first time. TS-Go only
 * type-checks, and emits declarations when the app's tsconfig asks for them.
 */
export const compileServerSources = async (
  appDirectory: string,
  config: IConfig,
  options: CompileOptions & { tsconfigPath: string },
) => {
  const {
    sourceDirs,
    distDir,
    tsconfigPath,
    moduleType,
    excludeFiles = [],
  } = options;
  const sources = new Set(await collectSources(sourceDirs, excludeFiles));
  const copyAllAssets = async () => {
    for (const sourceDir of sourceDirs) {
      await copyAssets(sourceDir, appDirectory, distDir);
    }
  };
  const tsgoBinPath = getTsgoBinPath(appDirectory);
  const { config: tsconfig, resolvedConfigPath } =
    await createResolvedTsgoConfig(
      appDirectory,
      tsconfigPath,
      sourceDirs,
      tsgoBinPath,
      excludeFiles,
    );
  const compilerOptions = tsconfig.compilerOptions ?? {};
  // Entries start from the tsconfig's root files, so scripts it excludes
  // (tests, client-only code) are neither emitted nor left unchecked.
  // JavaScript is outside the TS-Go program unless `allowJs` is set, and is
  // then emitted as found.
  const tsconfigDir = path.dirname(tsconfigPath);
  const roots = new Set(
    (tsconfig.files ?? []).map(file => path.resolve(tsconfigDir, file)),
  );
  for (const file of sources) {
    const checked = compilerOptions.allowJs === true || TS_RE.test(file);
    if (checked && !roots.has(path.resolve(file))) {
      sources.delete(file);
    }
  }
  const failOnTypeError = compilerOptions.noEmitOnError !== false;
  const declaration = compilerOptions.declaration === true;

  const formats: Record<OutputExtension, 'esm' | 'cjs'> = {
    '.js': moduleType === 'module' ? 'esm' : 'cjs',
    '.mjs': 'esm',
    '.cjs': 'cjs',
  };
  const createLibs = (
    entries: Record<OutputExtension, string[]>,
    emitDeclarations: boolean,
  ) => {
    const libs = (Object.keys(entries) as OutputExtension[])
      .filter(extension => entries[extension].length > 0)
      .map(
        (extension): LibConfig => ({
          format: formats[extension],
          bundle: false,
          autoExtension: false,
          outBase: appDirectory,
          source: { entry: { index: entries[extension] } },
          output: { filename: { js: `[name]${extension}` } },
        }),
      );
    // TS-Go emits declarations for the whole program; one library runs it.
    if (emitDeclarations) {
      libs[0].redirect = { dts: { extension: moduleType === 'module' } };
      libs[0].dts = {
        bundle: false,
        distPath: distDir,
        tsgo: true,
        typescriptPath: getTsgoModulePath(appDirectory),
        // Emit-only diagnostics (such as TS2742) surface only here.
        abortOnError: failOnTypeError,
      };
    }
    return libs;
  };

  // Server code may import app sources outside the source directories (for
  // example `@/utils` from `src/`). Those files are emitted too, so the build
  // repeats until every reached app source is an entry.
  const alias = resolveAlias(appDirectory, config.alias);
  // Non-script files that emitted code imports, such as JSON next to a
  // reached source outside the source directories.
  const assets = new Set<string>();
  const build = async () => {
    if (sources.size === 0) {
      return;
    }
    const { createRslib } = await import('@rslib/core');
    const appPackage = await fs
      .readJSON(path.join(appDirectory, 'package.json'))
      .catch(() => undefined);
    const nodeEngine = appPackage?.engines?.node;
    const nodeRange =
      typeof nodeEngine === 'string' ? semver.validRange(nodeEngine) : null;
    const nodeVersion = nodeRange ? semver.minVersion(nodeRange) : null;
    const nodeTarget: Rspack.Configuration['target'] = nodeVersion?.major
      ? `node${nodeVersion.major}.${nodeVersion.minor}`
      : undefined;
    // The declaration program is the tsconfig, which the passes below never
    // change, so every pass would emit the same declarations. Only the first
    // one emits them.
    let emitDeclarations = declaration;
    for (;;) {
      const reached = new Set<string>();
      const rslib = await createRslib({
        cwd: appDirectory,
        config: {
          lib: createLibs(
            groupEntries(appDirectory, sources),
            emitDeclarations,
          ),
          source: {
            tsconfigPath: resolvedConfigPath,
            ...(compilerOptions.experimentalDecorators
              ? { decorators: { version: 'legacy' as const } }
              : {}),
          },
          resolve: { alias },
          output: {
            target: 'node',
            distPath: { root: distDir },
            cleanDistPath: false,
            sourceMap: config.sourceMap ?? { js: 'source-map' },
          },
          // Concurrent server compiles of one app would share the cache.
          performance: { buildCache: false },
          tools: {
            rspack: rspackConfig => {
              // Keep Rslib's engine-based syntax transforms, but describe the
              // Node runtime with Rspack's native target, not its browser database.
              if (nodeTarget) rspackConfig.target = nodeTarget;
              // Externals run in order; app imports must not reach Rslib's
              // redirect, which knows only one output extension per library.
              rspackConfig.externals = [
                importEmittedFile({
                  appDirectory,
                  distDir,
                  alias,
                  sources,
                  reached,
                  assets,
                }),
                ...[rspackConfig.externals ?? []].flat(),
              ];
            },
          },
        },
      });
      await rslib.build();
      emitDeclarations = false;
      if (reached.size === 0) {
        return;
      }
      for (const file of reached) {
        sources.add(file);
      }
    }
  };

  const typeCheck = async () => {
    // Declaration-only roots are still checked; an empty program is not.
    if (roots.size === 0) {
      return;
    }
    const result = await runTsgo(
      tsgoBinPath,
      ['-p', resolvedConfigPath, '--noEmit'],
      { cwd: appDirectory, reject: false },
    );
    if (result.code === 0) {
      return;
    }
    const diagnostics = result.stdout.trim() || result.stderr.trim();
    if (!failOnTypeError) {
      logger.warn(`TS-Go type check found errors:\n${diagnostics}`);
      return;
    }
    throw new Error(
      [`TS-Go type check failed with exit code ${result.code}.`, diagnostics]
        .filter(Boolean)
        .join('\n'),
    );
  };

  // Sources reached only through `source.alias` are invisible to TS-Go, so
  // the build runs first and the check adds every emitted TypeScript source
  // it did not already cover.
  const checkReachedSources = async () => {
    const reachedRoots = [...sources].filter(
      file =>
        !roots.has(path.resolve(file)) &&
        (compilerOptions.allowJs === true || TS_RE.test(file)),
    );
    if (reachedRoots.length === 0) {
      return typeCheck();
    }
    for (const file of reachedRoots) {
      roots.add(path.resolve(file));
    }
    tsconfig.files = [
      ...(tsconfig.files ?? []),
      ...reachedRoots.map(file => toPosix(path.relative(tsconfigDir, file))),
    ];
    await fs.writeFile(resolvedConfigPath, JSON.stringify(tsconfig, null, 2));
    return typeCheck();
  };

  let results: PromiseSettledResult<void>[];
  try {
    const built = await Promise.allSettled([build()]);
    // The type check's failure carries the diagnostics, so it is reported
    // before a declaration-emit failure for the same errors.
    results = [
      ...(await Promise.allSettled([checkReachedSources()])),
      ...built,
    ];
  } finally {
    await fs.remove(resolvedConfigPath);
  }
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason;
  }

  await copyAllAssets();
  for (const asset of assets) {
    await fs.copy(
      asset,
      path.join(distDir, path.relative(appDirectory, asset)),
    );
  }
  logger.info('Server sources compiled');
};
