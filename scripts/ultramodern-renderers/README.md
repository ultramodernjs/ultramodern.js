<!--
DESIGN (t3-harness): replace the renderer acceptance harness with ordinary
integration tests + one lean packed-release script.

Today: ~35k lines of scripts here, ~28k lines of committed evidence and
declaration snapshots, ~25k in tests/ultramodern-renderers and ~16.6k in
scripts/ultramodern-production-readiness. Most of that is bookkeeping:
digests, receipts, bindings, artifact audits and type snapshots. It does not
test what a user sees. Target: about 3-4k lines total.

(a) Fixture apps: tests/integration/renderer-*/
  These are normal tests/integration packages. Each has a package.json with
  workspace:* dependencies, a modern.config.ts and tests/*.test.ts. They run
  under tests/rstest.config.mts with modernBuild/modernServe/killApp/getPort
  from tests/utils/modernTestUtils.js, called with
  { modernBin: packages/solutions/ultramodern-app-tools/bin/ultramodern.mjs }.
  The source moves (git mv) from tests/ultramodern-renderers/conformance/
  fixtures/<renderer>/src. Imports are rewritten once to the canonical
  @modern-js/* names. The native overlay's replaceAll then has nothing left
  to do and is deleted. Packed apps get the same names through the npm:
  aliases the generator already writes.

    renderer-react/     conformance React app (+ not-found route, head)
    renderer-solid/     conformance Solid app
    renderer-octane/    conformance Octane app (+ items/[id] like Solid)
    renderer-worker-ssr/  React custom server entries (fetch export and
                        requestHandler) built with MODERNJS_DEPLOY=cloudflare
                        and served by miniflare (devDependency pinned like
                        ultramodern-create). Sources come from
                        renderer-worker-lifecycle-proof/fixtures.mjs and
                        release-worker.mjs. Checks: streamed SSR 200, and a
                        client disconnect aborts request.signal.
    renderer-mf/{host,remote}/  Solid host (SSR) + Solid remote exposing
                        ./Widget, from solid-federation/proof.mjs. Checks:
                        remote markup and CSS are in the SSR HTML, hydration
                        keeps that node, a down remote renders the fallback
                        with a 200, a React-stamped container is rejected.
    renderer-i18n/{solid,octane}/  layout + about + en/cs locales, from
                        i18n/proof.mjs. Checks: Accept-Language and cookie
                        redirect, Czech SSR, no language flash on hydration,
                        client-side switch, per-request isolation.
    renderer-ssg/{solid,octane}/  output.ssg: true, two pages. Checks: the
                        prerendered HTML file exists, is served and hydrates.

(b) Shared behavior specs: tests/integration/renderer-specs/
    specs.ts  defineRendererSpecs({ renderer, target }) registers describe/
              test once. target() returns { url, stop }. Driver: puppeteer +
              utils/launchOptions (the repo driver, so playwright-core goes).
    Specs (run per renderer against the common data-testid contract):
      ssr-html        GET / with JS disabled holds native-route, loader value
      hydration       the SSR native-layout node survives hydration (tagged
                      via evaluateOnNewDocument); native-count increments;
                      no hydration warnings or pageerror
      client-nav      Link to /about: no document request, same window marker
      back-forward    history back/forward restores routes without reload
      loader-data     /items/1 loader data from SSR and on client navigation
      action          ActionForm submit shows native-action-value; 422 field
                      error; intent=redirect -> 303 -> /about with cookie
      not-found       unknown path -> 404 + native-not-found
      error-route     ?case=error -> error boundary native-error, status 500
      head            per-route <title>/meta in SSR HTML and after client nav
      deferred        ?case=deferred streams native-deferred-pending, then
                      native-deferred-late after the held control is released
      no-hmr-client   the production page opens no HMR websocket
      dev-hmr         under modern dev, editing a sibling of Counter updates
                      it in place: same document, Counter keeps its count,
                      the layout stylesheet still applies
    Solid and Octane also run a CSR build of the same fixture
    (RENDERER_CSR=true turns server.ssr off):
      csr-shell       / is a 200 shell with one root and no server markup;
                      the client renders the route, loader data and styles
      csr-navigation  client nav, back/forward, loader data and deferred
                      data without a document request
      csr-errors      unknown route, loader not-found and loader error
                      answer 200 and render native-not-found / native-error
    Each renderer-<x>/tests/index.test.ts is about 15 lines: build, serve,
    defineRendererSpecs. A spec a renderer cannot meet is skipped in that
    one file, with a reason.

(c) scripts/ultramodern-renderers/release.mjs (~400 lines, replaces
    acceptance/release*.mjs, run.mjs, artifacts.mjs and friends)
    1. pnpm ultramodern:build-bleedingdev-publish, then
       ultramodern:prepare-bleedingdev-publish --version <v> --out <tmp>
       (or --cohort-dir to reuse one).
    2. startEphemeralRegistry({ release, releaseDir, rootDir, storeDir })
       from ultramodern-publish/lib/source-create-proof/runtime-proof.
    3. For each renderer: <packed create bin> <dir> --renderer <r>
       --no-agents-md. For Solid and Octane, install, build and serve the
       untouched starter first (GET / answers 200 with its renderer
       markup). Then copy the renderer-<r> fixture src/ over it.
    4. pnpm install with minimum_release_age 0. Newly published versions need
       no age exemptions; exact cohort integrity and no-downgrade trust remain
       required.
    5. Inside each app: a native TS 7 typecheck.
    6. rstest run -c tests/rstest.config.mts renderer-specs with
       RENDERER_TARGET_DIR=<app> and RENDERER_TARGET_BIN=<installed bin>.
       These are the same specs against the packed apps, including the
       no-react-bundle spec (d).
    7. Separate steps, unchanged entry points: react-rsc-worker-proof/
       main.mjs, renderer-mf-lifecycle-proof, run-tractor-downstream-
       acceptance.mjs.
    Output: a PASS/FAIL/SKIP table and exit code 1 on failure. No
    report.json, receipts, digests or bindings. Run it through owned-temp-dir.

(d) The one AST check to keep: bundle-check.mjs (~80 lines)
    For a Solid or Octane app, parse every dist JS file (client static/js
    and server bundles) with @babel/core parseSync. Fail if:
      - import / export-from / import() / require() names react, react-dom,
        react-server-dom-*, scheduler or react/jsx-runtime;
      - Symbol.for('react.*') appears (inlined React runtime marker).
    The no-react-bundle spec in renderer-specs runs it on every Solid and
    Octane build, in workspace and packed runs.

Deleted: the acceptance/ harness (run.mjs, release*.mjs, artifacts.mjs and
its digest/receipt layers, evidence/*.json.txt, the native-type-interop
declaration snapshots and export-octane-type-evidence, compiler-observation
and compiler-activation-proof, react-baseline-*, matrix.mts, minimum-node,
*-http-probes, prepare-octane-admission; the capability rejection probe and
the React MF probe with its manifest guard proof, which renderer-selection,
renderer-runtime-plugin and renderer-mf-lifecycle-proof cover),
capabilities/ (inventory), the renderer-solid/-octane public-programs
type harnesses (src/public-api.ts in the Solid and Octane fixtures uses the
client, server and manifest entries, so the packed fixture typecheck covers
those declarations), the conformance/
fixtures and harness unit tests, and solid-admission/production-host.mjs.
Kept: installed-cohort.mjs ("installed = packed, not workspace links") and
bundle-check.mjs (no React in native bundles). The React worker probe moved
next to its library in production-readiness/renderer-worker-lifecycle-proof;
release.mjs runs it with the RSC, MF and Tractor runners. Still to replace:
the native MF proof (solid-federation/proof.mjs) and i18n/proof.mjs, which
remain standalone until renderer-mf/ and renderer-i18n/ fixtures exist.
Out of scope here: published-create-proof/ and browser-smoke/ belong to the
ERP-10 publish lane (run-release-acceptance.mjs). They are touched only
where they import deleted helpers.
-->

# UltraModern renderer acceptance

- In-repo behavior: `tests/integration/renderer-*` (see `tests/integration/renderer-specs`).
- Native Octane Module Federation: `owned-temp-dir --run octane-federation-proof -- node tests/ultramodern-renderers/octane-federation/proof.mjs`. The source proof builds an exposed remote, an SSR host and a CSR host. It checks shared Octane/router context, remote styles, retained SSR nodes, signal state after host props change, unavailable/slow remotes, browser and server recovery after failed SSR containers, and foreign-renderer rejection.
- Packed release: `owned-temp-dir --run renderer-release -- pnpm ultramodern:renderer-release --version <x.y.z-ultramodern.N>` (or `--cohort-dir <dir>`). It also runs the React worker, RSC and Module Federation runners from `scripts/ultramodern-production-readiness` (`--with`), and Tractor with `--tractor-source`.
- Packed Solid and Octane Node deployment uses separate ordinary fixture apps, installed from the same cohort without release-age waits. The shared specs run copied `.output` with Node filesystem permissions restricted to that directory, then check HTML, hydration, styles, navigation, actions, redirects and errors.
- These fixtures prove plain-app deployment. The generated shell still requires a committed source revision and its delivery-unit release envelope; they do not prove that separate release path.
