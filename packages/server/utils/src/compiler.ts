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

/** Config parsing, checking and declarations must belong to one compiler. */
export interface ServerCompiler {
  command: {
    executable: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
  };
  readConfig: (tsconfigPath: string) => Promise<ServerCompilerConfig>;
  /** Rslib-compatible module exporting version, with adjacent getExePath.js. */
  typescriptPath: string;
  dispose?: () => Promise<void>;
}

export type ServerCompilerProvider = (
  appDirectory: string,
) => ServerCompiler | Promise<ServerCompiler>;
