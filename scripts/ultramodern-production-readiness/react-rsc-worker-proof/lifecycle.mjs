import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const maintenanceLockReason = 'another maintenance operation holds the lock';
const markerName = '.disk-guardian-owner';

export function maintenanceLockFailure(error) {
  if (error.status !== 1 || error.signal || error.stderr?.toString().trim())
    return false;
  if (typeof error.stdout !== 'string' && !Buffer.isBuffer(error.stdout))
    return false;
  try {
    const result = JSON.parse(error.stdout.toString());
    return (
      result !== null &&
      !Array.isArray(result) &&
      result.status === 'failed' &&
      result.reason === maintenanceLockReason
    );
  } catch {
    return false;
  }
}

/** Retries only guardian lock contention; each command gets its remaining budget. */
export async function retryMaintenanceOperation(
  operation,
  {
    timeoutMs = 30_000,
    retryDelayMs = 250,
    now = () => performance.now(),
    sleep = setTimeout,
  } = {},
) {
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
  assert(Number.isFinite(retryDelayMs) && retryDelayMs > 0);
  const deadline = now() + timeoutMs;
  while (true) {
    try {
      return await operation(Math.max(1, Math.ceil(deadline - now())));
    } catch (error) {
      const lock =
        error !== null &&
        typeof error === 'object' &&
        maintenanceLockFailure({
          status: error.status ?? error.code,
          signal: error.signal || (error.killed ? 'killed' : null),
          stdout: error.stdout,
          stderr: error.stderr,
        });
      const remaining = deadline - now();
      if (!lock || remaining <= 0) throw error;
      await sleep(Math.min(retryDelayMs, remaining));
      if (now() >= deadline) throw error;
    }
  }
}

const ownerSnapshot = pid =>
  execFileSync(
    '/bin/ps',
    ['-p', String(pid), '-o', 'pid=', '-o', 'uid=', '-o', 'stat='],
    {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 5000,
    },
  );

function inspectOwnerProcess(pid, snapshotImpl) {
  process.kill(pid, 0);
  const output = snapshotImpl(pid);
  assert(
    typeof output === 'string' && output.endsWith('\n'),
    'Incomplete lease owner inspection',
  );
  const fields = output.trim().split(/\s+/u);
  assert.equal(fields.length, 3, 'Owned temporary lease owner is unavailable');
  assert.equal(fields[0], String(pid), 'Owned temporary lease owner changed');
  assert(/^-?(?:0|[1-9]\d*)$/u.test(fields[1]) && fields[1] !== '-0');
  const printedUid = Number(fields[1]);
  assert(
    Number.isSafeInteger(printedUid) &&
      printedUid >= -0x8000_0000 &&
      printedUid <= 0xffff_ffff,
  );
  // Darwin ps formats its unsigned uid_t as a signed integer.
  const uid = printedUid < 0 ? printedUid + 0x1_0000_0000 : printedUid;
  assert(
    /^[DHIRSTU][A-Za-z+<>-]*$/u.test(fields[2]),
    'Lease owner is not live',
  );
  return { uid };
}

function ordinaryOwnedDirectory(directory, uid) {
  const stat = fs.lstatSync(directory);
  assert(
    stat.isDirectory(),
    `Owned temporary path is not ordinary: ${directory}`,
  );
  assert.equal(
    stat.uid,
    uid,
    `Owned temporary path has a foreign owner: ${directory}`,
  );
  assert.equal(
    fs.realpathSync(directory),
    directory,
    'Owned temporary path must be physical',
  );
  return stat;
}

