import {
  RENDERER_FEDERATION_METADATA_KEY,
  RENDERER_FEDERATION_SCHEMA,
  RENDERER_FEDERATION_SCHEMA_VERSION,
  type RendererFederationCompatibility,
  readRendererFederationContract,
} from '../../src/module-federation/renderer-contract';
import {
  createRendererFederationRuntimePlugin,
  rendererShareVersions,
} from '../../src/module-federation/renderer-runtime-plugin';

const consumingRenderer: RendererFederationCompatibility = {
  profile: {
    renderer: 'react',
    protocolVersion: 1,
    compiler: { name: '@rsbuild/plugin-react', version: '2.1.1' },
    hydration: { name: 'react-dom', version: '19.3.0' },
    router: {
      name: 'react-router',
      version: '7.18.4',
      coreName: 'react-router',
      coreVersion: '7.18.4',
    },
  },
  runtime: { name: 'react', version: '19.3.0' },
  bootstrap: { name: '@modern-js/runtime', version: '3.9.0' },
};

const publication = (appId = 'inventory', buildId = 'inventory-build') => ({
  schema: RENDERER_FEDERATION_SCHEMA,
  schemaVersion: RENDERER_FEDERATION_SCHEMA_VERSION,
  ...structuredClone(consumingRenderer),
  identities: {
    main: {
      renderer: 'react',
      protocolVersion: 1,
      appId,
      entryName: 'main',
      buildId,
    },
  },
});

const manifest = (contract: unknown = publication()) => ({
  metaData: { [RENDERER_FEDERATION_METADATA_KEY]: contract },
  exposes: [{ name: 'Product', path: './Product' }],
  shared: [],
});

const snapshot = (): Record<string, unknown> => ({
  globalName: 'inventory',
  buildVersion: '0.1.0',
  remoteEntry: 'remoteEntry.js',
  remoteEntryType: 'global',
  ssrRemoteEntry: 'server/remoteEntry.js',
  ssrRemoteEntryType: 'commonjs-module',
  publicPath: 'https://inventory.example/assets/',
  ssrPublicPath: 'https://inventory.example/assets/',
});

// Corrupt a single manifest input without weakening the typed valid fixture.
function withField(path: readonly string[], value: unknown): unknown {
  const contract = publication() as Record<string, unknown>;
  let parent = contract;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Record<string, unknown>;
  }
  const key = path[path.length - 1];
  if (value === undefined) {
    delete parent[key];
  } else {
    parent[key] = value;
  }
  return contract;
}

type RuntimePlugin = ReturnType<typeof createRendererFederationRuntimePlugin>;
type ShareArgs = Parameters<RuntimePlugin['resolveShare']>[0];
type ShareResult = NonNullable<ReturnType<ShareArgs['resolver']>>;
type ResolveArgs = Parameters<RuntimePlugin['afterResolve']>[0];

const remoteInfo = (): Record<string, unknown> => ({
  name: 'inventory',
  entry: 'https://inventory.example/assets/server/remoteEntry.js',
  type: 'commonjs-module',
  entryGlobalName: 'inventory',
  buildVersion: '0.1.0',
});

async function nativeResolution(plugin: RuntimePlugin): Promise<ResolveArgs> {
  const remoteSnapshot = snapshot();
  await plugin.loadRemoteSnapshot({
    from: 'manifest',
    manifestJson: manifest(),
    remoteSnapshot,
  });
  await plugin.afterLoadSnapshot({ remoteSnapshot });
  const args: ResolveArgs = {
    remote: { name: 'inventory' },
    remoteInfo: remoteInfo(),
    remoteSnapshot,
    origin: { moduleCache: new Map() },
  };
  await plugin.afterResolve(args);
  return args;
}

