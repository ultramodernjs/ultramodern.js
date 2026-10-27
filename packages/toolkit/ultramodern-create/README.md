# UltraModern.js Create

Create an UltraModern.js workspace with React, Solid 2, or Octane. React is the
default SuperApp profile; Solid and Octane provide standalone Node SSR and CSR
preview profiles with their native authoring and router APIs.

Replace `<V>` with the exact published UltraModern package cohort version:

```bash
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> my-workspace
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> my-solid-workspace --renderer solid
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> my-octane-workspace --renderer octane
```

The supported pnpm command contract is the scoped package specifier above:
`pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> <target>`. Do not shorten it
to `pnpm dlx modern-js-ultramodern-create`; there is no unscoped
`modern-js-ultramodern-create` npm package. Release proof runs this scoped form
from a temporary pnpm store/cache so it cannot pass because of a local link
cache.

To initialize the empty directory you are already in, pass `.` explicitly:

```bash
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> .
```

## Renderer Selection

`--renderer react|solid|octane` selects the initial scaffold only. Existing
workspace additions read the renderer from the owning `modern.config.ts` and
reject `--renderer`. That config is the single selector for the compiler,
runtime, router, and generated entries:

```ts
import { defineConfig } from '@modern-js/ultramodern-app-tools';

export default defineConfig({
  renderer: 'solid',
  server: { ssr: true },
});
```

Restart the dev server after changing `renderer`, and author app sources for
the selected renderer. `defineConfig` selects the native compiler; do not add
a second compiler or base app-tools plugin.

| Renderer | Application authoring | Router imports |
| --- | --- | --- |
| Solid 2 RC | `solid-js`, `@solidjs/web` | `@modern-js/renderer-solid/router` |
| Octane | `octane` | `@modern-js/renderer-octane/router` |

Solid and Octane previews support plain Node SSR with hydration and CSR. They
require the admitted package cohort and reject unsupported capabilities:
Module Federation, Worker deployment, RSC, SSG, framework i18n, SVG component
imports, and CSS declaration emission beside authored source. There is no CLI
preview override. The SuperApp federation and
Cloudflare guidance below applies to the React profile.

The workspace starts shell-only so the first commit has no fake business
domains to delete. It generates:

- `apps/shell-super-app` as the initial app and topology owner; React also
  makes it the Module Federation host.
- `verticals/*` empty until a real domain is added with `--vertical`.
- `packages/shared-*` placeholders for shared contracts, tokens, and Effect
API support.
- `catalogs.ultramodern` in `pnpm-workspace.yaml` for published framework
  dependency versions, referenced by application manifests.
- `topology/*` as app-owned topology, ownership, and local development overlay
  JSON.

Validate the generated workspace before making application changes:

```bash
cd my-workspace
mise install
pnpm install
pnpm check
pnpm build
```

Start the shell during development, or serve its production build:

```bash
pnpm dev:shell
pnpm --filter "./apps/shell-super-app" serve
```

Run these as separate commands. Use the matching app directory in the filter
to serve an added app.

The generated toolchain pins Node `26.10.0`, pnpm `12.8.1`, and
`@types/node@26.6.4`; the generator requires Node `>=26.10.0`, and generated
workspaces declare an engine baseline of Node `>=26` with pnpm `12+`.
`packageManager`, `.mise.toml`, generated validation, and CI should all agree
on those values; do not reintroduce Corepack or older pnpm aliases.

The current React dependency cohort also pins `@effect/tsgo@0.59.0`,
`@tanstack/react-router@1.170.41`, `@tanstack/router-core@1.171.34`,
`@tanstack/history@1.162.4`, and the Module Federation integration `2.9.2`
cohort, `@module-federation/node@2.7.52`. Move these only through the
generator-owned version policy so templates, validation, and the published
workspace contract stay aligned.

## TS-Go Compatibility Boundary

The supported generator runtime surfaces are:

