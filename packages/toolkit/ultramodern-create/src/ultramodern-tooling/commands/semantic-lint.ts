import path from 'node:path';
import { lintSemanticWorkspace } from '../semantic-lint';
import type { CommandContext } from './context';

export function runSemanticLint(
  args: string[],
  context: CommandContext,
): number {
  const json = args[0] === '--json';
  const inputs = json ? args.slice(1) : args;
  if (inputs.some(argument => argument.startsWith('-'))) {
    throw new Error('Usage: semantic-lint [--json] <source paths...>');
  }
  const result = lintSemanticWorkspace(context.invocationCwd, inputs);
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(
        `${path.relative(context.invocationCwd, diagnostic.file)}:${diagnostic.line}:${diagnostic.column} [ultramodern/${diagnostic.rule}] ${diagnostic.message}\n`,
      );
    }
    process.stdout.write(
      `Semantic lint checked ${result.files} files in ${result.projects.length} configured projects; ${result.diagnostics.length} findings.\n`,
    );
  }
  return result.diagnostics.length === 0 ? 0 : 1;
}
