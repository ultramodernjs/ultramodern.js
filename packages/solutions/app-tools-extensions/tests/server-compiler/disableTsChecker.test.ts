import { spawnSync } from 'node:child_process';
import { fs } from '@modern-js/utils';
import os from 'os';
import path from 'path';
import { compileServerSources as compile } from '../../src/server-compiler';
import { getTsgoBinPath } from '../../src/server-compiler/tsgo';

describe('server type-checker policy', () => {
  let appDirectory: string;
  let distDir: string;
  let tsconfigPath: string;
  const authored = {
    compilerOptions: {
      declaration: true,
      module: 'commonjs',
      strict: true,
      target: 'ES2022',
      types: [],
    },
    include: ['server', 'shared'],
  };
  const compileWith = (disableTsChecker?: boolean) =>
    compile(
      appDirectory,
      { disableTsChecker, sourceMap: false },
      {
        sourceDirs: [path.join(appDirectory, 'server')],
        distDir,
        tsconfigPath,
        throwErrorInsteadOfExit: true,
      },
    );

  beforeEach(async () => {
    appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-ts-checker-')),
    );
    distDir = path.join(appDirectory, 'dist');
    tsconfigPath = path.join(appDirectory, 'tsconfig.json');
    await fs.outputJSON(tsconfigPath, authored);
    await fs.outputFile(
      path.join(appDirectory, 'server/index.ts'),
      "export { answer } from '../shared/answer';\n",
    );
    // Reached only through the closure, outside the source directory.
    await fs.outputFile(
      path.join(appDirectory, 'shared/answer.ts'),
      'export const answer: number = 42;\nexport const invalid: string = 42;\n',
    );
  });

  afterEach(() => fs.remove(appDirectory));

  it('fails the build on a type error by default and emits nothing', async () => {
    await expect(compileWith()).rejects.toThrow(/TS2322/u);
    expect(await fs.pathExists(distDir)).toBe(false);
  });

  it('emits the unchecked closure and its declarations only when disabled, while the independent checker still fails', async () => {
    const result = await compileWith(true);
    const server = path.join(distDir, 'server/index.js');
    const shared = path.join(distDir, 'shared/answer.js');
    expect(result).toEqual({
      rootFiles: [server],
      emittedFiles: [
        path.join(distDir, 'server/index.d.ts'),
        server,
        path.join(distDir, 'shared/answer.d.ts'),
        shared,
      ].sort(),
    });
    expect(require(server).answer).toBe(42);
    expect(
      await fs.readFile(path.join(distDir, 'shared/answer.d.ts'), 'utf8'),
    ).toContain('invalid: string');
    expect(await fs.readJSON(tsconfigPath)).toEqual(authored);
    const checked = spawnSync(
      process.execPath,
      [getTsgoBinPath(appDirectory), '-p', tsconfigPath, '--noEmit'],
      { cwd: appDirectory, encoding: 'utf8' },
    );
    expect(checked.status).not.toBe(0);
    expect(checked.stdout).toContain('TS2322');
  });
});
