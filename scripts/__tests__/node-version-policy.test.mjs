import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
} from '../ultramodern-node-policy/check-node-version.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

test('rejects legacy and malformed Node runtimes with an actionable error', () => {
  for (const version of [
    '20.19.5',
    '22.23.2',
    '26.6.99',
    '26.12.0',
    '26.13.0',
    'unknown',
  ]) {
    assert.throws(
      () => assertSupportedNodeVersion(version),
      error =>
        error instanceof Error &&
        error.message.includes(`requires Node.js >=${MINIMUM_NODE_VERSION}`) &&
        error.message.includes(`detected v${version}`) &&
        error.message.includes('mise install'),
    );
  }
});

test('supports the exact current Node pin and newer stable runtimes', () => {
  assert.equal(MINIMUM_NODE_VERSION, '26.13.1');
  for (const version of ['26.13.1', '26.13.2', '26.14.0', '27.0.0'])
    assert.equal(assertSupportedNodeVersion(version), version);
});

test('app-tools rejects unsupported Node before loading dependencies', () => {
  for (const bin of ['modern.js', 'modern-bundle-docs.js']) {
    const binPath = path.join(
      repoRoot,
      'packages/solutions/app-tools/bin',
      bin,
    );
    for (const version of ['22.23.2', '26.12.0', '26.13.0', 'bogus']) {
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `Object.defineProperty(process.versions, 'node', { value: '${version}' }); require(${JSON.stringify(binPath)})`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1, `${bin} on ${version}`);
      assert.match(
        result.stderr,
        new RegExp(`requires Node\\.js >=${MINIMUM_NODE_VERSION}`),
        bin,
      );
      assert.match(result.stderr, new RegExp(`detected v${version}`), bin);
    }
  }
});
