import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { formatGeneratedWorkspaceFiles } from '../src/ultramodern-workspace/fs-io';
import { createWorkspace } from './helpers/workspace-kit';

const packageRoot = path.resolve(__dirname, '..');
// Resolve Oxfmt through Ultracite's installed peer dependency graph.
const oxfmtPackageJsonPath = createRequire(
  path.join(
    fs.realpathSync(path.join(packageRoot, 'node_modules/ultracite')),
    'package.json',
  ),
).resolve('oxfmt/package.json');
const oxfmtCliPath = path.join(
  path.dirname(oxfmtPackageJsonPath),
  (
    JSON.parse(fs.readFileSync(oxfmtPackageJsonPath, 'utf-8')) as {
      bin: { oxfmt: string };
    }
  ).bin.oxfmt,
);

function createFormatHarness(workspaceDir: string) {
  const formatHarnessDir = fs.mkdtempSync(
    path.join(packageRoot, '.format-harness-'),
  );
  const configPath = path.join(formatHarnessDir, 'oxfmt.config.ts');
  fs.copyFileSync(path.join(workspaceDir, 'oxfmt.config.ts'), configPath);
  return configPath;
}

function runGeneratedFormat(
  workspaceDir: string,
  configPath: string,
  relativePath: string,
  check: boolean,
) {
  return spawnSync(
    process.execPath,
    [
      oxfmtCliPath,
      '--config',
      configPath,
      ...(check ? ['--check'] : []),
      relativePath,
    ],
    {
      cwd: workspaceDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
    },
  );
}

function assertFormatStatus(
  result: ReturnType<typeof runGeneratedFormat>,
  expectedStatus: number,
  state: string,
) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(
    result.error,
    undefined,
    `${state} failed to execute.\n${output}`,
  );
  assert.equal(result.status, expectedStatus, `${state} failed.\n${output}`);
}

test('formatGeneratedWorkspaceFiles produces output that already satisfies the generated oxfmt config', async () => {
  const { tempRoot, workspaceDir } = await createWorkspace('generated-format', {
    tempPrefix: 'um-generated-format-',
  });
  const configPath = createFormatHarness(workspaceDir);
  const relativePath = path.join('packages', 'format-probe.tsx');
  const probePath = path.join(workspaceDir, relativePath);
  const unsortedProbe =
    'export const Probe = () => <div className="p-4 flex items-center">probe</div>;\n';

  try {
    fs.writeFileSync(probePath, unsortedProbe, 'utf-8');
    formatGeneratedWorkspaceFiles(workspaceDir, [relativePath]);
    const formattedProbe = fs.readFileSync(probePath, 'utf-8');
    assert.notEqual(
      formattedProbe,
      unsortedProbe,
      'formatGeneratedWorkspaceFiles must actually rewrite unformatted source',
    );
    assertFormatStatus(
      runGeneratedFormat(workspaceDir, configPath, relativePath, true),
      0,
      'generation preformat compatibility check',
    );
  } finally {
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
