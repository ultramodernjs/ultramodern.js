import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDevArtifactOwnership } from './artifact-ownership.mjs';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'mf-artifact-'),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = path.join(root, '_github_workflow');
  const workspace = path.join(root, 'workspace');
  const workRoot = path.join(root, 'proof');
  for (const directory of [workflow, workspace, workRoot])
    fs.mkdirSync(directory);
  const eventPath = path.join(workflow, 'event.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({ repository: { full_name: 'owner/repo', id: 1234 } }),
  );
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_REPOSITORY_ID: '1234',
    GITHUB_RUN_ID: '2345',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_JOB: 'native-renderer-features',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF:
      'owner/repo/.github/workflows/native.yml@refs/pull/1/merge',
    GITHUB_WORKSPACE: workspace,
    GITHUB_EVENT_PATH: eventPath,
    RUNNER_TEMP: root,
    ...overrides,
  };
  const options = {
    workRoot,
    owner: 'mf-proof-test',
    ownerPid: process.pid,
    env,
    platform: 'linux',
    ownerSnapshotImpl: pid => `${pid} ${process.getuid()} R\n`,
    guardianCommand: () =>
      assert.fail('A hosted job lease is not guardian registration'),
  };
  return {
    root,
    workRoot,
    env,
    options,
    artifacts: createDevArtifactOwnership(options),
  };
}

test('hosted artifacts use verified job provenance and release their actual identity', async t => {
  const { artifacts, workRoot } = fixture(t);
  const directory = path.join(workRoot, 'remote', 'node_modules');
  await artifacts.register(directory, 'dependencies');
  const [record] = artifacts.snapshot();
  assert.equal(artifacts.size, 1);
  assert.deepEqual(artifacts.directories, [directory]);
  assert.equal(record.status, 'runner-job-lease');
  assert.equal(record.enclosingLease.assurance, 'runner-environment-asserted');
  assert.equal(record.enclosingLease.attested, false);
  assert.equal(record.enclosingLease.runId, '2345');
  assert.equal(record.enclosingLease.cleanupOwner, 'github-hosted-runner');
  assert.equal(record.identity.inode, fs.statSync(directory).ino);
  assert.equal(record.released, false);
  await artifacts.release(directory);
  assert.equal(record.released, true);
  assert.ok(
    fs.statSync(directory).isDirectory(),
    'The outer proof owns tree deletion',
  );
  await assert.rejects(artifacts.release(directory), /no active owner/u);
});

test('incomplete or forged runner identity cannot create an artifact or bypass guardian', async t => {
  for (const [overrides, expected] of [
    [{ GITHUB_RUN_ID: '' }, /Invalid runner GITHUB_RUN_ID/u],
    [{ GITHUB_REPOSITORY_ID: '9999' }, /repository ID changed/u],
    [{ GITHUB_WORKFLOW_SHA: 'unknown' }, /Invalid runner GITHUB_WORKFLOW_SHA/u],
  ]) {
    const { artifacts, workRoot } = fixture(t, overrides);
    const directory = path.join(workRoot, 'dist');
    await assert.rejects(artifacts.register(directory, 'build'), expected);
    assert.equal(artifacts.size, 0);
    assert.ok(!fs.existsSync(directory));
  }
});

test('a hosted artifact must stay inside the physical proof tree', async t => {
  const { artifacts, root, workRoot } = fixture(t);
  await assert.rejects(
    artifacts.register(path.join(root, 'escape'), 'build'),
    /proof root/u,
  );
  const target = path.join(workRoot, 'target');
  fs.mkdirSync(target);
  const alias = path.join(workRoot, 'alias');
  fs.symlinkSync(target, alias);
  await assert.rejects(
    artifacts.register(path.join(alias, 'dist'), 'build'),
    /not ordinary|physical/u,
  );
  assert.equal(artifacts.size, 0);
  assert.ok(!fs.existsSync(path.join(target, 'dist')));
});

test('release rejects replaced artifacts and changed job ownership', async t => {
  const { artifacts, workRoot, env } = fixture(t);
  const directory = path.join(workRoot, 'dist');
  await artifacts.register(directory, 'build');
  fs.renameSync(directory, `${directory}.retained`);
  fs.mkdirSync(directory);
  await assert.rejects(
    artifacts.release(directory),
    /artifact identity changed/u,
  );
  assert.equal(artifacts.snapshot()[0].released, false);
  env.GITHUB_RUN_ID = '9999';
  await assert.rejects(artifacts.release(directory), /artifact lease changed/u);
});

test('local ownership still registers and releases with guardian', async t => {
  const { options, workRoot } = fixture(t, {
    GITHUB_ACTIONS: 'false',
    RUNNER_ENVIRONMENT: '',
  });
  const calls = [];
  const artifacts = createDevArtifactOwnership({
    ...options,
    guardianCommand: async args => calls.push(args),
  });
  const directory = path.join(workRoot, 'dist');
  await artifacts.register(directory, 'build');
  await artifacts.release(directory);
  assert.deepEqual(calls, [
    [
      'register',
      directory,
      '--owner',
      'mf-proof-test',
      '--owner-pid',
      String(process.pid),
      '--kind',
      'build',
      '--grace-hours',
      '24',
    ],
    ['release', directory, '--owner', 'mf-proof-test'],
  ]);
  assert.equal(artifacts.snapshot()[0].status, 'registered');
  assert.equal(artifacts.snapshot()[0].released, true);
});

test('missing guardian on local or self-hosted execution is a failure', async t => {
  for (const overrides of [
    { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: '' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
  ]) {
    const { options, workRoot } = fixture(t, overrides);
    const missing = Object.assign(new Error('guardian unavailable'), {
      code: 'ENOENT',
    });
    const artifacts = createDevArtifactOwnership({
      ...options,
      guardianCommand: async () => {
        throw missing;
      },
    });
    await assert.rejects(
      artifacts.register(path.join(workRoot, 'dist'), 'build'),
      error => error === missing,
    );
    assert.equal(artifacts.snapshot()[0].status, 'pending');
    assert.equal(artifacts.snapshot()[0].released, false);
  }
});
