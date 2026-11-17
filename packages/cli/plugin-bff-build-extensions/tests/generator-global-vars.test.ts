import type { BffCompilation } from '@modern-js/app-tools';
import * as actualEffectLoader from '@modern-js/plugin-bff-extensions/effect-source-loader' with {
  rstest: 'importActual',
};
import { fs } from '@modern-js/utils';
import os from 'os';
import path from 'path';
import * as actualServerUtils from '../../../server/utils/src/index' with {
  rstest: 'importActual',
};
import serverBuildPlugin from '../../../solutions/app-tools/src/plugins/serverBuild';
import { bffPlugin } from '../../plugin-bff/src/cli';
import { createBffGenerator } from '../../plugin-bff/src/cli/generator';
import { bffPlugin as extendedBffPlugin } from '../src';
import { registerBffCompilation } from '../src/compile';

type Compile = typeof actualServerUtils.compile;
type BundleEffectEntry =
  typeof actualEffectLoader.bundleBuiltEffectEntryForNode;
const compileCalls: Parameters<Compile>[] = [];
let compileImplementation: Compile = actualServerUtils.compile;
let bundleImplementation: BundleEffectEntry =
  actualEffectLoader.bundleBuiltEffectEntryForNode;

rstest.mock('../../../server/utils/src/index', () => ({
  ...actualServerUtils,
  compile: (...args: Parameters<Compile>) => {
    compileCalls.push(args);
    return compileImplementation(...args);
  },
}));
rstest.mock('@modern-js/plugin-bff-extensions/effect-source-loader', () => ({
  ...actualEffectLoader,
  bundleBuiltEffectEntryForNode: (...args: Parameters<BundleEffectEntry>) =>
    bundleImplementation(...args),
}));

beforeEach(() => {
  compileCalls.length = 0;
  compileImplementation = actualServerUtils.compile;
  bundleImplementation = actualEffectLoader.bundleBuiltEffectEntryForNode;
});

import type {
  BffRuntimeBuildIdentity,
  BffRuntimeBuildIdentityProvider,
} from '../src/runtime-build-identity';

async function createRuntimeIdentityFixture(
  appDirectory: string,
  globalVars: Record<string, unknown>,
  resolveBffRuntimeBuildIdentity?: BffRuntimeBuildIdentityProvider,
) {
  const apiDirectory = path.join(appDirectory, 'api');
  const distDirectory = path.join(appDirectory, 'dist');
  const sharedDirectory = path.join(appDirectory, 'shared');
  const tsconfigPath = path.join(appDirectory, 'tsconfig.json');
  await fs.outputJSON(tsconfigPath, {
    compilerOptions: {
      declaration: false,
      module: 'CommonJS',
      moduleResolution: 'Node',
      noEmitOnError: true,
      target: 'ES2020',
    },
    include: ['api', 'shared'],
  });
  await fs.outputFile(
    path.join(apiDirectory, 'index.ts'),
    [
      'declare const ULTRAMODERN_BUILD_MARKER: string;',
      'declare const ULTRAMODERN_RELEASE_VERSION: string;',
      'declare const ULTRAMODERN_SOURCE_REVISION: string;',
      'declare const OTHER_GLOBAL: { value: string };',
      'export default () => ({',
      '  buildMarker: ULTRAMODERN_BUILD_MARKER,',
      '  markerBranch:',
      "    typeof ULTRAMODERN_BUILD_MARKER === 'string' && ULTRAMODERN_BUILD_MARKER.length === 64",
      "      ? 'finalized' : 'legacy',",
      '  markerType: typeof ULTRAMODERN_BUILD_MARKER,',
      '  other: OTHER_GLOBAL,',
      '  releaseVersion: ULTRAMODERN_RELEASE_VERSION,',
      '  sourceRevision: ULTRAMODERN_SOURCE_REVISION,',
      '});',
      '',
    ].join('\n'),
  );
  const appContext = {
    apiDirectory,
    apiOnly: false,
    appDirectory,
    distDirectory,
    isProd: true,
    moduleType: 'commonjs',
    resolveBffRuntimeBuildIdentity,
    sharedDirectory,
  };
  const config = {
    tools: {},
    resolve: {},
    server: { tsconfigPath },
    source: { globalVars },
  };
  const hooks = bffPlugin().registryHooks!;
  const api = {
    getAppContext: () => ({ ...appContext }),
    getHooks: () => hooks,
    getNormalizedConfig: () => config,
    onAfterBffCompile: hooks.onAfterBffCompile.tap,
    onBeforeBffCompile: hooks.onBeforeBffCompile.tap,
  };
  registerBffCompilation(api as never);
  const { compileApi } = createBffGenerator(api as never);
  const compiledEntry = path.join(distDirectory, 'api/index.js');
  return { appContext, compileApi, compiledEntry, config, hooks };
}