function runnerOwnedPath(root, target, uid, { allowMissing = false } = {}) {
  assert(path.isAbsolute(target) && path.resolve(target) === target);
  const relative = path.relative(root, target);
  assert(
    relative && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    'Runner proof resource must be a proper descendant of RUNNER_TEMP',
  );
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    const current = path.join(root, ...parts.slice(0, index + 1));
    try {
      ordinaryOwnedDirectory(current, uid);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

/** GitHub owns RUNNER_TEMP for this hosted job; this is not a guardian lease. */
export function validateRunnerJobLease(
  options,
  {
    env = process.env,
    platform = process.platform,
    allowMissing = false,
    ownerSnapshotImpl = ownerSnapshot,
  } = {},
) {
  assert.equal(platform, 'linux', 'Runner job leases require hosted Linux');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'A GitHub Actions job is required');
  assert.equal(
    env.RUNNER_ENVIRONMENT,
    'github-hosted',
    'Runner job leases require a GitHub-hosted job',
  );
  assert.equal(env.RUNNER_OS, 'Linux', 'Runner job OS must be Linux');
  assert.equal(
    env.GITHUB_SERVER_URL,
    'https://github.com',
    'Runner server must be GitHub',
  );
  for (const name of [
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_REPOSITORY_ID',
  ])
    assert(/^[1-9]\d*$/u.test(env[name] ?? ''), `Invalid runner ${name}`);
  assert(/^[A-Za-z0-9_-]+$/u.test(env.GITHUB_JOB ?? ''), 'Invalid runner job');
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY ?? ''),
    'Invalid runner repository',
  );
  for (const name of ['GITHUB_SHA', 'GITHUB_WORKFLOW_SHA'])
    assert(/^[a-f0-9]{40}$/u.test(env[name] ?? ''), `Invalid runner ${name}`);
  assert(
    env.GITHUB_WORKFLOW_REF?.startsWith(
      `${env.GITHUB_REPOSITORY}/.github/workflows/`,
    ) && /\.ya?ml@refs\/.+/u.test(env.GITHUB_WORKFLOW_REF),
    'Runner workflow must belong to its repository',
  );
  const uid = process.getuid();
  assert.equal(
    inspectOwnerProcess(options.ownerPid, ownerSnapshotImpl).uid,
    uid,
    'Runner proof requires a live same-UID owner',
  );
  const root = env.RUNNER_TEMP;
  assert(
    typeof root === 'string' &&
      path.isAbsolute(root) &&
      path.resolve(root) === root,
    'RUNNER_TEMP must be absolute and canonical',
  );
  const rootStat = ordinaryOwnedDirectory(root, uid);
  assert.equal(
    rootStat.mode & 0o022,
    0,
    'RUNNER_TEMP must not be externally writable',
  );
  assert(
    typeof env.GITHUB_WORKSPACE === 'string' &&
      path.isAbsolute(env.GITHUB_WORKSPACE) &&
      path.resolve(env.GITHUB_WORKSPACE) === env.GITHUB_WORKSPACE,
    'Runner workspace must be absolute and canonical',
  );
  ordinaryOwnedDirectory(env.GITHUB_WORKSPACE, uid);
  const eventPath = env.GITHUB_EVENT_PATH;
  assert(typeof eventPath === 'string' && path.isAbsolute(eventPath));
  runnerOwnedPath(root, path.dirname(eventPath), uid);
  assert.equal(
    fs.realpathSync(eventPath),
    eventPath,
    'Runner event must be physical',
  );
  const eventStat = fs.lstatSync(eventPath);
  assert(
    eventStat.isFile() && eventStat.uid === uid,
    'Runner event must be an owned file',
  );
  assert(eventStat.size <= 4 * 1024 * 1024, 'Runner event is too large');
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  assert.equal(
    event.repository?.full_name,
    env.GITHUB_REPOSITORY,
    'Runner event repository name changed',
  );
  assert.equal(
    String(event.repository?.id),
    env.GITHUB_REPOSITORY_ID,
    'Runner event repository ID changed',
  );
  runnerOwnedPath(root, options.workDir, uid, { allowMissing });
  const current = ordinaryOwnedDirectory(root, uid);
  assert.equal(current.dev, rootStat.dev, 'Runner temporary device changed');
  assert.equal(current.ino, rootStat.ino, 'Runner temporary directory changed');
  return {
    provider: 'github-actions',
    assurance: 'runner-environment-asserted',
    attested: false,
    lifecycle: 'hosted-job-temporary-directory',
    root,
    repository: env.GITHUB_REPOSITORY,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    job: env.GITHUB_JOB,
    sourceRevision: env.GITHUB_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowRevision: env.GITHUB_WORKFLOW_SHA,
    eventPath,
    rootIdentity: { device: rootStat.dev, inode: rootStat.ino, uid },
    cleanupOwner: 'github-hosted-runner',
  };
}

