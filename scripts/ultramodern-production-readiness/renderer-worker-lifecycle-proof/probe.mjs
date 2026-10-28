import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readReleaseManifest } from '../../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import {
  readCohort,
  readInstalledPackageFiles,
  verifyInstalledPackage,
} from '../../ultramodern-renderers/installed-cohort.mjs';
import {
  fileEvidence,
  ordinaryFiles,
  workerOptions,
} from '../react-rsc-worker-proof/contract.mjs';
import {
  createWorkerLifecycleSources,
  verifyWorkerLifecycle,
} from './index.mjs';
import {
  assertCompiledReactRuntime,
  effectiveRuntimePackage,
  workerRuntimeConfig,
} from './runtime-contract.mjs';
import {
  assertBinding,
  atomicJson,
  launch,
  registerArtifact,
  removeOwnedLeaf,
  sha256,
  sourceEvidence,
  within,
} from './support.mjs';

const script = fileURLToPath(import.meta.url);

function packageAt(file, consumerRoot) {
  let directory = path.dirname(fs.realpathSync(file));
  for (;;) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (
        typeof manifest.name === 'string' &&
        typeof manifest.version === 'string'
      ) {
        assert(
          within(consumerRoot, directory),
          `Installed owner escapes its authentic consumer: ${directory}`,
        );
        return { directory, manifest, manifestPath };
      }
    }
    const parent = path.dirname(directory);
    assert.notEqual(
      directory,
      parent,
      `No installed package owner for ${file}`,
    );
    directory = parent;
  }
}

function authenticatePackage(record, artifacts, packedArtifact) {
  const artifact =
    packedArtifact ??
    artifacts.artifacts.find(item => item.targetName === record.manifest.name);
  assert(
    artifact,
    `Installed framework owner is absent from C2 artifacts: ${record.manifest.name}`,
  );
  assert.equal(record.manifest.version, artifact.version);
  const files = verifyInstalledPackage(record.directory, artifact);
  return {
    name: record.manifest.name,
    version: record.manifest.version,
    artifactSha256: artifact.sha256,
    installedPath: record.directory,
    manifest: sourceEvidence(record.manifestPath),
    fileGraphSha256: sha256(JSON.stringify(files)),
    files,
  };
}

/**
 * Records an installed owner that has no packed candidate bytes (an upstream
 * package behind an unpublished fork edge) so the proof can check that the
 * build did not change it.
 */
function recordInstalledOwner(record) {
  const files = readInstalledPackageFiles(record.directory);
  return {
    name: record.manifest.name,
    version: record.manifest.version,
    installedPath: record.directory,
    manifest: sourceEvidence(record.manifestPath),
    fileGraphSha256: sha256(JSON.stringify(files)),
    files,
  };
}

function requestWorker(runtime, token) {
  return `import { registerPlugin } from ${JSON.stringify(`${runtime}/plugin`)};
import { setGlobalContext } from ${JSON.stringify(`${runtime}/context`)};
import { createRequestHandler, renderStreaming } from ${JSON.stringify(`${runtime}/ssr/server`)};
const token = ${JSON.stringify(token)};
function fixtureMetadataToken(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || !('c2Token' in value)) return undefined;
  if (typeof value.c2Token !== 'string') throw new Error('Fixture metadata token is not a string');
  return value.c2Token;
}
function App() { return <p id="c2-native-request-handler">{token + ':request-handler:α🌐'}</p>; }
registerPlugin([]);
setGlobalContext({ App, entryName: 'c2Request', enableRsc: false });
const nativePromise = createRequestHandler(async (request, Root, options) => {
  const proof = {
    dispatchForm: 'request-handler',
    token,
    entryName: options.resource.entryName,
    routePath: options.resource.route.urlPath,
    routeManifest: fixtureMetadataToken(options.resource.routeManifest),
    loadableStats: fixtureMetadataToken(options.resource.loadableStats),
    templateLoaded: options.resource.htmlTemplate.includes('c2-template-' + token),
    loaderContextIsMap: options.loaderContext instanceof Map,
    paramsAreEmpty: Object.keys(options.params).length === 0,
    configIsObject: options.config !== null && typeof options.config === 'object',
    method: request.method,
    requestHeader: request.headers.get('x-c2-worker-token'),
    requestBody: await request.clone().text(),
    requestUrl: request.url,
  };
  if (!proof.templateLoaded || !proof.loaderContextIsMap || !proof.paramsAreEmpty || !proof.configIsObject) throw new Error('Native worker handler options are invalid');
  const body = await renderStreaming(request, <Root />, options);
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-c2-worker-proof': encodeURIComponent(JSON.stringify(proof)) } });
});
export const requestHandler: Awaited<typeof nativePromise> = async (request, options) => (await nativePromise)(request, options);
`;
}

function fetchWorker(token) {
  return `import { renderToReadableStream } from 'react-dom/server.edge';
const token = ${JSON.stringify(token)};
type WorkerBindings = { C2_WORKER_TOKEN: string };
type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};
export default {
  async fetch(request: Request, env: WorkerBindings, ctx: WorkerExecutionContext): Promise<Response> {
    const stream = await renderToReadableStream(<p id="c2-native-fetch-export">{token + ':fetch-export:α🌐'}</p>);
    const proof = {
      dispatchForm: 'fetch-export', token,
      method: request.method, requestUrl: request.url,
      requestHeader: request.headers.get('x-c2-worker-token'),
      requestBody: await request.clone().text(),
      binding: env.C2_WORKER_TOKEN,
      executionContext: typeof ctx.waitUntil === 'function' && typeof ctx.passThroughOnException === 'function',
    };
    return new Response(stream, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-c2-worker-proof': encodeURIComponent(JSON.stringify(proof)) } });
  }
};
`;
}

