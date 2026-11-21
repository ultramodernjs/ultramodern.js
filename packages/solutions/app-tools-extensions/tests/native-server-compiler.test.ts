import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fs } from '@modern-js/utils';
import { createBffGenerator } from '../../../cli/plugin-bff/src/cli/generator';
import serverBuildPlugin from '../../app-tools/src/plugins/serverBuild';
import { resolveEffectTsrsCompiler } from '../src/build-config/build-environment';
import { nativeServerCompiler } from '../src/native-server-compiler';
import {
  type ServerCompiler as Compiler,
  compileServerSources as compile,
  type ServerCompilerProvider as Provider,
} from '../src/server-compiler';

const require = createRequire(import.meta.url);

/**
 * The provider's invocation-private adapter directories, observed through a
 * temporary directory owned by one test. The adapter is not public API.
 */
async function privateTmp(appDirectory: string) {
  const directory = path.join(appDirectory, '.tmp');
  await fs.ensureDir(directory);
  const variable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
  const previous = process.env[variable];
  process.env[variable] = directory;
  expect(await fs.realpath(os.tmpdir())).toBe(directory);
  return {
    adapters: async () =>
      (await fs.readdir(directory))
        .filter(name => name.startsWith('modern-server-tsrs-'))
        .map(name => path.join(directory, name)),
    /** Compiler-private discovery and declaration directories. */
    scratch: async () =>
      (await fs.readdir(directory)).filter(name =>
        name.startsWith('modern-server-compile-'),
      ),
    restore: () => {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    },
  };
}

async function fixture() {
  const appDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'native-server-compiler-test-')),
  );
  try {
    // A consumer, not a checkout-root fixture: no vanilla TypeScript link.
    for (const name of ['tsrs', '@effect/tsgo', 'effect']) {
      const target = path.join(appDirectory, 'node_modules', name);
      await fs.ensureDir(path.dirname(target));
      await fs.symlink(
        path.dirname(require.resolve(`${name}/package.json`)),
        target,
        'dir',
      );
    }
    await fs.outputJSON(path.join(appDirectory, 'package.json'), {
      private: true,
      type: 'commonjs',
    });
    await fs.outputJSON(path.join(appDirectory, 'config/preset/base.json'), {
      compilerOptions: {
        target: 'ESNext',
        module: 'CommonJS',
        moduleResolution: 'NodeNext',
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        incremental: true,
        tsBuildInfoFile: './cache/server.tsbuildinfo',
        outDir: './authored-output',
        noEmitOnError: true,
        types: [],
        jsx: 'react-jsx',
        lib: ['ESNext'],
        paths: { '@shared/*': ['../../shared/*'] },
        plugins: [
          {
            name: '@effect/language-service',
            diagnosticSeverity: {
              floatingEffect: 'error',
              unstableApiUsage: 'message',
            },
          },
        ],
      },
    });
    const tsconfigPath = path.join(appDirectory, 'config/tsconfig.json');
    await fs.outputJSON(tsconfigPath, {
      extends: './preset/base.json',
      // Keep NodeNext's module/resolution pair valid.
      compilerOptions: { module: 'NodeNext' },
      include: ['../api', '../server', '../shared'],
      references: [{ path: '../referenced' }],
    });
    await fs.outputJSON(path.join(appDirectory, 'referenced/tsconfig.json'), {
      compilerOptions: { composite: true },
      files: ['index.ts'],
    });
    await fs.outputFile(
      path.join(appDirectory, 'referenced/index.ts'),
      'export const referenced = 1;\n',
    );
    await fs.outputFile(
      path.join(appDirectory, 'api/index.ts'),
      'export const answer: number = 42;\n',
    );
    await fs.outputFile(
      path.join(appDirectory, 'server/cache.ts'),
      'export default { max: 42 };\n',
    );
    await fs.outputFile(
      path.join(appDirectory, 'shared/index.ts'),
      'export const shared: number = 7;\n',
    );
    await fs.outputFile(
      path.join(appDirectory, 'client-only.ts'),
      'export const unchecked: string = 1;\n',
    );
    return { appDirectory, tsconfigPath };
  } catch (error) {
    await fs.remove(appDirectory);
    throw error;
  }
}

