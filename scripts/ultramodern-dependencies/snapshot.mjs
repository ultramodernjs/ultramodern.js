export const sourceRevision = '319279bf5d7c833d7fa38a91520ab16b2b5bc99b';
export const queriedAt = {
  start: '2026-11-16T00:25:28.366Z',
  end: '2026-11-16T00:28:35.127Z',
};
export const rslibPatchSha256 =
  'bd0c8f1b4c4681eeb0d1ea0123c252ad41b17f01be1ca171bd8c42ca2d652e44';

// Immutable reviewed merge (PR #342) carrying the qualified support-v4 cohort
// (producer source bea0d22f, run 44174451205 attempt 1). Its manifests grant only
// their exact support-owned metadata and selections, not other edges or URLs.
// This is a reviewed manifest baseline, not full release acceptance.
export const supportBaselineRevision =
  '75e3d5f6bccaac893773e33b65eb585bf7c8e936';

// The same reviewed merge carries qualified native source 7d4e7415
// (run 44303834194 attempt 1, Octane 0.20). It grants only its exact native-owned
// metadata and selections; a newer descriptor still needs admission.
export const nativeBaselineRevision =
  '75e3d5f6bccaac893773e33b65eb585bf7c8e936';

// Owning source and actual packed runtime/type qualification establish this
// consolidation. Corrected OTel distribution and release acceptance stay separate.
export const traceConsolidation = Object.freeze({
  path: 'packages/server/bff-effect/package.json',
  from: Object.freeze({
    '@opentelemetry/sdk-trace-base': '2.12.0',
    '@opentelemetry/sdk-trace-node': '2.12.0',
    '@opentelemetry/sdk-trace-web': '2.12.0',
  }),
  name: '@opentelemetry/sdk-trace',
  version: '3.1.1',
});

