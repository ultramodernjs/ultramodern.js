import {
  appEmitsBrowserUi,
  appHasApi,
  sharedPackages,
  shellApp,
} from './descriptors';
import { relativeRootFor } from './naming';
import { createPublicSurfaceGenerationCommand } from './public-surface';
import { hasNativeAppGeneration } from './renderer-generations';
import {
  resolveAppGenerationProfile,
  resolveWorkspaceRenderer,
} from './renderer-profile';
import {
  GENERATED_TOOLING_COMMANDS,
  type GeneratedToolingCommandKey,
} from './tooling-command-catalog';
import type { WorkspaceApp } from './types';

export const GENERATED_POSTINSTALL_SCRIPT =
  'ultramodern-create ultramodern compiler-prepare && ultramodern-create ultramodern skills install --postinstall';

// Recognize only flat && chains with quoted or escaped arguments. A caller
// must reconstruct the entire command before treating these matches as owned.
// Substitutions, comments, pipelines and redirections remain opaque shell code.
export const WORKSPACE_SCRIPT_SEGMENT_PATTERN =
  /(?:'[^']*'|"(?:\\[^\r\n]|[^"\\`$]|\$(?![(']))*"|\\[^\r\n]|[^"'\\`&|;()<>\r\n^#$]|\$(?![('"]))+/gu;

const toolingCommand = (key: GeneratedToolingCommandKey) =>
  `ultramodern-create ultramodern ${GENERATED_TOOLING_COMMANDS[key].command}`;

const rootToolingScriptName = (key: GeneratedToolingCommandKey) => {
  const rootScript = GENERATED_TOOLING_COMMANDS[key].rootScript;
  if (!rootScript) {
    throw new Error(
      `Generated tooling command ${key} does not define a root package script.`,
    );
  }
  return rootScript;
};

const rootToolingWrapperCommand = toolingCommand;
const packageToolingWrapperCommand = (
  _packageDir: string,
  key: GeneratedToolingCommandKey,
) => toolingCommand(key);

export interface WorkspaceRootScriptPlan {
  build: string;
  cloudflareBuild: string;
  cloudflareDeploy: string;
  cloudflareProof: string;
  cloudflareSsrProof: string;
  cloudflareOutputVerify: string;
  backendFederationGenerate: string;
  nodeProof: string;
  mfTypes: string;
  performanceReadiness: string;
  zeropsMaterialize: string;
  contractCheck: string;
  typecheck: string;
  check: string;
}

const workspaceRootPackageScriptNames = {
  build: 'build',
  cloudflareBuild: 'cloudflare:build',
  cloudflareDeploy: 'cloudflare:deploy',
  cloudflareProof: rootToolingScriptName('cloudflareProof'),
  cloudflareSsrProof: rootToolingScriptName('cloudflareSsrProof'),
  cloudflareOutputVerify: rootToolingScriptName('cloudflareOutputVerify'),
  backendFederationGenerate: rootToolingScriptName('backendFederationGenerate'),
  nodeProof: rootToolingScriptName('backendFederationProof'),
  mfTypes: rootToolingScriptName('mfTypes'),
  performanceReadiness: rootToolingScriptName('performanceReadiness'),
  zeropsMaterialize: rootToolingScriptName('zeropsMaterialize'),
  contractCheck: rootToolingScriptName('validate'),
  typecheck: 'typecheck',
  check: 'check',
} as const satisfies Record<keyof WorkspaceRootScriptPlan, string>;

type WorkspaceRootPackageScriptName =
  (typeof workspaceRootPackageScriptNames)[keyof typeof workspaceRootPackageScriptNames];

type WorkspaceRootPackageScripts = Partial<
  Record<WorkspaceRootPackageScriptName, string>
>;

const shellOnlyOmittedRootScriptPlanKeys = new Set<
  keyof WorkspaceRootScriptPlan
>(['cloudflareSsrProof', 'zeropsMaterialize']);
// Backend-federation scripts require an API surface — omitted independently
// of the shell-only gate (split gating; ALL units deploy via Zerops).
const backendSurfaceOmittedRootScriptPlanKeys = new Set<
  keyof WorkspaceRootScriptPlan
