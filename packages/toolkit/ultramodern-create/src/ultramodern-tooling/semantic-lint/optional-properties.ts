import {
  isParenthesizedTypeNode,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isUnionTypeNode,
  type Node,
  SyntaxKind,
  type TypeNode,
} from 'tsrs/ast';
import { type Type, TypeFlags } from 'tsrs/sync';
import type { SemanticContext } from './context';

function unionConstituents(node: TypeNode): TypeNode[] {
  if (isParenthesizedTypeNode(node)) {
    return unionConstituents(node.type);
  }
  return isUnionTypeNode(node) ? node.types.flatMap(unionConstituents) : [node];
}

function includesUndefined(type: Type, undefinedId: number): boolean {
  if (type.isErrorType()) {
    return false;
  }
  if (
    type.id === undefinedId ||
    (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0
  ) {
    return true;
  }
  return (
    type.isUnionType() &&
    type.getTypes().some(member => includesUndefined(member, undefinedId))
  );
}

export function checkOptionalProperties(context: SemanticContext): void {
  const { checker, compilerOptions, report, sourceFile } = context;
  const strictNullChecks =
    compilerOptions.strictNullChecks ?? compilerOptions.strict ?? false;
  const exact = strictNullChecks && compilerOptions.exactOptionalPropertyTypes;
  const undefinedId = checker.getUndefinedType().id;

  function visit(node: Node): void {
    if (
      (isPropertySignatureDeclaration(node) || isPropertyDeclaration(node)) &&
      node.postfixToken?.kind === SyntaxKind.QuestionToken &&
      node.type
    ) {
      const constituents = unionConstituents(node.type);
      const writtenUndefined = constituents.filter(
        member => member.kind === SyntaxKind.UndefinedKeyword,
      );
      if (constituents.length > 1 && writtenUndefined.length > 0) {
        const remaining = constituents.filter(
          member => member.kind !== SyntaxKind.UndefinedKeyword,
        );
        const types = remaining.map(member =>
          checker.getTypeFromTypeNode(member),
        );
        if (!types.some(type => type.isErrorType())) {
          // Keep one written undefined unless the other constituents or the
          // compiler's inexact optional semantics already provide it.
          const redundant =
            remaining.length > 0 &&
            (!exact || types.some(type => includesUndefined(type, undefinedId)))
              ? writtenUndefined
              : writtenUndefined.slice(1);
          for (const member of redundant) {
            report(
              member,
              'redundant-optional-undefined',
              'Remove this redundant undefined union constituent; keep the optional property marker.',
            );
          }
        }
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
}