- `@modern-js/ultramodern-create/ultramodern-workspace`
- `@modern-js/ultramodern-create/ultramodern-workspace/codesmith`
- The `@bleedingdev/modern-js-ultramodern-create` CLI that delegates to those APIs.

These surfaces are plain Node generator code. They must not import
`typescript` or TypeScript compiler internals at runtime. The package build is
the local validation command for this boundary:

```bash
pnpm --filter @modern-js/ultramodern-create build
```

That command lets Rslib emit runtime modules and declarations together through
the repository's compiler integration. The same declaration configuration
stays active during `rslib build --watch`. Run
`pnpm --filter @modern-js/ultramodern-create test` when changing generator behavior; it
includes a boundary test that scans generator sources, templates, and generated
workspace output for compiler API imports.

Generated workspaces and apps pin `tsrs@0.20.0-ts7.1.0-beta` and
`@effect/tsgo@0.59.0`. Root postinstall runs
`ultramodern-create ultramodern compiler-prepare` before skills install.
The installed tsrs platform metadata selects the official
`effect-tsgo tsrs --version` readiness check on supported hosts.
Hosts without a declared native tsrs package use `effect-tsgo tsc --version`
and print an explicit Effect-Go notice. Missing supported artifacts remain
fatal. These official proxy commands run the provider's Effect-enabled
binaries without changing the package store.
The shared compiler resolver selects the provider's tsrs for generated React and
Solid checks and Modern/Rspack builds, or Effect-Go on unsupported tsrs hosts.
The installed typecheck command sets
`TSRS_CHECKER_ASSIGNMENT` to the caller's explicit value or `go` by default,
and does not add `--checkers` or `--builders` in build mode. Octane apps retain
`octane-tsc` for their native TS7 checker.
All renderer profiles retain exact stable `typescript@7.0.2` for metadata and
tool dependencies. This is separate from tsrs's embedded TypeScript
`7.1.0-beta`. Only these exact compiler releases and their declared native
platform packages receive a release-age exception; the strict 24-hour gate
still applies to other packages apart from the authenticated release cohort.
Generated app/package source must not
depend on compiler API internals. If a future AST utility is needed, keep it
behind a dedicated TypeScript adapter and test it against stable `typescript`.

Generated React CI does not call the local aggregate. It runs format, lint,
typecheck, skills, i18n boundary validation, contract validation, and build as
separate matrix jobs so failures are isolated and parallelizable. Generated
lefthook config runs separate format and lint-fix commands on pre-commit, then
runs the read-only primitive gates in parallel on pre-push.

For local monorepo dependency testing, add `--workspace`:

```bash
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> my-workspace --workspace
```

For package-source validation outside the monorepo, pass explicit
`--ultramodern-package-*` options.

## Automation And Public API

The supported runtime import is the public generator subpath. It exposes only
generator operations and stable result types; CLI argument parsing, prompts,
registry lookup, and process-exit flows stay private.

```ts
import {
  addUltramodernVertical,
  generateUltramodernWorkspace,
  planUltramodernVertical,
} from '@modern-js/ultramodern-create/ultramodern-workspace';

const workspace = await generateUltramodernWorkspace({
  targetDir: '/tmp/my-workspace',
  packageName: 'my-workspace',
  modernVersion: '<V>',
  packageSource: {
    strategy: 'install',
    modernPackageVersion: '<V>',
  },
});

const plan = await planUltramodernVertical({
  workspaceRoot: workspace.workspaceRoot,
  name: 'new-vertical',
  modernVersion: '<V>',
});

const vertical = await addUltramodernVertical({
  workspaceRoot: workspace.workspaceRoot,
  name: 'new-vertical',
  modernVersion: '<V>',
});
```