describe('renderer federation publication admission', () => {
  test('accepts the same renderer tuple with independent app and build identities', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    const remotePublication = publication('cart', 'cart-build');
    const args = {
      from: 'manifest' as const,
      manifestJson: manifest(remotePublication),
      remoteSnapshot,
    };

    await expect(plugin.loadRemoteSnapshot(args)).resolves.toBe(args);
    await expect(plugin.afterLoadSnapshot({ remoteSnapshot })).resolves.toEqual(
      { remoteSnapshot },
    );
    expect(
      readRendererFederationContract(remotePublication).identities.main,
    ).toMatchObject({ appId: 'cart', buildId: 'cart-build' });
  });

  test.each([
    ['compiler package', ['profile', 'compiler', 'name'], 'other-compiler'],
    ['compiler version', ['profile', 'compiler', 'version'], '2.2.0'],
    ['hydration package', ['profile', 'hydration', 'name'], 'other-hydration'],
    ['hydration version', ['profile', 'hydration', 'version'], '19.4.0'],
    ['router package', ['profile', 'router', 'name'], 'other-router'],
    ['router version', ['profile', 'router', 'version'], '7.19.0'],
    ['router core package', ['profile', 'router', 'coreName'], 'other-core'],
    ['router core version', ['profile', 'router', 'coreVersion'], '7.19.0'],
    ['runtime package', ['runtime', 'name'], 'other-runtime'],
    ['runtime version', ['runtime', 'version'], '19.4.0'],
    ['bootstrap package', ['bootstrap', 'name'], 'other-bootstrap'],
    ['bootstrap version', ['bootstrap', 'version'], '3.10.0'],
    ['renderer protocol', ['profile', 'protocolVersion'], 2],
    ['identity protocol', ['identities', 'main', 'protocolVersion'], 2],
    ['publication schema', ['schema'], 'other.renderer-federation'],
    ['publication schema version', ['schemaVersion'], 2],
    ['missing schema version', ['schemaVersion'], undefined],
    ['unknown publication field', ['legacyRenderer'], 'react'],
    ['unknown profile field', ['profile', 'legacyCompiler'], 'react'],
    ['unknown runtime field', ['runtime', 'alias'], 'react'],
    ['unknown bootstrap field', ['bootstrap', 'alias'], 'runtime'],
    ['missing identity', ['identities'], {}],
    ['missing identity build', ['identities', 'main', 'buildId'], undefined],
    ['incoherent entry identity', ['identities', 'main', 'entryName'], 'other'],
    [
      'incoherent renderer identity',
      ['identities', 'main', 'renderer'],
      'solid',
    ],
    ['non-exact runtime version', ['runtime', 'version'], '^19.3.0'],
  ] satisfies [string, string[], unknown][])(
    'rejects %s before the consumer evaluates its entry',
    async (_name, path, value) => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      let entryEvaluations = 0;
      const load = async () => {
        const remoteSnapshot = snapshot();
        await plugin.loadRemoteSnapshot({
          from: 'manifest',
          manifestJson: manifest(withField(path, value)),
          remoteSnapshot,
        });
        await plugin.afterLoadSnapshot({ remoteSnapshot });
        entryEvaluations += 1;
      };

      await expect(load()).rejects.toThrow();
      expect(entryEvaluations).toBe(0);
    },
  );

  test('rejects a coherent cross-renderer publication before entry evaluation', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const contract = publication();
    const crossRenderer = {
      ...contract,
      profile: { ...contract.profile, renderer: 'solid' },
      identities: {
        main: { ...contract.identities.main, renderer: 'solid' },
      },
    };
    let entryEvaluations = 0;
    const load = async () => {
      const remoteSnapshot = snapshot();
      await plugin.loadRemoteSnapshot({
        from: 'manifest',
        manifestJson: manifest(crossRenderer),
        remoteSnapshot,
      });
      await plugin.afterLoadSnapshot({ remoteSnapshot });
      entryEvaluations += 1;
    };

    await expect(load()).rejects.toThrow('cross-renderer');
    expect(entryEvaluations).toBe(0);
  });

  test.each([
    ['missing manifest', undefined],
    ['missing metadata', { exposes: [], shared: [] }],
    ['missing renderer metadata', { metaData: {}, exposes: [], shared: [] }],
    ['null renderer metadata', manifest(null)],
  ])('rejects %s', async (_name, manifestJson) => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    await expect(
      plugin.loadRemoteSnapshot({
        from: 'manifest',
        manifestJson,
        remoteSnapshot: snapshot(),
      }),
    ).rejects.toThrow('renderer publication metadata is absent');
  });

  test('rejects entries belonging to different apps in one publication', () => {
    const contract = publication();
    expect(() =>
      readRendererFederationContract({
        ...contract,
        identities: {
          ...contract.identities,
          checkout: {
            ...contract.identities.main,
            appId: 'checkout',
            entryName: 'checkout',
          },
        },
      }),
    ).toThrow('incoherent publication identity');
  });

  test('accepts multiple finalized entry identities from one app', () => {
    const contract = publication();
    const entries = {
      ...contract.identities,
      checkout: {
        ...contract.identities.main,
        entryName: 'checkout',
        buildId: 'checkout-entry-build',
      },
    };
    expect(
      readRendererFederationContract({ ...contract, identities: entries })
        .identities,
    ).toEqual(entries);
  });

  test.each(['https://inventory.example/remoteEntry.js', '/remoteEntry.js'])(
    'rejects an unchecked direct container %s during registration',
    entry => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      expect(() =>
        plugin.beforeRegisterRemote({ remote: { name: 'inventory', entry } }),
      ).toThrow('native JSON manifest');
    },
  );

  test('accepts native manifest and version registrations', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    for (const remote of [
      {
        name: 'inventory',
        entry: 'https://inventory.example/mf-manifest.json',
      },
      { name: 'inventory', version: '0.1.0' },
    ]) {
      const args = { remote };
      expect(plugin.beforeRegisterRemote(args)).toBe(args);
    }
  });

  test('checks a direct container returned by the native match hook', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    await expect(
      plugin.afterMatchRemote({
        remote: {
          name: 'inventory',
          entry: 'https://inventory.example/entry.js',
        },
      }),
    ).rejects.toThrow('native JSON manifest');
  });
});

