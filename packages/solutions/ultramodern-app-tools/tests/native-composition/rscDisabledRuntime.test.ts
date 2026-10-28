import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AppTools, AppUserConfig } from '@modern-js/app-tools';
import { createConfigOptions } from '@modern-js/plugin/cli';
import type { RsbuildPlugin } from '@rsbuild/core';
import { expect, it } from '@rstest/core';
import { type BuilderConfig, createBuilder } from '../../../../cli/builder/src';
import { ultramodernAppTools } from '../../src/native-composition';
import { rscDisabledRuntimePlugin } from '../../src/renderers/react/rsc-disabled-plugin';

type ComposerConfig = Omit<AppUserConfig, 'server'> &
  Pick<BuilderConfig, 'server'>;

async function resolveComposerConfig(
  appDirectory: string,
  config: ComposerConfig,
) {
  const result = await createConfigOptions<AppTools>({
    command: 'build',
    configFile: false,
    cwd: appDirectory,
    // Applications author the UltraModern base composition in config.plugins.
    config: { ...config, plugins: [ultramodernAppTools()] } as AppUserConfig,
  });
  return result.config as ComposerConfig;
}

it.each([
  { rsc: undefined, guarded: true },
  { rsc: false, guarded: true },
  { rsc: true, guarded: false },
  { rsc: { environments: { server: 'server' } }, guarded: false },
])(
  'installs the guard after consumer plugins for rsc=$rsc only when disabled',
  async ({ rsc, guarded }) => {
    const consumer: RsbuildPlugin = { name: 'consumer', setup() {} };
    const input: ComposerConfig = {
      server: { rsc },
      builderPlugins: [consumer],
      html: { title: 'preserved' },
    };
    const result = await resolveComposerConfig(__dirname, input);
    expect(
      result.builderPlugins
        ?.map(plugin => (plugin && 'name' in plugin ? plugin.name : undefined))
        .slice(guarded ? -3 : -2),
    ).toEqual([
      // Makes the composed runtime packages resolvable from the app itself.
      'ultramodern:runtime-package-resolution',
      ...(guarded
        ? ['ultramodern:react:redact', 'builder:rsc-disabled-runtime']
        : ['ultramodern:react:runtime-cache']),
    ]);
    expect(result.builderPlugins).toContain(consumer);
    expect(result.html).toMatchObject(input.html!);
    expect(input.builderPlugins).toEqual([consumer]);
  },
);

const require = createRequire(import.meta.url);
const runtimeSubpaths = [
  'client.browser',
  'client.edge',
  'client.node',
  'server.edge',
  'server.node',
] as const;
const runtimeExports = {
  'client.browser': [
    'createFromFetch',
    'createFromReadableStream',
    'createServerReference',
    'createTemporaryReferenceSet',
    'encodeReply',
    'registerServerReference',
    'setFindSourceMapURLCallback',
    'setServerCallback',
  ],
  'client.edge': [
    'createFromFetch',
    'createFromReadableStream',
    'createServerReference',
    'createTemporaryReferenceSet',
    'encodeReply',
    'registerServerReference',
  ],
  'client.node': [
    'createFromFetch',
    'createFromNodeStream',
    'createFromReadableStream',
    'createServerReference',
    'createTemporaryReferenceSet',
    'encodeReply',
    'registerServerReference',
  ],
  'server.edge': [
    'createServerEntry',
    'createTemporaryReferenceSet',
    'decodeAction',
    'decodeFormState',
    'decodeReply',
    'decodeReplyFromAsyncIterable',
    'decryptServerActionBoundArgs',
    'encryptServerActionBoundArgs',
    'ensureServerActions',
    'loadServerAction',
    'registerClientReference',
    'registerServerReference',
    'renderToReadableStream',
    'setServerActionBoundArgsEncryption',
  ],
  'server.node': [
    'createServerEntry',
    'createTemporaryReferenceSet',
    'decodeAction',
    'decodeFormState',
    'decodeReply',
    'decodeReplyFromAsyncIterable',
    'decodeReplyFromBusboy',
    'decryptServerActionBoundArgs',
    'encryptServerActionBoundArgs',
    'ensureServerActions',
    'loadServerAction',
    'registerClientReference',
    'registerServerReference',
    'renderToPipeableStream',
    'renderToReadableStream',
    'setServerActionBoundArgsEncryption',
  ],
} as const;
const allRuntimeExports = [...new Set(Object.values(runtimeExports).flat())];

