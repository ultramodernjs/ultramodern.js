import { createRequire } from 'node:module';
import path from 'node:path';
import { fileReader } from '@modern-js/runtime-utils/fileReader';
import helpers from '@module-federation/runtime/helpers';
import { onRepack } from '../src/helpers/repack';

const nodeRequire = createRequire(__filename);
const distDir = path.join(__dirname, 'fixtures/federated-ssr');
const bundlePath = path.join(distDir, 'bundles/index.js');
// The repack handler `@module-federation/modern-js-v3/server` registers
// (module-federation/core#5152). The dev server itself keeps no Module
// Federation knowledge.
const federationHooks = {
  onReset: {
    call: async ({ event }: { event: { type: string } }) => {
      if (event.type === 'repack') helpers.global.resetFederationRuntime();
    },
  },
} as any;
const hooks = { onReset: { call: rstest.fn() } } as any;

// The dev server loads SSR bundles through Node's CommonJS loader and
// `onRepack` evicts them from `require.cache`. Under rstest that identifier is
// the runner's module registry, so evict the bundle from Node's cache here.
const requireBundleGeneration = () => {
  delete nodeRequire.cache[bundlePath];
  return nodeRequire(bundlePath);
};

afterEach(async () => {
  await onRepack(distDir, federationHooks, fileReader);
});

describe('onRepack', () => {
  it('lets a re-required federated SSR bundle consume its own shared singletons', async () => {
    const previous = requireBundleGeneration();
    expect(previous.loadReact()).toBe(previous.react);
    expect((globalThis as any).host).toEqual({
      generation: previous.react.generation,
    });

    await onRepack(distDir, federationHooks, fileReader);
    expect((globalThis as any).host).toBeUndefined();
    expect(previous.federation.moduleCache.size).toBe(0);
    const next = requireBundleGeneration();

    expect(next.loadReact()).toBe(next.react);
  });

  it('leaves the federation runtime to the onReset handlers', async () => {
    const previous = requireBundleGeneration();
    expect(previous.loadReact()).toBe(previous.react);

    // No plugin resets it, so the next generation joins the previous one's
    // share scope and gets its react: a mixed generation.
    await onRepack(distDir, hooks, fileReader);
    const next = requireBundleGeneration();

    expect(next.loadReact()).toBe(previous.react);
  });

  it('purges the previous generation only after a slow async onReset handler settles', async () => {
    let releaseReset!: () => void;
    const slowHooks = {
      onReset: {
        call: () =>
          new Promise<void>(resolve => {
            releaseReset = resolve;
          }),
      },
    } as any;
    const reset = rstest.spyOn(fileReader, 'reset');
    try {
      const repack = onRepack(distDir, slowHooks, fileReader);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(reset).not.toHaveBeenCalled();

      releaseReset();
      await repack;
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      reset.mockRestore();
    }
  });

  it('purges the previous generation and rejects when an onReset handler throws', async () => {
    const error = new Error('reset failed');
    const failingHooks = {
      onReset: { call: async () => Promise.reject(error) },
    };
    const reset = rstest.spyOn(fileReader, 'reset');
    try {
      await expect(
        onRepack(distDir, failingHooks as any, fileReader),
      ).rejects.toBe(error);
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      reset.mockRestore();
    }
  });
});