describe('renderer federation native snapshot cache', () => {
  test('retains immutable metadata across the global snapshot path', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    const remoteManifest = manifest();
    await plugin.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: remoteManifest,
      remoteSnapshot,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      remoteSnapshot,
      Symbol.for('ultramodern.renderer-federation.attestation.v1'),
    );
    expect(descriptor).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expect(Object.isFrozen(descriptor?.value)).toBe(true);
    expect(Object.isFrozen(descriptor?.value.contract.profile.hydration)).toBe(
      true,
    );

    remoteManifest.metaData[RENDERER_FEDERATION_METADATA_KEY] = publication(
      'tampered-app',
      'tampered-build',
    );
    const cacheArgs = { from: 'global' as const, remoteSnapshot };
    await expect(plugin.loadRemoteSnapshot(cacheArgs)).resolves.toBe(cacheArgs);
    expect(descriptor?.value.contract.identities.main.appId).toBe('inventory');
  });

  test('a second host accepts a retained snapshot through its mandatory gate', async () => {
    const creator = createRendererFederationRuntimePlugin(consumingRenderer);
    const consumer = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    await creator.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });

    // A native shared manifest promise can bypass the consumer's creator hook.
    await expect(
      consumer.afterLoadSnapshot({ remoteSnapshot }),
    ).resolves.toEqual({ remoteSnapshot });
  });

  test('an incompatible creator does not poison the snapshot for a compatible host', async () => {
    const creator = createRendererFederationRuntimePlugin({
      ...consumingRenderer,
      bootstrap: { ...consumingRenderer.bootstrap, version: '3.10.0' },
    });
    const consumer = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    await expect(
      creator.loadRemoteSnapshot({
        from: 'manifest',
        manifestJson: manifest(),
        remoteSnapshot,
      }),
    ).resolves.toBeDefined();
    await expect(creator.afterLoadSnapshot({ remoteSnapshot })).rejects.toThrow(
      'bootstrap.version',
    );
    await expect(
      consumer.afterLoadSnapshot({ remoteSnapshot }),
    ).resolves.toEqual({ remoteSnapshot });
  });

  test('a second host rejects a cached snapshot incompatible with its own tuple', async () => {
    const creator = createRendererFederationRuntimePlugin(consumingRenderer);
    const consumer = createRendererFederationRuntimePlugin({
      ...consumingRenderer,
      bootstrap: { ...consumingRenderer.bootstrap, version: '3.10.0' },
    });
    const remoteSnapshot = snapshot();
    await creator.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });
    let entryEvaluations = 0;
    const load = async () => {
      await consumer.afterLoadSnapshot({ remoteSnapshot });
      entryEvaluations += 1;
    };

    await expect(load()).rejects.toThrow('bootstrap.version');
    expect(entryEvaluations).toBe(0);
  });

  test.each(['global', 'afterLoadSnapshot'] as const)(
    'rejects bare serialized metadata in the %s cache gate',
    async hook => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      const remoteSnapshot = {
        ...snapshot(),
        [RENDERER_FEDERATION_METADATA_KEY]: publication(),
      };
      const load =
        hook === 'global'
          ? plugin.loadRemoteSnapshot({ from: 'global', remoteSnapshot })
          : plugin.afterLoadSnapshot({ remoteSnapshot });
      await expect(load).rejects.toThrow('attestation');
    },
  );

  test('rejects a cloned snapshot that lost its loader attestation', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    await plugin.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });

    await expect(
      plugin.afterLoadSnapshot({ remoteSnapshot: { ...remoteSnapshot } }),
    ).rejects.toThrow('attestation');
  });

  test.each([
    'globalName',
    'buildVersion',
    'remoteEntry',
    'remoteEntryType',
    'ssrRemoteEntry',
    'ssrRemoteEntryType',
    'publicPath',
    'ssrPublicPath',
    'getPublicPath',
  ])('rejects a cached snapshot with changed %s', async field => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    await plugin.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });
    remoteSnapshot[field] = 'different-entry-coordinate';

    await expect(plugin.afterLoadSnapshot({ remoteSnapshot })).rejects.toThrow(
      'attestation',
    );
  });

  test('rejects a second publication claiming the same retained snapshot', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    await plugin.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });

    await expect(
      plugin.loadRemoteSnapshot({
        from: 'manifest',
        manifestJson: manifest(publication('other-app', 'other-build')),
        remoteSnapshot,
      }),
    ).rejects.toThrow('conflicting publication ownership');
  });
});

