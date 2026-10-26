import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateUltramodernWorkspace } from '../src/ultramodern-workspace';
import { workspaceTemplateDir } from '../src/ultramodern-workspace/fs-io';
import { compilerBootstrapFixture } from './helpers/compiler-bootstrap';

/**
 * Supply-chain guardrails for generated workspaces: a plain `pnpm install`
 * (postinstall) must never install system packages with sudo or install
 * reference repositories. Codex skills are default-on, repo-owned, and may
 * skip clone-backed skills only as an advisory offline fallback.
 */

const createBinPath = path.resolve(__dirname, '../bin/run.js');

async function scaffoldWorkspace(): Promise<{
  tempRoot: string;
  workspaceDir: string;
}> {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-postinstall-safety-'),
  );
  const workspaceDir = path.join(tempRoot, 'safety-workspace');
  await generateUltramodernWorkspace({
    targetDir: workspaceDir,
    packageName: 'safety-workspace',
    modernVersion: '3.2.1',
    enableTailwind: true,
    packageSource: {
      strategy: 'workspace',
    },
  });
  return { tempRoot, workspaceDir };
}

function writeExecutable(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function writeCommandShim(
  fakeBinDir: string,
  command: string,
  scriptContent: string,
) {
  const scriptPath = path.join(fakeBinDir, `${command}.js`);
  fs.writeFileSync(scriptPath, scriptContent);
  writeExecutable(
    path.join(fakeBinDir, command),
    `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)});\n`,
  );
  fs.writeFileSync(
    path.join(fakeBinDir, `${command}.cmd`),
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
  );
}

function createFakeGitAndLefthookBin(
  tempRoot: string,
  options: { failNetwork?: boolean; topLevel?: string },
) {
  const fakeBinDir = path.join(tempRoot, 'fake-bin');
  const gitLog = path.join(tempRoot, 'git.log');
  const ghLog = path.join(tempRoot, 'gh.log');
  const lefthookLog = path.join(tempRoot, 'lefthook.log');
  fs.mkdirSync(fakeBinDir);

  writeCommandShim(
    fakeBinDir,
    'git',
    `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(gitLog)}, \`\${args.join(' ')}\\n\`);
if (args[0] === '--version') {
  console.log('git version 2.44.0');
  process.exit(0);
}
if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
  const topLevel = ${options.topLevel === undefined ? 'undefined' : JSON.stringify(options.topLevel)};
  if (topLevel === undefined) {
    process.exit(1);
  }
  console.log(topLevel);
  process.exit(0);
}
if (args[0] === 'init') {
  fs.mkdirSync(path.join(process.cwd(), '.git'), { recursive: true });
  process.exit(0);
}
if (args[0] === 'branch') {
  process.exit(0);
}
if (${JSON.stringify(options.failNetwork === true)} && (args[0] === 'clone' || args[0] === 'fetch')) {
  process.exit(1);
}
process.exit(0);
`,
  );
  writeCommandShim(
    fakeBinDir,
    'gh',
    `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(ghLog)}, \`\${process.argv.slice(2).join(' ')}\\n\`);
process.exit(1);
`,
  );
  writeCommandShim(
    fakeBinDir,
    'lefthook',
    `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(lefthookLog)}, \`\${process.cwd()} \${process.argv.slice(2).join(' ')}\\n\`);
process.exit(0);
`,
  );

  return { fakeBinDir, ghLog, gitLog, lefthookLog };
}

function withFakeToolEnv(fakeBinDir: string) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const activePathKey = pathKey ?? 'PATH';
  env[activePathKey] =
    `${fakeBinDir}${path.delimiter}${env[activePathKey] ?? ''}`;
  env.PATH = env[activePathKey];
  if (process.platform === 'win32') {
    env.Path = env[activePathKey];
    env.PATHEXT = `.CMD;.EXE;.BAT;.COM;${env.PATHEXT ?? ''}`;
  }
  const commandExtension = process.platform === 'win32' ? '.cmd' : '';
  env.ULTRAMODERN_GIT_BIN = path.join(fakeBinDir, `git${commandExtension}`);
  env.ULTRAMODERN_GH_BIN = path.join(fakeBinDir, `gh${commandExtension}`);
  env.ULTRAMODERN_LEFTHOOK_BIN = path.join(
    fakeBinDir,
    `lefthook${commandExtension}`,
  );
  env.ULTRAMODERN_CREATE_BIN = createBinPath;
  return env;
}

