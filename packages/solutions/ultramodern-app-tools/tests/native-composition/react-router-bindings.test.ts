import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Entrypoint } from '@modern-js/types/cli/base';
import { describe, expect, it } from '@rstest/core';
import { validateRendererRouterBindings } from '../../../../toolkit/backend-federation-contracts/src/backend-federation-contract';
import { resolveReactRouterBindings } from '../../src/renderers/react/router-bindings';

const legacy = '@modern-js/plugin-router';
const tanstack = '@modern-js/plugin-tanstack';
const reactRouter = {
  framework: 'react-router',
  name: 'react-router',
  version: '8.5.1',
  coreName: 'react-router',
  coreVersion: '8.5.1',
};
const tanstackRouter = {
  framework: 'tanstack',
  name: '@tanstack/react-router',
  version: '1.170.46',
  coreName: '@tanstack/router-core',
  coreVersion: '1.171.39',
};
type RouterEntrypoint = Entrypoint & {
  __modernRoutesOwner?: string;
  __modernRoutesDir?: string;
};

function entry(
  entryName: string,
  metadata: Partial<RouterEntrypoint> = {},
): RouterEntrypoint {
  return {
    entryName,
    entry: '/fixture/src/App.tsx',
    isMainEntry: false,
    ...metadata,
  };
}