Workspace generation returns `operation`, `workspaceRoot`, `packageScope`,
`packageSource`, `createdApps`, `createdPaths`, `rewrittenPaths`,
`assignedPorts`, `moduleFederationNames`, `apiPrefixes`,
`generatedContractPath`, and `warnings`. MicroVertical addition returns the
same shape for the new vertical and all rewritten integration surfaces.

MicroVertical addition supports dry-run. The CLI prints the plan as
JSON and writes no files:

```bash
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> new-vertical --vertical --dry-run
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> --vertical=new-vertical --dry-run
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> --vertical-name new-vertical --dry-run
```

The dry-run object adds `dryRun: true`, `selectedPort`,
`moduleFederationRemote`, `apiPrefix`, `jsonMutations`,
`shellDependencyChanges`, and `generatedContractChanges`. It still validates
the workspace before returning a plan.

Validation runs before publishing generated output to the target workspace.
Failures name the owning
contract so automation can stop safely:

| Failure area | Typical cause | Fix |
| --- | --- | --- |
| Fresh input | Invalid or missing vertical name | Use `<name> --vertical`, `--vertical=<name>`, or `--vertical-name <name>` |
| Existing topology | Duplicate app ID, package suffix, path, Module Federation name, port, API prefix, or manifest key | Choose a new vertical name or repair the existing topology/local overlay first |
| Workspace files | Missing or invalid topology, ownership, local overlay or app manifest | Repair the named authoritative file |
| Tailwind prefix | Existing app already owns the generated CSS prefix | Rename the vertical before generation |
| Output path | A generated path already exists | Treat it as an existing vertical and do not overwrite it |

Package source is selected by the installed generator dependency and native pnpm catalog.
Application manifests own package identity; the development overlay owns local ports.

| Strategy | Use when | CLI |
| --- | --- | --- |
| `install` | Published BleedingDev package cohort or release proof | Default for the BleedingDev create package; optional `--ultramodern-package-version`, `--ultramodern-package-registry` (serves the cohort scope only; release-age metadata for every other dependency is validated against npmjs), `--ultramodern-package-scope`, and `--ultramodern-package-name-prefix` |
| `workspace` | Local monorepo testing against unreleased packages | `--workspace` or `--ultramodern-package-source=workspace` |

## Framework dependencies

Published framework versions live in `catalogs.ultramodern` in
`pnpm-workspace.yaml`. Application manifests reference `catalog:ultramodern`;
the lockfile records resolved packages. Corrected third-party dependencies ship
as published packages. Applications do not install framework patches or carry
a copied release manifest.

Use `--ultramodern-package-source=install` for published package acceptance and
`--ultramodern-package-version` to select an exact release. Use `--workspace`
for local monorepo development. After installation, run `pnpm contract:check`,
which invokes the installed CLI directly. The installed generator owns its
release-integrity metadata.

Normal installs retain the generated strict 24-hour release-age and trust
policy. The one exception is `minimumReleaseAgeExclude`: it lists the exact
`package@version` of every package in the cohort the create package ships, so a
workspace created on the day that cohort is published can install it. Every
other dependency still waits 24 hours, including a cohort selected with
`--ultramodern-package-version` that differs from the create package's own; to
install a fresh cohort on publish day, run that release's create package.
Release acceptance adds exact, temporary exceptions for the sidecars under test
on the command line.

## CodeSmith Adapter And Overlays

The CodeSmith adapter is exported from:

```ts
import ultramodernCodeSmith from '@modern-js/ultramodern-create/ultramodern-workspace/codesmith';
```

Non-interactive usage passes config directly:

```ts
await ultramodernCodeSmith({
  config: {
    mode: 'workspace',
    name: 'my-workspace',
    targetDir: '/tmp/my-workspace',
    modernVersion: '<V>',
    packageSourceStrategy: 'install',
    modernPackageVersion: '<V>',
  },
});

await ultramodernCodeSmith({
  config: {
    mode: 'vertical',
    name: 'new-vertical',
    workspaceRoot: '/tmp/my-workspace',
    dryRun: true,
    logResult: true,
  },
});
```

