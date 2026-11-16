import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = process.env.OWNED_TEMP_DIR;
assert(root, 'Run with owned-temp-dir --run solid-rc22 -- node <this file>');
assert.equal(process.versions.node, '26.13.1');
const owner = `solid-rc22-${process.pid}`;
const dependencies = path.join(root, 'node_modules');
const registered = new Set();
let stopBuild;
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}`);
};
const tuple = {
  'solid-js': '2.0.0-rc.22',
  '@solidjs/web': '2.0.0-rc.22',
  '@solidjs/signals': '2.0.0-rc.22',
  '@solidjs/compiler': '2.0.0-rc.22',
  '@babel/core': '8.1.2',
  seroval: '1.8.1',
  'seroval-plugins': '1.8.0',
};
const fixtureDependencies = {
  ...tuple,
  '@jridgewell/remapping': '2.3.5',
  '@rsbuild/core': '2.3.2',
  esbuild: '0.28.2',
  'happy-dom': '21.0.4',
};
fs.writeFileSync(
  path.join(root, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'pnpm@12.21.0',
    dependencies: fixtureDependencies,
  }),
);
const repositoryPolicy = parse(
  fs.readFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'utf8'),
);
const serializerOverrides = Object.fromEntries(
  ['seroval@>=1.0.0 <1.8.1', 'seroval-plugins@>=1.0.0 <1.8.0'].map(selector => {
    const version = repositoryPolicy.overrides[selector];
    assert.equal(
      version,
      tuple[selector.slice(0, selector.indexOf('@'))],
      `Repository serializer policy drift: ${selector}`,
    );
    return [selector, version];
  }),
);
fs.writeFileSync(
  path.join(root, 'pnpm-workspace.yaml'),
  stringify({ overrides: serializerOverrides }),
);
const register = (directory, kind) => {
  run('/Users/satan/bin/disk-guardian-artifacts', [
    'register',
    directory,
    '--owner',
    owner,
    '--owner-pid',
    String(process.pid),
    '--kind',
    kind,
    '--grace-hours',
    '24',
  ]);
  registered.add(directory);
};
try {
  assert.equal(
    spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    '12.21.0',
  );
  run('pnpm', [
    'install',
    '--ignore-scripts',
    '--strict-peer-dependencies',
    '--config.package-import-method=clone-or-copy',
    '--store-dir=/Users/satan/.pnpm-store',
  ]);
  register(dependencies, 'dependencies');
  const require = createRequire(path.join(root, 'package.json'));
  const locate = (request, name = request) => {
    const resolveFrom = name.startsWith('@solidjs/compiler-')
      ? createRequire(require.resolve('@solidjs/compiler'))
      : require;
    let directory = path.dirname(resolveFrom.resolve(request));
    for (;;) {
      const file = path.join(directory, 'package.json');
      if (
        fs.existsSync(file) &&
        JSON.parse(fs.readFileSync(file)).name === name
      )
        return directory;
      const parent = path.dirname(directory);
      assert.notEqual(parent, directory, name);
      directory = parent;
    }
  };
  const identities = {};
  // Authenticate the registry tarball, then compare every shipped file with the installed owner.
  for (const [name, version] of Object.entries({
    ...tuple,
    [`@solidjs/compiler-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`]:
      '2.0.0-rc.22',
  })) {
    const installed = locate(
      name === 'seroval-plugins' ? `${name}/web` : name,
      name,
    );
    const response = await fetch(
      `https://registry.npmjs.org/${name}/${version}`,
    );
    assert(response.ok, `${name} registry HTTP ${response.status}`);
    const metadata = await response.json();
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, version);
    const bytes = Buffer.from(
      await (await fetch(metadata.dist.tarball)).arrayBuffer(),
    );
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    assert.equal(integrity, metadata.dist.integrity, name);
    const archive = path.join(root, `${name.replaceAll('/', '-')}.tgz`);
    const extracted = `${archive}.source`;
    fs.writeFileSync(archive, bytes);
    fs.mkdirSync(extracted);
    run('tar', ['-xzf', archive, '-C', extracted]);
    let files = 0;
    const compare = relative => {
      for (const entry of fs.readdirSync(
        path.join(extracted, 'package', relative),
        { withFileTypes: true },
      )) {
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) compare(file);
        else {
          assert.deepEqual(
            fs.readFileSync(path.join(installed, file)),
            fs.readFileSync(path.join(extracted, 'package', file)),
            `${name}/${file}`,
          );
          files++;
        }
      }
    };
    compare('');
    identities[name] = { version, integrity, files };
  }
  const solidRequire = createRequire(require.resolve('solid-js'));
  const webRequire = createRequire(require.resolve('@solidjs/web'));
  for (const name of ['@solidjs/signals', 'seroval', 'seroval-plugins/web']) {
    assert.equal(
      fs.realpathSync(solidRequire.resolve(name)),
      fs.realpathSync(webRequire.resolve(name)),
      name,
    );
    assert.equal(
      fs.realpathSync(require.resolve(name)),
      fs.realpathSync(webRequire.resolve(name)),
      name,
    );
  }
  const source = path.join(repo, 'packages/runtime/renderer-solid');
  const copied = path.join(root, 'build');
  fs.cpSync(path.join(source, 'src'), path.join(copied, 'src'), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(source, 'package.json'),
    path.join(copied, 'package.json'),
  );
  fs.copyFileSync(
    path.join(source, 'native-loader.cjs'),
    path.join(copied, 'native-loader.cjs'),
  );
  register(copied, 'build');
  const { build, stop } = require('esbuild');
  stopBuild = stop;
  const core = path.join(repo, 'packages/runtime/renderer-core/src');
  const compileOwner = async (entry, outfile) => {
    await build({
      entryPoints: [path.join(copied, 'src', entry)],
      outfile: path.join(copied, outfile),
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      alias: {
        '@modern-js/renderer-core/identity': path.join(core, 'identity.ts'),
        '@modern-js/renderer-core': path.join(core, 'index.ts'),
      },
    });
    return import(pathToFileURL(path.join(copied, outfile)));
  };
  const { pluginSolidRenderer } = await compileOwner(
    'plugin/compiler.ts',
    'compiler.mjs',
  );
  const { validateSolidModuleManifest } = await compileOwner(
    'manifest.ts',
    'manifest.mjs',
  );
  const { nativePromiseSerializationPlugin } = await compileOwner(
    'native-promise-serialization.ts',
    'promise.mjs',
  );
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, 'Lazy.tsx'),
    'export default function Lazy(){ return <aside>lazy rc22</aside> }',
  );
  const app =
    'import { lazy } from "solid-js"; export const Deferred = lazy(() => import("./Lazy")); export default function App(){ return <main id="rc22">native rc22</main> }';
  fs.writeFileSync(path.join(src, 'index.tsx'), app);
  const nativeLoader = require(path.join(copied, 'native-loader.cjs'));
  for (const server of [true, false]) {
    const output = nativeLoader.call(
      {
        resourcePath: path.join(src, 'index.tsx'),
        getOptions: () => ({ server }),
      },
      app,
    );
    assert.match(output, /@solidjs\/web/u);
    assert(
      require('@babel/core').parseSync(output, {
        configFile: false,
        babelrc: false,
      }),
    );
  }
  const loader = require(path.join(copied, 'src/plugin/solid-loader.cjs'));
  const transform = (sourceText, server, isProd) =>
    new Promise((resolve, reject) => {
      const dependencies = [];
      loader.call(
        {
          resourcePath: path.join(src, 'index.tsx'),
          getOptions: () => ({
            projectRoot: root,
            server,
            isProd,
            sourceExtensions: ['.tsx', '.ts', '.jsx', '.js'],
          }),
          addDependency: file => dependencies.push(file),
          async: () => (error, code, map) =>
            error ? reject(error) : resolve({ code, map, dependencies }),
        },
        sourceText,
      );
    });
  for (const [server, isProd] of [
    [true, true],
    [false, true],
    [false, false],
  ]) {
    const result = await transform(app, server, isProd);
    assert(result.map.sources.some(file => file.endsWith('index.tsx')));
    assert(result.dependencies.includes(path.join(src, 'Lazy.tsx')));
    assert(result.code.includes('src/Lazy.tsx'));
    if (!server && !isProd) assert.match(result.code, /solid-js\/refresh/u);
    if (server) fs.writeFileSync(path.join(root, 'ssr.mjs'), result.code);
  }
  const domSource =
    'import { createSignal, flush } from "solid-js"; import { render } from "@solidjs/web"; export function mount(target) { const [count, setCount] = createSignal(1); const dispose = render(() => <button onClick={() => setCount(count() + 1)}>{count()}</button>, target); return { dispose, flush }; }';
  const dom = await transform(domSource, false, true);
  fs.writeFileSync(path.join(root, 'dom.js'), dom.code);
  await build({
    entryPoints: [path.join(root, 'dom.js')],
    outfile: path.join(copied, 'dom.mjs'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    conditions: ['solid', 'browser'],
  });
  fs.writeFileSync(
    path.join(root, 'dom-check.mjs'),
    `
    import assert from 'node:assert/strict';
    import { Window } from 'happy-dom';
    const window = new Window();
    for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
    const { mount } = await import('./build/dom.mjs');
    const { dispose, flush } = mount(document.body);
    assert.equal(document.querySelector('button').textContent, '1');
    document.querySelector('button').click();
    flush();
    assert.equal(document.querySelector('button').textContent, '2');
    dispose();
    assert.equal(document.body.textContent, '');
    await window.happyDOM.close();
  `,
  );
  run(process.execPath, [path.join(root, 'dom-check.mjs')]);
  const preserve = require(
    path.join(copied, 'src/plugin/preserve-import-loader.cjs'),
  );
  const preserveSource = sourceText =>
    new Promise((resolve, reject) =>
      preserve.call(
        {
          resourcePath: 'web.js',
          async: () => (error, code) => (error ? reject(error) : resolve(code)),
        },
        sourceText,
      ),
    );
  for (const filename of ['web.js', 'web.dev.js']) {
    const webSource = fs.readFileSync(
      path.join(locate('@solidjs/web'), 'dist', filename),
      'utf8',
    );
    assert.match(await preserveSource(webSource), /webpackIgnore: true/u);
  }
  for (const changed of [
    'export const changed = true;',
    'import(otherUrl);',
    'import(entryUrl); import(entryUrl);',
  ]) {
    await assert.rejects(preserveSource(changed), /import contract changed/u);
  }
  const identity = {
    renderer: 'solid',
    appId: 'rc22',
    entryName: 'index',
    protocolVersion: 1,
    buildId: 'qualification',
  };
  const { createRsbuild } = require('@rsbuild/core');
  const rsbuild = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      plugins: [
        pluginSolidRenderer({
          rendererIdentities: () => ({ index: identity }),
        }),
      ],
      source: { entry: { index: './src/index.tsx' } },
      output: { distPath: { root: 'dist' }, minify: false },
      tools: { rspack: { experiments: { outputModule: true } } },
    },
  });
  await rsbuild.build();
  register(path.join(root, 'dist'), 'build');
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'dist/solid-module-manifest.index.json'),
      'utf8',
    ),
  );
  validateSolidModuleManifest(manifest, identity, ['src/Lazy.tsx']);
  assert.equal(manifest.compilerVersion, '2.0.0-rc.22');
  assert.throws(
    () =>
      validateSolidModuleManifest(
        { ...manifest, compilerVersion: '2.0.0-rc.15' },
        identity,
      ),
    /ABI mismatch/u,
  );
  assert.throws(
    () =>
      validateSolidModuleManifest(manifest, { ...identity, buildId: 'stale' }),
    /Stale Solid/u,
  );
  const web = await import(pathToFileURL(require.resolve('@solidjs/web')));
  const solid = await import(pathToFileURL(require.resolve('solid-js')));
  const { default: App } = await import(
    pathToFileURL(path.join(root, 'ssr.mjs'))
  );
  assert.match(
    await new Response(web.renderToStream(App).readable).text(),
    /native rc22/u,
  );
  const memoOutcomes = [];
  for (const candidate of [false, true]) {
    for (const failure of [false, true]) {
      let settle;
      const future = new Promise((resolve, reject) => {
        settle = failure ? reject : resolve;
      });
      const errors = [];
      const memoStream = web
        .renderToStream(
          () =>
            solid.createComponent(solid.Errored, {
              fallback: web.ssr('<p>errored rc22</p>'),
              get children() {
                const value = solid.createMemo(async () => await future);
                return solid.createComponent(solid.Loading, {
                  fallback: web.ssr('<p>loading rc22</p>'),
                  get children() {
                    return web.ssr(['<p>', '</p>'], () => value());
                  },
                });
              },
            }),
          {
            plugins: candidate ? [nativePromiseSerializationPlugin] : undefined,
            onError(_error, details) {
              errors.push(details.handling);
              return new Error('public rc22 failure');
            },
          },
        )
        .readable.getReader();
      let output = new TextDecoder().decode((await memoStream.read()).value);
      assert.match(output, /loading rc22/u);
      settle(
        failure ? new Error('private rc22 failure') : 'resolved memo rc22',
      );
      for (;;) {
        const chunk = await memoStream.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      if (failure) {
        assert.deepEqual(errors, ['fallback']);
        assert.match(output, /errored rc22/u);
        assert.match(output, /public rc22 failure/u);
      } else assert.match(output, /resolved memo rc22/u);
      memoOutcomes.push(
        [...output.matchAll(/<template\b[^>]*>[\s\S]*?<\/template>/gu)].map(
          match => match[0],
        ),
      );
    }
  }
  assert.deepEqual(memoOutcomes.slice(0, 2), memoOutcomes.slice(2));
  let accept;
  const promise = new Promise(resolve => {
    accept = resolve;
  });
  const stream = web.renderToStream(
    () => {
      web
        .getHydrationWriter()
        .write('rc22:record', { first: promise, alias: promise });
      return [
        solid.createComponent(web.HydrationScript, {}),
        web.ssr('<main>shell rc22</main>'),
      ];
    },
    { renderId: 'rc22:', plugins: [nativePromiseSerializationPlugin] },
  );
  const reader = stream.readable.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  let html = new TextDecoder().decode(first.value);
  assert.match(html, /shell rc22/u);
  accept('settled rc22');
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    html += new TextDecoder().decode(chunk.value);
  }
  const names = ['window', 'self', 'document', '_$HY', '$R'];
  const previous = new Map(
    names.map(name => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  try {
    for (const name of ['window', 'self'])
      Object.defineProperty(globalThis, name, {
        value: globalThis,
        configurable: true,
      });
    Object.defineProperty(globalThis, 'document', {
      value: new EventTarget(),
      configurable: true,
    });
    for (const script of html.matchAll(
      /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu,
    ))
      new Function(script[1])();
    const record = globalThis._$HY.r['rc22:record'];
    assert.equal(record.first, record.alias);
    assert.equal(record.first.s, 1);
    assert.equal(record.first.v, 'settled rc22');
    assert.equal(await record.first, 'settled rc22');
    const writeScripts = text => {
      for (const script of text.matchAll(
        /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu,
      ))
        new Function(script[1])();
    };
    let reject;
    const future = new Promise((_resolve, fail) => {
      reject = fail;
    });
    const rejected = web
      .renderToStream(
        () => {
          web.getHydrationWriter().write('reject:record', { future });
          return [
            solid.createComponent(web.HydrationScript, {}),
            web.ssr('<p>reject shell</p>'),
          ];
        },
        { renderId: 'reject:', plugins: [nativePromiseSerializationPlugin] },
      )
      .readable.getReader();
    writeScripts(new TextDecoder().decode((await rejected.read()).value));
    const pending = globalThis._$HY.r['reject:record'].future;
    assert(pending instanceof Promise);
    assert.equal(pending.s, undefined);
    reject({ message: 'late rejection rc22' });
    for (;;) {
      const chunk = await rejected.read();
      if (chunk.done) break;
      writeScripts(new TextDecoder().decode(chunk.value));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(globalThis._$HY.r['reject:record'].future, pending);
    assert.equal(pending.s, 2);
    await assert.rejects(
      pending,
      reason =>
        reason === pending.v && reason.message === 'late rejection rc22',
    );
    let cancelReject;
    const cancelledSource = new Promise((_resolve, fail) => {
      cancelReject = fail;
    });
    const abort = new AbortController();
    let cleanups = 0;
    const cancelled = web
      .renderToStream(
        () => {
          solid.onCleanup(() => {
            cleanups++;
          });
          web
            .getHydrationWriter()
            .write('cancel:record', { future: cancelledSource });
          return web.ssr('<p>cancel shell</p>');
        },
        {
          renderId: 'cancel:',
          signal: abort.signal,
          plugins: [nativePromiseSerializationPlugin],
        },
      )
      .readable.getReader();
    assert.equal((await cancelled.read()).done, false);
    abort.abort(new Error('cancel rc22'));
    await cancelled.cancel();
    cancelReject(new Error('late source rejection after cancellation'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cleanups, 1);
    assert.equal((await cancelled.read()).done, true);
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        fixtureOverrides: serializerOverrides,
        host: `${process.platform}-${process.arch}`,
        identities,
        checks: [
          'authenticated-installed-bytes',
          'singleton-serializer-signals',
          'real-native-and-owning-loaders-dom-ssr-refresh-lazy-maps',
          'real-rsbuild-owning-plugin',
          'manifest-abi-and-identity-rejection',
          'native-dom-signal-click-disposal-emulated',
          'native-ssr',
          'native-async-memo-loading-and-error-policy',
          'incremental-native-promise-alias-settlement',
          'late-rejection-metadata',
          'native-abort-cleanup-no-late-rejection',
        ],
        pending: ['browser', 'worker', 'downstream'],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  stopBuild?.();
  if (fs.existsSync(dependencies) && !registered.has(dependencies))
    register(dependencies, 'dependencies');
  for (const directory of registered) {
    run('/Users/satan/bin/disk-guardian-artifacts', [
      'release',
      directory,
      '--owner',
      owner,
    ]);
    run('/Users/satan/bin/disk-guardian-artifacts', [
      'cleanup',
      '--only',
      directory,
      '--no-caches',
      '--apply',
    ]);
  }
}
