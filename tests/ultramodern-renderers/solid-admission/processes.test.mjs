import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdmissionProcessScope } from './processes.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('owned commands capture both streams and handle spawn failure without hanging', async () => {
  const scope = createAdmissionProcessScope();
  try {
    assert.deepEqual(
      await scope.execute(process.execPath, [
        '-e',
        "process.stdout.write('ok');process.stderr.write('warning')",
      ]),
      { stdout: 'ok', stderr: 'warning' },
    );
    await assert.rejects(
      scope.execute('/missing/solid-admission-executable', [], {
        timeout: 1000,
      }),
      { code: 'ENOENT' },
    );
  } finally {
    await scope.dispose();
  }
});

test('interruption closes an active command and releases its signal handlers', async () => {
  const before = process.listenerCount('SIGTERM');
  const scope = createAdmissionProcessScope();
  try {
    const result = scope
      .execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      .catch(error => error);
    await delay(50);
    process.emit('SIGTERM');
    assert.match((await result).message, /interrupted by SIGTERM/u);
  } finally {
    await scope.dispose();
  }
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('stopping an owned process also closes descendants and preserves a sibling', {
  skip: process.platform === 'win32',
}, async () => {
  const sibling = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { detached: true, stdio: 'ignore' },
  );
  const siblingClosed = new Promise(resolve => sibling.once('close', resolve));
  const scope = createAdmissionProcessScope();
  let descendant;
  try {
    const child = scope.start(process.execPath, [
      '-e',
      "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(() => {}, 1000)",
    ]);
    const deadline = Date.now() + 2000;
    while (!child.output().trim() && Date.now() < deadline) await delay(10);
    descendant = Number(child.output().trim());
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    await scope.stop(child);
    await scope.stop(child);
    while (alive(descendant) && Date.now() < deadline) await delay(10);
    assert.equal(alive(descendant), false);
    assert.equal(alive(sibling.pid), true);
  } finally {
    await scope.dispose();
    process.kill(-sibling.pid, 'SIGTERM');
    await siblingClosed;
    if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
  }
});

test('a bounded command timeout closes its subprocess', async () => {
  const scope = createAdmissionProcessScope();
  try {
    await assert.rejects(
      scope.execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeout: 50,
      }),
      /failed \(timeout\)/u,
    );
  } finally {
    await scope.dispose();
  }
});

test('parent cancellation closes an active owned command without aborting unrelated scopes', async () => {
  const parent = new AbortController();
  const scope = createAdmissionProcessScope({ signal: parent.signal });
  const sibling = createAdmissionProcessScope();
  let child;
  try {
    child = scope.start(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]);
    parent.abort(new Error('Renderer feature acceptance cancelled'));
    await child.admissionCompletion;
    assert.equal(
      scope.signal.reason.message,
      'Renderer feature acceptance cancelled',
    );
    assert.equal(alive(child.pid), false);
    assert.equal(sibling.signal.aborted, false);
    assert.deepEqual(
      await sibling.execute(process.execPath, [
        '-e',
        "process.stdout.write('retained')",
      ]),
      { stdout: 'retained', stderr: '' },
    );
    assert.throws(
      () => scope.start(process.execPath, []),
      /acceptance cancelled/u,
    );
  } finally {
    await scope.dispose();
    await sibling.dispose();
  }
});
