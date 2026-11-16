import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { API } from 'typescript/unstable/sync';
import { compileToVolarMappings } from 'octane/compiler';
import { createTextTypeProject } from 'octane/compiler/typescript';
import { createTextTypeFixture, stringChildren } from '@fixture';
import { virtualTextTypeConfig } from '@config-adapter';

const stable = { name: 'published stable 7.0.2', typescript: dirname(createRequire(import.meta.url).resolve('typescript/package.json')) };
const fixtures: ReturnType<typeof createTextTypeFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
function fixture(source: string) {
  const f = createTextTypeFixture({'Entry.tsrx':source}, {}, stable);
  fixtures.push(f);
  return f;
}

it('preserves JSONC, escapes, and unrelated config fields while mapping root specs', () => {
  const jsonc = String.raw`{
    // "files": ["not-a-root.tsrx"]
    "extends": "./base.tsrx", "compilerOptions": { "paths": {"x":["./x.tsrx"]} },
    "files": ["a\u002etsrx", "b.tsx"], "include": ["**/*.tsrx",],
    "exclude": ["ignored.tsrx"], /* retained */
  }`;
  expect(virtualTextTypeConfig(jsonc).code).toBe(jsonc.replace('"a\\u002etsrx"', '"a.tsrx.tsx"').replace('"**/*.tsrx"', '"**/*.tsrx.tsx"').replace('"ignored.tsrx"', '"ignored.tsrx.tsx"'));
  expect(virtualTextTypeConfig('{"files": ["bad\\q.tsrx"]}').code).toBe('{"files": ["bad\\q.tsrx"]}');
});

it('the actual stable compiler retains TS2352, TS2339, TS2307 and exact diagnostic spans', () => {
  const source = `import { missing } from './missing';
export function Entry(props: { value: number; sound: string }) @{
 <main><p>{props.value as string}</p><p>{String(props.value)}</p><p>{props.absent}</p><p>{missing()}</p><p>{props.sound}</p></main>
}`;
  const f = fixture(source);
  expect(stringChildren(source, f.project.snapshot(f.file('Entry.tsrx')))).toEqual(['String(props.value)', 'props.sound']);
  const virtual = compileToVolarMappings(source, f.file('Entry.tsrx'));
  const check = f.write('Entry.check.tsx', virtual.code);
  const config = f.write('native-check.json', JSON.stringify({extends:'./tsconfig.json', files:[check], include:[]}));
  const api = new API({cwd:f.directory});
  try {
    const snapshot = api.updateSnapshot({openProjects:[config]});
    const project = snapshot.getProject(config)!;
    expect(project.program.getSyntacticDiagnostics(check)).toEqual([]);
    const diagnostics = project.program.getSemanticDiagnostics(check);
    expect(diagnostics.map(d => d.code).sort()).toEqual([2307, 2339, 2352]);
    const assertion = diagnostics.find(d => d.code === 2352)!;
    expect(virtual.code.slice(assertion.pos, assertion.end)).toBe('__octane_nativeAttributeValue(props.value) as string');
    expect(project.checker).toBeDefined();
    expect(project.program.getCompilerOptions().strict).toBe(true);
  } finally { api.close(); }
});

it('stable rejects malformed syntax rather than inventing text proof', () => {
  const f = fixture('export const broken = ;');
  const name = f.write('Broken.tsx', 'export function Broken() { return <p>{(}</p>; }');
  const facts = f.project.snapshot(name);
  expect(facts.stringChildRanges).toEqual([]);
  const config = f.write('syntax-check.json', JSON.stringify({extends:'./tsconfig.json',files:[name],include:[]}));
  const api = new API({cwd:f.directory});
  try {
    const snapshot = api.updateSnapshot({openProjects:[config]});
    expect(snapshot.getProject(config)!.program.getSyntacticDiagnostics(name).length).toBeGreaterThan(0);
  } finally { api.close(); }
});

it.each([
  '{"compilerOptions":{"strict":"wrong"}}',
  '{"extends":"./missing-base.json"}',
  '{"compilerOptions": { "strict": true, BROKEN }}',
])('surfaces native configuration errors without suppressing them: %s', config => {
  const f = fixture('export function Entry(props: {sound: string}) @{ <p>{props.sound}</p> }');
  f.write('tsconfig.json', config);
  f.project.invalidate();
  // Repeated calls must not retain an invalid, already-created Program.
  for (let i=0; i<2; i++) expect(() => f.project.snapshot(f.file('Entry.tsrx'))).toThrow();
});

it('resolves commented inherited files arrays and excluded ambient roots', () => {
  const source = 'export function Entry(props: {sound: Included}) @{ <p>{props.sound}</p> }';
  const f = fixture(source);
  f.write('included.tsrx', 'declare global { type Included = string; } export {};');
  f.write('excluded.tsrx', 'declare global { type Included = number; } export {};');
  f.write('config/base.json', '{/* preserve relative scope */ "files":["../included.tsrx"], "include":["../*.tsrx"], "exclude":["../excluded.tsrx"],}');
  const config = JSON.parse(readFileSync(f.tsconfig,'utf8'));
  delete config.include;
  config.extends = './config/base.json';
  f.write('tsconfig.json', JSON.stringify(config));
  f.project.invalidate();
  expect(stringChildren(source, f.project.snapshot(f.file('Entry.tsrx')))).toEqual(['props.sound']);
  const fresh = createTextTypeProject({tsconfig:f.tsconfig,typescript:stable.typescript});
  try { expect(fresh.snapshot(f.file('Entry.tsrx'))).toEqual(f.project.snapshot(f.file('Entry.tsrx'))); }
  finally { fresh.dispose(); }
});
