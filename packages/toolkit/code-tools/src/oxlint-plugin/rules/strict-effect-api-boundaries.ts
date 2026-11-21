import {
  createEffectApiImportResolver,
  strictEffectRuntimeTopologyViolation,
} from '../../strict-effect-runtime.ts';
import {
  getNodeName,
  getSourceText,
  getStringLiteralValue,
  isApiEntryFile,
  isApiSourceFile,
  isForbiddenGeneratedEffectPath,
  isSharedApiContractFile,
  normalizeFilename,
  reportMissingProgramPattern,
  reportProgramPattern,
} from '../ast.ts';
import type { AstNode, Rule } from '../types.ts';

const unconstrainedSchemaMembers = new Set([
  'Any',
  'Unknown',
  'UnknownFromJsonString',
]);
const unconstrainedSchemaMessage =
  'API modules must use concrete request, response and error schemas; Schema.UnknownFromJsonString, Schema.Unknown and Schema.Any are forbidden in UltraModern API code.';

/**
 * Whether `object.member` reads an unconstrained schema in value space. Type
 * positions (`typeof Schema.Unknown.Type`) parse as `TSQualifiedName` and
 * never reach the member visitors.
 */
const unconstrainedSchemaMember = (
  object: AstNode | undefined,
  member: string | undefined,
): boolean =>
  (object?.type === 'Identifier' || object?.type === 'JSXIdentifier') &&
  object.name === 'Schema' &&
  member !== undefined &&
  unconstrainedSchemaMembers.has(member);

export const createStrictEffectApiBoundariesRule = (): Rule => ({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw HTTP handlers and non-Effect API runtime drift in UltraModern workspaces.',
    },
    schema: [],
  },
  create(context) {
    const filename = normalizeFilename(context.filename);
    const apiFile = isApiSourceFile(filename);
    const reportUnconstrained = (
      node: AstNode,
      object: AstNode | undefined,
      member: string | undefined,
    ) => {
      if (apiFile && unconstrainedSchemaMember(object, member))
        context.report({ node, message: unconstrainedSchemaMessage });
    };
    return {
      Program(node) {
        const source = getSourceText(context, node);

        if (isForbiddenGeneratedEffectPath(filename)) {
          context.report({
            node,
            message:
              'Generated UltraModern workspaces use direct api/index.ts, shared/api.ts and src/api/* paths; api/effect, api/lambda, shared/effect and src/effect are forbidden.',
          });
        }

        reportProgramPattern(
          context,
          node,
          source,
          /@modern-js\/plugin-bff\/(?:server|hono-server)(?![\w-])/u,
          'UltraModern API workspaces must not import Hono server helpers; use @modern-js/bff-effect/effect-edge and HttpApi.',
        );
        reportProgramPattern(
          context,
          node,
          source,
          /\bruntimeFramework\s*(?::|=)\s*['"]hono['"]/u,
          'UltraModern API apps must use bff.runtimeFramework: "effect".',
        );
        reportProgramPattern(
          context,
          node,
          source,
          /(?:from|import)\s*['"][^'"]*(?:api\/effect|shared\/effect)(?=\/|\.[cm]?[jt]sx?['"]|['"])[^'"]*['"]|shared-effect-api/u,
          'Import API code from direct api/index.ts, shared/api.ts or src/api/* paths, not api/effect, shared/effect or shared Effect API packages.',
        );
        reportProgramPattern(
          context,
          node,
          source,
          /\bstrictEffectApproach\s*(?::|=)\s*false\b/u,
          'UltraModern API apps must keep strictEffectApproach enabled.',
        );

        if (isApiEntryFile(filename)) {
          const violation = strictEffectRuntimeTopologyViolation(
            source,
            createEffectApiImportResolver(filename),
          );
          if (violation) context.report({ node, message: violation });
        }

        if (isSharedApiContractFile(filename)) {
          reportMissingProgramPattern(
            context,
            node,
            source,
            /\bHttpApi\.make\b/u,
            'Generated shared API contracts must declare an HttpApi contract.',
          );
          reportMissingProgramPattern(
            context,
            node,
            source,
            /\bHttpApiGroup\.make\b/u,
            'Generated shared API contracts must declare HttpApi groups.',
          );
          reportMissingProgramPattern(
            context,
            node,
            source,
            /\bHttpApiEndpoint\./u,
            'Generated shared API contracts must declare endpoints through HttpApiEndpoint.',
          );
          reportMissingProgramPattern(
            context,
            node,
            source,
            /\bSchema\./u,
            'Generated shared API contracts must model request, response and error shapes with Schema.',
          );
        }

        if (!apiFile) {
          return;
        }

        reportProgramPattern(
          context,
          node,
          source,
          /\bnew\s+Response\s*\(|\bResponse\.json\s*\(/u,
          'API modules must not hand-build Response objects; model endpoints through Effect HttpApi and schemas.',
        );
        reportProgramPattern(
          context,
          node,
          source,
          /\b(?:request|req)\.(?:json|text|formData|arrayBuffer)\s*\(/u,
          'API modules must not manually parse request bodies; use HttpApiEndpoint payload/query/params schemas.',
        );
        reportProgramPattern(
          context,
          node,
          source,
          /\bexport\s+const\s+handler\b|\bexport\s+default\s+async\b/u,
          'API modules must not export raw request handlers; export defineEffectBff(...) from api/index.ts.',
        );
        reportProgramPattern(
          context,
          node,
          source,
          /\bcreateHandler\s*[:=]\s*(?!defineEffectBff\b)/u,
          'API modules must not define unbranded handler factories; use defineEffectBff(...).',
        );
      },
      MemberExpression(node) {
        reportUnconstrained(
          node,
          node.object,
          node.computed
            ? getStringLiteralValue(node.property)
            : node.property?.type === 'Identifier'
              ? getNodeName(node.property)
              : undefined,
        );
      },
      JSXMemberExpression(node) {
        reportUnconstrained(node, node.object, getNodeName(node.property));
      },
      TSImportEqualsDeclaration(node) {
        // `import Loose = Schema.Any` is a value alias of the member.
        if (node.importKind === 'type') return;
        let reference = node.moduleReference;
        while (
          reference?.type === 'TSQualifiedName' &&
          reference.left?.type !== 'Identifier'
        )
          reference = reference.left;
        if (reference?.type === 'TSQualifiedName')
          reportUnconstrained(
            node,
            reference.left,
            getNodeName(reference.right),
          );
      },
    };
  },
});
