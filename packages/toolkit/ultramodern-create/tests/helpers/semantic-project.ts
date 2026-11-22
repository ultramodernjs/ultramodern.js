import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API, type RawCompilerOptions } from 'tsrs/sync';
import type {
  SemanticContext,
  SemanticDiagnostic,
} from '../../src/ultramodern-tooling/semantic-lint/context';

export function withSemanticProject(
  source: string,
  check: (context: SemanticContext) => void,
  compilerOptions: RawCompilerOptions = {
    strict: true,
    exactOptionalPropertyTypes: true,
  },
): SemanticDiagnostic[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-semantic-'));
  const file = path.join(root, 'input.ts');
  fs.writeFileSync(file, source);
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'Preserve',
        moduleResolution: 'Bundler',
        noImplicitReturns: true,
        ...compilerOptions,
        types: [],
        noEmit: true,
      },
      files: ['input.ts'],
    }),
  );
  const api = new API({ cwd: root });
  try {
    const snapshot = api.createSnapshot({ openFiles: [file] });
    try {
      const project = snapshot.getDefaultProjectForFile(file);
      const sourceFile = project?.program.getSourceFile(file);
      if (!project?.configFileName || !sourceFile) {
        throw new Error('Semantic fixture did not load its configured project');
      }
      const diagnostics: SemanticDiagnostic[] = [];
      check({
        sourceFile,
        program: project.program,
        checker: project.checker,
        compilerOptions: project.program.getCompilerOptions(),
        report(node, rule, message) {
          const start = node.getStart(sourceFile);
          const { line, character } =
            sourceFile.getLineAndCharacterOfPosition(start);
          diagnostics.push({
            rule,
            file,
            start,
            line: line + 1,
            column: character + 1,
            message,
          });
        },
      });
      return diagnostics;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
