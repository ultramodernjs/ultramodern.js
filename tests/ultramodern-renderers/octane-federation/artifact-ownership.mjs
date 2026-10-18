import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRunnerJobLease } from '../../../scripts/ultramodern-production-readiness/react-rsc-worker-proof/lifecycle.mjs';

/** Inner installs/builds borrow the authenticated hosted job; local runs use guardian. */
export function createDevArtifactOwnership({
  workRoot,
  owner,
  ownerPid,
  guardianCommand,
  env = process.env,
  platform = process.platform,
  ownerSnapshotImpl,
}) {
  const hosted =
    env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  const records = new Map();
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
        const record = { directory, kind, status: 'pending', released: false };
        records.set(directory, record);
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
      } else await guardianCommand(['release', directory, '--owner', owner]);
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
