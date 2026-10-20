import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertBrowserSocketPath,
  createBrowserTemporary,
  usesHostedBrowserTemporary,
} from './browser-temporary.mjs';

for (const [platform, limit] of [
  ['linux', 108],
  ['darwin', 104],
])
  test(`${platform} checks the complete Chromium socket path in bytes including its terminator`, () => {
    const suffix = '/org.chromium.Chromium.XXXXXX/SingletonSocket';
    assertBrowserSocketPath(
      `/${'a'.repeat(limit - Buffer.byteLength(suffix) - 2)}`,
      platform,
    );
    assert.throws(
      () =>
        assertBrowserSocketPath(
          `/${'a'.repeat(limit - Buffer.byteLength(suffix) - 1)}`,
          platform,
        ),
      /socket budget/u,
    );
    assert.throws(
      () => assertBrowserSocketPath(`/${'é'.repeat(40)}`, platform),
      /socket budget/u,
    );
    assertBrowserSocketPath('/home/runner/work/_temp/b-ABCDEF', platform);
    assert.throws(
      () =>
        assertBrowserSocketPath(
          '/home/runner/work/_temp/renderer-features-sHt1aV/feature-dev-refresh',
          platform,
        ),
      /socket budget/u,
    );
  });

function root(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'bt-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('hosted browser temp is a fresh direct job child with validated lease and isolated child environment', t => {
  const workRoot = root(t);
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_TEMP: workRoot,
    TMPDIR: '/unrelated',
  };
  let validation;
  const temporary = createBrowserTemporary(
    { workRoot: '/long/feature/root', env, platform: 'win32' },
    {
      validateJobLease(options, context) {
        validation = { options, context };
        return { provider: 'github-actions' };
      },
    },
  );
  assert.equal(path.dirname(temporary.directory), workRoot);
  assert.equal(validation.options.workDir, temporary.directory);
  assert.equal(validation.options.ownerPid, process.pid);
  assert.equal(validation.context.env, env);
  assert.deepEqual(temporary.env, {
    TMPDIR: temporary.directory,
    TMP: temporary.directory,
    TEMP: temporary.directory,
  });
  assert.equal(env.TMPDIR, '/unrelated');
  fs.writeFileSync(path.join(temporary.directory, 'owned-profile'), 'profile');
  temporary.cleanup();
  assert.equal(fs.existsSync(temporary.directory), false);
});

test('invalid hosted lease retires only its newly created child', t => {
  const workRoot = root(t);
  fs.writeFileSync(path.join(workRoot, 'foreign'), 'preserve');
  const failure = new Error('invalid job lease');
  assert.throws(
    () =>
      createBrowserTemporary(
        {
          workRoot,
          env: {
            GITHUB_ACTIONS: 'true',
            RUNNER_ENVIRONMENT: 'github-hosted',
            RUNNER_TEMP: workRoot,
          },
          platform: 'win32',
        },
        {
          validateJobLease() {
            throw failure;
          },
        },
      ),
    error => error === failure,
  );
  assert.deepEqual(fs.readdirSync(workRoot), ['foreign']);
});

test('local browser temp stays inside the proof and refuses replaced directories', t => {
  const workRoot = root(t);
  const temporary = createBrowserTemporary({
    workRoot,
    env: {},
    platform: 'win32',
  });
  assert.equal(path.dirname(temporary.directory), workRoot);
  const original = `${temporary.directory}-original`;
  fs.renameSync(temporary.directory, original);
  fs.mkdirSync(temporary.directory);
  fs.writeFileSync(path.join(temporary.directory, 'foreign'), 'preserve');
  assert.throws(() => temporary.cleanup(), /inode changed/u);
  assert.equal(
    fs.readFileSync(path.join(temporary.directory, 'foreign'), 'utf8'),
    'preserve',
  );
});

test('only hosted Linux proof invocations use the Linux job temporary lease', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
  };
  assert.equal(usesHostedBrowserTemporary(env, 'linux'), true);
  for (const [platform, runnerOS] of [
    ['darwin', 'macOS'],
    ['win32', 'Windows'],
    ['linux', 'macOS'],
  ])
    assert.equal(
      usesHostedBrowserTemporary({ ...env, RUNNER_OS: runnerOS }, platform),
      false,
    );
  assert.equal(
    usesHostedBrowserTemporary(
      { ...env, RUNNER_ENVIRONMENT: 'self-hosted' },
      'linux',
    ),
    false,
  );
  assert.equal(
    usesHostedBrowserTemporary({ ...env, GITHUB_ACTIONS: 'false' }, 'linux'),
    false,
  );
});
