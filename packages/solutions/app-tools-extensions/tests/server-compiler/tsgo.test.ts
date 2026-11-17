import { createRequire } from 'node:module';
import { fs } from '@modern-js/utils';
import os from 'os';
import path from 'path';
import { compileServerSources as compile } from '../../src/server-compiler';
import {
  createResolvedTsgoConfig,
  getTsgoBinPath,
} from '../../src/server-compiler/tsgo';

/** A server app whose roots and `paths` mirror a generated Modern.js app. */
const createIsolatedTsExample = async (prefix = 'server-compiler-tsgo-') => {
  const tempRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  const example = path.join(tempRoot, 'ts-example');
  await fs.outputJSON(path.join(example, 'tsconfig.json'), {
    compilerOptions: {
      declaration: false,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      paths: { '@/*': ['./src/*'], '@shared/*': ['./shared/*'] },
      types: [],
    },
    include: ['src', 'shared', 'server', 'api', 'modern-app-env.d.ts'],
  });
  await fs.outputJSON(path.join(example, 'nested/tsconfig.json'), {
    extends: '../tsconfig.json',
  });
  await fs.outputFile(
    path.join(example, 'modern-app-env.d.ts'),
    "declare module '@modern-js/runtime/server' {}\n",
  );
  for (const file of [
    'api/index.ts',
    'shared/index.ts',
    'server/index.ts',
    'src/index.ts',
  ]) {
    await fs.outputFile(path.join(example, file), 'export const value = 1;\n');
  }
  return { example, tempRoot };
};

const require = createRequire(import.meta.url);

describe('getTsgoBinPath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'server-compiler-tsgo-')),
    );
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('prefers the app-local stable TypeScript 7.0.2 compiler', async () => {
    const pkgDir = path.join(tmpDir, 'node_modules/typescript');
    await fs.outputJSON(path.join(pkgDir, 'package.json'), {
      name: 'typescript',
      version: '7.0.2',
      exports: { './package.json': './package.json' },
      bin: { tsc: './bin/tsc' },
    });
    await fs.outputFile(path.join(pkgDir, 'bin/tsc'), '// stub\n');

    expect(getTsgoBinPath(tmpDir)).toBe(path.join(pkgDir, 'bin/tsc'));
  });

  it.each(['@typescript/native-preview', '@typescript/native'])(
    'does not select %s instead of the canonical stable package',
    async name => {
      const pkgDir = path.join(tmpDir, 'node_modules', name);
      await fs.outputJSON(path.join(pkgDir, 'package.json'), {
        name: 'typescript',
        version: '7.0.2',
        exports: { './package.json': './package.json' },
        bin: { tsc: './bin/tsc' },
      });
      await fs.outputFile(path.join(pkgDir, 'bin/tsc'), '// stub\n');

      expect(() => getTsgoBinPath(tmpDir, [tmpDir])).toThrow(
        'Please install "typescript@7.0.2"',
      );
    },
  );

  it('uses the declared stable production compiler when the app has none', () => {
    const binPath = getTsgoBinPath(tmpDir);
    const pkgPath = require.resolve('typescript/package.json');
    const pkg = require(pkgPath);

    expect(pkg.name).toBe('typescript');
    expect(pkg.version).toBe('7.0.2');
    expect(binPath).toBe(path.resolve(path.dirname(pkgPath), pkg.bin.tsc));
    expect(fs.existsSync(binPath)).toBe(true);
  });

  it.each(['5.9.3', '6.0.2', '7.0.0-dev.20260707.2'])(
    'rejects an app-local incompatible compiler %s without falling back',
    async version => {
      const pkgDir = path.join(tmpDir, 'node_modules/typescript');
      await fs.outputJSON(path.join(pkgDir, 'package.json'), {
        name: 'typescript',
        version,
        bin: { tsc: './bin/tsc' },
      });
      await fs.outputFile(path.join(pkgDir, 'bin/tsc'), '// stub\n');

      expect(() => getTsgoBinPath(tmpDir)).toThrow(
        `requires typescript@7.0.2; found typescript@${version}`,
      );
    },
  );

  it('does not guess an undeclared compiler launcher', async () => {
    const pkgDir = path.join(tmpDir, 'node_modules/typescript');
    await fs.outputJSON(path.join(pkgDir, 'package.json'), {
      name: 'typescript',
      version: '7.0.2',
      bin: { tsgo: './bin/tsgo.js' },
    });
    await fs.outputFile(path.join(pkgDir, 'bin/tsgo.js'), '// stub\n');

    expect(() => getTsgoBinPath(tmpDir)).toThrow('declares no tsc executable');
  });

  it('rejects a declared compiler launcher that is not present', async () => {
    const pkgDir = path.join(tmpDir, 'node_modules/typescript');
    await fs.outputJSON(path.join(pkgDir, 'package.json'), {
      name: 'typescript',
      version: '7.0.2',
      bin: { tsc: './bin/tsc' },
    });

    expect(() => getTsgoBinPath(tmpDir)).toThrow('executable is missing');
  });

  it('rejects a compiler launcher outside its declared package owner', async () => {
    const pkgDir = path.join(tmpDir, 'node_modules/typescript');
    await fs.outputJSON(path.join(pkgDir, 'package.json'), {
      name: 'typescript',
      version: '7.0.2',
      bin: { tsc: '../../outside-tsc' },
    });
    await fs.outputFile(path.join(tmpDir, 'outside-tsc'), '// stub\n');

    expect(() => getTsgoBinPath(tmpDir)).toThrow('outside its package');
  });

  it('throws an actionable error when the stable compiler cannot be resolved', () => {
    expect(() => getTsgoBinPath(tmpDir, [tmpDir])).toThrow(
      'Please install "typescript@7.0.2"',
    );
  });
});

