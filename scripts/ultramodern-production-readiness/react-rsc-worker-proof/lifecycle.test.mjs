import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  registerOwnedRoot as registerRoot,
  retryMaintenanceOperation,
  validateRunnerJobLease,
} from './lifecycle.mjs';

const registerOwnedRoot = (proof, configuration) =>
  registerRoot(proof, { env: {}, ...configuration });

const markerName = '.disk-guardian-owner';
const lockReason = 'another maintenance operation holds the lock';

function ownedDirectory(t) {
  const parent = process.env.ULTRAMODERN_RSC_WORKER_PROOF_TEST_ROOT;
  assert(
    parent && path.isAbsolute(parent),
    'Set ULTRAMODERN_RSC_WORKER_PROOF_TEST_ROOT to an owned, registered test parent',
  );
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(parent), 'rsc-lifecycle-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function lease(t, overrides = {}) {
  const root = ownedDirectory(t);
  const now = Math.floor(Date.now() / 1000);
  const fields = {
    version: '1',
    path: root,
    owner_pid: process.pid,
    created_epoch: now - 1,
    expires_epoch: now + 3600,
    ...overrides,
  };
  const marker = path.join(root, markerName);
  fs.writeFileSync(
    marker,
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  return { root, marker, fields };
}

function options(root, overrides = {}) {
  return {
    workDir: path.join(root, 'react-rsc'),
    owner: 'rsc-lifecycle-test',
    ownerPid: process.pid,
    ...overrides,
  };
}

function registrationFailure(overrides = {}) {
  return Object.assign(new Error('Guardian registration failed'), {
    status: 1,
    signal: null,
    stdout: Buffer.from(
      JSON.stringify({ time: 1, status: 'failed', reason: lockReason }),
    ),
    stderr: Buffer.alloc(0),
    ...overrides,
  });
}

function failedRegistration(error) {
  return () => {
    throw error;
  };
}

function runnerJob(t) {
  const root = ownedDirectory(t);
  fs.chmodSync(root, 0o700);
  const workflow = path.join(root, '_github_workflow');
  fs.mkdirSync(workflow);
  const eventPath = path.join(workflow, 'event.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({ repository: { full_name: 'owner/repo', id: 1234 } }),
  );
  const workspace = ownedDirectory(t);
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_REPOSITORY_ID: '1234',
    GITHUB_RUN_ID: '2345',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_JOB: 'installed-renderer-features',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF:
      'owner/repo/.github/workflows/native.yml@refs/pull/1/merge',
    GITHUB_WORKSPACE: workspace,
    GITHUB_EVENT_PATH: eventPath,
    RUNNER_TEMP: root,
  };
  return {
    root,
    env,
    proof: options(root),
    configuration: {
      env,
      platform: 'linux',
      registerImpl: () =>
        assert.fail('A runner job lease is not guardian registration'),
    },
  };
}

test('hosted runner owns only its job temporary descendant and records cleanup provenance', t => {
  const job = runnerJob(t);
  const result = registerOwnedRoot(job.proof, job.configuration);
  assert.equal(result.status, 'runner-job-lease');
  assert.equal(result.enclosingLease.provider, 'github-actions');
  assert.equal(result.enclosingLease.assurance, 'runner-environment-asserted');
  assert.equal(result.enclosingLease.attested, false);
  assert.equal(result.enclosingLease.runId, '2345');
  assert.equal(result.enclosingLease.runAttempt, '2');
  assert.equal(result.enclosingLease.job, job.env.GITHUB_JOB);
  assert.equal(result.enclosingLease.repositoryId, '1234');
  assert.equal(result.enclosingLease.sourceRevision, 'a'.repeat(40));
  assert.equal(result.enclosingLease.workflowRevision, 'b'.repeat(40));
  assert.equal(result.enclosingLease.cleanupOwner, 'github-hosted-runner');
  assert.equal(
    result.enclosingLease.rootIdentity.inode,
    fs.statSync(job.root).ino,
  );
  assert.equal(
    fs.readFileSync(path.join(job.proof.workDir, markerName), 'utf8'),
    `${job.proof.owner}\n`,
  );
  assert.deepEqual(registerOwnedRoot(job.proof, job.configuration), result);
});

