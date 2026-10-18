import {
  ULTRAMODERN_CREATE_PACKAGE,
  WORKSPACE_PACKAGE_VERSION,
} from '../ultramodern-package-source';
import type { UltramodernBridgeConfig } from './bridge-config';
import {
  appEmitsBrowserUi,
  appHasApi,
  remoteDependencyAlias,
  resolveApiProtocol,
  resolveRemoteRefs,
  shellApp,
  verticalApiApps,
  zephyrRemoteDependency,
} from './descriptors';
import { readFileTemplate } from './fs-io';
import { packageName, relativeRootFor } from './naming';
import { ULTRAMODERN_WORKSPACE_POLICY } from './policy';
import { hasNativeAppGeneration } from './renderer-generations';
import {
  appSupportsFederation,
  resolveAppGenerationProfile,
  resolveWorkspaceRenderer,
} from './renderer-profile';
import type { JsonValue, ResolvedPackageSource, WorkspaceApp } from './types';
import { NODE_VERSION, ULTRAMODERN_PACKAGE_PINS } from './versions';
import {
  createStrictTsgoTypecheckCommand,
  createWorkspaceAppPackageScripts,
  createWorkspaceRootPackageScripts,
  GENERATED_POSTINSTALL_SCRIPT,
} from './workspace-script-plan';

const frameworkRequest = (packageSource: ResolvedPackageSource) =>
  packageSource.strategy === 'install' ? 'catalog:ultramodern' : 'workspace:*';

export function appDependencies(
  scope: string,
  packageSource: ResolvedPackageSource,
  app: WorkspaceApp,
  remotes: WorkspaceApp[] = [],
  bridge?: UltramodernBridgeConfig,
): Record<string, string> {
  const renderer = resolveWorkspaceRenderer(app);
  const generationProfile = resolveAppGenerationProfile(app);
  const dependencies: Record<string, string> = {
    ...(renderer === 'react'
      ? {
          '@modern-js/plugin-tanstack': frameworkRequest(packageSource),
          '@modern-js/i18n-integration': frameworkRequest(packageSource),
          '@modern-js/plugin-i18n': frameworkRequest(packageSource),
          '@modern-js/federation-runtime': frameworkRequest(packageSource),
          '@modern-js/runtime-renderer-extensions':
            frameworkRequest(packageSource),
          '@modern-js/runtime-extensions': frameworkRequest(packageSource),
          '@modern-js/runtime': frameworkRequest(packageSource),
          ...ULTRAMODERN_PACKAGE_PINS.appDependencies,
        }
      : renderer === 'none'
        ? {}
        : {
            ...Object.fromEntries(
              generationProfile!.frameworkDependencies.map(name => [
                name,
                frameworkRequest(packageSource),
              ]),
            ),
            ...generationProfile!.dependencies,
          }),
    '@modern-js/backend-federation-contracts': frameworkRequest(packageSource),
    [packageName(scope, 'shared-contracts')]: WORKSPACE_PACKAGE_VERSION,
    ...(appEmitsBrowserUi(app)
      ? {
          [packageName(scope, 'shared-design-tokens')]:
            WORKSPACE_PACKAGE_VERSION,
        }
      : {}),
  };

  if (appHasApi(app) || (app.kind === 'shell' && renderer === 'react')) {
    dependencies['@modern-js/plugin-bff-extensions'] =
      frameworkRequest(packageSource);
  }

  const appRemotes = resolveRemoteRefs(app, remotes);

  for (const dependency of bridge?.dependencies ?? []) {
    if (Object.hasOwn(dependencies, dependency)) {
      throw new Error(
        `Bridge mode dependency "${dependency}" conflicts with generated app dependency.`,
      );
    }

    dependencies[dependency] = WORKSPACE_PACKAGE_VERSION;
  }

  if (app.kind === 'shell' && renderer === 'react') {
    dependencies['@modern-js/boundary-debugger'] =
      frameworkRequest(packageSource);
    dependencies['@modern-js/plugin-bff'] = frameworkRequest(packageSource);
    Object.assign(dependencies, ULTRAMODERN_PACKAGE_PINS.bffEffectDependencies);
  }
  if (app.kind === 'shell') {
    for (const remote of verticalApiApps(remotes)) {
      dependencies[packageName(scope, remote.packageSuffix)] =
        WORKSPACE_PACKAGE_VERSION;
    }
  }

  for (const remote of appRemotes) {
    dependencies[packageName(scope, remote.packageSuffix)] =
      WORKSPACE_PACKAGE_VERSION;
  }

  if (appHasApi(app)) {
    dependencies['@modern-js/plugin-bff'] = frameworkRequest(packageSource);
    dependencies['@modern-js/bff-effect'] = frameworkRequest(packageSource);
    Object.assign(dependencies, ULTRAMODERN_PACKAGE_PINS.bffEffectDependencies);
    if (renderer === 'none') {
      dependencies['@module-federation/runtime'] =
        ULTRAMODERN_PACKAGE_PINS.appDependencies['@module-federation/runtime'];
    }
  }

  return dependencies;
}

