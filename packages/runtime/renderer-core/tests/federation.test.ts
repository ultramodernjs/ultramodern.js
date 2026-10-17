import {
  type FederationInstance,
  getFederationHost,
  loadFederatedModule,
  remoteBrowserAssets,
} from '../src/federation';

describe('application-owned federation', () => {
  test('captures each compiler host independently of initialization order', async () => {
    const first: FederationInstance = {
      loadRemote: async <T>() => ({ default: 'first' }) as T,
    };
    const second: FederationInstance = {
      loadRemote: async <T>() => ({ default: 'second' }) as T,
    };
    const binding = { instance: () => first };
    const host = getFederationHost(binding);
    expect(getFederationHost({ instance: () => second })).toBe(second);
    expect(host).toBe(first);
    expect(await loadFederatedModule(host, 'remote/Widget')).toEqual({
      module: { default: 'first' },
      assets: undefined,
    });
    expect(await loadFederatedModule(second, 'remote/Widget')).toEqual({
      module: { default: 'second' },
      assets: undefined,
    });
  });

  test('rejects absent and unavailable runtimes without consulting another host', async () => {
    expect(getFederationHost(undefined)).toBeUndefined();
    expect(() => getFederationHost({ instance: () => null! })).toThrow(
      'runtime has not started',
    );
    await expect(
      loadFederatedModule(undefined, 'remote/Widget'),
    ).rejects.toThrow('no Module Federation runtime');
    await expect(
      loadFederatedModule({ loadRemote: async () => null }, 'remote/Widget'),
    ).rejects.toThrow('unavailable');
  });

  test('resolves only the loaded expose and deduplicates its streamed CSS', () => {
    const remoteInfo = {};
    const instance: FederationInstance = {
      loadRemote: async () => null,
      remoteHandler: {
        idToRemoteMap: {
          'remote/Widget': { name: 'remote', expose: './Widget' },
        },
      },
      moduleCache: new Map([['remote', { remoteInfo }]]),
      snapshotHandler: {
        getGlobalRemoteInfo: info => {
          expect(info).toBe(remoteInfo);
          return {
            remoteSnapshot: {
              publicPath: 'https://remote.example/assets',
              remoteEntry: 'remoteEntry.js',
              modules: [
                {
                  modulePath: './Other',
                  assets: { css: { sync: ['unrelated.css'] } },
                },
                {
                  modulePath: './Widget',
                  assets: {
                    js: {
                      sync: ['widget.js', 'https://cdn.example/shared.js'],
                    },
                    css: {
                      sync: ['widget.css'],
                      async: ['widget.css', 'lazy.css'],
                    },
                  },
                },
              ],
            },
          };
        },
      },
    };
    expect(remoteBrowserAssets(instance, 'remote/Widget')).toEqual({
      js: [
        'https://remote.example/assets/remoteEntry.js',
        'https://remote.example/assets/widget.js',
        'https://cdn.example/shared.js',
      ],
      css: [
        'https://remote.example/assets/widget.css',
        'https://remote.example/assets/lazy.css',
      ],
    });
    expect(remoteBrowserAssets(instance, 'remote/Missing')).toBeUndefined();
  });

  test('retains the assets captured with the old module when development refresh replaces its snapshot', async () => {
    const captureLoad = Symbol.for('ultramodern.federation.load-with-capture');
    let file = 'v1.css';
    const instance: FederationInstance = {
      loadRemote: async <T>() => ({ default: 'old module' }) as T,
      remoteHandler: {
        idToRemoteMap: {
          'remote/Widget': { name: 'remote', expose: './Widget' },
        },
      },
      moduleCache: new Map([['remote', { remoteInfo: {} }]]),
      snapshotHandler: {
        getGlobalRemoteInfo: () => ({
          remoteSnapshot: {
            publicPath: 'https://remote.example/',
            remoteEntry: 'remoteEntry.js',
            modules: [
              { modulePath: './Widget', assets: { css: { sync: [file] } } },
            ],
          },
        }),
      },
    };
    Object.defineProperty(instance, captureLoad, {
      value: async <T, Captured>(
        _id: string,
        capture: (module: T | null) => Captured,
      ) => {
        const module = { default: 'old module' } as T;
        const captured = capture(module);
        file = 'v2.css';
        return { module, captured };
      },
    });
    const loaded = await loadFederatedModule(instance, 'remote/Widget');
    expect(loaded.module).toEqual({ default: 'old module' });
    expect(loaded.assets?.css).toEqual(['https://remote.example/v1.css']);
    expect(remoteBrowserAssets(instance, 'remote/Widget')?.css).toEqual([
      'https://remote.example/v2.css',
    ]);
  });

  test('captures a load-owned admitted snapshot after another host replaces the process-global snapshot', async () => {
    const snapshot = (file: string) => ({
      publicPath: 'https://remote.example/',
      remoteEntry: 'remoteEntry.js',
      modules: [{ modulePath: './Widget', assets: { css: { sync: [file] } } }],
    });
    const admitted = snapshot('v1.css');
    const instance: FederationInstance = {
      loadRemote: async () => null,
      remoteHandler: {
        idToRemoteMap: {
          'remote/Widget': { name: 'remote', expose: './Widget' },
        },
      },
      moduleCache: new Map([['remote', { remoteInfo: {} }]]),
      snapshotHandler: {
        getGlobalRemoteInfo: () => ({ remoteSnapshot: snapshot('v2.css') }),
      },
    };
    Object.defineProperty(
      instance,
      Symbol.for('ultramodern.federation.load-with-capture'),
      {
        value: async <T, Captured>(
          _id: string,
          capture: (
            module: T | null,
            resolution: { remoteSnapshot: unknown; expose: string },
          ) => Captured,
        ) => {
          const module = { default: 'old module' } as T;
          return {
            module,
            captured: capture(module, {
              remoteSnapshot: admitted,
              expose: './Widget',
            }),
          };
        },
      },
    );
    expect(
      (await loadFederatedModule(instance, 'remote/Widget')).assets?.css,
    ).toEqual(['https://remote.example/v1.css']);
    expect(remoteBrowserAssets(instance, 'remote/Widget')?.css).toEqual([
      'https://remote.example/v2.css',
    ]);
  });
});