The adapter prompts only when a required name is missing and a CodeSmith prompt
function is available. It returns the same public generation result or dry-run
plan as the direct API.

Overlays are explicit CodeSmith generators that run after base workspace or
MicroVertical generation:

```bash
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> new-vertical --vertical \
  --codesmith-overlay ./generators/vertical-overlay
```

```ts
await addUltramodernVertical({
  workspaceRoot: '/tmp/my-workspace',
  name: 'new-vertical',
  modernVersion: '<V>',
  overlays: [
    {
      generator: './generators/vertical-overlay',
      config: { owner: 'workspace' },
    },
  ],
});
```

Overlay config receives `workspaceRoot`, `packageScope`, `operation`,
`generatedApp`, `generatedApps`, `assignedPort`, `assignedPorts`,
`moduleFederationName`, `moduleFederationNames`, `apiPrefix`,
`apiPrefixes`, `packageSource`, and `generationResult`. Overlays extend
the generated output after base generation; they do not replace, inherit, or
shadow the base templates. Overlay failures stop the command with an
`UltraModern CodeSmith overlay failed` error and do not report base generation
as fully successful.

## Vertical Workspace Recipes

Use the workspace add flow from the UltraModern workspace root. It derives the
package path, package name, port, Module Federation name, topology entry, local
overlay, ownership entry, strict Effect HttpApi surface, and root `dev:*` script from the
requested vertical name.

```bash
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> catalog --vertical
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> --vertical=catalog
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> --vertical-name catalog
```

Use this decision table before adding a vertical:

| Need | Keep inside current vertical | Create a new vertical |
| --- | --- | --- |
| Route or widget changes with the same product owner, release train, and fallback behavior | Yes | No |
| Route subtree needs independent rollout, rollback, or incident ownership | No | `--vertical` |
| UI and Effect BFF must version, deploy, and roll back together | No | `--vertical` |
| Design tokens, primitives, generated clients, or domain-neutral utilities | Yes | Use an ordinary workspace package, not a vertical |
| Feature composites or workflow state shared across verticals | No | Revisit ownership; do not hide it in shared code |

## SuperApp Architecture Contracts

Generated React `modern.config.ts` files declare their app identity through
`presetUltramodernWorkspace(config, { appId, from: import.meta.url })` inside
the renderer-selecting `defineConfig` from `@modern-js/ultramodern-app-tools`,
and keep ordinary Modern.js plugins and authored configuration. The preset
resolves `topology/reference-topology.json` and the development overlay when
the config loads. Fork-owned packages apply deployment targets, ports, asset
origins, CORS, Cloudflare bindings, build/cache directories, release identity,
and Zephyr deployment policy. Authored values override preset defaults; native
builder hooks and plugins compose normally. Solid and Octane apps select their
renderer directly with `defineConfig({ renderer })`.

Adding a shell or vertical updates topology, overlays, and generated workspace
metadata without rewriting any existing `modern.config.ts`. Application
configs belong to their authors from the moment they are created. New apps
receive a config scaffold with their own stable `appId`; changing a port or
shell composition takes effect through the canonical workspace inputs.

The React SuperApp shell owns route assembly and policy. Each React vertical added with
`--vertical` owns its route subtree, Module Federation exposes, Effect BFF
contract, generated client, `localisedUrls`, locale JSON, CSS layer, and
Cloudflare Worker output. The shell consumes vertical UI through Module
Federation manifests and vertical APIs through generated Effect clients
exported by the vertical packages.

Shell routes load federated modules through `createLazyComponent` or the
generated loaders. A route that drives the runtime itself calls
`loadRemote()` or `loadShare()` on the instance from `getInstance()`
(`@module-federation/modern-js-v3/runtime`), and only inside the true branch
of `import.meta.env.MODERN_TARGET === 'browser'`:

