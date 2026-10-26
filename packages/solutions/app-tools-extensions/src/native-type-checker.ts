import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { refreshTsgoCheckerConfig } from '@modern-js/builder';
import type { Rspack, RspackChain } from '@rsbuild/core';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { resolveEffectTsgoCompiler } from './build-config/build-environment';

const execute = promisify(execFile);
const name = 'UltramodernNativeTypeChecker';

export interface NativeTypeCheckerCommand {
  executable: string;
  args: readonly string[];
  /** The selected package's native config API. tsrs has no --showConfig CLI. */
  configApi?: string;
}

/** Resolve the Effect-enabled native compiler from the application's origin. */
export function resolveNativeTypeCheckerCommand(
  from: string,
): NativeTypeCheckerCommand {
  const executable = resolveEffectTsgoCompiler({ from });
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TSRS_CHECKER_ASSIGNMENT: process.env.TSRS_CHECKER_ASSIGNMENT || 'go',
    },
    timeout: 10_000,
  });
  if (version.includes('(tsrs ')) {
    return {
      executable,
      args: [],
      configApi: createRequire(from).resolve('tsrs/sync'),
    };
  }
  // TypeScript-Go supports --showConfig, including project references. Its
  // older native config API lacks tsrs's diagnostics and reference fields.
  return {
    executable,
    args: [],
  };
}

// Use the real native parser, not a handwritten tsconfig/extends interpreter.
// Running the client in a child also applies assignment to its native API
// process without changing the build/dev server's environment.
const inspectNativeConfig = `
  import { pathToFileURL } from 'node:url';
  const [modulePath, compiler, configFile] = process.argv.slice(1);
  const { API, formatDiagnostics } = await import(pathToFileURL(modulePath).href);
  const api = new API({ tsserverPath: compiler });
  try {
    const config = api.parseConfigFile(configFile);
    if (config.errors.length) {
      process.stdout.write(formatDiagnostics(config.errors, api));
      process.exitCode = 1;
    } else {
      process.stdout.write(JSON.stringify({
        compilerOptions: config.options,
        files: config.fileNames,
        references: config.projectReferences,
      }));
    }
  } finally {
    api.close();
  }
`;

interface TypeCheckerConfig {
  compilerOptions?: Record<string, unknown>;
  references?: Array<{ path: string }>;
  [key: string]: unknown;
}

// Windows file events expand 8.3 aliases; register the same native path spelling.
// A path that does not exist yet (a project tsconfig mid-edit) cannot be
// realpathed; it is registered as spelled so its return still triggers a build.
const watchDependencyPath = (file: string): string => {
  if (process.platform !== 'win32') return file;
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
};

/**
 * TS2875 means JSX compiles against a jsxImportSource whose runtime is not
 * installed: usually components still authored for a previous renderer.
 */
export function missingJsxRuntimeHint(diagnostics: string): string {
  const source =
    /error TS2875: This JSX tag requires the module path '(.+?)\/jsx-(?:dev-)?runtime'/u.exec(
      diagnostics,
    )?.[1];
  if (!source) return '';
  return `\nHint: JSX compiles against jsxImportSource '${source}', the selected renderer's runtime, but '${source}/jsx-runtime' cannot be resolved from this app. If you changed \`renderer\` in modern.config, install that renderer's packages and port components authored for the previous renderer, or switch \`renderer\` back.\n`;
}

export class UltramodernNativeTypeChecker {
  constructor(
    private readonly options: {
      compiler: () => string | NativeTypeCheckerCommand;
      configFile: string;
      build: boolean;
      configOverwrite?: TypeCheckerConfig;
    },
  ) {}

  async check(): Promise<void> {
    const configFile = await this.projectConfigFile();
    try {
      await this.checkProject(configFile);
    } finally {
      this.removeProjection(configFile);
    }
  }

