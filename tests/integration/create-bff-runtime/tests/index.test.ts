import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { installPackedGenerator } from '../../../utils/generatedWorkspaceDependencies';
import { generatorTestTempParent } from '../../../utils/generatorTestTemp.mjs';
import { setSuiteTimeout } from '../../../utils/setSuiteTimeout';

setSuiteTimeout(600_000);

const repoRoot = path.resolve(__dirname, '../../../../');
let createBin: string;
const testFrameworkVersion = '3.2.0-ultramodern.108';
const frameworkVersionEnv = 'ULTRAMODERN_CREATE_FRAMEWORK_VERSION';

type ExecSyncError = Error & {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
};

function runCreate(projectDir: string, args: string[]) {
  execFileSync(
    process.execPath,
    [
      createBin,
      projectDir,
      '--ultramodern-package-source',
      'workspace',
      ...args,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_PATH: '',
        FORCE_COLOR: '0',
        [frameworkVersionEnv]: testFrameworkVersion,
      },
      stdio: 'pipe',
    },
  );
}

function runCreateInWorkspace(workspaceDir: string, args: string[]) {
  execFileSync(process.execPath, [createBin, ...args], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      NODE_PATH: '',
      FORCE_COLOR: '0',
      [frameworkVersionEnv]: testFrameworkVersion,
    },
    stdio: 'pipe',
  });
}

function scaffoldWorkspaceWithVertical(
  workspaceDir: string,
  workspaceArgs: string[],
  verticalArgs: string[],
) {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  runCreate(workspaceDir, workspaceArgs);
  runCreateInWorkspace(workspaceDir, verticalArgs);
}

function captureCreateFailure(projectDir: string, args: string[]): string {
  try {
    runCreate(projectDir, args);
  } catch (error) {
    const execError = error as ExecSyncError;
    return typeof execError.stderr === 'string'
      ? execError.stderr
      : execError.stderr?.toString() || '';
  }
  throw new Error(
    `Expected create to fail for: ${args.join(' ')} (it succeeded)`,
  );
}

describe('create-bff-runtime', () => {
  let tempRoot = '';

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(
      path.join(
        generatorTestTempParent(repoRoot),
        'modern-create-bff-runtime-',
      ),
    );
    console.log(`create-bff-runtime scratch directory: ${tempRoot}`);
    createBin = installPackedGenerator(tempRoot);
  });

  afterAll(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('generates strict Effect BFF files through the packed CLI', () => {
    const workspaceDir = path.join(tempRoot, 'with-bff-effect');
    scaffoldWorkspaceWithVertical(
      workspaceDir,
      ['--bff-runtime', 'effect', '--lang', 'en'],
      ['greetings', '--vertical', '--bff-runtime', 'effect', '--lang', 'en'],
    );
    const topology = JSON.parse(
      fs.readFileSync(
        path.join(workspaceDir, 'topology/reference-topology.json'),
        'utf8',
      ),
    );
    expect(topology.verticals).toContainEqual(
      expect.objectContaining({
        id: 'greetings',
        api: expect.objectContaining({
          runtime: 'effect',
          bff: expect.objectContaining({ strictEffectApproach: true }),
        }),
      }),
    );
    expect(
      fs.existsSync(
        path.join(workspaceDir, 'verticals/greetings/api/index.ts'),
      ),
    ).toBe(true);
  });

  test('rejects unsupported BFF runtimes before writing', () => {
    for (const [name, runtime] of [
      ['hono', 'hono'],
      ['unknown', 'unknown-runtime'],
    ] as const) {
      const appDir = path.join(tempRoot, `with-bff-${name}`);
      const stderr = captureCreateFailure(appDir, [
        '--bff-runtime',
        runtime,
        '--lang',
        'en',
      ]);
      expect(stderr).toContain('Unsupported BFF runtime');
      expect(fs.existsSync(appDir)).toBe(false);
    }
  });
});