// Explicitly reviewed source transitions. These are not claims that native CI,
// corrected assets or new sidecar publication/consumer acceptance have passed.
const mfTransitions = Object.fromEntries(
  [
    'bridge-react',
    'cli',
    'dts-plugin',
    'enhanced',
    'manifest',
    'modern-js-v3',
    'rsbuild-plugin',
    'rspack',
    'runtime',
    'runtime-core',
    'runtime-tools',
    'sdk',
    'webpack-bundler-runtime',
  ].map(name => [
    `@module-federation/${name}`,
    {
      from: [
        '2.9.2',
        `npm:@bleedingdev/mf-${name}@${name === 'modern-js-v3' ? '2.9.4' : name === 'sdk' ? '2.9.2' : '2.9.3'}`,
      ],
      to: `npm:@bleedingdev/mf-${name}@2.9.5`,
    },
  ]),
);
// Registry declarations reviewed against the immutable .7 checkout.
// The isolated renderer build inputs and broad consumer peers are not moved.
const registryAdvances = {
  '@rsbuild/core': { from: ['2.3.2'], to: '2.3.3' },
  '@rspack/core': { from: ['2.2.9'], via: ['2.3.2'], to: '2.3.3' },
  '@vercel/nft': {
    from: ['^1.11.0'],
    via: ['^1.11.2', '^1.11.6'],
    to: '1.11.7',
  },
  antd: { from: ['^6.6.6'], via: ['^6.7.0'], to: '6.7.1' },
  browserslist: { from: ['4.29.5'], to: '4.29.6' },
  'es-module-lexer': { from: ['^3.0.4'], to: '3.0.5' },
  filesize: {
    from: ['11.0.26'],
    via: ['11.0.32', '11.0.34'],
    to: '11.0.35',
  },
  hono: { from: ['^4.13.13'], via: ['^4.13.18'], to: '4.13.19' },
  i18next: { from: ['26.4.6'], via: ['27.1.2'], to: '27.1.5' },
  'i18next-browser-languagedetector': { from: ['^8.3.0'], to: '8.3.1' },
  'i18next-http-middleware': {
    from: ['^3.10.0'],
    via: ['^3.10.2'],
    to: '3.10.3',
  },
  minimatch: { from: ['^10.2.6'], via: ['^11.0.8'], to: '11.0.9' },
  oxfmt: { from: ['0.73.0'], via: ['0.78.0'], to: '0.79.0' },
  oxlint: { from: ['1.88.0'], via: ['1.93.0'], to: '1.94.0' },
  'path-serializer': { from: ['0.7.0'], to: '0.8.1' },
  'postcss-custom-properties': { from: ['15.0.4'], to: '15.0.5' },
  puppeteer: { from: ['^25.14.0'], via: ['^25.17.0'], to: '25.18.1' },
  'react-i18next': { from: ['17.0.18'], via: ['18.0.1'], to: '18.0.2' },
  rollup: {
    from: ['^4.64.7'],
    via: ['^4.68.3', '^4.68.5'],
    to: '4.68.6',
  },
  seroval: { from: ['1.6.9'], via: ['1.8.1'], to: '1.8.2' },
  'type-fest': { from: ['5.10.0'], to: '6.0.1' },
  vitest: { from: ['^5.0.5'], via: ['^5.1.0'], to: '5.1.1' },
};
export const coordinatedTransitions = Object.freeze({
  ...registryAdvances,
  ...mfTransitions,
  '@module-federation/node': {
    from: ['2.7.52', 'npm:@bleedingdev/mf-node@2.7.53'],
    to: 'npm:@bleedingdev/mf-node@2.7.54',
  },
  '@tanstack/redact': {
    from: ['npm:@bleedingdev/tanstack-redact@0.2.2'],
    to: 'npm:@bleedingdev/tanstack-redact@0.3.2',
  },
  ultracite: {
    from: ['8.0.1'],
    to: 'npm:@bleedingdev/ultracite@8.2.2',
  },
  '@effect/tsgo': { from: ['0.67.0'], via: ['0.69.0'], to: '0.70.0' },
  tsrs: { from: ['0.21.0-ts7.1.0-beta'], to: '0.25.0-ts7.1.0-beta' },
  '@solidjs/compiler': {
    from: ['2.0.0-rc.15'],
    via: ['2.0.0-rc.22', '2.0.0'],
    to: '2.0.1',
  },
  '@solidjs/signals': {
    from: ['2.0.0-rc.15'],
    via: ['2.0.0-rc.22', '2.0.0'],
    to: '2.0.1',
  },
  '@solidjs/web': {
    from: ['2.0.0-rc.15'],
    via: ['2.0.0-rc.22', '2.0.0'],
    to: '2.0.1',
  },
  'solid-js': {
    from: ['2.0.0-rc.15'],
    via: ['2.0.0-rc.22', '2.0.0'],
    to: '2.0.1',
  },
  miniflare: { from: ['5.20261012.0-beta'], to: '5.20261113.0-beta' },
  wrangler: { from: ['4.151.0'], to: '4.162.0' },
  '@cloudflare/workers-types': {
    from: ['5.20261015.1'],
    to: '5.20261115.1',
  },
  'react-router': { from: ['7.18.4', '^7.18.4'], to: '8.5.1' },
  '@rslib/core': { from: ['1.0.3'], to: '1.0.7' },
});

export const satisfiedExceptions = Object.freeze({
  'postcss-initial': '4.0.1',
  '@rsbuild-image/core': '0.0.1-next.36',
  '@rsbuild-image/react': '0.0.1-next.36',
});

// Exact reviewed edge additions (`from: null`) and removals (`to: null`) made
// after sourceRevision. The updater accepts but never performs these edits:
// `from` is the sourceRevision value; `commit` records review provenance, not
// a runtime ancestry requirement on feature commits rewritten by rebasing.
const reviewedTransition = (commit, path, field, name, from, to) =>
  Object.freeze({ commit, path, field, name, from, to });
const cohortCommit = 'efa682f9254ef4b8b4beb9a0612df8b161d47bbf';
const solidDeclarationsCommit = 'a08a714015d1a8403e6b328049317027c19674a9';
const svgrDeclarationsCommit = '7c27dc97387bbac67c051c9865bce114d04779b8';
const declarationPluginSupportCommit =
  'ca40fbecaff494fe71a9960960ff84f394a4933f';
