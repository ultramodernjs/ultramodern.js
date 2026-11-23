import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import { createLoadedConfig } from '../src/cli/run/config/createLoadedConfig';

type ConfigForm = 'object' | 'sync' | 'async';
type ConfigExtension = 'js' | 'ts';

interface FixtureConfig {
  label: string;
  settings: {
    primary?: boolean;
    local?: boolean;
    programmatic?: boolean;
    value: string;
  };
  values: string[];
}

interface ConfigInvocation {
  source: string;
  context: { env: string; command: string };
}

describe('config evaluation context', () => {
  const tempDirs: string[] = [];
  let originalArgv: string[];
  let originalEnv: {
    NODE_ENV?: string;
    MODERN_ARGV?: string;
    MODERN_LIB_FORMAT?: string;
  };

  beforeEach(() => {
    originalArgv = process.argv;
    originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      MODERN_ARGV: process.env.MODERN_ARGV,
      MODERN_LIB_FORMAT: process.env.MODERN_LIB_FORMAT,
    };
    delete process.env.MODERN_ARGV;
  });

  afterEach(async () => {
    process.argv = originalArgv;
    for (const key of [
      'NODE_ENV',
      'MODERN_ARGV',
      'MODERN_LIB_FORMAT',
    ] as const) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })),
    );
  });

  async function createFixture(extension: ConfigExtension, form: ConfigForm) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'modern-config-context-'));
    tempDirs.push(cwd);
    const traceFile = path.join(cwd, 'config-invocations.jsonl');
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'config-evaluation-context-test' }),
    );
    await writeFile(traceFile, '');

    for (const source of ['primary', 'local'] as const) {
      const filename =
        source === 'primary'
          ? `modern.config.${extension}`
          : `modern.config.local.${extension}`;
      const config = JSON.stringify({
        label: source,
        settings: { [source]: true, value: source },
        values: ['shared', source],
      });
      const exportPrefix =
        extension === 'js' ? 'module.exports = ' : 'export default ';
      const fsImport =
        extension === 'js'
          ? "const { appendFileSync } = require('node:fs');"
          : "import { appendFileSync } from 'node:fs';";
      const callbackArgument =
        extension === 'ts'
          ? '(context: { env: string; command: string })'
          : '(context)';
      const contents =
        form === 'object'
          ? `${exportPrefix}${config};`
          : `${fsImport}
${exportPrefix}${form === 'async' ? 'async ' : ''}${callbackArgument} => {
  appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ source: ${JSON.stringify(source)}, context }) + '\\n');
  ${form === 'async' ? 'await Promise.resolve();' : ''}
  return ${config};
};`;
      await writeFile(path.join(cwd, filename), contents);
    }

    return {
      cwd,
      filename: `modern.config.${extension}`,
      async invocations(): Promise<ConfigInvocation[]> {
        const trace = await readFile(traceFile, 'utf8');
        return trace
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line));
      },
    };
  }

  it('reloads edited TypeScript configuration and dependencies', async () => {
    const fixture = await createFixture('ts', 'object');
    const dependency = path.join(fixture.cwd, 'dependency.ts');
    await writeFile(dependency, 'export const label: string = "first";');
    const file = path.join(fixture.cwd, fixture.filename);
    await writeFile(
      file,
      'import { label } from "./dependency.ts"; export default { label };',
    );
    const load = () =>
      createLoadedConfig<{ label: string }>(
        fixture.cwd,
        fixture.filename,
        undefined,
        { env: 'test', command: 'build' },
      );

    expect((await load()).config.label).toBe('first');
    await writeFile(dependency, 'export const label: string = "second";');
    await writeFile(
      file,
      'import { label } from "./dependency.ts"; export default { label: label + "-edited" };',
    );
    expect((await load()).config.label).toBe('second-edited');
  });

  it.each(['mjs', 'js'])(
    'reloads edited local .%s ESM helpers',
    async extension => {
      process.env.MODERN_LIB_FORMAT = 'cjs';
      const fixture = await createFixture('ts', 'object');
      const directory = path.join(fixture.cwd, 'local-esm-helper');
      await mkdir(directory);
      await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ type: 'module' }),
      );
      const dependency = path.join(directory, `index.${extension}`);
      await writeFile(dependency, 'export const label = "first";');
      await writeFile(
        path.join(fixture.cwd, fixture.filename),
        `import { label } from "./local-esm-helper/index.${extension}"; export default { label };`,
      );
      const load = () =>
        createLoadedConfig<{ label: string }>(
          fixture.cwd,
          fixture.filename,
          undefined,
          { env: 'test', command: 'build' },
        );

      expect((await load()).config.label).toBe('first');
      await writeFile(dependency, 'export const label = "second";');
      expect((await load()).config.label).toBe('second');
    },
  );

  it('preserves missing dependency error codes and config context', async () => {
    const fixture = await createFixture('ts', 'object');
    const configFile = path.join(fixture.cwd, fixture.filename);
    await writeFile(
      configFile,
      'import "missing-modern-config-package"; export default {};',
    );

    await expect(
      createLoadedConfig(fixture.cwd, fixture.filename, undefined, {
        env: 'test',
        command: 'build',
      }),
    ).rejects.toMatchObject({
      code: 'MODULE_NOT_FOUND',
      message: expect.stringContaining(`loading config file: ${configFile}`),
    });
  });

  it.each(['cjs', 'esm'])(
    'preserves %s package identity, re-exports and dynamic imports',
    async format => {
      process.env.MODERN_LIB_FORMAT = format;
      const fixture = await createFixture('ts', 'object');
      const configFile = path.join(fixture.cwd, fixture.filename);
      const packageDirectory = path.join(
        fixture.cwd,
        'node_modules',
        'config-runtime',
      );
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        path.join(packageDirectory, 'package.json'),
        JSON.stringify({
          name: 'config-runtime',
          exports: { import: './index.mjs', require: './index.cjs' },
        }),
      );
      await writeFile(
        path.join(packageDirectory, 'index.cjs'),
        `exports.identity = {}; exports.loadBundle = file => require(file);
const callable = () => "callable";
callable.sync = () => "sync";
Object.defineProperty(exports, "callable", { enumerable: true, get: () => callable });`,
      );
      await writeFile(
        path.join(packageDirectory, 'index.mjs'),
        `export const identity = {}; export const loadBundle = file => import(file);
export const callable = () => "callable";
callable.sync = () => "sync";`,
      );
      const helperDirectory = path.join(fixture.cwd, 'config');
      await mkdir(helperDirectory);
      await writeFile(
        path.join(helperDirectory, 'named.ts'),
        'export { identity, callable } from "config-runtime";',
      );
      await writeFile(
        path.join(helperDirectory, 'all.ts'),
        'export * from "./named.ts";',
      );
      const bundleFile = path.join(fixture.cwd, 'server-bundle.cjs');
      await writeFile(
        bundleFile,
        `const handlers = { requestHandler: () => 'ssr', handleRequest: () => 'loader' };
for (const name in handlers) {
  Object.defineProperty(exports, name, { enumerable: true, get: () => handlers[name] });
}`,
      );
      await writeFile(
        configFile,
        `import { identity, loadBundle, callable } from "config-runtime";
import { identity as transitiveIdentity, callable as transitiveCallable } from "./config/all.ts";
export default async () => ({
  identity, transitiveIdentity, loadBundle, callable, transitiveCallable,
  callableResult: callable.sync(),
  dynamicIdentity: (await import("config-runtime")).identity,
});`,
      );

      const loaded = await createLoadedConfig<{
        identity: object;
        transitiveIdentity: object;
        dynamicIdentity: object;
        callable: (() => string) & { sync: () => string };
        transitiveCallable: (() => string) & { sync: () => string };
        callableResult: string;
        loadBundle: (file: string) => {
          requestHandler: () => string;
          handleRequest: () => string;
        };
      }>(fixture.cwd, fixture.filename, undefined, {
        env: 'test',
        command: 'build',
      });
      const imported = await import(
        pathToFileURL(path.join(packageDirectory, 'index.mjs')).href
      );
      const expected =
        format === 'cjs'
          ? createRequire(configFile)('config-runtime')
          : imported;

      if (format === 'cjs') {
        const bundle = await loaded.config.loadBundle(bundleFile);
        expect(bundle.requestHandler()).toBe('ssr');
        expect(bundle.handleRequest()).toBe('loader');
      }
      expect(loaded.config.identity).toBe(expected.identity);
      expect(loaded.config.transitiveIdentity).toBe(expected.identity);
      expect(loaded.config.dynamicIdentity).toBe(imported.identity);
      expect(loaded.config.loadBundle).toBe(expected.loadBundle);
      expect(loaded.config.callableResult).toBe('sync');
      expect(loaded.config.callable.sync()).toBe('sync');
      expect(loaded.config.callable).toBe(expected.callable);
      expect(loaded.config.transitiveCallable).toBe(expected.callable);
    },
  );

  for (const extension of ['js', 'ts'] as const) {
    describe(`.${extension} config`, () => {
      it.each(['mjs', 'js'])(
        'loads installed .%s ESM dependencies that read optional import.meta properties',
        async dependencyExtension => {
          const fixture = await createFixture(extension, 'object');
          const dependencyDirectory = path.join(
            fixture.cwd,
            'node_modules',
            'native-esm-dependency',
          );
          await mkdir(dependencyDirectory, { recursive: true });
          await writeFile(
            path.join(dependencyDirectory, 'package.json'),
            JSON.stringify({
              name: 'native-esm-dependency',
              type: 'module',
              exports: `./index.${dependencyExtension}`,
            }),
          );
          await writeFile(
            path.join(dependencyDirectory, `index.${dependencyExtension}`),
            'export const label = import.meta?.env?.MODE ?? "native-esm";',
          );
          const specifier = 'native-esm-dependency';
          await writeFile(
            path.join(fixture.cwd, fixture.filename),
            extension === 'js'
              ? `const { label } = require("${specifier}"); module.exports = { label };`
              : `import { label } from "${specifier}"; export default { label };`,
          );

          const loaded = await createLoadedConfig<{ label: string }>(
            fixture.cwd,
            fixture.filename,
            undefined,
            { env: 'test', command: 'build' },
          );

          expect(loaded.config.label).toBe('native-esm');
        },
      );

      it('isolates callback mutation from its caller and local evaluation', async () => {
        process.argv = ['node', 'modern', 'build'];
        const fixture = await createFixture(extension, 'sync');
        const file = path.join(fixture.cwd, fixture.filename);
        const source = await readFile(file, 'utf8');
        await writeFile(
          file,
          source.replace(
            'return {',
            "context.env = 'changed'; context.command = 'build'; return {",
          ),
        );
        const context = { env: 'staging', command: 'dev' };
        const loaded = await createLoadedConfig<FixtureConfig>(
          fixture.cwd,
          fixture.filename,
          undefined,
          context,
        );
        expect(context).toEqual({ env: 'staging', command: 'dev' });
        expect(loaded.config.label).toBe('local');
        expect(await fixture.invocations()).toEqual([
          { source: 'primary', context: { env: 'staging', command: 'dev' } },
          { source: 'local', context: { env: 'staging', command: 'dev' } },
        ]);
      });
      it.each(['object', 'sync', 'async'] as const)(
        'loads %s primary and local exports with an explicit dev context',
        async form => {
          process.argv = ['node', 'modern', 'build'];
          process.env.NODE_ENV = 'production';
          const fixture = await createFixture(extension, form);
          const context = { env: 'staging', command: 'dev' };

          const loaded = await createLoadedConfig<FixtureConfig>(
            fixture.cwd,
            fixture.filename,
            undefined,
            context,
          );

          expect(loaded.config).toEqual({
            label: 'local',
            settings: { primary: true, local: true, value: 'local' },
            values: ['shared', 'primary', 'local'],
          });
          expect(await fixture.invocations()).toEqual(
            form === 'object'
              ? []
              : [
                  { source: 'primary', context },
                  { source: 'local', context },
                ],
          );
        },
      );

      it.each(['sync', 'async'] as const)(
        'skips the local %s callback during an explicit build despite dev argv',
        async form => {
          process.argv = ['node', 'modern', 'dev'];
          process.env.NODE_ENV = 'development';
          const fixture = await createFixture(extension, form);
          const context = { env: 'preview', command: 'build' };

          const loaded = await createLoadedConfig<FixtureConfig>(
            fixture.cwd,
            fixture.filename,
            undefined,
            context,
          );

          expect(loaded.config).toEqual({
            label: 'primary',
            settings: { primary: true, value: 'primary' },
            values: ['shared', 'primary'],
          });
          expect(await fixture.invocations()).toEqual([
            { source: 'primary', context },
          ]);
        },
      );

      it('loads local config for an explicit start command despite build argv', async () => {
        process.argv = ['node', 'modern', 'build'];
        const fixture = await createFixture(extension, 'sync');
        const context = { env: 'preview', command: 'start' };

        const loaded = await createLoadedConfig<FixtureConfig>(
          fixture.cwd,
          fixture.filename,
          undefined,
          context,
        );

        expect(loaded.config.label).toBe('local');
        expect(await fixture.invocations()).toEqual([
          { source: 'primary', context },
          { source: 'local', context },
        ]);
      });

      it('preserves argv, NODE_ENV, and start-command local loading without an explicit context', async () => {
        process.argv = ['node', 'modern', 'build'];
        process.env.MODERN_ARGV = 'node modern start';
        process.env.NODE_ENV = 'production';
        const fixture = await createFixture(extension, 'async');

        const loaded = await createLoadedConfig<FixtureConfig>(
          fixture.cwd,
          fixture.filename,
        );

        expect(loaded.config.label).toBe('local');
        expect(await fixture.invocations()).toEqual([
          {
            source: 'primary',
            context: { env: 'production', command: 'start' },
          },
          {
            source: 'local',
            context: { env: 'production', command: 'start' },
          },
        ]);
      });

      it('defaults an absent NODE_ENV to development without an explicit context', async () => {
        process.argv = ['node', 'modern', 'build'];
        delete process.env.NODE_ENV;
        const fixture = await createFixture(extension, 'sync');

        const loaded = await createLoadedConfig<FixtureConfig>(
          fixture.cwd,
          fixture.filename,
        );

        expect(loaded.config.label).toBe('primary');
        expect(await fixture.invocations()).toEqual([
          {
            source: 'primary',
            context: { env: 'development', command: 'build' },
          },
        ]);
      });

      it('merges programmatic config after evaluated primary and local config', async () => {
        const fixture = await createFixture(extension, 'async');
        const context = { env: 'test', command: 'dev' };

        const loaded = await createLoadedConfig<FixtureConfig>(
          fixture.cwd,
          fixture.filename,
          {
            label: 'programmatic',
            settings: { programmatic: true, value: 'programmatic' },
            values: ['shared', 'programmatic'],
          },
          context,
        );

        expect(loaded.config).toEqual({
          label: 'programmatic',
          settings: {
            primary: true,
            local: true,
            programmatic: true,
            value: 'programmatic',
          },
          values: ['shared', 'primary', 'local', 'programmatic'],
        });
        expect(await fixture.invocations()).toEqual([
          { source: 'primary', context },
          { source: 'local', context },
        ]);
      });
    });
  }
});
