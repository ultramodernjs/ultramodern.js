import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  createRsbuild,
  type RsbuildConfig,
  type Rspack,
  rspack,
} from '@rsbuild/core';
import { describe, expect, it } from '@rstest/core';
import type { ReactRuntimeConfig } from '../../src/native-composition/redact-config';
import {
  assertRedactPatch,
  createRedactBuilderPlugin,
  mergeRedactAliases,
  REDACT_ALIASES,
  redactArtifactDigest,
  redactRuntimeIdentity,
  resolveRedactAliases,
} from '../../src/renderers/react/redact-integration-plugin';

const installedRequire = createRequire(import.meta.url);
const require = process.env.REDACT_FIXTURE_ROOT
  ? createRequire(path.join(process.env.REDACT_FIXTURE_ROOT, 'package.json'))
  : installedRequire;
const artifactDirectory = path.resolve(
  path.dirname(require.resolve('@tanstack/redact')),
  '..',
);
// Module resources are native paths; assert file identities in POSIX form.
const posixPath = (file: string) => file.split(path.sep).join(path.posix.sep);

async function configure(
  options: {
    runtime?: ReactRuntimeConfig;
    target?: 'web' | 'node' | 'web-worker';
    mode?: RsbuildConfig['mode'];
    runtimeRequire?: NodeJS.Require;
  } = {},
) {
  const target = options.target ?? 'web';
  const builder = await createRsbuild({
    cwd: __dirname,
    config: {
      mode: options.mode ?? 'production',
      source: { entry: { index: import.meta.filename } },
      tools: { htmlPlugin: false },
      performance: { buildCache: { cacheDigest: ['authored'] } },
      environments: {
        [target === 'web-worker' ? 'workerSSR' : 'proof']: {
          output: { target },
        },
      },
      plugins: [
        {
          name: 'fixture:late-react-pins',
          setup(api) {
            api.modifyBundlerChain(chain => {
              chain.resolve.alias.set('react$', '/wrong-react.js');
            });
            api.modifyRspackConfig(config => {
              config.externals = {
                react: 'commonjs react',
                'react-dom/client': 'commonjs react-dom/client',
                'react-dom/server.browser': 'commonjs react-dom/server.browser',
                unrelated: 'commonjs unrelated',
              };
            });
          },
        },
        createRedactBuilderPlugin(options.runtime ?? {}, {
          require: options.runtimeRequire ?? require,
        }),
      ],
    },
  });
  return { builder, config: (await builder.initConfigs())[0] };
}

async function compile(config: Rspack.Configuration, source: string) {
  config.entry = {
    index: 'data:text/javascript,' + encodeURIComponent(source),
  };
  config.optimization = {
    ...config.optimization,
    minimize: false,
    concatenateModules: false,
    splitChunks: false,
    runtimeChunk: false,
  };
  config.cache = false;
  const compiler = rspack(config);
  compiler.hooks.shouldEmit.tap('no-test-artifacts', () => false);
  try {
    const stats = await new Promise<Rspack.Stats>((resolve, reject) =>
      compiler.run((error, result) =>
        error
          ? reject(error)
          : result
            ? resolve(result)
            : reject(new Error('No stats')),
      ),
    );
    expect(stats.toJson({ all: false, errors: true }).errors).toEqual([]);
    const modules = [...stats.compilation.modules]
      .map(module =>
        posixPath(
          'resource' in module ? String(module.resource) : module.identifier(),
        ),
      )
      .join('\n');
    const assets = stats.compilation
      .getAssets()
      .filter(item => item.name.endsWith('.js'));
    return {
      modules,
      code: assets.map(asset => String(asset.source.source())).join('\n'),
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      compiler.close(error => (error ? reject(error) : resolve())),
    );
  }
}

