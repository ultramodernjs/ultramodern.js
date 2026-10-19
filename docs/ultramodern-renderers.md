# Choosing a renderer

An UltraModern.js app builds with exactly one renderer: `react` (default),
`solid`, or `octane`. Select it once in `modern.config.ts`:

```ts
import { defineConfig } from '@bleedingdev/modern-js-ultramodern-app-tools';

export default defineConfig({ renderer: 'solid' });
```

`@bleedingdev/modern-js-ultramodern-app-tools` is the published package
(`packages/solutions/ultramodern-app-tools/package.json`, name
`@modern-js/ultramodern-app-tools`, published under the `bleedingdev` scope).
A workspace created by the generator installs it through a pnpm catalog
alias, so its own `modern.config.ts` imports the unscoped specifier,
`@modern-js/ultramodern-app-tools`; installing the package directly uses the
published name shown above. The in-repo renderer fixture apps
(`tests/integration/renderer-{react,solid,octane}`) import the unscoped name
from the workspace.

## What the renderer switch does

Selecting a renderer swaps, for the whole app, the compiler, the JSX import
source, the hydration runtime, the router bindings and the server document
renderer. It does not translate source. A component authored for one renderer is not
rewritten for another: route modules are checked against the selected
renderer before the build proceeds, and plugins that only work with React are
rejected outright. See "Switching an existing app" below.

## Creating an app

Pass `--renderer` to the generator:

```sh
pnpm dlx @bleedingdev/modern-js-ultramodern-create@<V> my-app --renderer solid
```

`--renderer <react|solid|octane>` is defined in
`packages/toolkit/ultramodern-create/src/cli/flags.ts`. Each native starter
(Solid, Octane) writes the same shape:

| File | Purpose |
| --- | --- |
| `src/routes/layout.tsx` | Root layout; `Link`/`Outlet` from the renderer's router |
| `src/routes/page.tsx` | Home route; reads `useLoaderData` and submits a route action |
| `src/routes/page.data.ts` | `loader`/`action` exports, native TanStack Router data handlers |
| `src/routes/page.head.ts` | Per-route `head()` metadata |
| `src/routes/about/page.tsx`, `about/page.head.ts` | A second route, same shape |
| `src/routes/error.tsx` | `ErrorRouteComponent` boundary |
| `src/routes/not-found.tsx` | `NotFoundRouteComponent` |
| `src/components/Counter.tsx`, `Stable.tsx` | HMR fixtures: one edited component, one left alone |

(`packages/runtime/renderer-{solid,octane}/src/plugin/create.ts`.)

## Routing and data

Both native renderers use file-system routes and the same `loader`/`action`
shape, backed by native TanStack Router data handlers
(`DataHandlerInput` from `@bleedingdev/modern-js-renderer-core/data`). Only
the component-side router bindings differ.

### Solid

Router bindings come from `@bleedingdev/modern-js-renderer-solid/router`:

```tsx
// src/routes/page.tsx
import {
  ActionForm,
  useLoaderData,
  useRouteAction,
} from '@bleedingdev/modern-js-renderer-solid/router';

export default function HomePage() {
  const data = useLoaderData({ strict: false });
  const action = useRouteAction();
  return (
    <section>
      <pre>{JSON.stringify(data())}</pre>
      <ActionForm action={action}>
        <input name="name" />
        <button type="submit" disabled={action.pending()}>
          Save
        </button>
      </ActionForm>
    </section>
  );
}
```

```ts
// src/routes/page.data.ts
import type { DataHandlerInput } from '@bleedingdev/modern-js-renderer-core/data';

export function loader({ request }: DataHandlerInput) {
  return { message: 'Native loader value' };
}

export async function action({ request }: DataHandlerInput) {
  const form = await request.formData();
  return { saved: form.get('name') };
}
```

(Full fixture:
`tests/integration/renderer-solid/src/routes/page.tsx`.)

### Octane

