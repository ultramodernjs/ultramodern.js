import assert from 'node:assert/strict';
import { checkArrayMembership } from '../src/ultramodern-tooling/semantic-lint/array-membership';
import { withSemanticProject } from './helpers/semantic-project';

function lint(source: string) {
  return withSemanticProject(source, checkArrayMembership);
}

test('repeated membership uses semantic array parameters, not strings', () => {
  const diagnostics = withSemanticProject(
    `
    function arrays(allowed: readonly string[], candidates: string[]) {
      return candidates.some(candidate => allowed.includes(candidate));
    }
    function strings(allowed = 'ready', candidates: string[]) {
      return candidates.some(candidate => allowed.includes(candidate));
    }
    `,
    checkArrayMembership,
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, 'repeated-array-membership');
  assert.equal(diagnostics[0].line, 3);
  assert.match(diagnostics[0].message, /one Set before the loop/u);
  assert.match(
    diagnostics[0].message,
    /If the array and all its aliases remain unchanged/u,
  );
  assert.match(diagnostics[0].message, /manually/u);
  assert.match(diagnostics[0].message, /immutability is not proven/u);
  assert.equal('fix' in diagnostics[0], false);
});

test('fresh per-iteration arrays and single lookups do not get Set advice', () => {
  const diagnostics = withSemanticProject(
    `
    function check(candidates: string[]) {
      const allowed = ['ready'];
      allowed.includes('ready');
      return candidates.some(candidate => {
        const fresh = [candidate];
        return fresh.includes(candidate);
      });
    }
    `,
    checkArrayMembership,
  );
  assert.deepEqual(diagnostics, []);
});

test('hoisted array producers and readonly tuples are reusable in all supported callbacks', () => {
  const diagnostics = lint(`
    declare function produce(): string[];
    function check(candidates: string[]) {
      const produced = produce();
      const tuple = ['ready', 'done'] as const;
      candidates.some(candidate => produced.includes(candidate));
      candidates.map(candidate => produced.includes(candidate));
      candidates.every(candidate => produced.includes(candidate));
      candidates.filter(candidate => produced.includes(candidate));
      candidates.forEach(candidate => tuple.includes('ready'));
    }
  `);
  assert.equal(diagnostics.length, 5);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.line),
    [6, 7, 8, 9, 10],
  );
});

test('lexical loop bodies and conditions repeat, but initializers and iterable expressions do not', () => {
  const diagnostics = lint(`
    function check(allowed: string[], candidates: string[]) {
      for (let i = allowed.includes('init') ? 0 : 1; i < 3; i++) {
        allowed.includes('body');
      }
      for (; allowed.includes('condition');) break;
      for (let i = 0; i < 3; allowed.includes('increment'), i++) {}
      while (allowed.includes('while')) break;
      do { allowed.includes('do'); } while (false);
      for (const candidate of candidates) allowed.includes(candidate);
      for (const key in candidates) allowed.includes(key);
      for (const candidate of allowed.includes('iterable') ? candidates : []) {}
      for (const key in allowed.includes('object') ? candidates : []) {}
    }
  `);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.line),
    [4, 6, 7, 8, 9, 10, 11],
  );
});

test('deferred functions inside loops are not repeated invocations', () => {
  assert.deepEqual(
    lint(`
    function check(allowed: string[], candidates: string[]) {
      for (const candidate of candidates) {
        const later = () => allowed.includes(candidate);
        function detached() { return allowed.includes(candidate); }
        const object = { check() { return allowed.includes(candidate); } };
      }
      const callback = (candidate: string) => allowed.includes(candidate);
      candidates.some(callback);
      candidates.map(() => () => allowed.includes('later'));
      candidates.forEach(() => setTimeout(() => allowed.includes('later')));
    }
  `),
    [],
  );
});

test('allocation inside a loop is not amortized, including producer and inline expressions', () => {
  assert.deepEqual(
    lint(`
    declare function produce(): string[];
    function check(candidates: string[]) {
      for (const candidate of candidates) {
        const perIteration = produce();
        perIteration.includes(candidate);
        ['ready', 'done'].includes(candidate);
        produce().includes(candidate);
      }
      candidates.some(candidate => produce().includes(candidate));
      candidates.some(candidate => {
        const tuple = ['ready', 'done'] as const;
        return tuple.includes('ready');
      });
    }
  `),
    [],
  );
});

