import type { mergeAlias } from '@modern-js/utils/alias';
import type { OutputConfig, RsbuildPlugin } from '@rsbuild/core';
import type { PluginDtsOptions } from 'rsbuild-plugin-dts';

/** A parsed JSON tsconfig, with paths based at its owning config file. */
export interface ServerCompilerConfig {
  extends?: string;
  compilerOptions?: {
    allowJs?: boolean;
    baseUrl?: string | null;
    composite?: boolean;
    declaration?: boolean;
    declarationMap?: boolean;
    emitDeclarationOnly?: boolean;
    experimentalDecorators?: boolean;
    incremental?: boolean;
    jsx?: string;
    moduleResolution?: string | null;
    noEmit?: boolean;
    noEmitOnError?: boolean;
    outDir?: string | null;
    paths?: Record<string, string[]>;
    rootDir?: string;
    tsBuildInfoFile?: string | null;
    [option: string]: unknown;
  };
  files?: string[];
  include?: string[];
  references?: Array<{ path: string }>;
}

/** The server build's declaration settings for its one emitting library. */
export interface DeclarationPluginOptions {
  /**
   * A directory private to this compilation. The compiler moves what the
   * plugin writes here into the server output and reports each file.
   */
  distPath: NonNullable<PluginDtsOptions['distPath']>;
  /** Emit-only diagnostics (such as TS2742) surface only through this. */
  abortOnError: NonNullable<PluginDtsOptions['abortOnError']>;
  redirect: NonNullable<PluginDtsOptions['redirect']>;
}

/** Config parsing, checking and declarations must belong to one compiler. */
export interface ServerCompiler {
  command: {
    executable: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
  };
  readConfig: (tsconfigPath: string) => Promise<ServerCompilerConfig>;
  /**
   * The bundleless Rsbuild declaration plugin bound to this compiler. It is
   * the only declaration emitter: the library it joins leaves `dts` unset.
   */
  declarationPlugin: (
    options: DeclarationPluginOptions,
  ) => RsbuildPlugin | Promise<RsbuildPlugin>;
  dispose?: () => Promise<void>;
}

export type ServerCompilerProvider = (
  appDirectory: string,
) => ServerCompiler | Promise<ServerCompiler>;

export interface ServerCompileConfig {
  alias?: Parameters<typeof mergeAlias>[0];
  sourceMap?: OutputConfig['sourceMap'];
  /**
   * `output.disableTsChecker`: skip the server type check. Declarations are
   * still emitted, from the same program without checking it (`noCheck`);
   * the app owns type checking elsewhere.
   */
  disableTsChecker?: boolean;
}

export interface ServerCompileOptions {
  /** Omit to use the stable TypeScript 7.0.2 compiler this package ships. */
  compiler?: ServerCompilerProvider;
  sourceDirs: string[];
  distDir: string;
  /** Absolute files excluded as roots; imported dependencies remain checked. */
  excludeFiles?: string[];
  tsconfigPath?: string;
  moduleType?: 'module' | 'commonjs';
  throwErrorInsteadOfExit?: boolean;
}

/** What one server compilation actually wrote, as absolute paths. */
export interface ServerCompilationResult {
  /** The emitted JavaScript of the source-directory roots, not what they reach. */
  readonly rootFiles: readonly string[];
  /** Every file written into `distDir`: JavaScript, maps, declarations, assets. */
  readonly emittedFiles: readonly string[];
}
