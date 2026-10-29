import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppTools, CliPlugin } from '@modern-js/app-tools';
import { logger } from '@modern-js/utils';
import type { RsbuildPlugin, Rspack } from '@rsbuild/core';
import { pluginRedact } from 'rsbuild-redact-plugin';
import {
  type ReactRuntimeConfig,
  usesRedact,
  validateRedactConfig,
} from '../../native-composition/redact-config';
import { readRendererFrameworkPackage } from '../../native-composition/renderer-installed-profile';

export {
  usesRedact,
  validateRedactConfig,
} from '../../native-composition/redact-config';

// Alias mapping adapted from rsbuild-redact-plugin 0.1.0 (MIT, zllkjc).
export const REDACT_ALIASES = {
  react: '@tanstack/redact',
  'react/jsx-runtime': '@tanstack/redact/jsx-runtime',
  'react/jsx-dev-runtime': '@tanstack/redact/jsx-dev-runtime',
  'react/compiler-runtime': '@tanstack/redact/compiler-runtime',
  'react-dom': '@tanstack/redact/dom',
  'react-dom/client': '@tanstack/redact/dom-client',
  'react-dom/test-utils': '@tanstack/redact/dom-test-utils',
  'react-dom/server': '@tanstack/redact/server',
  'react-dom/server.browser': '@tanstack/redact/server',
  'react-dom/server.node': '@tanstack/redact/server',
  'react-dom/server.edge': '@tanstack/redact/server',
  'react-dom/server.bun': '@tanstack/redact/server',
  scheduler: '@tanstack/redact/scheduler',
  'use-sync-external-store': '@tanstack/redact',
  'use-sync-external-store/index.js': '@tanstack/redact',
  'use-sync-external-store/shim': '@tanstack/redact',
  'use-sync-external-store/shim/index.js': '@tanstack/redact',
  'use-sync-external-store/with-selector': '@tanstack/redact',
  'use-sync-external-store/with-selector.js': '@tanstack/redact',
  'use-sync-external-store/shim/with-selector': '@tanstack/redact',
  'use-sync-external-store/shim/with-selector.js': '@tanstack/redact',
} as const;

const frameworkRequire = createRequire(import.meta.url);
const frameworkDirectory = () =>
  readRendererFrameworkPackage({
    specifier: '@modern-js/ultramodern-app-tools',
    filename: fileURLToPath(import.meta.url),
  }).directory;

export const REDACT_PATCH_MARKER = '// ultramodern-redact-patch: v1';

/** Mandatory for every enabled build, including CSR; never exposed as app config. */
export function assertRedactPatch(read = readFileSync): void {
  const stream = path.join(
    path.dirname(frameworkRequire.resolve('@tanstack/redact/server')),
    'stream.js',
  );
  if (read(stream, 'utf8').split(/\r?\n/, 1)[0] !== REDACT_PATCH_MARKER) {
    throw new Error(
      `[ultramodern] @tanstack/redact@0.2.1 requires the UltraModern reviewed SSR patch (${REDACT_PATCH_MARKER}) in ${stream}. Install the framework's npm:@bleedingdev/tanstack-redact@0.2.1 dependency; unpatched Redact must not ship. Set redact: false to use real React instead.`,
    );
  }
}

/** Hash the installed runtime, including transitive modules behind the aliases.
 * Version and marker stay unchanged when a reviewed patch is regenerated. Do
 * not memoize by installation path: a normal reinstall can replace its bytes.
 */
export function redactArtifactDigest(
  directory = path.resolve(
    path.dirname(frameworkRequire.resolve('@tanstack/redact')),
    '..',
  ),
): string {
  const hash = createHash('sha256');
  // Export-map changes can select another entry without changing dist bytes.
  const manifest = readFileSync(path.resolve(directory, '../package.json'));
  hash.update(JSON.stringify(['package.json', manifest.length]));
  hash.update(manifest);
  const visit = (relative: string) => {
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        const bytes = readFileSync(path.join(directory, filename));
        hash.update(JSON.stringify([filename, bytes.length]));
        hash.update(bytes);
      } else {
        throw new Error(`Unsupported Redact runtime artifact: ${filename}`);
      }
    }
  };
  visit('');
  return `redact-artifact:sha256:${hash.digest('hex')}`;
}

