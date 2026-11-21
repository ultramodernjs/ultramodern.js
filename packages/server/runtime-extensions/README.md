# @modern-js/server-runtime-extensions

Fork-owned ultramodern.js server runtime extensions. This package hosts the
server-side fork features that previously lived inside the upstream-owned
`@modern-js/server-core` sources, so the fork diff against upstream Modern.js
stays small:

- **Telemetry pipeline** — `TelemetryRegistry`, OTLP / VictoriaMetrics
  exporters, SLO alerts, telemetry-aware metrics wrapping and the
  `injectTelemetryPlugin()` server plugin (runtime status + runtime fallback
  signal endpoints).
- **Contract-gate health observation** — `TelemetryHealthMonitor`,
  `ContractGateSnapshotObserver` and the file/HTTP contract-gate snapshot stores.
- **Module federation runtime helpers** — remote CSS collection for SSR
  (`collectDirectRemoteModuleFederationCss`, `injectModuleFederationCssPlugin()`)
  and MF asset cache-header policies (`resolveMfAssetCacheHeaders`,
  `injectMfAssetCacheHeadersPlugin()`). Remote entries configure the canonical
  final manifest URL: the native fetch rejects redirects (`redirect: 'error'`),
  and a trusted injected `fetcher` must honor that same option.

## Registration

None of these plugins are part of the bare `@modern-js/server-core` default
plugin chain. `@modern-js/prod-server` registers them in its plugin assembly
(`applyPlugins`), which is also the assembly used by the dev server
(`@modern-js/server` via `@modern-js/app-tools`), so production and dev behave
identically:

- `injectTelemetryPlugin()` — no-op unless `server.telemetry` is configured.
  The runtime-fallback-signal endpoint is opt-in
  (`health.snapshotObservation.runtimeFallbackSignal.enabled: true`) and requires an
  auth token (`auth.expectedValue` / `auth.expectedValueEnv`); the
  `/_modern/runtime/status` endpoint returns a bare health probe unless the
  caller authenticates with that token.
- `injectModuleFederationCssPlugin()` — no-op unless the dist directory
  contains an `mf-manifest.json` host manifest. Must be registered after
  `injectResourcePlugin()` so the request-scoped server manifest exists. In
  production the remote CSS collection is cached with a 30s TTL (configurable
  via the plugin's `remoteCssCacheTtlMs` option) instead of being pinned at
  boot.
- `injectMfAssetCacheHeadersPlugin()` — applies the ADR-0002 MF cache-header
  policy to `mf-manifest.json`/`mf-stats.json` (`no-store`) and
  `remoteEntry*.js` (revalidate, or `immutable` when version-pinned via
  `?mfv=`) responses served by the static middleware.

## Environment variables

The environment variables consumed by this package at runtime are parsed in a
single typed pass by `parseServerRuntimeExtensionsEnv()` in `src/env.ts`:

| Variable | Default | Description |
| --- | --- | --- |
| `MODERN_ENV` | _unset_ | Deployment environment name (also drives `.env.{MODERN_ENV}` loading in the server bootstrap). First candidate for the telemetry `environment` label. |
| `NODE_ENV` | _unset_ | Standard Node.js environment name. Second candidate for the telemetry `environment` label; the final fallback is `development`. |
| `MODERN_CONTRACT_GATES_FILE` | `.modern/contract-gates.json` (resolved against the app directory) | Path of the contract-gate snapshot file used by the health observer and the runtime fallback signal endpoint when `server.telemetry.health.snapshotObservation.gateSnapshotPath` is not configured. |
| `MODERN_SERVER_RENDER_RESOURCES` | `eager` | In production, `lazy` defers render bundles and templates until the first page request and shares that load across concurrent requests. API and static requests do not load render resources. |
| `MODERN_SERVER_IMMUTABLE_ASSETS` | `false` | In production, `true` caches metadata for up to 8192 found static files per server and retains its federation asset inventory. Use only when release files do not change while the server runs. Missing files are not cached. |
| `MODERN_SERVER_PRECOMPRESSED_ASSETS` | `true` | In production, `false` disables `.br` and `.gz` file probes and serves identity responses. Requests that reject identity still receive 406. |

The Node-only `@modern-js/server-runtime-extensions/render-resources` entry
exports `renderBundleLoadChannel` and `serverRequestChannel` from
`node:diagnostics_channel`. The first publishes bundle paths, load durations,
outcomes, and triggering request paths. The second traces request start and
completion. Subscribers must handle their own errors; Node reports subscriber
exceptions as uncaught exceptions.

Exporter endpoints and the module federation remote manifest timeout are
configured through `server.telemetry.exporters.*.endpoint` and plugin options
only; their defaults (`http://127.0.0.1:4318/v1/logs`,
`http://127.0.0.1:8428/api/v1/import/prometheus`, `1500`ms) are hard-coded,
matching the pre-extraction server-core behavior.
`MODERN_TELEMETRY_OTLP_ENDPOINT` / `MODERN_TELEMETRY_VICTORIA_ENDPOINT` are
read only at config time by `@modern-js/app-tools` (`baseline.ts`), not at
server runtime.

One dynamic indirection cannot be statically parsed:
`server.telemetry.health.snapshotObservation.runtimeFallbackSignal.auth.expectedValueEnv`
names an arbitrary environment variable that holds the expected runtime-signal
auth token; it is read when the auth config is normalized.