function appDevDependencies(
  packageSource: ResolvedPackageSource,
  enableTailwind: boolean,
  app: WorkspaceApp,
): Record<string, string> {
  const {
    '@rsbuild/plugin-tailwindcss': tailwindPluginVersion,
    tailwindcss: tailwindVersion,
    ...always
  } = ULTRAMODERN_PACKAGE_PINS.appDevDependencies;
  const renderer = resolveWorkspaceRenderer(app);
  const generationProfile = resolveAppGenerationProfile(app);
  const selectedAlways =
    renderer === 'react'
      ? always
      : Object.fromEntries(
          Object.entries(always).filter(
            ([name]) =>
              name !== '@types/react' &&
              name !== '@types/react-dom' &&
              name !== 'zephyr-rspack-plugin' &&
              (name !== 'wrangler' ||
                generationProfile?.capabilities.workers === true),
          ),
        );

  return {
    ...(appHasApi(app) || (app.kind === 'shell' && renderer === 'react')
      ? {
          '@modern-js/plugin-bff-build-extensions':
            frameworkRequest(packageSource),
        }
      : {}),
    '@modern-js/ultramodern-app-tools': frameworkRequest(packageSource),
    '@modern-js/app-tools-extensions': frameworkRequest(packageSource),
    ...(renderer === 'react' || renderer === 'none'
      ? { '@modern-js/app-tools': frameworkRequest(packageSource) }
      : {}),
    ...selectedAlways,
    ...generationProfile?.devDependencies,
    ...(enableTailwind
      ? {
          '@rsbuild/plugin-tailwindcss': tailwindPluginVersion,
          tailwindcss: tailwindVersion,
        }
      : {}),
  };
}