describe('renderer federation native container cache', () => {
  test('preserves native entry loading after the snapshot accepts its coordinates', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const args = await nativeResolution(plugin);

    expect(plugin.loadEntry({ remoteInfo: args.remoteInfo })).toBeUndefined();
  });

  test.each(['entry', 'type', 'name'])(
    'rejects an unattested %s before entry evaluation',
    async field => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      await nativeResolution(plugin);
      const unmatched = remoteInfo();
      unmatched[field] = 'unattested-entry-coordinate';
      let entryEvaluations = 0;
      const load = () => {
        plugin.loadEntry({ remoteInfo: unmatched });
        entryEvaluations += 1;
      };

      expect(load).toThrow(
        'coordinates differ from the attested native snapshot',
      );
      expect(entryEvaluations).toBe(0);
    },
  );

  test('rejects entry loading before this host accepts any snapshot', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    expect(() => plugin.loadEntry({ remoteInfo: remoteInfo() })).toThrow(
      'coordinates differ from the attested native snapshot',
    );
  });

  test('rejects resolution without an attested native snapshot', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    await expect(
      plugin.afterResolve({
        remote: { name: 'inventory' },
        remoteInfo: remoteInfo(),
        origin: { moduleCache: new Map() },
      }),
    ).rejects.toThrow('no attested snapshot');
  });

  test('permits a native Module whose remoteInfo passed this host gate', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    await plugin.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });
    const args: ResolveArgs = {
      remote: { name: 'inventory' },
      remoteInfo: remoteInfo(),
      remoteSnapshot,
      origin: { moduleCache: new Map() },
    };
    await expect(plugin.afterResolve(args)).resolves.toBe(args);
    args.origin.moduleCache.set('inventory', { remoteInfo: args.remoteInfo });
    const reuse = { ...args, remoteInfo: { ...args.remoteInfo } };

    await expect(plugin.afterResolve(reuse)).resolves.toBe(reuse);
  });

  test('rejects a raw cached container even when its coordinates match the snapshot', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    await plugin.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });
    const args: ResolveArgs = {
      remote: { name: 'inventory' },
      remoteInfo: remoteInfo(),
      remoteSnapshot,
      origin: {
        moduleCache: new Map([['inventory', { remoteInfo: remoteInfo() }]]),
      },
    };
    let entryEvaluations = 0;
    const load = async () => {
      await plugin.afterResolve(args);
      entryEvaluations += 1;
    };

    await expect(load()).rejects.toThrow('unattested or conflicting ownership');
    expect(entryEvaluations).toBe(0);
  });

  test.each(['name', 'entry', 'type', 'entryGlobalName', 'buildVersion'])(
    'rejects in-place changes to an approved container %s',
    async field => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      const remoteSnapshot = snapshot();
      await plugin.loadRemoteSnapshot({
        from: 'manifest',
        manifestJson: manifest(),
        remoteSnapshot,
      });
      const args: ResolveArgs = {
        remote: { name: 'inventory' },
        remoteInfo: remoteInfo(),
        remoteSnapshot,
        origin: { moduleCache: new Map() },
      };
      await plugin.afterResolve(args);
      args.origin.moduleCache.set('inventory', { remoteInfo: args.remoteInfo });
      args.remoteInfo[field] = 'changed-container-coordinate';

      await expect(plugin.afterResolve(args)).rejects.toThrow('ownership');
    },
  );

  test('checks compatibility again at final native resolution', async () => {
    const creator = createRendererFederationRuntimePlugin(consumingRenderer);
    const consumer = createRendererFederationRuntimePlugin({
      ...consumingRenderer,
      bootstrap: { ...consumingRenderer.bootstrap, version: '3.10.0' },
    });
    const remoteSnapshot = snapshot();
    await creator.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });

    await expect(
      consumer.afterResolve({
        remote: { name: 'inventory' },
        remoteInfo: remoteInfo(),
        remoteSnapshot,
        origin: { moduleCache: new Map() },
      }),
    ).rejects.toThrow('bootstrap.version');
  });

  test('permits cached exports previously observed through this host native loader', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const args = await nativeResolution(plugin);
    const remoteEntryExports = {
      get: () => Promise.resolve(() => ({})),
      init: () => undefined,
    };
    const entryArgs = { remoteInfo: args.remoteInfo, remoteEntryExports };
    await expect(plugin.afterLoadEntry(entryArgs)).resolves.toBe(entryArgs);
    const cached = { ...entryArgs, cached: true };

    await expect(plugin.afterLoadEntry(cached)).resolves.toBe(cached);
  });

  test('accepts native preload exports before custom resolution and reuses them for the Module', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const remoteSnapshot = snapshot();
    await plugin.loadRemoteSnapshot({
      from: 'manifest',
      manifestJson: manifest(),
      remoteSnapshot,
    });
    await plugin.afterLoadSnapshot({ remoteSnapshot });
    const preloadInfo = remoteInfo();
    delete preloadInfo.buildVersion;
    const remoteEntryExports = { get: () => Promise.resolve(() => ({})) };
    const preload = {
      remoteInfo: preloadInfo,
      remoteEntryExports,
      cached: false,
    };
    await expect(plugin.afterLoadEntry(preload)).resolves.toBe(preload);

    const resolved: ResolveArgs = {
      remote: { name: 'inventory' },
      remoteInfo: remoteInfo(),
      remoteSnapshot,
      origin: { moduleCache: new Map() },
    };
    await plugin.afterResolve(resolved);
    const cached = {
      remoteInfo: resolved.remoteInfo,
      remoteEntryExports,
      cached: true,
    };
    await expect(plugin.afterLoadEntry(cached)).resolves.toBe(cached);
  });

  test.each(['name', 'entry', 'type', 'entryGlobalName'])(
    'rejects noncached entry exports with an unattested %s',
    async field => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      const remoteSnapshot = snapshot();
      await plugin.loadRemoteSnapshot({
        from: 'manifest',
        manifestJson: manifest(),
        remoteSnapshot,
      });
      await plugin.afterLoadSnapshot({ remoteSnapshot });
      const unmatched = remoteInfo();
      unmatched[field] = 'unattested-entry-coordinate';

      await expect(
        plugin.afterLoadEntry({
          remoteInfo: unmatched,
          remoteEntryExports: { get: () => Promise.resolve(() => ({})) },
          cached: false,
        }),
      ).rejects.toThrow('coordinates differ from the attested native snapshot');
    },
  );

  test('observes recovered native exports and permits their subsequent cached reuse', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const args = await nativeResolution(plugin);
    const remoteEntryExports = { get: () => Promise.resolve(() => ({})) };
    const recovered = {
      remoteInfo: args.remoteInfo,
      remoteEntryExports,
      error: new Error('initial native entry request failed'),
      recovered: true,
    };
    await expect(plugin.afterLoadEntry(recovered)).resolves.toBe(recovered);
    const cached = {
      remoteInfo: args.remoteInfo,
      remoteEntryExports,
      cached: true,
    };

    await expect(plugin.afterLoadEntry(cached)).resolves.toBe(cached);
  });

  test('preserves an unrecovered native error without attesting its exports', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const args = await nativeResolution(plugin);
    const remoteEntryExports = { get: () => Promise.resolve(() => ({})) };
    const failed = {
      remoteInfo: args.remoteInfo,
      remoteEntryExports,
      error: new Error('native entry request failed'),
    };
    await expect(plugin.afterLoadEntry(failed)).resolves.toBe(failed);
    await expect(
      plugin.afterLoadEntry({
        remoteInfo: args.remoteInfo,
        remoteEntryExports,
        cached: true,
      }),
    ).rejects.toThrow('unattested ownership');
  });

  test('rejects raw Module exports before its container get executes', async () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    let containerGets = 0;
    const remoteEntryExports = {
      get() {
        containerGets += 1;
        return Promise.resolve(() => ({}));
      },
    };
    const load = async () => {
      await plugin.afterLoadEntry({
        remoteInfo: remoteInfo(),
        remoteEntryExports,
        cached: true,
      });
      await remoteEntryExports.get();
    };

    await expect(load()).rejects.toThrow(
      'no attested native container resolution',
    );
    expect(containerGets).toBe(0);
  });

  test.each([
    ['injected exports', false],
    ['replacement exports', true],
  ])(
    'rejects %s despite approved container coordinates',
    async (_name, previouslyLoaded) => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      const args = await nativeResolution(plugin);
      if (previouslyLoaded) {
        await plugin.afterLoadEntry({
          remoteInfo: args.remoteInfo,
          remoteEntryExports: { get: () => Promise.resolve(() => ({})) },
        });
      }
      let containerGets = 0;
      const injected = {
        get() {
          containerGets += 1;
          return Promise.resolve(() => ({}));
        },
      };
      const load = async () => {
        await plugin.afterLoadEntry({
          remoteInfo: args.remoteInfo,
          remoteEntryExports: injected,
          cached: true,
        });
        await injected.get();
      };

      await expect(load()).rejects.toThrow('unattested ownership');
      expect(containerGets).toBe(0);
    },
  );
});