export function resolveRedactAliases(
  require = frameworkRequire,
): Record<string, string> {
  const aliases = Object.fromEntries(
    Object.entries(REDACT_ALIASES).map(([from, to]) => [
      `${from}$`,
      require.resolve(to),
    ]),
  );
  for (const to of new Set(Object.values(REDACT_ALIASES)))
    aliases[`${to}$`] = require.resolve(to);
  return aliases;
}

type Aliases = NonNullable<Rspack.Configuration['resolve']>['alias'];
type AliasRecord = Exclude<NonNullable<Aliases>, boolean>;

/** Normalize legacy arrays for Rspack 2, preserving exact matches, false
 * aliases and ordered duplicate fallbacks. Never feed numeric keys to the
 * public plugin; array-shaped final aliases also fail native Rspack resolution.
 */
export function mergeRedactAliases(
  previous: Aliases,
  canonical: Record<string, string>,
): Aliases {
  const owned = (name: string) =>
    Object.hasOwn(canonical, `${name.replace(/\$$/, '')}$`);
  const entries: Array<[string, AliasRecord[string]]> = Array.isArray(previous)
    ? previous.map(item => [
        `${item.name}${item.onlyModule && !item.name.endsWith('$') ? '$' : ''}`,
        item.alias,
      ])
    : Object.entries(previous ?? {});
  const preserved: AliasRecord = Object.create(null);
  for (const [name, alias] of entries) {
    if (owned(name)) continue;
    if (Object.hasOwn(preserved, name)) {
      preserved[name] = [preserved[name], alias].flat();
    } else preserved[name] = alias;
  }
  return { ...canonical, ...preserved };
}

const runtimeRequest = (request: string) =>
  /^(?:react(?:-dom)?|@tanstack\/redact|scheduler|use-sync-external-store)(?:\/|$)/.test(
    request,
  );

/** Externals are evaluated before aliases. Keep runtime requests in the graph. */
export function bundleRedactRuntime(
  externals: Rspack.Configuration['externals'],
): Rspack.Configuration['externals'] {
  if (Array.isArray(externals))
    return externals
      .map(item => bundleRedactRuntime(item))
      .filter(item => item !== undefined) as Rspack.Configuration['externals'];
  if (typeof externals === 'string')
    return runtimeRequest(externals) ? undefined : externals;
  if (externals instanceof RegExp) {
    const expression = externals;
    return ({ request }, callback) => {
      if (!request || runtimeRequest(request)) return callback?.();
      expression.lastIndex = 0;
      return callback?.(
        undefined,
        expression.test(request) ? request : undefined,
      );
    };
  }
  if (typeof externals === 'function') {
    const original = externals;
    return (data, callback) =>
      data.request && runtimeRequest(data.request)
        ? callback?.()
        : original(data, callback);
  }
  if (externals && typeof externals === 'object')
    return Object.fromEntries(
      Object.entries(externals).filter(([request]) => !runtimeRequest(request)),
    );
  return externals;
}

