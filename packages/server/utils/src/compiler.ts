import type { Dts, Redirect, RsbuildPlugin } from '@rslib/core';

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

type DtsOptions = Exclude<Dts, boolean>;

/** The server build's declaration settings for its one emitting library. */
export interface DeclarationPluginOptions {
  distPath: NonNullable<DtsOptions['distPath']>;
  /** Emit-only diagnostics (such as TS2742) surface only through this. */
  abortOnError: NonNullable<DtsOptions['abortOnError']>;
  redirect: NonNullable<Redirect['dts']>;
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
