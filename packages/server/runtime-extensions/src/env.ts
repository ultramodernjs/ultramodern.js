/**
 * Single typed pass over the statically-known environment variables consumed
 * by the ultramodern.js server runtime extensions (telemetry pipeline and
 * contract-gate canary autopilot).
 *
 * Modules in this package read this environment state through
 * `parseServerRuntimeExtensionsEnv()` so the surface is documented and
 * testable in one place, with one documented exception: the telemetry
 * runtime-fallback-signal auth config can name an arbitrary token variable
 * via `auth.expectedValueEnv`, which is necessarily read dynamically from
 * `process.env` when that config is normalized. See the package README for
 * per-variable docs.
 */

export const DEFAULT_ENVIRONMENT_NAME = 'development';

export interface ServerRuntimeExtensionsEnv {
  /**
   * `MODERN_ENV` — deployment environment name loaded by the Modern.js env
   * bootstrap (`.env.{MODERN_ENV}`). Undefined when unset or blank.
   */
  modernEnv?: string;
  /** `NODE_ENV` — standard Node.js environment name. Undefined when unset or blank. */
  nodeEnv?: string;
  /**
   * Effective telemetry environment label:
   * `MODERN_ENV` || `NODE_ENV` || `"development"`.
   */
  environmentName: string;
  /**
   * `MODERN_CONTRACT_GATES_FILE` — path of the contract-gate snapshot file
   * (absolute, or relative to the app directory). Undefined when unset.
   */
  contractGatesFile?: string;
  /**
   * `MODERN_SERVER_RENDER_RESOURCES` — `lazy` defers production server bundle
   * imports to the first render request; anything else keeps eager warmup.
   */
  renderResources: 'eager' | 'lazy';
  /**
   * Production with `MODERN_SERVER_IMMUTABLE_ASSETS=true`: release files never
   * change while serving, so found files and the federation inventory are kept.
   */
  immutableAssets: boolean;
  /**
   * False only in production with `MODERN_SERVER_PRECOMPRESSED_ASSETS=false`:
   * no `.br`/`.gz` variants are probed or served.
   */
  precompressedAssets: boolean;
}

const readString = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Parse the statically-known environment variables consumed by this package
 * in one typed, documented pass. Defaults are applied here so consumers never
 * touch `process.env` directly (except the documented `expectedValueEnv`
 * indirection above).
 */
export const parseServerRuntimeExtensionsEnv = (
  env: Record<string, string | undefined> = process.env,
): ServerRuntimeExtensionsEnv => {
  const modernEnv = readString(env.MODERN_ENV);
  const nodeEnv = readString(env.NODE_ENV);
  const production = nodeEnv === 'production';

  return {
    modernEnv,
    nodeEnv,
    environmentName: modernEnv || nodeEnv || DEFAULT_ENVIRONMENT_NAME,
    contractGatesFile: readString(env.MODERN_CONTRACT_GATES_FILE),
    renderResources:
      readString(env.MODERN_SERVER_RENDER_RESOURCES) === 'lazy'
        ? 'lazy'
        : 'eager',
    immutableAssets:
      production && readString(env.MODERN_SERVER_IMMUTABLE_ASSETS) === 'true',
    precompressedAssets:
      !production ||
      readString(env.MODERN_SERVER_PRECOMPRESSED_ASSETS) !== 'false',
  };
};
