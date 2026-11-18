import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tsgoInvocation from '../../lib/tsgo-invocation.js';
import { publicDeclarationsPlugin } from './public-declarations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temp = mkdtempSync(
  join(process.env.TMPDIR ?? root, 'public-declarations-'),
);
const modules = join(temp, 'node_modules');
const manifest = file => JSON.parse(readFileSync(file, 'utf8'));
const packages = new Map();
const declared = new Set();

function discover(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (
      !item.isDirectory() ||
      ['node_modules', 'dist', 'compiled', '.git'].includes(item.name)
    )
      continue;
    const child = join(directory, item.name);
    if (existsSync(join(child, 'package.json')))
      packages.set(manifest(join(child, 'package.json')).name, child);
    else discover(child);
  }
}
function link(name, target) {
  const dest = join(modules, name);
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(target, dest, 'dir');
}
function stage(name) {
  if (declared.has(name)) return;
  declared.add(name);
  const source = packages.get(name);
  assert.ok(source, `Missing built framework package ${name}`);
  const dest = join(modules, name);
  cpSync(source, dest, {
    recursive: true,
    filter(file) {
      const part = file.slice(source.length).split('/');
      if (
        part.some(item =>
          ['node_modules', '.git', 'tests', 'docs', 'doc_build'].includes(item),
        )
      )
        return false;
      return (
        statSync(file).isDirectory() ||
        /(?:\.d\.[cm]?ts|package\.json)$/.test(file)
      );
    },
  });
  const pkg = manifest(join(source, 'package.json'));
  if (pkg.publishConfig?.types) pkg.types = pkg.publishConfig.types;
  writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg));
  for (const dep of Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
  })) {
    if (packages.has(dep)) stage(dep);
    else if (existsSync(join(source, 'node_modules', dep)))
      link(dep, realpathSync(join(source, 'node_modules', dep)));
  }
}
function compile(file) {
  const invocation = tsgoInvocation.createTsgoInvocation({
    requireFrom: createRequire(import.meta.url),
    args: [
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'false',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--target',
      'esnext',
      '--types',
      'node',
      '--typeRoots',
      join(modules, '@types'),
      file,
    ],
  });
  const result = spawnSync(invocation.command, invocation.argv, {
    cwd: temp,
    encoding: 'utf8',
    timeout: 120000,
    shell: invocation.shell,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
const positive = `import { chokidar, inquirer, lodash, upath } from '@modern-js/utils';
import { defineConfig } from '@modern-js/app-tools';
import type { AppUserConfig } from '@modern-js/ultramodern-app-tools';
const watcher = chokidar.watch('src/**/*.ts');
watcher.add(['src/**/*.tsx']).unwatch('src/generated/**');
const closed: Promise<void> = watcher.close();
const answer: Promise<{ name: string }> = inquirer.prompt<{ name: string }>([{ type: 'input', name: 'name', message: 'Name' }]);
const prompt = new inquirer.ui.Prompt({}, {});
const values: string[] = lodash.map([{ name: 'yes' }], item => item.name);
const weak = new WeakMap<symbol, string>();
weak.set(Symbol(), 'valid modern weak key');
const normalized: string = upath.win32.normalize('a/b');
defineConfig({ tools: { sass: { api: 'modern', sassOptions: { style: 'compressed' }, additionalData: (content, context) => String(content) + context.resourcePath } }, output: { svgDefaultExport: 'component' } });
defineConfig({ tools: { sass: { api: 'legacy', sassOptions: { outputStyle: 'compressed', includePaths: ['src'] } } }, output: { svgDefaultExport: 'url' } });
const compressed: AppUserConfig = { tools: { minifyCss: options => { options.parallel = 2; options.warningsFilter = (warning, file) => file.endsWith('.css'); return options; } }, output: { precompress: { gzip: { threshold: 1024, filename: data => String(data.filename) + '.gz', compressionOptions: { level: 6 } }, brotli: false } } };
void compressed;
const svgr: AppUserConfig = { tools: { svgr: { svgrOptions: { exportType: 'default', svgoConfig: { plugins: ['preset-default'] }, template: ({ componentName, jsx }, { tpl }) => tpl\`const \${componentName} = () => \${jsx};\` } } } };
void svgr;
`;
try {
  discover(join(root, 'packages'));
  mkdirSync(modules, { recursive: true });
  stage('@modern-js/utils');
  stage('@modern-js/app-tools');
  stage('@modern-js/ultramodern-app-tools');
  link(
    '@types/node',
    realpathSync(join(root, 'packages/toolkit/utils/node_modules/@types/node')),
  );
  const utils = join(modules, '@modern-js/utils/dist/compiled');
  // Accept the current worktree's actual build before exercising the producer.
  // No compiler aliases, ambient shims, consumer React types, or Webpack install.
  cpSync(join(root, 'packages/toolkit/utils/dist/compiled'), utils, {
    recursive: true,
  });
  const file = join(temp, 'positive.ts');
  writeFileSync(file, positive);
  const built = compile(file);
  assert.equal(built.status, 0, built.output);
  console.log(
    'BUILT Utils/AppTools/fork composition: strict TS7 + Node-only consumer passed',
  );
  // Check the generated dependency declarations without package-build repairs.
  rmSync(utils, { recursive: true });
  cpSync(join(root, 'packages/toolkit/utils/compiled'), utils, {
    recursive: true,
  });
  const baseline = compile(file);
  assert.equal(baseline.status, 0, baseline.output);
  const runtimeBefore = readdirSync(utils, { recursive: true })
    .filter(name => /\.[cm]?js$/.test(name))
    .sort();
  const runtimeBytes = new Map(
    runtimeBefore.map(name => [name, readFileSync(join(utils, name))]),
  );
  link(
    'rxjs',
    realpathSync(join(root, 'packages/toolkit/utils/node_modules/rxjs')),
  );
  // SVGR declaration inputs of the app-tools-extensions producer.
  for (const name of ['@rsbuild/plugin-svgr', '@types/babel__core', 'prettier'])
    link(
      name,
      realpathSync(
        join(
          packages.get('@modern-js/app-tools-extensions'),
          'node_modules',
          name,
        ),
      ),
    );
  for (const kind of ['builder', 'app-tools-extensions']) {
    let emit;
    publicDeclarationsPlugin(kind).setup({
      context: { rootPath: join(modules, `@modern-js/${kind}`) },
      onAfterBuild(handler) {
        emit = handler;
      },
    });
    emit();
  }
  const runtimeFiles = readdirSync(utils, { recursive: true })
    .filter(name => /\.[cm]?js$/.test(name))
    .sort();
  assert.deepEqual(runtimeFiles, runtimeBefore, 'Runtime file set changed');
  for (const name of runtimeFiles)
    assert.deepEqual(
      readFileSync(join(utils, name)),
      runtimeBytes.get(name),
      `Runtime changed: ${name}`,
    );
  const require = createRequire(join(temp, 'runtime.cjs'));
  const watcher = require(join(utils, 'chokidar/index.js')).watch([], {
    persistent: false,
  });
  assert.equal('ref' in watcher, false);
  assert.equal('unref' in watcher, false);
  await watcher.close();
  const result = compile(file);
  console.log(
    'RUNTIME',
    runtimeFiles.length,
    'unchanged modules; watcher wrapper has no ref/unref',
  );
  assert.equal(result.status, 0, result.output);
  const negative = join(temp, 'negative.ts');
  writeFileSync(
    negative,
    `import { chokidar, inquirer, upath } from '@modern-js/utils';
import { defineConfig } from '@modern-js/app-tools';
import type { AppUserConfig } from '@modern-js/ultramodern-app-tools';
chokidar.watch('src').ref();
inquirer.prompt<{ name: string }>([{ type: 'input', name: 'name', message: 'Name' }]).then(value => { const invalid: number = value.name; });
upath.win32.normalize(42);
defineConfig({ tools: { sass: { api: 'invalid' } }, output: { svgDefaultExport: 'invalid' } });
defineConfig({ tools: { minifyCss: { parallel: 'invalid' } } });
const invalidCompression: AppUserConfig = { output: { precompress: { gzip: { threshold: 'invalid' } } } };
const invalidSvgr: AppUserConfig = { tools: { svgr: { svgrOptions: { exportType: 'component' } } } };
`,
  );
  const rejected = compile(negative);
  assert.notEqual(rejected.status, 0);
  console.log(
    'Public Utils/AppTools/fork composition strict TypeScript 7 + Node 26 declaration cone passed.',
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
