import assert from 'node:assert/strict';
import type { RawCompilerOptions } from 'tsrs/sync';
import { checkReturnValues } from '../src/ultramodern-tooling/semantic-lint/returns';
import { withSemanticProject } from './helpers/semantic-project';

test('native return checks accept explicit empty normal and generator branches', () => {
  const diagnostics = withSemanticProject(
    `
export function partial(present: boolean) {
  if (!present) return;
  return 1;
}
export function* partialGenerator(present: boolean, decoded: boolean) {
  yield 0;
  if (!present) return;
  if (!decoded) return;
  return { effectId: 'live' };
}
export function explicitUndefined(present: boolean) {
  if (!present) return undefined;
  return 1;
}
export function* explicitGeneratorUndefined(present: boolean) {
  if (!present) return undefined;
  return 'allowed';
}
`,
    checkReturnValues,
  );
  assert.deepEqual(diagnostics, []);
});

test('native return checks catch genuine missing normal and generator branches', () => {
  const source = `
export function missingNormal(matches: boolean) {
  if (matches) return 1;
}
export function* missingDecision(applies: boolean, matches: boolean) {
  yield 0;
  if (!applies) return;
  if (matches) return 'allowed';
}
export function* missingReference(recovery: boolean) {
  yield 0;
  if (!recovery) return { effectId: 'live' };
}
`;
  const diagnostics = withSemanticProject(source, checkReturnValues);
  assert.equal(diagnostics.length, 3);
  for (const [index, name] of [
    'missingNormal',
    'missingDecision',
    'missingReference',
  ].entries()) {
    const diagnostic = diagnostics[index];
    assert.equal(diagnostic.rule, 'missing-return-value');
    assert.match(diagnostic.message, /^TS7030:/u);
    assert.equal(diagnostic.start, source.indexOf(name));
    const precedingLines = source.slice(0, diagnostic.start).split('\n');
    assert.equal(diagnostic.line, precedingLines.length);
    assert.equal(
      diagnostic.column,
      diagnostic.start - source.lastIndexOf('\n', diagnostic.start - 1),
    );
  }
});

test('native return checks preserve never calls and terminal return yield-star', () => {
  const diagnostics = withSemanticProject(
    `
function failNever(): never { throw new Error('unavailable'); }
function* failingIterable(): Generator<never, never, unknown> {
  throw new Error('unavailable');
}
export function normalNever(matches: boolean) {
  if (matches) return 'allowed';
  failNever();
}
export function returnNever(matches: boolean) {
  if (matches) return 'allowed';
  return failNever();
}
export function* returnYieldStar(matches: boolean) {
  if (matches) return 'allowed';
  return yield* failingIterable();
}
`,
    checkReturnValues,
  );
  assert.deepEqual(diagnostics, []);
});

test('native compiler still reports bare yield-star of a never-returning iterable', () => {
  const source = `
function* failingIterable(): Generator<never, never, unknown> {
  throw new Error('unavailable');
}
export function* bareYieldStar(matches: boolean) {
  if (matches) return 'allowed';
  yield* failingIterable();
}
`;
  const diagnostics = withSemanticProject(source, checkReturnValues);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].start, source.indexOf('bareYieldStar'));
  assert.match(diagnostics[0].message, /^TS7030:/u);
});

test('native exhaustive switches do not exempt conditional enclosing branches', () => {
  const source = `
export function exhaustive(kind: 'allow' | 'deny') {
  switch (kind) {
    case 'allow': return 'allowed';
    case 'deny': return 'denied';
  }
}
export function conditionalSwitch(applies: boolean, kind: 'allow' | 'deny') {
  if (applies) {
    switch (kind) {
      case 'allow': return 'allowed';
      case 'deny': return 'denied';
    }
  }
}
`;
  const diagnostics = withSemanticProject(source, checkReturnValues);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].start, source.indexOf('conditionalSwitch'));
  assert.match(diagnostics[0].message, /^TS7030:/u);
});

