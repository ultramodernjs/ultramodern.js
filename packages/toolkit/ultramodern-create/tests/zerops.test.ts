import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execaSync } from '@modern-js/utils/execa';
import yaml from 'js-yaml';
import type { WorkspaceApp } from '../src/ultramodern-workspace/types';
import { createZeropsYaml } from '../src/ultramodern-workspace/zerops';

type CommandRecord = {
  argv: string[];
  cwd: string;
};

function resolvePosixShell() {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const fromPath = execaSync('where.exe', ['sh.exe'], { reject: false });
    if (!fromPath.failed) {
      candidates.push(...fromPath.stdout.trim().split(/\r?\n/u));
    }
    const git = execaSync('git', ['--exec-path'], { reject: false });
    if (!git.failed) {
      const gitRoot = path.resolve(git.stdout.trim(), '../../..');
      candidates.push(
        path.join(gitRoot, 'usr/bin/sh.exe'),
        path.join(gitRoot, 'bin/sh.exe'),
      );
    }
  } else {
    candidates.push('/bin/sh');
  }

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) {
      continue;
    }
    try {
      if (
        execFileSync(candidate, ['-c', 'printf ultramodern-posix-shell'], {
          encoding: 'utf8',
          timeout: 5000,
        }) === 'ultramodern-posix-shell'
      ) {
        return candidate;
      }
    } catch {
      // Try the next installed POSIX shell; this test executes Linux commands.
    }
  }
  throw new Error(
    'Zerops command tests require a POSIX shell. Install Git for Windows or provide sh.exe on PATH.',
  );
}

function writeExecutable(filePath: string, source: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}`, 'utf-8');
  fs.chmodSync(filePath, 0o755);
}

function readCommandRecords(filePath: string) {
  return fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .map(line => {
      const record = JSON.parse(line) as CommandRecord;
      return { ...record, cwd: fs.realpathSync.native(record.cwd) };
    });
}

const ownership = {
  team: 'platform',
  slack: '#platform',
  pagerDuty: 'platform',
  runbookRef: 'docs/runbook.md',
  adrRef: 'docs/adr.md',
  blastRadius: {
    tier: 'low',
    references: [],
  },
};

test('Zerops commands preserve interpolated arguments and launch the materialized runtime', () => {
  const shell = resolvePosixShell();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-zerops-command-'));
  const app: WorkspaceApp = {
    id: "catalog 'quoted' app",
    directory: "verticals/catalog 'quoted'",
    packageSuffix: "catalog 'quoted' pkg",
    displayName: 'Catalog',
    kind: 'vertical',
    portEnv: 'CATALOG_PORT',
    port: 3050,
    mfName: 'catalog',
    api: {
      prefix: '/catalog api',
      stem: "catalog 'stem'",
      consumedBy: [],
    },
    ownership,
  };

  const document = yaml.load(createZeropsYaml('acme', [app])) as {
    zerops: Array<Record<string, any>>;
  };
  const [service] = document.zerops;

  try {
    assert.equal(service.setup, "catalog 'quoted' app");
    assert.equal(
      service.deploy.readinessCheck.httpGet.path,
      "/catalog api/catalog 'stem'/readiness",
    );
    assert.deepEqual(service.build.envVariables, { ZE_FAIL_BUILD: 'true' });

    const fakeHome = path.join(tempRoot, 'home');
    const fakeBin = path.join(tempRoot, 'bin');
    const commandRecordPath = path.join(tempRoot, 'mise-records.jsonl');
    const serveRecordPath = path.join(tempRoot, 'serve-record.json');
    const runtimeDirectory = path.join(tempRoot, '.zerops/runtime', app.id);
    fs.mkdirSync(path.join(fakeHome, '.local/bin'), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    const workspaceRealPath = fs.realpathSync.native(tempRoot);
    const runtimeRealPath = fs.realpathSync.native(runtimeDirectory);
    fs.mkdirSync(path.join(tempRoot, 'topology/local-overlays'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempRoot, 'topology/reference-topology.json'),
      '{}\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tempRoot, 'topology/local-overlays/development.json'),
      '{}\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(runtimeDirectory, 'package.json'),
      `${JSON.stringify({ scripts: { serve: 'node index.js' } }, null, 2)}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(runtimeDirectory, 'index.js'),
      "require('node:fs').writeFileSync(process.env.UM_ZEROPS_SERVE_RECORD, JSON.stringify({ cwd: process.cwd(), service: process.env.ULTRAMODERN_ZEROPS_SERVICE }));\n",
      'utf-8',
    );

    const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { process.stdout.write('2026.11.8 fixture'); }
