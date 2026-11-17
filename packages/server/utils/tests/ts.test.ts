import { fs, logger } from '@modern-js/utils';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { compile } from '../src';
import { createIsolatedTsExample } from './helpers';

describe('typescript', () => {
  const loadEsmModule = async (distDir: string, entry: string) => {
    await fs.outputJSON(path.join(distDir, 'package.json'), { type: 'module' });
    return import(`${pathToFileURL(entry).href}?t=${Date.now()}`);
  };

  it('excludes requested roots while still checking explicitly imported dependencies', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-utils-root-exclusion-')),
    );
    const sourceDir = path.join(appDirectory, 'api');
    const declaration = path.join(appDirectory, 'src/client.d.ts');
    const options = {
      sourceDirs: [sourceDir],
      distDir: path.join(appDirectory, 'dist'),
      tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
      throwErrorInsteadOfExit: true,
    };
    try {
      await fs.outputJSON(options.tsconfigPath, {
        compilerOptions: {
          module: 'commonjs',
          target: 'ES2022',
          types: [],
          skipLibCheck: false,
          noEmitOnError: true,
        },
        include: ['api', 'src'],
      });
      await fs.outputFile(
        path.join(sourceDir, 'index.ts'),
        'export const value = 1;\n',
      );
      await fs.outputFile(
        declaration,
        "export { Missing } from 'unavailable-client-types';\n",
      );

      await expect(compile(appDirectory, {}, options)).rejects.toThrow(
        /TS-Go type check failed/,
      );
      await compile(
        appDirectory,
        {},
        { ...options, excludeFiles: [declaration] },
      );
      expect(
        await fs.pathExists(path.join(options.distDir, 'api/index.js')),
      ).toBe(true);

      await fs.outputFile(
        path.join(sourceDir, 'index.ts'),
        "import type { Missing } from '../src/client';\nexport const value: Missing = {};\n",
      );
      await expect(
        compile(appDirectory, {}, { ...options, excludeFiles: [declaration] }),
      ).rejects.toThrow(/unavailable-client-types/);
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it('rejects relative excluded file paths', async () => {
    const appDirectory = path.resolve(
      os.tmpdir(),
      'server-utils-relative-exclusion',
    );
    await expect(
      compile(
        appDirectory,
        {},
        {
          sourceDirs: [path.join(appDirectory, 'api')],
          distDir: path.join(appDirectory, 'dist'),
          excludeFiles: ['src/client.d.ts'],
        },
      ),
    ).rejects.toThrow('excluded file src/client.d.ts is not an absolute path.');
  });

  it('compile typescript', async () => {
    const { example, tempRoot } = await createIsolatedTsExample();
    const tsconfigPath = path.join(example, './tsconfig.json');
    const distDir = path.join(example, './dist');
    const sharedDir = path.join(example, './shared');
    const apiDir = path.join(example, './api');
    const serverDir = path.join(example, './server');

    try {
      await compile(
        example,
        {
          alias: {
            '@modern-js/runtime/server': path.join(
              sharedDir,
              './runtime/server',
            ),
          },
        } as any,
        {
          sourceDirs: [sharedDir, apiDir, serverDir],
          distDir,
          tsconfigPath,
        },
      );

      const distApiDir = path.join(example, './dist', './api');

      const api = require(distApiDir).default;
      expect(api()).toEqual('runtime-shared-api');

      const distServerDir = path.join(distDir, './server');
      const server = require(distServerDir).default;
      expect(server()).toEqual('shared-server');

      const files = await fs.readdir(distServerDir);
      expect(files.sort()).toEqual(['foo.md', 'index.js', 'index.js.map']);

      const distSrcDir = path.join(distDir, './src');
      expect(await fs.pathExists(distSrcDir)).toBeFalsy();

      const mapAliasFile = path.join(distApiDir, './map-alias.js');
      expect(await fs.pathExists(mapAliasFile)).toBeTruthy();
      // ignore
      // const mapAliasContent = (await fs.readFile(mapAliasFile)).toString();
      // expect(mapAliasContent).toMatchSnapshot();
    } finally {
      await fs.remove(tempRoot);
    }
  });

  it('emits runnable server output with source maps for every import kind', async () => {
    const { example, tempRoot } = await createIsolatedTsExample(
      'server-utils-import-kinds-',
    );
    const apiDir = path.join(example, 'api');
    const distDir = path.join(example, 'dist');
    const workspacePackage = path.join(tempRoot, 'packages/workspace-dep');
    const sourceMapsEnabled = process.sourceMapsEnabled;

    try {
      await fs.outputJSON(path.join(workspacePackage, 'package.json'), {
        name: 'workspace-dep',
        main: 'index.js',
      });
      await fs.outputFile(
        path.join(workspacePackage, 'index.js'),
        "exports.value = 'workspace';\n",
      );
      await fs.outputFile(
        path.join(workspacePackage, 'index.d.ts'),
        'export declare const value: string;\n',
      );
      await fs.ensureSymlink(
        workspacePackage,
        path.join(example, 'node_modules/workspace-dep'),
      );
      const installedPackage = path.join(example, 'node_modules/installed-dep');
      await fs.outputJSON(path.join(installedPackage, 'package.json'), {
        name: 'installed-dep',
        main: 'index.js',
        types: 'index.d.ts',
      });
      await fs.outputFile(
        path.join(installedPackage, 'index.js'),
        "exports.value = 'installed';\n",
      );
      await fs.outputFile(
        path.join(installedPackage, 'index.d.ts'),
        'export declare const value: string;\n',
      );
      await fs.outputJSON(path.join(example, 'aliased/data.json'), {
        value: 'source-alias',
      });
      await fs.outputFile(
        path.join(example, 'aliased/value.ts'),
        "import data from './data.json';\nexport const value = data.value;\n",
      );
      // `source.alias` is invisible to the type checker; apps declare it.
      await fs.outputFile(
        path.join(apiDir, 'source-alias.d.ts'),
        "declare module '@source-alias/value' {\n  export const value: string;\n}\ndeclare module '@replaced/dep' {\n  export const value: string;\n}\n",
      );
      await fs.outputFile(
        path.join(apiDir, 'trace.ts'),
        [
          "import { value as aliased } from '@source-alias/value';",
          "import { shared } from '@shared/index';",
          "import { value as workspace } from 'workspace-dep';",
          "import { value as installed } from '@replaced/dep';",
          'export const values = () => [aliased, shared, workspace, installed];',
          '',
          'export const fail = (): never => {',
          "  throw new Error('trace');",
          '};',
          '',
        ].join('\n'),
      );

      await compile(
        example,
        {
          alias: {
            '@source-alias': './aliased',
            '@replaced/dep$': ['missing-dep', 'installed-dep'],
          },
        },
        {
          sourceDirs: [apiDir, path.join(example, 'shared')],
          distDir,
          tsconfigPath: path.join(example, 'tsconfig.json'),
          throwErrorInsteadOfExit: true,
        },
      );

      const output = path.join(distDir, 'api/trace.js');
      expect(await fs.pathExists(`${output}.map`)).toBe(true);
      const emitted = await fs.readFile(output, 'utf8');
      expect(emitted).toContain('require("workspace-dep")');
      expect(emitted).toContain('require("installed-dep")');
      expect(emitted).not.toMatch(/@source-alias|@shared|@replaced/u);
      expect(
        await fs.readJSON(path.join(distDir, 'aliased/data.json')),
      ).toEqual({ value: 'source-alias' });

      process.setSourceMapsEnabled(true);
      const trace = require(output);
      expect(trace.values()).toEqual([
        'source-alias',
        'shared',
        'workspace',
        'installed',
      ]);
      let stack = '';
      try {
        trace.fail();
      } catch (error) {
        stack = (error as Error).stack ?? '';
      }
      expect(stack).toContain(`${path.join(apiDir, 'trace.ts')}:8:`);
    } finally {
      process.setSourceMapsEnabled(sourceMapsEnabled);
      await fs.remove(tempRoot);
    }
  });

  it('emits only the scripts the tsconfig includes, plus what they import', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-utils-tsconfig-roots-')),
    );
    const apiDir = path.join(appDirectory, 'api');
    const distDir = path.join(appDirectory, 'dist');
    try {
      await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
        compilerOptions: { module: 'commonjs', target: 'ES2022', types: [] },
        include: ['api'],
        exclude: ['**/*.test.ts', 'api/helpers'],
      });
      await fs.outputFile(
        path.join(apiDir, 'index.ts'),
        "export { helper } from './helpers/used';\n",
      );
      await fs.outputFile(
        path.join(apiDir, 'helpers/used.ts'),
        "export const helper = 'used';\n",
      );
      await fs.outputFile(
        path.join(apiDir, 'helpers/unused.ts'),
        "export const unused = 'unused';\n",
      );
      await fs.outputFile(
        path.join(apiDir, 'index.test.ts'),
        "import { missing } from 'test-only';\nexport { missing };\n",
      );

      await compile(
        appDirectory,
        {},
        {
          sourceDirs: [apiDir],
          distDir,
          tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
          throwErrorInsteadOfExit: true,
        },
      );

      expect(require(path.join(distDir, 'api/index.js')).helper).toBe('used');
      expect(
        await fs.pathExists(path.join(distDir, 'api/helpers/unused.js')),
      ).toBe(false);
      expect(await fs.pathExists(path.join(distDir, 'api/index.test.js'))).toBe(
        false,
      );
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it('type-checks sources reached only through source.alias', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-utils-alias-check-')),
    );
    const apiDir = path.join(appDirectory, 'api');
    try {
      await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
        compilerOptions: { module: 'commonjs', target: 'ES2022', types: [] },
        include: ['api'],
      });
      await fs.outputFile(
        path.join(apiDir, 'aliases.d.ts'),
        "declare module '@lib/value' {\n  export const value: string;\n}\n",
      );
      await fs.outputFile(
        path.join(apiDir, 'index.ts'),
        "export { value } from '@lib/value';\n",
      );
      await fs.outputFile(
        path.join(appDirectory, 'lib/value.ts'),
        'export const value: string = 1;\n',
      );
      await expect(
        compile(
          appDirectory,
          { alias: { '@lib': './lib' } },
          {
            sourceDirs: [apiDir],
            distDir: path.join(appDirectory, 'dist'),
            tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
            throwErrorInsteadOfExit: true,
          },
        ),
      ).rejects.toThrow(/lib\/value\.ts.*TS2322/u);
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it('type-checks server roots that hold only declarations', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-utils-declarations-')),
    );
    const sharedDir = path.join(appDirectory, 'shared');
    try {
      await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
        compilerOptions: { module: 'commonjs', target: 'ES2022', types: [] },
        include: ['shared'],
      });
      await fs.outputFile(
        path.join(sharedDir, 'types.d.ts'),
        "export type Value = import('missing-types').Missing;\n",
      );
      await expect(
        compile(
          appDirectory,
          {},
          {
            sourceDirs: [sharedDir],
            distDir: path.join(appDirectory, 'dist'),
            tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
            throwErrorInsteadOfExit: true,
          },
        ),
      ).rejects.toThrow(/missing-types/u);
    } finally {
      await fs.remove(appDirectory);
    }
  });

  it('emits decorator metadata and reports non-blocking type errors', async () => {
    const appDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-utils-decorators-')),
    );
    const apiDir = path.join(appDirectory, 'api');
    const warn = rstest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
        compilerOptions: {
          module: 'commonjs',
          target: 'ES2022',
          types: [],
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          noEmitOnError: false,
        },
        include: ['api'],
      });
      await fs.outputFile(
        path.join(apiDir, 'index.ts'),
        [
          'const inject = (..._args: unknown[]) => {};',
          'export class Service {',
          '  constructor(@inject readonly name: string) {}',
          '}',
          'export const invalid: string = 1;',
          '',
        ].join('\n'),
      );

      await compile(
        appDirectory,
        {},
        {
          sourceDirs: [apiDir],
          distDir: path.join(appDirectory, 'dist'),
          tsconfigPath: path.join(appDirectory, 'tsconfig.json'),
          throwErrorInsteadOfExit: true,
        },
      );

      const emitted = await fs.readFile(
        path.join(appDirectory, 'dist/api/index.js'),
        'utf8',
      );
      expect(emitted).toContain('design:paramtypes');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/TS2322/u));
    } finally {
      warn.mockRestore();
      await fs.remove(appDirectory);
    }
  });

  it('rewrites tsconfig path aliases in emitted declarations', async () => {
    const example = path.join(__dirname, './fixtures', './ts-declaration');
    const tsconfigPath = path.join(example, './tsconfig.json');
    const distDir = path.join(example, './dist');
    const sharedDir = path.join(example, './shared');
    const apiDir = path.join(example, './api');

    try {
      // TS-Go never resolves `paths` in `.d.ts` output; Rslib's declaration
      // redirect does. Quote style is matched loosely.
      await compile(example, { alias: {} } as any, {
        sourceDirs: [sharedDir, apiDir],
        distDir,
        tsconfigPath,
      });

      const dts = (
        await fs.readFile(path.join(distDir, './api/declaration.d.ts'))
      ).toString();

      // No alias may leak to consumers.
      expect(dts).not.toContain('@shared/types');

      // Every specifier kind is rebased to a relative, extensionless path.
      // ImportDeclaration / ExportDeclaration
      expect(dts).toMatch(/from ["']\.\.\/shared\/types["']/);
      // ImportTypeNode (inline `import("...")` type)
      expect(dts).toMatch(/import\(["']\.\.\/shared\/types["']\)/);
      // ImportEqualsDeclaration (`import x = require("...")`)
      expect(dts).toMatch(/require\(["']\.\.\/shared\/types["']\)/);
    } finally {
      await fs.remove(distDir);
    }
  });

  it('appends .js to declaration specifiers in esm output', async () => {
    const example = path.join(__dirname, './fixtures', './ts-declaration-esm');
    const tsconfigPath = path.join(example, './tsconfig.json');
    const distDir = path.join(example, './dist');
    const sharedDir = path.join(example, './shared');
    const apiDir = path.join(example, './api');

    try {
      await compile(example, { alias: {} } as any, {
        sourceDirs: [sharedDir, apiDir],
        distDir,
        tsconfigPath,
        moduleType: 'module',
      });

      const dts = (
        await fs.readFile(path.join(distDir, './api/index.d.ts'))
      ).toString();

      // In ESM output the declaration specifier must carry the emitted `.js`
      // extension just like the JS output, or `node16`/`nodenext` consumers
      // fail with TS2835. TS resolves `./x.js` back to `./x.d.ts`.
      expect(dts).not.toContain('@shared');
      expect(dts).toMatch(/from ["']\.\.\/shared\/types\.js["']/);
      expect(dts).toMatch(/import\(["']\.\.\/shared\/types\.js["']\)/);
    } finally {
      await fs.remove(distDir);
    }
  });

  it('should keep .js suffix for aliased imports in esm output', async () => {
    const { example, tempRoot } = await createIsolatedTsExample();
    const tsconfigPath = path.join(example, './tsconfig.esm.json');
    const distDir = path.join(example, './dist-esm');
    const sharedDir = path.join(example, './shared');
    const apiDir = path.join(example, './api');
    const serverDir = path.join(example, './server');

    try {
      await compile(
        example,
        {
          alias: {
            '@modern-js/runtime/server': path.join(
              sharedDir,
              './runtime/server',
            ),
          },
        } as any,
        {
          sourceDirs: [sharedDir, apiDir, serverDir],
          distDir,
          tsconfigPath,
          moduleType: 'module',
        },
      );

      const api = await loadEsmModule(
        distDir,
        path.join(distDir, './api/index.js'),
      );
      const jsAlias = await loadEsmModule(
        distDir,
        path.join(distDir, './api/js-alias.js'),
      );
      const relative = await loadEsmModule(
        distDir,
        path.join(distDir, './api/relative.js'),
      );

      expect(api.default()).toBe('runtime-shared-api');
      expect(jsAlias.default()).toBe('shared-js-alias');
      expect(relative.default()).toBe('shared-relative');
    } finally {
      await fs.remove(tempRoot);
    }
  });
  it('forces Node-executable emission when app tsconfig resolves to bundler module settings', async () => {
    // Regression: TS-Go v7 resolves unpinned app tsconfigs to
    // module=preserve/moduleResolution=bundler, which used to leak bare
    // `import` statements into the CommonJS server dist (Node then fails on
    // extensionless ESM imports at runtime).
    const { example, tempRoot } = await createIsolatedTsExample();
    const tsconfigPath = path.join(example, './tsconfig.bundler.json');
    const distDir = path.join(example, './dist-bundler');
    const sharedDir = path.join(example, './shared');
    const apiDir = path.join(example, './api');
    const serverDir = path.join(example, './server');

    try {
      await compile(
        example,
        {
          alias: {
            '@modern-js/runtime/server': path.join(
              sharedDir,
              './runtime/server',
            ),
          },
        } as any,
        {
          sourceDirs: [sharedDir, apiDir, serverDir],
          distDir,
          tsconfigPath,
        },
      );

      const api = require(path.join(distDir, './api')).default;
      expect(api()).toEqual('runtime-shared-api');
    } finally {
      await fs.remove(tempRoot);
    }
  });

  it('emits no aliased output when the blocking type check fails', async () => {
    const example = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-config-alias-')),
    );
    const distDir = path.join(example, 'dist');
    const serverDir = path.join(example, 'server');
    const sharedDir = path.join(example, 'shared');

    await fs.outputJSON(path.join(example, 'tsconfig.json'), {
      compilerOptions: {
        declaration: false,
        module: 'CommonJS',
        moduleResolution: 'Node',
        target: 'ES2019',
        baseUrl: './',
        paths: {
          '@shared/*': ['./shared/*'],
        },
      },
      include: ['server', 'shared'],
    });
    await fs.outputFile(
      path.join(sharedDir, 'repro.ts'),
      `export const value = 'alias test';\n`,
    );
    await fs.outputFile(
      path.join(serverDir, 'modern.server.ts'),
      [
        `import { value } from '@shared/repro';`,
        `const mustBeNumber: number = value;`,
        `export default mustBeNumber;`,
        ``,
      ].join('\n'),
    );

    try {
      await expect(
        compile(example, {} as any, {
          sourceDirs: [serverDir, sharedDir],
          distDir,
          tsconfigPath: path.join(example, 'tsconfig.json'),
          throwErrorInsteadOfExit: true,
        }),
      ).rejects.toThrow(/TS-Go type check failed/);

      expect(await fs.pathExists(distDir)).toBe(false);
    } finally {
      await fs.remove(example);
    }
  });

  it('should resolve tsx directory entries and emit runnable js in esm output', async () => {
    const example = path.join(__dirname, './fixtures', './tsx-example');
    const tsconfigPath = path.join(example, './tsconfig.esm.json');
    const distDir = path.join(example, './dist-esm');
    const sharedDir = path.join(example, './shared');
    const serverDir = path.join(example, './server');

    try {
      // No alias and no tsconfig `paths`: relative specifiers still have to be
      // rewritten for native ESM.
      await compile(example, { alias: {} } as any, {
        sourceDirs: [sharedDir, serverDir],
        distDir,
        tsconfigPath,
        moduleType: 'module',
      });

      const server = await loadEsmModule(
        distDir,
        path.join(distDir, './server/index.js'),
      );
      expect(server.default()).toBe('foo-bar-helper-mjs-legacy-cjs-data-json');

      // `jsx: preserve` would emit `foo/index.jsx`, which Node cannot load.
      expect(
        await fs.pathExists(path.join(distDir, './server/foo/index.js')),
      ).toBeTruthy();
      expect(
        await fs.pathExists(path.join(distDir, './server/foo/index.jsx')),
      ).toBeFalsy();

      // Source files must not be copied next to their compiled output.
      expect(
        await fs.pathExists(path.join(distDir, './server/foo/index.tsx')),
      ).toBeFalsy();
      expect(
        await fs.pathExists(path.join(distDir, './server/native.mjs')),
      ).toBeTruthy();
      expect(
        await fs.pathExists(path.join(distDir, './server/native.cjs')),
      ).toBeTruthy();
      expect(
        await fs.pathExists(path.join(distDir, './server/native.mts')),
      ).toBeFalsy();
      expect(
        await fs.pathExists(path.join(distDir, './server/native.cts')),
      ).toBeFalsy();
    } finally {
      await fs.remove(distDir);
    }
  });

  it('rejects native source modules that publish the same output path', async () => {
    const { example, tempRoot } = await createIsolatedTsExample(
      'server-utils-native-collision-',
    );
    const serverDir = path.join(example, 'server');

    await Promise.all([
      fs.outputFile(
        path.join(serverDir, 'collision.mts'),
        `export const x = 1;`,
      ),
      fs.outputFile(
        path.join(serverDir, 'collision.mjs'),
        `export const x = 2;`,
      ),
    ]);

    try {
      await expect(
        compile(example, { alias: {} } as any, {
          sourceDirs: [serverDir],
          distDir: path.join(example, 'dist-native-collision'),
          tsconfigPath: path.join(example, 'tsconfig.json'),
          moduleType: 'module',
          throwErrorInsteadOfExit: true,
        }),
      ).rejects.toThrow(
        /collision\.m[jt]s" and ".*collision\.m[jt]s" both compile to "server\/collision\.mjs"/u,
      );
    } finally {
      await fs.remove(tempRoot);
    }
  });

  it('should keep specifiers that are not compiled to js in esm output', async () => {
    const example = path.join(__dirname, './fixtures', './tsx-example');
    const tsconfigPath = path.join(example, './tsconfig.esm.json');
    const distDir = path.join(example, './dist-esm-assets');
    const sharedDir = path.join(example, './shared');
    const serverDir = path.join(example, './server');

    try {
      await compile(example, { alias: {} } as any, {
        sourceDirs: [sharedDir, serverDir],
        distDir,
        tsconfigPath,
        moduleType: 'module',
      });

      const server = await loadEsmModule(
        distDir,
        path.join(distDir, './server/index.js'),
      );
      expect(server.default()).toBe('foo-bar-helper-mjs-legacy-cjs-data-json');
      await expect(server.loadData()).resolves.toMatchObject({
        default: { name: 'data-json' },
      });
      await expect(server.loadLocaleTemplate('en')).resolves.toMatchObject({
        locale: 'en',
      });
      await expect(server.loadLocaleConcat('en')).resolves.toMatchObject({
        locale: 'en',
      });

      expect(
        await fs.pathExists(path.join(distDir, './shared/data.json')),
      ).toBeTruthy();
      expect(
        await fs.pathExists(path.join(distDir, './server/helper.mjs')),
      ).toBeTruthy();
      expect(
        await fs.pathExists(path.join(distDir, './server/legacy.cjs')),
      ).toBeTruthy();
    } finally {
      await fs.remove(distDir);
    }
  });
});
