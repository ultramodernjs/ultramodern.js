import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCreatePackageRoot } from '../../create-package-root';
import {
  generatedToolingCommandList,
  generatedToolingCommands,
} from '../../ultramodern-workspace/tooling-command-catalog';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const createPackageRoot = resolveCreatePackageRoot(__dirname);

export type CommandContext = {
  workspaceRoot: string;
  invocationCwd: string;
};

// These CLI commands do not share the generated-wrapper contract.
export const AD_HOC_TOOLING_COMMANDS = {
  syncDeliveryUnit: 'sync-delivery-unit',
  skills: 'skills',
  semanticLint: 'semantic-lint',
} as const;

export function printHelp() {
  const commands = [
    ...generatedToolingCommandList().map(command => `  ${command}`),
    `  ${AD_HOC_TOOLING_COMMANDS.syncDeliveryUnit}`,
    `  ${AD_HOC_TOOLING_COMMANDS.skills} install`,
    `  ${AD_HOC_TOOLING_COMMANDS.skills} check`,
    `  ${AD_HOC_TOOLING_COMMANDS.semanticLint} [--json] <source paths...>`,
  ].join('\n');

  process.stdout.write(`Usage:
  ultramodern-create ultramodern <command> [args]

Commands:
${commands}
`);
}

export function spawnNodeScript(
  relativeScriptPath: string,
  args: string[],
  context: CommandContext,
  options: { cwd?: string } = {},
) {
  const scriptPath = path.join(createPackageRoot, relativeScriptPath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd ?? context.workspaceRoot,
    env: {
      ...process.env,
      ULTRAMODERN_WORKSPACE_ROOT: context.workspaceRoot,
    },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  return (
    result.status ??
    (result.signal ? 128 + osConstants.signals[result.signal] : 1)
  );
}

export function runTemplateBackedToolingCommand(
  command: string,
  args: string[],
  context: CommandContext,
) {
  const toolingCommand = generatedToolingCommands.find(
    candidate => candidate.command === command,
  );
  if (!toolingCommand?.templatePath) {
    return undefined;
  }

  return spawnNodeScript(toolingCommand.templatePath, args, context, {
    cwd:
      toolingCommand.cwd === 'invocation'
        ? context.invocationCwd
        : context.workspaceRoot,
  });
}
