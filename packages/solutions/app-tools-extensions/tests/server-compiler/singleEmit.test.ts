import { pathToFileURL } from 'node:url';
import { fs, logger } from '@modern-js/utils';
import * as actualRslib from '@rslib/core' with { rstest: 'importActual' };
import type { LibConfig } from '@rslib/core';
import os from 'os';
import path from 'path';
import { compileServerSources as compile } from '../../src/server-compiler';

const builds: LibConfig[][] = [];
let omittedOutput: string | undefined;

rstest.mock('@rslib/core', () => ({
  ...actualRslib,
  createRslib: (options: Parameters<typeof actualRslib.createRslib>[0]) => {
    builds.push(options?.config?.lib ?? []);
    return actualRslib.createRslib({
      ...options,
      config: {
        ...options?.config,
        plugins: [
          ...(options?.config?.plugins ?? []),
          {
            name: 'test:omit-server-output',
            setup(api) {
              api.modifyRspackConfig(config => {
                config.plugins ??= [];
                config.plugins.push({
                  apply(compiler) {
                    compiler.hooks.thisCompilation.tap(
                      'test:omit-output',
                      compilation => {
                        compilation.hooks.processAssets.tap(
                          {
                            name: 'test:omit-output',
                            stage:
                              compiler.webpack.Compilation
                                .PROCESS_ASSETS_STAGE_REPORT,
                          },
                          () => {
                            if (omittedOutput)
                              compilation.deleteAsset(omittedOutput);
                          },
                        );
                      },
                    );
                  },
                });
              });
            },
          },
        ],
      },
    });
  },
}));

const app = async (prefix: string) => {
  const appDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  return {
    appDirectory,
    distDir: path.join(appDirectory, 'dist'),
    write: (file: string, source: string) =>
      fs.outputFile(path.join(appDirectory, file), source),
  };
};

/**
 * `api/index.ts` reaches six app modules outside the source directory through
 * `source.alias`, tsconfig `paths`, relative, alias-array and cyclic imports.
 */
const writeChain = async (
  write: (file: string, source: string) => Promise<void>,
  level5 = "export const l5 = (): string => '5';\n",
) => {
  await write('api/index.ts', "export { l1 } from '@lib/l1';\n");
  await write(
    'lib/l1.ts',
    "import { l2 } from '@deep/l2';\nexport const l1 = (): string => '1' + l2();\n",
  );
  await write(
    'deep/l2.ts',
    "import { l3 } from './nested/l3';\nexport const l2 = (): string => '2' + l3();\n",
  );
  await write(
    'deep/nested/l3.ts',
    "import { l4 } from '~/l4';\nexport const l4Proxy = l4;\nexport const l3 = (): string => '3' + l4();\n",
  );
  await write(
    'more/l4.ts',
    "import { l5 } from '../other/l5';\nexport const l4 = (): string => '4' + l5();\n",
  );
  await write(
    'other/l5.ts',
    `import { l6 } from '@lib/l6';\n${level5.replace("'5'", "'5' + l6()")}`,
  );
  // l6 closes a cycle back to l1; only its value import is used lazily.
  await write(
    'lib/l6.ts',
    "import * as one from './l1';\nexport const l6 = (): string => (typeof one.l1 === 'function' ? '6' : 'x');\n",
  );
};

const chainConfig = (appDirectory: string) => ({
  alias: { '@lib': './lib', '~': ['./missing', './more'] },
  tsconfig: {
    compilerOptions: {
      declaration: true,
      module: 'commonjs',
      target: 'ES2022',
      types: [],
      paths: {
        '@lib/*': ['./lib/*'],
        '@deep/*': ['./deep/*'],
        '~/*': ['./more/*'],
      },
    },
    include: ['api'],
  },
  tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
});

