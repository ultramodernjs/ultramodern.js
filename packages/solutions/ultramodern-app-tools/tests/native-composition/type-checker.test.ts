import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { UltramodernNativeTypeChecker } from '@modern-js/app-tools-extensions/native-type-checker';
import { rspack } from '@rsbuild/core';
import { rendererTypeCheckerPlugin } from '../../src/native-composition/type-checker';

const require = createRequire(import.meta.url);

test('the configured build checker resolves the app cohort rather than typescriptPath in another installation', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'native-checker-app-origin-')),
  );
  const appDirectory = path.join(root, 'app');
  const foreignDirectory = path.join(root, 'foreign/node_modules/typescript');
  const previous = {
    EFFECT_TSGO_BIN: process.env.EFFECT_TSGO_BIN,
    TSRS_BINARY: process.env.TSRS_BINARY,
  };
  let compiler: ReturnType<typeof rspack> | undefined;
  try {
    delete process.env.EFFECT_TSGO_BIN;
    delete process.env.TSRS_BINARY;
    fs.mkdirSync(path.join(appDirectory, 'node_modules'), { recursive: true });
    fs.mkdirSync(foreignDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(foreignDirectory, 'package.json'),
      JSON.stringify({ name: 'typescript', version: '7.0.2' }),
    );
    for (const name of ['tsrs', '@effect/tsgo', 'typescript']) {
      const target = path.join(appDirectory, 'node_modules', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(
        path.dirname(require.resolve(`${name}/package.json`)),
        target,
        'dir',
      );
    }
    fs.writeFileSync(
      path.join(appDirectory, 'package.json'),
      JSON.stringify({ private: true }),
    );
    fs.writeFileSync(
      path.join(appDirectory, 'entry.js'),
      'console.log("bundled");',
    );
    fs.writeFileSync(
      path.join(appDirectory, 'checked.ts'),
      'export const value: string = 1;',
    );
    const configFile = path.join(appDirectory, 'tsconfig.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        compilerOptions: { module: 'ESNext', types: [], strict: true },
        files: ['checked.ts'],
      }),
    );
    let tools: any;
    const plugin = rendererTypeCheckerPlugin('react');
    (plugin.setup as Function)({
      config: (configure: Function) => {
        tools = configure().tools;
      },
      getAppContext: () => ({ appDirectory }),
    });
    let checker: UltramodernNativeTypeChecker | undefined;
    let command: { executable: string; args: string[] } | undefined;
    const checkerPlugin = {
      get: () => [
        {
          typescript: {
            configFile,
            tsgo: true,
            typescriptPath: path.join(foreignDirectory, 'package.json'),
          },
        },
      ],
      use: (
        Constructor: typeof UltramodernNativeTypeChecker,
        [options]: any[],
      ) => {
        command = options.compiler();
        checker = new Constructor(options);
      },
    };
    tools.bundlerChain(
      { plugins: new Set(['checker']), plugin: () => checkerPlugin },
      { CHAIN_ID: { PLUGIN: { TS_CHECKER: 'checker' } } },
    );
    const appRequire = createRequire(path.join(appDirectory, 'package.json'));
    const tsrsManifest = appRequire('tsrs/package.json');
    const effectManifest = appRequire.resolve('@effect/tsgo/package.json');
    const effect = JSON.parse(fs.readFileSync(effectManifest, 'utf8'));
    const effectPlatform = createRequire(effectManifest).resolve(
      `@effect/tsgo-${process.platform}-${process.arch}/package.json`,
    );
    const { getPlatformPackageName } = appRequire(
      path.join(
        path.dirname(appRequire.resolve('tsrs/package.json')),
        'lib/platform.js',
      ),
    );
    const supported =
      tsrsManifest.optionalDependencies[getPlatformPackageName()] ===
      tsrsManifest.version;
    const expected = supported
      ? path.join(
          path.dirname(effectPlatform),
          'artifacts/tsrs',
          tsrsManifest.version,
          process.platform === 'win32' ? 'tsrs.exe' : 'tsrs',
        )
      : path.join(
          path.dirname(effectPlatform),
          'lib',
          process.platform === 'win32' ? 'tsc.exe' : 'tsc',
        );
    expect(command?.executable).toBe(fs.realpathSync(expected));
    const version = execFileSync(command!.executable, ['--version'], {
      encoding: 'utf8',
    });
    expect(version).toContain(`+effect-tsgo.${effect.version}`);
    if (supported) expect(version).toContain(`tsrs ${tsrsManifest.version}`);
    compiler = rspack({
      context: appDirectory,
      mode: 'development',
      devtool: false,
      entry: './entry.js',
      output: { path: path.join(appDirectory, 'dist') },
      plugins: [checker!],
    });
    const stats = await new Promise<any>((resolve, reject) =>
      compiler!.run((error, stats) => (error ? reject(error) : resolve(stats))),
    );
    expect(stats.hasErrors()).toBe(true);
    expect(stats.toString({ all: false, errors: true })).toContain('TS2322');
    expect(
      stats.compilation.fileDependencies.has(
        path.join(appDirectory, 'checked.ts'),
      ),
    ).toBe(true);
  } finally {
    if (compiler)
      await new Promise<void>((resolve, reject) =>
        compiler!.close(error => (error ? reject(error) : resolve())),
      );
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
