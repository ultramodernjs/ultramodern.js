import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  let originalEnv: { NODE_ENV?: string; MODERN_ARGV?: string };

  beforeEach(() => {
    originalArgv = process.argv;
    originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      MODERN_ARGV: process.env.MODERN_ARGV,
    };
    delete process.env.MODERN_ARGV;
  });

  afterEach(async () => {
    process.argv = originalArgv;
    for (const key of ['NODE_ENV', 'MODERN_ARGV'] as const) {
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

  for (const extension of ['js', 'ts'] as const) {
    describe(`.${extension} config`, () => {
      it('loads ESM dependencies that read optional import.meta properties', async () => {
        const fixture = await createFixture(extension, 'object');
        await writeFile(
          path.join(fixture.cwd, 'dependency.mjs'),
          'export const label = import.meta?.env?.MODE ?? "native-esm";',
        );
        await writeFile(
          path.join(fixture.cwd, fixture.filename),
          extension === 'js'
            ? 'const { label } = require("./dependency.mjs"); module.exports = { label };'
            : 'import { label } from "./dependency.mjs"; export default { label };',
        );

        const loaded = await createLoadedConfig<{ label: string }>(
          fixture.cwd,
          fixture.filename,
          undefined,
          { env: 'test', command: 'build' },
        );

        expect(loaded.config.label).toBe('native-esm');
      });

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
