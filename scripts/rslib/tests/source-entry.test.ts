import { createRslib, type RslibConfig } from '@rslib/core';
import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { pathToFileURL } from 'url';
import { getDtsCompilerOptions } from '../../tsrs-dts/rslib-options.mjs';
import { rslibConfig } from '../src/index';

const fixtureDirectory = path.join(__dirname, 'fixtures/source-entry');
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'modernjs-rslib-source-entry-'),
);
const outputDirectory = path.join(temporaryDirectory, 'dist');
const declarationOutputDirectory = path.join(outputDirectory, 'types');
const outputFormats = [
  { directory: 'esm-node', extension: 'mjs', module: 'esm' },
  { directory: 'esm', extension: 'mjs', module: 'esm' },
  { directory: 'cjs', extension: 'js', module: 'cjs' },
] as const;

function createFixtureBuildConfig(outputRoot: string): RslibConfig {
  const declarationRoot = path.join(outputRoot, 'types');

  return {
    ...rslibConfig,
    lib: rslibConfig.lib?.map(libConfig => ({
      ...libConfig,
      dts:
        typeof libConfig.dts === 'object'
          ? {
              ...libConfig.dts,
              ...getDtsCompilerOptions({}),
              distPath: declarationRoot,
            }
          : libConfig.dts,
      output: {
        ...libConfig.output,
        distPath: {
          ...libConfig.output?.distPath,
          root: path.join(
            outputRoot,
            path.basename(libConfig.output?.distPath?.root ?? libConfig.id),
          ),
        },
      },
    })),
  };
}

