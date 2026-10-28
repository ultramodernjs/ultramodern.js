# UltraModern.js application tools

Select the application renderer in `modern.config.ts`. `defineConfig` registers
the selected compiler, runtime, router integration and server lifecycle.

```ts
import { defineConfig } from '@modern-js/ultramodern-app-tools';

export default defineConfig({
  renderer: 'solid', // 'react' or 'octane'; omitted means 'react'
  server: { ssr: true },
});
```

Use Node **26.10.0 or newer**. Run the installed application's public CLI:

```sh
pnpm exec ultramodern dev
pnpm exec ultramodern build
pnpm exec ultramodern serve
```

The selector belongs to this config import. Do not add another `appTools()` or
`ultramodernAppTools()` base plugin. Changing the renderer requires matching
native application source and dependencies, then a dev-server restart and a
document reload. The generated entries own mounting and hydration.

## Default React runtime

React applications use the framework's exact `@tanstack/redact@0.2.1` runtime
by default, on the client, Node SSR and Cloudflare workerd SSR. Keep authoring
normal React 19 imports; no application dependency or template edits enable it.
The framework owns Redact, `rsbuild-redact-plugin@0.1.0`, and a React 19 copy for
the public plugin's version check under pnpm's strict dependency isolation.
CSR uses that public plugin; SSR uses a fork-owned integration with the same
exact aliases, including canonical Redact imports, in every environment.
Custom Document compilers inherit these aliases instead of forcing real React
externals; the native compiler respects explicit runtime aliases.

```ts
export default defineConfig({
  // Omit for Redact with view transitions disabled.
  redact: { viewTransitions: true },
  server: { ssr: true },
});
```

Set `redact: false` to use real React throughout the application. Invalid values
fail configuration validation. **RSC applications always use real React**, on
both server and client: Flight requires React internals Redact does not provide.
The CLI logs this limitation once rather than mixing runtimes.

Enabled builds require the reviewed pnpm patch whose first line in Redact's
`dist/server/stream.js` is `// ultramodern-redact-patch: v1`. Missing patches
fail the build with installation guidance and the `redact: false` escape hatch;
there is no configuration bypass. The patch fixes streamed Suspense IDs,
post-hydration IDs, namespace-sensitive segments and deferred reveal ordering.

Federated hosts and remotes must choose the same runtime. Their existing
renderer manifest contract publishes the effective runtime and hydration
identity (Redact `0.2.1`, or actual React for opt-out/RSC), and rejects mismatches
before remote initialization. Shared React, JSX and Redact requests use canonical
singleton keys with honest runtime versions and strict version matching, not
React 19 version numbers attached to Redact factories. The React authoring
profile continues to describe React's API/compiler, not the runtime override.

## Native application imports

| Renderer | Component authoring | Application router |
| --- | --- | --- |
| React | `react` | `react-router`, or the configured TanStack integration |
| Solid 2 | `solid-js`, `@solidjs/web` | `@modern-js/renderer-solid/router` |
| Octane | `octane` | `@modern-js/renderer-octane/router` |

Solid and Octane use their native component syntax and managed filesystem
routes. Generated applications import the runtime modules of their renderer
package automatically: `/entry-client`, `/entry-server`, `/router`, `/i18n`
and `/manifest`, plus `/federation` for Solid. `/plugin` is the build-only
adapter; only the CLI loads it.

### Renderer adapters

Every renderer is a `RendererAdapter` from `@modern-js/renderer-core/adapter`.
`defineConfig` loads only the selected one:

- `react` is a composed adapter (`src/renderers/react`). Its `compose()`
  registers the Modern.js React graph.
- `solid` and `octane` are native adapters exported from
  `@modern-js/renderer-<renderer>/plugin`. Each one carries its build profile,
  runtime entry modules, Rsbuild compiler plugin, compiler artifact checks,
  Module Federation singletons, worker support and create templates.

This package keeps the renderer-neutral parts: config selection, the
registered renderers' package and source-extension ownership, capability
checks, and one build, dev, SSG, worker and federation pipeline for every
native adapter. The entries it generates hold only data: `index.ts` calls the
renderer's `startNativeClient()`, `index.server.ts` calls
`createNativeServerEntry()`, and `app.client.ts`/`app.server.ts` list the
route modules. Mounting, hydration, documents, sessions, i18n and data
endpoints live in `@modern-js/renderer-core/entry-client` and
`@modern-js/renderer-core/entry-server`.

## Supported preview profile