export function createRootPackageJson(
  scope: string,
  packageSource: ResolvedPackageSource,
  remotes: WorkspaceApp[] = [],
  bridge?: UltramodernBridgeConfig,
  additionalShells: WorkspaceApp[] = [],
  primaryShell: WorkspaceApp = shellApp,
): JsonValue {
  const renderer = resolveWorkspaceRenderer(primaryShell);
  if (hasNativeAppGeneration(renderer)) {
    const apps = [primaryShell, ...additionalShells, ...remotes];
    const workerApps = apps.filter(
      app => resolveAppGenerationProfile(app)?.capabilities.workers,
    );
    const workerFilters = workerApps
      .map(app => `--filter ${packageName(scope, app.packageSuffix)}`)
      .join(' ');
    if (bridge)
      throw new Error(
        `Renderer ${renderer} does not support React bridge configuration.`,
      );
    const rootDevDependencies = Object.fromEntries(
      Object.entries(ULTRAMODERN_PACKAGE_PINS.rootDevDependencies).filter(
        ([name]) =>
          (name !== 'wrangler' || workerApps.length > 0) &&
          name !== 'zephyr-agent' &&
          name !== 'miniflare',
      ),
    );
    return {
      private: true,
      name: scope,
      version: '0.1.0',
      type: 'module',
      packageManager: `pnpm@${ULTRAMODERN_WORKSPACE_POLICY.toolchain.packageManager.version}`,
      engines: {
        node: `>=${resolveAppGenerationProfile(primaryShell)!.nodeVersion}`,
        pnpm: '>=11',
      },
      scripts: {
        dev: `pnpm --parallel ${apps.map(app => `--filter ${packageName(scope, app.packageSuffix)}`).join(' ')} dev`,
        'dev:shell': `pnpm --filter ${packageName(scope, primaryShell.packageSuffix)} dev`,
        build: 'pnpm -r --filter "./apps/*" --filter "./verticals/*" run build',
        ...(workerApps.length > 0
          ? {
              'cloudflare:build': `pnpm -r ${workerFilters} run cloudflare:build`,
              'cloudflare:deploy': `pnpm -r ${workerFilters} run cloudflare:deploy`,
              'cloudflare:preview': `pnpm --parallel ${workerFilters} run cloudflare:preview`,
            }
          : {}),
        typecheck:
          'pnpm -r --filter "./packages/*" run typecheck && pnpm -r --filter "./apps/*" --filter "./verticals/*" run typecheck',
        'contract:check': 'ultramodern-create ultramodern validate',
        check:
          'pnpm format:check && pnpm lint && pnpm typecheck && pnpm contract:check',
        format: 'oxfmt .',
        'format:check': 'oxfmt --check .',
        lint: 'oxlint apps verticals packages',
        'lint:fix': 'oxlint apps verticals packages --fix',
        'skills:install': 'ultramodern-create ultramodern skills install',
        'skills:check': 'ultramodern-create ultramodern skills check',
        postinstall: GENERATED_POSTINSTALL_SCRIPT,
      },
      workspaces: ['apps/*', 'verticals/*', 'packages/*'],
      modernjs: {
        preset: 'presetUltramodern',
        workspace: 'ultramodern-superapp',
        topology: './topology/reference-topology.json',
        ownership: './topology/ownership.json',
      },
      devDependencies: {
        ...rootDevDependencies,
        typescript: ULTRAMODERN_PACKAGE_PINS.appDevDependencies.typescript,
        [ULTRAMODERN_CREATE_PACKAGE]: frameworkRequest(packageSource),
        '@modern-js/ultramodern-app-tools': frameworkRequest(packageSource),
      },
    };
  }
  const shellFilter = `--filter ${packageName(scope, shellApp.packageSuffix)}`;
  const additionalShellFilters = additionalShells.map(
    shell => `--filter ${packageName(scope, shell.packageSuffix)}`,
  );
  const remoteFilters = remotes.map(
    remote => `--filter ${packageName(scope, remote.packageSuffix)}`,
  );
  const bridgeScripts = bridge
    ? {
        ...Object.fromEntries(
          bridge.gates.map(gate => [
            `bridge:${gate.name}`,
            `${gate.cwd ? `cd ${gate.cwd} && ` : ''}${gate.command}`,
          ]),
        ),
        'bridge:check': bridge.gates
          .map(gate => `pnpm run bridge:${gate.name}`)
          .join(' && '),
      }
    : {};
  const bridgeCheck = bridge ? ' && pnpm bridge:check' : '';
  const bridgeTypecheck = bridge
    ? 'pnpm -r --filter "./apps/*" --filter "./verticals/*" --filter "./packages/*" run typecheck'
    : undefined;
  const rootPackageScripts = createWorkspaceRootPackageScripts(remotes, {
    bridgeCheck,
    typecheck: bridgeTypecheck,
    shells: [shellApp, ...additionalShells],
  });
  const workspacePackages = [
    'apps/*',
    'verticals/*',
    'packages/*',
    ...(bridge?.workspacePackages.map(entry => entry.pattern) ?? []),
  ];

  return {
    private: true,
    name: scope,
    version: '0.1.0',
    type: 'module',
    packageManager: `pnpm@${ULTRAMODERN_WORKSPACE_POLICY.toolchain.packageManager.version}`,
    scripts: {
      dev: `pnpm --parallel ${[shellFilter, ...additionalShellFilters, ...remoteFilters].join(' ')} dev`,
      'dev:shell': `pnpm --filter ${packageName(scope, shellApp.packageSuffix)} dev`,
      ...Object.fromEntries(
        additionalShells.map(shell => [
          `dev:${shell.packageSuffix}`,
          `pnpm --filter ${packageName(scope, shell.packageSuffix)} dev`,
        ]),
      ),
      ...Object.fromEntries(
        remotes.map(remote => [
          `dev:${remote.packageSuffix}`,
          `pnpm --filter ${packageName(scope, remote.packageSuffix)} dev`,
        ]),
      ),
      ...rootPackageScripts,
      format: 'oxfmt .',
      'format:check': 'oxfmt --check .',
      lint: 'oxlint apps verticals packages',
      'lint:fix': 'oxlint apps verticals packages --fix',
      'skills:install': 'ultramodern-create ultramodern skills install',
      'skills:check': 'ultramodern-create ultramodern skills check',
      'agents:refs:install': 'node ./scripts/setup-agent-reference-repos.mts',
      'agents:refs:check':
        'node ./scripts/setup-agent-reference-repos.mts --check',
      'api:check': 'modern-api-check',
      'api:check:files': 'modern-api-check-files',
      'i18n:boundaries': 'modern-i18n-check',
      ...bridgeScripts,
      postinstall: GENERATED_POSTINSTALL_SCRIPT,
    },
    engines: {
      node: ULTRAMODERN_WORKSPACE_POLICY.toolchain.node.engineRange,
      pnpm: ULTRAMODERN_WORKSPACE_POLICY.toolchain.packageManager.engineRange,
    },
    workspaces: workspacePackages,
    modernjs: {
      preset: 'presetUltramodern',
      workspace: 'ultramodern-superapp',
      topology: './topology/reference-topology.json',
      ownership: './topology/ownership.json',
    },
    devDependencies: {
      ...ULTRAMODERN_PACKAGE_PINS.rootDevDependencies,
      typescript: ULTRAMODERN_PACKAGE_PINS.appDevDependencies.typescript,
      react: ULTRAMODERN_PACKAGE_PINS.appDependencies.react,
      'react-dom': ULTRAMODERN_PACKAGE_PINS.appDependencies['react-dom'],
      '@modern-js/app-tools': frameworkRequest(packageSource),
      '@modern-js/runtime': frameworkRequest(packageSource),
      '@modern-js/plugin-bff-extensions': frameworkRequest(packageSource),
      '@modern-js/plugin-bff-build-extensions': frameworkRequest(packageSource),
      '@modern-js/runtime-renderer-extensions': frameworkRequest(packageSource),
      '@modern-js/ultramodern-app-tools': frameworkRequest(packageSource),
      '@modern-js/app-tools-extensions': frameworkRequest(packageSource),
      '@modern-js/bff-effect': frameworkRequest(packageSource),
      '@modern-js/code-tools': frameworkRequest(packageSource),
      [ULTRAMODERN_CREATE_PACKAGE]: frameworkRequest(packageSource),
      '@modern-js/plugin-bff': frameworkRequest(packageSource),
      ...ULTRAMODERN_PACKAGE_PINS.bffEffectDependencies,
    },
  };
}