test('runner lease rejects incomplete or mismatched job identity before creating a proof', t => {
  for (const [override, expected] of [
    [{ GITHUB_RUN_ID: '' }, /Invalid runner GITHUB_RUN_ID/u],
    [{ GITHUB_RUN_ATTEMPT: '0' }, /Invalid runner GITHUB_RUN_ATTEMPT/u],
    [{ GITHUB_JOB: 'bad/job' }, /Invalid runner job/u],
    [{ GITHUB_REPOSITORY_ID: '9999' }, /Runner event repository ID changed/u],
    [
      { GITHUB_REPOSITORY: 'foreign/repo' },
      /Runner workflow must belong to its repository/u,
    ],
    [{ GITHUB_SHA: 'unknown' }, /Invalid runner GITHUB_SHA/u],
    [{ GITHUB_WORKFLOW_SHA: '' }, /Invalid runner GITHUB_WORKFLOW_SHA/u],
    [
      {
        GITHUB_WORKFLOW_REF:
          'foreign/repo/.github/workflows/native.yml@refs/heads/main',
      },
      /Runner workflow must belong to its repository/u,
    ],
    [{ RUNNER_OS: 'macOS' }, /Runner job OS must be Linux/u],
    [
      { GITHUB_SERVER_URL: 'https://untrusted.invalid' },
      /Runner server must be GitHub/u,
    ],
  ]) {
    const job = runnerJob(t);
    Object.assign(job.env, override);
    assert.throws(
      () => registerOwnedRoot(job.proof, job.configuration),
      expected,
    );
    assert(!fs.existsSync(job.proof.workDir));
  }
});

test('runner lease cannot replace local or self-hosted artifact ownership', t => {
  const job = runnerJob(t);
  for (const [override, expected] of [
    [{ GITHUB_ACTIONS: 'false' }, /A GitHub Actions job is required/u],
    [
      { RUNNER_ENVIRONMENT: 'self-hosted' },
      /Runner job leases require a GitHub-hosted job/u,
    ],
  ]) {
    assert.throws(
      () =>
        validateRunnerJobLease(job.proof, {
          env: { ...job.env, ...override },
          platform: 'linux',
          allowMissing: true,
        }),
      expected,
    );
  }
  assert.throws(
    () =>
      registerOwnedRoot(job.proof, {
        ...job.configuration,
        platform: 'darwin',
      }),
    /hosted Linux/u,
  );
  assert(!fs.existsSync(job.proof.workDir));
});

test('runner lease rejects escaping roots and symlinked parent, event, and workspace paths', t => {
  const job = runnerJob(t);
  const outside = ownedDirectory(t);
  for (const workDir of [job.root, outside, path.join(outside, 'escape')]) {
    assert.throws(
      () => registerOwnedRoot({ ...job.proof, workDir }, job.configuration),
      /proper descendant of RUNNER_TEMP/u,
    );
  }
  const link = path.join(job.root, 'link');
  fs.symlinkSync(outside, link);
  assert.throws(
    () =>
      registerOwnedRoot(
        { ...job.proof, workDir: path.join(link, 'proof') },
        job.configuration,
      ),
    /Owned temporary path is not ordinary/u,
  );
  assert(!fs.existsSync(path.join(outside, 'proof')));
  const eventLink = path.join(job.root, '_github_workflow', 'event-link.json');
  fs.symlinkSync(job.env.GITHUB_EVENT_PATH, eventLink);
  assert.throws(
    () =>
      registerOwnedRoot(job.proof, {
        ...job.configuration,
        env: { ...job.env, GITHUB_EVENT_PATH: eventLink },
      }),
    /Runner event must be physical/u,
  );
  assert.throws(
    () =>
      registerOwnedRoot(job.proof, {
        ...job.configuration,
        env: { ...job.env, GITHUB_WORKSPACE: link },
      }),
    /Owned temporary path is not ordinary/u,
  );
  assert(!fs.existsSync(job.proof.workDir));
});