function createTemporaryFixtureWorkspace(prefix: string) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repositoryRoot = path.resolve(__dirname, '../../..');
  const inheritedConfigDirectory = path.join(workspace, 'config');
  const referenceDirectory = path.join(workspace, 'reference');

  fs.cpSync(fixtureDirectory, workspace, { recursive: true });
  fs.symlinkSync(
    path.join(repositoryRoot, 'node_modules'),
    path.join(workspace, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.mkdirSync(inheritedConfigDirectory);
  fs.mkdirSync(path.join(referenceDirectory, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'types/fixture-ambient'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(inheritedConfigDirectory, 'shared.json'),
    JSON.stringify({
      extends: path.resolve(__dirname, '../tsconfig.json'),
      compilerOptions: {
        typeRoots: ['../types'],
      },
    }),
  );
  fs.writeFileSync(
    path.join(referenceDirectory, 'tsconfig.json'),
    JSON.stringify({
      extends: path.resolve(__dirname, '../tsconfig.json'),
      compilerOptions: {
        composite: true,
        outDir: './dist',
        rootDir: './src',
      },
      include: ['src'],
    }),
  );
  fs.writeFileSync(
    path.join(referenceDirectory, 'src/index.ts'),
    'export const referencedProject = true;\n',
  );
  fs.writeFileSync(
    path.join(workspace, 'types/fixture-ambient/index.d.ts'),
    "declare namespace FixtureAmbient { type Label = 'ambient'; }\n",
  );
  fs.writeFileSync(
    path.join(workspace, 'types/fixture-ambient/package.json'),
    JSON.stringify({ name: 'fixture-ambient', types: './index.d.ts' }),
  );
  fs.writeFileSync(
    path.join(workspace, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: './config/shared.json',
        compilerOptions: {
          outDir: './dist',
          paths: {
            '@fixture/*': ['./src/*'],
          },
          rootDir: './src',
          types: ['fixture-ambient'],
        },
        include: ['src'],
        references: [{ path: './reference' }],
      },
      null,
      2,
    ),
  );
  fs.appendFileSync(
    path.join(workspace, 'src/entry.ts'),
    "\nexport const ambientLabel: FixtureAmbient.Label = 'ambient';\n",
  );

  return workspace;
}

async function waitForFileContent(
  filePath: string,
  predicate: (content: string) => boolean,
) {
  const deadline = Date.now() + 15_000;
  let content = '';

  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
      if (predicate(content)) {
        return content;
      }
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for declaration output at ${filePath}`);
}

describe('Rslib bundleless source entries', () => {
  beforeAll(async () => {
    const config = createFixtureBuildConfig(outputDirectory);
    const rslib = await createRslib({ cwd: fixtureDirectory, config });

    await rslib.build();
  }, 120_000);

  afterAll(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('emits executable TypeScript and TSX modules for every bundleless output', async () => {
    for (const outputFormat of outputFormats) {
      const entryPath = path.join(
        outputDirectory,
        outputFormat.directory,
        `entry.${outputFormat.extension}`,
      );
      const componentPath = path.join(
        outputDirectory,
        outputFormat.directory,
        `component.${outputFormat.extension}`,
      );
      const entry =
        outputFormat.module === 'esm'
          ? await import(pathToFileURL(entryPath).href)
          : require(entryPath);
      const component =
        outputFormat.module === 'esm'
          ? await import(pathToFileURL(componentPath).href)
          : require(componentPath);

      expect(entry.identifySourceEntry()).toBe('typescript-entry');
      expect(component.Greeting({ name: 'UltraModern' })).toMatchObject({
        element: 'strong',
        label: 'UltraModern',
      });
    }
  });

  it('does not emit Markdown as a library module', () => {
    for (const outputFormat of outputFormats) {
      expect(
        fs.existsSync(
          path.join(outputDirectory, outputFormat.directory, 'SPEC.md'),
        ),
      ).toBe(false);
    }
  });

  it('emits declarations through the packed TypeScript 7 Rslib build', () => {
    const entryDeclaration = fs.readFileSync(
      path.join(declarationOutputDirectory, 'entry.d.ts'),
      'utf8',
    );

    expect(entryDeclaration).toContain('identifySourceEntry(): string');
    expect(entryDeclaration).toContain("from './component.js'");
    expect(entryDeclaration).not.toContain('@fixture/component');
    expect(
      fs.readFileSync(
        path.join(declarationOutputDirectory, 'component.d.ts'),
        'utf8',
      ),
    ).toContain('export declare function Greeting');
  });

  it('rewrites declaration aliases with relative output directories', async () => {
    const workspace = createTemporaryFixtureWorkspace(
      'modernjs-rslib-relative-output-',
    );
    try {
      const rslib = await createRslib({
        cwd: workspace,
        config: createFixtureBuildConfig('./dist'),
      });
      await rslib.build();
      const declaration = fs.readFileSync(
        path.join(workspace, 'dist/types/entry.d.ts'),
        'utf8',
      );
      expect(declaration).toContain("from './component.js'");
      expect(declaration).not.toContain('@fixture/component');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('regenerates TypeScript 7 declarations during Rslib watch builds', async () => {
    const watchWorkspace = createTemporaryFixtureWorkspace(
      'modernjs-rslib-watch-',
    );
    const watchOutputDirectory = path.join(watchWorkspace, 'dist');
    const watchDeclarationDirectory = path.join(watchOutputDirectory, 'types');
    const watchConfig = createFixtureBuildConfig(watchOutputDirectory);
    const rslib = await createRslib({
      cwd: watchWorkspace,
      config: watchConfig,
    });
    const buildResult = await rslib.build({ watch: true });

    try {
      const sourcePath = path.join(watchWorkspace, 'src/entry.ts');
      const declarationPath = path.join(
        watchDeclarationDirectory,
        'entry.d.ts',
      );
      const baselineDeclaration = await waitForFileContent(
        declarationPath,
        declaration => declaration.includes('identifySourceEntry(): string'),
      );
      expect(baselineDeclaration).toContain(
        'ambientLabel: FixtureAmbient.Label',
      );
      fs.appendFileSync(
        sourcePath,
        '\nexport function identifyWatchedDeclaration(): number { return 7; }\n',
      );

      const declaration = await waitForFileContent(declarationPath, content =>
        content.includes('identifyWatchedDeclaration(): number'),
      );

      expect(declaration).toContain('identifyWatchedDeclaration(): number');
    } finally {
      await buildResult.close();
      fs.rmSync(watchWorkspace, { force: true, recursive: true });
    }
  }, 120_000);

  it('fails the Rslib build when TypeScript 7 declaration diagnostics fail', async () => {
    const invalidWorkspace = createTemporaryFixtureWorkspace(
      'modernjs-rslib-invalid-',
    );
    const invalidOutputDirectory = path.join(invalidWorkspace, 'dist');
    fs.appendFileSync(
      path.join(invalidWorkspace, 'src/entry.ts'),
      '\nexport const invalidDeclaration: string = 7;\n',
    );

    try {
      const rslib = await createRslib({
        cwd: invalidWorkspace,
        config: createFixtureBuildConfig(invalidOutputDirectory),
      });

      await expect(rslib.build()).rejects.toThrow(
        'declaration files generation',
      );
    } finally {
      fs.rmSync(invalidWorkspace, { force: true, recursive: true });
    }
  }, 120_000);
});
