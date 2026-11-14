import { fs } from '@modern-js/utils';
import os from 'os';
import path from 'path';
import { compile, type ServerCompiler } from '../src/common';

describe('neutral server compiler provider', () => {
  it('keeps the real stable TypeScript default when no provider is configured', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-compiler-stable-')),
    );
    try {
      await fs.outputFile(
        path.join(appDirectory, 'api/index.ts'),
        'export const answer: number = 42;',
      );
      await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
        compilerOptions: {
          module: 'commonjs',
          target: 'es2022',
          declaration: true,
          types: [],
        },
        include: ['api'],
      });
      await compile(
        appDirectory,
        {},
        {
          sourceDirs: [path.join(appDirectory, 'api')],
          distDir: path.join(appDirectory, 'dist'),
          tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
          throwErrorInsteadOfExit: true,
        },
      );
      expect(require(path.join(appDirectory, 'dist/api/index.js')).answer).toBe(
        42,
      );
      expect(
        await fs.readFile(
          path.join(appDirectory, 'dist/api/index.d.ts'),
          'utf8',
        ),
      ).toContain('export declare const answer: number;');
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it.each([true, false])(
    'runs the supplied executable and argument prefix, preserving noEmitOnError=%s',
    async noEmitOnError => {
      const appDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'server-compiler-provider-'),
      );
      const configFile = path.join(appDirectory, 'tsconfig.json');
      const roots = path.join(appDirectory, 'api');
      const declaration = path.join(roots, 'index.d.ts');
      const disposed = rstest.fn(async () => {});
      const readConfig = rstest.fn(async () => ({
        compilerOptions: { noEmitOnError },
        files: [declaration],
      }));
      const provider = rstest.fn(
        (): ServerCompiler => ({
          command: {
            executable: process.execPath,
            args: [
              '-e',
              `
            const fs = require('node:fs');
            const args = process.argv.slice(1);
            if (args[0] !== '-p' || args[2] !== '--noEmit') process.exit(9);
            const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
            if (config.references || config.compilerOptions.composite) process.exit(8);
            process.stdout.write('TS99999: selected provider diagnostic');
            process.exit(2);
          `,
              '--',
            ],
          },
          readConfig,
          // Declarations are not requested, so this must never be loaded.
          typescriptPath: path.join(appDirectory, 'not-a-compiler.cjs'),
          dispose: disposed,
        }),
      );
      try {
        await fs.outputFile(
          declaration,
          'export declare const answer: number;',
        );
        await fs.writeJSON(configFile, {});
        const result = compile(
          appDirectory,
          {},
          {
            compiler: provider,
            sourceDirs: [roots],
            distDir: path.join(appDirectory, 'dist'),
            tsconfigPath: configFile,
            throwErrorInsteadOfExit: true,
          },
        );
        if (noEmitOnError) {
          await expect(result).rejects.toThrow('selected provider diagnostic');
        } else {
          await expect(result).resolves.toBeUndefined();
        }
        expect(provider).toHaveBeenCalledExactlyOnceWith(appDirectory);
        expect(readConfig).toHaveBeenCalledExactlyOnceWith(configFile);
        expect(disposed).toHaveBeenCalledTimes(1);
        expect(
          (await fs.readdir(appDirectory)).filter(file =>
            file.endsWith('.resolved.json'),
          ),
        ).toEqual([]);
      } finally {
        await fs.remove(appDirectory);
      }
    },
  );

  it('disposes the provider when native config parsing rejects', async () => {
    const appDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'server-compiler-provider-error-'),
    );
    const dispose = rstest.fn(async () => {});
    try {
      await expect(
        compile(
          appDirectory,
          {},
          {
            compiler: () => ({
              command: { executable: process.execPath, args: [] },
              typescriptPath: 'unused',
              readConfig: async () => {
                throw new Error('invalid native config');
              },
              dispose,
            }),
            sourceDirs: [path.join(appDirectory, 'api')],
            distDir: path.join(appDirectory, 'dist'),
            tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
            throwErrorInsteadOfExit: true,
          },
        ),
      ).rejects.toThrow('invalid native config');
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      await fs.remove(appDirectory);
    }
  });
});
