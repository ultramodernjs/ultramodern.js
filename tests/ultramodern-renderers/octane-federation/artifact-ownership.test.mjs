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

const busyGuardian = () =>
  Object.assign(new Error('guardian busy'), {
    code: 1,
    stdout: JSON.stringify({
      status: 'failed',
      reason: 'another maintenance operation holds the lock',
    }),
    stderr: '',
  });

function localFixture(t, extra = {}) {
  const item = fixture(t, { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: '' });
  return {
    ...item,
    artifacts: createDevArtifactOwnership({ ...item.options, ...extra }),
  };
}

function guardianIdentity(directory) {
  const stat = fs.statSync(directory);
  return {
    owner: 'mf-proof-test',
    owner_pid: process.pid,
    released: null,
    identity: [stat.dev, stat.ino, stat.uid],
  };
}

test('remote restart reuses the same owned output without redundant registration', async t => {
  const calls = [];
  const { artifacts, workRoot } = localFixture(t, {
    guardianCommand: async args => calls.push(args),
    readGuardianRecord: guardianIdentity,
  });
  const directory = path.join(workRoot, 'remote', 'dist');
  await artifacts.register(directory, 'build');
  await artifacts.register(directory, 'build');
  assert.equal(calls.length, 1);
  assert.equal(artifacts.size, 1);
  await artifacts.release(directory);
  assert.equal(calls.length, 2);
});

test('known maintenance contention uses a truthful local lease until outer cleanup', async t => {
  let calls = 0;
  const { artifacts, workRoot } = localFixture(t, {
    guardianCommand: async () => {
      calls++;
      throw busyGuardian();
    },
    readGuardianRecord: () => undefined,
  });
  const directory = path.join(workRoot, 'remote', 'dist');
  await artifacts.register(directory, 'build');
  await artifacts.register(directory, 'build');
  assert.equal(calls, 1);
  assert.equal(artifacts.snapshot()[0].status, 'operation-local-lease');
  await artifacts.release(directory);
  assert.equal(calls, 1);
  assert.equal(artifacts.snapshot()[0].releaseMethod, 'operation-local');
  assert.equal(artifacts.snapshot()[0].released, true);
  assert(
    fs.existsSync(directory),
    'Only the outer owner deletes the proof tree',
  );
});

test('cleanup contention or bounded timeout cannot mask completed proof with matching ownership', async t => {
  for (const failure of [
    busyGuardian(),
    Object.assign(new Error('timed out'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
    }),
  ]) {
    const { artifacts, workRoot } = localFixture(t, {
      guardianCommand: async args => {
        if (args[0] === 'release') throw failure;
      },
      readGuardianRecord: guardianIdentity,
    });
    const directory = path.join(workRoot, 'dist');
    await artifacts.register(directory, 'build');
    await artifacts.release(directory);
    const [record] = artifacts.snapshot();
    assert.equal(record.status, 'registered');
    assert.equal(record.releaseMethod, 'operation-local');
    assert.equal(record.guardianReleaseDeferred, true);
    assert.equal(record.released, true);
  }
});

test('restart and release reject an output replaced after registration', async t => {
  const { artifacts, workRoot } = localFixture(t, {
    guardianCommand: async () => {},
  });
  const directory = path.join(workRoot, 'dist');
  await artifacts.register(directory, 'build');
  fs.renameSync(directory, `${directory}.old`);
  fs.mkdirSync(directory);
  await assert.rejects(
    artifacts.register(directory, 'build'),
    /artifact identity changed/u,
  );
  await assert.rejects(
    artifacts.release(directory),
    /artifact identity changed/u,
  );
  assert.equal(artifacts.snapshot()[0].released, false);
});

test('local registration rejects path escape and intermediate symlink before creating output', async t => {
  const { artifacts, root, workRoot } = localFixture(t, {
    guardianCommand: async () => assert.fail('must not invoke guardian'),
  });
  await assert.rejects(
    artifacts.register(path.join(root, 'escape'), 'build'),
    /proof root/u,
  );
  const target = path.join(workRoot, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(workRoot, 'alias'));
  await assert.rejects(
    artifacts.register(path.join(workRoot, 'alias', 'dist'), 'build'),
    /ordinary directory/u,
  );
  assert(!fs.existsSync(path.join(target, 'dist')));
});

test('contention never borrows a different registry owner or replaced registry identity', async t => {
  for (const change of [
    record => ({ ...record, owner: 'another-session' }),
    record => ({ ...record, identity: [1, 2, 3] }),
  ]) {
    const { artifacts, workRoot } = localFixture(t, {
      guardianCommand: async () => {
        throw busyGuardian();
      },
      readGuardianRecord: directory => change(guardianIdentity(directory)),
    });
    await assert.rejects(
      artifacts.register(path.join(workRoot, 'dist'), 'build'),
      /guardian owner|Guardian artifact identity/u,
    );
    assert.equal(artifacts.snapshot()[0].status, 'pending');
  }
});

