import fs from 'node:fs';
import {
  modernPackageSpecifier,
  ULTRAMODERN_WORKSPACE_MODERN_PACKAGES,
} from '../ultramodern-package-source';
import {
  hasCreateReleaseCohort,
  isCreatePackageSourceCheckout,
  readCreateReleaseCohort,
  releaseCohortSelectors,
} from '../ultramodern-release-cohort';
import { runFreshWorkspaceTransaction } from './add-vertical/transaction';
import { createSharedDesignTokensCss } from './app-files';
import type { UltramodernBridgeConfig } from './bridge-config';
import { normalizeUltramodernBridgeConfig } from './bridge-config';
import {
  createDevelopmentOverlay,
  createOwnership,
  createTopology,
} from './contracts';
import {
  appEmitsBrowserUi,
  createShellHost,
  sharedPackages,
} from './descriptors';
import {
  copyRootTemplate,
  formatGeneratedWorkspaceFiles,
  writeFile,
  writeFileReplacing,
  writeJson,
} from './fs-io';
import {
  createFileSnapshot,
  createGenerationResult,
  diffFileSnapshots,
} from './generation-result';
import { createUltramodernBuildArtifactJson } from './module-federation';
import {
  assertUniqueTailwindPrefixes,
  packageName,
  toPackageScope,
} from './naming';
import { runCodeSmithOverlays } from './overlays';
import {
  createRootPackageJson,
  createRootTsConfig,
  createSharedContractsIndex,
  createSharedPackage,
  createSharedPackageTsConfig,
  createTsConfigBase,
} from './package-json';
import {
  resolvePackageSource,
  resolveWorkspacePackageLinkingPolicy,
} from './package-source';
import { ULTRAMODERN_WORKSPACE_POLICY } from './policy';
import { captureWorkspaceRendererEvaluations } from './renderer-config-evaluation';
import { reconcileWorkspaceRendererIdentities } from './renderer-identity';
import { initializeGeneratedRendererIdentity } from './renderer-initial-identity';
import {
  getRendererGenerationProfile,
  isApplicationRenderer,
  resolveAppGenerationProfile,
  resolveWorkspaceRenderer,
} from './renderer-profile';
import type {
  ResolvedPackageSource,
  UltramodernGenerationResult,
  UltramodernWorkspaceOptions,
  WorkspaceApp,
} from './types';
import { isForeignRendererPackage } from './validation/renderer';
import { validateWorkspace } from './validation/workspace';
import {
  EFFECT_VERSION,
  I18NEXT_VERSION,
  NODE_VERSION,
  PNPM_VERSION,
} from './versions';
import { writeGeneratedWorkspaceScripts } from './workspace-scripts';
import { createWorkspaceValidationContract } from './workspace-validation-contract';
import { writeApp } from './write-app';
import { createZeropsYaml } from './zerops';

export { writeApp };

function hasExplicitInstallRequest(options: UltramodernWorkspaceOptions) {
  return (
    options.packageSource !== undefined &&
    options.packageSource.strategy !== 'workspace'
  );
}

function writeSharedPackages(
  targetDir: string,
  scope: string,
  packageSource: ResolvedPackageSource,
  primaryShell: WorkspaceApp,
) {
  for (const sharedPackage of sharedPackages) {
    writeJson(
      targetDir,
      `${sharedPackage.directory}/package.json`,
      createSharedPackage(
        scope,
        sharedPackage.id,
        sharedPackage.description,
        packageSource,
        primaryShell.renderer,
      ),
    );
    writeJson(
      targetDir,
      `${sharedPackage.directory}/tsconfig.json`,
      createSharedPackageTsConfig(sharedPackage.directory),
    );
  }

  writeFile(
    targetDir,
    'packages/shared-contracts/src/index.ts',
    createSharedContractsIndex(primaryShell.renderer),
  );
  writeFile(
    targetDir,
    'packages/shared-design-tokens/src/index.ts',
    `export const sharedDesignTokens = {
  color: {
    accent: '#2f8f68',
    foreground: '#133225',
    surface: '#f6fbf7',
  },
} as const;
`,
  );
  writeFile(
    targetDir,
    'packages/shared-design-tokens/src/tokens.css',
    createSharedDesignTokensCss(),
  );
}