function enclosingLease(options, ownedTempDir, ownerSnapshotImpl) {
  const uid = process.getuid();
  assert(
    typeof ownedTempDir === 'string' && path.isAbsolute(ownedTempDir),
    'Registration deferral requires an absolute OWNED_TEMP_DIR',
  );
  const parent = path.resolve(ownedTempDir);
  assert.equal(parent, ownedTempDir, 'OWNED_TEMP_DIR must be canonical');
  assert(
    parent.startsWith('/private/tmp/') ||
      /^\/private\/var\/folders\/.+\/T\/.+/u.test(parent),
    'Registration deferral requires an owned temporary lease',
  );
  const parentStat = ordinaryOwnedDirectory(parent, uid);
  const relative = path.relative(parent, options.workDir);
  assert(
    relative && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    'Proof root must be a proper descendant of OWNED_TEMP_DIR',
  );
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1)
    ordinaryOwnedDirectory(
      path.join(parent, ...parts.slice(0, index + 1)),
      uid,
    );

  const marker = path.join(parent, markerName);
  const markerStat = fs.lstatSync(marker);
  assert(markerStat.isFile(), 'Owned temporary lease marker must be ordinary');
  assert.equal(
    markerStat.uid,
    uid,
    'Owned temporary lease marker has a foreign owner',
  );
  const fields = new Map();
  for (const line of fs.readFileSync(marker, 'utf8').trimEnd().split('\n')) {
    const separator = line.indexOf('=');
    assert(separator > 0, 'Invalid owned temporary lease marker');
    const key = line.slice(0, separator);
    assert(!fields.has(key), 'Duplicate owned temporary lease marker field');
    fields.set(key, line.slice(separator + 1));
  }
  assert.equal(fields.size, 5, 'Invalid owned temporary lease marker fields');
  assert.equal(fields.get('version'), '1', 'Unsupported owned temporary lease');
  assert.equal(
    fields.get('path'),
    parent,
    'Owned temporary lease path changed',
  );
  const positiveInteger = key => {
    const value = fields.get(key);
    assert(/^[1-9]\d*$/u.test(value), `Invalid lease ${key}`);
    const parsed = Number(value);
    assert(Number.isSafeInteger(parsed), `Invalid lease ${key}`);
    return parsed;
  };
  const leaseOwnerPid = positiveInteger('owner_pid');
  const created = positiveInteger('created_epoch');
  const expires = positiveInteger('expires_epoch');
  assert(
    created < expires && created <= Math.floor(Date.now() / 1000),
    'Invalid lease lifetime',
  );
  for (const pid of new Set([leaseOwnerPid, options.ownerPid]))
    assert.equal(
      inspectOwnerProcess(pid, ownerSnapshotImpl).uid,
      uid,
      'Owned temporary lease requires a live same-UID owner',
    );
  const current = ordinaryOwnedDirectory(parent, uid);
  assert.equal(
    current.dev,
    parentStat.dev,
    'Owned temporary lease device changed',
  );
  assert.equal(
    current.ino,
    parentStat.ino,
    'Owned temporary lease directory changed',
  );
  return { root: parent, ownerPid: leaseOwnerPid };
}

export function validateOwnedTempLease(options, ownedTempDir) {
  assert(Number.isSafeInteger(options.ownerPid) && options.ownerPid > 0);
  assert(path.isAbsolute(options.workDir));
  assert.equal(path.resolve(options.workDir), options.workDir);
  return enclosingLease(options, ownedTempDir, ownerSnapshot);
}