test('uses one app-bound Effect tsrs executable for native config, checks and real DTS output', async () => {
  const { appDirectory, tsconfigPath } = await fixture();
  const tmp = await privateTmp(appDirectory);
  const providers: Compiler[] = [];
  const calls: string[] = [];
  const compiler: Provider = async from => {
    calls.push(from);
    const selected = await nativeServerCompiler(from);
    providers.push(selected);
    const [adapter, ...others] = await tmp.adapters();
    expect(others).toEqual([]);
    const expected = resolveEffectTsrsCompiler({
      from: path.join(appDirectory, 'package.json'),
    });
    expect(selected.command.executable).toBe(expected);
    expect(selected.command.args).toEqual([]);
    expect(
      execFileSync(expected, ['--version'], { encoding: 'utf8' }),
    ).toContain('+effect-tsgo.0.73.2');
    expect(require(path.join(adapter, 'compiler.cjs')).version).toBe(
      require('tsrs/package.json').tsrs.typescriptVersion,
    );
    // Rslib calls the adapter in its isolated worker. Check that worker's
    // policy without changing this application's environment.
    const assignment = process.env.TSRS_CHECKER_ASSIGNMENT;
    const workerResult = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          `delete process.env.TSRS_CHECKER_ASSIGNMENT;
const executable = require(process.argv[1])();
process.stdout.write(JSON.stringify({ executable, assignment: process.env.TSRS_CHECKER_ASSIGNMENT }));`,
          path.join(adapter, 'getExePath.js'),
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(workerResult).toEqual({
      executable: expected,
      assignment: selected.command.env?.TSRS_CHECKER_ASSIGNMENT,
    });
    expect(process.env.TSRS_CHECKER_ASSIGNMENT).toBe(assignment);
    const parsed = await selected.readConfig(tsconfigPath);
    // Numeric enums and lib filenames from the API are not valid tsconfig JSON.
    expect(parsed.compilerOptions).toMatchObject({
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'esnext',
      jsx: 'react-jsx',
      lib: ['esnext'],
      declaration: true,
    });
    expect(parsed.references).toHaveLength(1);
    expect(parsed.extends).toBe(tsconfigPath);
    expect(parsed.compilerOptions?.['pathsBasePath']).toBeUndefined();
    expect(parsed.compilerOptions?.['plugins']).toBeUndefined();
    expect(parsed.compilerOptions?.paths).toEqual({
      '@shared/*': [path.join(appDirectory, 'shared/*')],
    });
    return selected;
  };
  const excluded = path.join(appDirectory, 'api/generated.d.ts');
  try {
    await fs.outputFile(
      excluded,
      "import type { Missing } from 'not-installed';\n",
    );
    const result = await compile(
      appDirectory,
      {},
      {
        compiler,
        sourceDirs: [path.join(appDirectory, 'api')],
        distDir: path.join(appDirectory, 'dist'),
        tsconfigPath,
        excludeFiles: [excluded],
        throwErrorInsteadOfExit: true,
      },
    );
    expect(calls).toEqual([appDirectory]);
    expect(result).toEqual({
      rootFiles: [path.join(appDirectory, 'dist/api/index.js')],
      emittedFiles: ['api/index.d.ts', 'api/index.js', 'api/index.js.map'].map(
        file => path.join(appDirectory, 'dist', file),
      ),
    });
    expect(await tmp.scratch()).toEqual([]);
    expect(require(path.join(appDirectory, 'dist/api/index.js')).answer).toBe(
      42,
    );
    expect(
      await fs.readFile(path.join(appDirectory, 'dist/api/index.d.ts'), 'utf8'),
    ).toContain('export declare const answer: number;');
    expect(
      await fs.pathExists(path.join(appDirectory, 'referenced/index.d.ts')),
    ).toBe(false);
    expect(
      await fs.pathExists(path.join(appDirectory, 'config/preset/cache')),
    ).toBe(false);
    expect(
      await fs.pathExists(
        path.join(appDirectory, 'config/preset/authored-output'),
      ),
    ).toBe(false);
    expect(
      (await fs.readdir(path.dirname(tsconfigPath))).filter(file =>
        file.endsWith('.resolved.json'),
      ),
    ).toEqual([]);
    expect(await tmp.adapters()).toEqual([]);
  } finally {
    tmp.restore();
    for (const selected of providers) await selected.dispose?.();
    await fs.remove(appDirectory);
  }
});