test('native return diagnostics keep nested callbacks independent', () => {
  const source = `
export function outer() {
  return [true, false].map(function missingCallback(matches) {
    if (matches) return 1;
  });
}
export function enclosingMissing(matches: boolean) {
  [true, false].map(function completeCallback(value) {
    return value ? 1 : 2;
  });
  if (matches) return 'allowed';
}
`;
  const diagnostics = withSemanticProject(source, checkReturnValues);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.start),
    ['missingCallback', 'enclosingMissing'].map(name => source.indexOf(name)),
  );
  assert.ok(
    diagnostics.every(diagnostic => /^TS7030:/u.test(diagnostic.message)),
  );
});

test('native return checks respect finally overrides without hiding fallthrough', () => {
  const source = `
export function finallyReturns(matches: boolean) {
  try { if (matches) return 1; } finally { return 2; }
}
export function finallyReturnsEmpty(matches: boolean) {
  try { if (matches) return 1; } finally { return; }
}
export function finallyThrows(matches: boolean) {
  try { if (matches) return 1; } finally { throw new Error('failed'); }
}
export function finallyFallsThrough(matches: boolean) {
  try { if (matches) return 1; } finally { void matches; }
}
`;
  const diagnostics = withSemanticProject(source, checkReturnValues);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].start, source.indexOf('finallyFallsThrough'));
  assert.match(diagnostics[0].message, /^TS7030:/u);
});

test('native return checks distinguish async void from ordinary returned Promise<void>', () => {
  const source = `
declare function sideEffect(): Promise<void>;
export async function inferredAsyncVoid(matches: boolean) {
  if (matches) return sideEffect();
}
export async function explicitAsyncVoid(matches: boolean): Promise<void> {
  if (matches) return sideEffect();
}
export function ordinaryPromiseVoid(matches: boolean) {
  if (matches) return sideEffect();
}
export async function missingAsyncValue(matches: boolean) {
  if (matches) return Promise.resolve(1);
}
`;
  const diagnostics = withSemanticProject(source, checkReturnValues);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.start),
    ['ordinaryPromiseVoid', 'missingAsyncValue'].map(name =>
      source.indexOf(name),
    ),
  );
  assert.ok(
    diagnostics.every(diagnostic => /^TS7030:/u.test(diagnostic.message)),
  );
});

test('adapter forwards explicit-contract errors and ignores unrelated type errors', () => {
  const source = `
export function optionalButMissing(matches: boolean): number | undefined {
  if (matches) return 1;
}
export function requiredButMissing(matches: boolean): number {
  if (matches) return 1;
}
export function noReturn(): number {}
export const wrongType: number = 'not a number';
`;
  const diagnostics = withSemanticProject(source, checkReturnValues);
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.message.match(/^TS\d+/u)?.[0]),
    ['TS7030', 'TS2366', 'TS2355'],
  );
  assert.deepEqual(
    diagnostics.map(
      diagnostic => source.slice(diagnostic.start).split(/\s/u)[0],
    ),
    ['number', 'number', 'number'],
  );
});

test('adapter fails closed when the real project omits or disables noImplicitReturns', () => {
  for (const compilerOptions of [
    { strict: true, noImplicitReturns: undefined },
    { strict: true, noImplicitReturns: false },
  ] satisfies RawCompilerOptions[]) {
    assert.throws(
      () =>
        withSemanticProject(
          'export function missing(matches: boolean) { if (matches) return 1; }',
          checkReturnValues,
          compilerOptions,
        ),
      /requires noImplicitReturns: true.*input\.ts/u,
    );
  }
});

test('adapter checks effective program options, not a substituted context option', () => {
  assert.throws(
    () =>
      withSemanticProject(
        'export const value = 1;',
        context =>
          checkReturnValues({
            ...context,
            compilerOptions: {
              ...context.compilerOptions,
              noImplicitReturns: true,
            },
          }),
        { strict: true, noImplicitReturns: false },
      ),
    /requires noImplicitReturns: true/u,
  );
});