// The catalog pins one exact release cohort. The workspace keeps pnpm's strict
// 24h release-age gate for everything else but exempts the reviewed compiler
// releases and exact cohort and sidecar versions authenticated by this create
// package, so freshly released framework packages and their owned transitive
// dependencies install.
// A catalog for any other release gets no exemption: this package cannot
// authenticate that cohort, so it installs once it is 24h old.
function renderCatalogPolicy(
  packageSource: ResolvedPackageSource,
  primaryShell: WorkspaceApp,
) {
  const compilerExclusions =
    ULTRAMODERN_WORKSPACE_POLICY.pnpm.minimumReleaseAgeExclude;
  const renderExclusions = (selectors: readonly string[]) =>
    `minimumReleaseAgeExclude:\n${[...new Set(selectors)]
      .sort()
      .map(selector => `  - ${JSON.stringify(selector)}`)
      .join('\n')}\n\n`;
  if (packageSource.strategy !== 'install') {
    return renderExclusions(compilerExclusions);
  }
  // The catalog is workspace policy: it must not offer packages that belong
  // to another renderer than the one the workspace was generated for.
  const renderer = resolveWorkspaceRenderer(primaryShell);
  const catalog = [
    ...new Set([
      ...ULTRAMODERN_WORKSPACE_MODERN_PACKAGES,
      '@modern-js/backend-federation-contracts',
      '@modern-js/renderer-core',
      ...(resolveAppGenerationProfile(primaryShell)?.frameworkDependencies ??
        []),
    ]),
  ]
    .filter(name => !isForeignRendererPackage(name, renderer))
    .map(
      name =>
        `    ${JSON.stringify(name)}: ${JSON.stringify(modernPackageSpecifier(name, packageSource))}`,
    )
    .join('\n');
  const cohort = hasCreateReleaseCohort()
    ? readCreateReleaseCohort()
    : undefined;
  const pinsShippedCohort = cohort?.packages.every(
    item =>
      modernPackageSpecifier(item.sourceName, packageSource) ===
      `npm:${item.targetName}@${item.version}`,
  );
  const exclude = renderExclusions([
    ...compilerExclusions,
    ...(cohort && pinsShippedCohort ? releaseCohortSelectors(cohort) : []),
  ]);
  return `catalogs:\n  ultramodern:\n${catalog}\n\n${exclude}`;
}

function writePnpmWorkspacePackages(
  targetDir: string,
  bridge: UltramodernBridgeConfig | undefined,
  packageSource: ResolvedPackageSource,
  primaryShell: WorkspaceApp,
) {
  const pnpmWorkspacePath = `${targetDir}/pnpm-workspace.yaml`;
  const pnpmWorkspace = fs.readFileSync(pnpmWorkspacePath, 'utf-8');
  const packages = [
    'apps/*',
    'verticals/*',
    'packages/*',
    ...(bridge?.workspacePackages.map(entry => entry.pattern) ?? []),
  ];
  const renderedPackages = packages.map(pattern => `  - ${pattern}`).join('\n');

  writeFileReplacing(
    targetDir,
    'pnpm-workspace.yaml',
    `${renderCatalogPolicy(packageSource, primaryShell)}${pnpmWorkspace.replace(
      /^packages:\r?\n(?: {2}- .+\r?\n)+/u,
      `packages:\n${renderedPackages}\n`,
    )}`,
  );
}

export async function generateUltramodernWorkspace(
  options: UltramodernWorkspaceOptions,
): Promise<UltramodernGenerationResult> {
  return runFreshWorkspaceTransaction(options.targetDir, stagingRoot =>
    generateUltramodernWorkspaceInPlace(
      {
        ...options,
        targetDir: stagingRoot,
      },
      options.targetDir,
    ),
  );
}