>(['backendFederationGenerate', 'nodeProof']);

interface WorkspaceAppScriptPlan {
  dev: string;
  build: string;
  cloudflareBuild: string;
  cloudflareDeploy: string;
  cloudflarePreview: string;
  cloudflareProof: string;
  serve: string;
  typecheck: string;
}

const workspaceAppPackageScriptNames = {
  dev: 'dev',
  build: 'build',
  cloudflareBuild: 'cloudflare:build',
  cloudflareDeploy: 'cloudflare:deploy',
  cloudflarePreview: 'cloudflare:preview',
  cloudflareProof: 'cloudflare:proof',
  serve: 'serve',
  typecheck: 'typecheck',
} as const satisfies Record<keyof WorkspaceAppScriptPlan, string>;

type WorkspaceAppPackageScriptName =
  (typeof workspaceAppPackageScriptNames)[keyof typeof workspaceAppPackageScriptNames];

type WorkspaceAppPackageScripts = Record<WorkspaceAppPackageScriptName, string>;

export const createStrictTsgoTypecheckCommand = (packageDir: string) =>
  `${packageToolingWrapperCommand(packageDir, 'typecheck')} --project tsconfig.json`;

// The app config imports the route metadata manifest, so it is regenerated
// before Modern.js loads that config. Manifest-only generation never loads the
// config, so it cannot run the app in another command or NODE_ENV first.
// Headless apps have no route metadata.
const createRoutesGenerateCommand = (app: WorkspaceApp) =>
  appEmitsBrowserUi(app)
    ? `pnpm --dir ${relativeRootFor(app.directory)} exec ${toolingCommand(
        'routesGenerate',
      )} --app ${app.id} --manifest-only`
    : undefined;

function createWorkspaceAppScriptPlan(
  app: WorkspaceApp,
): WorkspaceAppScriptPlan {
  const routesGenerate = createRoutesGenerateCommand(app);
  // Deploy targets are CLI flags, not env wrappers: cross-env reports a build
  // that died from a signal (a native stack overflow) as a plain exit 1.
  const buildSteps = [
    routesGenerate,
    'ultramodern build --deploy-target node',
    createPublicSurfaceGenerationCommand(app, 'dist'),
    'ultramodern deploy --skip-build --deploy-target node',
    // NOTE: the Module Federation DTS archive is emitted by `ultramodern build`
    // above; verifying it (assert-mf-types) is done ONCE at the workspace root
    // (`pnpm mf:types`) AFTER every app has built. A per-app verify here races
    // under parallel `pnpm -r build` — an early app would assert a sibling's
    // not-yet-emitted archive — so it is intentionally omitted.
  ].filter((step): step is string => Boolean(step));
  const cloudflareOutputVerify = `${packageToolingWrapperCommand(
    app.directory,
    'cloudflareOutputVerify',
  )} --app ${app.id}`;
  const cloudflareBuildSteps = (requirePublicUrls: boolean) =>
    [
      routesGenerate,
      'ultramodern build --deploy-target cloudflare',
      createPublicSurfaceGenerationCommand(
        app,
        'cloudflare-dist',
        requirePublicUrls,
      ),
      'ultramodern deploy --skip-build --deploy-target cloudflare',
      requirePublicUrls
        ? `${cloudflareOutputVerify} --require-public-urls`
        : cloudflareOutputVerify,
    ].filter((step): step is string => Boolean(step));

  return {
    dev: [routesGenerate, 'ultramodern dev']
      .filter((step): step is string => Boolean(step))
      .join(' && '),
    build: buildSteps.join(' && '),
    cloudflareBuild: cloudflareBuildSteps(false).join(' && '),
    cloudflareDeploy: [
      ...cloudflareBuildSteps(true),
      'wrangler deploy --config .output/wrangler.json',
    ].join(' && '),
    cloudflarePreview:
      'pnpm run cloudflare:build && wrangler dev --config .output/wrangler.json',
    cloudflareProof: `${packageToolingWrapperCommand(
      app.directory,
      'cloudflareProof',
    )} --app ${app.id}`,
    serve: 'ultramodern serve',
    typecheck: createStrictTsgoTypecheckCommand(app.directory),
  };
}

