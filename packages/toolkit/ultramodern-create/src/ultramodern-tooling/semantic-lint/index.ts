import fs from 'node:fs';
import path from 'node:path';
import { API } from 'tsrs/sync';
import { checkArrayMembership } from './array-membership';
import type { SemanticDiagnostic } from './context';
import { checkOptionalProperties } from './optional-properties';
import { checkReturnValues } from './returns';

export type { SemanticDiagnostic, SemanticRule } from './context';

/**
 * These checks belong to the mandatory semantic pass, not the syntax bridge.
 * Pair this configuration with `ultramodern semantic-lint` in the lint script.
 */
export const semanticLintOxlintRules = {
  'sonarjs/no-redundant-optional': 'off',
  'sonarjs/no-inconsistent-returns': 'off',
  'react-doctor/js-set-map-lookups': 'off',
} as const;

export interface SemanticLintResult {
  readonly diagnostics: readonly SemanticDiagnostic[];
  readonly files: number;
  readonly projects: readonly string[];
}

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const outputDirectories = new Set([
  'node_modules',
  '.git',
  '.build',
  '.modern',
  '.modernjs',
  '.modern-js',
  '.output',
  '.mf',
  'dist',
  'dist-cloudflare',
  'coverage',
]);
const authoredDirectories = new Set(['src', 'tests', 'test', 'scripts']);

function collectInputs(root: string, inputs: readonly string[]): string[] {
  const files = new Set<string>();
  const directories = new Set<string>();
  function collect(file: string, authored: boolean, explicit: boolean) {
    const canonical = fs.realpathSync(file);
    const stat = fs.statSync(canonical);
    if (stat.isFile()) {
      if (sourceExtension.test(file)) {
        files.add(canonical);
      } else if (explicit) {
        throw new Error(`Semantic lint input is not authored source: ${file}`);
      }
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Unsupported semantic lint input: ${file}`);
    }
    if (directories.has(canonical)) {
      return;
    }
    directories.add(canonical);
    for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        (!authored && outputDirectories.has(entry.name))
      ) {
        continue;
      }
      collect(
        path.join(file, entry.name),
        authored || authoredDirectories.has(entry.name),
        false,
      );
    }
  }
  for (const input of inputs) {
    if (input.includes('*')) {
      for (const match of fs.globSync(input, { cwd: root })) {
        collect(path.resolve(root, match), false, true);
      }
    } else {
      collect(path.resolve(root, input), false, true);
    }
  }
  return [...files].sort();
}

/**
 * Run against the compiler's real configured projects. An orphan, malformed
 * configuration or compiler failure is an error, never an untyped clean result.
 */
export function lintSemanticWorkspace(
  root: string,
  inputs: readonly string[],
): SemanticLintResult {
  if (inputs.length === 0) {
    throw new Error('Semantic lint requires at least one source path');
  }
  const files = collectInputs(root, inputs);
  if (files.length === 0) {
    throw new Error('Semantic lint selected no source files');
  }
  const api = new API({ cwd: root });
  try {
    const snapshot = api.createSnapshot({ openFiles: files });
    try {
      const diagnostics: SemanticDiagnostic[] = [];
      const projects = new Set<string>();
      for (const file of files) {
        const project = snapshot.getDefaultProjectForFile(file);
        if (!project?.configFileName) {
          throw new Error(
            `Semantic lint has no configured project for ${path.relative(root, file)}. Include it in its owning tsconfig; inferred compiler options are not lint policy.`,
          );
        }
        if (!projects.has(project.configFileName)) {
          const configErrors = [
            ...project.program.getConfigFileParsingDiagnostics(),
            ...project.program.getProgramDiagnostics(),
          ];
          if (configErrors.length > 0) {
            throw new Error(
              `Invalid semantic lint project ${project.configFileName}: ${configErrors.map(error => error.text).join('; ')}`,
            );
          }
          projects.add(project.configFileName);
        }
        const sourceFile = project.program.getSourceFile(file);
        if (!sourceFile) {
          throw new Error(`Compiler did not load semantic lint input ${file}`);
        }
        const syntaxErrors = project.program.getSyntacticDiagnostics(file);
        if (syntaxErrors.length > 0) {
          throw new Error(
            `Invalid semantic lint input ${file}: ${syntaxErrors.map(error => error.text).join('; ')}`,
          );
        }
        const context = {
          sourceFile,
          program: project.program,
          checker: project.checker,
          compilerOptions: project.program.getCompilerOptions(),
          report(node, rule, message) {
            const start = node.getStart(sourceFile);
            const { line, character } =
              sourceFile.getLineAndCharacterOfPosition(start);
            diagnostics.push({
              file,
              rule,
              message,
              start,
              line: line + 1,
              column: character + 1,
            });
          },
        } satisfies import('./context').SemanticContext;
        checkOptionalProperties(context);
        checkReturnValues(context);
        checkArrayMembership(context);
      }
      diagnostics.sort(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.start - right.start ||
          left.rule.localeCompare(right.rule),
      );
      return {
        diagnostics,
        files: files.length,
        projects: [...projects].sort(),
      };
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
