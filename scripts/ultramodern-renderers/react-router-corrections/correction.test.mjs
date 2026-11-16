import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  packArchive,
  readArchive,
} from '../../ultramodern-dependencies/test-peer-corrections/archive.mjs';
import { authenticateArchive } from '../../ultramodern-dependencies/test-peer-corrections/authenticate.mjs';
import { correctReactArchive, verifyPayload } from './correction.mjs';
import { isolatedEnvironment } from './proof.mjs';

function fixture() {
  const manifest = {
    name: '@tanstack/react-router',
    version: '1.170.46',
    dependencies: {
      '@tanstack/router-core': '1.171.39',
      '@tanstack/history': '1.162.5',
    },
    peerDependencies: {
      react: '>=18.0.0 || >=19.0.0',
      'react-dom': '>=18.0.0 || >=19.0.0',
    },
    exports: {
      '.': { import: './dist/esm/index.js', require: './dist/cjs/index.cjs' },
    },
    license: 'MIT',
  };
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify(manifest, null, 2))],
    ['dist/esm/index.js', Buffer.from('export const sentinel = 42;\n')],
    [
      'dist/esm/index.d.ts',
      Buffer.from('export declare const sentinel: 42;\n'),
    ],
    ['LICENSE', Buffer.from('MIT fixture\n')],
  ]);
  return packArchive(files);
}

test('metadata correction preserves every runtime/type/license byte and other manifest fields', () => {
  const original = fixture();
  const corrected = correctReactArchive(original);
  const actual = readArchive(corrected.archiveBytes);
  const before = readArchive(original);
  const manifest = JSON.parse(actual.get('package.json'));
  assert(!('@tanstack/router-core' in manifest.dependencies));
  assert.equal(manifest.peerDependencies['@tanstack/router-core'], '1.171.39');
  assert(!manifest.peerDependenciesMeta);
  assert(
    !actual.get('package.json').toString().endsWith('\n'),
    'Preserve original newline',
  );
  for (const [name, bytes] of before)
    if (name !== 'package.json') assert(actual.get(name).equals(bytes));
  assert(
    correctReactArchive(original).archiveBytes.equals(corrected.archiveBytes),
    'Deterministic package',
  );
});

test('actual transported bytes are preserved; changed runtime and declarations fail', () => {
  const expected = correctReactArchive(fixture()).archiveBytes;
  const recompressed = gzipSync(gunzipSync(expected), { level: 1 });
  assert(!expected.equals(recompressed));
  assert.equal(verifyPayload(recompressed, expected), recompressed);
  for (const file of [
    'dist/esm/index.js',
    'dist/esm/index.d.ts',
    'LICENSE',
    'package.json',
  ]) {
    const files = readArchive(expected);
    files.set(file, Buffer.from('changed'));
    assert.throws(
      () => verifyPayload(packArchive(files), expected),
      /payload changed/,
    );
  }
});

test('wrong identity/version/dependency and optional peer are not accepted as this owning correction', () => {
  for (const mutate of [
    value => {
      value.name = 'other';
    },
    value => {
      value.version = '1.170.44';
    },
    value => {
      value.dependencies['@tanstack/router-core'] = '1.171.37';
    },
    value => {
      value.peerDependenciesMeta = {
        '@tanstack/router-core': { optional: true },
      };
    },
  ]) {
    const files = readArchive(fixture());
    const manifest = JSON.parse(files.get('package.json'));
    mutate(manifest);
    files.set('package.json', Buffer.from(JSON.stringify(manifest)));
    assert.throws(() => correctReactArchive(packArchive(files)));
  }
});

test('upstream SHA512 and registry ECDSA both fail closed', () => {
  const bytes = fixture();
  const identity = {
    name: '@tanstack/react-router',
    version: '1.170.46',
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    signatures: [],
  };
  assert.throws(
    () => authenticateArchive(identity, Buffer.from('bad')),
    /SHA512 mismatch/,
  );
  assert.throws(
    () => authenticateArchive(identity, bytes),
    /signature not verified/,
  );
  assert.throws(
    () =>
      authenticateArchive(
        {
          ...identity,
          signatures: [{ keyid: 'unknown', sig: 'bad' }],
        },
        bytes,
      ),
    /signature not verified/,
  );
});

test('subprocess environment drops ambient credentials and pnpm bypasses', () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests inside owned-temp-dir');
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'environment-'),
  );
  try {
    const env = isolatedEnvironment(directory);
    assert.deepEqual(
      Object.keys(env).sort(),
      [
        ...['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].filter(
          key => process.env[key],
        ),
        'CI',
        'npm_config_userconfig',
        'npm_config_globalconfig',
      ].sort(),
    );
    assert.equal(env.CI, 'true');
    assert.equal(fs.readFileSync(env.npm_config_userconfig, 'utf8'), '');
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