test('an array created in an outer iteration can be reused by an inner loop', () => {
  const diagnostics = lint(`
    declare function produce(): string[];
    function check(groups: string[][]) {
      for (const group of groups) {
        const allowed = produce();
        group.some(candidate => allowed.includes(candidate));
      }
    }
  `);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].line, 6);
});

test('inferred strings, string parameters and string-or-array unions stay silent', () => {
  assert.deepEqual(
    lint(`
    function check(candidates: string[], union: string | string[]) {
      const inferred = 'ready done';
      const concatenated = 'ready' + 'done';
      candidates.some(candidate => inferred.includes(candidate));
      candidates.map(candidate => concatenated.indexOf(candidate) !== -1);
      candidates.every(candidate => union.includes(candidate));
    }
    function strings(allowed: string, candidates: string[]) {
      return candidates.filter(candidate => allowed.indexOf(candidate) >= 0);
    }
  `),
    [],
  );
});

test('any, unknown, unresolved, optional receivers and custom membership are not built-in proofs', () => {
  assert.deepEqual(
    lint(`
    declare const missing: MissingType;
    interface Custom { includes(value: string): boolean }
    function check(
      candidates: string[], loose: any, unknownValue: unknown,
      optional: string[] | undefined, custom: Custom,
      overridden: string[] & { includes(value: string): boolean }
    ) {
      candidates.some(candidate => loose.includes(candidate));
      candidates.some(candidate => unknownValue.includes(candidate));
      candidates.some(candidate => missing.includes(candidate));
      candidates.some(candidate => optional?.includes(candidate));
      candidates.some(candidate => custom.includes(candidate));
      candidates.some(candidate => overridden.includes(candidate));
    }
  `),
    [],
  );
});

test('library-looking names in authored declarations do not establish built-in ownership', () => {
  assert.deepEqual(
    lint(`
    export {};
    declare global {
      interface Array<T> { includes(value: T): boolean }
    }
    function check(allowed: string[], candidates: string[]) {
      return candidates.some(candidate => allowed.includes(candidate));
    }
  `),
    [],
  );
});

test('custom higher-order methods do not establish repeated callback execution', () => {
  assert.deepEqual(
    lint(`
    interface Custom { some(callback: (value: string) => boolean): boolean }
    function check(allowed: string[], custom: Custom) {
      return custom.some(candidate => allowed.includes(candidate));
    }
  `),
    [],
  );
});

test('local mutation, rebinding, aliases and escapes suppress Set advice', () => {
  const bodies = [
    `allowed.push('new'); candidates.some(value => allowed.includes(value));`,
    `candidates.some(value => { allowed.splice(0, 1); return allowed.includes(value); });`,
    `candidates.some(value => { allowed[0] = value; return allowed.includes(value); });`,
    `candidates.some(value => { allowed.length = 0; return allowed.includes(value); });`,
    `candidates.some(value => { delete allowed[0]; return allowed.includes(value); });`,
    `allowed = ['new']; candidates.some(value => allowed.includes(value));`,
    `const alias = allowed; candidates.some(value => allowed.includes(value));`,
    `const { push } = allowed; candidates.some(value => allowed.includes(value));`,
    `leak(allowed); candidates.some(value => allowed.includes(value));`,
    `candidates.some(value => allowed.includes(value)); return allowed;`,
    `const object = { allowed }; candidates.some(value => allowed.includes(value));`,
    `const copy = [...allowed]; candidates.some(value => allowed.includes(value));`,
    `function mutate() { allowed.pop(); } candidates.some(value => allowed.includes(value));`,
    `allowed.includes = () => true; candidates.some(value => allowed.includes(value));`,
  ];
  for (const body of bodies) {
    assert.deepEqual(
      lint(`
      declare function leak(value: string[]): void;
      function check(allowed: string[], candidates: string[]) { ${body} }
    `),
      [],
      body,
    );
  }
});