describe('native Redact integration without the external wrapper', () => {
  it.each(['web', 'node', 'web-worker'] as const)(
    'pins every React browser/server entry in %s and bundles the corrected runtime',
    async target => {
      const { config, builder } = await configure({ target });
      expect(config.resolve?.alias).toEqual(
        expect.objectContaining(resolveRedactAliases(require)),
      );
      expect(config.resolve?.alias).not.toHaveProperty('0');
      expect(config.externals).toEqual({ unrelated: 'commonjs unrelated' });
      expect(() => assertRedactPatch(readFileSync, require)).not.toThrow();
      const cache =
        builder.getNormalizedConfig().environments[
          target === 'web-worker' ? 'workerSSR' : 'proof'
        ].performance.buildCache;
      expect(cache).toMatchObject({
        cacheDigest: expect.arrayContaining([
          'authored',
          redactRuntimeIdentity(require),
          redactArtifactDigest(artifactDirectory),
        ]),
      });
      const { modules } = await compile(
        config,
        `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { renderToString } from 'react-dom/server.browser';
      export const html = renderToString(createElement('p', null, 'native-redact'));
      export const client = createRoot;
    `,
      );
      expect(modules).toContain(posixPath(artifactDirectory));
      expect(modules).not.toMatch(/[/\\]react(?:-dom)?[/\\]cjs[/\\]/);
      expect(modules).not.toContain('external "react');
      expect(modules.includes('/view-transition/stub.js')).toBe(true);
      expect(modules).not.toContain('/view-transition/full.js');
    },
  );

  it.each([false, true])(
    'executes the SSR bundle with viewTransitions=%s',
    async viewTransitions => {
      const { config } = await configure({
        target: 'node',
        runtime: { redact: { viewTransitions } },
      });
      config.output = { ...config.output, library: { type: 'commonjs2' } };
      const { modules, code } = await compile(
        config,
        `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { renderToString } from 'react-dom/server.edge';
      export const html = renderToString(createElement('p', null, 'native-redact'));
      export const client = createRoot;
    `,
      );
      expect(
        modules.split('\n').filter(id => id.includes('/view-transition/')),
      ).toContainEqual(
        expect.stringContaining(
          viewTransitions
            ? '/view-transition/full.js'
            : '/view-transition/stub.js',
        ),
      );
      expect(modules).not.toContain(
        viewTransitions
          ? '/view-transition/stub.js'
          : '/view-transition/full.js',
      );
      const result = { exports: {} };
      vm.runInNewContext(code, {
        module: result,
        exports: result.exports,
        require,
        process,
        console,
        TextEncoder,
        TextDecoder,
        ReadableStream,
        setTimeout,
        clearTimeout,
      });
      expect(result.exports).toMatchObject({
        html: '<p>native-redact</p>',
        client: expect.any(Function),
      });
    },
  );

  it.each([{ redact: false }, { server: { rsc: true } }])(
    'leaves real React and refresh untouched for %j',
    async runtime => {
      const { builder, config } = await configure({ runtime });
      expect(config.resolve?.alias).toHaveProperty('react$', '/wrong-react.js');
      expect(config.resolve?.alias).not.toHaveProperty('@tanstack/redact$');
      expect(
        config.plugins?.some(
          plugin =>
            plugin?.constructor.name === 'NormalModuleReplacementPlugin',
        ),
      ).toBe(false);
      const cache =
        builder.getNormalizedConfig().environments.proof.performance.buildCache;
      expect(cache).toMatchObject({
        cacheDigest: expect.arrayContaining([
          'ultramodern:real-react-cache:v1',
        ]),
      });
      expect(JSON.stringify(cache)).not.toContain('redact-artifact');
    },
  );

  it('invalidates the cache for changed transitive bytes and export maps at the same source version', () => {
    const root = mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'redact-digest-'),
    );
    const dist = path.join(root, 'dist');
    mkdirSync(path.join(dist, 'dom'), { recursive: true });
    const manifest = path.join(root, 'package.json');
    const transitive = path.join(dist, 'dom/runtime.js');
    writeFileSync(
      manifest,
      JSON.stringify({
        name: '@bleedingdev/tanstack-redact',
        version: '0.3.2',
        exports: './dist/index.js',
      }),
    );
    writeFileSync(
      path.join(dist, 'index.js'),
      'export * from "./dom/runtime.js";',
    );
    writeFileSync(transitive, 'export const revision = 1;');
    try {
      const before = redactArtifactDigest(dist);
      writeFileSync(transitive, 'export const revision = 2;');
      expect(redactArtifactDigest(dist)).not.toBe(before);
      writeFileSync(transitive, 'export const revision = 1;');
      expect(redactArtifactDigest(dist)).toBe(before);
      writeFileSync(
        manifest,
        JSON.stringify({
          name: '@bleedingdev/tanstack-redact',
          version: '0.3.2',
          exports: './dist/dom/runtime.js',
        }),
      );
      expect(redactArtifactDigest(dist)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on uncorrected artifacts with the actual installed identity', () => {
    expect(() =>
      assertRedactPatch(() => '// upstream bytes without corrections', require),
    ).toThrow(redactRuntimeIdentity(require));
    expect(() =>
      assertRedactPatch(() => '// upstream bytes without corrections', require),
    ).toThrow('redact: false');
  });

  it('preserves object and ordered array alias fallbacks, not numeric keys', () => {
    for (const previous of [
      { react$: '/wrong.js', other: false },
      [
        { name: 'react', alias: '/wrong.js', onlyModule: true },
        { name: 'other', alias: false },
        { name: 'fallback', alias: '/a' },
        { name: 'fallback', alias: '/b' },
      ],
    ]) {
      const merged = mergeRedactAliases(
        previous,
        resolveRedactAliases(require),
      );
      expect(merged).toMatchObject({
        ...resolveRedactAliases(require),
        other: false,
      });
      expect(merged).not.toHaveProperty('0');
      if (Array.isArray(previous))
        expect(merged).toHaveProperty('fallback', ['/a', '/b']);
    }
    expect(Object.keys(REDACT_ALIASES)).toContain('react-dom/server.browser');
  });

  it('rejects React 18 only for enabled Redact', async () => {
    const react18 = Object.assign(
      (id: string) =>
        id === 'react/package.json' ? { version: '18.3.1' } : require(id),
      require,
    );
    await expect(configure({ runtimeRequire: react18 })).rejects.toThrow(
      'requires React 19',
    );
    await expect(
      configure({ runtimeRequire: react18, runtime: { redact: false } }),
    ).resolves.toBeDefined();
  });

  it('keeps development refresh renderer interop while production removes it', async () => {
    const source = `import { createRoot } from 'react-dom/client'; export const root = createRoot;`;
    const development = await configure({ mode: 'development' });
    const dev = await compile(development.config, source);
    expect(dev.modules).toContain('/dom/refresh.js');
    expect(dev.code).toContain('setRefreshHandler');
    expect(dev.code).toContain('scheduleRefresh');
    const production = await configure();
    const prod = await compile(production.config, source);
    expect(prod.code).not.toContain('setRefreshHandler');
    expect(prod.code).not.toContain('scheduleRefresh');
    expect(development.config.resolve?.alias).not.toHaveProperty(
      'react-refresh/runtime$',
    );
  });
  it('refreshes a mounted component through the standard renderer hook without losing state', async () => {
    const { config } = await configure({ target: 'node', mode: 'development' });
    config.output = { ...config.output, library: { type: 'commonjs2' } };
    config.devtool = false;
    const { code } = await compile(
      config,
      `
      import { createElement, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      let update;
      export function Before() { const [count, set] = useState(0); update = set; return createElement('button', null, 'before:' + count); }
      export function After() { const [count, set] = useState(0); update = set; return createElement('button', null, 'after:' + count); }
      export function mount(container) { const root = createRoot(container); flushSync(() => root.render(createElement(Before))); return root; }
      export function increment() { flushSync(() => update(n => n + 1)); }
    `,
    );
    const { Window } = createRequire(installedRequire.resolve('@rstest/core'))(
      'happy-dom',
    );
    const window = new Window();
    const {
      document,
      navigator,
      HTMLElement,
      Element,
      Node,
      Text,
      MutationObserver,
    } = window;
    const container = document.createElement('div');
    document.body.append(container);
    const context = vm.createContext({
      module: { exports: {} },
      require,
      process,
      console,
      document,
      window,
      navigator,
      HTMLElement,
      Element,
      Node,
      Text,
      MutationObserver,
      TextEncoder,
      TextDecoder,
      ReadableStream,
      setTimeout,
      clearTimeout,
      performance,
      queueMicrotask,
      container,
    });
    vm.runInContext(
      `
      var renderer, mounted;
      globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        inject(value) { renderer = value; return 1; },
        onCommitFiberRoot(id, root) { mounted = root; },
      };
    `,
      context,
    );
    try {
      vm.runInContext(code, context);
      vm.runInContext(
        'module.exports.mount(container); module.exports.increment();',
        context,
      );
      expect(container.textContent).toBe('before:1');
      vm.runInContext(
        `
        var family = { current: module.exports.After };
        renderer.setRefreshHandler(type => type === module.exports.Before || type === module.exports.After ? family : undefined);
        renderer.scheduleRefresh(mounted, { updatedFamilies: new Set([family]), staleFamilies: new Set() });
      `,
        context,
      );
      expect(container.textContent).toBe('after:1');
      vm.runInContext('module.exports.increment()', context);
      expect(container.textContent).toBe('after:2');
    } finally {
      container.remove();
      await window.happyDOM.close();
    }
  });
});