function assertExecutedBytes(files, root) {
  for (const file of files)
    assert.deepEqual(
      fileEvidence(path.join(root, file.path), root),
      file,
      'Executed worker bytes changed during qualification',
    );
}

async function executeWorker(input) {
  const {
    applicationRoot,
    consumerRoot,
    generatorPackageRoot,
    generatorConsumerRoot,
    leaf,
    resultPath,
    binding,
    artifacts: supplied,
    reactRuntime,
  } = input;
  const runtimeConfig = workerRuntimeConfig(reactRuntime);
  const artifacts = readCohort(supplied.manifestPath);
  assertBinding(
    {
      sourceRevision: artifacts.sourceRevision,
      releaseVersion: artifacts.release.version,
      manifestSha256: artifacts.manifestSha256,
      frameworkCohortDigest: artifacts.cohortDigest,
    },
    binding,
  );
  for (const field of ['sourceRevision', 'manifestSha256', 'cohortDigest'])
    assert.equal(supplied[field], artifacts[field]);
  const require = createRequire(path.join(applicationRoot, 'package.json'));
  const applicationManifest = JSON.parse(
    fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'),
  );
  const applicationDeclaration = sourceEvidence(
    path.join(applicationRoot, 'package.json'),
  );
  const originalConfigurationPath = path.join(
    applicationRoot,
    'modern.config.ts',
  );
  assert(fs.lstatSync(originalConfigurationPath).isFile());
  const originalConfigurationSource = sourceEvidence(originalConfigurationPath);
  const originalTsconfigPath = path.join(applicationRoot, 'tsconfig.json');
  const originalTsconfigSource = sourceEvidence(originalTsconfigPath);
  const ownerBindings = new Map();
  const publicRequests = [];
  let sdk;
  function publicEntry(canonical, subpath = '') {
    const members = artifacts.artifacts.filter(
      item => item.sourceName === canonical,
    );
    assert.equal(
      members.length,
      1,
      `One authenticated public owner is required for ${canonical}`,
    );
    const artifact = members[0];
    const requests = [canonical, artifact.targetName].filter(request =>
      ['dependencies', 'optionalDependencies', 'devDependencies'].some(block =>
        Object.hasOwn(applicationManifest[block] ?? {}, request),
      ),
    );
    assert(
      requests.length <= 1,
      `Ambiguous declared public slots for ${canonical}`,
    );
    let ownerRequire = require;
    let declarationOwner = path.join(applicationRoot, 'package.json');
    let requestName = requests[0];
    if (!requestName) {
      assert(
        sdk,
        `The application must declare its actual public SDK slot for ${canonical}`,
      );
      const declared = {
        ...sdk.record.manifest.dependencies,
        ...sdk.record.manifest.optionalDependencies,
      };
      assert.equal(
        declared[canonical],
        `npm:${artifact.targetName}@${artifact.version}`,
        `The authenticated SDK must declare the exact public ${canonical} dependency`,
      );
      requestName = canonical;
      ownerRequire = createRequire(sdk.record.manifestPath);
      declarationOwner = sdk.record.manifestPath;
    }
    const specifier = `${requestName}${subpath}`;
    const entry = ownerRequire.resolve(specifier);
    const record = packageAt(entry, consumerRoot);
    assert.equal(record.manifest.name, artifact.targetName);
    if (!ownerBindings.has(record.directory))
      ownerBindings.set(
        record.directory,
        authenticatePackage(record, artifacts),
      );
    publicRequests.push({ canonical, specifier, declarationOwner, entry });
    return { requestName, specifier, entry, record, require: ownerRequire };
  }
  sdk = publicEntry('@modern-js/ultramodern-app-tools');
  // An explicitly authored probe config selects the genuine public composition.
  // Original consumer/ERP config and hooks are neither loaded nor rewritten.
  const configurationPath = path.join(leaf, 'modern.config.cjs');
  const tsconfigPath = path.join(leaf, 'tsconfig.worker.json');
  fs.writeFileSync(
    configurationPath,
    [
      `const { defineConfig } = require(${JSON.stringify(sdk.entry)});`,
      `module.exports = defineConfig({ ...${JSON.stringify(runtimeConfig)}, server: { ssr: true }, source: { tsconfigPath: ${JSON.stringify(tsconfigPath)} } });`,
      '',
    ].join('\n'),
    { flag: 'wx' },
  );
  const configurationSource = sourceEvidence(configurationPath);
  const cloudflare = publicEntry(
    '@modern-js/app-tools-extensions',
    '/cloudflare',
  );
  const compilerAdapter = publicEntry(
    '@modern-js/app-tools-extensions',
    '/cloudflare-builder',
  );
  const runtime = publicEntry('@modern-js/runtime', '/ssr/server');
  const runtimeExtensions = publicEntry(
    '@modern-js/runtime-extensions',
    '/router-state',
  );
  publicEntry('@modern-js/app-tools-extensions', '/cloudflare/worker-options');
  const sdkRsbuild = publicEntry(
    '@modern-js/ultramodern-app-tools',
    '/rsbuild',
  );
  publicEntry('@modern-js/runtime', '/context');
  publicEntry('@modern-js/runtime', '/plugin');
  const appTools = publicEntry('@modern-js/app-tools');
  const appToolsRequire = createRequire(appTools.record.manifestPath);
  const builderArtifacts = artifacts.artifacts.filter(
    item => item.sourceName === '@modern-js/builder',
  );
  assert.equal(builderArtifacts.length, 1);
  const builderArtifact = builderArtifacts[0];
  assert(
    [
      builderArtifact.version,
      `npm:${builderArtifact.targetName}@${builderArtifact.version}`,
    ].includes(appTools.record.manifest.dependencies?.['@modern-js/builder']),
    'Installed app-tools must declare the authenticated builder dependency',
  );
  const builder = {
    specifier: '@modern-js/builder',
    entry: appToolsRequire.resolve('@modern-js/builder'),
  };
  builder.record = packageAt(builder.entry, consumerRoot);
  assert.equal(builder.record.manifest.name, builderArtifact.targetName);
  ownerBindings.set(
    builder.record.directory,
    authenticatePackage(builder.record, artifacts),
  );
  const generatorArtifacts = artifacts.artifacts.filter(
    item => item.sourceName === '@modern-js/ultramodern-create',
  );
  assert.equal(
    generatorArtifacts.length,
    1,
    'The candidate must authenticate one public generator owner',
  );
  const generatorArtifact = generatorArtifacts[0];
  const generatorSelfRequire = createRequire(
    path.join(generatorPackageRoot, 'package.json'),
  );
  const generatorEntry = generatorSelfRequire.resolve(
    generatorArtifact.targetName,
  );
  const generator = {
    specifier: generatorArtifact.targetName,
    entry: generatorEntry,
    record: packageAt(generatorEntry, generatorConsumerRoot),
  };
  assert.equal(
    fs.realpathSync(generator.record.directory),
    fs.realpathSync(generatorPackageRoot),
    'Generator public self-resolution differs from its authenticated sidecar owner',
  );
  assert.equal(generator.record.manifest.name, generatorArtifact.targetName);
  const generatorOwner = authenticatePackage(generator.record, artifacts);
  ownerBindings.set(generator.record.directory, generatorOwner);
  const generatorRequire = createRequire(generator.record.manifestPath);
  const miniflareEntry = generatorRequire.resolve('miniflare');
  const miniflarePackage = packageAt(miniflareEntry, generatorConsumerRoot);
  assert.equal(miniflarePackage.manifest.name, 'miniflare');
  assert.equal(
    miniflarePackage.manifest.version,
    generator.record.manifest.dependencies.miniflare,
  );
  const miniflareRequire = createRequire(miniflarePackage.manifestPath);
  const workerdEntry = miniflareRequire.resolve('workerd');
  const workerdPackage = packageAt(workerdEntry, generatorConsumerRoot);
  assert.equal(workerdPackage.manifest.name, 'workerd');
  assert.equal(
    workerdPackage.manifest.version,
    miniflarePackage.manifest.dependencies.workerd,
  );
  const workerdPublic = miniflareRequire('workerd');
  const workerdBinary = workerdPublic.default;
  assert.equal(typeof workerdBinary, 'string');
  assert.equal(workerdPublic.version, workerdPackage.manifest.version);
  assert(
    within(generatorConsumerRoot, fs.realpathSync(workerdBinary)),
    'The installed workerd binary escapes the authenticated generator consumer',
  );
  assert(
    !process.env.MINIFLARE_WORKERD_PATH,
    'An ambient workerd override cannot certify the installed host',
  );
  assert(
    !process.env.VSCODE_INSPECTOR_OPTIONS,
    'Detached inspector watchdogs are outside this worker ownership contract',
  );
  const { createCloudflarePreset } = cloudflare.require(cloudflare.specifier);
  const { getCloudflareBuilderEnvironments } = compilerAdapter.require(
    compilerAdapter.specifier,
  );
  const { SERVICE_WORKER_ENVIRONMENT_NAME } = appToolsRequire(
    builder.specifier,
  );
  const { resolveUltramodernRsbuildConfig } = sdkRsbuild.require(
    sdkRsbuild.specifier,
  );
  assert.equal(typeof createCloudflarePreset, 'function');
  assert.equal(typeof getCloudflareBuilderEnvironments, 'function');
  assert.equal(typeof resolveUltramodernRsbuildConfig, 'function');
  assert.equal(typeof SERVICE_WORKER_ENVIRONMENT_NAME, 'string');
  const adapterRequire = createRequire(compilerAdapter.record.manifestPath);
  const sdkRequire = createRequire(sdk.record.manifestPath);
  const release = readReleaseManifest({ manifestPath: artifacts.manifestPath });
  assert.equal(release.manifestSha256, binding.manifestSha256);
  assert.equal(
    sdk.record.manifest.dependencies['@rsbuild/core'],
    compilerAdapter.record.manifest.peerDependencies['@rsbuild/core'],
    'The SDK and compiler adapter declare the same native Rsbuild version',
  );
  const rsbuildEntry = sdkRequire.resolve('@rsbuild/core');
  assert.equal(
    fs.realpathSync(adapterRequire.resolve('@rsbuild/core')),
    fs.realpathSync(rsbuildEntry),
    'The Cloudflare adapter must use the same authenticated Rsbuild owner',
  );
  const rsbuildPackage = packageAt(rsbuildEntry, consumerRoot);
  assert.equal(rsbuildPackage.manifest.name, '@rsbuild/core');
  assert.equal(
    rsbuildPackage.manifest.version,
    compilerAdapter.record.manifest.peerDependencies['@rsbuild/core'],
  );
  const rsbuildOwner = recordInstalledOwner(rsbuildPackage);
  const { createRsbuild } = sdkRequire('@rsbuild/core');
  const token = `c2-${sha256(JSON.stringify(binding)).slice(0, 16)}-${randomUUID()}`;
  const authored = createWorkerLifecycleSources({
    runtimeSpecifier: runtime.requestName,
    runtimeExtensionsSpecifier: runtimeExtensions.requestName,
    cloudflareSpecifier: cloudflare.requestName,
    token,
    candidateBinding: binding,
  });
  const distDirectory = path.join(leaf, 'dist');
  const sources = path.join(leaf, 'sources');
  fs.mkdirSync(sources);
  const requestSource = path.join(sources, 'c2-request.tsx');
  const fetchSource = path.join(sources, 'c2-fetch.tsx');
  fs.writeFileSync(requestSource, requestWorker(runtime.requestName, token), {
    flag: 'wx',
  });
  fs.writeFileSync(fetchSource, fetchWorker(token), { flag: 'wx' });
  for (const route of authored.sources)
    fs.writeFileSync(path.join(sources, route.filename), route.source, {
      flag: 'wx',
    });
  atomicJson(tsconfigPath, {
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      noCheck: false,
      skipLibCheck: false,
      esModuleInterop: true,
      lib: ['ESNext', 'DOM', 'DOM.Iterable'],
      types: ['node', 'react', 'react-dom'],
    },
    files: [
      path.relative(leaf, requestSource),
      path.relative(leaf, fetchSource),
      ...authored.sources.map(({ filename }) =>
        path.relative(leaf, path.join(sources, filename)),
      ),
    ],
  });
  const tsconfigSource = sourceEvidence(tsconfigPath);
  const assetSources = path.join(sources, 'assets');
  const template = `<!doctype html><html><head><meta name="c2-template-${token}"></head><body><!--<?- html ?>--></body></html>`;
  for (const entry of [
    'c2Fetch',
    'c2Request',
    ...authored.sources.map(({ entryName }) => entryName),
  ]) {
    fs.mkdirSync(path.join(assetSources, 'html', entry), { recursive: true });
    fs.writeFileSync(
      path.join(assetSources, 'html', entry, 'index.html'),
      template,
      { flag: 'wx' },
    );
  }
  atomicJson(path.join(assetSources, 'route.json'), {
    routes: [
      {
        urlPath: '/fetch-export',
        entryName: 'c2Fetch',
        entryPath: 'html/c2Fetch/index.html',
        isSSR: true,
        worker: 'worker/c2Fetch.js',
      },
      {
        urlPath: '/request-handler',
        entryName: 'c2Request',
        entryPath: 'html/c2Request/index.html',
        isSSR: true,
        worker: 'worker/c2Request.js',
      },
      ...authored.sources.map(({ entryName, urlPath }) => ({
        urlPath,
        entryName,
        entryPath: `html/${entryName}/index.html`,
        isSSR: true,
        worker: `worker/${entryName}.js`,
      })),
    ],
  });
  atomicJson(path.join(assetSources, 'routes-manifest.json'), {
    c2Token: token,
    routeAssets: {},
  });
  atomicJson(path.join(assetSources, 'loadable-stats.json'), {
    c2Token: token,
    chunks: [],
    assets: [],
  });
  const modernConfig = {
    deploy: {
      target: 'cloudflare',
      worker: {
        name: `c2-dispatch-${randomUUID()}`,
        compatibilityDate: '2026-06-02',
        wrangler: {
          vars: { C2_WORKER_TOKEN: token, [authored.bindingVariable]: token },
        },
      },
    },
  };
  atomicJson(path.join(sources, 'native-settings.json'), {
    fixture: 'intentional public API worker entry exports',
    sourceEntries: {
      c2Fetch: 'c2-fetch.tsx',
      c2Request: 'c2-request.tsx',
      ...Object.fromEntries(
        authored.sources.map(({ entryName, filename }) => [
          entryName,
          filename,
        ]),
      ),
    },
    workerLifecycle: {
      candidateBinding: binding,
      bindingVariable: authored.bindingVariable,
      controlHeader: authored.controlHeader,
      candidateHeader: authored.candidateHeader,
      receiptHeader: authored.receiptHeader,
    },
    rendering: {
      runtime: reactRuntime,
      configuration: runtimeConfig,
      fetch: 'react-dom/server.edge.renderToReadableStream',
      request: `${runtime.requestName}/ssr/server.createRequestHandler+renderStreaming`,
    },
    modernConfig,
    mode: 'production',
    configuration: {
      api: `${sdkRsbuild.specifier}.resolveUltramodernRsbuildConfig`,
      source: 'explicit-new-hand-authored-public-SDK-probe-config',
      command: 'build',
      input: configurationSource,
      preservedOriginalInput: originalConfigurationSource,
      typeChecking: {
        config: tsconfigSource,
        preservedOriginalConfig: originalTsconfigSource,
        program: 'strict actual executed TSX worker sources',
      },
      applicationDeclaration,
    },
    define: { 'process.env.MODERN_SSR_ENV': 'edge' },
    assetEmission: 'native Rsbuild output.copy',
  });
  const authoredSources = ordinaryFiles(sources).map(file =>
    fileEvidence(file, sources),
  );
  const authoredAssets = ordinaryFiles(assetSources).map(file =>
    fileEvidence(file, assetSources),
  );
  const environments = getCloudflareBuilderEnvironments({
    appContext: {
      apiOnly: false,
      appDirectory: applicationRoot,
      apiDirectory: path.join(leaf, 'api'),
      // Commands resolve the deploy target once into the app context.
      deployTarget: { target: 'cloudflare', explicit: true },
    },
    normalizedConfig: {},
    environments: {
      [SERVICE_WORKER_ENVIRONMENT_NAME]: {
        source: {
          tsconfigPath,
          entry: {
            c2Fetch: fetchSource,
            c2Request: requestSource,
            ...Object.fromEntries(
              authored.sources.map(({ entryName, filename }) => [
                entryName,
                path.join(sources, filename),
              ]),
            ),
          },
          define: { 'process.env.MODERN_SSR_ENV': JSON.stringify('edge') },
        },
        output: {
          target: 'web-worker',
          distPath: { root: distDirectory, js: 'worker' },
          filename: { js: '[name].js' },
          minify: false,
          sourceMap: false,
          cleanDistPath: false,
          copy: [{ from: assetSources, to: '.', toType: 'dir' }],
        },
        tools: {
          rspack: {
            resolve: {
              modules: [
                path.join(applicationRoot, 'node_modules'),
                'node_modules',
              ],
            },
          },
        },
      },
    },
  });
  assert.equal(
    environments[SERVICE_WORKER_ENVIRONMENT_NAME].output.module,
    true,
  );
  let buildResult;
  let miniflare;
  let primary;
  let receipt;
  const cleanupFailures = [];
  try {
    const { rsbuildConfig } = await resolveUltramodernRsbuildConfig({
      cwd: applicationRoot,
      command: 'build',
      configPath: configurationPath,
    });
    const host = await createRsbuild({
      cwd: applicationRoot,
      config: {
        ...rsbuildConfig,
        mode: 'production',
        output: { ...rsbuildConfig.output, distPath: { root: distDirectory } },
        environments,
      },
    });
    buildResult = await host.build();
    assertExecutedBytes(authoredSources, sources);
    assertExecutedBytes(authoredAssets, distDirectory);
    const stats = buildResult.stats.toJson({
      all: false,
      modules: true,
      nestedModules: true,
    });
    const compiledInputs = new Map();
    function visitModule(module) {
      if (
        typeof module.nameForCondition === 'string' &&
        path.isAbsolute(module.nameForCondition)
      ) {
        const filename = module.nameForCondition.split('?')[0];
        if (fs.existsSync(filename) && !within(leaf, filename)) {
          const record = packageAt(filename, consumerRoot);
          const evidence = sourceEvidence(fs.realpathSync(filename));
          compiledInputs.set(evidence.path, {
            ...evidence,
            package: record.manifest.name,
            effectivePackage: effectiveRuntimePackage(record.manifest.name),
            version: record.manifest.version,
          });
          if (
            record.manifest.name.startsWith('@modern-js/') ||
            record.manifest.name.startsWith('@bleedingdev/modern-js-')
          ) {
            if (!ownerBindings.has(record.directory))
              ownerBindings.set(
                record.directory,
                authenticatePackage(record, artifacts),
              );
          }
        }
      }
      for (const nested of module.modules ?? []) visitModule(nested);
    }
    for (const compilation of stats.children ?? [stats])
      for (const module of compilation.modules ?? []) visitModule(module);
    assert(
      [...compiledInputs.values()].some(
        item => item.package === runtime.record.manifest.name,
      ),
      'Native build did not observe the public React runtime',
    );
    const compiledRuntime = assertCompiledReactRuntime(
      compiledInputs.values(),
      reactRuntime,
    );
    for (const entry of ['c2Fetch', 'c2Request']) {
      assert(
        fs
          .lstatSync(path.join(distDirectory, 'worker', `${entry}.js`))
          .isFile(),
      );
    }
    for (const { entryName } of authored.sources)
      assert(
        fs
          .lstatSync(path.join(distDirectory, 'worker', `${entryName}.js`))
          .isFile(),
      );
    const preset = createCloudflarePreset({
      api: { isPluginExists: () => false },
      appContext: {
        apiOnly: false,
        appDirectory: leaf,
        distDirectory,
        serverPlugins: [],
      },
      modernConfig,
    });
    for (const method of ['prepare', 'writeOutput', 'genEntry']) {
      assert.equal(typeof preset[method], 'function');
      await preset[method]();
    }
    const outputRoot = path.join(leaf, '.output');
    const wrangler = JSON.parse(
      fs.readFileSync(path.join(outputRoot, 'wrangler.json'), 'utf8'),
    );
    const workerConfig = {
      ...workerOptions(outputRoot, wrangler),
      bindings: wrangler.vars,
    };
    const executed = ordinaryFiles(outputRoot).map(file =>
      fileEvidence(file, outputRoot),
    );
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
      await import(pathToFileURL(miniflareEntry).href);
    assert.equal(typeof Miniflare, 'function');
    assert.equal(typeof convertV4MiniflareOptions, 'function');
    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        log: new Log(LogLevel.ERROR),
        workers: [workerConfig],
      }),
    );
    await miniflare.ready;
    const executions = [];
    let assertionCount = 0;
    const equal = (actual, expected, message) => {
      assert.equal(actual, expected, message);
      assertionCount += 1;
    };
    const check = (condition, message) => {
      assert(condition, message);
      assertionCount += 1;
    };
    for (const [dispatchForm, entry, marker] of [
      ['fetch-export', 'c2Fetch', 'c2-native-fetch-export'],
      ['request-handler', 'c2Request', 'c2-native-request-handler'],
    ]) {
      const url = `https://${wrangler.name}.invalid/${dispatchForm}?probe=${token}`;
      const requestBytes = Buffer.from(`${token}:request:α🌐`);
      const response = await miniflare.dispatchFetch(url, {
        method: 'POST',
        headers: {
          'x-c2-worker-token': token,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: requestBytes,
        signal: AbortSignal.timeout(60_000),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const html = bytes.toString('utf8');
      if (response.status !== 200) {
        const diagnostic = {
          dispatchForm,
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: html.slice(0, 32_768),
          responseSha256: sha256(bytes),
          responseByteLength: bytes.length,
        };
        console.error('[c2-worker-error-response]', JSON.stringify(diagnostic));
        atomicJson(resultPath, {
          schema: 'c2-worker-dispatch-proof',
          schemaVersion: 1,
          status: 'failed',
          ...binding,
          failureResponse: diagnostic,
        });
      }
      equal(
        response.status,
        200,
        `Native ${dispatchForm} failed in workerd: ${html.slice(0, 32_768)}`,
      );
      check(
        html.includes(`id="${marker}"`),
        'React SSR node is absent from real workerd response',
      );
      check(
        html.includes(`${token}:${dispatchForm}:α🌐`),
        'React SSR output is absent or became client fallback',
      );
      check(response.headers.get('content-type')?.startsWith('text/html'));
      const proofHeader = response.headers.get('x-c2-worker-proof');
      check(
        typeof proofHeader === 'string' && proofHeader.length > 0,
        'Native dispatch observation header is absent',
      );
      const proof = JSON.parse(decodeURIComponent(proofHeader));
      equal(proof.dispatchForm, dispatchForm);
      equal(proof.token, token);
      equal(proof.method, 'POST');
      equal(proof.requestHeader, token);
      equal(proof.requestBody, requestBytes.toString('utf8'));
      equal(proof.requestUrl, url);
      if (dispatchForm === 'fetch-export') {
        equal(proof.binding, token);
        equal(proof.executionContext, true);
      } else {
        equal(proof.entryName, entry);
        equal(proof.routePath, '/request-handler');
        equal(proof.routeManifest, token);
        equal(proof.loadableStats, token);
        for (const field of [
          'templateLoaded',
          'loaderContextIsMap',
          'paramsAreEmpty',
          'configIsObject',
        ])
          equal(proof[field], true);
      }
      executions.push({
        dispatchForm,
        status: response.status,
        reactSsrRendered: true,
        requestSha256: sha256(requestBytes),
        requestByteLength: requestBytes.length,
        responseSha256: sha256(bytes),
        responseByteLength: bytes.length,
        proof,
        source: authoredSources.find(
          item =>
            item.path ===
            (dispatchForm === 'fetch-export'
              ? 'c2-fetch.tsx'
              : 'c2-request.tsx'),
        ),
        worker: fileEvidence(
          path.join(outputRoot, 'worker', `${entry}.js`),
          outputRoot,
        ),
        server: fileEvidence(path.join(outputRoot, wrangler.main), outputRoot),
      });
    }
    let workerLifecycle;
    try {
      workerLifecycle = await verifyWorkerLifecycle({
        miniflare,
        miniflareClass: Miniflare,
        workerName: wrangler.name,
        token,
        candidateBinding: binding,
        routes: authored.sources.map(({ source, ...route }) => route),
      });
    } catch (error) {
      atomicJson(resultPath, {
        schema: 'c2-worker-dispatch-proof',
        schemaVersion: 1,
        status: 'failed',
        ...binding,
        executions,
        workerLifecycle: error.workerLifecycleEvidence ?? workerLifecycle,
        workerLifecycleError: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        observations: {
          runtime: 'workerd',
          fetchStatus: 200,
          dispatchForms: executions.map(item => item.dispatchForm),
          assertionCount,
          scope: 'installed-public-worker-dispatch-and-react-ssr',
        },
      });
      throw error;
    }
    assertExecutedBytes(executed, outputRoot);
    assertExecutedBytes(authoredSources, sources);
    assert.deepEqual(sourceEvidence(configurationPath), configurationSource);
    assert.deepEqual(
      sourceEvidence(originalConfigurationPath),
      originalConfigurationSource,
    );
    assert.deepEqual(
      sourceEvidence(originalTsconfigPath),
      originalTsconfigSource,
    );
    assert.deepEqual(sourceEvidence(tsconfigPath), tsconfigSource);
    assert.deepEqual(
      sourceEvidence(path.join(applicationRoot, 'package.json')),
      applicationDeclaration,
    );
    assert.deepEqual(
      recordInstalledOwner(rsbuildPackage),
      rsbuildOwner,
      'Executed Rsbuild bytes changed during qualification',
    );
    for (const [directory] of ownerBindings)
      authenticatePackage(
        {
          directory,
          manifest: JSON.parse(
            fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
          ),
          manifestPath: path.join(directory, 'package.json'),
        },
        artifacts,
      );
    receipt = {
      schema: 'c2-worker-dispatch-proof',
      schemaVersion: 1,
      status: 'passed',
      ...binding,
      publicOwners: [...ownerBindings.values()],
      publicRequests,
      consumerRoots: {
        application: consumerRoot,
        generator: generatorConsumerRoot,
      },
      generator: {
        ...generatorOwner,
        consumerRoot: generatorConsumerRoot,
        publicSpecifier: generator.specifier,
        entry: sourceEvidence(generator.entry),
      },
      miniflare: {
        name: miniflarePackage.manifest.name,
        version: miniflarePackage.manifest.version,
        installedPath: miniflarePackage.directory,
        consumerRoot: generatorConsumerRoot,
        entry: sourceEvidence(miniflareEntry),
      },
      workerd: {
        name: workerdPackage.manifest.name,
        version: workerdPackage.manifest.version,
        installedPath: workerdPackage.directory,
        consumerRoot: generatorConsumerRoot,
        entry: sourceEvidence(workerdEntry),
        binary: sourceEvidence(fs.realpathSync(workerdBinary)),
      },
      compiledRuntime,
      nativeCompiler: {
        ...(rsbuildForkDeclared
          ? { packedOwner: rsbuildOwner }
          : { upstreamOwner: rsbuildOwner }),
        name: rsbuildPackage.manifest.name,
        version: rsbuildPackage.manifest.version,
        entry: sourceEvidence(rsbuildEntry),
        inputs: [...compiledInputs.values()],
      },
      sources: {
        root: sources,
        files: authoredSources,
        copiedAssets: authoredAssets,
        authoredBeforeBuild: true,
        emission: 'public Rsbuild output.copy and native Cloudflare preset',
      },
      output: {
        wrangler: fileEvidence(
          path.join(outputRoot, 'wrangler.json'),
          outputRoot,
        ),
        files: executed,
      },
      executions,
      workerLifecycle,
      observations: {
        runtime: 'workerd',
        fetchStatus: 200,
        dispatchForms: executions.map(item => item.dispatchForm),
        assertionCount,
        scope: 'installed-public-worker-dispatch-and-react-ssr',
      },
    };
  } catch (error) {
    primary = error;
  } finally {
    for (const close of [
      () => miniflare?.dispose(),
      () => buildResult?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  if (primary || cleanupFailures.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupFailures],
      'Native worker dispatch proof failed',
      primary ? { cause: primary } : undefined,
    );
  atomicJson(resultPath, receipt);
}

/** Owns a fresh leaf and child group; never alters the six acceptance apps. */
async function runWorkerDispatchRuntimeProbe(options) {
  const {
    workDir,
    receiptPath,
    binding,
    artifacts,
    qualifiedNode,
    applicationRoot,
    consumerRoot,
    generatorPackageRoot,
    generatorConsumerRoot,
    kind = 'generated',
    reactRuntime,
    owner,
    ownerPid,
    signal,
    env = process.env,
  } = options;
  const childEnv = {
    ...env,
    NODE_ENV: 'production',
    NODE_OPTIONS: '',
    VSCODE_INSPECTOR_OPTIONS: '',
  };
  assert(
    path.isAbsolute(workDir) &&
      fs.lstatSync(workDir).isDirectory() &&
      !fs.lstatSync(workDir).isSymbolicLink(),
  );
  assert(within(workDir, receiptPath));
  assert(!fs.existsSync(receiptPath), 'Previous worker evidence is immutable');
  assert(
    within(fs.realpathSync(consumerRoot), fs.realpathSync(applicationRoot)) ||
      fs.realpathSync(consumerRoot) === fs.realpathSync(applicationRoot),
  );
  assert(
    path.isAbsolute(generatorPackageRoot) &&
      path.isAbsolute(generatorConsumerRoot),
    'Actual generator owner and consumer roots are required',
  );
  assert(
    fs.lstatSync(generatorConsumerRoot).isDirectory() &&
      !fs.lstatSync(generatorConsumerRoot).isSymbolicLink(),
  );
  assert(
    fs.lstatSync(generatorPackageRoot).isDirectory() &&
      !fs.lstatSync(generatorPackageRoot).isSymbolicLink(),
  );
  assert(
    within(
      fs.realpathSync(generatorConsumerRoot),
      fs.realpathSync(generatorPackageRoot),
    ),
    'Generator owner escapes its actual consumer',
  );
  signal?.throwIfAborted();
  const producer = sourceEvidence(script);
  // A genuine checked fixture resolves its compiler/types through the existing
  // consumer ancestry; no installed dependency slot is created or rewritten.
  const leaf = fs.mkdtempSync(
    path.join(applicationRoot, 'target-release-worker-'),
  );
  const resultPath = path.join(leaf, 'native-result.json');
  const inputPath = path.join(leaf, 'native-input.json');
  let registrationAttempted = false;
  let nativeHandle;
  let nativeStopped = false;
  let runtimeDeadline;
  let failure;
  let receipt = {
    schema: 'c2-worker-dispatch-proof',
    schemaVersion: 1,
    status: 'running',
    ...binding,
    producer,
    owner: { name: owner, pid: ownerPid, root: leaf },
    executions: [],
  };
  try {
    atomicJson(receiptPath, receipt);
    registrationAttempted = true;
    registerArtifact(leaf, { owner, ownerPid, kind: 'build' });
    atomicJson(inputPath, {
      applicationRoot,
      consumerRoot: fs.realpathSync(consumerRoot),
      generatorPackageRoot: fs.realpathSync(generatorPackageRoot),
      generatorConsumerRoot: fs.realpathSync(generatorConsumerRoot),
      kind,
      reactRuntime,
      leaf,
      resultPath,
      binding,
      artifacts,
    });
    const nativeArgs = [script, '--worker', inputPath];
    nativeHandle = launch(qualifiedNode, nativeArgs, {
      cwd: applicationRoot,
      env: childEnv,
      log: path.join(workDir, `${path.basename(leaf)}-runtime.log`),
      signal,
    });
    const result = await Promise.race([
      nativeHandle.closed,
      new Promise((_, reject) => {
        runtimeDeadline = setTimeout(
          () =>
            reject(
              new Error(
                'Native worker proof exceeded its 600 second allocation',
              ),
            ),
          600_000,
        );
      }),
    ]);
    if (nativeHandle.failure) throw nativeHandle.failure;
    assert.equal(
      result.code,
      0,
      `Native worker failed (${result.code ?? result.signal}); ${nativeHandle.log}`,
    );
    signal?.throwIfAborted();
    const native = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(native.status, 'passed');
    assert.equal(native.compiledRuntime.runtime, reactRuntime);
    assertBinding(native, binding);
    assert.equal(native.executions.length, 2);
    assert.deepEqual(
      native.executions.map(item => item.dispatchForm),
      ['fetch-export', 'request-handler'],
    );
    receipt = {
      ...native,
      producer: receipt.producer,
      owner: receipt.owner,
      command: {
        command: qualifiedNode,
        args: nativeArgs,
        cwd: applicationRoot,
        exitCode: result.code,
        log: sourceEvidence(nativeHandle.log),
      },
    };
  } catch (error) {
    failure = error;
    if (fs.existsSync(resultPath)) {
      try {
        const native = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        assert.equal(native.schema, 'c2-worker-dispatch-proof');
        assertBinding(native, binding);
        receipt = {
          ...native,
          producer: receipt.producer,
          owner: receipt.owner,
          command: nativeHandle
            ? {
                command: qualifiedNode,
                args: [script, '--worker', inputPath],
                cwd: applicationRoot,
                log: sourceEvidence(nativeHandle.log),
              }
            : undefined,
        };
      } catch (diagnosticError) {
        receipt.nativeDiagnosticReadError = diagnosticError.message;
      }
    }
    receipt.status = 'failed';
    receipt.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    clearTimeout(runtimeDeadline);
    if (nativeHandle) {
      try {
        await nativeHandle.stop();
        nativeStopped = true;
      } catch (error) {
        failure = new AggregateError(
          [...(failure ? [failure] : []), error],
          'Native worker process group did not stop',
          failure ? { cause: failure } : undefined,
        );
      }
    }
    try {
      // A failed group stop retains the registered leaf for its active owner.
      // Miniflare's workerd spawn inherits this group; inspector watchdogs are
      // disabled in the owned child. No detached browser host is launched here.
      assert(
        !nativeHandle || nativeStopped,
        'Cannot remove worker outputs while a native owner may survive',
      );
      if (registrationAttempted)
        receipt.cleanup = await removeOwnedLeaf(leaf, { owner });
      else {
        fs.rmSync(leaf, { recursive: true });
        receipt.cleanup = {
          path: leaf,
          removed: true,
          registryPruned: true,
          registrationRequired: false,
        };
      }
    } catch (error) {
      receipt.status = 'failed';
      receipt.cleanup = {
        path: leaf,
        removed: !fs.existsSync(leaf),
        registryPruned: false,
        error: error.message,
      };
      failure = new AggregateError(
        [...(failure ? [failure] : []), error],
        'Worker proof cleanup failed',
        failure ? { cause: failure } : undefined,
      );
    }
  }
  if (signal?.aborted) {
    receipt.status = 'failed';
    failure ??= signal.reason ?? new Error('Worker proof interrupted');
  }
  atomicJson(receiptPath, receipt);
  if (failure) throw failure;
  return receipt;
}

/** Both variants execute the complete dispatch and lifecycle contract. */
export async function runWorkerDispatchProbe(options) {
  assert(
    path.isAbsolute(options.workDir) &&
      fs.lstatSync(options.workDir).isDirectory() &&
      !fs.lstatSync(options.workDir).isSymbolicLink(),
  );
  assert(within(options.workDir, options.receiptPath));
  assert(
    !fs.existsSync(options.receiptPath),
    'Previous worker evidence is immutable',
  );
  const runtimeReceipts = {
    redact: `${options.receiptPath}.redact-default.json`,
    react: `${options.receiptPath}.react-compatibility.json`,
  };
  let receipt = {
    schema: 'c2-worker-dispatch-proof',
    schemaVersion: 1,
    status: 'running',
    ...options.binding,
    runtimeReceipts,
    executions: [],
  };
  atomicJson(options.receiptPath, receipt);
  try {
    const defaultProof = await runWorkerDispatchRuntimeProbe({
      ...options,
      receiptPath: runtimeReceipts.redact,
      reactRuntime: 'redact',
    });
    // Never publish a passing aggregate while compatibility is still pending.
    receipt = { ...defaultProof, runtimeReceipts, status: 'running' };
    atomicJson(options.receiptPath, receipt);
    receipt.realReactCompatibility = await runWorkerDispatchRuntimeProbe({
      ...options,
      receiptPath: runtimeReceipts.react,
      reactRuntime: 'react',
    });
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = { name: error.name, message: error.message };
    atomicJson(options.receiptPath, receipt);
    throw error;
  }
  atomicJson(options.receiptPath, receipt);
  return receipt;
}

if (
  process.argv[2] === '--worker' &&
  path.resolve(process.argv[1]) === script
) {
  executeWorker(JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))).catch(
    error => {
      for (const cause of [
        error,
        ...(error instanceof AggregateError ? error.errors : []),
      ])
        process.stderr.write(`${cause?.stack ?? cause}\n`);
      process.exitCode = 1;
    },
  );
}