async function generateUltramodernWorkspaceInPlace(
  options: UltramodernWorkspaceOptions,
  logicalWorkspaceRoot = options.targetDir,
): Promise<UltramodernGenerationResult> {
  const beforeFiles = createFileSnapshot(options.targetDir);
  const scope = toPackageScope(options.packageName);
  let packageSource: ResolvedPackageSource;
  if (isCreatePackageSourceCheckout()) {
    if (hasExplicitInstallRequest(options)) {
      throw new Error(
        'A local @modern-js/ultramodern-create source checkout cannot satisfy an explicit install package source. Use workspace mode locally or run the packed published package.',
      );
    }
    // A source checkout has no shipped release identity. Do this before any
    // projection lookup so an untracked asset cannot authorize registry policy.
    packageSource = resolvePackageSource({
      ...options,
      packageSource: { strategy: 'workspace' },
    });
  } else {
    packageSource = resolvePackageSource(options);
  }
  const bridge = normalizeUltramodernBridgeConfig(options.bridge);
  const renderer = options.renderer ?? 'react';
  if (!isApplicationRenderer(renderer))
    throw new Error(`Unsupported renderer ${String(renderer)}.`);
  const generation = getRendererGenerationProfile(renderer);
  if (renderer !== 'react' && bridge)
    throw new Error(
      `Renderer ${renderer} does not support React bridge configuration.`,
    );
  const enableTailwind = options.enableTailwind !== false;
  const initialVerticals: WorkspaceApp[] = [];
  const initialShell = initializeGeneratedRendererIdentity(scope, {
    ...createShellHost(initialVerticals),
    renderer,
    rendererProfile: generation.profile,
    rendererGenerationProfile: generation,
  });
  const createdApps = [initialShell, ...initialVerticals];
  assertUniqueTailwindPrefixes(createdApps);
  fs.mkdirSync(options.targetDir, { recursive: true });

  const workspacePackageLinkingPolicy =
    resolveWorkspacePackageLinkingPolicy(packageSource);

  const excludedRootTemplates = new Set([
    'scripts/setup-agent-reference-repos.mjs',
  ]);
  if (options.generateAgentFiles === false) {
    excludedRootTemplates.add('AGENTS.md.handlebars');
    excludedRootTemplates.add('CLAUDE.md.handlebars');
  }

  copyRootTemplate(
    options.targetDir,
    {
      packageName: options.packageName,
      packageScope: scope,
      nodeVersion: NODE_VERSION,
      pnpmVersion: PNPM_VERSION,
      dependencyOverridesYaml: `overrides:\n${Object.entries(
        ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides,
      )
        .map(
          ([selector, specifier]) =>
            `  ${JSON.stringify(selector)}: ${JSON.stringify(specifier)}`,
        )
        .join('\n')}\n\n`,
      compilerTrustExceptionsYaml: `trustPolicyExclude: ${JSON.stringify(ULTRAMODERN_WORKSPACE_POLICY.pnpm.trustPolicyExclude)}\n`,
      effectVersion: EFFECT_VERSION,
      i18nextVersion: I18NEXT_VERSION,
      workspacePackageLinkingYaml: Object.entries(workspacePackageLinkingPolicy)
        .map(([key, value]) => `${key}: ${String(value)}\n`)
        .join(''),
      tailwindEnabled: String(enableTailwind),
    },
    excludedRootTemplates,
  );
  writePnpmWorkspacePackages(
    options.targetDir,
    bridge,
    packageSource,
    initialShell,
  );

  writeJson(
    options.targetDir,
    'package.json',
    createRootPackageJson(
      scope,
      packageSource,
      initialVerticals,
      bridge,
      [],
      initialShell,
    ),
  );
  writeJson(
    options.targetDir,
    'ultramodern.compiler-trust.json',
    ULTRAMODERN_WORKSPACE_POLICY.pnpm.trustPolicyExclude,
  );
  // Zerops materialization is a delivery-unit capability. Fresh workspaces
  // start with the shell alone; add-vertical writes the manifest together
  // with the materializer and its package scripts when the first deployable
  // vertical is added.
  if (initialVerticals.length > 0) {
    writeFile(
      options.targetDir,
      'zerops.yaml',
      `${createZeropsYaml(scope, createdApps)}\n`,
    );
  }
  writeJson(options.targetDir, 'tsconfig.base.json', createTsConfigBase());
  writeJson(
    options.targetDir,
    'tsconfig.json',
    createRootTsConfig(createdApps),
  );
  writeJson(
    options.targetDir,
    'topology/reference-topology.json',
    createTopology(scope, initialVerticals, initialShell, 'source-authoring'),
  );
  writeJson(
    options.targetDir,
    'topology/ownership.json',
    createOwnership(scope, initialVerticals),
  );
  writeJson(
    options.targetDir,
    'topology/local-overlays/development.json',
    createDevelopmentOverlay(scope, initialVerticals),
  );
  writeApp(
    options.targetDir,
    scope,
    initialShell,
    packageSource,
    enableTailwind,
    initialVerticals,
    bridge,
  );
  for (const remote of initialVerticals) {
    writeApp(
      options.targetDir,
      scope,
      remote,
      packageSource,
      enableTailwind,
      initialVerticals,
      bridge,
    );
  }
  writeSharedPackages(options.targetDir, scope, packageSource, initialShell);
  writeGeneratedWorkspaceScripts(options.targetDir, { renderer });

  const preliminaryAfterFiles = createFileSnapshot(options.targetDir);
  const preliminaryDiff = diffFileSnapshots(beforeFiles, preliminaryAfterFiles);
  const preliminaryResult = createGenerationResult({
    phase: 'source-authoring',
    operation: 'workspace',
    workspaceRoot: logicalWorkspaceRoot,
    packageScope: scope,
    packageSource,
    createdApps,
    createdPaths: preliminaryDiff.createdPaths,
    rewrittenPaths: preliminaryDiff.rewrittenPaths,
  });
  const deferredUiArtifactPaths = new Set(
    createdApps
      .filter(appEmitsBrowserUi)
      .map(app => `${app.directory}/shared/ultramodern-build.json`),
  );
  runCodeSmithOverlays({
    workspaceRoot: options.targetDir,
    deferredUiArtifactPaths,
    overlays: options.overlays,
    result: preliminaryResult,
  });
  formatGeneratedWorkspaceFiles(options.targetDir);

  const evaluations = await captureWorkspaceRendererEvaluations(
    options.targetDir,
    createdApps,
    { command: 'generate' },
  );
  const reconciledApps = await reconcileWorkspaceRendererIdentities(
    options.targetDir,
    scope,
    createdApps,
    { command: 'generate', evaluations },
  );
  const reconciledShell = reconciledApps[0]!;
  if (reconciledShell.renderer !== renderer) {
    throw new Error(
      `Generated application renderer ${renderer} disagrees with the renderer resolved from modern.config (${reconciledShell.renderer}).`,
    );
  }
  writeFileReplacing(
    options.targetDir,
    'topology/reference-topology.json',
    `${JSON.stringify(createTopology(scope, initialVerticals, reconciledShell), null, 2)}\n`,
  );
  for (const app of reconciledApps) {
    const artifactPath = `${app.directory}/shared/ultramodern-build.json`;
    (deferredUiArtifactPaths.has(artifactPath)
      ? writeFile
      : writeFileReplacing)(
      options.targetDir,
      artifactPath,
      createUltramodernBuildArtifactJson(scope, app),
    );
  }
  validateWorkspace(
    options.targetDir,
    createWorkspaceValidationContract(
      scope,
      enableTailwind,
      sharedPackages.map(sharedPackage => ({
        id: sharedPackage.id,
        path: sharedPackage.directory,
        package: packageName(scope, sharedPackage.id),
      })),
      initialVerticals,
      [],
      reconciledShell,
    ),
  );

  const afterFiles = createFileSnapshot(options.targetDir);
  const { createdPaths, rewrittenPaths } = diffFileSnapshots(
    beforeFiles,
    afterFiles,
  );

  return createGenerationResult({
    operation: 'workspace',
    workspaceRoot: logicalWorkspaceRoot,
    packageScope: scope,
    packageSource,
    createdApps: reconciledApps,
    createdPaths,
    rewrittenPaths,
  });
}