function createZephyrDependencies(
  scope: string,
  app: WorkspaceApp,
  remotes: WorkspaceApp[] = [],
): JsonValue {
  if (!app.verticalRefs?.length) {
    return {};
  }

  return Object.fromEntries(
    resolveRemoteRefs(app, remotes).map(remote => [
      remoteDependencyAlias(remote),
      zephyrRemoteDependency(scope, remote),
    ]),
  );
}

export {
  createAppMfTypesTsConfig,
  createAppTsConfig,
  createPackageTsConfig,
  createRootTsConfig,
  createSharedPackageTsConfig,
  createTsConfigBase,
} from './tsconfigs';
export function createAppPackage(
  scope: string,
  app: WorkspaceApp,
  packageSource: ResolvedPackageSource,
  enableTailwind: boolean,
  remotes: WorkspaceApp[] = [],
  bridge?: UltramodernBridgeConfig,
): JsonValue {
  const packageExports: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(app.exposes ?? {}).map(([expose, source]) => [
      expose,
      source,
    ]),
  );
  const packageJson: Record<string, JsonValue> = {
    private: true,
    name: packageName(scope, app.packageSuffix),
    version: '0.1.0',
    engines: {
      node: `>=${resolveAppGenerationProfile(app)?.nodeVersion ?? NODE_VERSION}`,
    },
    scripts: createWorkspaceAppPackageScripts(app),
    modernjs: {
      preset: 'presetUltramodern',
      role:
        app.kind === 'shell'
          ? 'shell'
          : appSupportsFederation(app)
            ? 'module-federation-remote'
            : appEmitsBrowserUi(app)
              ? 'application'
              : 'api-only',
      appId: app.id,
      topology: `${relativeRootFor(app.directory)}/topology/reference-topology.json`,
      ...(appHasApi(app) ? { apiRuntime: 'effect' } : {}),
    },
    ...(resolveWorkspaceRenderer(app) === 'react' && appSupportsFederation(app)
      ? { 'zephyr:dependencies': createZephyrDependencies(scope, app, remotes) }
      : {}),
    dependencies: appDependencies(scope, packageSource, app, remotes, bridge),
    devDependencies: appDevDependencies(packageSource, enableTailwind, app),
  };

  if (appHasApi(app)) {
    const clientDirectory =
      app.surfaceProfile === 'api-only' ? 'shared' : 'src/api';
    if (resolveApiProtocol(app) === 'rpc') {
      Object.assign(packageExports, {
        './api': './shared/rpc.ts',
        './api/rpc-client': `./${clientDirectory}/${app.api.stem}-rpc-client.ts`,
      });
    } else {
      Object.assign(packageExports, {
        './api': './shared/api.ts',
        './api/client': `./${clientDirectory}/${app.api.stem}-client.ts`,
      });
    }
  }

  if (Object.keys(packageExports).length > 0) {
    packageJson.exports = packageExports;
  }

  return packageJson;
}