test('runner event repository binding is checked independently from workflow identity', t => {
  const job = runnerJob(t);
  fs.writeFileSync(
    job.env.GITHUB_EVENT_PATH,
    JSON.stringify({
      repository: { full_name: 'foreign/repo', id: 1234 },
    }),
  );
  assert.throws(
    () => registerOwnedRoot(job.proof, job.configuration),
    /Runner event repository name changed/u,
  );
  assert(!fs.existsSync(job.proof.workDir));
});

test('runner event cannot come from outside its leased temporary directory', t => {
  const job = runnerJob(t);
  const outside = ownedDirectory(t);
  const eventPath = path.join(outside, 'event.json');
  fs.copyFileSync(job.env.GITHUB_EVENT_PATH, eventPath);
  assert.throws(
    () =>
      registerOwnedRoot(job.proof, {
        ...job.configuration,
        env: { ...job.env, GITHUB_EVENT_PATH: eventPath },
      }),
    /proper descendant of RUNNER_TEMP/u,
  );
  assert(!fs.existsSync(job.proof.workDir));
});

for (const [statKey, identityKey] of [
  ['dev', 'device'],
  ['ino', 'inode'],
]) {
  test(`runner root ${identityKey} cannot change between registration validations`, t => {
    const job = runnerJob(t);
    const original = fs.lstatSync;
    let inspections = 0;
    t.mock.method(fs, 'lstatSync', target => {
      const stat = original(target);
      if (target !== job.root || ++inspections <= 2) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        [statKey]: stat[statKey] + 1,
      });
    });
    assert.throws(
      () => registerOwnedRoot(job.proof, job.configuration),
      new RegExp(
        `Runner temporary ${identityKey} changed between validations`,
        'u',
      ),
    );
    assert(!fs.existsSync(job.proof.workDir));
  });
}

test('runner lease uses the injected owner snapshot while enforcing same-UID ownership', t => {
  const job = runnerJob(t);
  const inspected = [];
  registerOwnedRoot(job.proof, {
    ...job.configuration,
    ownerSnapshotImpl: pid => {
      inspected.push(pid);
      return `${pid} ${process.getuid()} S\n`;
    },
  });
  assert.deepEqual(inspected, [process.pid, process.pid]);
  assert.throws(
    () =>
      registerOwnedRoot(job.proof, {
        ...job.configuration,
        ownerSnapshotImpl: pid => `${pid} ${process.getuid() + 1} S\n`,
      }),
    /Runner proof requires a live same-UID owner/u,
  );
});

test('runner lease rejects writable temporary roots and preserves existing evidence', t => {
  const job = runnerJob(t);
  fs.chmodSync(job.root, 0o777);
  assert.throws(
    () => registerOwnedRoot(job.proof, job.configuration),
    /externally writable/u,
  );
  fs.chmodSync(job.root, 0o700);
  registerOwnedRoot(job.proof, job.configuration);
  const evidence = path.join(job.proof.workDir, 'receipt.json');
  fs.writeFileSync(evidence, 'immutable evidence');
  assert.throws(
    () => registerOwnedRoot(job.proof, job.configuration),
    /prior evidence is immutable/u,
  );
  assert.equal(fs.readFileSync(evidence, 'utf8'), 'immutable evidence');
});

test('maintenance retry accepts only the exact async guardian lock failure', async () => {
  let clock = 0;
  const attempts = [];
  const lock = registrationFailure({ status: undefined, code: 1 });
  const result = await retryMaintenanceOperation(
    async remaining => {
      attempts.push(remaining);
      if (attempts.length === 1) throw lock;
      return 'registered';
    },
    {
      timeoutMs: 100,
      retryDelayMs: 25,
      now: () => clock,
      sleep: async duration => {
        clock += duration;
      },
    },
  );
  assert.equal(result, 'registered');
  assert.deepEqual(attempts, [100, 75]);
});