const serverCompilerOwnerCommit = '3961f60e3ffef65183ecea01d803a6b552c19239';
const scriptGlobCommit = 'dd35a9f82d9ccbb29cbcfd625708a267e449db45';
const utilsGlobCommit = 'a6e3eac3381fa9c01ff9c344ffa0e35975cabf24';
const appTools = 'packages/solutions/app-tools/package.json';
const ultramodernAppTools =
  'packages/solutions/ultramodern-app-tools/package.json';
const appToolsExtensions =
  'packages/solutions/app-tools-extensions/package.json';
export const reviewedTransitions = Object.freeze([
  reviewedTransition(
    scriptGlobCommit,
    'scripts/lint-package-json/package.json',
    'dependencies',
    'fast-glob',
    '3.3.3',
    null,
  ),
  reviewedTransition(
    scriptGlobCommit,
    'scripts/prebundle/package.json',
    'devDependencies',
    'fast-glob',
    '3.3.3',
    null,
  ),
  reviewedTransition(
    utilsGlobCommit,
    'scripts/prebundle/package.json',
    'devDependencies',
    'globby',
    '16.2.4',
    null,
  ),
  reviewedTransition(
    utilsGlobCommit,
    'packages/toolkit/utils/package.json',
    'dependencies',
    'fast-glob',
    '3.3.3',
    null,
  ),
  reviewedTransition(
    cohortCommit,
    ultramodernAppTools,
    'dependencies',
    'rsbuild-redact-plugin',
    '0.1.0',
    null,
  ),
  reviewedTransition(
    cohortCommit,
    'examples/module-federation/app-export/host/package.json',
    'dependencies',
    'react-router',
    '^7.18.4',
    null,
  ),
  // Solid compiler declarations reference convert-source-map types.
  reviewedTransition(
    solidDeclarationsCommit,
    'packages/runtime/renderer-solid/package.json',
    'dependencies',
    '@types/convert-source-map',
    null,
    '2.0.3',
  ),
  // SVGR option declarations are bundled by app-tools-extensions, so their
  // type-only inputs leave the published tool dependency surfaces.
  ...[appTools, ultramodernAppTools].flatMap(path => [
    reviewedTransition(
      svgrDeclarationsCommit,
      path,
      'dependencies',
      '@types/babel__core',
      '^7.20.5',
      null,
    ),
    reviewedTransition(
      svgrDeclarationsCommit,
      path,
      'dependencies',
      'prettier',
      '~3.9.10',
      null,
    ),
  ]),
  ...[
    ['@rsbuild/plugin-svgr', '2.0.5'],
    ['@types/babel__core', '^7.20.5'],
    ['prettier', '~3.10.1'],
  ].map(([name, to]) =>
    reviewedTransition(
      svgrDeclarationsCommit,
      appToolsExtensions,
      'devDependencies',
      name,
      null,
      to,
    ),
  ),
  // The native server compiler imports the support-corrected declaration
  // plugin from its host. The repository installs the raw exact version,
  // corrected by the root patch; publication hosts select the archive.
  ...['peerDependencies', 'devDependencies'].map(field =>
    reviewedTransition(
      declarationPluginSupportCommit,
      appToolsExtensions,
      field,
      'rsbuild-plugin-dts',
      null,
      '1.0.7',
    ),
  ),
  // The server compiler moved from server-utils into app-tools-extensions,
  // which now owns its Rslib and TypeScript runtime inputs; server-utils
  // depends on that owner instead of the reverse.
  reviewedTransition(
    serverCompilerOwnerCommit,
    'packages/server/utils/package.json',
    'dependencies',
    '@modern-js/app-tools-extensions',
    null,
    'workspace:*',
  ),
  ...[
    ['@rslib/core', '1.0.3'],
    ['typescript', '7.0.2'],
  ].map(([name, from]) =>
    reviewedTransition(
      serverCompilerOwnerCommit,
      'packages/server/utils/package.json',
      'dependencies',
      name,
      from,
      null,
    ),
  ),
  reviewedTransition(
    serverCompilerOwnerCommit,
    appToolsExtensions,
    'dependencies',
    '@modern-js/server-utils',
    'workspace:*',
    null,
  ),
  ...[
    ['@rslib/core', '1.0.7'],
    ['typescript', '7.0.2'],
  ].map(([name, to]) =>
    reviewedTransition(
      serverCompilerOwnerCommit,
      appToolsExtensions,
      'dependencies',
      name,
      null,
      to,
    ),
  ),
  reviewedTransition(
    serverCompilerOwnerCommit,
    appToolsExtensions,
    'devDependencies',
    '@rslib/core',
    '1.0.3',
    null,
  ),
]);