test('rejects a configured non-Effect provider rather than silently selecting stable TypeScript', async () => {
  const { appDirectory } = await fixture();
  const previous = process.env.EFFECT_TSGO_BIN;
  try {
    process.env.EFFECT_TSGO_BIN = process.execPath;
    await expect(nativeServerCompiler(appDirectory)).rejects.toThrow(
      'Unable to resolve an executable Effect tsrs API provider',
    );
  } finally {
    if (previous === undefined) delete process.env.EFFECT_TSGO_BIN;
    else process.env.EFFECT_TSGO_BIN = previous;
    await fs.remove(appDirectory);
  }
});

test('preserves real TypeScript and Effect diagnostics and cleans adapters after failure', async () => {
  const { appDirectory, tsconfigPath } = await fixture();
  const tmp = await privateTmp(appDirectory);
  const providers: Compiler[] = [];
  const compiler: Provider = async from => {
    const selected = await nativeServerCompiler(from);
    providers.push(selected);
    return selected;
  };
  try {
    await fs.writeJSON(tsconfigPath, {
      extends: './preset/base.json',
      compilerOptions: {
        module: 'NodeNext',
        declaration: false,
      },
      include: ['../api'],
    });
    for (const [source, diagnostic] of [
      ['export const broken: string = 42;', 'TS2322'],
      ['import { Effect } from "effect"; Effect.succeed(1);', 'floatingEffect'],
    ]) {
      await fs.writeFile(path.join(appDirectory, 'api/index.ts'), source);
      await expect(
        compile(
          appDirectory,
          {},
          {
            compiler,
            sourceDirs: [path.join(appDirectory, 'api')],
            distDir: path.join(appDirectory, 'dist'),
            tsconfigPath,
            throwErrorInsteadOfExit: true,
          },
        ),
      ).rejects.toThrow(diagnostic);
    }
    expect(providers).toHaveLength(2);
    expect(await tmp.adapters()).toEqual([]);
    expect(
      (await fs.readdir(path.dirname(tsconfigPath))).filter(file =>
        file.endsWith('.resolved.json'),
      ),
    ).toEqual([]);
  } finally {
    tmp.restore();
    for (const selected of providers) await selected.dispose?.();
    await fs.remove(appDirectory);
  }
});

test('fails on declaration-only diagnostics from the native plugin and cleans the adapter', async () => {
  const { appDirectory, tsconfigPath } = await fixture();
  const tmp = await privateTmp(appDirectory);
  const disposed: string[][] = [];
  try {
    await fs.writeJSON(tsconfigPath, {
      extends: './preset/base.json',
      compilerOptions: { module: 'NodeNext' },
      include: ['../api'],
    });
    await fs.writeFile(
      path.join(appDirectory, 'api/index.ts'),
      'export const broken: string = 42;\n',
    );
    await expect(
      compile(
        appDirectory,
        {},
        {
          // A passing checker leaves the declaration plugin as the only
          // program that reports the error.
          compiler: async from => {
            const selected = await nativeServerCompiler(from);
            return {
              ...selected,
              command: {
                executable: process.execPath,
                args: ['-e', '', '--'],
              },
              dispose: async () => {
                disposed.push(await tmp.adapters());
                await selected.dispose?.();
              },
            };
          },
          sourceDirs: [path.join(appDirectory, 'api')],
          distDir: path.join(appDirectory, 'dist'),
          tsconfigPath,
          throwErrorInsteadOfExit: true,
        },
      ),
    ).rejects.toThrow('declaration files generation');
    expect(disposed.map(adapters => adapters.length)).toEqual([1]);
    expect(await tmp.adapters()).toEqual([]);
    expect(await tmp.scratch()).toEqual([]);
    // The failed compilation leaves none of its JavaScript behind.
    expect(
      await fs.pathExists(path.join(appDirectory, 'dist/api/index.js')),
    ).toBe(false);
    expect(
      (await fs.readdir(path.dirname(tsconfigPath))).filter(file =>
        file.endsWith('.resolved.json'),
      ),
    ).toEqual([]);
  } finally {
    tmp.restore();
    await fs.remove(appDirectory);
  }
});