test('maintenance retry handles real async command errors and retains exact arguments', async () => {
  const execute = promisify(execFile);
  const args = ['release', '/private/tmp/owned-only', '--owner', 'proof-owner'];
  let attempts = 0;
  const result = await retryMaintenanceOperation(
    timeout =>
      execute(
        process.execPath,
        [
          '-e',
          ++attempts === 1
            ? `process.stdout.write(${JSON.stringify(JSON.stringify({ status: 'failed', reason: lockReason }))}); process.exit(1);`
            : 'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
          '--',
          ...args,
        ],
        { timeout },
      ),
    { retryDelayMs: 1 },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('maintenance retry keeps the original lock error when its total deadline expires', async () => {
  let clock = 0;
  const attempts = [];
  const lock = registrationFailure({ status: undefined, code: 1 });
  await assert.rejects(
    retryMaintenanceOperation(
      async remaining => {
        attempts.push(remaining);
        throw lock;
      },
      {
        timeoutMs: 60,
        retryDelayMs: 25,
        now: () => clock,
        sleep: async duration => {
          clock += duration;
        },
      },
    ),
    error => error === lock,
  );
  assert.deepEqual(attempts, [60, 35, 10]);
  assert.equal(clock, 60);
});

test('maintenance retry includes command execution in its total deadline', async () => {
  let clock = 0;
  const lock = registrationFailure({ status: undefined, code: 1 });
  let attempts = 0;
  await assert.rejects(
    retryMaintenanceOperation(
      async remaining => {
        attempts++;
        assert.equal(remaining, 50);
        clock += 50;
        throw lock;
      },
      {
        timeoutMs: 50,
        now: () => clock,
        sleep: () => assert.fail('An exhausted deadline must not wait'),
      },
    ),
    error => error === lock,
  );
  assert.equal(attempts, 1);
});

test('maintenance retry immediately preserves every nonexact failure', async () => {
  for (const error of [
    registrationFailure({ status: undefined, code: 'ENOENT' }),
    registrationFailure({ status: undefined, code: 2 }),
    registrationFailure({ status: 2, code: 1 }),
    registrationFailure({ signal: 'SIGTERM' }),
    registrationFailure({ killed: true }),
    registrationFailure({ status: undefined, code: 'ABORT_ERR' }),
    registrationFailure({ stderr: 'additional failure' }),
    registrationFailure({ stdout: 'malformed lock response' }),
    registrationFailure({
      stdout: JSON.stringify({
        status: 'failed',
        reason: 'owner or identity mismatch',
      }),
    }),
    registrationFailure({
      stdout: `${registrationFailure().stdout}\n${registrationFailure().stdout}`,
    }),
    new Error('Acceptance assertion failed'),
    null,
  ]) {
    let attempts = 0;
    await assert.rejects(
      retryMaintenanceOperation(
        async () => {
          attempts++;
          throw error;
        },
        { sleep: () => assert.fail('Nonexact failures must not wait') },
      ),
      observed => observed === error,
    );
    assert.equal(attempts, 1);
  }
});

function assertRejectedWithoutResidue(proofOptions, configuration, expected) {
  assert.throws(
    () => registerOwnedRoot(proofOptions, configuration),
    error => error === expected,
  );
  assert(
    !fs.existsSync(proofOptions.workDir),
    'Rejected new proof root must be removed',
  );
}

test('normal guardian registration does not require or inspect an enclosing lease', t => {
  const root = ownedDirectory(t);
  const proof = options(root);
  let calls = 0;
  const result = registerOwnedRoot(proof, {
    ownedTempDir: undefined,
    ownerSnapshotImpl: () => assert.fail('Normal registration does not defer'),
    registerImpl: (command, args, configuration) => {
      calls += 1;
      assert.equal(command, 'disk-guardian-artifacts');
      assert.deepEqual(args, [
        'register',
        '--owner',
        proof.owner,
        '--kind',
        'temp',
        '--owner-pid',
        String(process.pid),
        proof.workDir,
      ]);
      assert.deepEqual(configuration, { stdio: 'pipe' });
      return Buffer.from('{"status":"registered"}\n');
    },
  });
  assert.deepEqual(result, { status: 'registered' });
  assert.equal(calls, 1);
  assert.equal(
    fs.readFileSync(path.join(proof.workDir, markerName), 'utf8'),
    `${proof.owner}\n`,
  );
});

test('exact maintenance-lock failure defers to the enclosing live physical lease', t => {
  const parent = lease(t, { owner_pid: process.ppid });
  const originalMarker = fs.readFileSync(parent.marker);
  const proof = options(parent.root);
  const error = registrationFailure();
  const configuration = {
    ownedTempDir: parent.root,
    registerImpl: failedRegistration(error),
  };
  const expected = {
    status: 'deferred',
    reason: lockReason,
    enclosingLease: { root: parent.root, ownerPid: process.ppid },
  };
  assert.deepEqual(registerOwnedRoot(proof, configuration), expected);
  assert.deepEqual(
    registerOwnedRoot(proof, configuration),
    expected,
    'Marker-only re-entry is idempotent',
  );
  assert.deepEqual(fs.readFileSync(parent.marker), originalMarker);
  assert.equal(
    fs.readFileSync(path.join(proof.workDir, markerName), 'utf8'),
    `${proof.owner}\n`,
  );
});

test('an expired lease remains owned while its owner is live', t => {
  const now = Math.floor(Date.now() / 1000);
  const parent = lease(t, { created_epoch: now - 100, expires_epoch: now - 1 });
  assert.equal(
    registerOwnedRoot(options(parent.root), {
      ownedTempDir: parent.root,
      registerImpl: failedRegistration(registrationFailure()),
    }).status,
    'deferred',
  );
});

for (const [name, overrides] of [
  [
    'another failure reason',
    {
      stdout: JSON.stringify({
        status: 'failed',
        reason: 'not an owned directory',
      }),
    },
  ],
  [
    'another failure status',
    { stdout: JSON.stringify({ status: 'registered', reason: lockReason }) },
  ],
  ['malformed stdout', { stdout: '{' }],
  [
    'multiple stdout records',
    {
      stdout: `${JSON.stringify({ status: 'failed', reason: lockReason })}\n{}`,
    },
  ],
  ['text in stdout', { stdout: lockReason }],
  ['lock text only in stderr', { stdout: '', stderr: lockReason }],
  ['additional stderr', { stderr: 'another failure' }],
  ['another exit status', { status: 2 }],
  ['signal termination', { status: null, signal: 'SIGTERM' }],
  ['spawn failure', { status: null, code: 'ENOENT', stdout: undefined }],
]) {
  test(`${name} preserves the original registration failure and rolls back new resources`, t => {
    const parent = lease(t);
    const error = registrationFailure(overrides);
    assertRejectedWithoutResidue(
      options(parent.root),
      {
        ownedTempDir: parent.root,
        registerImpl: failedRegistration(error),
        ownerSnapshotImpl: () =>
          assert.fail('Other guardian failures cannot inspect a fallback'),
      },
      error,
    );
    assert(fs.existsSync(parent.marker));
  });
}

for (const [name, parentValue] of [
  ['absent', () => undefined],
  ['relative', () => 'relative'],
  ['noncanonical', parent => `${parent.root}/.`],
  ['equal to the proof root', (_parent, proof) => proof.workDir],
  ['missing', parent => path.join(parent.root, 'missing')],
  ['sibling', parent => `${parent.root}-sibling`],
]) {
  test(`${name} OWNED_TEMP_DIR cannot defer registration`, t => {
    const parent = lease(t);
    const proof = options(parent.root);
    const error = registrationFailure();
    assertRejectedWithoutResidue(
      proof,
      {
        ownedTempDir: parentValue(parent, proof),
        registerImpl: failedRegistration(error),
      },
      error,
    );
    assert(error.deferredOwnershipFailure);
    assert(fs.existsSync(parent.marker));
  });
}

for (const [name, markerFields] of [
  ['unknown version', { version: 2 }],
  ['another path', { path: '/private/tmp/another-lease' }],
  ['missing owner', { owner_pid: '' }],
  ['invalid owner', { owner_pid: -1 }],
  ['invalid creation', { created_epoch: 'bad' }],
  ['invalid expiry', { expires_epoch: 1 }],
  ['future creation', { created_epoch: Math.floor(Date.now() / 1000) + 7200 }],
]) {
  test(`${name} enclosing marker cannot defer registration`, t => {
    const parent = lease(t, markerFields);
    const markerBefore = fs.readFileSync(parent.marker);
    const error = registrationFailure();
    assertRejectedWithoutResidue(
      options(parent.root),
      { ownedTempDir: parent.root, registerImpl: failedRegistration(error) },
      error,
    );
    assert(error.deferredOwnershipFailure);
    assert.deepEqual(fs.readFileSync(parent.marker), markerBefore);
  });
}

test('missing and symlink enclosing markers cannot defer registration', t => {
  for (const symlink of [false, true]) {
    const parent = lease(t);
    const markerCopy = path.join(parent.root, 'marker-copy');
    fs.renameSync(parent.marker, markerCopy);
    if (symlink) fs.symlinkSync(markerCopy, parent.marker);
    const error = registrationFailure();
    assertRejectedWithoutResidue(
      options(parent.root),
      { ownedTempDir: parent.root, registerImpl: failedRegistration(error) },
      error,
    );
    assert(fs.existsSync(markerCopy));
  }
});

test('symlink enclosing paths and intermediate paths cannot authorize deferral', t => {
  const parent = lease(t);
  const sibling = ownedDirectory(t);
  const link = path.join(sibling, 'enclosing-link');
  fs.symlinkSync(parent.root, link);
  const error = registrationFailure();
  assertRejectedWithoutResidue(
    options(parent.root),
    { ownedTempDir: link, registerImpl: failedRegistration(error) },
    error,
  );
  const intermediate = path.join(parent.root, 'nested');
  fs.symlinkSync(sibling, intermediate);
  const throughLink = options(parent.root, {
    workDir: path.join(intermediate, 'react-rsc'),
  });
  assert.throws(
    () =>
      registerOwnedRoot(throughLink, {
        ownedTempDir: parent.root,
        registerImpl: () =>
          assert.fail('Nonphysical proof root cannot register'),
      }),
    /physical/u,
  );
  assert(!fs.existsSync(path.join(sibling, 'react-rsc')));
  assert(fs.lstatSync(intermediate).isSymbolicLink());
});

test('foreign and uninspectable live owners cannot defer registration', t => {
  for (const ownerSnapshotImpl of [
    pid => `${pid} ${process.getuid() + 1} S\n`,
    pid => `${pid} ${process.getuid()} Z\n`,
    pid => `${pid} ${process.getuid()} ?\n`,
    pid => `${pid} ${process.getuid()} S`,
    () => {
      throw new Error('Process ownership unavailable');
    },
  ]) {
    const parent = lease(t);
    const error = registrationFailure();
    assertRejectedWithoutResidue(
      options(parent.root),
      {
        ownedTempDir: parent.root,
        registerImpl: failedRegistration(error),
        ownerSnapshotImpl,
      },
      error,
    );
    assert(error.deferredOwnershipFailure);
  }
});

test('the supplied owner is inspected independently from the enclosing lease owner', t => {
  const parent = lease(t, { owner_pid: process.ppid });
  const error = registrationFailure();
  const inspected = [];
  assertRejectedWithoutResidue(
    options(parent.root),
    {
      ownedTempDir: parent.root,
      registerImpl: failedRegistration(error),
      ownerSnapshotImpl: pid => {
        inspected.push(pid);
        return `${pid} ${process.getuid() + (pid === process.pid ? 1 : 0)} S\n`;
      },
    },
    error,
  );
  assert.deepEqual(inspected, [process.ppid, process.pid]);
});

for (const targetName of ['root', 'marker']) {
  test(`a foreign-UID enclosing ${targetName} cannot defer registration`, t => {
    const parent = lease(t);
    const error = registrationFailure();
    const original = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', target => {
      const stat = original(target);
      if (target !== parent[targetName]) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        uid: process.getuid() + 1,
      });
    });
    assertRejectedWithoutResidue(
      options(parent.root),
      { ownedTempDir: parent.root, registerImpl: failedRegistration(error) },
      error,
    );
    assert(error.deferredOwnershipFailure);
  });
}