// DOM v7 is only a re-export parent of router v7. These consumers have no DOM
// imports and the MF producer re-exports its router-free bridge/base entry.
export const routerDomRemovals = Object.freeze([
  {
    path: 'examples/module-federation/app-export/host/package.json',
    from: '^7.18.4',
  },
  {
    path: 'examples/module-federation/base/host/package.json',
    from: '^7.18.4',
  },
  { path: 'tests/e2e/builder/package.json', from: '7.18.4' },
]);

// Reviewed registry snapshot, not a request to resolve moving dist-tags.
export const targets = Object.freeze({
  '@babel/core': '8.1.2',
  '@babel/parser': '8.1.2',
  '@babel/traverse': '8.1.2',
  '@babel/types': '8.1.2',
  '@babel/plugin-transform-modules-commonjs': '8.1.2',
  '@biomejs/biome': '2.6.8',
  '@commitlint/cli': '21.2.4',
  '@commitlint/config-conventional': '21.2.4',
  '@effect/opentelemetry': '4.1.4',
  '@effect/tsgo': '0.70.0',
  '@modelcontextprotocol/client': '2.4.0',
  '@modelcontextprotocol/ext-apps': '2.0.4',
  '@modelcontextprotocol/server': '2.4.0',
  '@module-federation/bridge-react': '2.9.3',
  '@module-federation/cli': '2.9.3',
  '@module-federation/dts-plugin': '2.9.3',
  '@module-federation/enhanced': '2.9.3',
  '@module-federation/manifest': '2.9.3',
  '@module-federation/modern-js-v3': '2.9.3',
  '@module-federation/node': '2.7.53',
  '@module-federation/rsbuild-plugin': '2.9.3',
  '@module-federation/rspack': '2.9.3',
  '@module-federation/runtime': '2.9.3',
  '@module-federation/runtime-core': '2.9.3',
  '@module-federation/runtime-tools': '2.9.3',
  '@module-federation/sdk': '2.9.3',
  '@module-federation/webpack-bundler-runtime': '2.9.3',
  '@octanejs/rspack-plugin': '0.2.12',
  '@octanejs/tanstack-router': '0.3.6',
  '@opentelemetry/api': '1.10.0',
  '@opentelemetry/resources': '3.1.1',
  '@opentelemetry/sdk-logs': '3.1.1',
  '@opentelemetry/sdk-metrics': '3.1.1',
  '@opentelemetry/sdk-trace': '3.1.1',
  '@opentelemetry/semantic-conventions': '1.45.0',
  '@playwright/test': '1.65.1',
  '@rsbuild/plugin-check-syntax': '2.1.0',
  '@rsbuild/plugin-typed-css-modules': '1.3.0',
  '@rslib/core': '1.0.7',
  '@rspress/core': '2.1.3',
  '@rspress/plugin-llms': '2.1.3',
  '@rspress/shared': '2.1.3',
  '@rstest/adapter-rsbuild': '0.12.6',
  '@rstest/browser': '0.12.6',
  '@rstest/browser-react': '0.12.6',
  '@rstest/core': '0.12.6',
  '@shikijs/transformers': '4.6.0',
  '@solidjs/compiler': '2.0.1',
  '@solidjs/signals': '2.0.1',
  '@solidjs/web': '2.0.1',
  '@storybook/addon-docs': '10.6.7',
  '@storybook/addon-onboarding': '10.6.7',
  '@storybook/react': '10.6.7',
  '@swc/core': '1.16.22',
  '@swc/helpers': '0.5.24',
  '@swc/plugin-loadable-components': '17.0.2',
  '@tailwindcss/postcss': '4.3.5',
  '@tanstack/react-router': '1.170.46',
  '@tanstack/redact': '0.3.1',
  '@tanstack/router-core': '1.171.39',
  '@tsconfig/strictest': '2.0.9',
  '@tsrx/oxc': '0.24.0',
  '@types/inquirer': '10.0.0',
  '@types/ioredis-mock': '8.2.8',
  '@types/jsdom': '30.0.0',
  '@types/node': '26.6.6',
  '@types/react': '19.3.0',
  '@types/react-dom': '19.3.0',
  '@vitejs/plugin-react': '6.3.0',
  '@volar/language-core': '2.4.31',
  axios: '1.21.1',
  'caniuse-lite': '1.0.30001826',
  'check-dependency-version-consistency': '6.0.1',
  chokidar: '6.0.0',
  commander: '15.1.0',
  cookie: '2.0.2',
  'core-js': '3.51.0',
  cssnano: '9.9.0',
  dotenv: '18.0.10',
  effect: '4.1.4',
  'enhanced-resolve': '5.27.0',
  entities: '9.0.0',
  execa: '10.2.1',
  glob: '14.0.6',
  'http-compression': '1.2.0',
  'http-proxy-middleware': '4.2.2',
  'i18next-chained-backend': '5.0.8',
  'i18next-fs-backend': '2.6.12',
  'i18next-http-backend': '4.0.10',
  inquirer: '14.3.0',
  'ioredis-mock': '8.13.1',
  ipx: '4.1.0',
  isbot: '5.2.3',
  jsdom: '31.0.1',
  koa: '3.3.0',
  'lint-staged': '17.6.1',
  memfs: '4.80.1',
  mermaid: '12.3.0',
  nock: '15.0.6',
  nx: '24.0.6',
  octane: '0.20.0',
  ora: '10.0.0',
  'path-to-regexp': '9.0.0',
  'pkg-types': '2.4.0',
  playwright: '1.65.1',
  'playwright-core': '1.65.1',
  postcss: '8.5.33',
  prettier: '3.10.1',
  qs: '6.17.1',
  react: '19.3.1',
  'react-dom': '19.3.1',
  'react-helmet-async': '3.1.0',
  'react-router': '8.5.1',
  'react-router-dom': '7.18.5',
  'react-server-dom-rspack': '0.1.1',
  rimraf: '6.1.4',
  'rsbuild-plugin-dts': '1.0.7',
  'rsbuild-redact-plugin': '0.2.0',
  sass: '1.108.2',
  'sass-embedded': '1.108.2',
  semver: '7.8.6',
  seroval: '1.8.2',
  'seroval-plugins': '1.8.0',
  'solid-js': '2.0.1',
  storybook: '10.6.7',
  'storybook-addon-modernjs': '3.6.3',
  'storybook-react-rsbuild': '3.6.3',
  supertest: '7.3.2',
  tailwindcss: '4.3.5',
  tsrs: '0.25.0-ts7.1.0-beta',
  typescript: '7.0.2',
  ultracite: '8.2.1',
  'url-join': '6.0.0',
  vite: '8.3.8',
  vitest: '5.1.1',
  vue: '3.5.45',
  webpack: '5.112.2',
  ws: '8.23.0',
  'zephyr-agent': '1.8.0',
  'zephyr-modernjs-plugin': '1.8.0',
  'zephyr-rspack-plugin': '1.8.0',
  zod: '4.6.7',
  ...Object.fromEntries(
    Object.entries(registryAdvances).map(([name, { to }]) => [name, to]),
  ),
});