export function createWorkspaceAppPackageScripts(
  app: WorkspaceApp,
): Partial<WorkspaceAppPackageScripts> {
  const renderer = resolveWorkspaceRenderer(app);
  if (hasNativeAppGeneration(renderer)) {
    return {
      dev: 'ultramodern dev',
      build: 'ultramodern build',
      serve: 'ultramodern serve',
      ...(resolveAppGenerationProfile(app)?.capabilities.workers
        ? {
            'cloudflare:build':
              'ultramodern build --deploy-target cloudflare && ultramodern deploy --skip-build --deploy-target cloudflare',
            'cloudflare:deploy':
              'pnpm run cloudflare:build && wrangler deploy --config .output/wrangler.json',
            'cloudflare:preview': `pnpm run cloudflare:build && wrangler dev --port ${app.port} --config .output/wrangler.json`,
          }
        : {}),
      typecheck:
        resolveAppGenerationProfile(app)?.typecheckCommand ??
        createStrictTsgoTypecheckCommand(app.directory),
    };
  }
  const plan = createWorkspaceAppScriptPlan(app);

  return Object.fromEntries(
    Object.entries(workspaceAppPackageScriptNames).map(
      ([planKey, packageScriptName]) => [
        packageScriptName,
        plan[planKey as keyof WorkspaceAppScriptPlan],
      ],
    ),
  ) as WorkspaceAppPackageScripts;
}