else fs.appendFileSync(process.env.UM_ZEROPS_COMMAND_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
`;
    const fixturePath = path.join(tempRoot, 'fixture');
    fs.writeFileSync(fixturePath, fixture);
    const preload = path.join(tempRoot, 'bootstrap-preload.cjs');
    fs.writeFileSync(
      preload,
      `
const fs = require('node:fs');
const cp = require('node:child_process');
const exec = cp.execFileSync;
// Test-only platform selection. The executable is portable JavaScript, not Linux ELF.
Object.defineProperty(process, 'platform', { value: 'linux' });
Object.defineProperty(process, 'arch', { value: 'x64' });
global.fetch = async () => new Response(process.env.UM_ZEROPS_CORRUPT ? Buffer.alloc(fs.statSync(${JSON.stringify(fixturePath)}).size) : fs.readFileSync(${JSON.stringify(fixturePath)}));
cp.execFileSync = (file, args, options) => exec(process.execPath, [file, ...args], options);
`,
    );
    const fixtureDigest = createHash('sha256').update(fixture).digest('hex');
    const buildCommand = service.build.buildCommands[0]
      .replaceAll(/size: \d+/gu, `size: ${Buffer.byteLength(fixture)}`)
      .replaceAll(/sha256: '[a-f0-9]+'/gu, `sha256: '${fixtureDigest}'`);

    const probeEnvironment = {
      ...process.env,
      HOME: fakeHome,
      NODE_OPTIONS: `--require=${preload}`,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      ULTRAMODERN_ZEROPS_SERVICE: app.id,
      UM_ZEROPS_COMMAND_RECORD: commandRecordPath,
      UM_ZEROPS_SERVE_RECORD: serveRecordPath,
    };
    const existingMise = path.join(fakeHome, '.local/bin/mise');
    writeExecutable(existingMise, "throw new Error('old mise must not run');");
    const existingBytes = fs.readFileSync(existingMise);
    assert.throws(
      () =>
        execFileSync(shell, ['-c', buildCommand], {
          cwd: tempRoot,
          env: { ...probeEnvironment, UM_ZEROPS_CORRUPT: '1' },
          stdio: 'pipe',
        }),
      /SHA-256 mismatch/u,
    );
    assert.deepEqual(fs.readFileSync(existingMise), existingBytes);
    assert.deepEqual(fs.readdirSync(path.dirname(existingMise)), ['mise']);
    assert.equal(fs.existsSync(commandRecordPath), false);
    execFileSync(shell, ['-c', buildCommand], {
      cwd: tempRoot,
      env: probeEnvironment,
      stdio: 'pipe',
    });

    assert.equal(fs.readFileSync(existingMise, 'utf8'), fixture);
    assert.deepEqual(fs.readdirSync(path.dirname(existingMise)), ['mise']);
    assert.deepEqual(readCommandRecords(commandRecordPath), [
      { argv: ['install'], cwd: workspaceRealPath },
      {
        argv: ['exec', '--', 'pnpm', 'install', '--frozen-lockfile'],
        cwd: workspaceRealPath,
      },
      {
        argv: [
          'exec',
          '--',
          'pnpm',
          '--filter',
          "@acme/catalog 'quoted' pkg",
          'run',
          'build',
        ],
        cwd: workspaceRealPath,
      },
      {
        argv: [
          'exec',
          '--',
          'pnpm',
          'run',
          'zerops:materialize',
          '--',
          '--app',
          "catalog 'quoted' app",
          '--package',
          "@acme/catalog 'quoted' pkg",
          '--package-dir',
          "verticals/catalog 'quoted'",
        ],
        cwd: workspaceRealPath,
      },
    ]);
    assert.equal(
      fs.readFileSync(path.join(runtimeDirectory, 'topology.json'), 'utf-8'),
      '{}\n',
    );
    assert.equal(
      fs.readFileSync(
        path.join(runtimeDirectory, 'local-overlay.json'),
        'utf-8',
      ),
      '{}\n',
    );

    execFileSync(shell, ['-c', service.run.start], {
      cwd: tempRoot,
      env: {
        ...probeEnvironment,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
      },
      stdio: 'pipe',
    });
    const startResult = JSON.parse(
      fs.readFileSync(serveRecordPath, 'utf-8'),
    ) as {
      cwd: string;
      service: string;
    };
    assert.deepEqual(
      { ...startResult, cwd: fs.realpathSync.native(startResult.cwd) },
      { cwd: runtimeRealPath, service: app.id },
    );
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