describe('React router owner bindings', () => {
  it('requires the positively registered default owner even for TanStack entries', () => {
    expect(() =>
      resolveReactRouterBindings({
        entrypoints: [entry('main', { __modernRoutesOwner: tanstack })],
        pluginNames: [tanstack],
      }),
    ).toThrow(/registered @modern-js\/plugin-router default owner/);
  });

  it('records the owned default for ordinary App entries', () => {
    const bindings = resolveReactRouterBindings({
      entrypoints: [entry('main')],
      pluginNames: [legacy],
    });
    expect(bindings.main).toEqual({
      owner: legacy,
      evidence: 'owned-default',
      defaultProvider: reactRouter,
      providers: [reactRouter],
    });
  });

  it('records TanStack file ownership only with the registered owner and canonical tag', () => {
    const bindings = resolveReactRouterBindings({
      entrypoints: [
        entry('main', {
          __modernRoutesOwner: tanstack,
          __modernRoutesDir: 'custom-tanstack-routes',
        }),
      ],
      pluginNames: [legacy, tanstack],
    });
    expect(bindings.main).toEqual({
      owner: tanstack,
      evidence: 'file-routes',
      defaultProvider: tanstackRouter,
      providers: [tanstackRouter],
    });
  });

  it('rejects a TanStack ownership tag without its registered CLI plugin', () => {
    expect(() =>
      resolveReactRouterBindings({
        entrypoints: [entry('main', { __modernRoutesOwner: tanstack })],
        pluginNames: [legacy],
      }),
    ).toThrow(/without its registered CLI owner/);
  });

  it('describes custom-entry provider availability without claiming app selection', () => {
    const bindings = resolveReactRouterBindings({
      entrypoints: [entry('main')],
      pluginNames: [legacy, tanstack],
    });
    expect(bindings.main).toEqual({
      owner: tanstack,
      evidence: 'provider-registry',
      defaultProvider: reactRouter,
      providers: [reactRouter, tanstackRouter],
    });
  });

  it.each([
    { nestedRoutesEntry: '/fixture/src/routes' },
    { __modernRoutesDir: 'routes' },
    { pageRoutesEntry: '/fixture/src/pages' },
    { __modernRoutesOwner: legacy, __modernRoutesDir: 'owned-custom-routes' },
  ])(
    'preserves the legacy route owner with TanStack registered: %o',
    metadata => {
      const bindings = resolveReactRouterBindings({
        entrypoints: [entry('main', metadata)],
        pluginNames: [legacy, tanstack],
      });
      expect(bindings.main.evidence).toBe('owned-default');
      expect(bindings.main.owner).toBe(legacy);
      expect(bindings.main.providers).toEqual([reactRouter]);
    },
  );

  it('rejects a foreign explicit owner before considering a legacy convention', () => {
    expect(() =>
      resolveReactRouterBindings({
        entrypoints: [
          entry('main', {
            __modernRoutesOwner: '@example/router',
            __modernRoutesDir: 'routes',
            pageRoutesEntry: '/fixture/src/pages',
          }),
        ],
        pluginNames: [legacy, tanstack],
      }),
    ).toThrow(/unsupported React router owner @example\/router/);
  });

  it('rejects an unowned foreign route convention instead of inferring TanStack', () => {
    expect(() =>
      resolveReactRouterBindings({
        entrypoints: [entry('main', { __modernRoutesDir: 'tanstack-routes' })],
        pluginNames: [legacy, tanstack],
      }),
    ).toThrow(/without a supported owner/);
  });

  it.each(['__modernRoutesOwner', '__modernRoutesDir'])(
    'rejects non-string canonical metadata for %s',
    key => {
      for (const value of [null, false, 42, {}, []]) {
        const entrypoint = entry('main');
        Object.defineProperty(entrypoint, key, { value });
        expect(() =>
          resolveReactRouterBindings({
            entrypoints: [entrypoint],
            pluginNames: [legacy, tanstack],
          }),
        ).toThrow(`invalid ${key} metadata; expected a string`);
      }
    },
  );

  it('preserves Unicode entry names and freezes every returned binding level', () => {
    const entries = Object.freeze([
      Object.freeze(entry('café🚜', { __modernRoutesOwner: tanstack })),
      Object.freeze(entry('cafe\u0301', { __modernRoutesDir: 'routes' })),
      Object.freeze(entry('constructor')),
    ]);
    const plugins = Object.freeze([legacy, tanstack]);
    const before = JSON.stringify(entries);
    const bindings = resolveReactRouterBindings({
      entrypoints: entries,
      pluginNames: plugins,
    });
    expect(Object.keys(bindings)).toEqual([
      'café🚜',
      'cafe\u0301',
      'constructor',
    ]);
    expect(Object.hasOwn(bindings, 'constructor')).toBe(true);
    expect(JSON.stringify(entries)).toBe(before);
    expect(Object.isFrozen(bindings)).toBe(true);
    for (const binding of Object.values(bindings)) {
      expect(Object.isFrozen(binding)).toBe(true);
      expect(Object.isFrozen(binding.providers)).toBe(true);
      expect(Object.isFrozen(binding.defaultProvider)).toBe(true);
      for (const provider of binding.providers) {
        expect(Object.isFrozen(provider)).toBe(true);
      }
    }
    expect(
      validateRendererRouterBindings(
        bindings,
        entries.map(value => value.entryName),
      ).ok,
    ).toBe(true);
    expect(validateRendererRouterBindings(bindings, ['café🚜']).ok).toBe(false);
  });

  it('rejects duplicate final entry names through the canonical validator', () => {
    expect(() =>
      resolveReactRouterBindings({
        entrypoints: [entry('main'), entry('main')],
        pluginNames: [legacy],
      }),
    ).toThrow(/expected entry "main" must be unique/);
  });

  it.each(['', ' main ', '__proto__'])(
    'rejects unsafe final entry name %j',
    name => {
      expect(() =>
        resolveReactRouterBindings({
          entrypoints: [entry(name)],
          pluginNames: [legacy],
        }),
      ).toThrow(/Invalid React router bindings/);
    },
  );

  it('accepts an empty final entry set without adding inferred bindings', () => {
    const bindings = resolveReactRouterBindings({
      entrypoints: [],
      pluginNames: [legacy],
    });
    expect(Object.keys(bindings)).toEqual([]);
    expect(Object.isFrozen(bindings)).toBe(true);
  });

  it('records the router versions the application installs through its framework owners', () => {
    const app = fs.mkdtempSync(
      path.join(os.tmpdir(), 'react-router-bindings-'),
    );
    const install = (
      directory: string,
      name: string,
      version: string,
      manifest: Record<string, unknown> = { name },
    ) => {
      const root = path.join(directory, 'node_modules', name);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ ...manifest, version }),
      );
      return root;
    };
    try {
      // The app shares an earlier TanStack patch with plugin-tanstack, as
      // pnpm overrides do; @modern-js/runtime keeps its React Router.
      // The published owner is an npm alias stamped with its source name.
      const plugin = install(app, tanstack, '3.9.0', {
        name: '@bleedingdev/modern-js-plugin-tanstack',
        ultramodern: { sourceName: tanstack },
      });
      const router = install(plugin, '@tanstack/react-router', '1.170.39');
      install(router, '@tanstack/router-core', '1.171.32');
      install(
        install(app, '@modern-js/runtime', '3.9.0'),
        'react-router',
        '8.5.1',
      );
      const bindings = resolveReactRouterBindings({
        entrypoints: [entry('main')],
        pluginNames: [legacy, tanstack],
        appDirectory: app,
      });
      expect(bindings.main.providers).toEqual([
        reactRouter,
        { ...tanstackRouter, version: '1.170.39', coreVersion: '1.171.32' },
      ]);
      // Before installation, the framework's declared routers are bound.
      const uninstalled = fs.mkdtempSync(
        path.join(os.tmpdir(), 'react-router-bindings-'),
      );
      try {
        expect(
          resolveReactRouterBindings({
            entrypoints: [entry('main')],
            pluginNames: [legacy, tanstack],
            appDirectory: uninstalled,
          }).main.providers,
        ).toEqual([reactRouter, tanstackRouter]);
      } finally {
        fs.rmSync(uninstalled, { recursive: true, force: true });
      }
      // A framework owner whose router cannot resolve its core is broken.
      const broken = fs.mkdtempSync(
        path.join(os.tmpdir(), 'react-router-bindings-'),
      );
      try {
        const brokenRouter = install(
          install(broken, tanstack, '3.9.0'),
          '@tanstack/react-router',
          '1.170.39',
        );
        // Block pnpm's test-runner NODE_PATH from supplying an ambient core.
        install(brokenRouter, '@tanstack/router-core', '0.0.0', {
          name: '@tanstack/router-core',
          exports: {},
        });
        expect(() =>
          resolveReactRouterBindings({
            entrypoints: [entry('main')],
            pluginNames: [legacy, tanstack],
            appDirectory: broken,
          }),
        ).toThrow(
          /installed without its @tanstack\/router-core core dependency/,
        );
      } finally {
        fs.rmSync(broken, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });

  it('keeps the explicit tuples aligned with their owning package manifests', () => {
    const runtime = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../../runtime/plugin-runtime/package.json',
        ),
        'utf8',
      ),
    );
    const provider = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../../runtime/plugin-tanstack/package.json',
        ),
        'utf8',
      ),
    );
    expect(runtime.dependencies['react-router']).toBe(reactRouter.version);
    expect(provider.peerDependencies['@tanstack/react-router']).toBe(
      tanstackRouter.version,
    );
    expect(provider.peerDependencies['@tanstack/router-core']).toBe(
      tanstackRouter.coreVersion,
    );
    expect(provider.devDependencies['@tanstack/react-router']).toBe(
      tanstackRouter.version,
    );
    expect(provider.devDependencies['@tanstack/router-core']).toBe(
      tanstackRouter.coreVersion,
    );
  });
});