export const holds = Object.freeze({
  '@effect/tsgo': 'compiler source/capability/platform payload review',
  tsrs: 'compiler source/capability/platform payload review',
  '@tanstack/react-router': 'router-core correction and exact router cohort',
  '@tanstack/router-core':
    'corrected archive, canonical patch and renderer ABI',
  '@tanstack/redact': 'signed correction and latest Rsbuild plugin rejects 0.3',
  'rsbuild-redact-plugin': 'signed Redact correction and plugin peer contract',
  '@octanejs/rspack-plugin': 'corrected renderer artifact and source profile',
  '@octanejs/tanstack-router':
    'corrected renderer artifact and router-core pin',
  octane: 'corrected renderer artifact, TypeScript and OXC compatibility',
  'react-router-dom': 'move router/DOM consumers together after peer review',
  'postcss-initial': '4.0.1 is newer than latest tag 3.0.4; never downgrade',
  '@rsbuild-image/core': 'no stable release beyond existing next.36',
  '@rsbuild-image/react': 'no stable release beyond existing next.36',
  miniflare: 'Wrangler v5 beta contract; latest tag is v4',
  ultracite: 'upstream MIT notice correction and exact sidecar identity',
});

// These declaration names were current in the same registry snapshot. Their
// exact old values are still authenticated against sourceRevision on every run.
export const currentNames = new Set(
  `
@changesets/assemble-release-plan @changesets/cli @changesets/config @changesets/read
@codesandbox/sandpack-react @jridgewell/remapping @jridgewell/trace-mapping
@loadable/component @loadable/server @manypkg/get-packages
@modern-js/codesmith @modern-js/codesmith-api-handlebars @modern-js/codesmith-utils
@modern-js/polyfill-lib @opentelemetry/api-logs @opentelemetry/sdk-trace-base
@opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-web @remix-run/web-fetch
@rollup/plugin-json @rsbuild/core @rsbuild/plugin-assets-retry @rsbuild/plugin-babel
@rsbuild/plugin-css-minimizer @rsbuild/plugin-less @rsbuild/plugin-react
@rsbuild/plugin-rem @rsbuild/plugin-sass @rsbuild/plugin-source-build
@rsbuild/plugin-styled-components @rsbuild/plugin-svgr @rsbuild/plugin-tailwindcss
@rsbuild/plugin-type-check @rsdoctor/rspack-plugin @svgr/core @svgr/plugin-jsx
@svgr/plugin-svgo @tanstack/history @testing-library/dom @testing-library/jest-dom
@testing-library/react @types/babel__core @types/babel__traverse
@types/cloneable-readable @types/connect @types/connect-history-api-fallback
@types/debug @types/express @types/fs-extra @types/html-minifier-terser
@types/invariant @types/ioredis-mock @types/jest @types/js-yaml @types/koa
@types/koa-compose @types/less @types/loadable__component @types/loadable__server
@types/lodash @types/lodash-es @types/merge-deep @types/mime-types @types/minimist
@types/normalize-path @types/qs @types/react-helmet @types/recursive-readdir
@types/semver @types/serve-static @types/signale @types/styled-components
@types/supertest @types/type-is @types/ua-parser-js @types/ws
@typescript/typescript6 @vercel/ncc @web-std/fetch @web-std/file @web-std/stream
address autoprefixer babel-plugin-macros browserslist chalk classnames client-only
cloneable-readable clsx compression-webpack-plugin connect connect-history-api-fallback
consola cross-spawn debug devcert dotenv-expand encoding es-module-lexer esbuild
express farrow-api farrow-pipeline farrow-schema fast-glob find-up find-workspaces
flatted fs-extra get-port gh-pages globby gzip-size happy-dom html-minifier-terser
husky i18next-browser-languagedetector import-lazy import-meta-resolve invariant
ioredis ioredis-mock jiti js-yaml json5 jsonc-parser kill-port koa-compose lefthook less lodash
lodash-es lru-cache micromatch mime-types minimist mlly nanoid ndepe
node-mocks-http normalize-path p-map path-serializer pg postcss-custom-properties
postcss-flexbugs-fixes postcss-font-variant postcss-media-minmax postcss-nesting
postcss-page-break postcss-value-parser react-helmet react-is recursive-readdir
reflect-metadata resolve.exports rollup-plugin-dts rsbuild-plugin-open-graph rsbuild-plugin-rsc rslog
rspack-manifest-plugin rxjs serve-static server-only sharp signal-exit signale slash
source-map std-env strip-ansi styled-components terser tree-kill ts-deepmerge ts-node
tsconfig-paths tsx twin.macro type-fest type-is ua-parser-js upath websocket ws yaml
`
    .trim()
    .split(/\s+/),
);

