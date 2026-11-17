import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { portableExports, upstream } from './reconstruct.mjs';

const provenance = JSON.parse(
  fs.readFileSync(new URL('./provenance.json', import.meta.url)),
);
test('canonical patch and source port are digest pinned', () => {
  for (const [file, digest] of [
    [
      '../../../patches/@tanstack__router-core@1.171.39.patch',
      provenance.patchSha256,
    ],
    ['./source.patch', provenance.sourcePatchSha256],
    ['./route-path-types.patch', provenance.routePathTypesPatchSha256],
  ])
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(new URL(file, import.meta.url)))
        .digest('hex'),
      digest,
    );
  assert.equal(provenance.upstreamCommit, upstream.commit);
  assert.equal(provenance.acceptedCommit, upstream.accepted);
  assert.equal(provenance.upstreamNpmIntegrity, upstream.integrity);
});
test('portable and Node exports preserve package identity and unrelated entries', () => {
  const portable = {
    import: {
      types: './dist/esm/ssr/server.d.ts',
      default: './dist/esm/ssr/server.js',
    },
    require: {
      types: './dist/cjs/ssr/server.d.cts',
      default: './dist/cjs/ssr/server.cjs',
    },
  };
  const manifest = {
    name: '@tanstack/router-core',
    version: '1.171.39',
    exports: {
      './ssr/server': portable,
      '.': { import: './dist/esm/index.js' },
    },
  };
  portableExports(manifest);
  assert.equal(manifest.name, '@tanstack/router-core');
  assert.equal(manifest.version, '1.171.39');
  assert.deepEqual(manifest.exports['.'], { import: './dist/esm/index.js' });
  for (const condition of ['browser', 'workerd', 'worker'])
    assert.deepEqual(manifest.exports['./ssr/server'][condition], portable);
  assert.deepEqual(
    manifest.exports['./ssr/server.node'],
    manifest.exports['./ssr/server'].node,
  );
  assert.equal(
    manifest.exports['./ssr/server.node'].require.types,
    './dist/cjs/ssr/server.node.d.cts',
  );
});
