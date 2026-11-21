export type AstNode = {
  readonly type?: string;
  readonly parent?: AstNode;
  readonly loc?: {
    readonly start?: {
      readonly line?: number;
    };
    readonly end?: {
      readonly line?: number;
    };
  };
  readonly value?: unknown;
  readonly raw?: unknown;
  readonly name?: unknown;
  readonly openingElement?: AstNode;
  readonly expression?: AstNode;
  readonly expressions?: readonly AstNode[];
  readonly quasis?: readonly AstNode[];
  readonly test?: AstNode;
  readonly consequent?: AstNode;
  readonly alternate?: AstNode;
  readonly arguments?: readonly AstNode[];
  readonly callee?: AstNode;
  readonly object?: AstNode;
  readonly property?: AstNode;
  readonly computed?: boolean;
  readonly left?: AstNode;
  readonly right?: AstNode;
  readonly moduleReference?: AstNode;
  readonly importKind?: string;
};

export type RuleContext = {
  readonly options?: readonly unknown[];
  readonly filename?: string;
  getSourceCode?: () => {
    readonly text?: string;
    getAllComments?: () => readonly AstNode[];
    getText?: (node: AstNode) => string;
  };
  report: (descriptor: {
    readonly node: AstNode;
    readonly message: string;
  }) => void;
};

export type Rule = {
  readonly meta: {
    readonly type: string;
    readonly docs: {
      readonly description: string;
    };
    readonly schema: unknown[];
  };
  create(context: RuleContext): Record<string, (node: AstNode) => void>;
};

export type CommonRuleOptions = {
  readonly allowElements: readonly string[];
  readonly ignoreCommentPattern: string;
};

export type AttributeRuleOptions = CommonRuleOptions & {
  readonly visibleAttributes: readonly string[];
};

export type SplitTranslationKeyRuleOptions = {
  readonly translationFunctions: readonly string[];
};
