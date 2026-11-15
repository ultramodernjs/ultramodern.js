export type OwnedEffectTarget =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'win32-x64';

export interface OwnedEffectSource {
  schemaVersion: 1;
  distribution: 'ultramodern-effect-tsrs';
  effect: { baseVersion: string; baseCommit: string };
  tsrs: { version: string; sourceCommit: string };
  typescript: { version: string; sourceCommit: string };
  patchSha256: string;
  optimization: 'none';
  targets: OwnedEffectTarget[];
}

export interface OwnedEffectManifest {
  schemaVersion: 1;
  source: OwnedEffectSource;
  producer: {
    repository: 'ultramodernjs/ultramodern.js';
    workflow: 'effect-compiler-payload.yml';
    runId: string;
    runAttempt: string;
    sourceCommit: string;
  };
  targets: Partial<
    Record<
      OwnedEffectTarget,
      {
        executable: string;
        files: {
          path: string;
          size: number;
          sha256: string;
          executable: boolean;
        }[];
      }
    >
  >;
}

export type OwnedEffectCompiler =
  | { kind: 'absent' }
  | {
      kind: 'owned';
      executable: string;
      artifactSha256: string;
      manifestSha256: string;
      typescriptVersion: string;
      typescriptCommit: string;
      effectVersion: string;
      tsrsVersion: string;
      target: OwnedEffectTarget;
      distribution: 'ultramodern-effect-tsrs';
    };

/** Selection verifies files and installed identities; it never runs the compiler. */
export function resolveOwnedEffectCompiler(options: {
  /** Absolute filename, directory, or file URL used to resolve installed packages. */
  from: string | URL;
  configuredExecutable?: string;
}): OwnedEffectCompiler;

/** Present but malformed payloads throw, including on unsupported platforms. */
export function validateOwnedEffectPayload(options?: {
  requireComplete?: boolean;
  /** Stage directory to validate; source expectations still belong to this package. */
  payloadRoot?: string;
}):
  | { kind: 'absent' }
  | { kind: 'owned'; manifest: OwnedEffectManifest; manifestSha256: string };
