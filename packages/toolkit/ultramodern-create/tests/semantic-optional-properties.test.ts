import assert from 'node:assert/strict';
import { isPropertySignatureDeclaration } from 'tsrs/ast';
import { TypeFlags } from 'tsrs/sync';
import { checkOptionalProperties } from '../src/ultramodern-tooling/semantic-lint/optional-properties';
import { withSemanticProject } from './helpers/semantic-project';

test('exact optionals preserve explicitly permitted undefined assignments', () => {
  const source = `
interface Input { readonly value?: string | undefined }
type ObjectInput = { value?: (number | undefined) };
class ClassInput { value?: boolean | undefined }
`;
  assert.deepEqual(withSemanticProject(source, checkOptionalProperties), []);
});

test('inexact optionals report only directly written undefined constituents', () => {
  const source = `
interface Input { readonly value?: (string | (undefined)) }
type ObjectInput = { value?: number | undefined };
class ClassInput { value?: boolean | undefined }
function optionalParameter(value?: string | undefined) {}
interface RequiredInput { value: string | undefined; absent?: string }
`;
  const diagnostics = withSemanticProject(source, checkOptionalProperties, {
    strict: true,
    exactOptionalPropertyTypes: false,
  });
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.line),
    [2, 3, 4],
  );
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.rule, 'redundant-optional-undefined');
    assert.equal(
      source.slice(diagnostic.start, diagnostic.start + 9),
      'undefined',
    );
    assert.match(diagnostic.message, /keep the optional property marker/u);
  }
});

test('exact optionals recognize undefined already supplied by aliases and indexed access', () => {
  const source = `
type Maybe = string | undefined;
interface Values { value?: number; explicit: boolean | undefined }
interface Input {
  alias?: Maybe | undefined;
  indexed?: Values['value'] | undefined;
  requiredIndexed?: Values['explicit'] | undefined;
}
`;
  const diagnostics = withSemanticProject(source, checkOptionalProperties);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.line),
    [5, 6, 7],
  );
});

test('exact optionals do not confuse the native missing marker with undefined', () => {
  const source = `
interface Values { value?: number }
type Present = { [Key in keyof Values]-?: Values[Key] };
interface Input {
  value?: Present['value'] | undefined;
  nested?: { value?: string } | undefined;
}
`;
  assert.deepEqual(withSemanticProject(source, checkOptionalProperties), []);
});

test('a real native missing type shares Undefined flags, not canonical identity', () => {
  const source = `
interface Input {
  missing?: string;
  explicit?: string | undefined;
  required?: Input['missing'] | undefined;
}
`;
  let observedMissingMarker = false;
  const diagnostics = withSemanticProject(source, context => {
    const undefinedId = context.checker.getUndefinedType().id;
    for (const statement of context.sourceFile.statements) {
      statement.forEachChild(node => {
        if (
          isPropertySignatureDeclaration(node) &&
          node.name.getText(context.sourceFile) === 'missing'
        ) {
          const type = context.checker.getTypeAtLocation(node);
          assert.ok(type.isUnionType());
          observedMissingMarker = type
            .getTypes()
            .some(
              member =>
                (member.flags & TypeFlags.Undefined) !== 0 &&
                member.id !== undefinedId,
            );
        }
      });
    }
    checkOptionalProperties(context);
  });
  assert.equal(observedMissingMarker, true);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.line),
    [5],
  );
});

test('unresolved types do not produce reports even with inexact optionals', () => {
  const source = `
type Broken = Missing | unknown;
interface Input {
  value?: Missing | undefined;
  indexed?: Missing['value'] | undefined;
  alias?: Broken | undefined;
  maskedByAny?: Missing | any | undefined;
  maskedByUnknown?: Missing | unknown | undefined;
}
`;
  for (const exactOptionalPropertyTypes of [true, false]) {
    assert.deepEqual(
      withSemanticProject(source, checkOptionalProperties, {
        strict: true,
        exactOptionalPropertyTypes,
      }),
      [],
    );
  }
});

test('known any and unknown constituents safely subsume undefined', () => {
  const source = `
type Anything = any;
type Uncertain = unknown;
interface Input {
  anyValue?: Anything | undefined;
  unknownValue?: Uncertain | undefined;
  plainUnknown?: unknown;
}
`;
  const diagnostics = withSemanticProject(source, checkOptionalProperties);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.line),
    [5, 6],
  );
});

test('parameters, methods, required and definite properties stay unchanged', () => {
  const source = `
type Maybe = string | undefined;
interface Input {
  alias?: Maybe;
  onlyUndefined?: undefined;
  required: string | undefined;
  method?(value?: string | undefined): void;
  callback?: (value?: string | undefined) => void;
}
class ClassInput {
  required!: string | undefined;
  constructor(public parameter?: string | undefined) {}
}
function optional(value?: string | undefined) {}
`;
  for (const exactOptionalPropertyTypes of [true, false]) {
    assert.deepEqual(
      withSemanticProject(source, checkOptionalProperties, {
        strict: true,
        exactOptionalPropertyTypes,
      }),
      [],
    );
  }
});

test('nested parenthesized unions and readonly class properties are checked', () => {
  const source = `
type Maybe<T> = T | undefined;
interface Input {
  nested?: ((Maybe<number> | null) | (undefined));
}
class ClassInput {
  readonly value?: ((Maybe<string>) | undefined);
}
`;
  const diagnostics = withSemanticProject(source, checkOptionalProperties);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.line),
    [4, 7],
  );
});

test('duplicate undefined constituents retain one when exact semantics need it', () => {
  const source = `
interface Input {
  value?: string | undefined | undefined;
  onlyUndefined?: undefined | undefined;
}
`;
  const exact = withSemanticProject(source, checkOptionalProperties);
  assert.deepEqual(
    exact.map(diagnostic => diagnostic.line),
    [3, 4],
  );
  assert.equal(
    exact[0].start,
    source.indexOf('undefined', source.indexOf('undefined') + 1),
  );
  const inexact = withSemanticProject(source, checkOptionalProperties, {
    strict: true,
    exactOptionalPropertyTypes: false,
  });
  assert.deepEqual(
    inexact.map(diagnostic => diagnostic.line),
    [3, 3, 4],
  );
});

test('disabled strict null checking makes the written union redundant', () => {
  const source = 'interface Input { value?: string | undefined }';
  for (const compilerOptions of [
    { strict: false },
    { strict: true, strictNullChecks: false },
    { strict: false, exactOptionalPropertyTypes: true },
  ]) {
    assert.equal(
      withSemanticProject(source, checkOptionalProperties, compilerOptions)
        .length,
      1,
    );
  }
  assert.deepEqual(
    withSemanticProject(source, checkOptionalProperties, {
      strict: false,
      strictNullChecks: true,
      exactOptionalPropertyTypes: true,
    }),
    [],
  );
});