Octane applications use the exact runtime, router and compiler archives from
[Octane source `0bf2313bbdfb`](https://github.com/BleedingDev/octane/releases/tag/ultramodern-octane-0bf2313bbdfb),
together with the Core archive from
[Router source `585d3233f7f5`](https://github.com/BleedingDev/router/releases/tag/ultramodern-router-core-585d3233f7f5).
This archive tuple is the supported contract. The generator writes its exact
URLs into the application dependencies; retain those requests in the manifest
or catalog. Workspace validation rejects different requests.

The renderer SDK's version peers describe the ABI it expects. Most are optional
so installing the SDK does not install an application toolchain. Registry
packages with the same version numbers do not provide the required fork APIs
and cannot replace these archives. The SDK's `ultramodern.nativeArtifacts`
metadata records each archive URL, version and SHA512 integrity; native artifact
qualification checks the downloaded bytes against that metadata.

Router bindings come from `@bleedingdev/modern-js-renderer-octane/router`.
Components are authored as `.tsx` today (the generator's starter); Octane
also admits its own `.tsrx` source extension for components, declared in its
build profile's `sourceExtensions`:

```tsx
// src/routes/page.tsx
import {
  useLoaderData,
  useOctaneRouteAction,
} from '@bleedingdev/modern-js-renderer-octane/router';
import { useActionState } from 'octane';

export default function HomePage() {
  const data = useLoaderData({ strict: false });
  // Bound to the nearest route; unmounting aborts a submission in flight.
  const submit = useOctaneRouteAction();
  const [result, action, pending] = useActionState(submit, undefined);
  return <pre>{JSON.stringify(data)}</pre>;
}
```

A `.tsrx` component (`tests/ultramodern-renderers/octane-admission/src/Counter.tsrx`)
uses Octane's own block syntax instead of a `return`:

```tsrx
export function Counter() @{
  const [count, setCount] = useAdmissionCount();
  <button onClick={() => setCount(count + 1)}>{"Count: " + count}</button>;
}
```

`page.data.ts` uses the same `loader`/`action` shape as Solid.

## Capability matrix

Source of truth: each renderer's build profile
(`packages/solutions/ultramodern-app-tools/src/renderers/react/profile.ts`,
`packages/runtime/renderer-{solid,octane}/src/plugin/profile.ts`).

| Capability | react | solid | octane |
| --- | --- | --- | --- |
| SSR / streaming, CSR | Yes | Yes | Yes |
| Worker (Cloudflare) SSR | Yes | Yes | Yes |
| SSG (`output.ssg`) | Yes | Yes | Yes |
| SVG components (`?component` import) | Yes | Yes | Yes |
| Module Federation | Full, including app SSR | Same-renderer components, browser and Node SSR | Same-renderer components, browser and Node SSR |
| RSC | Yes | No | No |
| i18n | Yes | Yes | Yes |

SSR/streaming and CSR carry no per-renderer gate in
`renderer-selection.ts`; worker, SSG, i18n and SVG components are declared
`true` in all three profiles' `capabilities`.

Solid and Octane federate native components between apps using the same
renderer and matching compiler, hydration, router and runtime identities.
Configure the host and remote in `module-federation.config.ts`; the native
adapter supplies their shared modules and container formats. Generated
Octane entries retain their own federation instance, and each server request
has a separate native component-loading scope.

For Solid,
`federatedComponent()` from `@bleedingdev/modern-js-renderer-solid/federation`
loads a remote by its `remote/Expose` id through the host's server federation
instance, renders it into the document with its stylesheets and preloads, and
hydrates the same remote in the browser. A remote that fails or times out on
the server renders `fallback`, and the browser retries it after hydration.

```tsx
import { federatedComponent } from '@bleedingdev/modern-js-renderer-solid/federation';

const RemoteWidget = federatedComponent('remote/Widget', {
  fallback: () => <p>Loading…</p>,
});
```

Octane exposes the same component-loading API through its own adapter:

```tsx
import { federatedComponent } from '@bleedingdev/modern-js-renderer-octane/federation';

const RemoteWidget = federatedComponent<{ title: string }>('remote/Widget', {
  fallback: () => <p>Loading…</p>,
  timeout: 3000,
});
```

Octane's native `lazy` and `Suspense` handle loading, streamed styles and
hydration. Remote components use the host's native router and application
context, and retain state when host props change. Server failures render the
fallback; the browser retries through its own federation instance. Browser
failures reach the nearest native `ErrorBoundary`.

Native Worker SSR and native Module Federation are separate capabilities.
Their combination is currently unsupported: it needs a remote-worker
transport and native hydration ownership rather than the Node container
loader. Native federation also rejects React application-SSR options and
mixed-renderer component remotes.

Unsupported combinations fail when the config is evaluated, before the build
starts:

```
unsupported-renderer-capability: renderer solid does not support React Server Components
```

`assertCapturedRenderer` in `renderer-selection.ts` raises the same error,
naming the capability, for RSC, i18n, SSG, SVG components, Module Federation
application SSR, and worker or non-Node/Cloudflare deployment targets.

## How a renderer plugs in

Every renderer is a `RendererAdapter` (`@bleedingdev/modern-js-renderer-core/adapter`).
`defineConfig` looks up the selected name and loads only that adapter:

```
renderer: 'react'   -> app-tools src/renderers/react/adapter.ts  (kind: 'composed')
renderer: 'solid'   -> @bleedingdev/modern-js-renderer-solid/plugin   (kind: 'native')
renderer: 'octane'  -> @bleedingdev/modern-js-renderer-octane/plugin  (kind: 'native')
```

- A **composed** adapter (React) registers the existing Modern.js React graph
  through `compose()`.
- A **native** adapter is data plus a compiler. It names its build profile,
  its runtime modules (`entry-client`, `entry-server`,
  `router`, `i18n`, `manifest`), Module Federation singletons, worker support,
  the Rsbuild compiler plugin, the compiler artifacts to verify, and the create
  templates. app-tools runs the same build, dev, SSG, worker and federation
  orchestration for every native adapter.

Generated entries hold only data. `index.ts` calls `startNativeClient()` and
`index.server.ts` calls `createNativeServerEntry()`; the renderer package's
`entry-client`/`entry-server` modules and renderer-core own mounting,
hydration, documents, sessions, i18n and data endpoints. `app.client.ts` and
`app.server.ts` list the route modules and route data.

## Switching an existing app

Changing `renderer` without migrating the app's source surfaces two kinds of
startup errors, both from
`packages/solutions/ultramodern-app-tools/src/native-composition/renderer-selection.ts`
and `renderer-source-ownership.ts`.

React-only CLI plugins (`assertRendererCliPlugins`):

```
unsupported-renderer-plugin: renderer solid cannot use React-only plugins registered in modern.config plugins:
  - @modern-js/plugin-tanstack: remove tanstackRouterPlugin(); the solid renderer routes src/routes through @modern-js/renderer-solid/router
Remove these plugins for the native renderer, or keep renderer: 'react'.
```

Route files still authored for the previous renderer
(`assertRouteSourcesMatchRenderer`, detected by a `.tsrx` extension, an
`@jsxImportSource` pragma, or an import of a renderer-owned package such as
`react-router` or `solid-js`). Renderer ownership is a static table in
`renderer-registration.ts`, so routes are still named after the previous
renderer's package was uninstalled, and the check loads no adapter:

```
renderer-source-mismatch: modern.config selects renderer solid, but these route modules are authored for react:
  - src/routes/page.tsx imports 'react-router' (react)
Port them to solid components and install its packages, or set renderer: 'react' in modern.config.
```

Fix both before the build proceeds: remove the listed plugins, then port or
relocate the listed route files.

## Preview status

`solid` (Solid 2 RC) and `octane` (a maintained Octane fork) are
`status: 'preview'` in their build profiles; `react` is `status: 'stable'`.
Expect their compiler, router and capability set to change between releases.