test('a dead enclosing lease owner cannot defer registration', t => {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
  assert.equal(child.status, 0);
  const parent = lease(t, { owner_pid: child.pid });
  const error = registrationFailure();
  assertRejectedWithoutResidue(
    options(parent.root),
    { ownedTempDir: parent.root, registerImpl: failedRegistration(error) },
    error,
  );
  assert(error.deferredOwnershipFailure);
});

test('a dead supplied owner fails before creating proof resources', t => {
  const parent = lease(t);
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
  assert.equal(child.status, 0);
  const proof = options(parent.root, { ownerPid: child.pid });
  assert.throws(
    () =>
      registerOwnedRoot(proof, {
        registerImpl: () => assert.fail('A dead owner cannot register'),
      }),
    { code: 'ESRCH' },
  );
  assert(!fs.existsSync(proof.workDir));
});

test('rejected registration preserves existing proof roots, markers and evidence', t => {
  const parent = lease(t);
  const proof = options(parent.root);
  fs.mkdirSync(proof.workDir);
  const proofMarker = path.join(proof.workDir, markerName);
  fs.writeFileSync(proofMarker, `${proof.owner}\n`);
  const error = registrationFailure({ status: 2 });
  assert.throws(
    () => registerOwnedRoot(proof, { registerImpl: failedRegistration(error) }),
    rejected => rejected === error,
  );
  assert.equal(fs.readFileSync(proofMarker, 'utf8'), `${proof.owner}\n`);
  fs.writeFileSync(path.join(proof.workDir, 'receipt.json'), '{}');
  assert.throws(
    () =>
      registerOwnedRoot(proof, {
        registerImpl: () => assert.fail('Prior evidence cannot register'),
      }),
    /prior evidence is immutable/u,
  );
  assert.equal(
    fs.readFileSync(path.join(proof.workDir, 'receipt.json'), 'utf8'),
    '{}',
  );
  fs.unlinkSync(path.join(proof.workDir, 'receipt.json'));
  fs.writeFileSync(proofMarker, 'another-owner\n');
  assert.throws(
    () =>
      registerOwnedRoot(proof, {
        registerImpl: () => assert.fail('A foreign marker cannot register'),
      }),
    { name: 'AssertionError' },
  );
  assert.equal(fs.readFileSync(proofMarker, 'utf8'), 'another-owner\n');
});

test('rollback preserves the primary registration error when a created root gains data', t => {
  const parent = lease(t);
  const proof = options(parent.root);
  const error = registrationFailure({ status: 2 });
  assert.throws(
    () =>
      registerOwnedRoot(proof, {
        registerImpl: () => {
          fs.writeFileSync(
            path.join(proof.workDir, 'retained-evidence'),
            'retain',
          );
          throw error;
        },
      }),
    rejected => rejected === error,
  );
  assert(!fs.existsSync(path.join(proof.workDir, markerName)));
  assert.equal(
    fs.readFileSync(path.join(proof.workDir, 'retained-evidence'), 'utf8'),
    'retain',
  );
  assert.equal(error.cleanupErrors.length, 1);
  assert.equal(error.cleanupErrors[0].path, proof.workDir);
});
