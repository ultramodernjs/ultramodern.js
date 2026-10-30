import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addUltramodernVertical,
  generateUltramodernWorkspace,
} from '../src/ultramodern-workspace';

function assertReferencedScriptsExist(workspaceDir: string) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf-8'),
  ) as { scripts?: Record<string, string> };
  for (const [scriptName, command] of Object.entries(
    packageJson.scripts ?? {},
  )) {
    for (const match of command.matchAll(
      /node \.\/(scripts\/[\s\S]*?)(?:\s|&|$)/gu,
    )) {
      const scriptPath = match[1].replace(/["']$/u, '');
      assert.equal(
        fs.existsSync(path.join(workspaceDir, scriptPath)),
        true,
        `${scriptName} references missing ${scriptPath}`,
      );
    }
  }
}

test('generated command plans reference emitted deployment capabilities', () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-profile-coherence-'),
  );
  const workspaceDir = path.join(tempRoot, 'profile-workspace');
  try {
    generateUltramodernWorkspace({
      targetDir: workspaceDir,
      packageName: 'profile-workspace',
      modernVersion: '3.2.1',
      enableTailwind: true,
      packageSource: { strategy: 'workspace' },
    });
    addUltramodernVertical({
      workspaceRoot: workspaceDir,
      name: 'catalog',
      modernVersion: '3.2.1',
    });

    for (const appDir of ['apps/shell-super-app', 'verticals/catalog']) {
      const modernConfig = fs.readFileSync(
        path.join(workspaceDir, appDir, 'modern.config.ts'),
        'utf-8',
      );
      assert.doesNotMatch(modernConfig, /overrideBrowserslist/u);
    }

    assertReferencedScriptsExist(workspaceDir);
    assert.equal(fs.existsSync(path.join(workspaceDir, 'zerops.yaml')), true);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf-8'),
    ) as { scripts?: Record<string, string> };
    assert.equal(
      packageJson.scripts?.['zerops:materialize'],
      'ultramodern-create ultramodern zerops-materialize',
    );
    assert.match(
      packageJson.scripts?.['cloudflare:build'] ?? '',
      /cloudflare:ssr-proof$/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace validation accepts explicitly disabled agent instruction files', () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-no-agent-instructions-'),
  );
  const workspaceDir = path.join(tempRoot, 'no-agent-workspace');
  try {
    generateUltramodernWorkspace({
      targetDir: workspaceDir,
      packageName: 'no-agent-workspace',
      modernVersion: '3.2.1',
      enableTailwind: true,
      generateAgentFiles: false,
      packageSource: { strategy: 'workspace' },
    });
    assert.equal(fs.existsSync(path.join(workspaceDir, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(workspaceDir, 'CLAUDE.md')), false);
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../bin/run.js'), 'ultramodern', 'validate'],
      {
        cwd: workspaceDir,
        encoding: 'utf-8',
        env: {
          ...process.env,
          ULTRAMODERN_CREATE_BIN: path.resolve(__dirname, '../bin/run.js'),
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