// Descriptor admission is limited to these existing owning declarations. This
// table grants no URL authority; the async byte/authentication boundary does.
export const artifactOwners = Object.freeze({
  nativeArtifacts: Object.freeze({
    'packages/runtime/renderer-octane/package.json': [
      'octane',
      '@octanejs/tanstack-router',
      '@octanejs/rspack-plugin',
      '@tanstack/router-core',
    ],
    'packages/runtime/renderer-solid/package.json': ['@tanstack/router-core'],
    'packages/runtime/plugin-tanstack/package.json': ['@tanstack/router-core'],
    'packages/solutions/ultramodern-app-tools/package.json': [
      'octane',
      '@octanejs/rspack-plugin',
    ],
    'packages/toolkit/ultramodern-create/package.json': [
      'octane',
      '@octanejs/rspack-plugin',
    ],
    'tests/integration/renderer-octane/package.json': [
      'octane',
      '@octanejs/tanstack-router',
      '@octanejs/rspack-plugin',
      '@tanstack/router-core',
    ],
    'tests/ultramodern-renderers/octane-admission/package.json': [
      'octane',
      '@octanejs/tanstack-router',
      '@octanejs/rspack-plugin',
      '@tanstack/router-core',
    ],
  }),
  supportArtifacts: Object.freeze({
    'package.json': ['@rstest/core'],
    'packages/cli/adapter-rstest/package.json': ['@rstest/core'],
    'packages/runtime/i18n-integration/package.json': ['@rstest/core'],
    'packages/toolkit/backend-federation-contracts/package.json': [
      '@rstest/core',
    ],
    'packages/toolkit/surface-resolution/package.json': ['@rstest/core'],
    'tests/package.json': ['@rstest/core'],
    'tests/integration/rstest/basic-app-rstest/package.json': ['@rstest/core'],
    'tests/integration/rstest/basic-app-rstest-browser/package.json': [
      '@rstest/core',
    ],
    'packages/runtime/renderer-solid/package.json': ['solid-js'],
    'tests/integration/renderer-solid/package.json': ['solid-js'],
    'packages/runtime/plugin-tanstack/package.json': ['@tanstack/react-router'],
    'packages/toolkit/runtime-utils/package.json': [
      'ioredis-mock',
      '@types/ioredis-mock',
    ],
    'packages/cli/plugin-bff-build-extensions/package.json': [
      '@effect/opentelemetry',
    ],
    'packages/cli/plugin-bff-extensions/package.json': [
      '@effect/opentelemetry',
    ],
    'packages/server/bff-effect/package.json': ['@effect/opentelemetry'],
    'tests/integration/bff-cross-project/bff-api-app/package.json': [
      '@effect/opentelemetry',
    ],
    'tests/integration/bff-effect/package.json': ['@effect/opentelemetry'],
    'tests/integration/i18n/routes-localised-urls/package.json': [
      '@effect/opentelemetry',
    ],
    'tests/integration/superapp-portfolio/package.json': [
      '@effect/opentelemetry',
    ],
    'tests/integration/routes-tanstack-mf/mf-host/package.json': [
      '@effect/opentelemetry',
      '@tanstack/react-router',
    ],
    'tests/integration/routes-tanstack-mf/mf-remote/package.json': [
      '@effect/opentelemetry',
      '@tanstack/react-router',
    ],
    'tests/integration/routes-tanstack-mf/mf-remote-2/package.json': [
      '@effect/opentelemetry',
      '@tanstack/react-router',
    ],
    // The generator declares no support input itself; it reads this metadata
    // from its own manifest and emits the admitted requests into generated apps.
    'packages/toolkit/ultramodern-create/package.json': [],
    // Framework peer owner: commits to the descriptor, keeps raw exact inputs.
    'packages/solutions/app-tools-extensions/package.json': [],
  }),
});

for (const owners of Object.values(artifactOwners))
  for (const names of Object.values(owners)) Object.freeze(names);