test('unexpected register errors and cleanup errors retain their failure', async t => {
  for (const failure of [
    Object.assign(new Error('not exact busy response'), {
      code: 1,
      stdout: 'another maintenance operation holds the lock',
      stderr: '',
    }),
    Object.assign(new Error('registration timed out'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
    }),
  ]) {
    const { artifacts, workRoot } = localFixture(t, {
      guardianCommand: async () => {
        throw failure;
      },
    });
    await assert.rejects(
      artifacts.register(path.join(workRoot, 'dist'), 'build'),
      error => error === failure,
    );
    assert.equal(artifacts.snapshot()[0].status, 'pending');
  }
  const unexpected = new Error('unexpected release failure');
  const { artifacts, workRoot } = localFixture(t, {
    guardianCommand: async args => {
      if (args[0] === 'release') throw unexpected;
    },
  });
  const directory = path.join(workRoot, 'dist');
  await artifacts.register(directory, 'build');
  await assert.rejects(
    artifacts.release(directory),
    error => error === unexpected,
  );
  assert.equal(artifacts.snapshot()[0].released, false);
});

test('cleanup contention rejects guardian takeover and retains the logical lease', async t => {
  let registered = false;
  const { artifacts, workRoot } = localFixture(t, {
    guardianCommand: async args => {
      if (args[0] === 'release') throw busyGuardian();
      registered = true;
    },
    readGuardianRecord: directory =>
      registered
        ? {
            ...guardianIdentity(directory),
            owner: 'other-session',
          }
        : undefined,
  });
  const directory = path.join(workRoot, 'dist');
  await artifacts.register(directory, 'build');
  await assert.rejects(artifacts.release(directory), /another guardian owner/u);
  assert.equal(artifacts.snapshot()[0].released, false);
  assert(fs.existsSync(directory));
});

test('local lease cannot survive replacement of its enclosing physical root', async t => {
  const { artifacts, workRoot } = localFixture(t, {
    guardianCommand: async () => {
      throw busyGuardian();
    },
    readGuardianRecord: () => undefined,
  });
  const directory = path.join(workRoot, 'dist');
  await artifacts.register(directory, 'build');
  fs.renameSync(workRoot, `${workRoot}.old`);
  fs.mkdirSync(workRoot);
  fs.mkdirSync(directory);
  await assert.rejects(
    artifacts.release(directory),
    /proof root identity changed/u,
  );
  assert.equal(artifacts.snapshot()[0].released, false);
});

test('duplicate same-inode registration refuses a foreign guardian takeover', async t => {
  let takeover = false;
  let calls = 0;
  const { artifacts, workRoot } = localFixture(t, {
    guardianCommand: async () => {
      calls++;
    },
    readGuardianRecord: directory => ({
      ...guardianIdentity(directory),
      owner: takeover ? 'foreign' : 'mf-proof-test',
    }),
  });
  const directory = path.join(workRoot, 'dist');
  await artifacts.register(directory, 'build');
  takeover = true;
  await assert.rejects(
    artifacts.register(directory, 'build'),
    /another guardian owner/u,
  );
  assert.equal(calls, 1, 'No ownership-overwriting registration is attempted');
  assert.equal(artifacts.snapshot()[0].released, false);
});

test('initial registration never overwrites foreign or released registry ownership', async t => {
  for (const change of [
    record => ({ ...record, owner: 'foreign' }),
    record => ({ ...record, released: Date.now(), identity: [1, 2, 3] }),
  ]) {
    let calls = 0;
    const { artifacts, workRoot } = localFixture(t, {
      guardianCommand: async () => {
        calls++;
      },
      readGuardianRecord: directory => change(guardianIdentity(directory)),
    });
    await assert.rejects(
      artifacts.register(path.join(workRoot, 'dist'), 'build'),
      /another guardian owner/u,
    );
    assert.equal(calls, 0);
  }
});

test('local lease exposes a matching guardian record as deferred at retirement', async t => {
  const { artifacts, workRoot } = localFixture(t, {
    guardianCommand: async () => {
      throw busyGuardian();
    },
    readGuardianRecord: guardianIdentity,
  });
  const directory = path.join(workRoot, 'dist');
  await artifacts.register(directory, 'build');
  await artifacts.release(directory);
  const [record] = artifacts.snapshot();
  assert.equal(record.status, 'operation-local-lease');
  assert.equal(record.guardianReleaseDeferred, true);
  assert.equal(record.releaseMethod, 'operation-local');
});
