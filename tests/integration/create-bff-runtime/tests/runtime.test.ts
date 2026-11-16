import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  generatedModernBin,
  installPackedGenerator,
  materializeGeneratedWorkspaceDependencies,
} from '../../../utils/generatedWorkspaceDependencies';
import { generatorTestTempParent } from '../../../utils/generatorTestTemp.mjs';
import {
  getPort,
  killApp,
  modernBuild,
  modernServe,
} from '../../../utils/modernTestUtils';
import { setSuiteTimeout } from '../../../utils/setSuiteTimeout';

setSuiteTimeout(600_000);

const repoRoot = path.resolve(__dirname, '../../../../');
let createBin: string;
const testFrameworkVersion = '3.2.0-ultramodern.108';
const frameworkVersionEnv = 'ULTRAMODERN_CREATE_FRAMEWORK_VERSION';

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
  runCreate(workspaceDir, workspaceArgs);
  runCreateInWorkspace(workspaceDir, verticalArgs);
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

  test('generates, builds, and serves a strict Effect BFF app', async () => {
    const workspaceDir = path.join(tempRoot, 'with-bff-effect');
    scaffoldWorkspaceWithVertical(
      workspaceDir,
      ['--bff-runtime', 'effect', '--lang', 'en'],
      ['greetings', '--vertical', '--bff-runtime', 'effect', '--lang', 'en'],
    );
    await materializeGeneratedWorkspaceDependencies(workspaceDir);
    const verticalDir = path.join(workspaceDir, 'verticals/greetings');
    const buildResult = await modernBuild(verticalDir, [], {
      modernBin: generatedModernBin(verticalDir),
      env: { NODE_PATH: '' },
      stdout: false,
      stderr: false,
    });
    expect(
      buildResult.code,
      `${buildResult.stdout}
${buildResult.stderr}`,
    ).toBe(0);

    const port = await getPort();
    const server = await modernServe(verticalDir, port, {
      modernBin: generatedModernBin(verticalDir),
      env: { NODE_PATH: '' },
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/greetings-api/greetings?limit=1`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        items: [
          {
            id: 'starter-greetings',
            title: 'Wire a real greetings source here',
          },
        ],
      });
    } finally {
      await killApp(server);
    }
  });
});
