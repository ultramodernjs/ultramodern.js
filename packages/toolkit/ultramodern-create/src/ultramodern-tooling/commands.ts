import fs from 'node:fs';
import path from 'node:path';
import { GENERATED_TOOLING_COMMANDS } from '../ultramodern-workspace/tooling-command-catalog';
import { runCloudflareOutputVerify } from './commands/cloudflare-output-verify';
import {
  AD_HOC_TOOLING_COMMANDS,
  printHelp,
  runTemplateBackedToolingCommand,
} from './commands/context';
import { runMfTypes } from './commands/mf-types';
import { runRoutesGenerate } from './commands/routes-generate';
import { runSemanticLint } from './commands/semantic-lint';
import { runSkills } from './commands/skills';
import { runSyncDeliveryUnit } from './commands/sync-delivery-unit';
import { runValidate } from './commands/validate';

export async function runUltramodernToolingCli(
  args: string[],
  workspaceRoot = process.env.ULTRAMODERN_WORKSPACE_ROOT ?? process.cwd(),
): Promise<number> {
  try {
    const [command, ...rest] = args;
    let discoveredRoot = path.resolve(workspaceRoot);
    for (
      let candidate = discoveredRoot;
      ;
      candidate = path.dirname(candidate)
    ) {
      if (
        fs.existsSync(path.join(candidate, 'topology/reference-topology.json'))
      ) {
        discoveredRoot = candidate;
        break;
      }
      if (path.dirname(candidate) === candidate) break;
    }
    const context = {
      workspaceRoot: discoveredRoot,
      invocationCwd: process.cwd(),
    };

    switch (command) {
      case undefined:
      case '--help':
      case '-h':
        printHelp();
        return 0;
      case GENERATED_TOOLING_COMMANDS.validate.command:
        return runValidate(context);
      case GENERATED_TOOLING_COMMANDS.mfTypes.command:
        return runMfTypes(rest, context);
      case GENERATED_TOOLING_COMMANDS.cloudflareOutputVerify.command:
        return await runCloudflareOutputVerify(rest, context);
      case GENERATED_TOOLING_COMMANDS.routesGenerate.command:
        return await runRoutesGenerate(rest, context);
      case AD_HOC_TOOLING_COMMANDS.syncDeliveryUnit:
        return runSyncDeliveryUnit(rest, context);
      case AD_HOC_TOOLING_COMMANDS.skills:
        return runSkills(rest, context);
      case AD_HOC_TOOLING_COMMANDS.semanticLint:
        return runSemanticLint(rest, context);
      default:
        {
          const templateBackedStatus = runTemplateBackedToolingCommand(
            command ?? '',
            rest,
            context,
          );
          if (templateBackedStatus !== undefined) {
            return templateBackedStatus;
          }
        }
        throw new Error(`Unknown UltraModern command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ultramodern] ${message}\n`);
    return 1;
  }
}
