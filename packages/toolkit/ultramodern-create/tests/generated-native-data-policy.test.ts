import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createOctaneWorkerFederationFixtures } from '../../../../tests/ultramodern-renderers/octane-federation-workers/fixtures.mjs';
import { generatedWorkerCoordinates } from '../../../../tests/ultramodern-renderers/octane-federation-workers/generated.mjs';
import { generateOctaneAppSources } from '../../../runtime/renderer-octane/src/plugin/create';
import { generateSolidAppSources } from '../../../runtime/renderer-solid/src/plugin/create';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const require = createRequire(import.meta.url);
const compilerProvider = require(
  path.join(repoRoot, 'scripts/tsrs-dts/compiler.cjs'),
);

test('generated Worker widget passes the shipped strict compiler policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-widget-policy-'));
  try {
    const descriptor = coordinate => ({
      ...coordinate,
      renderer: 'octane',
      packageName: `@proof/${coordinate.id}`,
      manifest: {
        name: `@proof/${coordinate.id}`,
        modernjs: { appId: coordinate.id },
      },
    });
    const fixture = createOctaneWorkerFederationFixtures({
      host: descriptor(generatedWorkerCoordinates.host),
      remotes: generatedWorkerCoordinates.remotes.map(descriptor),
      remoteOrigins: ['http://localhost:4101', 'http://localhost:4102'],
      services: [{ binding: 'A' }, { binding: 'B' }],
      remoteServices: { 'remote-a': [{ binding: 'B' }] },
      dependencies: Object.fromEntries(
        [
          '@modern-js/ultramodern-app-tools',
          '@modern-js/renderer-octane',
          '@modern-js/renderer-core',
          '@modern-js/i18n-runtime-extensions',
          '@tsrx/oxc',
          'octane',
          'i18next',
        ].map(name => [name, '1.0.0']),
      ),
    });
    const remote = fixture.applications[2]!;
    for (const [relative, content] of Object.entries({
      ...Object.fromEntries(
        Object.entries(remote.files).map(([file, value]) => [
          path.join(remote.app.directory, file),
          value,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(fixture.shared).map(([file, value]) => [
          path.join('shared', file),
          value,
        ]),
      ),
    })) {
      const filename = path.join(root, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }
    const rendererRoot = path.join(
      repoRoot,
      'packages/runtime/renderer-octane',
    );
    for (const [name, target] of Object.entries({
      '@modern-js/ultramodern-app-tools': path.join(
        repoRoot,
        'packages/solutions/ultramodern-app-tools',
      ),
      '@modern-js/renderer-octane': rendererRoot,
      octane: fs.realpathSync(path.join(rendererRoot, 'node_modules/octane')),
    })) {
      const link = path.join(root, 'node_modules', name);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, 'dir');
    }
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          ...policy.compilerOptions,
          types: ['@modern-js/ultramodern-app-tools/types'],
          jsxImportSource: 'octane',
          skipLibCheck: false,
          skipDefaultLibCheck: false,
        },
        files: [
          path.join(remote.app.directory, remote.app.exposes['./Widget']),
          path.join(remote.app.directory, 'src/modern-app-env.d.ts'),
        ],
      }),
    );
    for (const compiler of compilers.keys()) {
      const result = spawnSync(
        compiler,
        ['--project', root, '--pretty', 'false'],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, TSRS_CHECKER_ASSIGNMENT: 'go' },
        },
      );
      if (result.error) throw result.error;
      expect({
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
      }).toEqual({ status: 0, output: '' });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
// Resolve through the same reviewed provider as the launcher, but capture only
// compiler output. Supported fallback notices are not TypeScript diagnostics.
// Check the official Go backend locally too, even when this host selects tsrs.
// The pinned tsrs and Go CLIs reject these diagnostics with 2 and 1 respectively.
const compilers = new Map<string, number>([
  [
    compilerProvider.getExePath(),
    compilerProvider.getCompilerPolicy().backend === 'tsrs' ? 2 : 1,
  ],
  [require('@effect/tsgo/lib/getExePath').default(), 1],
]);
const policy = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, '../templates/tsconfig.base.json'),
    'utf8',
  ),
);

test.each([
  ['solid', generateSolidAppSources],
  ['octane', generateOctaneAppSources],
] as const)(
  '%s starter data handlers pass the shipped Effect compiler policy',
  (renderer, generate) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `native-${renderer}-policy-`),
    );
    try {
      const source = generate({
        appId: 'shell-super-app',
        title: 'Native starter',
        sourceExtension: '.tsx',
        jsxImportSource: renderer === 'octane' ? 'octane' : '@solidjs/web',
        capabilities: { ssr: true, federation: false },
      }).artifacts.find(
        artifact => artifact.path === 'src/routes/page.data.ts',
      );
      expect(source).toBeDefined();
      const dataPath = path.join(root, 'page.data.ts');
      fs.writeFileSync(dataPath, source!.content);
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            ...policy.compilerOptions,
            types: [],
            skipLibCheck: false,
            skipDefaultLibCheck: false,
            // Match an installed consumer's real declaration entrypoint,
            // rather than checking unpublished framework implementation here.
            paths: {
              '@modern-js/renderer-core/data': [
                path.join(
                  repoRoot,
                  'packages/runtime/renderer-core/dist/types/data/index.d.ts',
                ),
              ],
            },
          },
          files: ['page.data.ts'],
        }),
      );
      const compile = (compiler: string) => {
        const result = spawnSync(
          compiler,
          ['--project', root, '--pretty', 'false'],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
            env: {
              ...process.env,
              TSRS_CHECKER_ASSIGNMENT:
                process.env.TSRS_CHECKER_ASSIGNMENT || 'go',
            },
          },
        );
        if (result.error) throw result.error;
        return {
          status: result.status,
          output: `${result.stdout}${result.stderr}`,
        };
      };
      for (const compiler of compilers.keys()) {
        expect(compile(compiler)).toEqual({ status: 0, output: '' });
      }
      fs.appendFileSync(
        dataPath,
        `
export async function invalidControl(flag: string): Promise<number> {
  if (flag) return 'invalid assignment';
  return 1;
}
`,
      );
      for (const [compiler, diagnosticExitCode] of compilers) {
        const invalid = compile(compiler);
        expect(invalid.status).toBe(diagnosticExitCode);
        for (const diagnostic of ['TS377081', 'TS377029', 'TS2322']) {
          expect(invalid.output).toContain(diagnostic);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