it.each([
  {
    optionalRuntime: 'absent',
    installPoisonRuntime: false,
  },
  {
    optionalRuntime: 'resolvable',
    installPoisonRuntime: true,
  },
])(
  'links every disabled RSC runtime contract when the optional runtime is $optionalRuntime',
  async ({ installPoisonRuntime }) => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modern-rsc-disabled-build-'),
    );
    const sourcePath = path.join(workspaceRoot, 'index.js');
    const neighborPath = path.join(workspaceRoot, 'neighbor.js');
    const outputPath = path.join(workspaceRoot, 'dist');

    const poisonPackageRoot = path.join(
      workspaceRoot,
      'node_modules/react-server-dom-rspack',
    );

    try {
      fs.writeFileSync(
        path.join(workspaceRoot, 'package.json'),
        JSON.stringify({ name: 'rsc-disabled-runtime-fixture', private: true }),
      );
      if (installPoisonRuntime) {
        const packageRoot = poisonPackageRoot;
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(
          path.join(packageRoot, 'package.json'),
          JSON.stringify({
            name: 'react-server-dom-rspack',
            exports: Object.fromEntries(
              runtimeSubpaths.map(subpath => [
                `./${subpath}`,
                `./${subpath}.js`,
              ]),
            ),
          }),
          'utf-8',
        );
        for (const subpath of runtimeSubpaths) {
          fs.writeFileSync(
            path.join(packageRoot, `${subpath}.js`),
            `
            const poison = () => {
              throw new Error(
                'Resolved the optional RSC runtime while RSC was disabled.',
              );
            };
            for (const name of ${JSON.stringify(allRuntimeExports)}) {
              exports[name] = poison;
            }
          `,
            'utf-8',
          );
        }
      }
      fs.writeFileSync(
        neighborPath,
        "export const neighborMarker = 'preserved';\n",
        'utf-8',
      );
      fs.writeFileSync(
        sourcePath,
        `
        import { neighborMarker } from '@fixture/rsc-neighbor';
        import * as clientBrowser from 'react-server-dom-rspack/client.browser';
        import * as clientEdge from 'react-server-dom-rspack/client.edge';
        import * as clientNode from 'react-server-dom-rspack/client.node';
        import * as serverEdge from 'react-server-dom-rspack/server.edge';
        import * as serverNode from 'react-server-dom-rspack/server.node';

        const contracts = [
          [clientBrowser, ${JSON.stringify(runtimeExports['client.browser'])}],
          [clientEdge, ${JSON.stringify(runtimeExports['client.edge'])}],
          [clientNode, ${JSON.stringify(runtimeExports['client.node'])}],
          [serverEdge, ${JSON.stringify(runtimeExports['server.edge'])}],
          [serverNode, ${JSON.stringify(runtimeExports['server.node'])}],
        ];

        export function invokeDisabledRscRuntime() {
          if (neighborMarker !== 'preserved') {
            throw new Error('An unrelated resolver alias was not preserved.');
          }
          for (const [runtime, exportNames] of contracts) {
            const actualExportNames = Object.keys(runtime).sort();
            const expectedExportNames = [...exportNames].sort();
            if (
              JSON.stringify(actualExportNames) !==
              JSON.stringify(expectedExportNames)
            ) {
              throw new Error(
                'Disabled RSC export surface mismatch: ' +
                  JSON.stringify({ actualExportNames, expectedExportNames }),
              );
            }
            for (const exportName of exportNames) {
              const invoke = runtime[exportName];
              if (typeof invoke !== 'function') {
                throw new Error('Missing disabled RSC export: ' + exportName);
              }
              try {
                invoke();
              } catch (error) {
                if (
                  error instanceof Error &&
                  error.message ===
                    'React Server Components are disabled for this build.'
                ) {
                  continue;
                }
                throw error;
              }
              throw new Error('A disabled RSC export did not fail closed.');
            }
          }
          return true;
        }
      `,
        'utf-8',
      );

      const poisonAliasPlugin = {
        name: 'test:poison-rsc-alias',
        setup(
          api: Parameters<
            ReturnType<typeof rscDisabledRuntimePlugin>['setup']
          >[0],
        ) {
          api.modifyRspackConfig(config => {
            config.resolve ??= {};
            config.resolve.alias = {
              '@fixture/rsc-neighbor$': neighborPath,
              ...(installPoisonRuntime
                ? { 'react-server-dom-rspack': poisonPackageRoot }
                : {}),
            };
          });
        },
      };

      const composed = await resolveComposerConfig(workspaceRoot, {
        server: { rsc: false },
        builderPlugins: [poisonAliasPlugin],
      });
      const rsbuild = await createBuilder({
        bundlerType: 'rspack',
        cwd: workspaceRoot,
        config: {
          source: {
            entry: { index: sourcePath },
          },
          output: {
            distPath: {
              root: outputPath,
              js: '',
            },
            filename: {
              js: '[name].js',
            },
            target: 'node',
            disableTsChecker: true,
          },
          performance: {
            chunkSplit: {
              strategy: 'all-in-one',
            },
          },
          tools: {
            htmlPlugin: false,
          },
        },
      });

      rsbuild.addPlugins(
        (await Promise.all(composed.builderPlugins ?? [])).flat(
          Number.POSITIVE_INFINITY as 1,
        ) as RsbuildPlugin[],
      );
      await expect(rsbuild.build()).resolves.toBeDefined();
      const bundle = require(path.join(outputPath, 'index.js')) as {
        invokeDisabledRscRuntime: () => boolean;
      };
      expect(bundle.invokeDisabledRscRuntime()).toBe(true);
    } finally {
      fs.rmSync(workspaceRoot, { force: true, recursive: true });
    }
  },
);