/** Test dependencies are module-local factories, not user-config escape hatches. */
export function createRedactBuilderPlugin(
  config: ReactRuntimeConfig,
  testing: { assertPatch?: () => void } = {},
): RsbuildPlugin {
  const enabled = usesRedact(config);
  return {
    name: enabled
      ? 'ultramodern:react:redact'
      : 'ultramodern:react:runtime-cache',
    setup(api) {
      const viewTransitions =
        typeof config.redact === 'object' &&
        config.redact.viewTransitions === true;
      // Rspack's persistent module cache must not survive a runtime switch.
      // Otherwise cached real-React modules can be combined with a new Redact
      // server, even though the final aliases correctly select Redact.
      api.modifyEnvironmentConfig(environment => {
        const cache = environment.performance?.buildCache;
        if (cache === false) return environment;
        const options = typeof cache === 'object' ? cache : {};
        return {
          ...environment,
          performance: {
            ...environment.performance,
            buildCache: {
              ...options,
              cacheDigest: [
                ...(options.cacheDigest ?? []),
                ...(enabled
                  ? [
                      '@tanstack/redact@0.2.1',
                      REDACT_PATCH_MARKER,
                      redactArtifactDigest(),
                      `redact-view-transitions:${viewTransitions}`,
                    ]
                  : [
                      `react@${frameworkRequire('react/package.json').version}`,
                      'ultramodern:real-react-cache:v1',
                    ]),
              ],
            },
          },
        };
      });
      // Opt-out and RSC builds only receive cache identity, never aliases or
      // dependency replacement. They also cannot reuse pre-identity caches.
      if (!enabled) return;
      // Inspect normalized environments only after topology and inherited output
      // targets are final. Cloudflare's web-target worker is still SSR.
      const isCsr = () =>
        Object.entries(api.getNormalizedConfig().environments).every(
          ([name, env]) => env.output.target === 'web' && name !== 'workerSSR',
        );
      const publicApplied = new WeakSet<Rspack.Configuration>();
      const publicPlugin = pluginRedact({
        resolveFrom: frameworkDirectory(),
        viewTransitions,
      });
      // Isolate the third-party plugin's Object.entries(alias) implementation:
      // it receives an empty object, then we merge its output into the original
      // object OR array without converting array entries to numeric keys.
      publicPlugin.setup({
        ...api,
        modifyRspackConfig(hook) {
          const handler = typeof hook === 'function' ? hook : hook.handler;
          api.modifyRspackConfig({
            order: 'post',
            async handler(rspackConfig, utils) {
              if (!isCsr()) return;
              const isolated = {
                ...rspackConfig,
                resolve: { ...rspackConfig.resolve, alias: {} },
              };
              await handler(isolated, utils);
              if (Object.hasOwn(isolated.resolve.alias, 'react$'))
                publicApplied.add(rspackConfig);
              rspackConfig.resolve ??= {};
              rspackConfig.resolve.alias = mergeRedactAliases(
                rspackConfig.resolve.alias,
                isolated.resolve.alias as Record<string, string>,
              );
              rspackConfig.plugins = isolated.plugins;
            },
          });
        },
      });
      api.modifyRspackConfig({
        order: 'post',
        handler(rspackConfig, { rspack, environment }) {
          (testing.assertPatch ?? assertRedactPatch)();
          const aliases = resolveRedactAliases();
          // This hook follows both the public plugin and all chain hooks, so
          // Cloudflare/source-build React file pins cannot win over the runtime.
          rspackConfig.resolve ??= {};
          rspackConfig.resolve.alias = mergeRedactAliases(
            rspackConfig.resolve.alias,
            aliases,
          );
          rspackConfig.externals = bundleRedactRuntime(rspackConfig.externals);
          rspackConfig.plugins ??= [];
          if (!publicApplied.has(rspackConfig) && !viewTransitions) {
            const feature = path.resolve(
              path.dirname(frameworkRequire.resolve('@tanstack/redact')),
              '../dom/features/view-transition/index.js',
            );
            rspackConfig.plugins.push(
              new rspack.NormalModuleReplacementPlugin(
                /[\\/]features[\\/]view-transition[\\/]index\.js$/,
                data => {
                  if (data.createData?.resource === feature)
                    data.createData.resource = path.join(
                      path.dirname(feature),
                      'stub.js',
                    );
                },
              ),
            );
          }
          if (
            environment.name === 'workerSSR' ||
            environment.config.output.target === 'web-worker'
          ) {
            rspackConfig.plugins.push(
              new rspack.DefinePlugin({
                'process.env.NODE_ENV': JSON.stringify(
                  api.getNormalizedConfig().mode === 'development'
                    ? 'development'
                    : 'production',
                ),
              }),
            );
          }
        },
      });
    },
  };
}

export const ultramodernRedactIntegrationPlugin = (): CliPlugin<AppTools> => ({
  name: '@modern-js/ultramodern-redact-integration',
  setup(api) {
    let reportedRsc = false;
    api.modifyResolvedConfig(config => {
      const selected = config as typeof config & ReactRuntimeConfig;
      validateRedactConfig(selected.redact);
      if (selected.server?.rsc && selected.redact !== false && !reportedRsc) {
        reportedRsc = true;
        logger.info(
          '[ultramodern] Redact is disabled for this entire RSC app: React Flight requires real React internals that Redact does not implement.',
        );
      }
      return {
        ...config,
        builderPlugins: [
          ...(config.builderPlugins ?? []),
          createRedactBuilderPlugin(selected),
        ],
      };
    });
  },
});