export function createSharedPackage(
  scope: string,
  id: string,
  description: string,
  packageSource?: ResolvedPackageSource,
  renderer: WorkspaceApp['renderer'] = 'react',
): JsonValue {
  const packageJson: Record<string, JsonValue> = {
    private: true,
    name: packageName(scope, id),
    version: '0.1.0',
    description,
    type: 'module',
    exports: {
      '.': './src/index.ts',
    },
    scripts: {
      typecheck: createStrictTsgoTypecheckCommand(`packages/${id}`),
    },
    devDependencies: {
      '@effect/tsgo':
        ULTRAMODERN_PACKAGE_PINS.appDevDependencies['@effect/tsgo'],
    },
  };

  if (id === 'shared-contracts') {
    packageJson.dependencies = hasNativeAppGeneration(renderer)
      ? {
          '@modern-js/renderer-core': packageSource
            ? frameworkRequest(packageSource)
            : WORKSPACE_PACKAGE_VERSION,
        }
      : {
          ...ULTRAMODERN_PACKAGE_PINS.bffEffectDependencies,
          '@modern-js/bff-effect': packageSource
            ? frameworkRequest(packageSource)
            : WORKSPACE_PACKAGE_VERSION,
          '@modern-js/runtime-extensions': packageSource
            ? frameworkRequest(packageSource)
            : WORKSPACE_PACKAGE_VERSION,
          '@modern-js/plugin-bff': packageSource
            ? frameworkRequest(packageSource)
            : WORKSPACE_PACKAGE_VERSION,
        };
  }

  if (id === 'shared-design-tokens') {
    packageJson.exports = {
      ...(packageJson.exports as Record<string, JsonValue>),
      './tokens.css': './src/tokens.css',
    };
  }

  return packageJson;
}

export function createSharedContractsIndex(
  renderer: WorkspaceApp['renderer'] = 'react',
): string {
  if (hasNativeAppGeneration(renderer)) {
    return `export const ultramodernWorkspaceContract = {\n  preset: 'presetUltramodern',\n  topology: 'topology/reference-topology.json',\n  ownership: 'topology/ownership.json',\n} as const;\n`;
  }
  return readFileTemplate('packages/shared-contracts-index.ts');
}
