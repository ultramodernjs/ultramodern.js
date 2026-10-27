import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  createPresetUltramodernConfig,
  presetUltramodern,
} from '@modern-js/ultramodern-app-tools';
import { rspack } from '@rsbuild/core';

describe('presetUltramodern config', () => {
  it('builds CSS and module CSS through the cold public CLI with native JSX checking', async () => {
    const deadline = Date.now() + 110_000;
    const childTimeout = (limit: number) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          'Bare React CLI regression exceeded its child-process budget',
        );
      return Math.min(limit, remaining);
    };
    const appDirectory = fs.realpathSync(
      fs.mkdtempSync(
        path.join(
          process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
          'um-bare-react-cli-',
        ),
      ),
    );
    const sdkDirectory = path.resolve(__dirname, '../..');
    const generatorDirectory = path.resolve(
      __dirname,
      '../../../../toolkit/ultramodern-create',
    );
    const repositoryDirectory = path.resolve(__dirname, '../../../../..');
    const packages: readonly (readonly [string, string])[] = [
      ['@modern-js/ultramodern-app-tools', sdkDirectory],
      ...['@modern-js/app-tools-extensions', '@modern-js/plugin'].map(
        name => [name, path.join(sdkDirectory, 'node_modules', name)] as const,
      ),
      ...[
        '@modern-js/runtime',
        '@modern-js/runtime-renderer-extensions',
        '@modern-js/i18n-integration',
        'typescript',
        'tsrs',
        '@effect/tsgo',
        'react',
        'react-dom',
      ].map(
        name =>
          [name, path.join(generatorDirectory, 'node_modules', name)] as const,
      ),
      ['@types/node', path.join(sdkDirectory, 'node_modules/@types/node')],
      ...['@types/react', '@types/react-dom'].map(
        name =>
          [name, path.join(repositoryDirectory, 'node_modules', name)] as const,
      ),
    ];
    const configFile = path.join(appDirectory, 'modern.config.ts');
    const tsconfigFile = path.join(appDirectory, 'tsconfig.json');
    const sourceFile = path.join(appDirectory, 'src/App.jsx');
    const privateCheckerFiles = () => {
      const files: string[] = [];
      const directories = [appDirectory];
      for (const directory of directories) {
        for (const entry of fs.readdirSync(directory, {
          withFileTypes: true,
        })) {
          const filename = path.join(directory, entry.name);
          if (entry.name.startsWith('.ultramodern-native-checker.'))
            files.push(path.relative(appDirectory, filename));
          // Include ordinary generated directories, including node_modules,
          // without following the linked package owners outside this fixture.
          if (entry.isDirectory()) directories.push(filename);
        }
      }
      return files.sort();
    };
    const config = `import { defineConfig } from '@modern-js/ultramodern-app-tools';
export default defineConfig({ renderer: 'react', server: { ssr: true } });
`;
    const tsconfig = JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'preserve',
        allowJs: true,
        checkJs: true,
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        noUncheckedSideEffectImports: true,
        types: [],
      },
      include: ['src'],
    });
    const assetImports = `import './App.css';
import styles from './App.module.css';
`;
    const validSource = `${assetImports}
export default function App() { return <main id="bare-react-cli" className={styles.root}><button type="button">Native JSX</button></main>; }
`;
    try {
      const dependencies: Record<string, string> = {};
      const owners = new Map<string, string>();
      for (const [name, directory] of packages) {
        const owner = fs.realpathSync(directory);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(owner, 'package.json'), 'utf8'),
        );
        dependencies[name] =
          name === manifest.name
            ? manifest.version
            : `npm:${manifest.name}@${manifest.version}`;
        owners.set(name, owner);
        const link = path.join(appDirectory, 'node_modules', name);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(owner, link, 'dir');
      }
      expect(Object.keys(dependencies)).toHaveLength(14);
      for (const [name, present] of [
        ['tsrs', true],
        ['@effect/tsgo', true],
        ['@typescript/native', false],
      ] as const) {
        expect(Object.hasOwn(dependencies, name)).toBe(present);
        expect(owners.has(name)).toBe(present);
        expect(
          fs.existsSync(path.join(appDirectory, 'node_modules', name)),
        ).toBe(present);
      }
      fs.writeFileSync(
        path.join(appDirectory, 'package.json'),
        JSON.stringify({
          name: 'bare-react-cli-consumer',
          private: true,
          dependencies,
        }),
      );
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(configFile, config);
      fs.writeFileSync(tsconfigFile, tsconfig);
      fs.writeFileSync(
        path.join(appDirectory, 'src/env.d.ts'),
        '/// <reference types="@modern-js/ultramodern-app-tools/types" />\n',
      );
      fs.writeFileSync(
        path.join(appDirectory, 'src/App.css'),
        'main { color: red; }\n',
      );
      fs.writeFileSync(
        path.join(appDirectory, 'src/App.module.css'),
        '.root { display: block; }\n',
      );
      fs.writeFileSync(sourceFile, validSource);
      const fixtureRequire = createRequire(configFile);
      const typescriptDirectory = owners.get('typescript')!;
      const typescriptManifest = JSON.parse(
        fs.readFileSync(path.join(typescriptDirectory, 'package.json'), 'utf8'),
      );
      expect(typescriptManifest.name).toBe('typescript');
      expect(typescriptManifest.version).toBe('7.0.2');
      expect(dependencies.typescript).toBe('7.0.2');
      expect(fixtureRequire('react/package.json').version).toMatch(/^19\./);
      const environment = {
        ...process.env,
        NODE_ENV: 'production',
        NODE_PATH: '',
      };
      for (const name of [
        'EFFECT_TSGO_BIN',
        'MODERN_ARGV',
        'MODERN_ENV',
        'MODERN_LIB_FORMAT',
      ])
        delete environment[name];
      const native = spawnSync(
        process.execPath,
        [
          path.join(typescriptDirectory, typescriptManifest.bin.tsc),
          '--project',
          tsconfigFile,
          '--noEmit',
          '--pretty',
          'false',
        ],
        {
          cwd: appDirectory,
          env: environment,
          encoding: 'utf8',
          timeout: childTimeout(30_000),
        },
      );
      expect(native.error).toBeUndefined();
      expect(native.signal).toBeNull();
      expect(native.status).not.toBe(0);
      expect(native.stdout + native.stderr).toContain('TS7026');
      expect(native.stdout + native.stderr).not.toContain('TS2882');
      expect(native.stdout + native.stderr).not.toContain('TS2307');
      expect(native.stdout + native.stderr).not.toContain('TS2688');
      const sdkManifest = JSON.parse(
        fs.readFileSync(path.join(sdkDirectory, 'package.json'), 'utf8'),
      );
      const command = [
        path.join(sdkDirectory, sdkManifest.bin.ultramodern),
        'build',
      ];
      const built = spawnSync(process.execPath, command, {
        cwd: appDirectory,
        env: environment,
        encoding: 'utf8',
        timeout: childTimeout(60_000),
        maxBuffer: 16 * 1024 * 1024,
      });
      if (built.error || built.signal || built.status !== 0)
        throw new Error(built.stdout + built.stderr, { cause: built.error });
      const sdk: typeof import('@modern-js/ultramodern-app-tools') =
        fixtureRequire('@modern-js/ultramodern-app-tools');
      const manifest = await sdk.readRendererBuildManifest(
        path.join(appDirectory, 'dist'),
        sdk.resolveRendererProfile('react'),
      );
      expect(manifest.schema).toBe('ultramodern-renderer-build');
      expect(manifest.buildId).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(manifest.entries)).toHaveLength(1);
      for (const identity of Object.values(manifest.entries)) {
        expect(identity.renderer).toBe('react');
        expect(identity.buildId).toBe(manifest.buildId);
      }
      expect(fs.readFileSync(configFile, 'utf8')).toBe(config);
      expect(fs.readFileSync(tsconfigFile, 'utf8')).toBe(tsconfig);
      expect(privateCheckerFiles()).toEqual([]);
      fs.writeFileSync(
        sourceFile,
        `${assetImports}export default function App() { return <main definitelyNotAReactAttribute={true} />; }`,
      );
      const invalid = spawnSync(process.execPath, command, {
        cwd: appDirectory,
        env: environment,
        encoding: 'utf8',
        timeout: childTimeout(60_000),
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(invalid.error).toBeUndefined();
      expect(invalid.signal).toBeNull();
      expect(invalid.status).not.toBe(0);
      expect(invalid.stdout + invalid.stderr).toContain('TS2322');
      expect(
        fs.existsSync(
          path.join(appDirectory, 'dist', sdk.RENDERER_BUILD_MANIFEST_FILE),
        ),
      ).toBe(false);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(config);
      expect(fs.readFileSync(tsconfigFile, 'utf8')).toBe(tsconfig);
      expect(privateCheckerFiles()).toEqual([]);
      fs.writeFileSync(
        sourceFile,
        `import './missing-runtime.js';\n${validSource}`,
      );
      const missingJavaScript = spawnSync(process.execPath, command, {
        cwd: appDirectory,
        env: environment,
        encoding: 'utf8',
        timeout: childTimeout(60_000),
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(missingJavaScript.error).toBeUndefined();
      expect(missingJavaScript.signal).toBeNull();
      expect(missingJavaScript.status).not.toBe(0);
      expect(missingJavaScript.stdout + missingJavaScript.stderr).toContain(
        'TS2882',
      );
      expect(missingJavaScript.stdout + missingJavaScript.stderr).toContain(
        'missing-runtime.js',
      );
      expect(
        fs.existsSync(
          path.join(appDirectory, 'dist', sdk.RENDERER_BUILD_MANIFEST_FILE),
        ),
      ).toBe(false);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(config);
      expect(fs.readFileSync(tsconfigFile, 'utf8')).toBe(tsconfig);
      expect(privateCheckerFiles()).toEqual([]);
      fs.writeFileSync(sourceFile, validSource);
      const unsupportedConfig = `import { defineConfig } from '@modern-js/ultramodern-app-tools';
export default defineConfig({
  renderer: 'react',
  server: { ssr: true },
  tools: { tsChecker: { typescript: { tsgo: false } } },
});
`;
      fs.writeFileSync(configFile, unsupportedConfig);
      const unsupported = spawnSync(process.execPath, command, {
        cwd: appDirectory,
        env: environment,
        encoding: 'utf8',
        timeout: childTimeout(60_000),
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(unsupported.error).toBeUndefined();
      expect(unsupported.signal).toBeNull();
      expect(unsupported.status).not.toBe(0);
      expect(unsupported.stdout + unsupported.stderr).toContain(
        'unsupported-type-checker: UltraModern requires an Effect-enabled native compiler; typescript.tsgo cannot be false',
      );
      expect(
        fs.existsSync(
          path.join(appDirectory, 'dist', sdk.RENDERER_BUILD_MANIFEST_FILE),
        ),
      ).toBe(false);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(unsupportedConfig);
      expect(fs.readFileSync(tsconfigFile, 'utf8')).toBe(tsconfig);
      expect(privateCheckerFiles()).toEqual([]);
    } finally {
      fs.rmSync(appDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  it('selects renderer JSX types through the normal checker option chain', () => {
    for (const [renderer, jsxImportSource] of [
      ['react', 'react'],
      ['solid', '@solidjs/web'],
      ['octane', 'octane'],
    ] as const) {
      const selected = presetUltramodern({ renderer });
      expect(selected.tools?.tsChecker).toEqual({
        typescript: {
          configOverwrite: { compilerOptions: { jsxImportSource } },
        },
      });
    }
    const selected = presetUltramodern({
      renderer: 'react',
      tools: {
        tsChecker: {
          typescript: {
            configOverwrite: {
              compilerOptions: {
                jsxImportSource: 'custom-jsx',
                types: ['custom-types'],
              },
            },
          },
        },
      },
    });
    expect(selected.tools?.tsChecker).toEqual({
      typescript: {
        configOverwrite: {
          compilerOptions: {
            jsxImportSource: 'custom-jsx',
            types: ['custom-types'],
          },
        },
      },
    });
  });
  it('keeps React Router optional and uses the consumer copy before a nested DOM dependency', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'modern-optional-router-')),
    );
    const configure = createPresetUltramodernConfig().tools!
      .bundlerChain as Function;
    const aliases = new Map<string, string>();
    const chain = {
      get: () => root,
      resolve: { alias: aliases },
      plugins: new Set(),
    };
    const run = () =>
      configure(chain, {
        isProd: true,
        CHAIN_ID: { PLUGIN: { TS_CHECKER: 'checker' } },
      });
    const install = (directory: string, name: string) => {
      const target = path.join(directory, 'node_modules', name);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, 'package.json'),
        JSON.stringify({ name }),
      );
      return target;
    };
    try {
      run();
      expect(aliases.size).toBe(0);
      const dom = install(root, 'react-router-dom');
      const nested = install(dom, 'react-router');
      run();
      expect(aliases.get('react-router$')).toBe(
        path.join(nested, 'dist/production/index.mjs'),
      );
      const direct = install(root, 'react-router');
      run();
      expect(aliases.get('react-router$')).toBe(
        path.join(direct, 'dist/production/index.mjs'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('evaluates telemetry endpoint environment variables for every call', () => {
    const previousOtlp = process.env.MODERN_TELEMETRY_OTLP_ENDPOINT;
    const previousVictoria = process.env.MODERN_TELEMETRY_VICTORIA_ENDPOINT;
    delete process.env.MODERN_TELEMETRY_OTLP_ENDPOINT;
    delete process.env.MODERN_TELEMETRY_VICTORIA_ENDPOINT;

    try {
      const beforeEndpoint = createPresetUltramodernConfig();
      process.env.MODERN_TELEMETRY_OTLP_ENDPOINT =
        'http://env-collector.internal:4318/v1/logs';
      const afterEndpoint = createPresetUltramodernConfig();

      expect(beforeEndpoint.server?.telemetry?.exporters).toBeUndefined();
      expect(afterEndpoint.server?.telemetry?.exporters).toEqual({
        otlp: {
          enabled: true,
          endpoint: 'http://env-collector.internal:4318/v1/logs',
        },
      });
    } finally {
      if (typeof previousOtlp === 'undefined') {
        delete process.env.MODERN_TELEMETRY_OTLP_ENDPOINT;
      } else {
        process.env.MODERN_TELEMETRY_OTLP_ENDPOINT = previousOtlp;
      }
      if (typeof previousVictoria === 'undefined') {
        delete process.env.MODERN_TELEMETRY_VICTORIA_ENDPOINT;
      } else {
        process.env.MODERN_TELEMETRY_VICTORIA_ENDPOINT = previousVictoria;
      }
    }
  });

  it('stamps minimized browser bytes before content hashes are finalized', async () => {
    const previous = process.env.ULTRAMODERN_SOURCE_REVISION;
    const previousCwd = process.cwd();
    const workspaceRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'modern-preset-rspack-banner-')),
    );
    const sourceRevision = 'b'.repeat(40);
    const entry = path.join(workspaceRoot, 'entry.js');
    fs.writeFileSync(entry, 'globalThis.ultramodernClientLoaded = true;\n');
    process.env.ULTRAMODERN_SOURCE_REVISION = sourceRevision;

    try {
      process.chdir(workspaceRoot);
      const outputs: Array<{ filename: string }> = [];
      for (const [index, generationBuildMarker] of [
        '1111111111111111',
        '2222222222222222',
      ].entries()) {
        const outputPath = path.join(workspaceRoot, `dist-${index}`);
        const preset = createPresetUltramodernConfig({
          deliveryUnit: {
            buildMarker: generationBuildMarker,
            unitId: 'acme/catalog',
            version: '1.2.3',
          },
        });
        const rspackConfig = { plugins: [] as unknown[] };
        const banner = preset.builderPlugins?.find(
          candidate =>
            (candidate as { name?: string }).name ===
            'ultramodern:release-identity-banner',
        ) as { setup(api: unknown): void } | undefined;
        expect(banner).toBeDefined();
        banner!.setup({
          modifyRspackConfig: (
            handler: (config: typeof rspackConfig) => void,
          ) => handler(rspackConfig),
        });

        await new Promise<void>((resolve, reject) => {
          rspack.rspack(
            {
              entry,
              mode: 'production',
              optimization: {
                minimize: true,
              },
              output: {
                clean: true,
                filename: '[contenthash].js',
                path: outputPath,
              },
              plugins: rspackConfig.plugins,
            },
            (error, stats) => {
              if (error) {
                reject(error);
              } else if (!stats || stats.hasErrors()) {
                reject(
                  new Error(
                    stats?.toString({ all: false, errors: true }) ??
                      'Rspack returned no build stats.',
                  ),
                );
              } else {
                resolve();
              }
            },
          );
        });

        const filename = fs
          .readdirSync(outputPath)
          .find(candidate => candidate.endsWith('.js'));
        expect(filename).toBeDefined();
        delete (globalThis as Record<string, unknown>).ultramodernClientLoaded;
        require(path.join(outputPath, filename!));
        expect(
          (globalThis as Record<string, unknown>).ultramodernClientLoaded,
        ).toBe(true);
        outputs.push({ filename: filename! });
      }

      expect(outputs[0].filename).not.toBe(outputs[1].filename);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      if (previous === undefined) {
        delete process.env.ULTRAMODERN_SOURCE_REVISION;
      } else {
        process.env.ULTRAMODERN_SOURCE_REVISION = previous;
      }
    }
  });
});