Solid **2.0.0-rc.13** and Octane are Node previews with CSR, native streaming SSR,
hydration, route loading and actions. Their exact compiler, runtime and router
pins come from `resolveRendererProfile` exported by this package. Octane uses
the maintained [BleedingDev release artifacts](https://github.com/bleedingdev/octane/releases)
selected by that profile.

Native previews reject React Server Components, React runtime i18n
configuration and CSS declaration emission beside authored source. Octane
also rejects Module Federation.
These limits are checked before output generation; there is no preview bypass.

Native apps localize with `i18nPlugin()` from this package, which takes the
same `localeDetection`/`backend` options as `@modern-js/plugin-i18n`. URLs are
language-prefixed (`/cs/about`), translations come from
`locales/<language>/<namespace>.json`, and components use `useI18n`,
`LocalizedLink` and `I18nProvider` from `@modern-js/renderer-<renderer>/i18n`.
Install `i18next` and `@modern-js/i18n-runtime-extensions` next to the renderer:

```ts
import { defineConfig, i18nPlugin } from '@modern-js/ultramodern-app-tools';

export default defineConfig({
  renderer: 'solid',
  server: { ssr: true },
  plugins: [
    i18nPlugin({
      localeDetection: { languages: ['en', 'cs'], fallbackLanguage: 'en' },
    }),
  ],
});
```

`output.ssg` and `output.ssgByEntries` prerender native routes after the build,
in the same `dist/html/<entry>/<route>/index.html` layout as React SSG. Each
document's search-free loader data is written beside it, so client navigation
between prerendered routes works on a static host. A route cannot use both SSR
and SSG.

`import Icon from './icon.svg?component'` compiles an SVG into a Solid or
Octane component; `output.svgDefaultExport: 'component'` does the same for
plain `.svg` imports from scripts. Stylesheets and `?url` imports keep URLs.
Add `/// <reference types="@modern-js/ultramodern-app-tools/types" />` for the
`?component` module type.

Solid's native public route snapshots accept immutable plain records, arrays,
scalars and checked top-level deferred Promise slots. Rich HTTP data transport
is a separate `@modern-js/renderer-core/data` surface. Request objects, headers,
bindings and session state remain private to the request.
Authored deferred Promises use the standard prototype without custom own
properties. Symbol-bearing source Promises from async-hooks instrumentation and
Node's `--no-async-context-frame` mode are outside this preview profile.

Generate a workspace with the selected dependencies through
[`@modern-js/ultramodern-create`](../../toolkit/ultramodern-create/README.md).
Build and document identities bind the application source and installed
compiler/runtime cohort; stale manifests or hydration identities fail before
application startup.

## Workspace applications

Generated workspace applications declare their identity and authored options:

```ts
import {
  defineConfig,
  presetUltramodernWorkspace,
} from '@modern-js/ultramodern-app-tools';

export default defineConfig(
  presetUltramodernWorkspace(
    { html: { title: 'Catalog' } },
    { appId: 'catalog', from: import.meta.url },
  ),
);
```

The workspace preset reads `topology/reference-topology.json` and
`topology/local-overlays/development.json` relative to that config. Those records
provide app identity, renderer, development ports, composed remote references
and delivery unit identity. An authored `renderer` must match the topology. A
headless (API-only) unit declares renderer `none` and no Module Federation
name; its config selects no `renderer`.
Adding a shell or vertical changes the records; existing application configs
keep their authored contents.

The native package resolves build output and cache directories, remote asset
origins, canonical site origins, local CORS and Cloudflare service bindings and
fragment routes. Deploy target selection uses Modern.js's native resolver.
`deployTarget` and `environment` options allow explicit programmatic build inputs.
`createPresetUltramodernWorkspaceConfig(options)` exposes the resolved config for
inspection.

Cloudflare fragment bindings use the expose names from each remote's authored
Module Federation config. The shared config inspector accepts literal objects
and string arrays. Dynamic declarations use Modern.js's native config loader
during config resolution, including async functions, environment and command
arguments. Authored worker settings and services remain part of the merged
config; dynamic bindings use the loaded exposes.

The old generated `performance.rsdoctor` setting was not part of Modern.js's
supported config and had no effect. The native preset omits it.

Zephyr registers only for browser applications. It loads the application's
declared `zephyr-rspack-plugin` only when `ZE_CI_TOKEN` is present, and requires
`ZE_FAIL_BUILD=true` in that deploy environment. Ordinary builds require no
Zephyr account. The preset does not mutate environment variables.
The Zephyr SDK reads credentials and its fail-build flag from `process.env`.
When supplying `environment` explicitly, enabled Zephyr inputs must match those
process values; a mismatch fails during plugin setup before registration.

Authored config merges after native policy. Scalars and `false` override defaults;
nested records are preserved; arrays and hooks compose in preset-first order.
The existing typed preset options, including `enableTelemetry`,
`enableTelemetryExporters`, `enableBffRequestId` and
`enableModuleFederationSSR`, also apply to workspace presets.

Standalone applications can continue using `presetUltramodern(config, options)`.

## React base plugin

`defineConfig` is the entry for every renderer. A React application that keeps
`defineConfig` from `@modern-js/app-tools` registers the same React graph with
`plugins: [ultramodernAppTools()]` instead. It keeps the fork's default React
renderer and server behavior; pass `rendererExtensions: false` or
`serverExtensions: false` to `ultramodernAppTools()` to opt out of either
policy. Use one base: never combine it with this package's `defineConfig`.
