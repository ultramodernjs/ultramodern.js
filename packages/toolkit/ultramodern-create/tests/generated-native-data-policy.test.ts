import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { generateOctaneAppSources } from '../../../runtime/renderer-octane/src/plugin/create';
import { generateSolidAppSources } from '../../../runtime/renderer-solid/src/plugin/create';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const require = createRequire(import.meta.url);
const compilerProvider = require(
  path.join(repoRoot, 'scripts/tsrs-dts/compiler.cjs'),
);
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
