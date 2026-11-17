import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { supportProtocol } from '../../ultramodern-support-artifacts/protocol.mjs';
import { githubReader } from '../../ultramodern-support-artifacts/transport.mjs';
import {
  supportAdmissionRun,
  verifyInstalledSupportWorkspace,
} from '../lib/support-release-admission.mjs';
import { main } from '../run-release-acceptance.mjs';

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('support API reads use the supplied credential only on trusted GitHub routes', async () => {
  const previous = process.env.GH_TOKEN;
  const fallback = process.env.GITHUB_TOKEN;
  const requests = [];
  try {
    process.env.GH_TOKEN = 'synthetic-read-only-token';
    process.env.GITHUB_TOKEN = 'synthetic-fallback-token';
    const options = {
      fetchArtifact: async (url, init) => {
        requests.push({ url, headers: init.headers });
        return Response.json({ id: supportProtocol.repositoryId });
      },
    };
    const route = `/repositories/${supportProtocol.repositoryId}`;
    await githubReader(options)(route);
    delete process.env.GH_TOKEN;
    await githubReader(options)(route);
    await githubReader({ ...options, token: 'synthetic-explicit-token' })(
      route,
    );
    assert.deepEqual(
      requests.map(item => item.headers.Authorization),
      [
        'Bearer synthetic-read-only-token',
        'Bearer synthetic-fallback-token',
        'Bearer synthetic-explicit-token',
      ],
    );
    assert(
      requests.every(item => item.url === `https://api.github.com${route}`),
    );
    await assert.rejects(
      githubReader(options)('/repos/foreign/repository/actions/runs/1'),
      /Untrusted GitHub API route/u,
    );
    assert.equal(requests.length, 3);
  } finally {
    restoreEnvironment('GH_TOKEN', previous);
    restoreEnvironment('GITHUB_TOKEN', fallback);
  }
});

test('acceptance consumes its dedicated token before even parsing a command', async () => {
  const previous = process.env.SUPPORT_ARTIFACT_GITHUB_TOKEN;
  try {
    process.env.SUPPORT_ARTIFACT_GITHUB_TOKEN = 'synthetic-coordinator-token';
    const environment = { ...process.env };
    await assert.rejects(
      main(['--not-an-option'], environment),
      /Unknown argument/u,
    );
    assert.equal(environment.SUPPORT_ARTIFACT_GITHUB_TOKEN, undefined);
    assert.equal(process.env.SUPPORT_ARTIFACT_GITHUB_TOKEN, undefined);
  } finally {
    restoreEnvironment('SUPPORT_ARTIFACT_GITHUB_TOKEN', previous);
  }
});

test('only the read-only verifier child receives the coordinator credential', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-auth-env-'));
  const original = childProcess.spawnSync;
  const previous = process.env.GH_TOKEN;
  let installed = false;
  let inspected = false;
  try {
    delete process.env.GH_TOKEN;
    childProcess.spawnSync = (command, args, options) => {
      assert(installed, 'Install must finish before admission');
      assert.equal(command, process.execPath);
      assert(args[0].endsWith('verify-support-workspace.mjs'));
      assert.equal(options.env.GH_TOKEN, 'synthetic-coordinator-token');
      assert.equal(options.env.SUPPORT_ARTIFACT_GITHUB_TOKEN, undefined);
      assert.equal(options.cwd, root);
      inspected = true;
      return { status: 0 };
    };
    syncBuiltinESMExports();
    const run = supportAdmissionRun(
      (_command, _args, options) => {
        assert.equal(options.env.GH_TOKEN, undefined);
        assert.equal(options.env.SUPPORT_ARTIFACT_GITHUB_TOKEN, undefined);
        assert.equal(process.env.GH_TOKEN, undefined);
        installed = true;
        return { exitCode: 0 };
      },
      { githubToken: 'synthetic-coordinator-token' },
    );
    run('pnpm', ['install', '--frozen-lockfile'], {
      cwd: root,
      env: { TMPDIR: root },
    });
    assert(inspected);
    assert.equal(process.env.GH_TOKEN, undefined);
    assert.deepEqual(fs.readdirSync(root), [], 'Admission scratch must retire');
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    restoreEnvironment('GH_TOKEN', previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed authenticated admission preserves the failure and retires its scratch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-auth-failure-'));
  const original = childProcess.spawnSync;
  try {
    childProcess.spawnSync = () => ({ status: 1 });
    syncBuiltinESMExports();
    assert.throws(
      () =>
        verifyInstalledSupportWorkspace(
          root,
          { TMPDIR: root },
          { githubToken: 'synthetic-read-only-token' },
        ),
      /Installed support importer admission failed/u,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only the two ERP coordinator steps receive the dedicated read token', () => {
  const cases = [
    [
      '../../../.github/workflows/ultramodern-release-acceptance.yml',
      'Run exact-artifact ERP-10 acceptance',
    ],
    [
      '../../../.github/workflows/publish-bleedingdev.yml',
      'Run published ERP-10 acceptance',
    ],
  ];
  for (const [relative, expectedStep] of cases) {
    const workflow = parse(
      fs.readFileSync(new URL(relative, import.meta.url), 'utf8'),
    );
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
    const recipients = steps.filter(step =>
      Object.hasOwn(step.env ?? {}, 'SUPPORT_ARTIFACT_GITHUB_TOKEN'),
    );
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0].name, expectedStep);
    assert.match(
      recipients[0].env.SUPPORT_ARTIFACT_GITHUB_TOKEN,
      /^\$\{\{ github\.token \}\}$/u,
    );
  }
});