describe('renderer federation selected runtime ownership', () => {
  test.each([
    ['react', '19.3.0'],
    ['react-dom', '19.3.0'],
    ['react-dom/client', '19.3.0'],
    ['@modern-js/runtime', '3.9.0'],
  ])(
    'rejects the selected %s version before its factory is evaluated',
    (pkgName, version) => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      let factoryEvaluations = 0;
      const shared = {
        version: '99.0.0',
        get() {
          factoryEvaluations += 1;
          return Promise.resolve(() => ({}));
        },
      };
      const args = plugin.resolveShare({
        pkgName,
        shareScopeMap: {},
        resolver: () => ({ shared }),
      });

      expect(() => {
        args.resolver();
        shared.get();
      }).toThrow(`shared ${pkgName} version must be ${version}`);
      expect(factoryEvaluations).toBe(0);
    },
  );

  test('allows unloaded candidates and retains the native resolver result', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const shared = {
      version: '19.3.0',
      get: () => Promise.resolve(() => ({})),
    };
    const alternative = {
      version: '19.2.0',
      get: () => Promise.resolve(() => ({})),
      loaded: false,
    };
    const result = { shared };
    let resolutions = 0;
    const args = plugin.resolveShare({
      pkgName: 'react',
      shareScopeMap: { default: { react: { '19.2.0': alternative } } },
      resolver() {
        resolutions += 1;
        return result;
      },
    });

    expect(resolutions).toBe(0);
    expect(args.resolver()).toBe(result);
    expect(resolutions).toBe(1);
  });

  test.each(['loaded', 'lib'] as const)(
    'rejects another active runtime registered through %s',
    activeField => {
      const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
      const shared = {
        version: '19.3.0',
        get: () => Promise.resolve(() => ({})),
      };
      const conflicting = {
        version: '19.3.0',
        get: () => Promise.resolve(() => ({})),
        [activeField]: activeField === 'loaded' ? true : () => ({}),
      };
      const args = plugin.resolveShare({
        pkgName: 'react',
        shareScopeMap: {
          default: { react: { '19.3.0': shared } },
          remote: { react: { '19.3.0': conflicting } },
        },
        resolver: () => ({ shared }),
      });

      expect(() => args.resolver()).toThrow(
        'duplicate loaded runtime identities',
      );
    },
  );

  test('accepts registrations that expose the same loaded factory', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const lib = () => ({});
    const shared = { version: '19.3.0', lib, loaded: true };
    const args = plugin.resolveShare({
      pkgName: 'react',
      shareScopeMap: {
        default: { react: { '19.3.0': shared } },
        remote: { react: { '19.3.0': { ...shared } } },
      },
      resolver: () => ({ shared }),
    });

    expect(args.resolver()).toEqual({ shared });
  });

  test('rejects switching the selected runtime factory between resolutions', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const first = {
      version: '19.3.0',
      get: () => Promise.resolve(() => ({})),
    };
    const next = {
      version: '19.3.0',
      get: () => Promise.resolve(() => ({})),
    };
    const resolve = (shared: typeof first) =>
      plugin
        .resolveShare({
          pkgName: 'react',
          shareScopeMap: {},
          resolver: () => ({ shared }),
        })
        .resolver();

    expect(resolve(first)).toEqual({ shared: first });
    expect(() => resolve(next)).toThrow('conflicting runtime ownership');
  });

  test('rejects different loaded factories even when they share a getter', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const get = () => Promise.resolve(() => ({}));
    const shared = { version: '19.3.0', get, lib: () => ({ owner: 'host' }) };
    const conflicting = {
      version: '19.3.0',
      get,
      lib: () => ({ owner: 'remote' }),
      loaded: true,
    };
    const args = plugin.resolveShare({
      pkgName: 'react',
      shareScopeMap: { remote: { react: { '19.3.0': conflicting } } },
      resolver: () => ({ shared }),
    });

    expect(() => args.resolver()).toThrow(
      'duplicate loaded runtime identities',
    );
  });

  test('rejects an in-place mutation of the selected loaded factory', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const shared = {
      version: '19.3.0',
      get: () => Promise.resolve(() => ({})),
      lib: () => ({ owner: 'host' }),
    };
    const args = plugin.resolveShare({
      pkgName: 'react',
      shareScopeMap: {},
      resolver: () => ({ shared }),
    });
    expect(args.resolver()).toEqual({ shared });
    shared.lib = () => ({ owner: 'remote' });

    expect(() => args.resolver()).toThrow('conflicting runtime ownership');
  });

  test('pins the loaded factory when native loading completes an unloaded share', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const shared: ShareResult['shared'] = {
      version: '19.3.0',
      get: () => Promise.resolve(() => ({})),
    };
    const args = plugin.resolveShare({
      pkgName: 'react',
      shareScopeMap: {},
      resolver: () => ({ shared }),
    });
    expect(args.resolver()).toEqual({ shared });

    shared.lib = () => ({ owner: 'host' });
    shared.loaded = true;
    expect(() =>
      plugin.afterLoadShare({ pkgName: 'react', selectedShared: shared }),
    ).not.toThrow();
    shared.lib = () => ({ owner: 'remote' });

    expect(() => args.resolver()).toThrow('conflicting runtime ownership');
  });

  test('applies runtime ownership checks to the selected tree-shaken factory', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const selected = { get: () => Promise.resolve(() => ({})) };
    const other = { get: () => Promise.resolve(() => ({})), loaded: true };
    const shared = { version: '19.3.0', treeShaking: selected };
    const args = plugin.resolveShare({
      pkgName: 'react',
      shareScopeMap: {
        default: {
          react: { '19.3.0': { version: '19.3.0', treeShaking: other } },
        },
      },
      resolver: () => ({ shared, useTreesShaking: true }),
    });

    expect(() => args.resolver()).toThrow(
      'duplicate loaded runtime identities',
    );
  });

  test('preserves an unresolved native share result', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const args = plugin.resolveShare({
      pkgName: 'react',
      shareScopeMap: {},
      resolver: () => undefined,
    });
    expect(args.resolver()).toBeUndefined();
  });

  test('leaves packages outside the renderer runtime tuple to native resolution', () => {
    const plugin = createRendererFederationRuntimePlugin(consumingRenderer);
    const result: ShareResult = { shared: { version: '1.0.0' } };
    const original: ShareArgs = {
      pkgName: '@acme/catalog-data',
      shareScopeMap: {},
      resolver: () => result,
    };
    expect(plugin.resolveShare(original)).toBe(original);
    expect(original.resolver()).toBe(result);
  });
});