```tsx
import { getInstance } from '@module-federation/modern-js-v3/runtime';

export const loadWidget = () => {
  if (import.meta.env.MODERN_TARGET === 'browser') {
    const host = getInstance();
    if (host !== null) return host.loadRemote('inventory/Widget');
  }
  return undefined;
};
```

The React composition defines `import.meta.env.MODERN_TARGET` per bundle as
`'browser'` or `'node'`, the same value as `process.env.MODERN_TARGET`, so the
server bundle drops the branch. Shell routes must not read `process.env`:
`pnpm typecheck` rejects it through Effect's `processEnv` rule and
`pnpm contract:check` rejects it too.

Route metadata is route-owned and colocated in
`src/routes/**/route.meta.ts`; each file exports `routeMeta`.
`ultramodern-create ultramodern routes-generate` (run before every app `dev`
and `build`) regenerates `src/routes/ultramodern-route-metadata.ts` as a
formatted route manifest for Modern.js config, i18n, public head, and public
surface contracts; authors should not hand-maintain it. Locale JSON is served from
`/locales/{{lng}}/{{ns}}.json`; Czech and English routes are generated from the
route owner, not from shell rewrites.

Routes default to `privateByDefault: true` and
`publicnessDefault: private-app-screen`. Public web artifacts are build/deploy
outputs generated by `scripts/generate-public-surface-assets.mjs` into
`dist/public` and `.output/public`, not source files under `config/public`.
Generated public files use only explicit `public && indexable` route metadata,
so private app screens publish only a disallowing `robots.txt` by default.
JSON-LD is not inferred from route titles, descriptions, localized paths, app
names, BFF APIs, or Module Federation metadata. To publish structured data,
author `jsonLd` explicitly in route metadata for a `public && indexable` route;
generated apps provide `src/routes/ultramodern-jsonld.ts` helpers for
`WebPage`, `WebApplication`, `SoftwareApplication`, `BreadcrumbList`,
`FAQPage`, and `Organization`, while raw JSON-LD remains possible for other
schema types.

Dynamic public routes can expand sitemap entries through route-owned,
Node-safe ESM providers, normally `route.sitemap.mjs` beside the route
metadata. The public-surface generator discovers those providers for dynamic
public routes and still honors explicit `routes.publicSurface.contentSources`
entries in the generated route manifest. Providers may export
`entries`, `entries()`, or a default entries/loader returning sitemap entries;
draft entries and `indexable: false` entries are omitted.

CSS federation is explicit:

- `packages/shared-design-tokens` exports `./tokens.css` and owns
  `ultramodern-shared-tokens`.
- The shell owns shell base and overlay CSS only.
- Verticals own their vertical CSS layer and `[data-app-id="<vertical>"]`
  root marker.
- Tailwind CSS v4 is configured per app through `@rsbuild/plugin-tailwindcss`.
- Duplicate base styles are forbidden; SSR first paint depends on shared token
  CSS plus Modern/Rspack-emitted app CSS.

## Public URL Environment Variables

Generated apps must not bake absolute `http://localhost:<port>` URLs into asset
configuration. Public URL and asset prefix environment variables have distinct
roles, and stale aliases should not be carried forward when regenerating or
updating workspaces.

| Variable | Role | Feeds |
| --- | --- | --- |
| `MODERN_PUBLIC_SITE_URL` | Canonical site origin for public SEO output only | Canonical, hreflang, sitemap `<loc>`, robots `Sitemap:` |
| `MODERN_ASSET_PREFIX` | Preferred JS/CSS/static asset prefix | Modern/Rspack-emitted asset URLs |
| `ULTRAMODERN_ASSET_PREFIX` | UltraModern asset prefix fallback | Modern/Rspack-emitted asset URLs when `MODERN_ASSET_PREFIX` is unset |
| `ULTRAMODERN_PUBLIC_URL_<APP_ID>` | Per-app deployment/proof URL | Cloudflare proof inputs and Module Federation remote URLs |