describe('single server emit', () => {
  beforeEach(() => {
    builds.length = 0;
    omittedOutput = undefined;
  });

  it('keeps temporary resolved configs out of output when the config is under API sources', async () => {
    const { appDirectory, distDir, write } = await app('server-config-asset-');
    try {
      const tsconfigPath = path.join(appDirectory, 'api/tsconfig.json');
      await fs.outputJSON(tsconfigPath, { compilerOptions: { types: [] } });
      await write('api/index.ts', 'export const value = 42;\n');
      // Another generation may own a resolved config in the same directory.
      await write('api/.tsgo.123.456.resolved.json', '{}');
      const result = await compile(
        appDirectory,
        { sourceMap: false },
        {
          sourceDirs: [path.join(appDirectory, 'api')],
          distDir,
          tsconfigPath,
          throwErrorInsteadOfExit: true,
        },
      );
      expect(result.emittedFiles).toEqual([path.join(distDir, 'api/index.js')]);
      expect(await fs.readdir(path.join(distDir, 'api'))).toEqual(['index.js']);
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it.each(['api/index.js', 'lib/child.js'])(
    'rejects a missing emitted source %s and removes the other emitted files',
    async missing => {
      const { appDirectory, distDir, write } = await app(
        'server-missing-output-',
      );
      try {
        const tsconfigPath = path.join(appDirectory, 'tsconfig.json');
        await fs.outputJSON(tsconfigPath, {
          compilerOptions: { types: [] },
          include: ['api'],
        });
        await write('api/index.ts', "export { value } from '../lib/child';\n");
        await write('lib/child.ts', 'export const value = 42;\n');
        omittedOutput = missing;
        await expect(
          compile(
            appDirectory,
            { sourceMap: false },
            {
              sourceDirs: [path.join(appDirectory, 'api')],
              distDir,
              tsconfigPath,
              throwErrorInsteadOfExit: true,
            },
          ),
        ).rejects.toThrow('did not emit');
        for (const file of ['api/index.js', 'lib/child.js'])
          expect(await fs.pathExists(path.join(distDir, file))).toBe(false);
      } finally {
        await fs.remove(appDirectory);
      }
    },
  );

  // These are valid POSIX filenames, but Windows disallows pipes and uses
  // backslash as its path separator.
  (process.platform === 'win32' ? it.skip : it).each(['pipe', 'backslash'])(
    'never reports successful incomplete output for a literal %s filename',
    async name => {
      const { appDirectory, distDir, write } = await app(
        'server-literal-glob-',
      );
      try {
        const tsconfigPath = path.join(appDirectory, 'tsconfig.json');
        await fs.outputJSON(tsconfigPath, {
          compilerOptions: { types: [] },
          include: ['api'],
        });
        await write(
          'api/index.ts',
          name === 'pipe'
            ? "export { value } from '../lib/a|b';\n"
            : 'export const value = 42;\n',
        );
        if (name === 'pipe')
          await write('lib/a|b.ts', 'export const value = 42;\n');
        else await write('api/a\\b.ts', 'export const other = 1;\n');
        const result = compile(
          appDirectory,
          { sourceMap: false },
          {
            compiler: () => ({
              command: {
                executable: process.execPath,
                args: ['-e', 'process.exit(0)', '--'],
              },
              readConfig: async () => ({
                files:
                  name === 'pipe'
                    ? ['api/index.ts']
                    : ['api/index.ts', 'api/a\\b.ts'],
              }),
              declarationPlugin: () => {
                throw new Error('Declarations not requested');
              },
            }),
            sourceDirs: [path.join(appDirectory, 'api')],
            distDir,
            tsconfigPath,
            throwErrorInsteadOfExit: true,
          },
        );
        if (name === 'pipe') {
          expect((await result).emittedFiles).toEqual(
            ['api/index.js', 'lib/a|b.js']
              .map(file => path.join(distDir, file))
              .sort(),
          );
          expect(require(path.join(distDir, 'api/index.js')).value).toBe(42);
        } else {
          // Rslib normalizes literal backslashes as separators. That
          // unsupported mapping must fail and clean up, never report success.
          await expect(result).rejects.toThrow('did not emit');
          expect(await fs.pathExists(path.join(distDir, 'api/index.js'))).toBe(
            false,
          );
        }
      } finally {
        await fs.remove(appDirectory);
      }
    },
  );

  it('discovers a deep aliased chain once, then emits and declares it once', async () => {
    const { appDirectory, distDir, write } = await app('server-single-emit-');
    try {
      const { alias, tsconfig, tsconfigPath } = chainConfig(appDirectory);
      await fs.outputJSON(tsconfigPath, tsconfig);
      await writeChain(write);
      // A previous build's file is not part of this compilation's inventory.
      await fs.outputFile(path.join(distDir, 'api/stale.js'), 'stale');

      const result = await compile(
        appDirectory,
        { alias, sourceMap: false },
        {
          sourceDirs: [path.join(appDirectory, 'api')],
          distDir,
          tsconfigPath,
          throwErrorInsteadOfExit: true,
        },
      );

      expect(builds.map(libs => libs.map(lib => lib.bundle))).toEqual([
        [true],
        [false],
      ]);
      expect(builds.map(libs => libs.some(lib => lib.dts))).toEqual([
        false,
        true,
      ]);
      const modules = [
        'api/index',
        'deep/l2',
        'deep/nested/l3',
        'lib/l1',
        'lib/l6',
        'more/l4',
        'other/l5',
      ];
      expect(result).toEqual({
        rootFiles: [path.join(distDir, 'api/index.js')],
        emittedFiles: modules
          .flatMap(file => [`${file}.d.ts`, `${file}.js`])
          .map(file => path.join(distDir, file))
          .sort(),
      });
      expect(
        await fs.readFile(path.join(distDir, 'other/l5.d.ts'), 'utf8'),
      ).toContain('export declare const l5: () => string;');
      expect(require(path.join(distDir, 'api/index.js')).l1()).toBe('123456');
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it('emits JSON, assets, bracketed routes and every module format', async () => {
    const { appDirectory, distDir, write } = await app('server-single-mixed-');
    try {
      const tsconfigPath = path.join(appDirectory, 'tsconfig.json');
      await fs.outputJSON(tsconfigPath, {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          resolveJsonModule: true,
          target: 'ES2022',
          types: [],
        },
        include: ['api'],
      });
      await write('package.json', '{"type":"commonjs"}\n');
      await write('data/config.json', '{"value":7}\n');
      await write('api/readme.md', '# routes\n');
      await write(
        'api/[id].ts',
        "import data = require('../data/config.json');\nexport const id: number = data.value;\n",
      );
      await write('api/esm.mts', "export const format: string = 'esm';\n");
      await write(
        'api/legacy.cts',
        "import data = require('../data/config.json');\nexport const legacy: number = data.value + 1;\n",
      );

      const result = await compile(
        appDirectory,
        { sourceMap: false },
        {
          sourceDirs: [path.join(appDirectory, 'api')],
          distDir,
          tsconfigPath,
          throwErrorInsteadOfExit: true,
        },
      );

      expect(builds.map(libs => libs.map(lib => lib.format))).toEqual([
        ['cjs', 'esm', 'cjs'],
        ['cjs', 'esm', 'cjs'],
      ]);
      const roots = ['api/[id].js', 'api/esm.mjs', 'api/legacy.cjs'];
      expect([...result.rootFiles].sort()).toEqual(
        roots.map(file => path.join(distDir, file)),
      );
      expect(result.emittedFiles).toEqual(
        [...roots, 'api/readme.md', 'data/config.json']
          .map(file => path.join(distDir, file))
          .sort(),
      );
      expect(require(path.join(distDir, 'api/[id].js')).id).toBe(7);
      expect(require(path.join(distDir, 'api/legacy.cjs')).legacy).toBe(8);
      expect(
        (await import(pathToFileURL(path.join(distDir, 'api/esm.mjs')).href))
          .format,
      ).toBe('esm');
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it.each([true, false])(
    'checks a transitive alias before emitting with noEmitOnError=%s',
    async noEmitOnError => {
      const { appDirectory, distDir, write } = await app(
        'server-single-blocking-',
      );
      const warn = rstest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const { alias, tsconfig, tsconfigPath } = chainConfig(appDirectory);
        await fs.outputJSON(tsconfigPath, {
          ...tsconfig,
          compilerOptions: { ...tsconfig.compilerOptions, noEmitOnError },
        });
        await writeChain(
          write,
          "export const l5 = (): string => '5';\nexport const wrong: string = 5;\n",
        );
        const result = compile(
          appDirectory,
          { alias },
          {
            sourceDirs: [path.join(appDirectory, 'api')],
            distDir,
            tsconfigPath,
            throwErrorInsteadOfExit: true,
          },
        );
        if (noEmitOnError) {
          await expect(result).rejects.toThrow(/other\/l5\.ts.*TS2322/u);
          expect(await fs.pathExists(distDir)).toBe(false);
          // Discovery ran; the emit never started.
          expect(builds).toHaveLength(1);
        } else {
          await expect(result).resolves.toMatchObject({
            rootFiles: [path.join(distDir, 'api/index.js')],
          });
          expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/other\/l5\.ts.*TS2322/u),
          );
          expect(require(path.join(distDir, 'api/index.js')).l1()).toBe(
            '123456',
          );
        }
        expect(
          (await fs.readdir(appDirectory)).filter(file =>
            file.endsWith('.resolved.json'),
          ),
        ).toEqual([]);
      } finally {
        warn.mockRestore();
        await fs.remove(appDirectory);
      }
    },
  );
});
