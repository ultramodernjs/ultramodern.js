import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRunnerJobLease } from '../../../scripts/ultramodern-production-readiness/react-rsc-worker-proof/lifecycle.mjs';

export function usesHostedBrowserTemporary(
  env = process.env,
  platform = process.platform,
) {
  return (
    platform === 'linux' &&
    env.RUNNER_OS === 'Linux' &&
    env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted'
  );
}

export function assertBrowserSocketPath(
  directory,
  platform = process.platform,
) {
  const limit =
    platform === 'linux' ? 108 : platform === 'darwin' ? 104 : undefined;
  if (limit)
    assert(
      Buffer.byteLength(
        path.join(directory, 'org.chromium.Chromium.XXXXXX', 'SingletonSocket'),
      ) < limit,
      `Browser temporary directory exceeds the ${limit}-byte Unix socket budget`,
    );
}

/** Only browser children borrow this short, separately witnessed job directory. */
export function createBrowserTemporary(
  { workRoot, env = process.env, platform = process.platform },
  { validateJobLease = validateRunnerJobLease } = {},
) {
  const hosted =
    env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  const base = fs.realpathSync(hosted ? env.RUNNER_TEMP : workRoot);
  const directory = fs.mkdtempSync(path.join(base, 'b-'));
  const identity = fs.lstatSync(directory);
  let lease;
  try {
    assertBrowserSocketPath(directory, platform);
    if (hosted)
      lease = validateJobLease(
        { workDir: directory, ownerPid: process.pid },
        { env, platform },
      );
  } catch (error) {
    fs.rmSync(directory, { recursive: true });
    throw error;
  }
  return {
    directory,
    lease,
    env: { TMPDIR: directory, TMP: directory, TEMP: directory },
    cleanup() {
      const current = fs.lstatSync(directory);
      assert(
        current.isDirectory() && !current.isSymbolicLink(),
        'Browser temporary directory was replaced',
      );
      assert.equal(
        fs.realpathSync(directory),
        directory,
        'Browser temporary directory must remain physical',
      );
      assert.equal(
        current.dev,
        identity.dev,
        'Browser temporary device changed',
      );
      assert.equal(
        current.ino,
        identity.ino,
        'Browser temporary inode changed',
      );
      assert.equal(
        current.uid,
        identity.uid,
        'Browser temporary owner changed',
      );
      fs.rmSync(directory, { recursive: true });
    },
  };
}