describe('createResolvedTsgoConfig', () => {
  it('bases the resolved config beside the tsconfig, including nested tsconfig paths', async () => {
    const { example, tempRoot } = await createIsolatedTsExample();
    const nestedDir = path.join(example, 'nested');
    const tsconfigPath = path.join(nestedDir, 'tsconfig.json');
    const sourceDirs = [
      path.join(example, 'shared'),
      path.join(example, 'api'),
      path.join(example, 'server'),
    ];

    const { config, resolvedConfigPath } = await createResolvedTsgoConfig(
      example,
      tsconfigPath,
      sourceDirs,
      getTsgoBinPath(example),
    );

    try {
      // The temp config lives beside the tsconfig so the relative `files`
      // emitted by --showConfig keep their base directory.
      expect(path.dirname(resolvedConfigPath)).toBe(nestedDir);
      expect(await fs.pathExists(resolvedConfigPath)).toBe(true);

      // `files` are relative to the tsconfig directory and must survive the
      // source-dir filtering even when the tsconfig sits in a subdirectory.
      const resolvedFiles = (config.files ?? []).map(file =>
        path.resolve(nestedDir, file),
      );
      expect(resolvedFiles).toContain(path.join(example, 'api/index.ts'));
      expect(resolvedFiles).toContain(path.join(example, 'shared/index.ts'));
      expect(resolvedFiles).toContain(path.join(example, 'server/index.ts'));
    } finally {
      await fs.remove(tempRoot);
    }
  });

  it.each([
    { name: 'missing', excludeFiles: undefined },
    { name: 'empty', excludeFiles: [] },
  ])(
    'retains declaration roots with $name exclusions',
    async ({ excludeFiles }) => {
      const { example, tempRoot } = await createIsolatedTsExample();
      const tsconfigPath = path.join(example, 'tsconfig.json');
      const declaration = path.join(example, 'src/client/register.gen.d.ts');

      try {
        await fs.outputFile(declaration, 'export interface Client {}\n');
        const { config } = await createResolvedTsgoConfig(
          example,
          tsconfigPath,
          [path.join(example, 'api')],
          getTsgoBinPath(example),
          excludeFiles,
        );
        const resolvedFiles = (config.files ?? []).map(file =>
          path.resolve(example, file),
        );
        expect(resolvedFiles).toContain(declaration);
        expect(resolvedFiles).toContain(
          path.join(example, 'modern-app-env.d.ts'),
        );
        expect(resolvedFiles).toContain(path.join(example, 'api/index.ts'));
      } finally {
        await fs.remove(tempRoot);
      }
    },
  );

  it('excludes only exact root paths when the tsconfig is nested', async () => {
    const { example, tempRoot } = await createIsolatedTsExample();
    const tsconfigDir = path.join(example, 'nested');
    const excluded = path.join(example, 'src/client/register.gen.d.ts');
    const neighbors = [
      path.join(example, 'src/client/register-extra.gen.d.ts'),
      path.join(example, 'src/another-client/register.gen.d.ts'),
    ];
    try {
      for (const file of [excluded, ...neighbors]) {
        await fs.outputFile(file, 'export interface Client {}\n');
      }
      const { config } = await createResolvedTsgoConfig(
        example,
        path.join(tsconfigDir, 'tsconfig.json'),
        [path.join(example, 'api'), path.join(example, 'shared')],
        getTsgoBinPath(example),
        [excluded],
      );
      const resolvedFiles = (config.files ?? []).map(file =>
        path.resolve(tsconfigDir, file),
      );
      expect(resolvedFiles).not.toContain(excluded);
      for (const file of neighbors) expect(resolvedFiles).toContain(file);
      expect(resolvedFiles).toContain(path.join(example, 'api/index.ts'));
      expect(resolvedFiles).toContain(path.join(example, 'shared/index.ts'));
      expect(resolvedFiles).toContain(
        path.join(example, 'modern-app-env.d.ts'),
      );
    } finally {
      await fs.remove(tempRoot);
    }
  });

  it('emits executable output for concurrent consumers with app build flags', async () => {
    const { example, tempRoot } = await createIsolatedTsExample(
      'server-compiler-tsgo-consumer-',
    );
    const consumerDir = path.join(example, 'consumer');
    const tsconfigPath = path.join(example, 'tsconfig.consumer.json');

    await fs.outputFile(
      path.join(consumerDir, 'dependency.ts'),
      'export const value = 41;\n',
    );
    await fs.outputFile(
      path.join(consumerDir, 'entry.ts'),
      "import { value } from './dependency.ts';\nexport default value + 1;\n",
    );
    await fs.outputJSON(tsconfigPath, {
      compilerOptions: {
        allowImportingTsExtensions: true,
        composite: true,
        declaration: true,
        declarationMap: true,
        emitDeclarationOnly: true,
        incremental: true,
        module: 'preserve',
        moduleResolution: 'Bundler',
        noEmit: true,
      },
      include: ['consumer'],
    });

    const build = (distName: string) =>
      compile(example, { alias: {} } as any, {
        sourceDirs: [consumerDir],
        distDir: path.join(example, distName),
        moduleType: 'commonjs',
        throwErrorInsteadOfExit: true,
        tsconfigPath,
      });

    try {
      await Promise.all([build('dist-a'), build('dist-b')]);

      for (const distName of ['dist-a', 'dist-b']) {
        const outputPath = path.join(example, distName, 'consumer/entry.js');
        expect(await fs.pathExists(outputPath)).toBe(true);
        expect(require(outputPath).default).toBe(42);
        await expect(fs.readFile(outputPath, 'utf8')).resolves.toContain(
          './dependency.js',
        );
      }
    } finally {
      await fs.remove(tempRoot);
    }
  });
});