function withCreateBinEnv() {
  return {
    ...process.env,
    ULTRAMODERN_CREATE_BIN: createBinPath,
  };
}

test('generated postinstall installs vendored Codex skills without formatting consumer source', async () => {
  const { tempRoot, workspaceDir } = await scaffoldWorkspace();

  try {
    // Bootstrap copies the authoritative vendored bytes. Initial generation
    // formats Markdown, which can differ from a Windows CRLF source checkout.
    const expectedSkill = fs.readFileSync(
      path.join(
        workspaceTemplateDir,
        '.codex/skills/rsbuild-best-practices/SKILL.md',
      ),
    );
    fs.rmSync(path.join(workspaceDir, '.codex/skills/rsbuild-best-practices'), {
      force: true,
      recursive: true,
    });
    fs.mkdirSync(path.join(workspaceDir, '.codex/skills/local-user-skill'), {
      recursive: true,
    });
    const userSkill = Buffer.from('# Local user skill\n');
    fs.writeFileSync(
      path.join(workspaceDir, '.codex/skills/local-user-skill/SKILL.md'),
      userSkill,
    );
    const { fakeBinDir } = createFakeGitAndLefthookBin(tempRoot, {
      failNetwork: true,
      topLevel: undefined,
    });
    const compilerLog = path.join(tempRoot, 'effect-compiler.json');
    compilerBootstrapFixture(workspaceDir, { compilerLog });
    const consumerSourcePath = path.join(workspaceDir, 'consumer.ts');
    const consumerSource = 'export const value={unchanged:true}\n';
    fs.writeFileSync(consumerSourcePath, consumerSource);
    writeCommandShim(
      fakeBinDir,
      'oxfmt',
      `require('node:fs').writeFileSync(${JSON.stringify(consumerSourcePath)}, 'formatted');`,
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'),
    );
    const createPackageRoot = path.resolve(__dirname, '..');
    const createPackageJson = JSON.parse(
      fs.readFileSync(path.join(createPackageRoot, 'package.json'), 'utf8'),
    );
    assert.equal(
      packageJson.devDependencies[createPackageJson.name],
      'workspace:*',
    );
    const installedCreate = path.join(
      workspaceDir,
      'node_modules',
      createPackageJson.name,
    );
    fs.mkdirSync(path.dirname(installedCreate), { recursive: true });
    fs.symlinkSync(
      createPackageRoot,
      installedCreate,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const nativeCreateBin = path.join(
      installedCreate,
      createPackageJson.bin['ultramodern-create'],
    );
    assert.equal(
      fs.realpathSync(nativeCreateBin),
      fs.realpathSync(createBinPath),
    );
    const installedBinDir = path.join(workspaceDir, 'node_modules/.bin');
    fs.mkdirSync(installedBinDir, { recursive: true });
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(installedBinDir, 'ultramodern-create.cmd'),
        `@echo off\r\n"${process.execPath}" "${nativeCreateBin}" %*\r\n`,
      );
    } else {
      fs.symlinkSync(
        path.relative(installedBinDir, nativeCreateBin),
        path.join(installedBinDir, 'ultramodern-create'),
        'file',
      );
    }
    const env = withFakeToolEnv(fakeBinDir);
    env.PATH = `${installedBinDir}${path.delimiter}${env.PATH ?? ''}`;
    if (process.platform === 'win32') env.Path = env.PATH;
    delete env.ULTRAMODERN_CODEX_SKILLS;
    delete env.ULTRAMODERN_SKIP_CODEX_SKILLS;

    const result = spawnSync(packageJson.scripts.postinstall, {
      cwd: workspaceDir,
      encoding: 'utf-8',
      env,
      shell: true,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(compilerLog, 'utf8')).args, [
      'tsrs',
      '--version',
    ]);
    assert.equal(fs.readFileSync(consumerSourcePath, 'utf8'), consumerSource);
    assert.deepEqual(
      fs.readFileSync(
        path.join(
          workspaceDir,
          '.codex/skills/rsbuild-best-practices/SKILL.md',
        ),
      ),
      expectedSkill,
    );
    assert.match(
      result.stderr,
      /Advisory: unable to install Codex skills from https:\/\/github.com\/module-federation\/agent-skills/,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          workspaceDir,
          '.codex/skills/rsbuild-best-practices/SKILL.md',
        ),
      ),
      true,
    );
    assert.deepEqual(
      fs.readFileSync(
        path.join(workspaceDir, '.codex/skills/local-user-skill/SKILL.md'),
      ),
      userSkill,
      'postinstall must preserve user-owned skill bytes',
    );
    assert.equal(
      fs.readFileSync(
        path.join(workspaceDir, '.codex/skills/local-user-skill/SKILL.md'),
        'utf8',
      ),
      '# Local user skill\n',
    );
    assert.equal(
      fs.existsSync(path.join(workspaceDir, '.codex/skills/mf')),
      false,
    );
    const formatted = spawnSync(packageJson.scripts.format, {
      cwd: workspaceDir,
      encoding: 'utf-8',
      env,
      shell: true,
    });
    assert.equal(formatted.status, 0, formatted.stderr);
    assert.equal(fs.readFileSync(consumerSourcePath, 'utf8'), 'formatted');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installed skills command --postinstall skips Lefthook in nested Git worktrees', async () => {
  const { tempRoot, workspaceDir } = await scaffoldWorkspace();

  try {
    const { fakeBinDir, gitLog, lefthookLog } = createFakeGitAndLefthookBin(
      tempRoot,
      { failNetwork: true, topLevel: tempRoot },
    );
    const env = withFakeToolEnv(fakeBinDir);
    delete env.ULTRAMODERN_CODEX_SKILLS;
    delete env.ULTRAMODERN_SKIP_CODEX_SKILLS;

    const result = spawnSync(
      process.execPath,
      [createBinPath, 'ultramodern', 'skills', 'install', '--postinstall'],
      {
        cwd: workspaceDir,
        encoding: 'utf-8',
        env,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nested inside another Git worktree/);
    assert.match(fs.readFileSync(gitLog, 'utf-8'), /rev-parse --show-toplevel/);
    assert.doesNotMatch(fs.readFileSync(gitLog, 'utf-8'), /^init -b main$/m);
    assert.equal(fs.existsSync(lefthookLog), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installed skills command --postinstall installs Lefthook for standalone generated repos', async () => {
  const { tempRoot, workspaceDir } = await scaffoldWorkspace();

  try {
    const { fakeBinDir, gitLog, lefthookLog } = createFakeGitAndLefthookBin(
      tempRoot,
      { failNetwork: true, topLevel: undefined },
    );
    const env = withFakeToolEnv(fakeBinDir);
    delete env.ULTRAMODERN_CODEX_SKILLS;
    delete env.ULTRAMODERN_SKIP_CODEX_SKILLS;

    const result = spawnSync(
      process.execPath,
      [createBinPath, 'ultramodern', 'skills', 'install', '--postinstall'],
      {
        cwd: workspaceDir,
        encoding: 'utf-8',
        env,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(gitLog, 'utf-8'), /^init -b main$/m);
    assert.match(fs.readFileSync(lefthookLog, 'utf-8').trimEnd(), / install$/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installed skills command --postinstall supports documented Codex skill opt-outs', async () => {
  for (const envPatch of [{ ULTRAMODERN_SKIP_CODEX_SKILLS: '1' }]) {
    const { tempRoot, workspaceDir } = await scaffoldWorkspace();

    try {
      fs.rmSync(
        path.join(workspaceDir, '.codex/skills/rsbuild-best-practices'),
        {
          force: true,
          recursive: true,
        },
      );
      const { fakeBinDir } = createFakeGitAndLefthookBin(tempRoot, {
        topLevel: tempRoot,
      });
      const env = { ...withFakeToolEnv(fakeBinDir), ...envPatch };

      const result = spawnSync(
        process.execPath,
        [createBinPath, 'ultramodern', 'skills', 'install', '--postinstall'],
        {
          cwd: workspaceDir,
          encoding: 'utf-8',
          env,
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /Codex skills bootstrap skipped by environment/,
      );
      assert.equal(
        fs.existsSync(
          path.join(
            workspaceDir,
            '.codex/skills/rsbuild-best-practices/SKILL.md',
          ),
        ),
        false,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('installed skills command resolves the agents-standard .agents/ lockfile layout', async () => {
  const { tempRoot, workspaceDir } = await scaffoldWorkspace();

  try {
    fs.mkdirSync(path.join(workspaceDir, '.agents'), { recursive: true });
    fs.renameSync(
      path.join(workspaceDir, '.codex/skills-lock.json'),
      path.join(workspaceDir, '.agents/skills-lock.json'),
    );

    const result = spawnSync(
      process.execPath,
      [createBinPath, 'ultramodern', 'skills', 'check'],
      {
        cwd: workspaceDir,
        encoding: 'utf-8',
        env: withCreateBinEnv(),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Missing skills-lock\.json/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