describe('native renderer share tuple', () => {
  const solid: RendererFederationCompatibility = {
    profile: {
      renderer: 'solid',
      protocolVersion: 1,
      compiler: { name: '@solidjs/compiler', version: '2.0.0-rc.15' },
      hydration: { name: '@solidjs/web', version: '2.0.0-rc.15' },
      router: {
        name: '@modern-js/renderer-solid',
        version: '3.8.3',
        coreName: '@tanstack/router-core',
        coreVersion: '1.171.37',
      },
    },
    runtime: { name: 'solid-js', version: '2.0.0-rc.15' },
    bootstrap: { name: '@modern-js/renderer-solid', version: '3.8.3' },
  };

  test('derives exact versions from the native tuple instead of React packages', () => {
    expect(Object.fromEntries(rendererShareVersions(solid))).toEqual({
      'solid-js': '2.0.0-rc.15',
      '@solidjs/web': '2.0.0-rc.15',
      '@modern-js/renderer-solid': '3.8.3',
      '@tanstack/router-core': '1.171.37',
    });
    expect(
      rendererShareVersions(consumingRenderer).has('react-dom/client'),
    ).toBe(true);
  });

  test('rejects a tuple naming one package with two versions', () => {
    expect(() =>
      rendererShareVersions({
        ...solid,
        profile: {
          ...solid.profile,
          router: { ...solid.profile.router, version: '3.8.4' },
        },
      }),
    ).toThrow('conflicting versions');
  });

  test('gates a shared native runtime by the tuple version', () => {
    const plugin = createRendererFederationRuntimePlugin(solid);
    const args = plugin.resolveShare({
      pkgName: 'solid-js',
      shareScopeMap: {},
      resolver: () => ({ shared: { version: '2.0.0-rc.12' } }),
    });
    expect(() => args.resolver()).toThrow(
      'shared solid-js version must be 2.0.0-rc.15',
    );
    const react = plugin.resolveShare({
      pkgName: 'react',
      shareScopeMap: {},
      resolver: () => ({ shared: { version: '1.0.0' } }),
    });
    expect(react.resolver()).toEqual({ shared: { version: '1.0.0' } });
  });

  test.each([
    'octane/server',
    'octane/internal/server',
    'octane/signals/server',
  ])(
    'gates the version and completed factory identity of native %s',
    pkgName => {
      const octane: RendererFederationCompatibility = {
        ...solid,
        profile: {
          ...solid.profile,
          renderer: 'octane',
          hydration: { name: 'octane', version: '0.13.8' },
        },
        runtime: { name: 'octane', version: '0.13.8' },
      };
      const plugin = createRendererFederationRuntimePlugin(octane);
      const resolve = (shared: ShareResult['shared']) =>
        plugin
          .resolveShare({
            pkgName,
            shareScopeMap: {},
            resolver: () => ({ shared }),
          })
          .resolver();
      expect(() => resolve({ version: '0.13.9' })).toThrow(
        `shared ${pkgName} version must be 0.13.8`,
      );
      const get = () => Promise.resolve(() => ({}));
      const loaded = () => ({});
      resolve({ version: '0.13.8', get });
      plugin.afterLoadShare({
        pkgName,
        selectedShared: { version: '0.13.8', get, lib: loaded },
      });
      // Native loading completes lib after resolution. Even an unchanged get
      // must not conceal a different evaluated runtime factory on refresh.
      expect(() =>
        resolve({ version: '0.13.8', get, lib: () => ({}) }),
      ).toThrow('conflicting runtime ownership');
      expect(resolve({ version: '0.13.8', get, lib: loaded })?.shared.lib).toBe(
        loaded,
      );
    },
  );
});
