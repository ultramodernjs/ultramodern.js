import path from 'node:path';
import {
  appHasApi,
  resolveApiProtocol,
  resolveRemoteRefs,
  sharedPackages,
} from './descriptors';
import { relativeRootFor } from './naming';
import { resolveAppGenerationProfile } from './renderer-profile';
import type { JsonObject, JsonValue, WorkspaceApp } from './types';
export function createTsConfigBase(): JsonValue {
  return { extends: '@modern-js/ultramodern-create/tsconfig' };
}

function createTsBuildInfoFile(packageDir: string): string {
  const cacheKey = packageDir.replace(/[^a-zA-Z0-9._-]+/gu, '__');
  return `${relativeRootFor(packageDir)}/node_modules/.cache/tsgo/${cacheKey}.tsbuildinfo`;
}

function createTsDeclarationOutDir(packageDir: string): string {
  const cacheKey = packageDir.replace(/[^a-zA-Z0-9._-]+/gu, '__');
  return `${relativeRootFor(packageDir)}/node_modules/.cache/tsgo/declarations/${cacheKey}`;
}

function createReferences(
  packageDir: string,
  references: string[],
): JsonValue[] {
  return [...new Set(references)]
    .filter(reference => reference !== packageDir)
    .map(reference => ({
      path: path.relative(packageDir, reference).split(path.sep).join('/'),
    }));
}

type CreatePackageTsConfigOptions = {
  include?: string[];
  includeApi?: boolean;
  includeServer?: boolean;
  references?: string[];
  skipLibCheck?: boolean;
};

type PackageTsConfig = JsonObject & {
  compilerOptions: JsonObject;
  include: string[];
};

export function createPackageTsConfig(
  packageDir: string,
  options: CreatePackageTsConfigOptions | boolean = {},
): PackageTsConfig {
  const resolvedOptions =
    typeof options === 'boolean' ? { includeApi: options } : options;
  const include = resolvedOptions.include ?? [
    'src',
    'locales/**/*.json',
    'package.json',
    'shared',
    'shared/ultramodern-build.json',
  ];
  if (resolvedOptions.includeServer) {
    include.push('server');
  }
  if (resolvedOptions.includeApi) {
    include.push('api');
  }
  const references = createReferences(
    packageDir,
    resolvedOptions.references ?? [],
  );
  const tsconfig: PackageTsConfig = {
    extends: `${relativeRootFor(packageDir)}/tsconfig.base.json`,
    compilerOptions: {
      composite: true,
      declaration: true,
      declarationMap: false,
      emitDeclarationOnly: true,
      incremental: true,
      noEmit: false,
      ...(resolvedOptions.skipLibCheck ? { skipLibCheck: true } : {}),
      outDir: createTsDeclarationOutDir(packageDir),
      tsBuildInfoFile: createTsBuildInfoFile(packageDir),
    },
    include,
  };
  if (references.length > 0) {
    tsconfig.references = references;
  }
  return tsconfig;
}

export function createAppTsConfig(
  app: WorkspaceApp,
  remotes: WorkspaceApp[] = [],
): JsonValue {
  const remoteRefs =
    app.kind === 'shell' ? [] : resolveRemoteRefs(app, remotes);
  const references = [
    ...sharedPackages.map(sharedPackage => sharedPackage.directory),
    // Federation hosts resolve remote package exports directly to source.
    // Project references would require declaration output before host builds.
    ...remoteRefs.map(remote => remote.directory),
  ];
  const config = createPackageTsConfig(app.directory, {
    includeApi: appHasApi(app),
    includeServer: true,
    references,
    // Composed remotes import sibling source exports, so their application
    // checker traverses framework declaration dependencies outside app source.
    skipLibCheck: remoteRefs.length > 0,
  });
  config.include.push('*.config.ts');
  const profile = resolveAppGenerationProfile(app);
  if (profile) {
    const compilerOptions = config.compilerOptions;
    compilerOptions.jsx = 'preserve';
    compilerOptions.jsxImportSource = profile.jsxImportSource;
    if (profile.renderer !== 'react') compilerOptions.types = [];
    Object.assign(config, profile.tsconfig);
  }
  return config;
}

export function createAppMfTypesTsConfig(app: WorkspaceApp): JsonValue {
  const exposedFiles = Object.entries(app.exposes ?? {})
    .sort(([left], [right]) =>
      left === './Route' ? -1 : right === './Route' ? 1 : 0,
    )
    .map(([, exposePath]) => exposePath.replace(/^\.\//u, ''));

  return {
    extends: `${relativeRootFor(app.directory)}/tsconfig.base.json`,
    include:
      app.surfaceProfile === 'api-only'
        ? [
            resolveApiProtocol(app) === 'rpc'
              ? 'shared/rpc.ts'
              : 'shared/api.ts',
          ]
        : [...new Set([...exposedFiles, 'src/modern-app-env.d.ts'])],
    // The MF declaration compiler follows framework implementation types that
    // are not part of the exposed application surface. Application source is
    // still checked separately; composed apps use the same dependency boundary.
    compilerOptions: {
      skipLibCheck: true,
    },
  };
}

export function createSharedPackageTsConfig(packageDir: string): JsonValue {
  return createPackageTsConfig(packageDir, {
    include: ['src'],
  });
}

export function createRootTsConfig(apps: WorkspaceApp[] = []): JsonValue {
  return {
    files: [],
    references: [
      ...sharedPackages.map(sharedPackage => ({
        path: sharedPackage.directory,
      })),
      ...apps.map(app => ({ path: app.directory })),
    ],
  };
}
