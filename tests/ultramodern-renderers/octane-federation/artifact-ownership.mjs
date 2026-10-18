import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  maintenanceLockFailure,
  validateRunnerJobLease,
} from '../../../scripts/ultramodern-production-readiness/react-rsc-worker-proof/lifecycle.mjs';

/** Inner outputs borrow a hosted job or the current proof's physical local root.
 * released ends this operation's lease, not necessarily its guardian record:
 * guardianReleaseDeferred explicitly leaves registry reconciliation to the owner.
 */
export function createDevArtifactOwnership({
  workRoot,
  owner,
  ownerPid,
  guardianCommand,
  env = process.env,
  platform = process.platform,
  ownerSnapshotImpl,
  readGuardianRecord = directory => {
    const registry = path.join(
      os.homedir(),
      'Library/Application Support/DiskGuardian/artifacts.json',
    );
    return fs.existsSync(registry)
      ? JSON.parse(fs.readFileSync(registry, 'utf8'))[directory]
      : undefined;
  },
}) {
  const hosted =
    env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  const records = new Map();
  const root = fs.realpathSync(workRoot);
  assert.equal(root, path.resolve(workRoot), 'Dev proof root must be physical');
  const identity = directory => {
    const stat = fs.lstatSync(directory);
    assert(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'Dev artifact must be an ordinary directory',
    );
    return { device: stat.dev, inode: stat.ino, uid: stat.uid };
  };
  const rootIdentity = identity(root);
  const physicalArtifact = (directory, allowMissing = false) => {
    assert.deepEqual(
      identity(root),
      rootIdentity,
      'Dev proof root identity changed',
    );
    assert.equal(
      fs.realpathSync(root),
      root,
      'Dev proof root must stay physical',
    );
    const relative = path.relative(root, directory);
    assert(
      path.isAbsolute(directory) &&
        path.resolve(directory) === directory &&
        relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      'Dev artifact must belong to its proof root',
    );
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        identity(current);
      } catch (error) {
        if (allowMissing && error.code === 'ENOENT') return;
        throw error;
      }
    }
  };
  const verifyLocal = record => {
    physicalArtifact(record.directory);
    assert.deepEqual(
      identity(record.directory),
      record.identity,
      'Dev artifact identity changed',
    );
    assert.equal(
      ownerPid,
      process.pid,
      'Local artifact must belong to the current proof process',
    );
    process.kill(ownerPid, 0);
    if (process.getuid)
      assert.equal(
        record.identity.uid,
        process.getuid(),
        'Dev artifact owner UID changed',
      );
  };
  const verifyGuardianOwner = record => {
    verifyLocal(record);
    const registered = readGuardianRecord(record.directory);
    if (registered) {
      assert(
        !registered.released &&
          registered.owner === owner &&
          registered.owner_pid === ownerPid,
        'Dev artifact belongs to another guardian owner',
      );
      assert.deepEqual(
        registered.identity,
        [record.identity.device, record.identity.inode, record.identity.uid],
        'Guardian artifact identity changed',
      );
    } else
      assert(
        record.status !== 'registered',
        'Guardian artifact ownership disappeared',
      );
    return registered;
  };
  const busy = error =>
    error !== null &&
    typeof error === 'object' &&
    maintenanceLockFailure({
      status: error.status ?? error.code,
      signal: error.signal || (error.killed ? 'killed' : null),
      stdout: error.stdout,
      stderr: error.stderr,
    });
  const cleanupTimeout = error =>
    error !== null &&
    typeof error === 'object' &&
    error.killed === true &&
    error.code === null &&
    ['SIGTERM', 'SIGKILL'].includes(error.signal);

  const runnerLease = (directory, allowMissing = false) => {
    const relative = path.relative(workRoot, directory);
    assert(
      relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      'Dev artifact must belong to its proof root',
    );
    return validateRunnerJobLease(
      { workDir: directory, ownerPid },
      { env, platform, allowMissing, ownerSnapshotImpl },
    );
  };
  return {
    async register(directory, kind, signal) {
      signal?.throwIfAborted();
      const initialLease = hosted ? runnerLease(directory, true) : undefined;
      physicalArtifact(directory, true);
      const existing = records.get(directory);
      if (existing && !existing.released && existing.status !== 'pending') {
        assert.equal(existing.kind, kind, 'Dev artifact kind changed');
        if (hosted)
          assert.deepEqual(
            runnerLease(directory),
            existing.enclosingLease,
            'Runner artifact lease changed',
          );
        else verifyGuardianOwner(existing);
        assert.deepEqual(
          identity(directory),
          existing.identity,
          'Dev artifact identity changed',
        );
        return;
      }
      fs.mkdirSync(directory, { recursive: true });
      if (hosted) {
        const lease = runnerLease(directory);
        assert.deepEqual(lease, initialLease, 'Runner artifact lease changed');
        const stat = fs.lstatSync(directory);
        records.set(directory, {
          directory,
          kind,
          status: 'runner-job-lease',
          enclosingLease: lease,
          identity: { device: stat.dev, inode: stat.ino, uid: stat.uid },
          released: false,
        });
      } else {
        // An interrupted guardian invocation may already have registered it.
        const record = {
          directory,
          kind,
          status: 'pending',
          identity: identity(directory),
          owner,
          ownerPid,
          released: false,
        };
        records.set(directory, record);
        try {
          verifyGuardianOwner(record);
          await guardianCommand(
            [
              'register',
              directory,
              '--owner',
              owner,
              '--owner-pid',
              String(ownerPid),
              '--kind',
              kind,
              '--grace-hours',
              '24',
            ],
            signal,
          );
          record.status = 'registered';
        } catch (error) {
          if (!busy(error)) throw error;
          verifyGuardianOwner(record);
          record.status = 'operation-local-lease';
        }
      }
      signal?.throwIfAborted();
    },
    async release(directory) {
      const record = records.get(directory);
      assert(record && !record.released, 'Dev artifact has no active owner');
      if (record.status === 'runner-job-lease') {
        assert.deepEqual(
          runnerLease(directory),
          record.enclosingLease,
          'Runner artifact lease changed',
        );
        const stat = fs.lstatSync(directory);
        assert.deepEqual(
          { device: stat.dev, inode: stat.ino, uid: stat.uid },
          record.identity,
          'Runner artifact identity changed',
        );
      } else {
        verifyLocal(record);
        if (record.status === 'operation-local-lease') {
          if (verifyGuardianOwner(record))
            record.guardianReleaseDeferred = true;
          record.releaseMethod = 'operation-local';
        } else {
          try {
            await guardianCommand(['release', directory, '--owner', owner]);
            record.releaseMethod = 'guardian';
          } catch (error) {
            if (!busy(error) && !cleanupTimeout(error)) throw error;
            verifyGuardianOwner(record);
            record.releaseMethod = 'operation-local';
            record.guardianReleaseDeferred = true;
          }
        }
      }
      record.released = true;
    },
    get directories() {
      return [...records.keys()];
    },
    get size() {
      return records.size;
    },
    snapshot() {
      return [...records.values()];
    },
  };
}
