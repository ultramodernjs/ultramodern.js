import { fs } from '@modern-js/utils';
import type { RsbuildPlugin } from '@rslib/core';
import os from 'os';
import path from 'path';
import {
  compileServerSources as compile,
  type DeclarationPluginOptions,
  type ServerCompiler,
} from '../../src/server-compiler';
import {
  createResolvedTsgoConfig,
  getTsgoBinPath,
  runTsgo,
} from '../../src/server-compiler/tsgo';

const unrequestedDeclarations = (): never => {
  throw new Error('Declarations were not requested');
};

/**
 * A provider-bound declaration emitter: a real Rsbuild plugin that runs the
 * stable TS-Go over the build's tsconfig after the JavaScript output.
 */
const declarationProvider = (appDirectory: string) => {
  const tsgo = getTsgoBinPath(appDirectory);
  const requested: DeclarationPluginOptions[] = [];
  let emits = 0;
  const compiler: ServerCompiler = {
    command: { executable: process.execPath, args: [tsgo] },
    readConfig: async tsconfigPath =>
      JSON.parse(
        (
          await runTsgo(tsgo, ['--showConfig', '-p', tsconfigPath], {
            cwd: path.dirname(tsconfigPath),
          })
        ).stdout,
      ),
    declarationPlugin: (options): RsbuildPlugin => {
      requested.push(options);
      return {
        name: 'test:provider-declarations',
        setup(api) {
          let tsconfigPath = '';
          api.onBeforeEnvironmentCompile(({ environment }) => {
            tsconfigPath = environment.config.source.tsconfigPath ?? '';
          });
          api.onAfterBuild(async () => {
            emits += 1;
            const result = await runTsgo(
              tsgo,
              [
                '-p',
                tsconfigPath,
                '--emitDeclarationOnly',
                '--outDir',
                options.distPath,
              ],
              { cwd: appDirectory, reject: false },
            );
            if (result.code !== 0 && options.abortOnError) {
              throw new Error(
                `Provider declarations failed:\n${result.stdout}`,
              );
            }
          });
        },
      };
    },
  };
  return { compiler, requested, emits: () => emits };
};

const declarationApp = async (prefix: string, noEmitOnError = true) => {
  const appDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
    compilerOptions: {
      declaration: true,
      module: 'nodenext',
      target: 'es2022',
      types: [],
      noEmitOnError,
    },
    include: ['api'],
  });
  return appDirectory;
};

const resolvedConfigs = async (directory: string) =>
  (await fs.readdir(directory)).filter(file => file.endsWith('.resolved.json'));

