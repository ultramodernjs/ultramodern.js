export type { ResolveEffectTsgoCompilerOptions } from './build-config/public';
export {
  getBuildConfigEnvironment,
  resolveEffectTsgoCompiler,
} from './build-config/public';
export { createRemoteManifestUrl } from './build-config/remote-address';
export type { DeployTarget } from './deploy-output/target';
export { resolveDeployTarget } from './deploy-output/target';

export type CloudflareWorkerSecurityCspMode = 'enforce' | 'report-only' | 'off';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CloudflareWorkerArtifactConfig {
  /**
   * Source file or directory, relative to the app root, to copy into
   * `.output` after framework output has been staged.
   */
  from: string;
  /**
   * Destination path relative to `.output`.
   */
  to: string;
}

export interface CloudflareWorkerPublicAssetConfig {
  /**
   * Source file or directory, relative to the app root, to copy into
   * Cloudflare Worker Static Assets.
   */
  from: string;
  /**
   * Destination path relative to `.output/public`.
   */
  to: string;
}

export interface NodePublicAssetConfig {
  /**
   * Source file or directory, relative to the app root, to copy into the
   * Node deploy output's public directory.
   */
  from: string;
  /**
   * Destination path relative to `.output/public`.
   */
  to: string;
}

export interface CloudflareWorkerD1DatabaseConfig {
  /**
   * Worker binding name, for example `DB`.
   */
  binding: string;
  /**
   * Cloudflare D1 database name.
   */
  databaseName: string;
  /**
   * Cloudflare D1 database id.
   */
  databaseId: string;
  /**
   * Optional local migrations directory, relative to the app root. When set,
   * Modern.js stages it into `.output` and points Wrangler at the staged copy.
   */
  migrationsDir?: string;
  /**
   * Optional preview database id used by Wrangler preview/local flows.
   */
  previewDatabaseId?: string;
  /**
   * Wrangler remote flag for D1 commands.
   */
  remote?: boolean;
}

export interface CloudflareWorkerServiceBindingConfig {
  /** Worker binding name exposed on the module worker `env` object. */
  binding: string;
  /** Target Cloudflare Worker service name. */
  service: string;
  /**
   * Optional application path prefix that Modern.js should dispatch to this
   * service binding with `env[binding].fetch(request)`.
   */
  prefix?: string;
  /**
   * Server-rendered Module Federation fragments exposed by this Worker.
   * These fields are written to the Modern.js worker manifest, but stripped
   * from Wrangler's `services` entries.
   */
  fragments?: CloudflareWorkerServiceBindingFragmentConfig[];
}

export interface CloudflareWorkerVpcServiceConfig {
  /** Worker binding name exposed on the module worker `env` object. */
  binding: string;
  /** Workers VPC service id (`wrangler vpc service create`). */
  serviceId: string;
  /**
   * Optional application path prefix that Modern.js should dispatch to this
   * private origin with `env[binding].fetch(request)`, exactly like a
   * prefixed Worker service binding.
   */
  prefix?: string;
}

export interface CloudflareWorkerServiceBindingFragmentConfig {
  /** Stable remote id used by the shell's composition contract. */
  remote: string;
  /** Module Federation expose rendered by the fragment route. */
  expose: string;
  /** Expected boundary marker in the rendered fragment HTML. */
  boundaryId: string;
  /**
   * Route path on the bound Worker. `{locale}` is replaced with the first
   * locale segment from the incoming shell request.
   */
  path: string;
}

export interface CloudflareWorkerSecurityCspConfig {
  mode?: CloudflareWorkerSecurityCspMode;
  directives?: Record<string, string[] | string | false>;
  additionalScriptSrc?: string[];
  additionalStyleSrc?: string[];
  additionalConnectSrc?: string[];
  additionalImgSrc?: string[];
  frameAncestors?: string[] | false;
  reportUri?: string;
  reason?: string;
}

export interface CloudflareWorkerSecurityNoindexConfig {
  workersDev?: boolean;
  localhost?: boolean;
  previewHostnames?: string[];
  reason?: string;
}

export interface CloudflareWorkerSecurityCorsConfig {
  /**
   * Origins allowed to read application responses (BFF APIs, SSR HTML,
   * route fallbacks) cross-origin. Accepts exact origins
   * (e.g. `https://shell.example.com`) or `'*'`.
   * When empty, application responses carry no CORS headers (same-origin).
   * @default []
   */
  allowedOrigins?: string[];
  /**
   * Methods advertised on CORS preflight responses for application routes.
   * @default ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
   */
  allowedMethods?: string[];
  /**
   * Headers advertised on CORS preflight responses for application routes.
   * @default ['*']
   */
  allowedHeaders?: string[];
  /**
   * Apply wildcard CORS to static asset responses so federated remotes
   * (remote entries, manifests, CSS) can be loaded cross-origin.
   * @default true
   */
  assets?: boolean;
  reason?: string;
}

