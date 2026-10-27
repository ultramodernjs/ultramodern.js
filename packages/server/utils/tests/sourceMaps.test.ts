import { fs } from '@modern-js/utils';
import os from 'os';
import path from 'path';
import { compile } from '../src';

describe('server source-map policy', () => {
  it.each([
    [false, false],
    [{ js: false }, false],
    [{ js: 'source-map' }, true],
    [undefined, true],
  ] as const)(
    'honors %j while preserving executable output',
    async (sourceMap, enabled) => {
      const appDirectory = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'server-source-maps-')),
      );
      const sourceDir = path.join(appDirectory, 'server');
      const distDir = path.join(appDirectory, 'dist');
      const tsconfigPath = path.join(appDirectory, 'tsconfig.json');
      try {
        await fs.outputJSON(tsconfigPath, {
          compilerOptions: { module: 'commonjs', target: 'ES2022', types: [] },
          include: ['server'],
        });
        await fs.outputFile(
          path.join(sourceDir, 'index.ts'),
          'export const answer: number = 42;\n',
        );
        await compile(
          appDirectory,
          { sourceMap },
          {
            sourceDirs: [sourceDir],
            distDir,
            tsconfigPath,
            throwErrorInsteadOfExit: true,
          },
        );
        const output = path.join(distDir, 'server/index.js');
        expect(await fs.pathExists(`${output}.map`)).toBe(enabled);
        expect(
          (await fs.readFile(output, 'utf8')).includes('sourceMappingURL='),
        ).toBe(enabled);
        expect(require(output).answer).toBe(42);
      } finally {
        await fs.remove(appDirectory);
      }
    },
  );
});