function createReferencedRemoteDeclarationBuilds(remotes: WorkspaceApp[]) {
  const remotesById = new Map(remotes.map(remote => [remote.id, remote]));
  const referencedRemoteIds = new Set(
    remotes.flatMap(remote => remote.verticalRefs ?? []),
  );
  const orderedRemotes: WorkspaceApp[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (remote: WorkspaceApp) => {
    if (visited.has(remote.id) || visiting.has(remote.id)) {
      return;
    }
    visiting.add(remote.id);
    for (const dependencyId of remote.verticalRefs ?? []) {
      const dependency = remotesById.get(dependencyId);
      if (dependency !== undefined) {
        visit(dependency);
      }
    }
    visiting.delete(remote.id);
    visited.add(remote.id);
    orderedRemotes.push(remote);
  };

  for (const remote of remotes) {
    if (referencedRemoteIds.has(remote.id)) {
      visit(remote);
    }
  }

  return orderedRemotes
    .map(
      remote =>
        `${rootToolingWrapperCommand('typecheck')} --emit --project ${remote.directory}/tsconfig.json --skipLibCheck`,
    )
    .join(' && ');
}

export function createWorkspaceRootScriptPlan(
  remotes: WorkspaceApp[] = [],
  options: {
    bridgeCheck?: string;
    typecheck?: string;
    shells?: WorkspaceApp[];
  } = {},
): WorkspaceRootScriptPlan {
  const hasRemotes = remotes.length > 0;
  // Enumerate configured shells (G28) instead of hard-coding the single
  // ./apps/shell-super-app. The default is the primary shell alone, so a
  // single-shell workspace produces byte-identical default scripts.
  const shells =
    options.shells && options.shells.length > 0 ? options.shells : [shellApp];
  const shellBuild = shells
    .map(shell => `pnpm --filter "./${shell.directory}" run build`)
    .join(' && ');
  const shellCloudflareBuild = shells
    .map(shell => `pnpm --filter "./${shell.directory}" run cloudflare:build`)
    .join(' && ');
  const shellCloudflareDeploy = shells
    .map(shell => `pnpm --filter "./${shell.directory}" run cloudflare:deploy`)
    .join(' && ');
  const mfTypesScript = rootToolingScriptName('mfTypes');
  const performanceReadinessScript = rootToolingScriptName(
    'performanceReadiness',
  );
  const cloudflareOutputVerifyScript = rootToolingScriptName(
    'cloudflareOutputVerify',
  );
  const bridgeCheck = options.bridgeCheck ?? '';
  const sharedDeclarationsBuild = sharedPackages
    .map(
      sharedPackage =>
        `${rootToolingWrapperCommand('typecheck')} --build ${sharedPackage.directory}/tsconfig.json`,
    )
    .join(' && ');
  const referencedRemoteDeclarationsBuild =
    createReferencedRemoteDeclarationBuilds(remotes);
  const declarationBuild = [
    sharedDeclarationsBuild,
    referencedRemoteDeclarationsBuild,
  ]
    .filter(Boolean)
    .join(' && ');
  const buildPrefix = `${declarationBuild} && `;
  const remoteBuildPrefix = hasRemotes
    ? 'pnpm -r --filter "./verticals/*" run build && '
    : '';
  const remoteCloudflareBuildPrefix = hasRemotes
    ? 'pnpm -r --filter "./verticals/*" run cloudflare:build && '
    : '';
  const remoteCloudflareDeployPrefix = hasRemotes
    ? 'pnpm -r --filter "./verticals/*" run cloudflare:deploy && '
    : '';
  const cloudflareSsrProofSuffix = hasRemotes
    ? ' && pnpm cloudflare:ssr-proof'
    : '';

  return {
    build: `${buildPrefix}${remoteBuildPrefix}${shellBuild} && pnpm ${mfTypesScript} && pnpm ${performanceReadinessScript}`,
    cloudflareBuild: `${buildPrefix}${remoteCloudflareBuildPrefix}${shellCloudflareBuild} && pnpm ${mfTypesScript} --target cloudflare && pnpm ${cloudflareOutputVerifyScript}${cloudflareSsrProofSuffix}`,
    cloudflareDeploy: `${remoteCloudflareDeployPrefix}${shellCloudflareDeploy}`,
    cloudflareProof: `${rootToolingWrapperCommand(
      'cloudflareProof',
    )} --out .codex/reports/cloudflare-version-proof/public-url-proof.json`,
    cloudflareSsrProof: rootToolingWrapperCommand('cloudflareSsrProof'),
    cloudflareOutputVerify: rootToolingWrapperCommand('cloudflareOutputVerify'),
    backendFederationGenerate: rootToolingWrapperCommand(
      'backendFederationGenerate',
    ),
    nodeProof: rootToolingWrapperCommand('backendFederationProof'),
    mfTypes: rootToolingWrapperCommand('mfTypes'),
    performanceReadiness: rootToolingWrapperCommand('performanceReadiness'),
    zeropsMaterialize: rootToolingWrapperCommand('zeropsMaterialize'),
    contractCheck: rootToolingWrapperCommand('validate'),
    typecheck:
      options.typecheck ??
      `${rootToolingWrapperCommand('typecheck')} --build tsconfig.json`,
    // `check` is a static source/build gate. Runtime acceptance invokes the
    // read-only Node proof only after built servers are running.
    check: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm skills:check && pnpm i18n:boundaries && pnpm api:check:files && pnpm contract:check && pnpm performance:readiness${bridgeCheck}`,
  };
}

export function createWorkspaceRootPackageScripts(
  remotes: WorkspaceApp[] = [],
  options: {
    bridgeCheck?: string;
    typecheck?: string;
    shells?: WorkspaceApp[];
  } = {},
): WorkspaceRootPackageScripts {
  const plan = createWorkspaceRootScriptPlan(remotes, options);
  const shellOnly = remotes.length === 0;
  const hasBackendSurface = remotes.some(appHasApi);

  return Object.fromEntries(
    Object.entries(workspaceRootPackageScriptNames)
      .filter(
        ([planKey]) =>
          !(
            !hasBackendSurface &&
            backendSurfaceOmittedRootScriptPlanKeys.has(
              planKey as keyof WorkspaceRootScriptPlan,
            )
          ) &&
          !(
            shellOnly &&
            shellOnlyOmittedRootScriptPlanKeys.has(
              planKey as keyof WorkspaceRootScriptPlan,
            )
          ),
      )
      .map(([planKey, packageScriptName]) => [
        packageScriptName,
        plan[planKey as keyof WorkspaceRootScriptPlan],
      ]),
  ) as WorkspaceRootPackageScripts;
}
