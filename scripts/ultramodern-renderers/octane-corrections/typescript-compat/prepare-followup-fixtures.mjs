import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Fixture construction only: leave all upstream test bodies and assertions intact.
export function prepareNativeSuite(pkg) {
  const file=path.join(pkg,'tests/compiler/native-read-types.test.ts');
  let source=fs.readFileSync(file,'utf8');
  assert(source.includes('const snapshot = nativeApi.createSnapshot({'));
  source=source.replace("diagnostics: validateNativeSignalNames(program, sourceFile),", "diagnostics: validateNativeSignalNames(program, sourceFile, {typescript: dirname(createRequire(import.meta.url).resolve('typescript-classic/package.json'))}),");
  source=source.replace("{ name: 'the classic API', build: classicProgram, typescript: undefined }", "{ name: 'the classic API', build: classicProgram, typescript: dirname(createRequire(import.meta.url).resolve('typescript-classic/package.json')) }");
  const start=source.indexOf('let nativeApi: any = null;');
  const end=source.indexOf('\nconst BACKENDS =',start);
  assert(start>=0 && end>start);
  source=source.slice(0,start)+`const nativeApis: {close():void}[] = [];
afterAll(() => { for(const api of nativeApis) api.close(); });
function nativeProgram(source: string, otherFiles: Record<string,string>): FixtureProgram {
  const {filename,files}=fixtureFiles(source,otherFiles);
  const sync=native('typescript/unstable/sync');
  const config=ROOT+'/tsconfig.json';
  files.set(config,JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,jsx:'preserve',noEmit:true,skipLibCheck:true,types:[],paths:PATHS},files:[...files.keys()]}));
  const api=new sync.API({fs:{readFile:(name:string)=>files.get(name),fileExists:(name:string)=>files.has(name)?true:undefined,directoryExists:(name:string)=>name===ROOT?true:undefined}});
  nativeApis.push(api);
  const snapshot=api.updateSnapshot({openProjects:[config]});
  const project=snapshot.getProject(config);
  const program=project.program;
  const sourceFile=program.getSourceFile(filename);
  return {program:project,sourceFile,errors:program.getSemanticDiagnostics(filename).map((d:any)=>d.text),diagnostics:validateNativeSignalNames(project,sourceFile,{typescript:TYPESCRIPT_7})};
}
`+source.slice(end);
  fs.writeFileSync(file,source);
}