  private async projectConfigFile(): Promise<string> {
    const { configFile, configOverwrite } = this.options;
    if (!configOverwrite) return configFile;
    // Merge before native parsing: an overwrite may supply the inputs that
    // make an otherwise empty project valid. A same-directory projection
    // preserves the original extends, relative paths and project references.
    const errors: ParseError[] = [];
    const source = readFileSync(configFile, 'utf8');
    const project: TypeCheckerConfig = parse(
      source.charCodeAt(0) === 0xfeff ? source.slice(1) : source,
      errors,
      { allowTrailingComma: true },
    );
    if (errors.length) {
      throw new Error(
        `${name} requires valid JSONC in ${configFile}: ${errors
          .map(
            error => `${printParseErrorCode(error.error)} at ${error.offset}`,
          )
          .join(', ')}`,
      );
    }
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new Error(`${name} requires a JSONC object in ${configFile}.`);
    }
    const projectedConfig: TypeCheckerConfig = {
      ...project,
      ...configOverwrite,
      compilerOptions: {
        ...project.compilerOptions,
        ...configOverwrite.compilerOptions,
      },
    };
    const projected = path.join(
      path.dirname(configFile),
      `.ultramodern-native-checker.${randomUUID()}.json`,
    );
    writeFileSync(projected, `${JSON.stringify(projectedConfig, null, 2)}\n`, {
      flag: 'wx',
    });
    try {
      const resolved: TypeCheckerConfig = JSON.parse(
        await this.run(['--showConfig', '--project', projected]),
      );
      const options = resolved.compilerOptions ?? {};
      if (
        (this.options.build ||
          options.incremental === true ||
          options.composite === true) &&
        !options.tsBuildInfoFile
      ) {
        // Native TypeScript derives the default from the config filename.
        // Retain that original identity while this invocation-private config
        // is alive; referenced projects still use their own configurations.
        const original = configFile.slice(
          0,
          configFile.length - path.extname(configFile).length,
        );
        let buildInfo = original;
        if (typeof options.outDir === 'string') {
          const outDir = path.resolve(path.dirname(configFile), options.outDir);
          buildInfo =
            typeof options.rootDir === 'string'
              ? path.resolve(
                  outDir,
                  path.relative(
                    path.resolve(path.dirname(configFile), options.rootDir),
                    original,
                  ),
                )
              : path.join(outDir, path.basename(original));
        }
        projectedConfig.compilerOptions = {
          ...projectedConfig.compilerOptions,
          tsBuildInfoFile: `${buildInfo}.tsbuildinfo`,
        };
        writeFileSync(
          projected,
          `${JSON.stringify(projectedConfig, null, 2)}\n`,
        );
      }
      return projected;
    } catch (error) {
      unlinkSync(projected);
      throw error;
    }
  }

  private removeProjection(configFile: string): void {
    if (configFile !== this.options.configFile) unlinkSync(configFile);
  }

  private async checkProject(configFile: string): Promise<void> {
    const { build } = this.options;
    if (!build) {
      const config = JSON.parse(
        await this.run(['--showConfig', '--project', configFile]),
      ) as { references?: { path: string }[] };
      // Project mode consumes referenced declarations but never builds them.
      // Prepare only the references using their own emit contracts, then keep
      // the app itself in no-emit mode. This also refreshes stale declarations.
      if (config.references?.length) {
        await this.run([
          '--build',
          ...config.references.map(reference =>
            path.resolve(path.dirname(configFile), reference.path),
          ),
          '--stopBuildOnErrors',
          '--pretty',
          'false',
        ]);
      }
    }
    const args = build
      ? ['--build', configFile, '--stopBuildOnErrors']
      : ['--project', configFile, '--noEmit'];
    await this.run([...args, '--pretty', 'false']);
  }

  private async run(args: string[]): Promise<string> {
    try {
      const selected = this.options.compiler();
      const command: NativeTypeCheckerCommand =
        typeof selected === 'string'
          ? { executable: selected, args: [] }
          : selected;
      const inspect = args[0] === '--showConfig' && command.configApi;
      const result = await execute(
        inspect ? process.execPath : command.executable,
        inspect
          ? [
              '--input-type=module',
              '--eval',
              inspectNativeConfig,
              command.configApi!,
              command.executable,
              args[args.indexOf('--project') + 1],
            ]
          : [...command.args, ...args],
        {
          cwd: path.dirname(this.options.configFile),
          // Apply to every command, including explicit paths and TSRS_BINARY.
          // Keep caller selection; do not change the dev server's environment.
          env: {
            ...process.env,
            TSRS_CHECKER_ASSIGNMENT:
              process.env.TSRS_CHECKER_ASSIGNMENT || 'go',
          },
          maxBuffer: 16 * 1024 * 1024,
          ...(inspect ? { timeout: 10_000 } : {}),
        },
      );
      return result.stdout;
    } catch (cause) {
      const output = cause as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        signal?: NodeJS.Signals;
      };
      const diagnostics = `${output.stdout ?? ''}${output.stderr ?? ''}`;
      throw Object.assign(
        new Error(
          `${name} failed:\n${diagnostics || (cause instanceof Error ? cause.message : String(cause))}${missingJsxRuntimeHint(diagnostics)}`,
          { cause },
        ),
        { code: output.code, signal: output.signal },
      );
    }
  }

  private async watchInputs(configFile: string): Promise<{
    inputs: Set<string>;
    missing: Set<string>;
  }> {
    const inputs = new Set<string>();
    const missing = new Set<string>();
    const projects = [configFile];
    const visited = new Set<string>();
    for (const configFile of projects) {
      if (visited.has(configFile)) continue;
      visited.add(configFile);
      // Registered before it is parsed: a referenced config that is absent or
      // unparsable right now must still be watched, or creating or repairing
      // it never re-triggers the compilation. `check()` reports the error.
      if (configFile === this.options.configFile || configFile !== projects[0])
        inputs.add(configFile);
      if (!existsSync(configFile)) {
        missing.add(configFile);
        continue;
      }
      let config: { files?: string[]; references?: { path: string }[] };
      try {
        config = JSON.parse(
          await this.run(['--showConfig', '--project', configFile]),
        );
      } catch {
        continue;
      }
      const directory = path.dirname(configFile);
      for (const file of config.files ?? [])
        inputs.add(path.resolve(directory, file));
      for (const reference of config.references ?? []) {
        const target = path.resolve(directory, reference.path);
        projects.push(
          path.extname(target) === '.json'
            ? target
            : path.join(target, 'tsconfig.json'),
        );
      }
    }
    return { inputs, missing };
  }

  apply(compiler: Rspack.Compiler): void {
    compiler.hooks.thisCompilation.tap(name, compilation => {
      compilation.hooks.processAssets.tapPromise(name, async () => {
        try {
          compilation.fileDependencies.add(
            watchDependencyPath(this.options.configFile),
          );
          // A generated checker config restates values TypeScript does not
          // inherit through `extends` (project references above all). Rebuild
          // it from the project's own tsconfig before every check, and watch
          // that tsconfig, so an edit during `modern dev` reaches the next
          // compilation instead of the next restart.
          const projectConfigFile = refreshTsgoCheckerConfig(
            this.options.configFile,
          );
          if (projectConfigFile) {
            const watched = watchDependencyPath(projectConfigFile);
            compilation.fileDependencies.add(watched);
            // Absent mid-edit: a missing dependency makes its (re)appearance
            // a rebuild trigger, so the dev server recovers on its own.
            if (!existsSync(projectConfigFile)) {
              compilation.missingDependencies.add(watched);
            }
          }
          const configFile = await this.projectConfigFile();
          try {
            const { inputs, missing } = await this.watchInputs(configFile);
            for (const file of inputs)
              compilation.fileDependencies.add(watchDependencyPath(file));
            for (const file of missing)
              compilation.missingDependencies.add(watchDependencyPath(file));
            await this.checkProject(configFile);
          } finally {
            this.removeProjection(configFile);
          }
        } catch (cause) {
          compilation.errors.push(
            cause instanceof Error ? cause : new Error(String(cause)),
          );
        }
      });
    });
  }
}

/** Preserve project-reference emit contracts in the selected native compiler. */
export function configureUltramodernTypeChecker(
  chain: RspackChain,
  pluginId: string,
  resolveCompiler: (configFile: string) => string | NativeTypeCheckerCommand,
): void {
  if (!chain.plugins.has(pluginId)) return;
  const options = chain.plugin(pluginId).get('args')?.[0] as
    | {
        typescript?: {
          configFile?: string;
          build?: boolean;
          tsgo?: boolean;
          configOverwrite?: TypeCheckerConfig;
        };
      }
    | undefined;
  const typescript = options?.typescript;
  if (typescript?.tsgo === false) return;
  if (!typescript?.configFile) {
    throw new Error(`${name} requires the configured TypeScript project.`);
  }
  const configFile = path.resolve(typescript.configFile);
  chain.plugin(pluginId).use(UltramodernNativeTypeChecker, [
    {
      build: typescript.build === true,
      compiler: () => resolveCompiler(configFile),
      configFile,
      configOverwrite: typescript.configOverwrite,
    },
  ]);
}
