import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execaSync } from '@modern-js/utils/execa';

import { addUltramodernVertical } from '../src/ultramodern-workspace';
import { formatGeneratedWorkspaceFiles } from '../src/ultramodern-workspace/fs-io';
import {
  createWorkspace,
  linkInstalledEffectCompiler,
} from './helpers/workspace-kit';

const packageRoot = path.resolve(__dirname, '..');
// Resolve Oxc tools through Ultracite's installed peer dependency graph.
const ultracitePackageDir = fs.realpathSync(
  path.join(packageRoot, 'node_modules/ultracite'),
);
const ultraciteRequire = createRequire(
  path.join(ultracitePackageDir, 'package.json'),
);
const lintDependencyPackageDirs = {
  '@modern-js/ultramodern-create': packageRoot,
  '@types/node': path.dirname(
    createRequire(import.meta.url).resolve('@types/node/package.json'),
  ),
  oxfmt: path.dirname(ultraciteRequire.resolve('oxfmt/package.json')),
  oxlint: path.dirname(ultraciteRequire.resolve('oxlint/package.json')),
  ultracite: ultracitePackageDir,
};

function provisionPackageBinary(
  nodeModulesDir: string,
  packageName: string,
  binaryName: string,
) {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(nodeModulesDir, packageName, 'package.json'),
      'utf8',
    ),
  ) as { bin?: Record<string, string> | string };
  const packageBinary =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[binaryName];
  assert.ok(packageBinary, `${packageName} must expose ${binaryName}`);

  const binDir = path.join(nodeModulesDir, '.bin');
  const binaryPath = path.join(nodeModulesDir, packageName, packageBinary);
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDir, `${binaryName}.cmd`),
      `@echo off\r\n"${process.execPath}" "${binaryPath}" %*\r\n`,
      'utf8',
    );
  } else {
    fs.symlinkSync(
      path.relative(binDir, binaryPath),
      path.join(binDir, binaryName),
      'file',
    );
  }
}

