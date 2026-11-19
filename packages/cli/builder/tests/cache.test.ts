import { describe, expect, it } from '@rstest/core';
import { join } from 'path';
import * as cacheProof from '../../../../scripts/tests/fixture-builder-semantics';
import { createBuilder } from '../src';

describe('builder rspack with cache', () => {
  it('should disable cache by default', async () => {
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {},
      frameworkConfigPath: 'modern.config.ts',
      cwd: join(__dirname, '..'),
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    cacheProof.assertPersistentCache(bundlerConfigs[0].cache);
  });

  it('should generator rspack config correctly with cache', async () => {
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {
        performance: {
          buildCache: true,
        },
      },
      frameworkConfigPath: 'modern.config.ts',
      cwd: join(__dirname, '..'),
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    cacheProof.assertPersistentCache(bundlerConfigs[0].cache);
  });

  it('should isolate persistent cache directories by environment', async () => {
    const cacheDirectory = 'node_modules/.cache/rspack-ultramodern-app';
    const rsbuild = await createBuilder({
      bundlerType: 'rspack',
      config: {
        performance: {
          buildCache: {
            cacheDirectory,
            cacheDigest: ['ultramodern-app', 'cloudflare'],
          },
        },
        environments: {
          client: {
            output: {
              target: 'web',
            },
          },
          server: {
            output: {
              target: 'node',
            },
          },
          workerSSR: {
            output: {
              target: 'web-worker',
            },
          },
        },
      },
      frameworkConfigPath: 'modern.config.ts',
      cwd: join(__dirname, '..'),
    });

    const {
      origin: { bundlerConfigs },
    } = await rsbuild.inspectConfig();

    const directories = Object.fromEntries(
      (await cacheProof.assertCacheIsolation(bundlerConfigs)).map(config => [
        config.name,
        config.cache.storage.location,
      ]),
    );
    const expectedRoot = join(__dirname, '..', cacheDirectory);

    expect(directories.client).toContain(expectedRoot);
    expect(directories.server).toContain(expectedRoot);
    expect(directories.workerSSR).toContain(expectedRoot);
    expect(new Set(Object.values(directories)).size).toBe(
      Object.values(directories).length,
    );
  });
});
