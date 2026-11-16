import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  bindArtifactProtocol,
  exactKeys,
  sha256,
} from '../ultramodern-artifacts/protocol.mjs';
import { inspectNpmTarball } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const inputs = freeze(
  JSON.parse(
    fs.readFileSync(new URL('./inputs.json', import.meta.url), 'utf8'),
  ),
);
const cohort = Object.freeze({
  'solid-js': '2.0.0-rc.22',
  '@effect/opentelemetry': '4.1.4',
  '@rstest/core': '0.12.6',
  'ioredis-mock': '8.13.1',
  '@types/ioredis-mock': '8.2.8',
  '@tanstack/react-router': '1.170.46',
  'rsbuild-plugin-dts': '1.0.7',
});
export function inspectSupportTarball(bytes) {
  // DefinitelyTyped's authenticated archive has a single historical root name.
  // Normalize only that exact root for the unchanged strict npm-layout parser.
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  let changed = false;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(
      header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(),
      8,
    );
    assert(Number.isSafeInteger(size) && size >= 0);
    if (name === 'ioredis-mock/' || name.startsWith('ioredis-mock/')) {
      const normalized = 'package/' + name.slice('ioredis-mock/'.length);
      assert(Buffer.byteLength(normalized) <= 100);
      header.fill(0, 0, 100);
      header.write(normalized, 0);
      header.fill(32, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(
        checksum.toString(8).padStart(6, '0') + '\0 ',
        148,
        8,
        'ascii',
      );
      changed = true;
    } else
      assert(
        name === 'package/' || name.startsWith('package/'),
        'unknown support tar root',
      );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const inspected = inspectNpmTarball(changed ? gzipSync(tar) : bytes);
  if (changed)
    assert.equal(
      inspected.packageJson.name,
      '@types/ioredis-mock',
      'alternate tar root only belongs to exact DefinitelyTyped package',
    );
  assert(
    Object.hasOwn(cohort, inspected.packageJson.name),
    'unknown support archive package',
  );
  assert.equal(
    inspected.packageJson.version,
    cohort[inspected.packageJson.name],
  );
  return inspected;
}
function validateUpstream(value, name, version) {
  assert(Object.hasOwn(cohort, name));
  assert.equal(version, cohort[name]);
  exactKeys(
    value,
    Object.keys(inputs[name].upstream),
    'fixed support provenance',
  );
  assert.deepEqual(value, inputs[name].upstream);
}
function validateNpmLicense({ name, upstream, files }) {
  if (name === 'solid-js') {
    assert.equal(upstream.licenseLocation, 'source-only');
    assert(
      !files.has('LICENSE'),
      'Solid npm license presence changed; re-review source-only license contract',
    );
  } else {
    assert(files.has(upstream.licensePath));
    assert.equal(
      sha256(files.get(upstream.licensePath)),
      upstream.licenseSha256,
    );
  }
}
export const supportProtocol = bindArtifactProtocol({
  protocol: 'ultramodern.support-artifacts.v3',
  repository: 'ultramodernjs/ultramodern.js',
  repositoryId: 1151231350,
  workflow: '.github/workflows/support-artifacts.yml',
  cohort,
  manifestFilename: 'support-artifacts.json',
  tagPrefix: 'support-artifacts',
  releaseTitle: 'Support artifacts',
  reconstructionPrefix: 'support-reconstruction-',
  validateUpstream,
  inspectNpmTarball: inspectSupportTarball,
  validateNpmLicense,
});