Shell asset URLs use this precedence: `MODERN_ASSET_PREFIX` →
`ULTRAMODERN_ASSET_PREFIX` → origin-relative `/`. Module Federation remotes use
the same env precedence, then fall back to their per-app public origin:
configured public URL, inferred workers.dev URL, or local dev port.
`MODERN_PUBLIC_SITE_URL` is canonical/SEO-only and must not be used as an
asset-prefix fallback.
SEO output uses `MODERN_PUBLIC_SITE_URL`; if it is unset, generated local and
preview outputs remain non-public until deployment proof provides explicit
public URLs.

Without public URLs configured, shell asset paths are origin-relative (`/`).
Remote dev manifests publish their own local origin so host shells load
`remoteEntry.js` and exposed chunks from the remote dev server. Shell-only
workspaces can set `MODERN_PUBLIC_SITE_URL` for SEO output without changing
where assets load from.

## Cloudflare And Zephyr Proof

Each generated React workspace app has:

- `cloudflare:build`, `cloudflare:deploy`, `cloudflare:preview`, and
  `cloudflare:proof` scripts.
- Cloudflare Worker deploy config emitted from native Modern config.
- `zephyr:dependencies` for any consumed verticals.
- `zephyr-rspack-plugin` composed by the fork-owned workspace preset for UI
  apps. It activates only when `ZE_CI_TOKEN` is present; the deploy environment
  must also set `ZE_FAIL_BUILD=true`. Ordinary builds require no Zephyr token.

Deploy first, then pass each deployed app's generated public URL env key into
the proof step. The installed proof command reads topology and deployment contracts and checks the
Cloudflare Worker surface, including public-route sitemap/robots consistency,
preview noindex behavior, unknown-route status, asset headers, byte budgets,
and public sourcemap exposure. Shell-only workspaces only need the shell URL;
added verticals use the same `ULTRAMODERN_PUBLIC_URL_<APP_ID>` pattern with
hyphens converted to underscores and uppercased:

```bash
pnpm cloudflare:deploy
ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP=https://shell-super-app.example.workers.dev \
ULTRAMODERN_PUBLIC_URL_TRANSPORTATION=https://transportation.example.workers.dev \
pnpm cloudflare:proof --require-public-urls
```

Without public URLs and credentials, use local primitive gates and `pnpm build`
evidence only; do not claim live Cloudflare or Zephyr selection has been
proven.

## Troubleshooting

| Symptom | Current check | Owner |
| --- | --- | --- |
| Package version mismatch | Align the native framework catalog and regenerate the lockfile with `pnpm install`. | Workspace dependency manifests |
| Install failure | Check the active Node/pnpm from `mise install`; rerun `pnpm install` after the shell sees the pinned versions. | Toolchain setup |
| Build failure | Run the matching primitive gate (`pnpm lint`, `pnpm typecheck`, `pnpm i18n:boundaries`, `pnpm contract:check`) before `pnpm build`; fix the owning failure first. | Owning package or generated contract |
| Missing public URL | Set the app public URL env key declared in topology, for example `ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP`. | Deployment operator |
| Cloudflare credentials | Confirm Wrangler credentials before `pnpm cloudflare:deploy`; local checks do not prove live Worker access. | Deployment operator |
| Asset or CSS 404 | Rebuild with `pnpm build` or `pnpm cloudflare:deploy` and inspect emitted Modern/Rspack asset paths instead of hardcoding CSS URLs. | Framework/runtime asset pipeline |
| Federation manifest failure | Run the shell and vertical build scripts, then check each deployed `/mf-manifest.json` URL used by the shell. | Module Federation owner |

## Modern.js Documentation

- [English Documentation](https://modernjs.dev/en/)
- [中文文档](https://modernjs.dev)

## License

Modern.js is [MIT licensed](https://github.com/web-infra-dev/modern.js/blob/main/LICENSE).
