import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type CommandRecord = {
  argv: string[];
  cwd: string;
  env: {
    MODERNJS_DEPLOY?: string;
  };
};

type PackageJson = {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  exports?: unknown;
};

const materializeScriptPath = path.resolve(
  __dirname,
  '../templates/workspace-scripts/materialize-zerops-runtime.mjs',
);

function writeText(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function writeJson(filePath: string, value: unknown) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeExecutable(filePath: string, source: string) {
  writeText(filePath, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(filePath, 0o755);
  writeText(
    `${filePath}.cmd`,
    `@echo off\r\n"${process.execPath}" "${filePath}" %*\r\n`,
  );
}

test('Zerops runtime materializer executes deploy, assembles runtime output, and vendors workspace deps', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-zerops-materialize-'),
  );

  try {
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const fakeBinDir = path.join(tempRoot, 'bin');
    const recordDir = path.join(tempRoot, 'records');
    const appOutputDir = path.join(workspaceRoot, 'verticals/catalog/.output');
    const modernVersion = '3.2.0-ultramodern.108';

    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(recordDir, { recursive: true });

    writeJson(path.join(workspaceRoot, 'package.json'), {
      name: 'zerops-fixture',
      private: true,
      packageManager: 'pnpm@9.15.0',
    });
    const workspaceRealPath = fs.realpathSync(workspaceRoot);
    writeText(path.join(workspaceRoot, 'README.md'), 'original source\n');
    writeText(path.join(workspaceRoot, 'pnpm-lock.yaml'), 'packages: {}\n');
    const rootManifest = readJson<Record<string, unknown>>(
      path.join(workspaceRoot, 'package.json'),
    );
    writeJson(path.join(workspaceRoot, 'package.json'), {
      ...rootManifest,
      devDependencies: {
        '@modern-js/ultramodern-create': `npm:@bleedingdev/modern-js-ultramodern-create@${modernVersion}`,
      },
    });

    writeJson(path.join(workspaceRoot, 'verticals/catalog/package.json'), {
      name: '@acme/catalog',
      private: true,
      scripts: {
        deploy: 'modern deploy',
      },
    });
    writeText(
      path.join(appOutputDir, 'index.js'),
      "console.log('catalog runtime');\n",
    );
    writeText(path.join(appOutputDir, 'public/asset.txt'), 'static asset\n');
    writeJson(path.join(appOutputDir, 'package.json'), {
      dependencies: {
        '@acme/shared': 'workspace:*',
        '@bleedingdev/modern-js-runtime': modernVersion,
        'left-pad': '1.0.0',
      },
      optionalDependencies: {
        '@acme/optional': 'workspace:*',
        '@bleedingdev/modern-js-plugin-bff': modernVersion,
      },
    });

    writeJson(path.join(workspaceRoot, 'packages/shared/package.json'), {
      name: '@acme/shared',
      type: 'module',
      version: '0.0.0',
      exports: {
        '.': './src/index.ts',
        './nested': {
          import: './src/nested.ts',
        },
      },
    });
    writeText(
      path.join(workspaceRoot, 'packages/shared/src/index.ts'),
      [
        "import type { SharedType } from './types';",
        'type LocalValue = string;',
        'interface HiddenShape { value: string }',
        "export const sharedValue: string = 'from-shared';",
        "export const tuple = ['shared'] as const;",
        '',
      ].join('\n'),
    );
    writeText(
      path.join(workspaceRoot, 'packages/shared/src/nested.ts'),
      "export const nestedValue: string = 'nested';\n",
    );
    writeText(
      path.join(workspaceRoot, 'packages/shared/node_modules/ignored.txt'),
      'should not copy\n',
    );
    writeJson(path.join(workspaceRoot, 'apps/optional/package.json'), {
      name: '@acme/optional',
      version: '0.0.0',
      exports: './src/optional.ts',
    });
    writeText(
      path.join(workspaceRoot, 'apps/optional/src/optional.ts'),
      "export const optionalValue: string = 'optional';\n",
    );

    writeExecutable(
      path.join(fakeBinDir, 'pnpm'),
      `
const fs = require('node:fs');
const path = require('node:path');
const recordDir = process.env.UM_ZEROPS_RECORD_DIR;
fs.writeFileSync(
	path.join(recordDir, 'pnpm.json'),
	JSON.stringify({
		argv: process.argv.slice(2),
		cwd: process.cwd(),
		env: {
			MODERNJS_DEPLOY: process.env.MODERNJS_DEPLOY,
		},
	}, null, 2),
);
fs.writeFileSync(path.join(process.cwd(), 'README.md'), 'mutated by deploy\\n');
fs.writeFileSync(path.join(process.cwd(), 'deploy-generated.txt'), 'remove me\\n');
`,
    );
    writeExecutable(
      path.join(fakeBinDir, 'npm'),
      `
const fs = require('node:fs');
const path = require('node:path');
const recordDir = process.env.UM_ZEROPS_RECORD_DIR;
const packageJson = JSON.parse(
	fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
);
fs.writeFileSync(
	path.join(recordDir, 'npm.json'),
	JSON.stringify({
		argv: process.argv.slice(2),
		cwd: process.cwd(),
		env: {
			MODERNJS_DEPLOY: process.env.MODERNJS_DEPLOY,
		},
	}, null, 2),
);
fs.writeFileSync(
	path.join(recordDir, 'npm-install-package.json'),
	JSON.stringify(packageJson, null, 2),
);
const nodeModules = path.join(process.cwd(), 'node_modules');
fs.mkdirSync(path.join(nodeModules, 'left-pad'), { recursive: true });
fs.writeFileSync(
	path.join(nodeModules, 'left-pad/package.json'),
	JSON.stringify({ name: 'left-pad', version: '1.0.0' }, null, 2),
);
fs.mkdirSync(path.join(nodeModules, '@modern-js/runtime'), { recursive: true });
fs.writeFileSync(
	path.join(nodeModules, '@modern-js/runtime/package.json'),
	JSON.stringify({ name: '@modern-js/runtime', version: '${modernVersion}' }, null, 2),
);
`,
    );

    const output = execFileSync(
      process.execPath,
      [
        materializeScriptPath,
        '--app',
        'catalog',
        '--package',
        '@acme/catalog',
        '--package-dir',
        'verticals/catalog',
      ],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
          ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot,
          UM_ZEROPS_RECORD_DIR: recordDir,
        },
        stdio: 'pipe',
        timeout: 20_000,
      },
    ).toString();

    assert.ok(
      output.includes(
        `materialized catalog runtime at ${path.join('.zerops', 'runtime', 'catalog')}`,
      ),
      output,
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceRoot, 'README.md'), 'utf-8'),
      'original source\n',
    );
    assert.equal(
      fs.existsSync(path.join(workspaceRoot, 'deploy-generated.txt')),
      false,
    );

    const pnpmRecord = readJson<CommandRecord>(
      path.join(recordDir, 'pnpm.json'),
    );
    assert.deepEqual(pnpmRecord.argv, [
      '--filter',
      '@acme/catalog',
      'run',
      'deploy',
      '--skip-build',
    ]);
    assert.equal(pnpmRecord.cwd, workspaceRealPath);
    assert.equal(pnpmRecord.env.MODERNJS_DEPLOY, 'node');

    const runtimeRoot = path.join(workspaceRoot, '.zerops/runtime/catalog');
    assert.equal(
      execFileSync('npm', ['run', 'serve', '--silent'], {
        cwd: runtimeRoot,
        encoding: 'utf-8',
      }).trim(),
      'catalog runtime',
    );
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, 'public/asset.txt'), 'utf-8'),
      'static asset\n',
    );

    const runtimePackage = readJson<PackageJson>(
      path.join(runtimeRoot, 'package.json'),
    );
    assert.equal(runtimePackage.private, true);
    assert.equal(runtimePackage.name, 'catalog-zerops-runtime');
    const copiedSharedPackage = readJson<PackageJson>(
      path.join(runtimeRoot, 'node_modules/@acme/shared/package.json'),
    );
    assert.deepEqual(copiedSharedPackage.exports, {
      '.': './src/index.js',
      './nested': {
        import: './src/nested.js',
      },
    });
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot, 'node_modules/@acme/shared/node_modules'),
      ),
      false,
    );
    const sharedModule = await import(
      pathToFileURL(
        path.join(runtimeRoot, 'node_modules/@acme/shared/src/index.js'),
      ).href
    );
    assert.equal(sharedModule.sharedValue, 'from-shared');
    assert.deepEqual(sharedModule.tuple, ['shared']);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test('Zerops finalization preserves a prepared worker and uses the installed cohort and locked dependencies', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-zerops-finalize-'),
  );
  try {
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const runtimeRoot = path.join(
      workspaceRoot,
      '.zerops/runtime/catalog-worker',
    );
    const fakeBinDir = path.join(tempRoot, 'bin');
    const recordPath = path.join(tempRoot, 'install-package.json');
    const version = '3.9.3-ultramodern.9';
    writeJson(path.join(workspaceRoot, 'package.json'), {
      name: 'zerops-finalize-fixture',
      devDependencies: {
        '@modern-js/ultramodern-create': `npm:@bleedingdev/modern-js-ultramodern-create@${version}`,
      },
    });
    writeJson(path.join(workspaceRoot, 'verticals/catalog/package.json'), {
      name: '@acme/catalog',
    });
    writeText(
      path.join(workspaceRoot, 'pnpm-lock.yaml'),
      [
        'packageManager: pnpm@12.11.2',
        '---',
        'lockfileVersion: 9.0',
        'packages:',
        '  pinned-transitive@2.3.4: {}',
        '  left-pad@1.0.0: {}',
        '  ambiguous@1.0.0: {}',
        '  ambiguous@2.0.0: {}',
        '  "@acme/scoped@4.5.6": {}',
        '',
      ].join('\n'),
    );
    const aliases = {
      '@modern-js/plugin-bff': '@bleedingdev/modern-js-plugin-bff',
      '@modern-js/runtime': '@bleedingdev/modern-js-runtime',
    };
    writeJson(
      path.join(
        workspaceRoot,
        'node_modules/@modern-js/ultramodern-create/release-cohort.json',
      ),
      {
        schema: 'bleedingdev.ultramodern.release-cohort',
        schemaVersion: 2,
        source: {
          commit: 'abc123',
          repository: 'ultramodernjs/ultramodern.js',
        },
        release: { tag: `v${version}`, version },
        aliases,
        packages: Object.entries(aliases).map(([sourceName, targetName]) => ({
          sourceName,
          targetName,
          version,
        })),
        sidecars: [],
      },
    );
    writeJson(path.join(runtimeRoot, 'package.json'), {
      name: 'prepared-worker',
      scripts: { serve: 'node worker.mjs' },
      dependencies: {
        '@modern-js/runtime': 'catalog:ultramodern',
        '@acme/shared': 'workspace:*',
        'left-pad': '1.0.0',
        'excluded-os': '1.0.0',
        'excluded-cpu': '1.0.0',
      },
      optionalDependencies: {
        '@bleedingdev/modern-js-plugin-bff': 'catalog:ultramodern',
        'allowed-platform': '1.0.0',
      },
    });
    writeText(
      path.join(runtimeRoot, 'worker.mjs'),
      "console.log('prepared worker');\n",
    );
    writeText(
      path.join(runtimeRoot, 'worker-artifact.json'),
      '{"owned":"outbox"}\n',
    );
    writeText(
      path.join(workspaceRoot, 'node_modules/.modules.yaml'),
      'virtualStoreDir: .pnpm\n',
    );
    for (const [name, constraints] of Object.entries({
      'excluded-os': { os: [`!${process.platform}`] },
      'excluded-cpu': { cpu: [`!${process.arch}`] },
      'allowed-platform': { os: ['any'], cpu: [process.arch] },
    })) {
      writeJson(
        path.join(
          workspaceRoot,
          'node_modules/.pnpm',
          `${name}@1.0.0/node_modules`,
          name,
          'package.json',
        ),
        {
          name,
          version: '1.0.0',
          ...constraints,
        },
      );
    }
    writeJson(path.join(workspaceRoot, 'packages/shared/package.json'), {
      name: '@acme/shared',
      type: 'module',
      exports: './index.ts',
    });
    writeText(
      path.join(workspaceRoot, 'packages/shared/index.ts'),
      [
        "import { makeValue } from './value.ts';",
        "import './side-effect.ts';",
        "export { makeValue as exportedValue } from './value.ts';",
        "export * from './extra.ts';",
        'export const value: { nested: string } = makeValue();',
        "export const loadValue = () => import('./value.ts');",
        "export const literal = './untouched.ts';",
        `export const help = "import './example.ts'";`,
        `export const exportHelp = "export * from './example.ts'";`,
        `export const dynamicHelp = "import('./example.ts')";`,
      ].join('\n'),
    );
    writeText(
      path.join(workspaceRoot, 'packages/shared/value.ts'),
      "export function makeValue(): { nested: string } { return { nested: 'worker' }; }\n",
    );
    writeText(
      path.join(workspaceRoot, 'packages/shared/extra.ts'),
      "export const extraValue: string = 're-exported';\n",
    );
    writeText(
      path.join(workspaceRoot, 'packages/shared/side-effect.ts'),
      'export {};\n',
    );
    writeExecutable(
      path.join(fakeBinDir, 'pnpm'),
      "throw new Error('finalize-only must not deploy');",
    );
    writeExecutable(
      path.join(fakeBinDir, 'npm'),
      `
const fs = require('node:fs');
const path = require('node:path');
fs.copyFileSync(path.join(process.cwd(), 'package.json'), process.env.UM_ZEROPS_INSTALL_RECORD);
fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
`,
    );
    execFileSync(
      process.execPath,
      [
        materializeScriptPath,
        '--app',
        'catalog-worker',
        '--package',
        '@acme/catalog',
        '--package-dir',
        'verticals/catalog',
        '--finalize-only',
        '--runtime-dir',
        '.zerops/runtime/catalog-worker',
      ],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
          ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot,
          UM_ZEROPS_INSTALL_RECORD: recordPath,
        },
        stdio: 'pipe',
        timeout: 20_000,
      },
    );
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, 'worker-artifact.json'), 'utf8'),
      '{"owned":"outbox"}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, 'worker.mjs'), 'utf8'),
      "console.log('prepared worker');\n",
    );
    const manifest = readJson<PackageJson>(
      path.join(runtimeRoot, 'package.json'),
    );
    assert.equal(manifest.scripts?.serve, 'node worker.mjs');
    assert.equal(
      manifest.dependencies?.['@modern-js/runtime'],
      `npm:@bleedingdev/modern-js-runtime@${version}`,
    );
    assert.equal(
      manifest.optionalDependencies?.['@modern-js/plugin-bff'],
      `npm:@bleedingdev/modern-js-plugin-bff@${version}`,
    );
    assert.equal(
      manifest.optionalDependencies?.['@bleedingdev/modern-js-plugin-bff'],
      version,
    );
    assert.equal(manifest.dependencies?.['excluded-os'], undefined);
    assert.equal(manifest.dependencies?.['excluded-cpu'], undefined);
    assert.equal(manifest.optionalDependencies?.['allowed-platform'], '1.0.0');
    const installed = readJson<PackageJson>(recordPath);
    assert.equal(installed.dependencies?.['@acme/shared'], undefined);
    assert.deepEqual(installed.overrides, {
      'pinned-transitive': '2.3.4',
      '@acme/scoped': '4.5.6',
    });
    const shared = await import(
      pathToFileURL(
        path.join(runtimeRoot, 'node_modules/@acme/shared/index.js'),
      ).href
    );
    assert.deepEqual(shared.value, { nested: 'worker' });
    assert.deepEqual(shared.exportedValue(), { nested: 'worker' });
    assert.equal(shared.extraValue, 're-exported');
    assert.deepEqual((await shared.loadValue()).makeValue(), {
      nested: 'worker',
    });
    assert.equal(shared.literal, './untouched.ts');
    assert.equal(shared.help, "import './example.ts'");
    assert.equal(shared.exportHelp, "export * from './example.ts'");
    assert.equal(shared.dynamicHelp, "import('./example.ts')");
    for (const dependencies of [
      { 'unresolved-package': 'catalog:ultramodern' },
      { '@modern-js/runtime': 'catalog:unresolved' },
    ]) {
      writeJson(path.join(runtimeRoot, 'package.json'), {
        scripts: { serve: 'node worker.mjs' },
        dependencies,
      });
      writeText(recordPath, 'do not install unresolved catalogs\n');
      const result = spawnSync(
        process.execPath,
        [
          materializeScriptPath,
          '--app',
          'catalog-worker',
          '--package',
          '@acme/catalog',
          '--package-dir',
          'verticals/catalog',
          '--finalize-only',
          '--runtime-dir',
          '.zerops/runtime/catalog-worker',
        ],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
            ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot,
            UM_ZEROPS_INSTALL_RECORD: recordPath,
          },
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /no installed release identity/u);
      assert.equal(
        fs.readFileSync(recordPath, 'utf8'),
        'do not install unresolved catalogs\n',
      );
    }
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test('Zerops finalization rejects unknown flags and unsafe runtime paths before touching staged files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-zerops-paths-'));
  try {
    const workspaceRoot = path.join(tempRoot, 'workspace');
    writeJson(path.join(workspaceRoot, 'verticals/catalog/package.json'), {
      name: '@acme/catalog',
    });
    const marker = path.join(workspaceRoot, 'protected/marker.txt');
    writeText(marker, 'preserve\n');
    fs.mkdirSync(path.join(workspaceRoot, '.zerops/runtime'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(workspaceRoot, 'protected'),
      path.join(workspaceRoot, '.zerops/runtime/link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const baseArgs = [
      materializeScriptPath,
      '--app',
      'catalog',
      '--package',
      '@acme/catalog',
      '--package-dir',
      'verticals/catalog',
    ];
    const rejected: [string[], RegExp][] = [
      [['--worker'], /Unknown option/u],
      [['--finalize-only'], /must be used together/u],
      [['--runtime-dir', '.zerops/runtime/catalog'], /must be used together/u],
      [
        ['--finalize-only', '--runtime-dir', '../outside'],
        /workspace-relative path/u,
      ],
      [
        ['--finalize-only', '--runtime-dir', path.join(tempRoot, 'outside')],
        /workspace-relative path/u,
      ],
      [
        ['--finalize-only', '--runtime-dir', 'protected'],
        /inside .zerops\/runtime/u,
      ],
      [
        ['--finalize-only', '--runtime-dir', '.zerops/runtime/link'],
        /must not contain symlinks/u,
      ],
    ];
    for (const [flags, expectedError] of rejected) {
      const result = spawnSync(process.execPath, [...baseArgs, ...flags], {
        cwd: workspaceRoot,
        env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(
        result.status,
        1,
        JSON.stringify({ flags, stderr: result.stderr }),
      );
      assert.match(result.stderr, expectedError);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve\n');
    }
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
