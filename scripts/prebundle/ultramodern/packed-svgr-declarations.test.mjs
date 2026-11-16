// Installs the packed @modern-js/app-tools-extensions with pnpm and npm next
// to Babel 8 and checks `tools.svgr` option types with library checking on.
// SVGR's own declarations fail there (TS2614/TS2305: they bind the hoisted
// Babel 8 instead of the Babel 7 types they never declare); the published
// `./svgr` declarations must pass, keep `tpl` typed, and load no installed
// SVGR, Babel, SVGO or Prettier declarations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import tsgoInvocation from '../../lib/tsgo-invocation.js';
import { emitSvgrDeclarations } from './public-declarations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const producer = join(root, 'packages/solutions/app-tools-extensions');
const manifest = file => JSON.parse(readFileSync(file, 'utf8'));
const extensions = manifest(join(producer, 'package.json'));
const windows = process.platform === 'win32';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    shell: windows,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
}

function compile(consumer, file) {
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
      '--listFiles',
      file,
    ],
  });
  const result = spawnSync(invocation.command, invocation.argv, {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 120_000,
    shell: invocation.shell,
  });
  if (result.error) throw result.error;
  const lines = `${result.stdout}${result.stderr}`.split(/\r?\n/);
  return {
    status: result.status,
    output: lines.join('\n'),
    errors: lines.filter(line => /error TS\d+:/.test(line)),
    files: lines
      .filter(
        line => /\.d\.[cm]?ts$|\.ts$/.test(line) && !/error TS/.test(line),
      )
      .map(line => line.replaceAll('\\', '/')),
  };
}