test('symbol identity distinguishes an unrelated shadowed mutation', () => {
  const diagnostics = lint(`
    function check(allowed: string[], candidates: string[]) {
      function unrelated(allowed: string[]) { allowed.push('changed'); }
      return candidates.some(candidate => allowed.includes(candidate));
    }
  `);
  assert.equal(diagnostics.length, 1);
});

test('fromIndex and argument spreads cannot be converted to Set.has', () => {
  assert.deepEqual(
    lint(`
    function check(allowed: string[], candidates: string[]) {
      const args: [string, number] = ['ready', 1];
      candidates.some(candidate => allowed.includes(candidate, 1));
      candidates.some(candidate => allowed.includes(candidate, 0));
      candidates.some(candidate => allowed.indexOf(candidate, -1) !== -1);
      candidates.some(candidate => allowed.lastIndexOf(candidate, 0) >= 0);
      candidates.some(candidate => allowed.includes(...args));
      candidates.some(candidate => allowed.includes());
    }
  `),
    [],
  );
});

test('indexOf string membership comparisons are safe but numeric positions are not booleans', () => {
  const diagnostics = lint(`
    function check(allowed: readonly string[], candidates: string[]) {
      candidates.some(candidate => allowed.indexOf(candidate) !== -1);
      candidates.some(candidate => allowed.indexOf(candidate) === -1);
      candidates.some(candidate => allowed.indexOf(candidate) > -1);
      candidates.some(candidate => allowed.indexOf(candidate) >= 0);
      candidates.some(candidate => allowed.indexOf(candidate) < 0);
      candidates.some(candidate => -1 !== allowed.indexOf(candidate));
      candidates.some(candidate => -1 < allowed.indexOf(candidate));
      candidates.some(candidate => 0 <= allowed.indexOf(candidate));
      candidates.some(candidate => 0 > allowed.indexOf(candidate));
      candidates.some(candidate => allowed.lastIndexOf(candidate) !== -1);
      candidates.map(candidate => allowed.indexOf(candidate));
      candidates.some(candidate => allowed.indexOf(candidate) === 0);
      candidates.some(candidate => allowed.indexOf(candidate) > 0);
      candidates.some(candidate => !!allowed.indexOf(candidate));
      candidates.some(candidate => allowed.indexOf(candidate) == -1);
      candidates.some(candidate => allowed.indexOf(candidate) !== 1);
    }
  `);
  assert.equal(diagnostics.length, 10);
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.line),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
});

test('indexOf numeric NaN and sparse undefined queries do not get Set advice', () => {
  assert.deepEqual(
    lint(`
    function check(
      numbers: readonly number[], sparse: readonly (string | undefined)[],
      candidates: (string | undefined)[], numericQueries: number[]
    ) {
      numericQueries.some(candidate => numbers.indexOf(candidate) !== -1);
      numericQueries.some(candidate => numbers.lastIndexOf(candidate) >= 0);
      numericQueries.some(candidate => numbers.indexOf(NaN) === -1);
      candidates.some(candidate => sparse.indexOf(candidate) !== -1);
      candidates.some(candidate => sparse.indexOf(undefined) === -1);
    }
  `),
    [],
  );
});

test('includes retains SameValueZero and sparse undefined membership semantics', () => {
  const diagnostics = lint(`
    function check(
      numbers: readonly number[], sparse: readonly (string | undefined)[],
      candidates: (string | undefined)[], numericQueries: number[]
    ) {
      numericQueries.some(candidate => numbers.includes(candidate));
      candidates.some(candidate => sparse.includes(candidate));
    }
  `);
  assert.equal(diagnostics.length, 2);
});

test('real arrays in union branches are accepted without accepting mixed receiver kinds', () => {
  const diagnostics = lint(`
    function check(
      allowed: readonly string[] | readonly [string, string],
      candidates: string[]
    ) {
      return candidates.some(candidate => allowed.includes(candidate));
    }
  `);
  assert.equal(diagnostics.length, 1);
});
