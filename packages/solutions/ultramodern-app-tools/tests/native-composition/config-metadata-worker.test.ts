import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from '@rstest/core';
import { loadUltramodernConfigMetadata } from '../../src/native-composition/config-metadata';

it('loads a TypeScript config whose imports read import.meta in the worker', async () => {
  // Inside the package, so the config resolves the package by self-reference.
  const appDirectory = fs.mkdtempSync(
    path.join(__dirname, '..', '.config-metadata-worker-'),
  );
  try {
    fs.mkdirSync(path.join(appDirectory, 'src'));
    fs.writeFileSync(
      path.join(appDirectory, 'package.json'),
      JSON.stringify({ name: 'shell', type: 'module' }),
    );
    fs.writeFileSync(
      path.join(appDirectory, 'src', 'App.tsx'),
      'export default () => null;',
    );
    // Effect's ConfigProvider spreads `import.meta?.env` the same way.
    fs.writeFileSync(
      path.join(appDirectory, 'environment.ts'),
      'export const environment: Record<string, unknown> = { ...(import.meta as { env?: object })?.env };\n',
    );
    fs.writeFileSync(
      path.join(appDirectory, 'modern.config.ts'),
      [
        "import { defineConfig } from '@modern-js/ultramodern-app-tools';",
        "import { environment } from './environment';",
        'export default defineConfig({',
        "  renderer: 'react',",
        '  source: { globalVars: { ENVIRONMENT_KEYS: Object.keys(environment).length } },',
        '});',
        '',
      ].join('\n'),
    );

    const metadata = await loadUltramodernConfigMetadata({
      appDirectory,
      env: 'production',
      command: 'build',
    });

    expect(metadata.renderer).toBe('react');
    expect(metadata.entries).toHaveLength(1);
  } finally {
    fs.rmSync(appDirectory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'analyzes actual public prefixes and cleans up isolated metadata lifecycle with aliases %s',
  async aliases => {
    const appDirectory = fs.mkdtempSync(
      path.join(__dirname, '..', '.config-route-metadata-'),
    );
    const previousArgv = process.env.MODERN_ARGV;
    // The active build's command must not make the metadata child generate
    // application entries, empty its internal directory or create a compiler.
    process.env.MODERN_ARGV = 'node modern build';
    try {
      fs.mkdirSync(path.join(appDirectory, 'src'));
      fs.writeFileSync(
        path.join(appDirectory, 'package.json'),
        JSON.stringify({ name: 'route-metadata-fixture', type: 'module' }),
      );
      fs.writeFileSync(
        path.join(appDirectory, 'src', 'App.tsx'),
        'export default () => null;',
      );
      const marker = path.join(appDirectory, 'metadata-lifecycle.jsonl');
      fs.writeFileSync(
        path.join(appDirectory, 'modern.config.ts'),
        `import {appendFileSync} from 'node:fs';
import {defineConfig} from '@modern-js/ultramodern-app-tools';
export default defineConfig(context => {
  const record = value => appendFileSync(${JSON.stringify(marker)}, JSON.stringify(value) + '\\n');
  record({factoryCommand: context.command});
  return {renderer:'react', plugins:[{
    name:'fixture:analyzed-public-prefix',
    setup(api) {
      api.modifyServerRoutes(({routes}) => {
        record({command:api.getAppContext().command,argv:process.env.MODERN_ARGV});
        return {routes: routes.flatMap(route => route.isApi ? [route] : [
          {...route,urlPath:'/remote'},
          ${aliases ? "{...route,urlPath:'/alias'}," : ''}
        ])};
      });
      api.generateEntryCode(() => {throw new Error('metadata entered build generation');});
      api.onBeforeExit(() => {record({cleanup:true});});
    },
  }]};
});`,
      );
      const result = loadUltramodernConfigMetadata({
        appDirectory,
        env: 'production',
        command: 'build',
        analyzeServerRoutes: true,
      });
      if (aliases)
        await expect(result).rejects.toThrow(
          'one analyzed public route prefix',
        );
      else
        await expect(result).resolves.toMatchObject({
          renderer: 'react',
          entryBasePaths: { index: '/remote' },
        });
      expect(
        fs
          .readFileSync(marker, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line)),
      ).toEqual([
        { factoryCommand: 'metadata' },
        { command: 'metadata', argv: 'node modern metadata' },
        { cleanup: true },
      ]);
      expect(process.env.MODERN_ARGV).toBe('node modern build');
    } finally {
      if (previousArgv === undefined) delete process.env.MODERN_ARGV;
      else process.env.MODERN_ARGV = previousArgv;
      fs.rmSync(appDirectory, { recursive: true, force: true });
    }
  },
);