export function registerOwnedRoot(
  options,
  {
    registerImpl = execFileSync,
    ownedTempDir = process.env.OWNED_TEMP_DIR,
    ownerSnapshotImpl = ownerSnapshot,
    env = process.env,
    platform = process.platform,
  } = {},
) {
  assert(Number.isSafeInteger(options.ownerPid) && options.ownerPid > 0);
  process.kill(options.ownerPid, 0);
  assert(
    path.isAbsolute(options.workDir),
    'Proof work directory must be absolute',
  );
  assert.equal(
    path.resolve(options.workDir),
    options.workDir,
    'Proof work directory must be canonical',
  );
  const hostedJob =
    env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  const initialRunnerLease = hostedJob
    ? validateRunnerJobLease(options, {
        env,
        platform,
        allowMissing: true,
        ownerSnapshotImpl,
      })
    : undefined;
  const rootExisted = fs.existsSync(options.workDir);
  fs.mkdirSync(options.workDir, { recursive: true });
  const rootIdentity = fs.lstatSync(options.workDir);
  const marker = path.join(options.workDir, markerName);
  const markerExisted = fs.existsSync(marker);
  let markerIdentity;
  try {
    ordinaryOwnedDirectory(options.workDir, process.getuid());
    assert(
      fs.readdirSync(options.workDir).every(name => name === markerName),
      'Proof work directory must be new and empty; prior evidence is immutable',
    );
    if (markerExisted) {
      const existingMarker = fs.lstatSync(marker);
      assert(existingMarker.isFile(), 'Proof owner marker must be ordinary');
      assert.equal(
        existingMarker.uid,
        process.getuid(),
        'Proof owner marker has a foreign owner',
      );
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), options.owner);
    } else {
      fs.writeFileSync(marker, `${options.owner}\n`, { flag: 'wx' });
      markerIdentity = fs.lstatSync(marker);
    }
    if (hostedJob) {
      const lease = validateRunnerJobLease(options, {
        env,
        platform,
        ownerSnapshotImpl,
      });
      for (const key of ['device', 'inode'])
        assert.equal(
          lease.rootIdentity[key],
          initialRunnerLease.rootIdentity[key],
          `Runner temporary ${key} changed between validations`,
        );
      return {
        status: 'runner-job-lease',
        enclosingLease: lease,
      };
    }
    const isTemp =
      options.workDir.startsWith('/private/tmp/') ||
      options.workDir.startsWith('/private/var/folders/');
    try {
      registerImpl(
        'disk-guardian-artifacts',
        [
          'register',
          '--owner',
          options.owner,
          '--kind',
          isTemp ? 'temp' : 'build',
          '--owner-pid',
          String(options.ownerPid),
          options.workDir,
        ],
        { stdio: 'pipe' },
      );
      return { status: 'registered' };
    } catch (error) {
      if (!maintenanceLockFailure(error)) throw error;
      try {
        const lease = enclosingLease(options, ownedTempDir, ownerSnapshotImpl);
        return {
          status: 'deferred',
          reason: maintenanceLockReason,
          enclosingLease: lease,
        };
      } catch (ownershipError) {
        error.deferredOwnershipFailure = {
          name: ownershipError.name,
          message: ownershipError.message,
        };
        throw error;
      }
    }
  } catch (error) {
    for (const [target, identity, remove] of [
      ...(markerIdentity ? [[marker, markerIdentity, fs.unlinkSync]] : []),
      ...(!rootExisted ? [[options.workDir, rootIdentity, fs.rmdirSync]] : []),
    ]) {
      try {
        const current = fs.lstatSync(target);
        assert(
          ['dev', 'ino', 'uid', 'mode'].every(
            key => current[key] === identity[key],
          ),
          `Created proof resource identity changed: ${target}`,
        );
        remove(target);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          error.cleanupErrors ??= [];
          error.cleanupErrors.push({
            path: target,
            message: cleanupError.message,
          });
        }
      }
    }
    throw error;
  }
}
