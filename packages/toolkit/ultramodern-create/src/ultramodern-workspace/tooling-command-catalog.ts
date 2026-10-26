export type GeneratedToolingCommandId =
  | 'validate'
  | 'typecheck'
  | 'compilerPrepare'
  | 'mfTypes'
  | 'publicSurface'
  | 'backendFederationGenerate'
  | 'backendFederationProof'
  | 'cloudflareProof'
  | 'cloudflareOutputVerify'
  | 'performanceReadiness'
  | 'routesGenerate'
  | 'zeropsMaterialize'
  | 'cloudflareSsrProof';

export type GeneratedToolingCommandKey = GeneratedToolingCommandId;

interface GeneratedToolingCommand {
  id: GeneratedToolingCommandId;
  command: string;
  requiresBackendSurface?: boolean;
  requiresRemotes?: boolean;
  rootScript?: string;
  templatePath?: `templates/workspace-scripts/${string}.mjs`;
  cwd?: 'invocation';
}

const defineToolingCommand = (command: GeneratedToolingCommand) => command;

export const generatedToolingCommands = [
  defineToolingCommand({
    id: 'validate',
    command: 'validate',
    rootScript: 'contract:check',
  }),
  defineToolingCommand({
    id: 'typecheck',
    command: 'typecheck',
    rootScript: 'typecheck',
    templatePath: 'templates/workspace-scripts/ultramodern-typecheck.mjs',
    cwd: 'invocation',
  }),
  defineToolingCommand({
    id: 'compilerPrepare',
    command: 'compiler-prepare',
    templatePath:
      'templates/workspace-scripts/ultramodern-compiler-prepare.mjs',
  }),
  defineToolingCommand({
    id: 'mfTypes',
    command: 'mf-types',
    rootScript: 'mf:types',
  }),
  defineToolingCommand({
    id: 'publicSurface',
    command: 'public-surface',
    templatePath:
      'templates/workspace-scripts/generate-public-surface-assets.mjs',
  }),
  defineToolingCommand({
    id: 'backendFederationGenerate',
    requiresBackendSurface: true,
    command: 'backend-federation-generate',
    rootScript: 'node:backend-federation:generate',
    templatePath:
      'templates/workspace-scripts/generate-node-backend-federation.mjs',
  }),
  defineToolingCommand({
    id: 'backendFederationProof',
    requiresBackendSurface: true,
    command: 'backend-federation-proof',
    rootScript: 'node:proof',
    templatePath:
      'templates/workspace-scripts/proof-node-backend-federation.mjs',
  }),
  defineToolingCommand({
    id: 'cloudflareProof',
    command: 'cloudflare-proof',
    rootScript: 'cloudflare:proof',
    templatePath: 'templates/workspace-scripts/proof-cloudflare-version.mjs',
  }),
  defineToolingCommand({
    id: 'cloudflareOutputVerify',
    command: 'cloudflare-output-verify',
    rootScript: 'cloudflare-output:verify',
  }),
  defineToolingCommand({
    id: 'performanceReadiness',
    command: 'performance-readiness',
    rootScript: 'performance:readiness',
    templatePath:
      'templates/workspace-scripts/ultramodern-performance-readiness.mjs',
  }),
  defineToolingCommand({
    id: 'routesGenerate',
    command: 'routes-generate',
  }),
  defineToolingCommand({
    id: 'zeropsMaterialize',
    command: 'zerops-materialize',
    rootScript: 'zerops:materialize',
    requiresRemotes: true,
    templatePath: 'templates/workspace-scripts/materialize-zerops-runtime.mjs',
  }),
  defineToolingCommand({
    id: 'cloudflareSsrProof',
    command: 'cloudflare-ssr-proof',
    rootScript: 'cloudflare:ssr-proof',
    requiresRemotes: true,
    templatePath: 'templates/workspace-scripts/proof-workerd-ssr.mjs',
  }),
] as const satisfies readonly GeneratedToolingCommand[];

// An explicit backend-surface choice takes precedence over shell-only inference.
export function selectGeneratedToolingCommands(
  options: { shellOnly?: boolean; hasBackendSurface?: boolean } = {},
) {
  const backendSurface = options.hasBackendSurface ?? !options.shellOnly;
  return generatedToolingCommands.filter(
    command =>
      (!options.shellOnly || !command.requiresRemotes) &&
      (backendSurface || !command.requiresBackendSurface),
  );
}

const toolingCommandById = Object.fromEntries(
  generatedToolingCommands.map(command => [command.id, command]),
) as Record<GeneratedToolingCommandId, GeneratedToolingCommand>;

export const GENERATED_TOOLING_COMMANDS = toolingCommandById;

export const generatedToolingCommandList = () =>
  generatedToolingCommands.map(command => command.command);
