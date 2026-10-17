export default [
  {
    packageName: '@tanstack/router-core',
    version: '1.171.34',
    path: 'patches/@tanstack__router-core@1.171.34.patch',
    sha256: '0e526bc0a1fd038c459fbf45b2b62da81f7f2516176b585f41fed7098ac4abbb',
    repository: true,
    workspace: null,
    reason:
      'Let native localized masks inherit the canonical resolved search without rerunning middleware or validation, including public types and emitted CJS/ESM source maps. Applies only to the accepted Octane router-core 1.171.34 closure during local qualification. Generated workspaces remain patch-free; retire when their mature accepted router sidecar or upstream release supplies the same runtime and declaration contract.',
  },
  {
    packageName: '@tanstack/router-core',
    version: '1.171.37',
    path: 'patches/@tanstack__router-core@1.171.37.patch',
    sha256: '6ffa70914ed338f3cb56d3cd1f526e35286e09f287ecf48ee6dbc1aa18305458',
    repository: true,
    workspace: null,
    reason:
      'Let native localized masks inherit the canonical resolved search without rerunning middleware or validation, preserving current location caching and SSR rewrite behavior, public types and emitted CJS/ESM source maps. Applies only to Modern router-core 1.171.37 during local qualification. Generated workspaces remain patch-free; retire when their mature accepted router sidecar or upstream release supplies the same runtime and declaration contract.',
  },
  {
    packageName: 'ultracite',
    version: '8.0.1',
    path: 'patches/ultracite@8.0.1.patch',
    sha256: 'a18b2c7be68a6823a793f0def8ce13d7655c67c56c2200978a2be600cb29ba74',
    repository: false,
    workspace: null,
    reason:
      'Include the upstream MIT notice omitted from the npm artifact, preserving the exact license.md bytes at registry source commit e948def3e0b1bdba2c4264c183d960f6a05ed61f.',
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
    version: '2.9.2',
    path: 'patches/@module-federation__bridge-react@2.9.2.patch',
    sha256: '2d8a06e2ef045f877d6b0c5f741053dc8183cb6194f42b704357f426f315d0db',
    repository: true,
    workspace: null,
    reason:
      'Portable React declaration specifiers ([#5130](https://github.com/module-federation/core/pull/5130)).',
  },
  {
    packageName: '@module-federation/dts-plugin',
    version: '2.9.2',
    path: 'patches/@module-federation__dts-plugin@2.9.2.patch',
    sha256: 'f93107fb896839b94ca31491774b920c82a3cc31dda8fd9e53d06b47ad72cba0',
    repository: true,
    workspace: null,
    reason:
      'Bind the type server to port 0 and yield a busy broker port ([#5159](https://github.com/module-federation/core/pull/5159)); execute absolute compilerInstance paths without a shell ([#5131](https://github.com/module-federation/core/pull/5131)); pass the inferred rootDir to the list-files config (the rootDir hunk of [#4947](https://github.com/module-federation/core/pull/4947)). UltraModern renderer hunks: retry native API transport resets within the host attempt cap and report final failures through the public manager callback; await remote type consumption; skip unchanged native type materialization; close the DTS worker during compiler shutdown; fork the ESM broker, dev worker and runtime plugin from their .mjs files. The DTS worker witness and `dts.onDevWorkerCreated` hunks have no consumer and drop at the next mf-dts-plugin sidecar version.',
  },
  {
    packageName: '@module-federation/manifest',
    version: '2.9.2',
    path: 'patches/@module-federation__manifest@2.9.2.patch',
    sha256: 'bbb5b50645aa4f67570bf2a361f92cd24c15a90e471f81057b28e01abbd80f03',
    repository: true,
    workspace: null,
    reason:
      'Load dts-plugin lazily when DTS is disabled ([#5132](https://github.com/module-federation/core/pull/5132)).',
  },
  {
    packageName: '@module-federation/modern-js-v3',
    version: '2.9.2',
    path: 'patches/@module-federation__modern-js-v3@2.9.2.patch',
    sha256: 'b0e1d695fb33da011494338e16294c5fd2961c655774b014712750f2b7f52b86',
    repository: true,
    workspace: null,
    reason:
      'Resolve CLI runtime plugins through createRequire in the ESM builds ([#5133](https://github.com/module-federation/core/pull/5133)); constrain stream SSR splitChunks filters ([#4851](https://github.com/module-federation/core/pull/4851)); reset the federation runtime on server repack ([#5152](https://github.com/module-federation/core/pull/5152)); keep SSR runtime plugins out of web-worker builds ([#5155](https://github.com/module-federation/core/pull/5155)); reload SSR dev pages through the dev-server socket instead of SSRLiveReload ([#5158](https://github.com/module-federation/core/pull/5158)). Serve JavaScript with UTF-8 byte lengths so Unicode chunks are not truncated over HTTP. UltraModern renderer hunk: re-export the public React bridge base entry without React Router imports in every module format.',
  },
  {
    packageName: '@module-federation/node',
    version: '2.7.52',
    path: 'patches/@module-federation__node@2.7.52.patch',
    sha256: '69e8251a310c4a1f3cf338f8dfe27e4c6a4833dcd8a81155967d154689e2bce7',
    repository: true,
    workspace: null,
    reason:
      'Align Node chunk loading with startup readiness and preserve per-runtime chunk state ([#5192](https://github.com/module-federation/core/pull/5192)); reset the federation runtime in performReload ([#5152](https://github.com/module-federation/core/pull/5152)) and guard the bundle-only module cache when called from plain Node ([#5158](https://github.com/module-federation/core/pull/5158)).',
  },
  {
    packageName: '@module-federation/rspack',
    version: '2.9.2',
    path: 'patches/@module-federation__rspack@2.9.2.patch',
    sha256: '06641dcd38197ccc8831f0dca7f6ff37b05ee2e771686816cc3d3f3c57c0e8af',
    repository: true,
    workspace: null,
    reason:
      'Load dts-plugin lazily when DTS is disabled ([#5132](https://github.com/module-federation/core/pull/5132)).',
  },
  {
    packageName: '@module-federation/runtime-core',
    version: '2.9.2',
    path: 'patches/@module-federation__runtime-core@2.9.2.patch',
    sha256: '8f844e9c948e1e0b8fa183bf3e8c87f9e7fa9d9abbab91cdf0aeb708123b574e',
    repository: true,
    workspace: null,
    reason:
      'Add helpers.global.resetFederationRuntime() for rebuilt server bundles ([#5152](https://github.com/module-federation/core/pull/5152)). Forward the public fetch lifecycle to the canonical Node entry loader so transport failures can settle and retry without replacing the loader or clearing healthy caches.',
  },
  {
    packageName: '@module-federation/sdk',
    version: '2.9.2',
    path: 'patches/@module-federation__sdk@2.9.2.patch',
    sha256: 'fb4b0dfd33a0588ad3821f1d56e2316044ae0b721c515a69080d7d9d9de72e3e',
    repository: true,
    workspace: null,
    reason:
      'Call the documented Node fetch hook with its URL/options tuple and declare it on loadScriptNode; preserve native response and fallback behavior. Retire only failed ESM modules so imported fetch, link and evaluation failures can retry while healthy shared modules remain cached.',
  },
];