// The installed package that owns a loaded declaration file.
function owner(file) {
  const path = file.slice(file.lastIndexOf('/node_modules/') + 14);
  const parts = path.split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

const before = `import type { PluginSvgrOptions } from '@rsbuild/plugin-svgr';
export const options: PluginSvgrOptions = { svgrOptions: { exportType: 'default' } };
`;
const after = `import type { PluginSvgrOptions } from '@modern-js/app-tools-extensions/svgr';
type SvgrOptions = NonNullable<PluginSvgrOptions['svgrOptions']>;
type Template = NonNullable<SvgrOptions['template']>;
type Tpl = Parameters<Template>[1]['tpl'];
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export const tplBuildsTemplateStatements: Equal<ReturnType<Tpl>, ReturnType<Template>> = true;
export const template: Template = ({ componentName, jsx }, { tpl }) =>
  tpl\`const \${componentName} = () => \${jsx};\`;
export const options: PluginSvgrOptions = {
  mixedImport: true,
  parallel: true,
  exclude: /icons/,
  svgrOptions: {
    exportType: 'default',
    icon: 24,
    template,
    prettierConfig: { semi: false },
    jsx: { babelConfig: { plugins: [] } },
    svgoConfig: { plugins: ['preset-default', { name: 'prefixIds', params: { prefix: 'icon' } }] },
  },
};
// @ts-expect-error SVGR exports are 'named' or 'default'.
export const invalidExport: PluginSvgrOptions = { svgrOptions: { exportType: 'component' } };
// @ts-expect-error SVGO custom plugins need fn.
export const invalidSvgo: PluginSvgrOptions = { svgrOptions: { svgoConfig: { plugins: [{ name: 'custom' }] } } };
// @ts-expect-error tpl builds Babel statements.
export const invalidTemplate: Template = (_, { tpl }) => { const count: number = tpl\`x\`; return count; };
`;

test('packed app-tools-extensions publishes self-contained SVGR option declarations', () => {
  const temp = mkdtempSync(
    join(process.env.OWNED_TEMP_DIR ?? tmpdir(), 'packed-svgr-'),
  );
  try {
    const tarballs = join(temp, 'tarballs');
    mkdirSync(tarballs);
    run('pnpm', ['pack', '--pack-destination', tarballs], producer);
    const tarball = join(tarballs, readdirSync(tarballs)[0]);
    // Unreleased workspace packages are not in the SVGR declaration graph;
    // the listed files below prove no stub is loaded.
    const overrides = {};
    for (const [name, range] of Object.entries({
      ...extensions.dependencies,
      ...extensions.peerDependencies,
    })) {
      if (!range.startsWith('workspace:')) continue;
      const stub = join(temp, 'stubs', name);
      mkdirSync(stub, { recursive: true });
      writeFileSync(
        join(stub, 'package.json'),
        JSON.stringify({ name, version: extensions.version }),
      );
      overrides[name] = `file:${stub}`;
    }
    const consumerManifest = {
      private: true,
      dependencies: {
        '@modern-js/app-tools-extensions': `file:${tarball}`,
        '@rsbuild/core': extensions.peerDependencies['@rsbuild/core'],
        '@rsbuild/plugin-svgr':
          extensions.devDependencies['@rsbuild/plugin-svgr'],
      },
      devDependencies: {
        '@babel/core': manifest(join(root, 'package.json')).devDependencies[
          '@babel/core'
        ],
        '@types/node': extensions.devDependencies['@types/node'],
      },
    };
    for (const manager of ['pnpm', 'npm']) {
      const consumer = join(temp, manager);
      mkdirSync(consumer);
      if (manager === 'pnpm') {
        writeFileSync(
          join(consumer, 'package.json'),
          JSON.stringify(consumerManifest),
        );
        writeFileSync(
          join(consumer, 'pnpm-workspace.yaml'),
          `packages: [.]\nautoInstallPeers: false\nstrictPeerDependencies: false\noverrides: ${JSON.stringify(overrides)}\n`,
        );
        run(
          'pnpm',
          ['install', '--ignore-scripts', '--prefer-offline'],
          consumer,
        );
      } else {
        writeFileSync(
          join(consumer, 'package.json'),
          JSON.stringify({ ...consumerManifest, overrides }),
        );
        run(
          'npm',
          [
            'install',
            '--ignore-scripts',
            '--legacy-peer-deps',
            '--no-audit',
            '--no-fund',
          ],
          consumer,
        );
      }
      writeFileSync(join(consumer, 'before.ts'), before);
      writeFileSync(join(consumer, 'after.ts'), after);

      const upstream = compile(consumer, 'before.ts');
      assert.notEqual(upstream.status, 0, `${manager}: ${upstream.output}`);
      for (const [code, member] of [
        ['TS2614', 'TemplateBuilder'],
        ['TS2305', 'TransformOptions'],
      ])
        assert.ok(
          upstream.errors.some(
            error =>
              error.includes('/@svgr/') &&
              error.includes(`error ${code}:`) &&
              error.includes(`'${member}'`),
          ),
          `${manager} ${code}: ${upstream.output}`,
        );
      // Anything else is in SVGR or the Babel 8 declarations it reached.
      for (const error of upstream.errors)
        assert.match(
          error,
          /node_modules\/(@svgr\/[^/]+|@babel\/core)\//,
          `${manager}: ${upstream.output}`,
        );
      console.log(`${manager} before:`, upstream.errors.join('\n'));

      const published = compile(consumer, 'after.ts');
      assert.equal(published.status, 0, `${manager}: ${published.output}`);
      const owners = new Set(
        published.files
          .filter(file => file.includes('/node_modules/'))
          .map(owner),
      );
      for (const name of owners)
        assert.doesNotMatch(
          name,
          /^(@svgr\/|@rsbuild\/plugin-svgr$|svgo$|prettier$|@babel\/|@types\/babel__|@modern-js\/(?!app-tools-extensions$))/,
          `${manager}: loaded ${name}`,
        );
      for (const file of [
        'svgr/svgo/lib/svgo.d.ts',
        'svgr/@babel/types/lib/index.d.ts',
        'svgr/prettier/index.d.ts',
      ])
        assert.ok(
          published.files.some(loaded =>
            loaded.endsWith(`app-tools-extensions/dist/types/${file}`),
          ),
          `${manager}: loaded vendored ${file}`,
        );
      console.log(`${manager} after: strict library check passed`);
    }

    // The SVGR graph of a fresh, unpatched install yields declarations that
    // pass the same consumer; Babel 7 and Prettier types are build inputs.
    const consumer = join(temp, 'pnpm');
    const installed = realpathSync(
      join(consumer, 'node_modules/@modern-js/app-tools-extensions/dist/types'),
    );
    const svgr = join(installed, 'svgr.d.ts');
    writeFileSync(svgr, readFileSync(join(producer, 'src/svgr.ts'), 'utf8'));
    emitSvgrDeclarations(installed, name =>
      realpathSync(
        join(
          name === '@rsbuild/plugin-svgr' ? consumer : producer,
          'node_modules',
          name,
        ),
      ),
    );
    assert.equal(
      readFileSync(svgr, 'utf8'),
      "export type { PluginSvgrOptions } from './svgr/@rsbuild/plugin-svgr/dist/index.js';\n",
    );
    assert.match(
      readFileSync(
        join(
          installed,
          'svgr/@svgr/babel-plugin-transform-svg-component/dist/index.d.ts',
        ),
        'utf8',
      ),
      /import \{ TemplateBuilder \} from '\.\.\/\.\.\/\.\.\/@babel\/template\/index\.js';/,
    );
    const fresh = compile(consumer, 'after.ts');
    assert.equal(fresh.status, 0, fresh.output);
    console.log('fresh unpatched SVGR producer: strict library check passed');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
