import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = {
  commit:'4c35afcdca0f4889921612fc462e6aabe507d78d',
  sha256:'e12e4846d57c0e4913f60bd1d010637cfe175b833158cb50e2d175c7452f5900',
};
const integrity = 'sha512-nMuONCV3pMMJhWjlXmC08Dn+i/bXju1micX/kKyAxY1b+dGK0zvCY6dCuMn791pyQfgXBs0jQ2X8apPysVrOhQ==';
const run = (cmd,args,cwd,extra={}) => execFileSync(cmd,args,{cwd,stdio:'inherit',...extra});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function disk() {
  run('df',['-h','/System/Volumes/Data']);
  const {bavail,bsize}=fs.statfsSync('/System/Volumes/Data');
  assert(bavail*bsize>=20*1024**3,'Below 20 GiB; stop');
}
async function archive(url,name,work,check) {
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  assert(response.ok,`${response.status} ${url}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  check(bytes);
  const file=path.join(work,name+'.tgz');
  fs.writeFileSync(file,bytes);
  const dir=path.join(work,name);fs.mkdirSync(dir);
  run('tar',['-xzf',file,'--strip-components=1','-C',dir],work);
  return dir;
}

assert(process.env.OWNED_TEMP_DIR,'Use owned-temp-dir --need-gib 20 --run octane-typescript-compat -- node <this-file>');
const work=path.join(fs.realpathSync(process.env.OWNED_TEMP_DIR),'qualification');
fs.mkdirSync(work);
const owner=`octane-typescript-compat-${process.pid}`;
const registered=[];
function register(dir,kind) {
  fs.mkdirSync(dir,{recursive:true});
  run('/Users/satan/bin/disk-guardian-artifacts',['register',dir,'--owner',owner,'--owner-pid',String(process.pid),'--kind',kind,'--grace-hours','24'],work);
  registered.push(dir);
}
try {
  disk();
  const root=await archive(`https://codeload.github.com/octanejs/octane/tar.gz/${source.commit}`,'source',work,b=>assert.equal(sha256(b),source.sha256));
  const npm=await archive('https://registry.npmjs.org/octane/-/octane-0.18.0.tgz','npm',work,b=>assert.equal('sha512-'+createHash('sha512').update(b).digest('base64'),integrity));
  const pkg=path.join(root,'packages/octane');
  const original=fs.readFileSync(path.join(pkg,'src/compiler/text-types-ts7.js'));
  assert.deepEqual(original,fs.readFileSync(path.join(npm,'dist/compiler/text-types-ts7.js')),'npm/source backend must be byte-identical');
  const deps=path.join(work,'deps');fs.mkdirSync(deps);
  for(const [a,b] of [['build-package.json','package.json'],['build-pnpm-lock.yaml','pnpm-lock.yaml'],['build-workspace.yaml','pnpm-workspace.yaml']]) fs.copyFileSync(path.join(here,a),path.join(deps,b));
  const pnpm=process.env.PNPM_BINARY ?? '/Users/satan/.local/share/mise/installs/pnpm/12.21.0/pnpm';
  assert.equal(run(pnpm,['--version'],deps,{stdio:'pipe',encoding:'utf8'}).trim(),'12.21.0');
  disk();register(path.join(deps,'node_modules'),'dependencies');
  run(pnpm,['install','--frozen-lockfile','--ignore-scripts','--config.manage-package-manager-versions=false','--store-dir','/Users/satan/.pnpm-store','--config.package-import-method=clone-or-copy'],deps);
  register(path.join(deps,'node_modules'),'dependencies');
  const modules=path.join(deps,'node_modules');
  fs.symlinkSync(modules,path.join(root,'node_modules'));
  fs.symlinkSync(modules,path.join(work,'node_modules'));
  fs.symlinkSync(modules,path.join(npm,'node_modules'));
  fs.symlinkSync('typescript',path.join(modules,'typescript-native'));
  const fixtures=path.join(work,'fixtures');fs.mkdirSync(fixtures);
  const check=path.join(work,'tsconfig.json');fs.writeFileSync(check,'{"files":[]}');
  const before=spawnSync(process.execPath,['--input-type=module','-e',`import{createTextTypeProject}from${JSON.stringify(path.join(pkg,'src/compiler/typescript.js'))};createTextTypeProject({tsconfig:${JSON.stringify(check)}});`],{cwd:work,encoding:'utf8'});
  assert.notEqual(before.status,0);assert.match(before.stderr,/parsed|reading 'filter'/);console.log('FAIL before: '+before.stderr.split('\n').find(x=>x.includes('TypeError')));
  const probe=run(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import{API}from'typescript/unstable/sync';const api=new API({cwd:process.cwd()});try{const parsed=api.parseConfigFile('tsconfig.json');assert.deepEqual(Object.keys(parsed).sort(),['fileNames','options']);assert.equal(typeof api.parseJsonConfigFileContent,'undefined');assert.throws(()=>api.createSnapshot({}),/createSnapshot is not a function/);console.log('Stable API: parseConfigFile keys',Object.keys(parsed),'createSnapshot absent; updateSnapshot available',typeof api.updateSnapshot);}finally{api.close()}`],work,{stdio:'pipe',encoding:'utf8'});console.log(probe.trim());
  const patch=path.join(here,'typescript-source.patch');
  const checked=spawnSync('git',['apply','--check','--verbose',patch],{cwd:root,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);assert(!/offset|fuzz/i.test(checked.stderr));
  run('git',['apply',patch],root);
  // The upstream fixture runs a classic and a native backend. Give the classic
  // lane its own genuine 6.0.3 install; the native alias names stable 7.0.2.
  const helper=path.join(pkg,'tests/_text-type-project.ts');
  fs.writeFileSync(helper,fs.readFileSync(helper,'utf8').replace("{ name: 'the classic API', typescript: undefined }","{ name: 'the classic API', typescript: dirname(createRequire(import.meta.url).resolve('typescript-classic/package.json')) }"));
  fs.copyFileSync(path.join(here,'compat.test.ts'),path.join(work,'compat.test.ts'));
  // Upstream's owning build copies plain-JS compiler modules unchanged. Rebuild
  // precisely these two modules into the authentic npm layout; no runtime or
  // generated declaration edits, no invented full Octane runtime build.
  register(path.join(work,'dist'),'build');
  for(const name of ['text-types-ts7.js','text-types-config.js']) {
    fs.copyFileSync(path.join(pkg,'src/compiler',name),path.join(work,'dist',name));
    fs.copyFileSync(path.join(work,'dist',name),path.join(npm,'dist/compiler',name));
  }
  for(const mode of ['source','npm']) {
    const compiler=mode==='source'?path.join(pkg,'src/compiler'):path.join(npm,'dist/compiler');
    const cfg=path.join(work,`${mode}.config.mjs`);
    fs.writeFileSync(cfg,`import{defineConfig}from'vitest/config';export default defineConfig({resolve:{alias:[
{find:'octane/compiler/typescript',replacement:${JSON.stringify(compiler+'/typescript.js')}},
{find:'octane/compiler',replacement:${JSON.stringify(compiler+'/index.js')}},
{find:'@fixture',replacement:${JSON.stringify(helper)}},
{find:'@config-adapter',replacement:${JSON.stringify(compiler+'/text-types-config.js')}},
{find:/^typescript$/,replacement:${JSON.stringify(modules+'/typescript-classic/lib/typescript.js')}}
]},test:{environment:'node',include:${JSON.stringify([pkg+'/tests/compiler/typescript-text-inference.test.ts',work+'/compat.test.ts'])},maxWorkers:1}});`);
    disk();run(process.execPath,[modules+'/vitest/vitest.mjs','run','--config',cfg],work,{env:{...process.env,TMPDIR:fixtures}});
  }
  console.log(JSON.stringify({source,octaneIntegrity:integrity,typescript:'7.0.2',oxc:'0.24.0',patchSha256:sha256(fs.readFileSync(patch)),qualification:'source and rebuilt npm compiler modules; existing suite + independent stable diagnostics',fullRuntimeBuild:'parent-owned; pending'},null,2));
} finally {
  for(const dir of [...new Set(registered)].reverse()) run('/Users/satan/bin/disk-guardian-artifacts',['release',dir,'--owner',owner],work);
  fs.rmSync(work,{recursive:true,force:true});
}