const normalizedRuntimeGlobals = Object.freeze({
  OTHER_GLOBAL: Object.freeze({ value: 'original-global' }),
  ULTRAMODERN_BUILD_MARKER: '0123456789abcdef',
  ULTRAMODERN_RELEASE_VERSION: '1.2.3-release.4',
  ULTRAMODERN_SOURCE_REVISION: 'normalized-revision',
});

function executeRuntimeIdentityFixture(compiledEntry: string) {
  const runtime = require(compiledEntry) as {
    default: () => {
      buildMarker: string;
      markerBranch: 'finalized' | 'legacy';
      markerType: string;
      other: { value: string };
      releaseVersion: string;
      sourceRevision: string;
    };
  };
  return runtime.default();
}

describe('BFF compiler global variables', () => {
  it('uses the finalized identity from the fresh app context in the emitted API', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), 'plugin-bff-finalized-identity-'),
      ),
    );
    try {
      const fixture = await createRuntimeIdentityFixture(
        appDirectory,
        normalizedRuntimeGlobals,
      );
      const identity = Object.freeze({
        buildMarker: 'a'.repeat(64),
        sourceRevision: 'finalized/source@1234',
      });
      let beforeCompilation: BffCompilation | undefined;
      let providerCompilation: BffCompilation | undefined;
      fixture.hooks.onBeforeBffCompile.tap(compilation => {
        beforeCompilation = compilation;
        fixture.appContext.resolveBffRuntimeBuildIdentity = async actual => {
          providerCompilation = actual;
          await Promise.resolve();
          return identity;
        };
      });

      await fixture.compileApi('build');

      expect(providerCompilation).toBe(beforeCompilation);
      expect(providerCompilation?.appDirectory).toBe(appDirectory);
      expect(executeRuntimeIdentityFixture(fixture.compiledEntry)).toEqual({
        ...identity,
        markerBranch: 'finalized',
        markerType: 'string',
        other: normalizedRuntimeGlobals.OTHER_GLOBAL,
        releaseVersion: normalizedRuntimeGlobals.ULTRAMODERN_RELEASE_VERSION,
      });
      expect(fixture.config.source.globalVars).toBe(normalizedRuntimeGlobals);
      expect(fixture.config.source.globalVars).toEqual({
        OTHER_GLOBAL: { value: 'original-global' },
        ULTRAMODERN_BUILD_MARKER: '0123456789abcdef',
        ULTRAMODERN_RELEASE_VERSION: '1.2.3-release.4',
        ULTRAMODERN_SOURCE_REVISION: 'normalized-revision',
      });
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it('keeps runtime identity providers isolated between two applications', async () => {
    const workspaceDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-bff-isolated-identity-')),
    );
    try {
      const applications = ['catalog', 'checkout'];
      const seenCompilations: BffCompilation[] = [];
      const fixtures = await Promise.all(
        applications.map((appId, index) =>
          createRuntimeIdentityFixture(
            path.join(workspaceDirectory, appId),
            normalizedRuntimeGlobals,
            async compilation => {
              seenCompilations.push(compilation);
              return Object.freeze({
                buildMarker: (index === 0 ? 'a' : 'b').repeat(64),
                sourceRevision: `${appId}-revision`,
              });
            },
          ),
        ),
      );
      for (const fixture of fixtures) await fixture.compileApi('build');
      fixtures.forEach((fixture, index) => {
        expect(executeRuntimeIdentityFixture(fixture.compiledEntry)).toEqual({
          buildMarker: (index === 0 ? 'a' : 'b').repeat(64),
          markerBranch: 'finalized',
          markerType: 'string',
          other: normalizedRuntimeGlobals.OTHER_GLOBAL,
          releaseVersion: normalizedRuntimeGlobals.ULTRAMODERN_RELEASE_VERSION,
          sourceRevision: `${applications[index]}-revision`,
        });
        expect(seenCompilations[index]?.appDirectory).toBe(
          fixture.appContext.appDirectory,
        );
        expect(fixture.config.source.globalVars).toBe(normalizedRuntimeGlobals);
      });
      expect(seenCompilations[0]).not.toBe(seenCompilations[1]);
    } finally {
      await fs.remove(workspaceDirectory);
    }
  });

  it('preserves API-only identity when a provider was registered before classification', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-bff-api-only-identity-')),
    );
    try {
      let providerCalls = 0;
      const fixture = await createRuntimeIdentityFixture(
        appDirectory,
        normalizedRuntimeGlobals,
        async () => {
          providerCalls++;
          throw new Error(
            'UI identity must not be requested for API-only apps.',
          );
        },
      );
      fixture.hooks.onBeforeBffCompile.tap(() => {
        fixture.appContext.apiOnly = true;
      });

      await fixture.compileApi('build');

      expect(providerCalls).toBe(0);
      expect(executeRuntimeIdentityFixture(fixture.compiledEntry)).toEqual({
        buildMarker: normalizedRuntimeGlobals.ULTRAMODERN_BUILD_MARKER,
        markerBranch: 'legacy',
        markerType: 'string',
        other: normalizedRuntimeGlobals.OTHER_GLOBAL,
        releaseVersion: normalizedRuntimeGlobals.ULTRAMODERN_RELEASE_VERSION,
        sourceRevision: normalizedRuntimeGlobals.ULTRAMODERN_SOURCE_REVISION,
      });
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it.each<{
    identity: BffRuntimeBuildIdentity;
    message: string;
    name: string;
  }>([
    {
      identity: Object.freeze({
        buildMarker: '0123456789abcdef',
        sourceRevision: 'finalized-revision',
      }),
      message: 'BFF runtime build identity is not finalized.',
      name: 'short marker',
    },
    {
      identity: Object.freeze({
        buildMarker: 'a'.repeat(64),
        sourceRevision: '',
      }),
      message: 'BFF runtime build identity is not finalized.',
      name: 'empty revision',
    },
    {
      identity: {
        buildMarker: 'a'.repeat(64),
        sourceRevision: 'mutable-revision',
      },
      message: 'BFF runtime build identity must be immutable.',
      name: 'mutable identity',
    },
  ])(
    'rejects $name before replacing globals',
    async ({ identity, message }) => {
      const appDirectory = await fs.realpath(
        await fs.mkdtemp(
          path.join(os.tmpdir(), 'plugin-bff-invalid-identity-'),
        ),
      );
      try {
        const fixture = await createRuntimeIdentityFixture(
          appDirectory,
          normalizedRuntimeGlobals,
          async () => identity,
        );

        await expect(fixture.compileApi('build')).rejects.toThrow(message);

        const compiledSource = await fs.readFile(fixture.compiledEntry, 'utf8');
        expect(compiledSource).toContain('ULTRAMODERN_BUILD_MARKER');
        expect(compiledSource).toContain('ULTRAMODERN_SOURCE_REVISION');
        expect(fixture.config.source.globalVars).toBe(normalizedRuntimeGlobals);
      } finally {
        await fs.remove(appDirectory);
      }
    },
  );

  it('propagates an unready registered provider before replacing globals', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-bff-unready-identity-')),
    );
    try {
      const fixture = await createRuntimeIdentityFixture(
        appDirectory,
        normalizedRuntimeGlobals,
        async () => {
          throw new Error('Finalized UI build identity is not ready.');
        },
      );

      await expect(fixture.compileApi('build')).rejects.toThrow(
        'Finalized UI build identity is not ready.',
      );

      const compiledSource = await fs.readFile(fixture.compiledEntry, 'utf8');
      expect(compiledSource).toContain('ULTRAMODERN_BUILD_MARKER');
      expect(compiledSource).toContain('ULTRAMODERN_SOURCE_REVISION');
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it('rejects a provider from a different app context before replacing globals', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), 'plugin-bff-wrong-app-identity-'),
      ),
    );
    try {
      let providerCalls = 0;
      const fixture = await createRuntimeIdentityFixture(
        appDirectory,
        normalizedRuntimeGlobals,
        async () => {
          providerCalls++;
          return Object.freeze({
            buildMarker: 'a'.repeat(64),
            sourceRevision: 'finalized-revision',
          });
        },
      );
      fixture.hooks.onBeforeBffCompile.tap(() => {
        fixture.appContext.appDirectory = path.join(appDirectory, 'other-app');
      });

      await expect(fixture.compileApi('build')).rejects.toThrow(
        'BFF runtime build identity provider does not belong to this application.',
      );

      expect(providerCalls).toBe(0);
      expect(await fs.readFile(fixture.compiledEntry, 'utf8')).toContain(
        'ULTRAMODERN_BUILD_MARKER',
      );
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it('emits a Node-executable Effect entry when it imports raw TypeScript from a workspace package', async () => {
    const workspaceDirectory = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), 'plugin-bff-workspace-typescript-'),
      ),
    );
    const appDirectory = path.join(workspaceDirectory, 'verticals', 'catalog');
    const apiDirectory = path.join(appDirectory, 'api');
    const sharedDirectory = path.join(appDirectory, 'shared');
    const distDirectory = path.join(appDirectory, 'dist');
    const packageDirectory = path.join(
      workspaceDirectory,
      'packages',
      'raw-contract',
    );
    const packageLink = path.join(
      appDirectory,
      'node_modules',
      '@fixture',
      'raw-contract',
    );
    const esmDependencyDirectory = path.join(
      appDirectory,
      'node_modules',
      '@fixture',
      'esm-runtime',
    );
    const tsconfigPath = path.join(appDirectory, 'tsconfig.json');

    await fs.outputJSON(path.join(packageDirectory, 'package.json'), {
      name: '@fixture/raw-contract',
      version: '1.0.0',
      type: 'module',
      exports: {
        '.': './src/index.ts',
      },
    });
    await fs.outputFile(
      path.join(packageDirectory, 'src/index.ts'),
      "export const workspaceValue: string = 'raw-workspace-typescript';\n",
    );
    await fs.ensureDir(path.dirname(packageLink));
    await fs.symlink(
      packageDirectory,
      packageLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.outputJSON(path.join(esmDependencyDirectory, 'package.json'), {
      name: '@fixture/esm-runtime',
      version: '1.0.0',
      type: 'module',
      exports: {
        types: './index.d.ts',
        default: './index.js',
      },
    });
    await fs.outputFile(
      path.join(esmDependencyDirectory, 'index.d.ts'),
      'export declare const runtimeValue: string;\n',
    );
    await fs.outputFile(
      path.join(esmDependencyDirectory, 'index.js'),
      "export const runtimeValue = 'esm-runtime';\n",
    );
    await fs.outputJSON(tsconfigPath, {
      compilerOptions: {
        declaration: false,
        module: 'CommonJS',
        moduleResolution: 'Node',
        noEmitOnError: true,
        target: 'ES2020',
      },
      include: ['api', 'shared'],
    });
    await fs.outputFile(
      path.join(apiDirectory, 'index.ts'),
      [
        "import { workspaceValue } from '@fixture/raw-contract';",
        "import { runtimeValue } from '@fixture/esm-runtime';",
        "export default () => workspaceValue + ':' + runtimeValue;",
        '',
      ].join('\n'),
    );

    const api = {
      getAppContext: () => ({
        appDirectory,
        apiDirectory,
        bffRuntimeFramework: 'effect',
        distDirectory,
        isProd: true,
        moduleType: 'commonjs',
        sharedDirectory,
      }),
      getNormalizedConfig: () => ({
        tools: {},
        bff: {
          runtimeFramework: 'effect',
        },
        resolve: {},
        server: {
          tsconfigPath,
        },
        source: {},
      }),
    };

    try {
      const hooks = bffPlugin().registryHooks!;
      const compilationApi = {
        ...api,
        getHooks: () => hooks,
        onBeforeBffCompile: hooks.onBeforeBffCompile.tap,
        onAfterBffCompile: hooks.onAfterBffCompile.tap,
      };
      registerBffCompilation(compilationApi as never);
      const { compileApi } = createBffGenerator(compilationApi as never);
      await compileApi('build');

      const compiledEntry = path.join(distDirectory, 'api/index.js');
      await fs.remove(packageDirectory);
      const runtime = require(compiledEntry) as {
        default: () => string;
      };
      expect(runtime.default()).toBe('raw-workspace-typescript:esm-runtime');
    } finally {
      await fs.remove(workspaceDirectory);
    }
  });

  it('embeds exact release identity without replacing literal tokens', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-bff-global-vars-')),
    );
    const sharedDirectory = path.join(appDirectory, 'shared');
    const apiDirectory = path.join(appDirectory, 'api');
    const distDirectory = path.join(appDirectory, 'dist');
    const tsconfigPath = path.join(appDirectory, 'tsconfig.json');
    const buildMarker = 'catalog-build-2026.07.18+exact';
    const releaseVersion = '1.2.3-release.4';
    const sourceRevision = 'release/erp-10@4f2a9c7';

    await fs.outputJSON(tsconfigPath, {
      compilerOptions: {
        declaration: false,
        module: 'CommonJS',
        moduleResolution: 'Node',
        noEmitOnError: true,
        target: 'ES2020',
      },
      include: ['api', 'shared'],
    });
    await fs.outputFile(
      path.join(sharedDirectory, 'ultramodern-build.ts'),
      [
        'declare const ULTRAMODERN_BUILD_MARKER: string;',
        'declare const ULTRAMODERN_SOURCE_REVISION: string;',
        'declare const ULTRAMODERN_BUILD_MARKER_NEAR_MATCH: string;',
        '',
        '// ULTRAMODERN_BUILD_MARKER must remain a comment token.',
        "const markerTokenText = 'ULTRAMODERN_BUILD_MARKER';",
        'export const ultramodernApiMarker = {',
        '  buildMarker: ULTRAMODERN_BUILD_MARKER,',
        '  sourceRevision: ULTRAMODERN_SOURCE_REVISION,',
        '  markerTokenText,',
        '  nearMatchType:',
        "    typeof ULTRAMODERN_BUILD_MARKER_NEAR_MATCH === 'undefined'",
        "      ? 'undefined'",
        "      : 'defined',",
        '} as const;',
        '',
      ].join('\n'),
    );
    await fs.outputFile(
      path.join(apiDirectory, 'backend-federation.ts'),
      [
        'declare const ULTRAMODERN_BUILD_MARKER: string;',
        'declare const ULTRAMODERN_RELEASE_VERSION: string;',
        'declare const ULTRAMODERN_SOURCE_REVISION: string;',
        'export const backendFederationContract = {',
        '  buildMarker: ULTRAMODERN_BUILD_MARKER,',
        '  releaseVersion: ULTRAMODERN_RELEASE_VERSION,',
        '  sourceRevision: ULTRAMODERN_SOURCE_REVISION,',
        '};',
      ].join('\n'),
    );
    const api = {
      getAppContext: () => ({
        appDirectory,
        apiDirectory,
        distDirectory,
        isProd: true,
        moduleType: 'commonjs',
        sharedDirectory,
      }),
      getNormalizedConfig: () => ({
        tools: {},
        resolve: {},
        server: {
          tsconfigPath,
        },
        source: {
          globalVars: {
            ULTRAMODERN_BUILD_MARKER: buildMarker,
            ULTRAMODERN_RELEASE_VERSION: releaseVersion,
            ULTRAMODERN_SOURCE_REVISION: sourceRevision,
          },
        },
      }),
    };

    try {
      const hooks = bffPlugin().registryHooks!;
      const compilationApi = {
        ...api,
        getHooks: () => hooks,
        onBeforeBffCompile: hooks.onBeforeBffCompile.tap,
        onAfterBffCompile: hooks.onAfterBffCompile.tap,
      };
      registerBffCompilation(compilationApi as never);
      const { compileApi } = createBffGenerator(compilationApi as never);
      await compileApi('build');

      const compiledPath = path.join(
        distDirectory,
        'shared/ultramodern-build.js',
      );
      const runtime = require(compiledPath) as {
        ultramodernApiMarker: {
          buildMarker: string;
          markerTokenText: string;
          nearMatchType: string;
          sourceRevision: string;
        };
      };
      expect(runtime.ultramodernApiMarker).toEqual({
        buildMarker,
        sourceRevision,
        markerTokenText: 'ULTRAMODERN_BUILD_MARKER',
        nearMatchType: 'undefined',
      });

      const compiledBackendFederation = require(
        path.join(distDirectory, 'api/backend-federation.js'),
      ) as {
        backendFederationContract: {
          buildMarker: string;
          releaseVersion: string;
          sourceRevision: string;
        };
      };
      expect(compiledBackendFederation.backendFederationContract).toEqual({
        buildMarker,
        releaseVersion,
        sourceRevision,
      });
    } finally {
      await fs.remove(appDirectory);
    }
  });
});

