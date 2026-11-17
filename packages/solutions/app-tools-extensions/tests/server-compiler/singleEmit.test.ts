import { fs, logger } from '@modern-js/utils';
import * as actualRslib from '@rslib/core' with { rstest: 'importActual' };
import type { LibConfig } from '@rslib/core';
import os from 'os';
import path from 'path';
import { compileServerSources as compile } from '../../src/server-compiler';

const builds: LibConfig[][] = [];

rstest.mock('@rslib/core', () => ({
  ...actualRslib,
  createRslib: (options: Parameters<typeof actualRslib.createRslib>[0]) => {
    builds.push(options?.config?.lib ?? []);
    return actualRslib.createRslib(options);
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
  });

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
      expect((await import(path.join(distDir, 'api/esm.mjs'))).format).toBe(
        'esm',
      );
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
