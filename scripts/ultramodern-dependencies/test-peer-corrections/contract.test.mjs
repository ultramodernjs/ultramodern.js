import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { corrections, versions } from './inputs.mjs';

for (const [name, peers] of Object.entries(corrections)) {
  test(`${name} patch changes only the demonstrated peer range`, () => {
    const patch = fs.readFileSync(
      new URL(`./${name.replaceAll('/', '_')}.patch`, import.meta.url),
      'utf8',
    );
    assert.match(patch, /diff --git a\/package\.json b\/package\.json/);
    const removed = patch
      .split('\n')
      .filter(line => line.startsWith('-') && !line.startsWith('---'));
    const added = patch
      .split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++'));
    assert.equal(removed.length, Object.keys(peers).length);
    assert.equal(added.length, Object.keys(peers).length);
    for (const [peer, range] of Object.entries(peers)) {
      assert(added.some(line => line.includes(`"${peer}": "${range}"`)));
    }
    assert(!patch.includes('strictPeerDependencies'));
  });
}

test('explicit latest tuple is unchanged by correction', () => {
  assert.deepEqual(versions, {
    '@rstest/core': '0.12.6',
    'happy-dom': '21.0.4',
    'ioredis-mock': '8.13.1',
    '@types/ioredis-mock': '8.2.8',
    ioredis: '6.0.0',
  });
});

test('portable API imports without installed dependencies or host paths', async () => {
  const { qualifyPeerCorrections } = await import('./qualify.mjs');
  assert.equal(typeof qualifyPeerCorrections, 'function');
  for (const file of ['qualify.mjs', 'authenticate.mjs', 'archive.mjs']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert(!source.includes('/Users/'));
    assert(!source.includes('require.resolve'));
  }
});

test('archive qualification rejects extra files, changed bytes and unsafe paths', async () => {
  const { readArchive, packArchive, assertSameFiles } = await import(
    './archive.mjs'
  );
  const files = new Map([
    ['package.json', Buffer.from('{}')],
    ['LICENSE', Buffer.from('license')],
  ]);
  assertSameFiles(readArchive(packArchive(files)), files);
  assert.throws(
    () =>
      assertSameFiles(new Map([...files, ['extra', Buffer.from('x')]]), files),
    /member set/,
  );
  assert.throws(
    () =>
      assertSameFiles(
        new Map([...files, ['LICENSE', Buffer.from('changed')]]),
        files,
      ),
    /payload changed LICENSE/,
  );
  assert.throws(
    () =>
      readArchive(
        packArchive(new Map([...files, ['../escape', Buffer.from('x')]])),
      ),
    /unsafe archive path/,
  );
});