const PROOF_SOURCE = 'module.exports = PROOF_GLOBAL;';

/**
 * Emits each root plus `src/aliased.ts`, which roots reach through an alias,
 * and reports exactly those files, like the server compiler.
 */
const aliasReachingCompile: Compile = async (
  appDirectory,
  _config,
  options,
) => {
  const rootFiles: string[] = [];
  for (const directory of options.sourceDirs)
    for (const name of await fs.readdir(directory))
      rootFiles.push(path.join(directory, name));
  const emittedFiles: string[] = [];
  for (const file of [
    ...rootFiles,
    path.join(appDirectory, 'src/aliased.ts'),
  ]) {
    const output = path.join(
      options.distDir,
      path.relative(appDirectory, file).replace(/\.ts$/u, '.js'),
    );
    await fs.outputFile(output, PROOF_SOURCE);
    emittedFiles.push(output);
  }
  return {
    rootFiles: emittedFiles.slice(0, rootFiles.length),
    emittedFiles,
  };
};

type LifecycleMode = {
  runtimeFramework?: 'hono' | 'effect';
  apiOnly?: boolean;
  api?: boolean;
};

async function createLifecycleApp(mode: LifecycleMode) {
  const appDirectory = await fs.realpath(
    await fs.mkdtemp(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'bff-one-writer-'),
    ),
  );
  if (mode.api !== false)
    await fs.outputFile(path.join(appDirectory, 'api/index.ts'), '');
  await fs.outputFile(path.join(appDirectory, 'shared/schema.ts'), '');
  await fs.outputFile(path.join(appDirectory, 'server/modern.server.ts'), '');
  await fs.outputFile(path.join(appDirectory, 'src/aliased.ts'), '');
  // Not emitted by this compilation, so finalization must not touch it.
  await fs.outputFile(
    path.join(appDirectory, 'dist/src/stale.js'),
    PROOF_SOURCE,
  );
  await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {});
  let context: Record<string, unknown> = {
    appDirectory,
    apiDirectory: path.join(appDirectory, 'api'),
    lambdaDirectory: path.join(appDirectory, 'api/lambda'),
    distDirectory: path.join(appDirectory, 'dist'),
    sharedDirectory: path.join(appDirectory, 'shared'),
    metaName: 'modern-js',
    moduleType: 'commonjs',
    apiOnly: mode.apiOnly ?? false,
  };
  const config = {
    source: { alias: {}, globalVars: { PROOF_GLOBAL: 'final' } },
    resolve: { alias: {} },
    server: {},
    output: {},
    tools: {},
    bff: { runtimeFramework: mode.runtimeFramework },
  };
  const hooks = bffPlugin().registryHooks!;
  const afterBuild: (() => Promise<void>)[] = [];
  const api = new Proxy(
    {},
    {
      get: (_target, name) => {
        switch (name) {
          case 'getAppContext':
            return () => context;
          case 'updateAppContext':
            return (update: Record<string, unknown>) => {
              context = { ...context, ...update };
            };
          case 'getConfig':
          case 'getNormalizedConfig':
            return () => config;
          case 'getHooks':
            return () => hooks;
          case 'onAfterBuild':
            return (callback: () => Promise<void>) => afterBuild.push(callback);
          case 'onBeforeBffCompile':
            return hooks.onBeforeBffCompile.tap;
          case 'onAfterBffCompile':
            return hooks.onAfterBffCompile.tap;
          default:
            return () => undefined;
        }
      },
    },
  );
  const read = (file: string) =>
    fs.readFile(path.join(appDirectory, 'dist', file), 'utf8');
  return { appDirectory, api, afterBuild, read };
}

