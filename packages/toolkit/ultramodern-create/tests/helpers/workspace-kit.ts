import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { generateUltramodernWorkspace } from '../../src/ultramodern-workspace';

const require = createRequire(import.meta.url);

export function linkInstalledCompilerPolicy(workspaceDir: string) {
  const destination = path.join(
    workspaceDir,
    'node_modules/@modern-js/ultramodern-create',
  );
  if (fs.existsSync(destination)) return;
  const producer = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(producer, 'package.json'), 'utf8'),
  );
  const policy = manifest.publishConfig.exports['./tsconfig'];
  fs.mkdirSync(path.dirname(path.join(destination, policy)), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(destination, 'package.json'),
    JSON.stringify({
      ...manifest,
      ...manifest.publishConfig,
    }),
  );
  fs.copyFileSync(path.join(producer, policy), path.join(destination, policy));
}

export function linkInstalledCompiler(workspaceDir: string) {
  const compilerPath = path.join(
    workspaceDir,
    'node_modules/@typescript/native',
  );
  if (!fs.existsSync(compilerPath)) {
    fs.mkdirSync(path.dirname(compilerPath), { recursive: true });
    fs.symlinkSync(
      path.dirname(require.resolve('typescript/package.json')),
      compilerPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

export function linkInstalledEffectCompiler(workspaceDir: string) {
  linkInstalledCompilerPolicy(workspaceDir);
  for (const name of ['typescript', 'tsrs', '@effect/tsgo']) {
    const compilerPath = path.join(workspaceDir, 'node_modules', name);
    if (!fs.existsSync(compilerPath)) {
      fs.mkdirSync(path.dirname(compilerPath), { recursive: true });
      fs.symlinkSync(
        path.dirname(require.resolve(`${name}/package.json`)),
        compilerPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
  }
}

export function runValidation(workspaceDir: string) {
  return spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../../bin/run.js'), 'ultramodern', 'validate'],
    {
      cwd: workspaceDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ULTRAMODERN_WORKSPACE_ROOT: workspaceDir,
      },
    },
  );
}

export function linkWorkspaceFormatterDependencies(workspaceDir: string) {
  const modulesDirectory = path.join(workspaceDir, 'node_modules');
  fs.mkdirSync(modulesDirectory, { recursive: true });
  for (const name of ['oxfmt', 'ultracite']) {
    let providerDirectory = path.dirname(
      require.resolve(
        name === 'oxfmt' ? 'oxfmt/package.json' : 'ultracite/oxfmt',
      ),
    );
    while (!fs.existsSync(path.join(providerDirectory, 'package.json'))) {
      const parent = path.dirname(providerDirectory);
      if (parent === providerDirectory)
        throw new Error(`Missing native ${name} provider package`);
      providerDirectory = parent;
    }
    fs.symlinkSync(
      providerDirectory,
      path.join(modulesDirectory, name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

type CreateWorkspaceOptions = {
  tempPrefix?: string;
  workspaceDir?: string;
};

export async function createWorkspace(
  packageNameOrWorkspaceDir: string,
  options: CreateWorkspaceOptions = {},
) {
  const usesExplicitWorkspaceDir =
    options.workspaceDir !== undefined ||
    path.isAbsolute(packageNameOrWorkspaceDir);
  const packageName =
    usesExplicitWorkspaceDir && options.workspaceDir === undefined
      ? path.basename(packageNameOrWorkspaceDir)
      : packageNameOrWorkspaceDir;
  const workspaceDir =
    options.workspaceDir ??
    (usesExplicitWorkspaceDir
      ? packageNameOrWorkspaceDir
      : path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), options.tempPrefix ?? 'um-')),
          packageName,
        ));
  const tempRoot = path.dirname(workspaceDir);

  await generateUltramodernWorkspace({
    targetDir: workspaceDir,
    packageName,
    modernVersion: '3.2.1',
    enableTailwind: true,
    packageSource: { strategy: 'workspace' },
  });
  return { tempRoot, workspaceDir };
}

export function listFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Git metadata may change independently of generated workspace files.
    if (entry.name === '.git') {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, entryPath));
    } else if (entry.isFile()) {
      files.push(path.relative(root, entryPath).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

export function snapshotWorkspace(
  workspaceDir: string,
): Record<string, string> {
  return Object.fromEntries(
    listFiles(workspaceDir).map(relativePath => [
      relativePath,
      fs.readFileSync(path.join(workspaceDir, relativePath), 'utf-8'),
    ]),
  );
}
