import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isNumericLiteral,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isWhileStatement,
  type Node,
  NodeFlags,
  SyntaxKind,
} from 'tsrs/ast';
import { type Checker, type Type, TypeFlags } from 'tsrs/sync';
import type { SemanticContext } from './context';

const membershipMethods = new Set(['includes', 'indexOf', 'lastIndexOf']);
const iterationMethods = new Set(['some', 'map', 'every', 'filter', 'forEach']);

function unparenthesize(expression: Expression): Expression {
  while (isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function isArray(type: Type, checker: Checker): boolean {
  if (type.isUnionType()) {
    return type.getTypes().every(part => isArray(part, checker));
  }
  return (
    !type.isErrorType() &&
    (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) === 0 &&
    (checker.isArrayType(type) || checker.isTupleType(type))
  );
}

/** Require the actual library member, not just an array-shaped receiver. */
function isBuiltinArrayCall(
  call: CallExpression,
  context: SemanticContext,
): boolean {
  const { checker, program } = context;
  const access = call.expression;
  if (
    !isPropertyAccessExpression(access) ||
    access.questionDotToken ||
    call.questionDotToken ||
    !isArray(checker.getTypeAtLocation(access.expression), checker)
  ) {
    return false;
  }
  const member = checker.getSymbolAtLocation(access.name);
  return (
    member !== undefined &&
    member.declarations.length > 0 &&
    member.declarations.every(handle => {
      const declaration = handle.resolve();
      return (
        declaration !== undefined &&
        program.isSourceFileDefaultLibrary(declaration.getSourceFile()) &&
        isInterfaceDeclaration(declaration.parent) &&
        ['Array', 'ReadonlyArray'].includes(declaration.parent.name.text)
      );
    })
  );
}

function contains(outer: Node, inner: Node): boolean {
  return outer.pos <= inner.pos && inner.end <= outer.end;
}

/** Do not attribute a deferred function's body to its enclosing lexical loop. */
function repeatedRegions(
  call: CallExpression,
  context: SemanticContext,
): Node[] {
  const regions: Node[] = [];
  let child: Node = call;
  for (let parent = child.parent; parent; parent = parent.parent) {
    if (isFunctionLikeDeclaration(parent)) {
      if (!isArrowFunction(parent) && !isFunctionExpression(parent)) {
        break;
      }
      let callback: Node = parent;
      while (isParenthesizedExpression(callback.parent)) {
        callback = callback.parent;
      }
      const invocation = callback.parent;
      if (
        !isCallExpression(invocation) ||
        invocation.arguments[0] !== callback ||
        !isPropertyAccessExpression(invocation.expression) ||
        !iterationMethods.has(invocation.expression.name.text) ||
        !isBuiltinArrayCall(invocation, context)
      ) {
        break;
      }
      regions.push(invocation);
    } else if (
      isWhileStatement(parent) ||
      isDoStatement(parent) ||
      (isForStatement(parent) && child !== parent.initializer) ||
      ((isForOfStatement(parent) || isForInStatement(parent)) &&
        child === parent.statement)
    ) {
      regions.push(parent);
    }
    child = parent;
  }
  return regions;
}

function numericValue(node: Expression): number | undefined {
  node = unparenthesize(node);
  if (isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (
    isPrefixUnaryExpression(node) &&
    node.operator === SyntaxKind.MinusToken &&
    isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return undefined;
}

/** An index is not a boolean; accept only comparisons that mean membership. */
function isMembershipComparison(call: CallExpression): boolean {
  let operand: Node = call;
  while (isParenthesizedExpression(operand.parent)) {
    operand = operand.parent;
  }
  const parent = operand.parent;
  if (!isBinaryExpression(parent)) {
    return false;
  }
  const onLeft = parent.left === operand;
  const value = numericValue(onLeft ? parent.right : parent.left);
  const operator = parent.operatorToken.kind;
  if (value === -1) {
    return (
      operator === SyntaxKind.EqualsEqualsEqualsToken ||
      operator === SyntaxKind.ExclamationEqualsEqualsToken ||
      (onLeft
        ? operator === SyntaxKind.GreaterThanToken
        : operator === SyntaxKind.LessThanToken)
    );
  }
  return (
    value === 0 &&
    (onLeft
      ? operator === SyntaxKind.GreaterThanEqualsToken ||
        operator === SyntaxKind.LessThanToken
      : operator === SyntaxKind.LessThanEqualsToken ||
        operator === SyntaxKind.GreaterThanToken)
  );
}

/**
 * Without an interprocedural effect proof, only direct library membership
 * reads may use this binding. Aliasing, writes and escapes invalidate it.
 */
function hasOnlyMembershipReads(
  declaration: Node,
  name: Identifier,
  context: SemanticContext,
): boolean {
  const symbol = context.checker.getSymbolAtLocation(name);
  let safe = symbol !== undefined;
  function visit(node: Node): void {
    if (!safe) {
      return;
    }
    // A shorthand's property symbol is not the value binding it exports.
    if (
      isShorthandPropertyAssignment(node) &&
      isIdentifier(node.name) &&
      node.name.text === name.text &&
      context.checker.getShorthandAssignmentValueSymbol(node) === symbol
    ) {
      safe = false;
      return;
    }
    if (
      isIdentifier(node) &&
      node.text === name.text &&
      node !== name &&
      context.checker.getSymbolAtLocation(node) === symbol
    ) {
      const access = node.parent;
      const call = access.parent;
      if (
        !isPropertyAccessExpression(access) ||
        access.expression !== node ||
        !membershipMethods.has(access.name.text) ||
        !isCallExpression(call) ||
        call.expression !== access ||
        !isBuiltinArrayCall(call, context)
      ) {
        safe = false;
        return;
      }
    }
    node.forEachChild(visit);
  }
  // Include closures and uses before/after the loop, not only its body.
  visit(declaration.getSourceFile());
  return safe;
}

/**
 * This is manual advice, not a mutation/alias proof across function boundaries.
 * Parameters and produced arrays may have external aliases; users must verify
 * their stability before hoisting a Set. Local writes/escapes suppress advice.
 */
export function checkArrayMembership(context: SemanticContext): void {
  function visit(node: Node): void {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      membershipMethods.has(node.expression.name.text) &&
      node.arguments.length === 1 &&
      !isSpreadElement(node.arguments[0]) &&
      isBuiltinArrayCall(node, context)
    ) {
      const receiver = unparenthesize(node.expression.expression);
      if (isIdentifier(receiver)) {
        const symbol = context.checker.getSymbolAtLocation(receiver);
        const declaration = symbol?.valueDeclaration?.resolve();
        if (
          !declaration ||
          (!isParameterDeclaration(declaration) &&
            !isVariableDeclaration(declaration)) ||
          !isIdentifier(declaration.name)
        ) {
          node.forEachChild(visit);
          return;
        }
        const reusable =
          (isParameterDeclaration(declaration) ||
            (declaration.initializer !== undefined &&
              (declaration.parent.flags & NodeFlags.Const) !== 0)) &&
          repeatedRegions(node, context).some(
            region =>
              !contains(region, declaration) && declaration.end <= region.pos,
          );
        const indexSemantics =
          node.expression.name.text === 'includes' ||
          (isMembershipComparison(node) &&
            // indexOf skips holes and cannot find NaN. Restrict its query to
            // known non-numeric, non-undefined values before suggesting Set.
            (context.checker.getTypeAtLocation(node.arguments[0]).flags &
              (TypeFlags.StringLike |
                TypeFlags.BooleanLike |
                TypeFlags.BigIntLike)) !==
              0);
        if (
          reusable &&
          indexSemantics &&
          hasOnlyMembershipReads(declaration, declaration.name, context)
        ) {
          context.report(
            node,
            'repeated-array-membership',
            'This built-in array membership scan repeats in a loop over a reusable array. If the array and all its aliases remain unchanged for the entire loop, consider manually building one Set before the loop and using Set.has for these membership checks. Verify external aliases and producer behavior; their immutability is not proven. Do not construct a fresh Set on each iteration.',
          );
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(context.sourceFile);
}