describe('one writer finalizes every emitted server file', () => {
  beforeEach(() => {
    compileImplementation = aliasReachingCompile;
  });

  it.each([
    ['Effect', {}],
    ['Hono', { runtimeFramework: 'hono' }],
    ['API-only', { apiOnly: true }],
    ['BFF server-only', { api: false }],
  ] as [string, LifecycleMode][])(
    'finalizes server, shared and aliased src output for %s in every order',
    async (_name, mode) => {
      for (const serverBuildFirst of [true, false]) {
        for (const reverseCallbacks of [false, true]) {
          const app = await createLifecycleApp(mode);
          compileCalls.length = 0;
          const bundled: string[] = [];
          bundleImplementation = async () => {
            // The Effect entry bundle runs only after global finalization.
            bundled.push(await app.read('shared/schema.js'));
          };
          try {
            const plugins = [
              serverBuildPlugin(),
              bffPlugin(),
              extendedBffPlugin(),
            ];
            if (!serverBuildFirst) plugins.push(plugins.shift()!);
            for (const plugin of plugins) await plugin.setup!(app.api as never);
            const callbacks = [...app.afterBuild];
            if (reverseCallbacks) callbacks.reverse();
            for (const callback of callbacks) await callback();

            expect(compileCalls).toHaveLength(1);
            const outputs = [
              ...(mode.api === false ? [] : ['api/index.js']),
              'server/modern.server.js',
              'shared/schema.js',
              'src/aliased.js',
            ];
            for (const output of outputs)
              expect(await app.read(output)).toBe(
                'module.exports = "final";\n',
              );
            expect(await app.read('src/stale.js')).toBe(PROOF_SOURCE);
            expect(bundled).toEqual(
              mode.runtimeFramework === 'hono'
                ? []
                : ['module.exports = "final";\n'],
            );
          } finally {
            await fs.remove(app.appDirectory);
          }
        }
      }
    },
  );
});
