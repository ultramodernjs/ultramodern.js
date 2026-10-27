import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateOctaneAppSources } from '../../../runtime/renderer-octane/src/plugin/create';
import { generateSolidAppSources } from '../../../runtime/renderer-solid/src/plugin/create';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const compilerWrapper = path.join(repoRoot, 'scripts/with-effect-tsrs.mjs');
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
      const compile = () => {
        const result = spawnSync(
          process.execPath,
          [compilerWrapper, '--project', root, '--pretty', 'false'],
          { cwd: root, encoding: 'utf8', timeout: 30_000 },
        );
        if (result.error) throw result.error;
        return {
          status: result.status,
          output: `${result.stdout}${result.stderr}`,
        };
      };
      expect(compile()).toEqual({ status: 0, output: '' });
      fs.appendFileSync(
        dataPath,
        `
export async function invalidControl(flag: string): Promise<number> {
  if (flag) return 'invalid assignment';
  return 1;
}
`,
      );
      const invalid = compile();
      expect(invalid.status).toBe(2);
      for (const diagnostic of ['TS377081', 'TS377029', 'TS2322']) {
        expect(invalid.output).toContain(diagnostic);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
