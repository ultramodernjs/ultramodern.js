export default [
  {
    packageName: '@module-federation/enhanced',
    version: '2.9.3',
    path: 'patches/@module-federation__enhanced@2.9.3.patch',
    sha256: '63a7ef5ba6d63ff71ba84fe11c3421741171db9531111db7979960dbfe776786',
    repository: false,
    workspace: null,
    reason:
      'Retain the complete MIT-licensed inject-external-runtime-core-plugin 2.9.3 implementation inside its owning enhanced package and resolve provideExternalRuntime to it. Its unchanged runtime-tools import binds the corrected singleton; remove the external package with its incompatible exact upstream peer. Use public Webpack class/factory APIs for 5.112.2, current locations for helpers without public exports, and retain the MIT-licensed script-external parser in the owning package with generated JavaScript/maps. Recognize the exact upstream and fork package names when resolving the owning version so default manifest generation reports the actual installed fork version. Authenticated plugin source: sha512-JbadnW6TLqy0wa6GDOGl82kv0iVMWPbHiU86zFDU1KMIIbbX1Cr6gqtlFS306U7XlRS/+PLCbA/wRK/T8pbavw==. Candidate publication selects this patch independently of the active inventory.',
  },
  {
    packageName: 'rsbuild-plugin-dts',
    version: '1.0.7',
    path: 'patches/rsbuild-plugin-dts@1.0.7.patch',
    sha256: 'bd0c8f1b4c4681eeb0d1ea0123c252ad41b17f01be1ca171bd8c42ca2d652e44',
    repository: true,
    workspace: null,
    reason:
      'Resolve declaration outputs against the project root before alias rewriting and anchor discovery at that output so Windows short-path ancestors remain traversable. Preserve checked TypeScript 7 emit and alias rewriting; keep explicit native tsgo plus typescriptPath on the executable backend rather than importing typescript/sync in TypeScript 7.1; retire when the accepted Rslib dependency includes the same short-path fix.',
  },
  {
    packageName: '@tanstack/redact',
    version: '0.3.1',
    path: 'patches/@tanstack__redact@0.3.1.patch',
    sha256: 'eb9fe1549ef0b71454b287bf57affb4f819e60ee5b26f7b8826a98bb915e9f61',
    repository: false,
    workspace: null,
    reason:
      'Keep shipped source and dist behavior equivalent for streamed Suspense boundaries that stay inline when they complete before their bytes are written, tree-position useId, prefixed hexadecimal transport IDs, document-wide reveal registrations without changing upstream early-event capture or replay, stylesheet reveals that discard rejected segments, table fallback ranges and SVG/MathML integration points, deleted pending boundary ownership with subscription disposal and late-segment cleanup, Element-root metadata adoption with attempt-scoped claims and range-scoped inline lookup, error-fallback bubbling with Suspense marker placement, and synthetic events that copy non-enumerable Event fields such as the happy-dom type and target accessors (TanStack/redact#113). Upstream 0.3.1 absorbs the root-transition, retained-subscriber, hydration/store, browser-text, inline-metadata, action-scope, and error-recovery corrections; preserve its extracted Suspense hydration layer and bounded pending-task scheduler. Independent TanStack/redact SSR PRs remain pending. The tanstack-redact sidecar recipe reconstructs @bleedingdev/tanstack-redact@0.3.2 from this reviewed 0.3.1 source/dist correction and v1 stream marker; app-tools installs the signed sidecar through its exact npm:@bleedingdev/tanstack-redact alias, so the patch is not projected into repository patchedDependencies. Generated workspaces remain patch-free.',
  },
  {
    packageName: '@tanstack/router-core',
    version: '1.171.34',
    path: 'patches/@tanstack__router-core@1.171.34.patch',
    sha256: '0e526bc0a1fd038c459fbf45b2b62da81f7f2516176b585f41fed7098ac4abbb',
    repository: false,
    workspace: null,
    reason:
      'Let native localized masks inherit the canonical resolved search without rerunning middleware or validation, including public types and emitted CJS/ESM source maps. Historical correction retained for exact 1.171.34 mask qualification only; the repository resolves router-core through the authenticated native 1.171.39 artifact, so this selector must not be projected into repository patchedDependencies. Generated workspaces remain patch-free.',
  },
  {
    packageName: '@tanstack/router-core',
    version: '1.171.37',
    path: 'patches/@tanstack__router-core@1.171.37.patch',
    sha256: '6ffa70914ed338f3cb56d3cd1f526e35286e09f287ecf48ee6dbc1aa18305458',
    repository: false,
    workspace: null,
    reason:
      'Historical localized-mask correction for router-core 1.171.37. The repository now qualifies 1.171.39 with the complete owning correction, so this selector is not projected into repository patchedDependencies. Generated workspaces remain patch-free.',
  },
  {
    packageName: '@tanstack/router-core',
    version: '1.171.39',
    path: 'patches/@tanstack__router-core@1.171.39.patch',
    sha256: '6a2ebee5cc73df367ba768b9a950dee2a57ec0c93122ded77e5342ca8640df24',
    repository: false,
    workspace: null,
    reason:
      'Canonical router-core 1.171.39 correction for localized-mask search inheritance, loader lifecycle, SSR rewrites, runtime-aligned route IDs and trailing-slash navigation types. The native artifact producer must rebuild and byte-compare this exact patch before admitting a new archive; existing release descriptors remain immutable until that qualification succeeds. The repository never reapplies this producer-only correction. Generated workspaces remain patch-free.',
  },
  {
    packageName: '@effect/opentelemetry',
    version: '4.1.4',
    path: 'patches/@effect__opentelemetry@4.1.4.patch',
    sha256: '41d00660534734d73420fe8f6ca1c8df6689445babba3adea61a417d3a20b804',
    repository: false,
    workspace: null,
    reason:
      'Canonical support-producer correction binding NodeSdk, WebSdk and declarations to the current sdk-trace and sdk-logs owning APIs, retained as producer input and fixture evidence. Every repository resolution is the authenticated support 4.1.4 archive whose descriptor pins this patch SHA-256 and whose bytes already carry the correction, so the repository no longer reapplies it. Generated workspaces remain patch-free.',
  },
  {
    packageName: '@svgr/babel-plugin-transform-svg-component',
    version: '8.0.0',
    path: 'patches/@svgr__babel-plugin-transform-svg-component@8.0.0.patch',
    sha256: 'c2d9f4f67f22c7a4cbfb9dc08b9fd3a0036c661566a313b5e4726e43d659e9d2',
    repository: true,
    workspace: null,
    reason:
      'Derive tpl from template.smart.ast on the declared Babel core peer, exactly as SVGR constructs it at runtime, instead of importing an undeclared private Babel template type. Repository qualification covers Babel 8 coexistence; published consumers require the corrected authenticated sidecar closure, not this repository-only patch. Generated workspaces remain patch-free.',
  },
  {
    packageName: 'braces',
    version: '3.0.3',
    path: 'patches/braces@3.0.3.patch',
    sha256: 'e14af28f138a243a283deed5e9f26275891ad6eedc02e964d8ec7ae7efc6783a',
    repository: true,
    workspace: null,
    reason:
      'Bound parser and AST walker nesting in every repository consumer ([braces#78](https://github.com/micromatch/braces/pull/78), commit 97308a01d091b211cf015314a2d0696da28a5392); authenticated installed bytes and depth regressions guard the registry correction. Generated workspaces remain patch-free, and a mature signed dependency will replace this repository correction.',
  },
  {
    packageName: '@module-federation/bridge-react',
    version: '2.9.3',
    path: 'patches/@module-federation__bridge-react@2.9.3.patch',
    sha256: 'a30452867e1ce11c9bab1b7ca921a02d0e4ef8578d313b19bd795436f3139205',
    repository: false,
    workspace: null,
    reason:
      'Portable React declaration specifiers ([#5130](https://github.com/module-federation/core/pull/5130)).',
  },
  {
    packageName: '@module-federation/dts-plugin',
    version: '2.9.3',
    path: 'patches/@module-federation__dts-plugin@2.9.3.patch',
    sha256: 'e744a60a5c7ffd856e11a90de9c3e776e065b12aac3a94b97ed16026ce42aa03',
    repository: false,
    workspace: null,
    reason:
      'Bind the type server to port 0 and yield a busy broker port ([#5159](https://github.com/module-federation/core/pull/5159)); execute absolute compilerInstance paths without a shell ([#5131](https://github.com/module-federation/core/pull/5131)); pass the inferred rootDir to the list-files config (the rootDir hunk of [#4947](https://github.com/module-federation/core/pull/4947)). UltraModern renderer hunks: retry native API transport resets within the host attempt cap and report final failures through the public manager callback; await remote type consumption; skip unchanged native type materialization; close the DTS worker during compiler shutdown; fork the ESM broker, dev worker and runtime plugin from their .mjs files. Retire the unconsumed DTS worker witness and `dts.onDevWorkerCreated` hooks while retaining awaited shutdown and transport handling.',
  },
  {
    packageName: '@module-federation/manifest',
    version: '2.9.3',
    path: 'patches/@module-federation__manifest@2.9.3.patch',
    sha256: '550b30fe76e14f48cc64fb77c3a7920db36121dbca0d24c94227a27afe2e6b4f',
    repository: false,
    workspace: null,
    reason:
      'Load dts-plugin lazily when DTS is disabled ([#5132](https://github.com/module-federation/core/pull/5132)).',
  },
  {
    packageName: '@module-federation/modern-js-v3',
    version: '2.9.3',
    path: 'patches/@module-federation__modern-js-v3@2.9.3.patch',
    sha256: 'b9f885924b8c0b4c7d368a12d0d49257c1c38e6df867ee6eb7931490fd22c46c',
    repository: false,
    workspace: null,
    reason:
      'Resolve CLI runtime plugins through createRequire in the ESM builds ([#5133](https://github.com/module-federation/core/pull/5133)); constrain stream SSR splitChunks filters ([#4851](https://github.com/module-federation/core/pull/4851)); reset the federation runtime on server repack ([#5152](https://github.com/module-federation/core/pull/5152)); keep SSR runtime plugins out of web-worker builds ([#5155](https://github.com/module-federation/core/pull/5155)); reload SSR dev pages through the dev-server socket instead of SSRLiveReload ([#5158](https://github.com/module-federation/core/pull/5158)). Serve JavaScript with UTF-8 byte lengths so Unicode chunks are not truncated over HTTP. UltraModern renderer hunk: re-export the public React bridge base entry without React Router imports in every module format.',
  },
  {
    packageName: '@module-federation/node',
    version: '2.7.53',
    path: 'patches/@module-federation__node@2.7.53.patch',
    sha256: '7e201915b4b0cfff63c20fd1a6980e16946ef76792ea8c707cd09d9fcd8a4809',
    repository: false,
    workspace: null,
    reason:
      'Align Node chunk loading with startup readiness and preserve per-runtime chunk state ([#5192](https://github.com/module-federation/core/pull/5192)); reset the federation runtime in performReload ([#5152](https://github.com/module-federation/core/pull/5152)) and guard the bundle-only module cache when called from plain Node ([#5158](https://github.com/module-federation/core/pull/5158)).',
  },
  {
    packageName: '@module-federation/rspack',
    version: '2.9.3',
    path: 'patches/@module-federation__rspack@2.9.3.patch',
    sha256: 'ffab46cc34e8d63543dfaf46c13a54f5393724b41da706dd0dc3777ae543fcf4',
    repository: false,
    workspace: null,
    reason:
      'Load dts-plugin lazily when DTS is disabled ([#5132](https://github.com/module-federation/core/pull/5132)).',
  },
  {
    packageName: '@module-federation/runtime-core',
    version: '2.9.3',
    path: 'patches/@module-federation__runtime-core@2.9.3.patch',
    sha256: 'adb0e091fad6816d03f1d1786df07835d0650a1f44ae97c6b3f2223c4259dec9',
    repository: false,
    workspace: null,
    reason:
      'Add helpers.global.resetFederationRuntime() for rebuilt server bundles ([#5152](https://github.com/module-federation/core/pull/5152)). Forward the public fetch lifecycle to the canonical Node entry loader so transport failures can settle and retry without replacing the loader or clearing healthy caches.',
  },
  {
    packageName: '@module-federation/sdk',
    version: '2.9.3',
    path: 'patches/@module-federation__sdk@2.9.3.patch',
    sha256: 'fb4b0dfd33a0588ad3821f1d56e2316044ae0b721c515a69080d7d9d9de72e3e',
    repository: true,
    workspace: null,
    reason:
      'Call the documented Node fetch hook with its URL/options tuple and declare it on loadScriptNode; preserve native response and fallback behavior. Retire only failed ESM modules so imported fetch, link and evaluation failures can retry while healthy shared modules remain cached.',
  },
];
