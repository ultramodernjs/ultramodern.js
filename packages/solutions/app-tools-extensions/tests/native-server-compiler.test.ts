import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { compile } from '@modern-js/server-utils';
import { fs } from '@modern-js/utils';
import { createBffGenerator } from '../../../cli/plugin-bff/src/cli/generator';
import serverBuildPlugin from '../../app-tools/src/plugins/serverBuild';
import { resolveEffectTsrsCompiler } from '../src/build-config/build-environment';
import { nativeServerCompiler } from '../src/native-server-compiler';

const require = createRequire(import.meta.url);
type Provider = NonNullable<Parameters<typeof compile>[2]['compiler']>;
type Compiler = Awaited<ReturnType<Provider>>;

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
    await fs.outputJSON(path.join(appDirectory, 'config/base.json'), {
      compilerOptions: {
        target: 'ESNext',
        module: 'CommonJS',
        moduleResolution: 'NodeNext',
        strict: true,
        declaration: true,
        noEmitOnError: true,
        types: [],
        jsx: 'react-jsx',
        lib: ['ESNext'],
      },
    });
    const tsconfigPath = path.join(appDirectory, 'config/tsconfig.json');
    await fs.outputJSON(tsconfigPath, {
      extends: './base.json',
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
    return { appDirectory, tsconfigPath };
  } catch (error) {
    await fs.remove(appDirectory);
    throw error;
  }
}

test('uses one app-bound Effect tsrs executable for native config, checks and real DTS output', async () => {
  const { appDirectory, tsconfigPath } = await fixture();
  const providers: Compiler[] = [];
  const calls: string[] = [];
  const compiler: Provider = async from => {
    calls.push(from);
    const selected = await nativeServerCompiler(from);
    providers.push(selected);
    const expected = resolveEffectTsrsCompiler({
      from: path.join(appDirectory, 'package.json'),
    });
    expect(selected.command.executable).toBe(expected);
    expect(selected.command.args).toEqual([]);
    expect(
      execFileSync(expected, ['--version'], { encoding: 'utf8' }),
    ).toContain('+effect-tsgo.0.67.0');
    expect(require(selected.typescriptPath).version).toBe(
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
          path.join(path.dirname(selected.typescriptPath), 'getExePath.js'),
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
    return selected;
  };
  const excluded = path.join(appDirectory, 'api/generated.d.ts');
  try {
    await fs.outputFile(
      excluded,
      "import type { Missing } from 'not-installed';\n",
    );
    await compile(
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
      (await fs.readdir(path.dirname(tsconfigPath))).filter(file =>
        file.endsWith('.resolved.json'),
      ),
    ).toEqual([]);
    for (const selected of providers) {
      expect(await fs.pathExists(selected.typescriptPath)).toBe(false);
    }
  } finally {
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
  const providers: Compiler[] = [];
  const compiler: Provider = async from => {
    const selected = await nativeServerCompiler(from);
    providers.push(selected);
    return selected;
  };
  try {
    await fs.writeJSON(tsconfigPath, {
      extends: './base.json',
      compilerOptions: {
        module: 'NodeNext',
        declaration: false,
        plugins: [
          {
            name: '@effect/language-service',
            diagnosticSeverity: { floatingEffect: 'error' },
          },
        ],
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
    for (const selected of providers) {
      expect(await fs.pathExists(selected.typescriptPath)).toBe(false);
    }
    expect(
      (await fs.readdir(path.dirname(tsconfigPath))).filter(file =>
        file.endsWith('.resolved.json'),
      ),
    ).toEqual([]);
  } finally {
    for (const selected of providers) await selected.dispose?.();
    await fs.remove(appDirectory);
  }
});

test('both real BFF and custom-server callers forward the configured provider and app origin', async () => {
  const { appDirectory, tsconfigPath } = await fixture();
  const calls: string[] = [];
  const compiler: Provider = async from => {
    calls.push(from);
    return nativeServerCompiler(from);
  };
  let afterBuild: (() => Promise<void>) | undefined;
  const context = {
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
    getNormalizedConfig: () => config,
    getHooks: () => ({
      onBeforeBffCompile: { call: async () => {} },
      onAfterBffCompile: { call: async () => {} },
    }),
    onAfterBuild: (callback: () => Promise<void>) => {
      afterBuild = callback;
    },
  };
  try {
    serverBuildPlugin().setup!(api as never);
    if (!afterBuild) throw new Error('Custom-server build hook not registered');
    // BFF and custom-server both emit shared/: do not introduce a test-only
    // output race while proving that each independently forwards the provider.
    await createBffGenerator(api as never).compileApi();
    await afterBuild();
    expect(calls).toEqual([appDirectory, appDirectory]);
    for (const file of [
      'api/index.d.ts',
      'server/cache.d.ts',
      'shared/index.d.ts',
    ]) {
      expect(await fs.pathExists(path.join(context.distDirectory, file))).toBe(
        true,
      );
    }
  } finally {
    await fs.remove(appDirectory);
  }
});