function provisionGeneratedLintDependencies(workspaceDir: string) {
  const nodeModulesDir = path.join(workspaceDir, 'node_modules');
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  for (const [packageName, packageDir] of Object.entries(
    lintDependencyPackageDirs,
  )) {
    fs.mkdirSync(path.dirname(path.join(nodeModulesDir, packageName)), {
      recursive: true,
    });
    fs.symlinkSync(
      packageDir,
      path.join(nodeModulesDir, packageName),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  linkInstalledEffectCompiler(workspaceDir);
  provisionPackageBinary(nodeModulesDir, 'oxlint', 'oxlint');
  provisionPackageBinary(
    nodeModulesDir,
    '@modern-js/ultramodern-create',
    'ultramodern-create',
  );
}

function provisionApiDependencies(workspaceDir: string, scope: string) {
  for (const [name, target] of [
    ['effect', path.dirname(ultraciteRequire.resolve('effect/package.json'))],
    [
      '@typescript/native',
      fs.realpathSync(path.join(packageRoot, 'node_modules/typescript')),
    ],
    ['@modern-js/code-tools', path.resolve(packageRoot, '../code-tools')],
    [
      '@modern-js/bff-effect',
      path.resolve(packageRoot, '../../server/bff-effect'),
    ],
    [
      `@${scope}/shared-contracts`,
      path.join(workspaceDir, 'packages/shared-contracts'),
    ],
  ]) {
    const destination = path.join(workspaceDir, 'node_modules', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(
      target,
      destination,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

function runGeneratedWorkspaceLint(workspaceDir: string) {
  const externalPath = (process.env.PATH ?? process.env.Path ?? '')
    .split(path.delimiter)
    .filter(entry => !/[\\/]node_modules[\\/]\.bin$/u.test(entry))
    .join(path.delimiter);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: externalPath };
  if (process.platform === 'win32') {
    env.Path = externalPath;
  }
  return execaSync('pnpm', ['--config.verify-deps-before-run=false', 'lint'], {
    cwd: workspaceDir,
    encoding: 'utf8',
    env,
    reject: false,
  });
}

function assertGeneratedWorkspaceLintClean(
  workspaceDir: string,
  generatedState: string,
) {
  const result = runGeneratedWorkspaceLint(workspaceDir);
  const commandOutput = `${result.stdout}\n${result.stderr}`;
  assert.equal(
    result.failed,
    false,
    `${generatedState} lint failed to execute.\n${commandOutput}`,
  );
  assert.match(
    commandOutput,
    /Semantic lint checked \d+ files in \d+ configured projects; 0 findings\./u,
    `${generatedState} must complete the semantic pass as well as Oxlint.\n${commandOutput}`,
  );
  assert.equal(
    result.exitCode,
    0,
    `${generatedState} lint exited unsuccessfully.\n${commandOutput}`,
  );
}

function assertGeneratedWorkspaceContractClean(
  workspaceDir: string,
  generatedState: string,
) {
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../bin/run.js'), 'ultramodern', 'validate'],
    { cwd: workspaceDir, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `${generatedState} failed its generated workspace contract.\n${result.stdout}\n${result.stderr}`,
  );
}

describe.each([
  { state: 'shell-only workspace', verticals: [] },
  { state: 'workspace with checkout', verticals: ['checkout'] },
  {
    state: 'workspace with checkout, catalog, and records',
    verticals: ['checkout', 'catalog', 'records'],
  },
])('generated workspace lint and contracts: $state', ({ state, verticals }) => {
  let tempRoot: string;
  let workspaceDir: string;
  let setup: Promise<void> | undefined;

  beforeAll(() => {
    setup = (async () => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-generated-lint-'));
      workspaceDir = path.join(tempRoot, 'generated-lint');
      await createWorkspace('generated-lint', { workspaceDir });
      provisionGeneratedLintDependencies(workspaceDir);
      for (const name of verticals) {
        await addUltramodernVertical({
          workspaceRoot: workspaceDir,
          name,
          modernVersion: '3.2.1',
        });
      }
    })();
    return setup;
  });

  afterAll(async () => {
    // A hook timeout leaves setup running; drain it before removing the fixture.
    if (setup) await Promise.allSettled([setup]);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('generated files are lint-clean and validate', () => {
    assertGeneratedWorkspaceLintClean(workspaceDir, state);
    assertGeneratedWorkspaceContractClean(workspaceDir, state);
  });
});

test('a semantic-only violation makes the generated lint command fail', async () => {
  const { tempRoot, workspaceDir } = await createWorkspace('semantic-pipeline');
  try {
    provisionGeneratedLintDependencies(workspaceDir);
    fs.writeFileSync(
      path.join(
        workspaceDir,
        'apps/shell-super-app/src/semantic-lint-control.ts',
      ),
      `interface OptionalValue { readonly value?: string }
export interface RedundantValue {
  readonly value?: OptionalValue['value'] | undefined;
}
`,
    );
    const result = runGeneratedWorkspaceLint(workspaceDir);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.failed, true, output);
    assert.equal(result.exitCode, 1, output);
    assert.match(output, /\[ultramodern\/redundant-optional-undefined\]/u);
    assert.match(
      output,
      /Semantic lint checked \d+ files in \d+ configured projects; 1 findings\./u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('generated APIs pass real Oxlint after Oxfmt with the current preset and native boundaries', async () => {
  const { tempRoot, workspaceDir } = await createWorkspace('erp-api-lint');
  try {
    provisionGeneratedLintDependencies(workspaceDir);
    provisionApiDependencies(workspaceDir, 'erp-api-lint');
    const names = ['inventory', 'orders'];
    for (const name of names) {
      await addUltramodernVertical({
        workspaceRoot: workspaceDir,
        name,
        modernVersion: '3.9.0',
      });
    }
    formatGeneratedWorkspaceFiles(workspaceDir);
    assertGeneratedWorkspaceLintClean(
      workspaceDir,
      'two formatted scoped APIs',
    );
    const checked = spawnSync(
      process.execPath,
      [path.resolve(packageRoot, '../code-tools/bin/modern-api-check.mjs')],
      {
        cwd: workspaceDir,
        encoding: 'utf8',
        env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: workspaceDir },
      },
    );
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
