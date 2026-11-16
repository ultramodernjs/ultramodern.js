// Serialized into the strict, clean packed installation. No repository imports.
export async function packedMfCohortProbeMain(sdkProbe) {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const http = (await import('node:http')).default;
  const net = (await import('node:net')).default;
  const vm = await import('node:vm');
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const root = fs.realpathSync(process.cwd());
  const installedRequire = createRequire(path.join(root, 'package.json'));
  const suffixes = [
    'bridge-react',
    'cli',
    'dts-plugin',
    'enhanced',
    'manifest',
    'modern-js-v3',
    'node',
    'rsbuild-plugin',
    'rspack',
    'runtime',
    'runtime-core',
    'runtime-tools',
    'sdk',
    'webpack-bundler-runtime',
  ];
  const roots = new Map();
  for (const suffix of suffixes) {
    const name = `@bleedingdev/mf-${suffix}`;
    const directory = path.join(root, 'node_modules', name);
    assert.equal(
      fs.realpathSync(directory),
      directory,
      `${name} must be physically installed`,
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.name, name);
    assert.equal(
      manifest.version,
      suffix === 'node' ? '2.7.54' : '2.9.5',
      `${name} cohort drift`,
    );
    roots.set(suffix, directory);
    const from = createRequire(path.join(directory, 'package.json'));
    for (const block of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [dependency, specifier] of Object.entries(
        manifest[block] ?? {},
      )) {
        if (!dependency.startsWith('@module-federation/')) continue;
        const child = dependency.slice('@module-federation/'.length);
        if (!suffixes.includes(child)) continue;
        const target = `@bleedingdev/mf-${child}`;
        assert.equal(
          specifier,
          `npm:${target}@${child === 'node' ? '2.7.54' : '2.9.5'}`,
          `${name} uncorrected runtime edge ${dependency}`,
        );
        let resolved = path.dirname(from.resolve(dependency));
        while (!fs.existsSync(path.join(resolved, 'package.json')))
          resolved = path.dirname(resolved);
        const installed = JSON.parse(
          fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'),
        );
        assert.equal(
          installed.name,
          target,
          `${name} resolved upstream ${dependency}`,
        );
        assert.equal(installed.version, child === 'node' ? '2.7.54' : '2.9.5');
      }
    }
  }
  const load = file => import(pathToFileURL(file));
  const loadInstalled = name => import(import.meta.resolve(name));
  // Real top-level APIs of both runtime formats, including reset of stale containers.
  for (const extension of ['cjs', 'js']) {
    const core =
      extension === 'cjs'
        ? installedRequire(
            path.join(roots.get('runtime-core'), 'dist/index.cjs'),
          )
        : await load(path.join(roots.get('runtime-core'), 'dist/index.js'));
    const helpers =
      extension === 'cjs'
        ? installedRequire(
            path.join(roots.get('runtime-core'), 'dist/helpers.cjs'),
          )
        : await load(path.join(roots.get('runtime-core'), 'dist/helpers.js'));
    const runtime =
      extension === 'cjs'
        ? installedRequire('@bleedingdev/mf-runtime')
        : await loadInstalled('@bleedingdev/mf-runtime');
    assert.equal(typeof runtime.createInstance, 'function');
    const instance = new core.ModuleFederation({
      name: `packed_${extension}`,
      remotes: [],
    });
    instance.moduleCache.set('stale', {
      remoteInfo: { entryGlobalName: `old_remote_${extension}` },
    });
    globalThis[`old_remote_${extension}`] = {};
    globalThis[instance.name] = {};
    helpers.default.global.setGlobalFederationInstance(instance);
    helpers.default.global.setPreloaded('packed', true);
    helpers.default.global.resetFederationRuntime();
    assert.equal(instance.moduleCache.size, 0);
    assert.equal(globalThis[instance.name], undefined);
    assert.equal(globalThis[`old_remote_${extension}`], undefined);
    assert.equal(helpers.default.global.getPreloaded('packed'), undefined);
  }
  // Forward the runtime's public fetch hook to the actual canonical Node entry loader.
  const core = installedRequire('@bleedingdev/mf-runtime-core');
  let healthy = false;
  let requests = 0;
  const entryServer = http.createServer((_request, response) => {
    requests++;
    response.writeHead(healthy ? 200 : 503, {
      'content-type': 'application/javascript',
    });
    response.end(
      healthy
        ? 'module.exports={init(){},get(id){return ()=>({id,value:"healthy"})}};'
        : 'unavailable',
    );
  });
  await new Promise(resolve => entryServer.listen(0, '127.0.0.1', resolve));
  try {
    const observed = [];
    const host = new core.ModuleFederation({
      name: 'packed_fetch',
      remotes: [
        {
          name: 'packed_remote',
          entry: `http://127.0.0.1:${entryServer.address().port}/entry.js`,
          type: 'commonjs-module',
          entryGlobalName: 'packed_remote',
        },
      ],
      plugins: [
        {
          name: 'packed-fetch-hook',
          async fetch(url, init, remoteInfo) {
            observed.push(remoteInfo.name);
            const response = await fetch(url, init);
            assert.ok(response.ok, `entry HTTP ${response.status}`);
            return response;
          },
        },
      ],
    });
    await assert.rejects(host.loadRemote('packed_remote/Card'));
    healthy = true;
    assert.deepEqual(await host.loadRemote('packed_remote/Card'), {
      id: './Card',
      value: 'healthy',
    });
    assert.equal(requests, 2);
    assert.deepEqual(observed, ['packed_remote', 'packed_remote']);
  } finally {
    entryServer.closeAllConnections();
    await new Promise(resolve => entryServer.close(resolve));
  }
  // DTS-disabled public metadata must not load the DTS toolchain eagerly.
  const manifestRoot = roots.get('manifest');
  for (const extension of ['js', 'mjs']) {
    const utils =
      extension === 'js'
        ? installedRequire(path.join(manifestRoot, 'dist/utils.js'))
        : await load(path.join(manifestRoot, 'dist/utils.mjs'));
    assert.deepEqual(utils.getTypesMetaInfo({ dts: false }, root), {
      path: '',
      name: '',
      zip: '',
      api: '',
    });
  }
  for (const [name, symbol] of [
    ['rspack', 'ModuleFederationPlugin'],
    ['enhanced', 'ModuleFederationPlugin'],
    ['dts-plugin', 'DtsPlugin'],
    ['rsbuild-plugin', 'pluginModuleFederation'],
  ]) {
    const api = installedRequire(`@bleedingdev/mf-${name}`);
    assert.equal(typeof api[symbol], 'function', `${name} public ${symbol}`);
  }
  // Exercise the actual enhanced/Rspack option path, not a disconnected copy.
  for (const owner of ['enhanced', 'rspack']) {
    const from = createRequire(path.join(roots.get(owner), 'package.json'));
    const bundler = from(owner === 'enhanced' ? 'webpack' : '@rspack/core');
    if (owner === 'enhanced') {
      assert.equal(bundler.version, '5.112.2', 'Latest Webpack qualification');
      const Factory = from(
        './dist/src/lib/container/FallbackModuleFactory.js',
      ).default;
      assert.equal(
        Object.getPrototypeOf(Factory.prototype),
        bundler.ModuleFactory.prototype,
        'Enhanced factories must use the public Webpack class identity',
      );
      const Dependency = from(
        './dist/src/lib/container/runtime/FederationRuntimeDependency.js',
      ).default;
      assert.ok(
        new Dependency('./entry.js') instanceof
          bundler.dependencies.ModuleDependency,
      );
      const utils = from('./dist/src/lib/container/runtime/utils.js');
      assert.deepEqual(
        utils.normalizeRuntimeInitOptionsWithOutShared({
          name: 'remote_parser',
          remotes: {
            remote: 'container@https://example.invalid/entry.js?user=a@b',
            relative: 'relativeContainer@/remoteEntry.js',
            invalid: 'container@',
          },
        }).remotes,
        [
          {
            alias: 'remote',
            name: 'container',
            entry: 'https://example.invalid/entry.js?user=a@b',
            shareScope: 'default',
            externalType: 'script',
          },
          {
            alias: 'relative',
            name: 'relativeContainer',
            entry: '/remoteEntry.js',
            shareScope: 'default',
            externalType: 'script',
          },
          {
            alias: 'invalid',
            name: '',
            entry: '',
            shareScope: 'default',
            externalType: 'unknown',
          },
        ],
      );
    }
    const Plugin = installedRequire(
      `@bleedingdev/mf-${owner}`,
    ).ModuleFederationPlugin;
    const plugin = new Plugin({
      name: `injection_${owner}`,
      remotes:
        owner === 'enhanced'
          ? { remote: 'remoteContainer@https://example.invalid/remoteEntry.js' }
          : {},
      shared:
        owner === 'enhanced'
          ? { react: { singleton: true, requiredVersion: '^19.0.0' } }
          : {},
      dts: false,
      manifest: false,
      experiments: { provideExternalRuntime: true },
    });
    const webpackEntry = path.join(root, 'webpack-compat-entry.js');
    if (owner === 'enhanced')
      fs.writeFileSync(
        webpackEntry,
        'import("remote/Button"); import("react");\n',
      );
    const compile = owner === 'enhanced' ? bundler : bundler.rspack;
    const compiler = compile({
      mode: 'none',
      context: root,
      entry: owner === 'enhanced' ? { main: webpackEntry } : {},
      output: { path: path.join(root, `unused-${owner}`) },
      plugins: [plugin],
    });
    try {
      if (owner === 'enhanced') {
        const stats = await new Promise((resolve, reject) =>
          compiler.run((error, result) =>
            error ? reject(error) : resolve(result),
          ),
        );
        assert.equal(
          stats.hasErrors(),
          false,
          stats.toString({ all: false, errors: true }),
        );
        const emitted = Object.keys(stats.compilation.assets)
          .map(file =>
            fs.readFileSync(path.join(compiler.outputPath, file), 'utf8'),
          )
          .join('\n');
        assert.match(emitted, /remoteContainer/u);
        assert.match(emitted, /https:\/\/example\.invalid\/remoteEntry\.js/u);
        assert.match(emitted, /federation/u);
      }
      const options = plugin._options;
      const registered = options.runtimePlugins.find(file =>
        file.includes('inject-external-runtime-core-plugin'),
      );
      assert.ok(
        registered && registered.startsWith(roots.get(owner)),
        'Injection must be registered from its owning package',
      );
      const embeddedRoot = path.dirname(path.dirname(registered));
      assert.match(
        fs.readFileSync(path.join(embeddedRoot, 'LICENSE'), 'utf8'),
        /2024-present zhanghang/u,
      );
      const provider = from(registered)();
      const canonical = from('@module-federation/runtime-tools/runtime-core');
      const globalRef = canonical.Global;
      const oldCore = globalRef._FEDERATION_RUNTIME_CORE;
      const oldFrom = globalRef._FEDERATION_RUNTIME_CORE_FROM;
      const warn = console.warn;
      const warnings = [];
      try {
        delete globalRef._FEDERATION_RUNTIME_CORE;
        delete globalRef._FEDERATION_RUNTIME_CORE_FROM;
        const args = { options: { name: `provider_${owner}` } };
        assert.equal(provider.beforeInit(args), args);
        const injected = globalRef._FEDERATION_RUNTIME_CORE;
        assert.equal(injected.ModuleFederation, canonical.ModuleFederation);
        assert.equal(injected.Global, canonical.Global);
        assert.equal(provider.beforeInit(args), args);
        console.warn = message => warnings.push(message);
        const other = { options: { name: 'conflicting-provider' } };
        assert.equal(provider.beforeInit(other), other);
        assert.equal(
          globalRef._FEDERATION_RUNTIME_CORE,
          injected,
          'Conflicting provider must not replace the singleton',
        );
        assert.equal(warnings.length, 1);
      } finally {
        console.warn = warn;
        globalRef._FEDERATION_RUNTIME_CORE = oldCore;
        globalRef._FEDERATION_RUNTIME_CORE_FROM = oldFrom;
      }
    } finally {
      await new Promise((resolve, reject) =>
        compiler.close(error => (error ? reject(error) : resolve())),
      );
    }
  }
  // Keep manifest generation at its enabled default. The injection-only fixture
  // above intentionally disables it and cannot qualify package self-identity.
  {
    const from = createRequire(
      path.join(roots.get('enhanced'), 'package.json'),
    );
    const webpack = from('webpack');
    const Plugin = installedRequire(
      '@bleedingdev/mf-enhanced',
    ).ModuleFederationPlugin;
    // Exercise the actual emitted lookup against both exact supported names,
    // and reject unrelated names without changing installed package bytes.
    const implementation = fs.readFileSync(
      path.join(
        roots.get('enhanced'),
        'dist/src/lib/container/ModuleFederationPlugin.js',
      ),
      'utf8',
    );
    const lookup = implementation.match(
      /function getEnhancedPackageVersion\(\) \{[\s\S]*?\n\}/u,
    );
    assert.ok(lookup, 'Packed enhanced must retain its owning version lookup');
    for (const [name, version, accepted] of [
      ['@module-federation/enhanced', '2.9.3', true],
      ['@bleedingdev/mf-enhanced', '2.9.5', true],
      ['@bleedingdev/unrelated-enhanced', '9.9.9', false],
      ['@bleedingdev/mf-enhanced', '', false],
    ]) {
      const fixture = fs.mkdtempSync(path.join(root, 'self-identity-'));
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({ name, version }),
      );
      const resolveVersion = () =>
        vm.runInNewContext(`(${lookup[0]})()`, {
          __dirname: fixture,
          node_fs: { default: fs },
          node_path: { default: path },
        });
      if (accepted) assert.equal(resolveVersion(), version);
      else assert.throws(resolveVersion, /Unable to resolve/u);
    }
    const entry = path.join(root, 'manifest-compat-entry.js');
    const outputPath = path.join(root, 'manifest-enabled-enhanced');
    fs.writeFileSync(entry, 'export const identity = "manifest-default";\n');
    const compiler = webpack({
      mode: 'none',
      context: root,
      entry: { main: entry },
      output: { path: outputPath, publicPath: 'auto' },
      plugins: [
        new Plugin({
          name: 'manifest_enabled_enhanced',
          filename: 'remoteEntry.js',
          exposes: { './identity': './manifest-compat-entry.js' },
          dts: false,
        }),
      ],
    });
    try {
      const stats = await new Promise((resolve, reject) =>
        compiler.run((error, result) =>
          error ? reject(error) : resolve(result),
        ),
      );
      assert.equal(
        stats.hasErrors(),
        false,
        stats.toString({ all: false, errors: true }),
      );
      const manifest = JSON.parse(
        fs.readFileSync(path.join(outputPath, 'mf-manifest.json'), 'utf8'),
      );
      assert.equal(manifest.metaData.pluginVersion, '2.9.5');
      assert.equal(manifest.name, 'manifest_enabled_enhanced');
      assert.ok(
        manifest.exposes.some(exposed => exposed.name === 'identity'),
        'Default manifest must retain the actual exposed module',
      );
    } finally {
      await new Promise((resolve, reject) =>
        compiler.close(error => (error ? reject(error) : resolve())),
      );
    }
  }
  const node = installedRequire('@bleedingdev/mf-node');
  assert.equal(typeof node.NodeFederationPlugin, 'function');
  const chunkRuntime = installedRequire(
    path.join(roots.get('node'), 'dist/src/runtimePlugin.js'),
  );
  const previousWebpack = globalThis.__webpack_require__;
  let readyCalls = 0;
  let resolved = 0;
  globalThis.__webpack_require__ = {
    m: {},
    O() {
      readyCalls++;
    },
  };
  try {
    const states = {
      app: [
        () => {
          resolved++;
        },
      ],
    };
    chunkRuntime.installChunk(
      { ids: ['app'], modules: { field() {} } },
      states,
      1,
    );
    assert.equal(states.app, 1);
    assert.equal(resolved, 1);
    assert.equal(
      readyCalls,
      1,
      'Chunk installation must wake startup readiness',
    );
    const separate = {};
    chunkRuntime.installChunk({ ids: ['other'], modules: {} }, separate, 0);
    assert.equal(separate.other, 0);
    assert.equal(
      states.other,
      undefined,
      'Runtime chunk states must remain isolated',
    );
  } finally {
    if (previousWebpack === undefined) delete globalThis.__webpack_require__;
    else globalThis.__webpack_require__ = previousWebpack;
  }
  const tools = installedRequire('@bleedingdev/mf-runtime-tools');
  assert.equal(typeof tools.createInstance, 'function');
  assert.ok(installedRequire('@bleedingdev/mf-webpack-bundler-runtime'));
  const cliManifest = JSON.parse(
    fs.readFileSync(path.join(roots.get('cli'), 'package.json')),
  );
  assert.ok(cliManifest.bin.mf, 'Preserve mf CLI bin');
  // Execute actual emitted DTS server functions with real competing sockets.
  for (const esm of [false, true]) {
    const directory = path.join(
      roots.get('dts-plugin'),
      esm ? 'dist/esm' : 'dist',
    );
    const file = prefix =>
      path.join(
        directory,
        fs
          .readdirSync(directory)
          .find(
            name =>
              name.startsWith(prefix) && name.endsWith(esm ? '.mjs' : '.js'),
          ),
      );
    const broker = fs.readFileSync(file('Broker-'), 'utf8');
    const start = broker.indexOf('function listen(server, port) {');
    assert.notEqual(start, -1);
    const listen = vm.runInNewContext(
      `(${broker.slice(start, broker.indexOf('\n}\n', start) + 2)})`,
    );
    const rpc = fs.readFileSync(file('expose-rpc-'), 'utf8');
    const resolveCompilerCommand = vm.runInNewContext(
      `${rpc.slice(rpc.indexOf('const getPMFromUserAgent ='), rpc.indexOf('const compileTs ='))}\nresolveCompilerCommand;`,
      {
        path: path.win32,
        isAbsolute: path.win32.isAbsolute,
        fs: { existsSync: () => true },
        existsSync: () => true,
        process: { platform: 'win32', env: {} },
      },
    );
    const compilerPath = String.raw`C:\Program Files\Effect & TypeScript\tsc.exe`;
    const command = resolveCompilerCommand(
      { compilerInstance: compilerPath },
      String.raw`C:\App Root\tsconfig.json`,
    );
    assert.equal(command.executable, compilerPath);
    assert.equal(command.shell, false);

    const begin = rpc.indexOf('//#region src/server/createHttpServer.ts');
    const createHttpServer = vm.runInNewContext(
      `${rpc.slice(begin, rpc.indexOf('//#endregion', begin))}\ncreateHttpServer;`,
      {
        http: { ...http, default: http },
        fs: { ...fs, default: fs },
        getFreePort: () => {
          throw Error('racy port probing');
        },
        getIPV4: () => '127.0.0.1',
        listen,
        DEFAULT_TAR_NAME: '@mf-types.zip',
        require_Broker: { listen, getIPV4: () => '127.0.0.1' },
        require_Action: { DEFAULT_TAR_NAME: '@mf-types.zip' },
      },
    );
    const competitor = net.createServer();
    await new Promise(resolve => competitor.listen(0, resolve));
    const servers = [];
    try {
      servers.push(
        ...(await Promise.all([
          createHttpServer({ typeTarPath: path.join(root, 'package.json') }),
          createHttpServer({ typeTarPath: path.join(root, 'package.json') }),
        ])),
      );
      assert.equal(
        new Set([
          competitor.address().port,
          ...servers.map(item => item.server.address().port),
        ]).size,
        3,
      );
      for (const item of servers)
        assert.equal(
          new URL(item.serverAddress).port,
          String(item.server.address().port),
        );
    } finally {
      await Promise.all(
        [competitor, ...servers.map(item => item.server)].map(
          server => new Promise(resolve => server.close(resolve)),
        ),
      );
    }
  }
  for (const format of ['cjs', 'esm-node', 'esm']) {
    const extension = format === 'cjs' ? 'js' : 'mjs';
    const directory = roots.get('modern-js-v3');
    const react =
      format === 'cjs'
        ? installedRequire(
            path.join(directory, `dist/${format}/react/index.${extension}`),
          )
        : await load(
            path.join(directory, `dist/${format}/react/index.${extension}`),
          );
    const modernRequire = createRequire(path.join(directory, 'package.json'));
    let bridgeRoot = path.dirname(
      modernRequire.resolve('@module-federation/bridge-react/base'),
    );
    while (!fs.existsSync(path.join(bridgeRoot, 'package.json')))
      bridgeRoot = path.dirname(bridgeRoot);
    const bridgeManifest = JSON.parse(
      fs.readFileSync(path.join(bridgeRoot, 'package.json'), 'utf8'),
    );
    assert.equal(bridgeManifest.name, '@bleedingdev/mf-bridge-react');
    const bridge =
      format === 'cjs'
        ? modernRequire('@module-federation/bridge-react/base')
        : await load(
            path.join(bridgeRoot, bridgeManifest.exports['./base'].import),
          );
    for (const symbol of ['createBridgeComponent', 'createRemoteComponent']) {
      assert.equal(typeof react[symbol], 'function');
      assert.equal(react[symbol], bridge[symbol]);
    }
    const file = path.join(
      directory,
      `dist/${format}/server/staticMiddleware.${extension}`,
    );
    const { createStaticMiddleware } =
      format === 'cjs' ? installedRequire(file) : await load(file);
    const bundles = path.join(root, `static-${format}`, 'bundles');
    fs.mkdirSync(bundles, { recursive: true });
    const bytes = Buffer.from('exports.value="Čeština, ř, 🚜";');
    fs.writeFileSync(path.join(bundles, 'unicode.js'), bytes);
    const middleware = createStaticMiddleware({
      pwd: path.dirname(bundles),
      assetPrefix: '',
    });
    const server = http.createServer((request, response) => {
      Promise.resolve(
        middleware(
          {
            req: { path: request.url },
            header: (name, value) => response.setHeader(name, value),
            body: content => response.end(content),
          },
          () => {
            response.writeHead(404).end();
          },
        ),
      ).catch(error => response.destroy(error));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/bundles/unicode.js`,
      );
      assert.equal(
        response.headers.get('content-length'),
        String(bytes.length),
      );
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  assert.equal(
    typeof sdkProbe,
    'function',
    'Canonical SDK correction probe is required',
  );
  await sdkProbe();
  process.stdout.write(
    `${JSON.stringify({ probe: 'mf-cohort', packages: suffixes.length, corrections: ['reset', 'fetch-retry', 'dts-port', 'bridge-base', 'ssr-utf8', 'sdk-public-api'] })}\n`,
  );
}