test('sibling native providers emit real declarations with separate adapters', async () => {
  const apps = await Promise.all([fixture(), fixture()]);
  const tmp = await privateTmp(apps[0].appDirectory);
  const seen = new Set<string>();
  try {
    await Promise.all(
      apps.map(async ({ appDirectory, tsconfigPath }, index) => {
        await fs.writeFile(
          path.join(appDirectory, 'api/index.ts'),
          `export const sibling: ${index === 0 ? 'string' : 'number'} = ${index === 0 ? "'first'" : '2'};\n`,
        );
        await compile(
          appDirectory,
          {},
          {
            compiler: async from => {
              const selected = await nativeServerCompiler(from);
              for (const adapter of await tmp.adapters()) seen.add(adapter);
              return selected;
            },
            sourceDirs: [path.join(appDirectory, 'api')],
            distDir: path.join(appDirectory, 'dist'),
            tsconfigPath,
            throwErrorInsteadOfExit: true,
          },
        );
      }),
    );
    expect(seen.size).toBe(2);
    expect(
      await fs.readFile(
        path.join(apps[0].appDirectory, 'dist/api/index.d.ts'),
        'utf8',
      ),
    ).toContain('export declare const sibling: string;');
    expect(
      await fs.readFile(
        path.join(apps[1].appDirectory, 'dist/api/index.d.ts'),
        'utf8',
      ),
    ).toContain('export declare const sibling: number;');
    expect(await tmp.adapters()).toEqual([]);
  } finally {
    tmp.restore();
    await Promise.all(apps.map(({ appDirectory }) => fs.remove(appDirectory)));
  }
});

test('inherits Effect severity policy without broadening the selected server roots', async () => {
  const { appDirectory, tsconfigPath } = await fixture();
  try {
    await fs.writeJSON(tsconfigPath, {
      extends: './preset/base.json',
      compilerOptions: {
        module: 'NodeNext',
        // Effect's HTTP declarations use URL, fetch and stream globals.
        lib: ['ESNext', 'DOM', 'DOM.Iterable'],
      },
      include: ['../api', '../client-only.ts'],
    });
    await fs.writeFile(
      path.join(appDirectory, 'api/index.ts'),
      `import { HttpApi } from 'effect/http-api';
import type { Shared } from '@shared/types';
export type ApiValue = Shared;
export const api = HttpApi.make('NativeApi');
`,
    );
    await fs.outputFile(
      path.join(appDirectory, 'shared/types.ts'),
      'export interface Shared { readonly value: number }\n',
    );
    await compile(
      appDirectory,
      {},
      {
        compiler: nativeServerCompiler,
        sourceDirs: [path.join(appDirectory, 'api')],
        distDir: path.join(appDirectory, 'dist'),
        tsconfigPath,
        throwErrorInsteadOfExit: true,
      },
    );
    expect(
      await fs.pathExists(path.join(appDirectory, 'dist/api/index.d.ts')),
    ).toBe(true);
    expect(
      await fs.pathExists(path.join(appDirectory, 'dist/client-only.js')),
    ).toBe(false);
  } finally {
    await fs.remove(appDirectory);
  }
});

