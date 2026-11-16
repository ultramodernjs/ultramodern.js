import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  type RendererRouterBinding,
  type RendererRouterBindings,
  type RouterPackageBinding,
  validateRendererRouterBindings,
} from '@modern-js/backend-federation-contracts';
import {
  getEntrypointRoutesDir,
  getEntrypointRoutesOwner,
} from '@modern-js/runtime/cli';
import type { Entrypoint } from '@modern-js/types/cli/base';

const BUILT_IN_OWNER = '@modern-js/plugin-router';
const TANSTACK_OWNER = '@modern-js/plugin-tanstack';

const DECLARED_REACT_ROUTER = Object.freeze<RouterPackageBinding>({
  framework: 'react-router',
  name: 'react-router',
  version: '8.5.1',
  coreName: 'react-router',
  coreVersion: '8.5.1',
});
const DECLARED_TANSTACK_ROUTER = Object.freeze<RouterPackageBinding>({
  framework: 'tanstack',
  name: '@tanstack/react-router',
  version: '1.170.46',
  coreName: '@tanstack/router-core',
  coreVersion: '1.171.39',
});

type InstalledPackage = { directory: string; version: string };

function readInstalledPackage(
  fromDirectory: string,
  name: string,
): InstalledPackage | undefined {
  let manifestFile: string;
  try {
    manifestFile = createRequire(
      path.join(fromDirectory, 'package.json'),
    ).resolve(`${name}/package.json`);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
      return undefined;
    throw error;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  // Published framework owners are npm aliases stamped with their source name.
  if (
    (manifest?.name !== name && manifest?.ultramodern?.sourceName !== name) ||
    typeof manifest.version !== 'string'
  )
    throw new Error(
      `Installed ${name} has an invalid manifest: ${manifestFile}`,
    );
  return { directory: path.dirname(manifestFile), version: manifest.version };
}

/**
 * The router the application's owning framework package actually binds.
 * Applications may share an earlier router release with the framework (for
 * example through pnpm overrides), so the installed version is the identity;
 * an application whose dependencies are not installed yet binds the
 * framework's declared release.
 */
function installedProvider(
  appDirectory: string | undefined,
  owner: string,
  declared: RouterPackageBinding,
): RouterPackageBinding {
  if (!appDirectory) return declared;
  const framework = readInstalledPackage(appDirectory, owner);
  if (!framework) return declared;
  const router = readInstalledPackage(framework.directory, declared.name);
  if (!router)
    throw new Error(
      `${owner} is installed without its ${declared.name} router dependency`,
    );
  const core =
    declared.coreName === declared.name
      ? router
      : readInstalledPackage(router.directory, declared.coreName);
  if (!core)
    throw new Error(
      `${declared.name} is installed without its ${declared.coreName} core dependency`,
    );
  if (
    router.version === declared.version &&
    core.version === declared.coreVersion
  )
    return declared;
  return Object.freeze({
    ...declared,
    version: router.version,
    coreVersion: core.version,
  });
}

function ownedBinding(
  owner: string,
  evidence: 'owned-default' | 'file-routes',
  provider: RouterPackageBinding,
): RendererRouterBinding {
  return Object.freeze({
    owner,
    evidence,
    defaultProvider: provider,
    providers: Object.freeze([provider] as const),
  });
}

/** Capture registered owners and provider availability without selecting app code. */
export function resolveReactRouterBindings({
  entrypoints,
  pluginNames,
  appDirectory,
}: {
  entrypoints: readonly Entrypoint[];
  pluginNames: readonly string[];
  /** Records the routers this application installs, when present. */
  appDirectory?: string;
}): RendererRouterBindings {
  const owners = new Set(pluginNames);
  if (!owners.has(BUILT_IN_OWNER)) {
    throw new Error(
      'React router bindings require the registered @modern-js/plugin-router default owner.',
    );
  }
  const hasTanstack = owners.has(TANSTACK_OWNER);
  const reactRouter = installedProvider(
    appDirectory,
    '@modern-js/runtime',
    DECLARED_REACT_ROUTER,
  );
  const tanstackRouter = hasTanstack
    ? installedProvider(appDirectory, TANSTACK_OWNER, DECLARED_TANSTACK_ROUTER)
    : DECLARED_TANSTACK_ROUTER;
  const bindings = Object.fromEntries(
    entrypoints.map(entrypoint => {
      // Runtime's canonical metadata is attached by entrypoint modifiers and
      // is intentionally absent from the shared framework-neutral entry type.
      const routesOwner: unknown = Reflect.get(
        entrypoint,
        '__modernRoutesOwner',
      );
      const routesDirectory: unknown = Reflect.get(
        entrypoint,
        '__modernRoutesDir',
      );
      if (routesOwner !== undefined && typeof routesOwner !== 'string') {
        throw new Error(
          `Entry ${entrypoint.entryName} has invalid __modernRoutesOwner metadata; expected a string.`,
        );
      }
      if (
        routesDirectory !== undefined &&
        typeof routesDirectory !== 'string'
      ) {
        throw new Error(
          `Entry ${entrypoint.entryName} has invalid __modernRoutesDir metadata; expected a string.`,
        );
      }
      const routesMetadata = {
        __modernRoutesOwner: routesOwner,
        __modernRoutesDir: routesDirectory,
        nestedRoutesEntry: entrypoint.nestedRoutesEntry,
      };
      const owner = getEntrypointRoutesOwner(routesMetadata);
      const routesDir = getEntrypointRoutesDir(routesMetadata);
      let binding: RendererRouterBinding;

      if (owner === TANSTACK_OWNER) {
        if (!hasTanstack) {
          throw new Error(
            `Entry ${entrypoint.entryName} declares ${TANSTACK_OWNER} without its registered CLI owner.`,
          );
        }
        binding = ownedBinding(TANSTACK_OWNER, 'file-routes', tanstackRouter);
      } else if (owner && owner !== BUILT_IN_OWNER) {
        throw new Error(
          `Entry ${entrypoint.entryName} has unsupported React router owner ${owner}.`,
        );
      } else if (
        owner === BUILT_IN_OWNER ||
        entrypoint.pageRoutesEntry ||
        routesDir === 'routes'
      ) {
        binding = ownedBinding(BUILT_IN_OWNER, 'owned-default', reactRouter);
      } else if (routesDir !== null) {
        throw new Error(
          `Entry ${entrypoint.entryName} has route convention ${routesDir} without a supported owner.`,
        );
      } else if (hasTanstack) {
        binding = Object.freeze({
          owner: TANSTACK_OWNER,
          evidence: 'provider-registry',
          defaultProvider: reactRouter,
          providers: Object.freeze([reactRouter, tanstackRouter]),
        });
      } else {
        binding = ownedBinding(BUILT_IN_OWNER, 'owned-default', reactRouter);
      }
      return [entrypoint.entryName, binding];
    }),
  );
  const validation = validateRendererRouterBindings(
    bindings,
    entrypoints.map(entrypoint => entrypoint.entryName),
  );
  if (!validation.ok) {
    throw new Error(
      `Invalid React router bindings: ${validation.errors
        .map(error => `${error.path}: ${error.message}`)
        .join('; ')}`,
    );
  }
  return Object.freeze(bindings);
}
