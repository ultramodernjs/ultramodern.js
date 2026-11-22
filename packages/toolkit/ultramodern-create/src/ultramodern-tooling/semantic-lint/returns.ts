import { getTokenAtPosition, ScriptKind } from 'tsrs/ast';
import type { SemanticContext } from './context';

const returnDiagnosticCodes = new Set([7030, 2366, 2355]);

export function checkReturnValues(context: SemanticContext): void {
  const { program, sourceFile, report } = context;
  if (program.getCompilerOptions().noCheck === true) {
    throw new Error(
      `Semantic lint requires noCheck to be disabled in the configured project for ${sourceFile.fileName}`,
    );
  }
  if (program.getCompilerOptions().noImplicitReturns !== true) {
    throw new Error(
      `Semantic lint requires noImplicitReturns: true in the configured project for ${sourceFile.fileName}`,
    );
  }
  if (
    (sourceFile.scriptKind === ScriptKind.JS ||
      sourceFile.scriptKind === ScriptKind.JSX) &&
    program.getCompilerOptions().checkJs !== true
  ) {
    throw new Error(
      `Semantic lint requires checkJs: true in the configured project for ${sourceFile.fileName}`,
    );
  }

  for (const diagnostic of program.getSemanticDiagnostics(
    sourceFile.fileName,
  )) {
    if (returnDiagnosticCodes.has(diagnostic.code)) {
      report(
        getTokenAtPosition(sourceFile, diagnostic.pos),
        'missing-return-value',
        `TS${diagnostic.code}: ${diagnostic.text}`,
      );
    }
  }
}
