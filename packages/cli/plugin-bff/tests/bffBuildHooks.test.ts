import os from 'node:os';
import path from 'node:path';
import { fs } from '@modern-js/utils';
import { bffPlugin } from '../src/cli';
import { createBffGenerator } from '../src/cli/generator';

async function fixture(
  source = 'export const value: number = 1;',
  sourceMap?: boolean,
) {
  const appDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'native-bff-hooks-')),
  );
  const apiDirectory = path.join(appDirectory, 'api');
  await fs.outputFile(path.join(apiDirectory, 'index.ts'), source);
  await fs.outputJSON(path.join(appDirectory, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      moduleResolution: 'Node',
      noEmitOnError: true,
    },
    include: ['api'],
  });
  await fs.outputJSON(path.join(appDirectory, 'package.json'), {
    name: 'native-hooks',
  });
  const hooks = bffPlugin().registryHooks!;
  const context = {
    appDirectory,
    apiDirectory,
    lambdaDirectory: path.join(apiDirectory, 'lambda'),
    distDirectory: path.join(appDirectory, 'dist'),
    sharedDirectory: path.join(appDirectory, 'shared'),
    moduleType: 'commonjs',
    serverCompileExcludedFiles: [] as string[],
  };
  const api = {
    getAppContext: () => context,
    getHooks: () => hooks,
    getNormalizedConfig: () => ({
      source: {},
      resolve: {},
      server: {},
      output: { sourceMap },
      bff: {},
    }),
  };
  return { appDirectory, context, hooks, ...createBffGenerator(api as never) };
}

test('forwards disabled source maps to the BFF compiler', async () => {
  const { appDirectory, compileApi } = await fixture(undefined, false);
  try {
    await compileApi();
    const output = path.join(appDirectory, 'dist/api/index.js');
    expect(require(output).value).toBe(1);
    expect(fs.existsSync(`${output}.map`)).toBe(false);
    expect(await fs.readFile(output, 'utf8')).not.toContain(
      'sourceMappingURL=',
    );
  } finally {
    await fs.remove(appDirectory);
  }
});

test('runs before and after around actual compilation with the same context', async () => {
  const { appDirectory, hooks, compileApi } = await fixture();
  const seen: unknown[] = [];
  const output = path.join(appDirectory, 'dist/api/index.js');
  try {
    hooks.onBeforeBffCompile.tap(context => {
      expect(fs.existsSync(output)).toBe(false);
      seen.push(context);
    });
    hooks.onAfterBffCompile.tap(context => {
      expect(fs.existsSync(output)).toBe(true);
      seen.push(context);
    });
    await compileApi();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toMatchObject({
      appDirectory,
      sourceDirectories: [path.join(appDirectory, 'api')],
    });
    expect(
      (seen[0] as { outputDirectories: string[] }).outputDirectories.map(
        directory => path.normalize(directory),
      ),
    ).toEqual([path.join(appDirectory, 'dist/api')]);
  } finally {
    await fs.remove(appDirectory);
  }
});

test('before hook failures prevent writes and compiler failures do not run after hooks', async () => {
  const first = await fixture();
  try {
    first.hooks.onBeforeBffCompile.tap(() => {
      throw new Error('before rejected');
    });
    await expect(first.compileApi()).rejects.toThrow('before rejected');
    expect(fs.existsSync(path.join(first.appDirectory, 'dist'))).toBe(false);
  } finally {
    await fs.remove(first.appDirectory);
  }
  const broken = await fixture('export const value: number = "invalid";');
  try {
    const after = rstest.fn();
    broken.hooks.onAfterBffCompile.tap(after);
    await expect(broken.compileApi()).rejects.toThrow();
    expect(after).not.toHaveBeenCalled();
  } finally {
    await fs.remove(broken.appDirectory);
  }
});

test('forwards the current exact generated declaration exclusions after before hooks', async () => {
  const { appDirectory, context, hooks, compileApi } = await fixture();
  try {
    const excluded = path.join(context.apiDirectory, 'register.gen.d.ts');
    await fs.outputFile(
      excluded,
      "import type { Missing } from 'unavailable-generated-client-module';",
    );
    hooks.onBeforeBffCompile.tap(() => {
      context.serverCompileExcludedFiles = [excluded];
    });
    await compileApi();
    expect(fs.existsSync(path.join(appDirectory, 'dist/api/index.js'))).toBe(
      true,
    );
  } finally {
    await fs.remove(appDirectory);
  }
});
