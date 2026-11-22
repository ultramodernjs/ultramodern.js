import type { Node, SourceFile } from 'tsrs/ast';
import type { Checker, CompilerOptions, Program } from 'tsrs/sync';

export type SemanticRule =
  | 'redundant-optional-undefined'
  | 'missing-return-value'
  | 'repeated-array-membership';

export interface SemanticDiagnostic {
  readonly rule: SemanticRule;
  readonly file: string;
  readonly start: number;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface SemanticContext {
  readonly sourceFile: SourceFile;
  readonly program: Program;
  readonly checker: Checker;
  readonly compilerOptions: CompilerOptions;
  readonly report: (node: Node, rule: SemanticRule, message: string) => void;
}
