import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevOutputCapture } from './process-output.mjs';

test('retains bounded startup output separately from the rolling tail', () => {
  const capture = createDevOutputCapture();
  capture.append('initial startup\n');
  capture.append('x'.repeat(256 * 1024));
  capture.append('\nlatest output');
  assert.ok(capture.startup().initialOutput.startsWith('initial startup\n'));
  assert.equal(capture.startup().initialOutput.length, 4096);
  assert.equal(capture.startup().firstServerError, undefined);
  assert.equal(capture.tail.length, 128 * 1024);
  assert.ok(capture.tail.endsWith('\nlatest output'));
  assert.ok(!capture.tail.includes('initial startup'));
});

test('keeps the original server exception after later requests replace the tail', () => {
  const capture = createDevOutputCapture();
  capture.append('warnings\n'.repeat(2000));
  capture.append(
    'error   Server Error - Internal server error: original cause\n',
  );
  capture.append('    at initialize (handlers.server.ts:12)\n');
  capture.append('x'.repeat(256 * 1024));
  capture.append(
    'error   Server Error - ReferenceError: cached module export\n',
  );
  const first = capture.startup().firstServerError;
  assert.match(
    first,
    /^Server Error - Internal server error: original cause\n/u,
  );
  assert.match(first, /at initialize \(handlers.server.ts:12\)/u);
  assert.equal(first.length, 8192);
  assert.ok(!first.includes('cached module export'));
  assert.ok(!capture.tail.includes('original cause'));
  assert.ok(capture.tail.includes('cached module export'));
});

test('recognizes the server-error marker split across process chunks', () => {
  for (let split = 1; split < 'Server Error -'.length; split++) {
    const capture = createDevOutputCapture();
    const message = 'Server Error - original exception\n';
    capture.append(`startup\nerror   ${message.slice(0, split)}`);
    capture.append(message.slice(split));
    assert.equal(capture.startup().firstServerError, message);
  }
});
