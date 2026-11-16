import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const patch = fs.readFileSync(
  new URL(
    '../../patches/@module-federation__modern-js-v3@2.9.3.patch',
    import.meta.url,
  ),
  'utf8',
);
const filters = [
  ...patch.matchAll(
    /\+\s+if \(!isServer && enableSSR && splitChunkConfig[\s\S]*?\+\s+if \(shouldWarn\)[^\n]+/g,
  ),
].map(
  match =>
    match[0]
      .split('\n')
      .map(line => line.slice(1))
      .join('\n') + '\n}',
);
assert.equal(filters.length, 3, 'exercise every shipped CLI module format');

for (const [format, filter] of filters.entries()) {
  function constrain(config, enableSSR = true, isServer = false) {
    let result = config;
    vm.runInNewContext(filter, {
      enableSSR,
      isServer,
      splitChunkConfig: config,
      _type_of__: value => typeof value,
      chain: {
        optimization: {
          splitChunks: value => {
            result = value;
          },
        },
      },
      logger: { warn() {} },
      external_logger_js_default: () => ({ warn() {} }),
    });
    return result;
  }

  test(`format ${format}: preserve disabled splitting and non-SSR settings`, () => {
    assert.equal(constrain(false), false);
    const config = { chunks: 'all', minSize: 123 };
    assert.equal(constrain(config, false), config);
    assert.equal(constrain(config, true, true), config);
    assert.equal(config.chunks, 'all');
  });

  test(`format ${format}: cache groups cannot reintroduce initial chunks`, () => {
    const accepts = chunk => chunk.accept;
    const config = {
      chunks: accepts,
      minSize: 123,
      cacheGroups: {
        vendor: { chunks: 'all', enforce: true, name: 'vendor' },
        initial: { chunks: 'initial' },
        selected: { chunks: accepts },
        disabled: false,
      },
      fallbackCacheGroup: { chunks: accepts, minSize: 456 },
    };
    assert.equal(constrain(config), config);
    assert.equal(config.minSize, 123);
    assert.equal(config.cacheGroups.vendor.name, 'vendor');
    assert.equal(config.cacheGroups.vendor.enforce, true);
    assert.equal(config.cacheGroups.vendor.chunks, 'async');
    assert.equal(config.cacheGroups.initial.chunks, 'async');
    assert.equal(config.cacheGroups.disabled, false);
    assert.equal(config.fallbackCacheGroup.minSize, 456);
    for (const chunks of [
      config.chunks,
      config.cacheGroups.selected.chunks,
      config.fallbackCacheGroup.chunks,
    ]) {
      assert.equal(chunks({ canBeInitial: () => true, accept: true }), false);
      assert.equal(chunks({ canBeInitial: () => false, accept: true }), true);
      assert.equal(chunks({ canBeInitial: () => false, accept: false }), false);
    }
  });
}

for (const [format, extension] of [
  ['cjs', 'js'],
  ['esm-node', 'mjs'],
  ['esm', 'mjs'],
]) {
  test(`${format}: native federation static middleware serves complete UTF-8 chunks`, async () => {
    const nativeRoot = fs.realpathSync(
      new URL(
        '../../packages/solutions/app-tools-extensions/node_modules/@module-federation/modern-js-v3',
        import.meta.url,
      ),
    );
    const relative = `dist/${format}/server/staticMiddleware.${extension}`;
    const nativeFile = path.join(nativeRoot, relative);
    const directory = fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        'mf-static-byte-length-',
      ),
    );
    let server;
    try {
      const createStaticMiddleware =
        extension === 'js'
          ? createRequire(import.meta.url)(nativeFile).createStaticMiddleware
          : (await import(pathToFileURL(nativeFile).href))
              .createStaticMiddleware;
      const bytes = Buffer.from(
        'exports.ids=["locale"];exports.modules={cs:()=>"Čeština, ř, 🚜"};',
      );
      const bundleDirectory = path.join(directory, 'bundles');
      fs.mkdirSync(bundleDirectory);
      fs.writeFileSync(path.join(bundleDirectory, 'locale.js'), bytes);
      const middleware = createStaticMiddleware({
        pwd: directory,
        assetPrefix: '',
      });
      server = http.createServer(async (request, response) => {
        try {
          await middleware(
            {
              req: { path: request.url },
              header: (name, value) => response.setHeader(name, value),
              body: content => response.end(content),
            },
            () => {
              response.statusCode = 404;
              response.end();
            },
          );
        } catch (error) {
          response.destroy(error);
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/bundles/locale.js`,
      );
      assert.equal(
        response.headers.get('content-length'),
        String(bytes.byteLength),
      );
      const received = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(received, bytes);
      const chunk = {};
      vm.runInThisContext(
        `(function(exports) {${received.toString('utf8')}\n})`,
      )(chunk);
      assert.equal(chunk.modules.cs(), 'Čeština, ř, 🚜');
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
