---
'@modern-js/ultramodern-create': minor
'@modern-js/ultramodern-app-tools': minor
'@modern-js/app-tools': patch
'@modern-js/app-tools-extensions': patch
'@modern-js/builder': patch
'@modern-js/runtime': patch
'@modern-js/render': patch
'@modern-js/plugin-tanstack': patch
'@modern-js/server-core': patch
'@modern-js/server': patch
'@modern-js/server-runtime-extensions': patch
'@modern-js/bff-core': patch
'@modern-js/plugin-data-loader': patch
'@modern-js/plugin-i18n': patch
'@modern-js/mcp-apps': patch
---

Integrate Modern.js 3.11.3 and subsequent upstream fixes while preserving
UltraModern's native compiler, renderer, worker, and federation contracts.
Add upstream MCP Apps support with the accepted federation sidecars.
Improve static caching, plugin loading, streamed rendering, action redirects,
and i18n initialization without replacing stronger fork behavior.
Preserve explicit worker externals, native server reloads, application RSC
manifests, and both HTTP and native TanStack redirect contracts.