describe('neutral server compiler provider', () => {
  it('clears inherited emit, cache and deprecated options without restoring client roots', async () => {
    const appDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'server-compiler-inherited-'),
    );
    try {
      const { config } = await createResolvedTsgoConfig(
        appDirectory,
        path.join(appDirectory, 'tsconfig.json'),
        [path.join(appDirectory, 'api')],
        {
          readConfig: async () => ({
            extends: './base.json',
            compilerOptions: {
              declaration: true,
              incremental: true,
              composite: true,
              emitDeclarationOnly: true,
              tsBuildInfoFile: './cache/server.tsbuildinfo',
              outDir: './authored-output',
              baseUrl: '.',
              paths: { '@shared/*': ['./shared/*'] },
              moduleResolution: 'node10',
            },
            files: ['api/index.ts', 'client/index.ts'],
            include: ['client'],
            references: [{ path: './referenced' }],
          }),
        },
      );
      expect(config.compilerOptions).toMatchObject({
        incremental: false,
        composite: false,
        emitDeclarationOnly: false,
        tsBuildInfoFile: null,
        outDir: null,
        baseUrl: null,
        moduleResolution: null,
        paths: { '@shared/*': ['./shared/*'] },
      });
      expect(config.files).toEqual(['api/index.ts']);
      expect(config.include).toEqual([]);
      expect(config.references).toBeUndefined();
    } finally {
      await fs.remove(appDirectory);
    }
  });

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
            process.stdout.write('api/index.d.ts(1,1): error TS99999: selected provider diagnostic');
            process.exit(2);
          `,
              '--',
            ],
          },
          readConfig,
          // Declarations are not requested, so this must never be called.
          declarationPlugin: unrequestedDeclarations,
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
          // Declarations are not emitted, so nothing is written.
          await expect(result).resolves.toEqual({
            rootFiles: [],
            emittedFiles: [],
          });
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
              declarationPlugin: unrequestedDeclarations,
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

  it.each([
    ['a crash without diagnostics', 'segmentation fault', 2, ''],
    ['a config error', 'error TS5023: Unknown compiler option', 1, ''],
    [
      'a config file diagnostic',
      'tsconfig.json(3,5): error TS5024: bad',
      1,
      '',
    ],
    [
      'an unexpected exit status',
      'api/index.ts(1,1): error TS2322: x',
      134,
      '',
    ],
    [
      'a panic after partial diagnostics',
      'api/index.ts(1,1): error TS2322: x',
      2,
      'panic: runtime error: invalid memory address\n',
    ],
  ])(
    'fails on %s even when noEmitOnError=false',
    async (_name, output, code, stderr) => {
      const appDirectory = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'server-compiler-crash-')),
      );
      try {
        await fs.outputFile(
          path.join(appDirectory, 'api/index.ts'),
          'export const answer = 42;\n',
        );
        await expect(
          compile(
            appDirectory,
            {},
            {
              compiler: () => ({
                command: {
                  executable: process.execPath,
                  args: [
                    '-e',
                    `process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code});`,
                    '--',
                  ],
                },
                readConfig: async () => ({
                  compilerOptions: { noEmitOnError: false },
                  files: [path.join(appDirectory, 'api/index.ts')],
                }),
                declarationPlugin: unrequestedDeclarations,
              }),
              sourceDirs: [path.join(appDirectory, 'api')],
              distDir: path.join(appDirectory, 'dist'),
              tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
              throwErrorInsteadOfExit: true,
            },
          ),
        ).rejects.toThrow(`exit code ${code}`);
        expect(await fs.pathExists(path.join(appDirectory, 'dist'))).toBe(
          false,
        );
      } finally {
        await fs.remove(appDirectory);
      }
    },
  );

  it('emits declarations once through each sibling provider plugin across formats', async () => {
    const apps = await Promise.all(
      ['server-compiler-dts-a-', 'server-compiler-dts-b-'].map(prefix =>
        declarationApp(prefix),
      ),
    );
    try {
      const builds = await Promise.all(
        apps.map(async (appDirectory, index) => {
          // `api/index.ts` reaches `lib/value.ts`, which discovery finds;
          // `api/esm.mts` adds a second library.
          await fs.outputFile(
            path.join(appDirectory, 'api/index.ts'),
            "export { value } from '../lib/value';\n",
          );
          await fs.outputFile(
            path.join(appDirectory, 'lib/value.ts'),
            `export const value: number = ${index};\n`,
          );
          await fs.outputFile(
            path.join(appDirectory, 'api/esm.mts'),
            'export const format: string = "esm";\n',
          );
          const provider = declarationProvider(appDirectory);
          const result = await compile(
            appDirectory,
            {},
            {
              compiler: () => provider.compiler,
              sourceDirs: [path.join(appDirectory, 'api')],
              distDir: path.join(appDirectory, 'dist'),
              tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
              throwErrorInsteadOfExit: true,
            },
          );
          return { ...provider, result };
        }),
      );
      for (const [index, appDirectory] of apps.entries()) {
        const dist = path.join(appDirectory, 'dist');
        // The plugin writes to a private directory; only its output moves.
        const [requested, ...others] = builds[index].requested;
        expect(others).toEqual([]);
        expect(requested).toMatchObject({
          abortOnError: true,
          redirect: { extension: false },
        });
        expect(path.relative(appDirectory, requested.distPath)).toMatch(
          /^\.\./u,
        );
        expect(await fs.pathExists(requested.distPath)).toBe(false);
        expect(builds[index].result.emittedFiles).toEqual(
          expect.arrayContaining(
            ['api/index.js', 'api/esm.mjs', 'lib/value.js']
              .concat(['api/index.d.ts', 'api/esm.d.mts', 'lib/value.d.ts'])
              .map(file => path.join(dist, file)),
          ),
        );
        expect(builds[index].result.rootFiles.slice().sort()).toEqual([
          path.join(dist, 'api/esm.mjs'),
          path.join(dist, 'api/index.js'),
        ]);
        expect(builds[index].emits()).toBe(1);
        expect(require(path.join(dist, 'api/index.js')).value).toBe(index);
        expect(
          await fs.readFile(path.join(dist, 'lib/value.d.ts'), 'utf8'),
        ).toContain('export declare const value: number;');
        expect(
          await fs.readFile(path.join(dist, 'api/esm.d.mts'), 'utf8'),
        ).toContain('export declare const format: string;');
        expect(await resolvedConfigs(appDirectory)).toEqual([]);
      }
    } finally {
      await Promise.all(apps.map(app => fs.remove(app)));
    }
  });

  it.each([true, false])(
    'propagates emit-only declaration diagnostics when noEmitOnError=%s and always cleans up',
    async noEmitOnError => {
      const appDirectory = await declarationApp(
        'server-compiler-dts-error-',
        noEmitOnError,
      );
      const provider = declarationProvider(appDirectory);
      const dispose = rstest.fn(async () => {});
      try {
        const tsconfigPath = path.join(appDirectory, 'tsconfig.json');
        await fs.outputFile(
          path.join(appDirectory, 'api/index.ts'),
          'export const broken: string = 42;\n',
        );
        const result = compile(
          appDirectory,
          {},
          {
            // The checker passes, so only the declaration plugin sees the error.
            compiler: () => ({
              ...provider.compiler,
              command: {
                executable: process.execPath,
                args: ['-e', '', '--'],
              },
              dispose,
            }),
            sourceDirs: [path.join(appDirectory, 'api')],
            distDir: path.join(appDirectory, 'dist'),
            tsconfigPath,
            throwErrorInsteadOfExit: true,
          },
        );
        if (noEmitOnError) {
          await expect(result).rejects.toThrow('TS2322');
          // The failed compilation leaves none of its JavaScript behind.
          expect(
            await fs.pathExists(path.join(appDirectory, 'dist/api/index.js')),
          ).toBe(false);
        } else {
          await expect(result).resolves.toMatchObject({
            rootFiles: [path.join(appDirectory, 'dist/api/index.js')],
          });
          expect(
            require(path.join(appDirectory, 'dist/api/index.js')).broken,
          ).toBe(42);
        }
        expect(provider.requested).toEqual([
          expect.objectContaining({ abortOnError: noEmitOnError }),
        ]);
        expect(provider.emits()).toBe(1);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(await resolvedConfigs(appDirectory)).toEqual([]);
      } finally {
        await fs.remove(appDirectory);
      }
    },
  );
});
