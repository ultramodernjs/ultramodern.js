import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  requireTrustedVerificationSeed,
  verificationCacheIdentity,
} from '../pnpm-verification-cache.mjs';

const files = {
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\n',
  '.npmrc': 'registry=https://registry.npmjs.org/\n',
  '.mise.toml': '[tools]\nnode = "26.12.0"\npnpm = "12.21.0"\n',
  'package.json': '{"packageManager":"pnpm@12.21.0"}',
};
const identify = (overrides = {}, contents = files) =>
  verificationCacheIdentity({
    cacheDirectory: '/runner/pnpm-cache',
    nodeVersion: '26.12.0',
    pnpmVersion: '12.21.0',
    platform: 'linux',
    architecture: 'x64',
    read: name => Buffer.from(contents[name]),
    ...overrides,
  });

test('identity restores only pnpm verification and ignores runner-specific cache location', () => {
  const result = identify();
  assert.equal(result.path, '/runner/pnpm-cache/lockfile-verified.jsonl');
  assert.match(
    result.key,
    /^pnpm-verification-v1-Linux-x64-node26\.12\.0-pnpm12\.21\.0-[a-f0-9]{64}$/u,
  );
  assert.equal(identify({ cacheDirectory: '/another/cache' }).key, result.key);
  assert.equal(
    identify({
      platform: 'win32',
      cacheDirectory: 'C:\\Users\\runner\\AppData\\Local\\pnpm-cache',
    }).path,
    'C:\\Users\\runner\\AppData\\Local\\pnpm-cache\\lockfile-verified.jsonl',
  );
});

test('lockfile, policy, registry, toolchain, OS and architecture invalidate the key', () => {
  const original = identify().key;
  for (const name of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.mise.toml',
  ]) {
    assert.notEqual(
      identify({}, { ...files, [name]: `${files[name]}\n# change\n` }).key,
      original,
      name,
    );
  }
  assert.notEqual(identify({ platform: 'darwin' }).key, original);
  assert.notEqual(identify({ architecture: 'arm64' }).key, original);
  const updated = {
    ...files,
    '.mise.toml': '[tools]\nnode = "26.11.0"\npnpm = "12.9.0"\n',
    'package.json': '{"packageManager":"pnpm@12.9.0"}',
  };
  assert.notEqual(
    identify({ nodeVersion: '26.11.0', pnpmVersion: '12.9.0' }, updated).key,
    original,
  );
});

test('identity rejects unpinned tools, unsupported runners and output injection', () => {
  for (const override of [
    { nodeVersion: '26.11.0' },
    { pnpmVersion: '12.9.0' },
    { platform: 'freebsd' },
    { architecture: 'x64\nkey=unsafe' },
    { cacheDirectory: '' },
    { cacheDirectory: 'relative/cache' },
    { cacheDirectory: '/cache\nkey=unsafe' },
    { cacheDirectory: '/cache\0unsafe' },
  ])
    assert.throws(() => identify(override));
  assert.throws(() =>
    identify(
      {},
      { ...files, 'package.json': '{"packageManager":"pnpm@12.9.0"}' },
    ),
  );
});

const trusted = {
  GITHUB_REPOSITORY: 'ultramodernjs/ultramodern.js',
  GITHUB_REF: 'refs/heads/main-ultramodern',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_WORKFLOW_REF:
    'ultramodernjs/ultramodern.js/.github/workflows/ci-cache.yml@refs/heads/main-ultramodern',
};

test('only the repository default-branch seed workflow can write', () => {
  assert.doesNotThrow(() =>
    requireTrustedVerificationSeed({
      ...trusted,
      GITHUB_REPOSITORY: 'renamed/project',
      GITHUB_WORKFLOW_REF:
        'renamed/project/.github/workflows/ci-cache.yml@refs/heads/main-ultramodern',
    }),
  );
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert.doesNotThrow(() =>
      requireTrustedVerificationSeed({ ...trusted, GITHUB_EVENT_NAME: event }),
    );
  }
  for (const override of [
    { GITHUB_REPOSITORY: 'fork/ultramodern.js' },
    { GITHUB_REF: 'refs/pull/225/merge' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    {
      GITHUB_WORKFLOW_REF: trusted.GITHUB_WORKFLOW_REF.replace(
        'main-ultramodern',
        'feature',
      ),
    },
    {
      GITHUB_WORKFLOW_REF: trusted.GITHUB_WORKFLOW_REF.replace(
        'ci-cache.yml',
        'other.yml',
      ),
    },
  ])
    assert.throws(() =>
      requireTrustedVerificationSeed({ ...trusted, ...override }),
    );
  assert.throws(() => requireTrustedVerificationSeed({}));
});

test('seed requires a real regular verification file and never alters pnpm verdict bytes', () => {
  const directory = mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'pnpm-verification-test-',
    ),
  );
  try {
    const output = path.join(directory, 'outputs');
    const result = path.join(directory, 'lockfile-verified.jsonl');
    const run = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../pnpm-verification-cache.mjs', import.meta.url),
          ),
          'seed',
          '12.21.0',
          directory,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, ...trusted, GITHUB_OUTPUT: output },
        },
      );
    assert.notEqual(
      run().status,
      0,
      'Missing verifier output cannot be seeded',
    );
    const bytes = Buffer.from('test fixture: pnpm owns verdict validation\n');
    writeFileSync(result, bytes);
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(readFileSync(result), bytes);
    assert.match(readFileSync(output, 'utf8'), /^key=pnpm-verification-v1-/u);
    rmSync(result);
    const target = path.join(directory, 'target');
    writeFileSync(target, bytes);
    symlinkSync(target, result);
    assert.notEqual(
      run().status,
      0,
      'A symlink is not a trusted verification file',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
