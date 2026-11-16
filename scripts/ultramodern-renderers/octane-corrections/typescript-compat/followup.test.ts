import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { API } from 'typescript/unstable/sync';
import { compileToVolarMappings } from 'octane/compiler';
import { validateNativeSignalNames } from 'octane/compiler/typescript';
import { createTextTypeFixture } from '@fixture';

const stable = dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
const cleanups: (()=>void)[] = [];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse()) cleanup();});
function projectFor(source:string, realSignals=false) {
  const fixture=createTextTypeFixture({'Entry.tsx':source},{},{name:'stable',typescript:stable});
  cleanups.push(()=>fixture.dispose());
  const root=process.env.OCTANE_SOURCE_PACKAGE!;
  const paths=realSignals?{
    'octane/signals':[resolve(root,'src/signals/index.ts')],
    octane:[resolve(root,'src/index.ts')],
    'octane/jsx-runtime':[resolve(root,'src/jsx-runtime.d.ts')],
    'octane/signals/client':[resolve(root,'src/signals/client.ts')],
    'octane/signals/server':[resolve(root,'src/signals/server.ts')],
  }:undefined;
  const config=fixture.write('check.json',JSON.stringify({extends:'./tsconfig.json',compilerOptions:{paths},files:['Entry.tsx'],include:[]}));
  const api=new API({cwd:fixture.directory});cleanups.push(()=>api.close());
  const snapshot=api.updateSnapshot({openProjects:[config]});
  const project=snapshot.getProject(config)!;
  const file=fixture.file('Entry.tsx');
  expect(project.program.getSyntacticDiagnostics(file)).toEqual([]);
  expect(project.program.getSemanticDiagnostics(file)).toEqual([]);
  return {project,file,source};
}
function position(source:string,offset:number) {
  const before=source.slice(0,offset).split('\n');
  return {offset,line:before.length,column:before.at(-1)!.length};
}
it('uses the genuine stable Project checker and preserves exact native error objects',()=>{
  const source=`import {signal$} from 'octane/signals';\nimport {useMemo} from 'octane';\nconst value = signal$(1);\nconst stale = useMemo(() => value.get(), []);\n`;
  const {project,file}=projectFor(source,true);
  const ranges=[['value',source.indexOf('value =')],['useMemo(() => value.get(), [])',source.indexOf('useMemo(()')]] as const;
  expect(validateNativeSignalNames(project,file,{typescript:stable})).toEqual([
    {code:'OCTANE_NATIVE_SIGNAL_NAME',severity:'error',filename:file,message:'Native signal handles and functions exposing handles or live reads must end in $. Rename "value" to "value$"; sampled values keep ordinary names.',start:position(source,ranges[0][1]),end:position(source,ranges[0][1]+ranges[0][0].length),suggestions:[]},
    {code:'OCTANE_NATIVE_MEMO_READ',severity:'error',filename:file,message:'A live native signal read inside useMemo is not represented by an explicit dependency array. Omit the array to track native reads, or sample the signal during render and pass that value in the array. Explicit arrays are never rewritten; null runs the callback on every render.',start:position(source,ranges[1][1]),end:position(source,ranges[1][1]+ranges[1][0].length),suggestions:[]},
  ]);
});
it('accepts correctly named handles, tracked reads and ordinary structural lookalikes',()=>{
  const {project,file}=projectFor(`import {signal$} from 'octane/signals';
import {useMemo} from 'octane';
const value$ = signal$(1);
const sample = value$.get();
const tracked = useMemo(() => value$.get());
const everyRender = useMemo(() => value$.get(), null);
const ordinary = {get: () => 1};
`,true);
  expect(validateNativeSignalNames(project,file,{typescript:stable})).toEqual([]);
});
it('rejects a stable bare Program with the required public-API migration, not a missing-method crash',()=>{
  const {project,file}=projectFor('export const n = 1;');
  expect(()=>validateNativeSignalNames(project.program,file,{typescript:stable})).toThrow(/requires the Project from snapshot.getProject/);
});
it.each([
  ['',undefined],
  ['/** @jsxImportSource another */\n','octane'],
  ['// @jsxImportSource another\n','octane'],
])('prints a canonical mapped synthetic pragma and retains full TS diagnostics: %s',(authored,intrinsics)=>{
  const source=authored+'export function Entry(props:{value:number}) @{ <p>{props.value as string}</p> }';
  const virtual=compileToVolarMappings(source,'Entry.tsrx',{intrinsics});
  expect(virtual.code).toContain('/** @jsxImportSource octane */');
  // The invalid assertion must remain an error; only the malformed synthetic
  // pragma is corrected, inside the single mapped source-AST print.
  const f=createTextTypeFixture({'Entry.tsx':virtual.code},{},{name:'stable',typescript:stable});
  cleanups.push(()=>f.dispose());
  const api=new API({cwd:f.directory});cleanups.push(()=>api.close());
  const snapshot=api.updateSnapshot({openProjects:[f.tsconfig]});
  const program=snapshot.getProject(f.tsconfig)!.program;
  expect(program.getSyntacticDiagnostics(f.file('Entry.tsx'))).toEqual([]);
  expect(program.getSemanticDiagnostics(f.file('Entry.tsx')).map(d=>d.code)).toEqual([2352]);
  expect(virtual.mappings.length).toBeGreaterThan(0);
});
it('the shipped declarations accept stable Project and reject a checker-less stable Program',()=>{
  const source=`import type {Project,Program} from 'typescript/unstable/sync';
import {validateNativeSignalNames} from ${JSON.stringify(process.env.OCTANE_VALIDATOR_DECLARATION)};
declare const project: Project;
declare const program: Program;
validateNativeSignalNames(project,'test.ts');
validateNativeSignalNames(program,'test.ts');
`;
  const f=createTextTypeFixture({'Entry.tsx':source},{},{name:'stable',typescript:stable});
  cleanups.push(()=>f.dispose());
  // Resolve the real published API declaration through an explicit local path.
  const config=f.write('declarations.json',JSON.stringify({extends:'./tsconfig.json',compilerOptions:{paths:{'typescript/unstable/sync':[resolve(stable,'dist/api/sync/api.d.ts')]}},files:['Entry.tsx'],include:[]}));
  const api=new API({cwd:f.directory});cleanups.push(()=>api.close());
  const snapshot=api.updateSnapshot({openProjects:[config]});
  const diagnostics=snapshot.getProject(config)!.program.getSemanticDiagnostics(f.file('Entry.tsx'));
  expect(diagnostics.map(d=>d.code)).toEqual([2345]);
  expect(source.slice(diagnostics[0].pos,diagnostics[0].end)).toBe('program');
});