export interface CloudflareWorkerSecurityConfig {
  /**
   * Disable all Cloudflare worker security defaults for this app.
   * Prefer narrower escape hatches when possible.
   */
  enabled?: boolean;
  headers?: {
    referrerPolicy?: string | false;
    contentTypeOptions?: 'nosniff' | false;
    permissionsPolicy?: string | false;
  };
  contentSecurityPolicy?: CloudflareWorkerSecurityCspConfig;
  noindex?: boolean | CloudflareWorkerSecurityNoindexConfig;
  /**
   * Cross-origin resource sharing policy applied by the generated worker.
   * Asset responses default to wildcard CORS for federated loading;
   * application responses (BFF, SSR) default to no CORS headers.
   */
  cors?: CloudflareWorkerSecurityCorsConfig;
  /**
   * @deprecated Write-only: this option never had any runtime effect — the
   * generated worker never mutates application `Set-Cookie` headers.
   * Kept temporarily so configs emitted by existing `modern create`
   * templates keep typechecking; will be removed once the generator stops
   * emitting it. Use {@link CloudflareWorkerSecurityConfig.cors} for the
   * worker's cross-origin policy.
   */
  cookies?: {
    mutateSetCookie?: false;
    reason?: string;
  };
  reason?: string;
}

export interface CloudflareWorkerDeployConfig {
  name?: string;
  /**
   * Cloudflare Workers compatibility date for generated wrangler config.
   * Use YYYY-MM-DD. Defaults to the date validated against the bundled
   * Wrangler version used by UltraModern generated workspaces.
   */
  compatibilityDate?: string;
  ssr?: boolean;
  security?: CloudflareWorkerSecurityConfig;
  /**
   * Raw Wrangler-compatible config merged into `.output/wrangler.json`.
   * Framework-owned worker invariants still win for `main`, the assets
   * binding/directory/run mode, and required compatibility flags.
   */
  wrangler?: Record<string, JsonValue>;
  /**
   * Additional app-root files or directories to stage under `.output`.
   * Use this for provider resources such as migrations or generated config.
   */
  artifacts?: CloudflareWorkerArtifactConfig[];
  /**
   * Additional app-root files or directories to serve as Cloudflare Worker
   * Static Assets under `.output/public`. Use `to: '.'` to copy a
   * source directory's contents into the public asset root.
   */
  publicAssets?: CloudflareWorkerPublicAssetConfig[];
  /**
   * First-class Cloudflare D1 bindings. Modern.js writes these to
   * `wrangler.json` as `d1_databases` and stages configured migration
   * directories into `.output`.
   */
  d1Databases?: CloudflareWorkerD1DatabaseConfig[];
  /**
   * First-class Cloudflare service bindings. Modern.js writes these to
   * `wrangler.json` as `services`; when a binding also has `prefix`,
   * the generated Worker dispatches matching requests through
   * `env[binding].fetch(request)`.
   */
  services?: CloudflareWorkerServiceBindingConfig[];
  /** Native Worker context profiles, registered before federated exposes load. */
  federation?: {
    contextProfiles?: readonly string[];
  };
  /**
   * First-class Workers VPC service bindings to private origins reached
   * through a Cloudflare Tunnel. Modern.js writes these to `wrangler.json`
   * as `vpc_services`; a binding with `prefix` joins the prefix dispatch of
   * `services`.
   */
  vpcServices?: CloudflareWorkerVpcServiceConfig[];
  /**
   * Dist output paths that must not be copied into Cloudflare public assets.
   * Entries are slash-normalized path prefixes relative to the app dist root.
   * Top-level `api` and `shared` dist directories are excluded when matching
   * source directories exist in the app root because they conventionally
   * contain server-only implementation code.
   */
  publicAssetExcludes?: string[];
}

export interface CloudflareDeployConfig {
  /** Release surface owned by this application, independent of federation production. */
  releaseEnvelopeRole?: 'microvertical' | 'shell';
  worker?: CloudflareWorkerDeployConfig;
}

export interface NodeDeployConfig {
  node?: {
    /**
     * Additional app-root files or directories to stage under
     * `.output/public` when `modern deploy` targets Node, the counterpart of
     * `deploy.worker.publicAssets`. The Node server does not route these
     * files; serve them from the app, for example from an API handler.
     * Release envelopes record them as declared public assets, so API-only
     * units may ship them.
     */
    publicAssets?: NodePublicAssetConfig[];
  };
}
