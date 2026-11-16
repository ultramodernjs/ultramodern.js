// Proves patches/@svgr__babel-plugin-transform-svg-component@8.0.0.patch in an
// isolated pnpm workspace shaped like the repository: Babel 8 latest at the
// root, and a member that reaches SVGR 8 next to the transitive packages the
// repository already hoists for SVGR's other type imports (@types/babel__core
// from the builder, svgo from @svgr/plugin-svgo, prettier).
//
// Unpatched, SVGR's declaration imports TemplateBuilder from @babel/template,
// which it does not declare; pnpm's hidden hoist binds Babel 8, which has no
// such export, and strict TypeScript 7 fails with TS2614. Patched, tpl is typed
// from template on its declared @babel/core peer, exactly as the runtime builds
// it, and strict TypeScript 7 passes on a normal and a frozen offline install.
//
// owned-temp-dir --run svgr-corrections -- env PNPM_BINARY=<pnpm 12.21.0> \
//   node scripts/ultramodern-dependencies/svgr-corrections/qualify.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const temporary = process.env.OWNED_TEMP_DIR;
assert(temporary, 'Run under owned-temp-dir --run svgr-corrections');
const pnpm = process.env.PNPM_BINARY || 'pnpm';
const root = JSON.parse(
  fs.readFileSync(path.join(repo, 'package.json'), 'utf8'),
);
const patchName = '@svgr__babel-plugin-transform-svg-component@8.0.0.patch';
const workspace = path.join(temporary, 'workspace');
const member = path.join(workspace, 'member');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: 'true', TMPDIR: temporary },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
function succeed(command, args) {
  const result = run(command, args);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.output}`,
  );
  return result.output;
}
function write(file, value) {
  fs.writeFileSync(
    path.join(workspace, file),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}
function settings(patched) {
  const lines = ['packages:', '  - member', 'nodeLinker: isolated'];
  if (patched)
    lines.push(
      'patchedDependencies:',
      `  '@svgr/babel-plugin-transform-svg-component@8.0.0': patches/${patchName}`,
    );
  return `${lines.join('\n')}\n`;
}
function typecheck() {
  return run(path.join(workspace, 'node_modules/.bin/tsc'), [
    '-p',
    member,
    '--traceResolution',
  ]);
}
function errors(output) {
  return output
    .split('\n')
    .filter(line => / error TS\d+:/.test(line))
    .map(line => line.replace(/^.*\/(?=[^/]+\/dist\/)/, ''));
}
function assertPatchedPass(label) {
  const { status, output } = typecheck();
  assert.deepEqual(errors(output), [], `${label}: strict TypeScript 7 errors`);
  assert.equal(status, 0, `${label}: tsc exit status`);
  assert.doesNotMatch(
    output,
    /Resolving module '@babel\/template' from '[^']*@svgr\/babel-plugin-transform-svg-component\//,
    `${label}: SVGR must not import the undeclared @babel/template`,
  );
  console.log(
    `pass after (${label}): strict TypeScript 7 accepts the patched SVGR graph`,
  );
}

fs.mkdirSync(path.join(member), { recursive: true });
fs.mkdirSync(path.join(workspace, 'patches'));
const pnpmVersion = succeed(pnpm, ['--version']).trim();
assert.equal(
  `pnpm@${pnpmVersion}`,
  root.packageManager,
  'Use the repository pnpm',
);
write('package.json', {
  name: 'svgr-correction-proof',
  private: true,
  devDependencies: {
    '@babel/core': root.devDependencies['@babel/core'],
    typescript: root.devDependencies.typescript,
  },
});
write('member/package.json', {
  name: 'member',
  private: true,
  dependencies: {
    '@svgr/core': '8.1.0',
    '@types/babel__core': '7.20.5',
    prettier: '3.10.1',
    svgo: '3.3.5',
  },
});
write('member/tsconfig.json', {
  compilerOptions: {
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: [],
  },
  include: ['proof.ts'],
});
write(
  'member/proof.ts',
  `import type { Config } from '@svgr/core';

type Template = NonNullable<Config['template']>;
type Tpl = Parameters<Template>[1]['tpl'];
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export const tplBuildsTemplateStatements: Equal<
  ReturnType<Tpl>,
  ReturnType<Template>
> = true;
export const template: Template = ({ componentName, jsx }, { tpl }) =>
  tpl\`const \${componentName} = () => \${jsx};\`;
`,
);

write('pnpm-workspace.yaml', settings(false));
succeed(pnpm, ['install', '--no-frozen-lockfile']);
const before = typecheck();
assert.notEqual(before.status, 0, 'unpatched graph must fail');
// The unresolved builder also erases tpl, so the precision check fails too.
assert.deepEqual(errors(before.output).sort(), [
  `babel-plugin-transform-svg-component/dist/index.d.ts(2,10): error TS2614: Module '"@babel/template"' has no exported member 'TemplateBuilder'. Did you mean to use 'import TemplateBuilder from "@babel/template"' instead?`,
  `member/proof.ts(10,14): error TS2322: Type 'true' is not assignable to type 'false'.`,
]);
assert.match(
  before.output,
  /Module name '@babel\/template' was successfully resolved to '[^']*' with Package ID '@babel\/template\/lib\/index\.d\.ts@8\./,
);
console.log(
  'fail before: SVGR binds its undeclared @babel/template import to Babel 8 (TS2614)',
);

fs.copyFileSync(
  path.join(repo, 'patches', patchName),
  path.join(workspace, 'patches', patchName),
);
write('pnpm-workspace.yaml', settings(true));
succeed(pnpm, ['install', '--no-frozen-lockfile']);
assertPatchedPass('normal install');

fs.rmSync(path.join(workspace, 'node_modules'), {
  recursive: true,
  force: true,
});
fs.rmSync(path.join(member, 'node_modules'), { recursive: true, force: true });
succeed(pnpm, ['install', '--frozen-lockfile', '--offline']);
assertPatchedPass('frozen offline install');
