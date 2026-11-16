import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  generatedModernBin,
  installPackedGenerator,
  materializeGeneratedWorkspaceDependencies,
} from '../../../utils/generatedWorkspaceDependencies';
import { generatorTestTempParent } from '../../../utils/generatorTestTemp.mjs';
import { modernBuild } from '../../../utils/modernTestUtils';
import { setSuiteTimeout } from '../../../utils/setSuiteTimeout';

setSuiteTimeout(600_000);

const repoRoot = path.resolve(__dirname, '../../../../');
let createBin: string;
const testFrameworkVersion = '3.2.0-ultramodern.108';
const frameworkVersionEnv = 'ULTRAMODERN_CREATE_FRAMEWORK_VERSION';
const bleedingDevAliases: Record<string, string> = {
  '@modern-js/app-tools': '@bleedingdev/modern-js-app-tools',
  '@modern-js/plugin-bff': '@bleedingdev/modern-js-plugin-bff',
  '@modern-js/plugin-i18n': '@bleedingdev/modern-js-plugin-i18n',
  '@modern-js/plugin-tanstack': '@bleedingdev/modern-js-plugin-tanstack',
  '@modern-js/runtime': '@bleedingdev/modern-js-runtime',
};

type ExecSyncError = Error & {
  stderr?: Buffer | string;
};

function expectedBleedingDevSpecifier(
  packageName: string,
  version = testFrameworkVersion,
) {
  const alias = bleedingDevAliases[packageName];
  if (!alias) {
    throw new Error('No BleedingDev alias configured for ' + packageName);
  }
  return 'npm:' + alias + '@' + version;
}

function differentUltramodernVersion(version: string) {
  const match = /^(\d+\.\d+\.\d+-ultramodern\.)(\d+)$/u.exec(version);
  if (!match) {
    throw new Error('Expected UltraModern test version, got ' + version);
  }
  return match[1] + (Number(match[2]) + 1);
}

function runCreate(projectDir: string, args: string[], bin = createBin) {
  const packageSourceArgs =
    bin === createBin ? ['--ultramodern-package-source', 'workspace'] : [];
  execFileSync(
    process.execPath,
    [bin, projectDir, ...packageSourceArgs, ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_PATH: '',
        [frameworkVersionEnv]: testFrameworkVersion,
        FORCE_COLOR: '0',
      },
      stdio: 'pipe',
    },
  );
}

function readText(root: string, relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function writeText(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function runWorkspaceValidator(workspaceDir: string) {
  return execFileSync(
    process.execPath,
    [
      path.join(
        workspaceDir,
        'node_modules/@modern-js/ultramodern-create/bin/run.js',
      ),
      'ultramodern',
      'validate',
    ],
    {
      cwd: workspaceDir,
      env: { ...process.env, NODE_PATH: '' },
      stdio: 'pipe',
    },
  ).toString();
}

function expectWorkspaceValidatorPass(workspaceDir: string) {
  expect(runWorkspaceValidator(workspaceDir).trim()).toBe(
    'UltraModern workspace validated',
  );
}

describe('create-ultramodern-workspace', () => {
  let tempRoot = '';

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(
      path.join(
        generatorTestTempParent(repoRoot),
        'modern-create-ultramodern-workspace-',
      ),
    );
    console.log(`create-ultramodern-workspace scratch directory: ${tempRoot}`);
    createBin = installPackedGenerator(tempRoot);
  });

  afterAll(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('generates a shell workspace that builds and rejects mixed package cohorts', async () => {
    const workspaceDir = path.join(tempRoot, 'ultra-workspace');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    runCreate(workspaceDir, ['--no-tailwind', '--lang', 'en']);
    await materializeGeneratedWorkspaceDependencies(workspaceDir);
    expectWorkspaceValidatorPass(workspaceDir);
    const shellDir = path.join(workspaceDir, 'apps/shell-super-app');
    const isolatedEnv = { ...process.env, NODE_PATH: '' };
    const installedRouter = execFileSync(
      process.execPath,
      ['-e', 'console.log(require.resolve("@modern-js/plugin-tanstack"))'],
      { cwd: shellDir, encoding: 'utf8', env: isolatedEnv },
    ).trim();
    expect(
      fs
        .realpathSync(installedRouter)
        .startsWith(`${fs.realpathSync(workspaceDir)}${path.sep}`),
    ).toBe(true);
    // The old all-to-all links made undeclared framework packages available.
    expect(() =>
      execFileSync(
        process.execPath,
        ['-e', 'require.resolve("@modern-js/plugin-data-loader/runtime")'],
        { cwd: shellDir, env: isolatedEnv, stdio: 'pipe' },
      ),
    ).toThrow();
    const routeManifestPath =
      'apps/shell-super-app/src/routes/ultramodern-route-metadata.ts';
    const scaffoldedRouteManifest = readText(workspaceDir, routeManifestPath);
    execFileSync(
      process.execPath,
      [
        path.join(
          workspaceDir,
          'node_modules/@modern-js/ultramodern-create/bin/run.js',
        ),
        'ultramodern',
        'routes-generate',
      ],
      {
        cwd: workspaceDir,
        env: { ...process.env, NODE_PATH: '' },
        stdio: 'pipe',
        timeout: 90_000,
      },
    );
    expect(
      fs.globSync('src/modern-tanstack/*/router.gen.ts', { cwd: shellDir }),
    ).not.toEqual([]);
    expect(readText(workspaceDir, routeManifestPath)).toBe(
      scaffoldedRouteManifest,
    );
    const buildResult = await modernBuild(
      path.join(workspaceDir, 'apps/shell-super-app'),
      [],
      {
        modernBin: generatedModernBin(
          path.join(workspaceDir, 'apps/shell-super-app'),
        ),
        env: { NODE_PATH: '' },
        stdout: false,
        stderr: false,
      },
    );
    if (buildResult.code !== 0) {
      console.error(
        `Generated shell build failed in ${shellDir} with exit code ${buildResult.code}.\n` +
          `stdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`,
      );
    }
    expect(buildResult.code).toBe(0);

    const shellPackagePath = 'apps/shell-super-app/package.json';
    const originalShellPackage = readText(workspaceDir, shellPackagePath);
    const mutatedShellPackage = JSON.parse(originalShellPackage);
    mutatedShellPackage.dependencies['@modern-js/runtime'] =
      expectedBleedingDevSpecifier(
        '@modern-js/runtime',
        differentUltramodernVersion(testFrameworkVersion),
      );
    writeText(
      workspaceDir,
      shellPackagePath,
      `${JSON.stringify(mutatedShellPackage, null, 2)}\n`,
    );
    try {
      runWorkspaceValidator(workspaceDir);
      throw new Error(
        'Expected workspace validator to reject a mixed Modern package cohort',
      );
    } catch (error) {
      const execError = error as ExecSyncError & {
        stdout?: Buffer | string;
      };
      const stdout =
        typeof execError.stdout === 'string'
          ? execError.stdout
          : execError.stdout?.toString() || '';
      const stderr =
        typeof execError.stderr === 'string'
          ? execError.stderr
          : execError.stderr?.toString() || '';
      expect(`${stdout}\n${stderr}`).toMatch(
        /apps\/shell-super-app\/package\.json @modern-js\/runtime must use the ultramodern catalog/u,
      );
    } finally {
      writeText(workspaceDir, shellPackagePath, originalShellPackage);
    }
  });
});
