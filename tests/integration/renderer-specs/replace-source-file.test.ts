import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { rs } from '@rstest/core';
import { replaceSourceFile } from './replace-source-file';

rs.mock('node:timers/promises', () => ({
  setTimeout: rs.fn(() => Promise.resolve()),
}));

let root: string;
let file: string;
const original = 'export const message = "original";\n';
const updated = 'export const message = "updated";\n';

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-source-write-')),
  );
  file = path.join(root, 'Message.tsx');
  fs.writeFileSync(file, original, { mode: 0o640 });
  rs.mocked(delay).mockClear();
});

afterEach(() => {
  rs.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

test('does not rewrite an already restored source file', async () => {
  const rename = rs.spyOn(fs, 'renameSync');
  const stage = rs.spyOn(fs, 'mkdtempSync');
  await replaceSourceFile(file, original, 'win32');
  assert.equal(rename.mock.calls.length, 0);
  assert.equal(stage.mock.calls.length, 0);
  assert.deepEqual(fs.readdirSync(root), ['Message.tsx']);
});

test('replaces a complete source revision and preserves its mode', async () => {
  const mode = fs.statSync(file).mode;
  await replaceSourceFile(file, updated);
  assert.equal(fs.readFileSync(file, 'utf8'), updated);
  assert.equal(fs.statSync(file).mode, mode);
  assert.equal(rs.mocked(delay).mock.calls.length, 0);
  assert.deepEqual(fs.readdirSync(root), ['Message.tsx']);
});

test.each(['EPERM', 'EBUSY'])(
  'retries a transient Windows %s without exposing partial source',
  async code => {
    const rename = fs.renameSync;
    const calls: string[] = [];
    rs.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      assert.equal(fs.readFileSync(from, 'utf8'), updated);
      assert.equal(to, file);
      calls.push(String(from));
      if (calls.length < 3) {
        throw Object.assign(new Error('Sharing violation'), { code });
      }
      return rename(from, to);
    });
    await replaceSourceFile(file, updated, 'win32');
    assert.equal(new Set(calls).size, 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(rs.mocked(delay).mock.calls, [[20], [40]]);
    assert.equal(fs.readFileSync(file, 'utf8'), updated);
    assert.deepEqual(fs.readdirSync(root), ['Message.tsx']);
  },
);

test('bounds Windows retries and preserves the original on terminal failure', async () => {
  const failure = Object.assign(new Error('Still locked'), { code: 'EPERM' });
  const rename = rs.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw failure;
  });
  await assert.rejects(
    replaceSourceFile(file, updated, 'win32'),
    error => error === failure,
  );
  assert.equal(rename.mock.calls.length, 6);
  assert.deepEqual(rs.mocked(delay).mock.calls, [
    [20],
    [40],
    [80],
    [160],
    [320],
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(root), ['Message.tsx']);
});

test.each([
  { platform: 'linux', code: 'EPERM' },
  { platform: 'darwin', code: 'EBUSY' },
  { platform: 'win32', code: 'EACCES' },
  { platform: 'win32', code: 'ENOENT' },
] as const)(
  'does not retry $platform $code errors',
  async ({ platform, code }) => {
    const failure = Object.assign(new Error('Cannot replace'), { code });
    const rename = rs.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw failure;
    });
    await assert.rejects(
      replaceSourceFile(file, updated, platform),
      error => error === failure,
    );
    assert.equal(rename.mock.calls.length, 1);
    assert.equal(rs.mocked(delay).mock.calls.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(root), ['Message.tsx']);
  },
);