test('a transitive alias is checked under the inherited Effect policy and its scoped overrides', async () => {
  const { appDirectory, tsconfigPath } = await fixture();
  const tmp = await privateTmp(appDirectory);
  try {
    await fs.writeJSON(tsconfigPath, {
      extends: './preset/base.json',
      compilerOptions: {
        module: 'NodeNext',
        declaration: false,
        // Effect's declarations use URL, fetch and stream globals.
        lib: ['ESNext', 'DOM', 'DOM.Iterable'],
        paths: { '@lib/*': ['../lib/*'] },
      },
      include: ['../api'],
    });
    await fs.writeFile(
      path.join(appDirectory, 'api/index.ts'),
      "export { run } from '@lib/first';\n",
    );
    await fs.outputFile(
      path.join(appDirectory, 'lib/first.ts'),
      "export { run } from '@lib/second';\n",
    );
    const second = path.join(appDirectory, 'lib/second.ts');
    const options = {
      compiler: nativeServerCompiler,
      sourceDirs: [path.join(appDirectory, 'api')],
      distDir: path.join(appDirectory, 'dist'),
      tsconfigPath,
      throwErrorInsteadOfExit: true,
    };
    const alias = { alias: { '@lib': './lib' } };
    const body = `import { Effect } from 'effect';
export const run = (): number => {
  Effect.succeed(1);
  return 1;
};
`;
    // Reached only through `source.alias`: the inherited severity applies.
    await fs.outputFile(second, body);
    await expect(compile(appDirectory, alias, options)).rejects.toThrow(
      /lib\/second\.ts[\s\S]*floatingEffect/u,
    );
    expect(await fs.pathExists(options.distDir)).toBe(false);
    // A scoped directive in the reached file still governs its own scope.
    await fs.outputFile(
      second,
      `// @effect-diagnostics floatingEffect:off\n${body}`,
    );
    const result = await compile(appDirectory, alias, options);
    expect(result.rootFiles).toEqual([
      path.join(options.distDir, 'api/index.js'),
    ]);
    expect(result.emittedFiles).toContain(
      path.join(options.distDir, 'lib/second.js'),
    );
    expect(require(path.join(options.distDir, 'api/index.js')).run()).toBe(1);
    expect(await tmp.adapters()).toEqual([]);
    expect(await tmp.scratch()).toEqual([]);
  } finally {
    tmp.restore();
    await fs.remove(appDirectory);
  }
});

test('one owner compiles the BFF and server roots with the configured provider', async () => {
  const { appDirectory, tsconfigPath } = await fixture();
  const calls: string[] = [];
  const compiler: Provider = async from => {
    calls.push(from);
    return nativeServerCompiler(from);
  };
  const afterBuild: Array<() => Promise<void>> = [];
  const results: Array<{ readonly emittedFiles: readonly string[] }> = [];
  let context: Record<string, unknown> = {
    appDirectory,
    apiDirectory: path.join(appDirectory, 'api'),
    sharedDirectory: path.join(appDirectory, 'shared'),
    distDirectory: path.join(appDirectory, 'dist'),
    metaName: 'modern-js',
    moduleType: 'commonjs',
  };
  const config = {
    source: { alias: {} },
    resolve: {},
    output: { sourceMap: false },
    server: { tsconfigPath },
    tools: { serverCompiler: compiler },
  };
  const api = {
    getAppContext: () => context,
    updateAppContext: (update: Record<string, unknown>) => {
      context = { ...context, ...update };
    },
    getNormalizedConfig: () => config,
    getHooks: () => ({
      onBeforeBffCompile: { call: async () => {} },
      onAfterBffCompile: {
        call: async (
          _context: unknown,
          result: { readonly emittedFiles: readonly string[] },
        ) => {
          results.push(result);
        },
      },
    }),
    onAfterBuild: (callback: () => Promise<void>) => {
      afterBuild.push(callback);
    },
  };
  const dist = (file: string) => path.join(appDirectory, 'dist', file);
  try {
    serverBuildPlugin().setup!(api as never);
    // Without an owner, the custom-server build compiles server and shared.
    for (const callback of afterBuild) await callback();
    expect(calls).toEqual([appDirectory]);
    expect(await fs.pathExists(dist('server/cache.d.ts'))).toBe(true);
    expect(await fs.pathExists(dist('api/index.js'))).toBe(false);

    await fs.remove(dist('.'));
    calls.length = 0;
    // The BFF build owns the server roots: one compilation, one provider.
    api.updateAppContext({ serverCompileOwner: '@modern-js/plugin-bff' });
    await createBffGenerator(api as never).compileApi('build');
    for (const callback of afterBuild) await callback();
    expect(calls).toEqual([appDirectory]);
    expect(results).toHaveLength(1);
    for (const file of [
      'api/index.d.ts',
      'server/cache.d.ts',
      'shared/index.d.ts',
    ]) {
      expect(results[0].emittedFiles).toContain(dist(file));
      expect(await fs.pathExists(dist(file))).toBe(true);
    }
  } finally {
    await fs.remove(appDirectory);
  }
});
