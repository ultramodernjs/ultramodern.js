import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const protocol = 'ultramodern.native-artifacts.v1';
export const repository = 'ultramodernjs/ultramodern.js';
export const repositoryId = 1151231350;
export const workflow = '.github/workflows/native-renderer-artifacts.yml';
export const cohort = Object.freeze({
  octane: '0.18.0',
  '@octanejs/tanstack-router': '0.3.4',
  '@octanejs/rspack-plugin': '0.2.10',
  '@tanstack/router-core': '1.171.39',
});
export const manifestFilename = 'native-artifacts.json';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const integrity = bytes =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
export function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label}: unknown or missing fields`,
  );
}
export function digest(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^sha512-[A-Za-z0-9+/]{86}==$/u);
  assert.equal(
    Buffer.from(value.slice(7), 'base64').toString('base64'),
    value.slice(7),
  );
}
export function commit(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[a-f0-9]{40}$/u);
}
export function hash(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[a-f0-9]{64}$/u);
}
export const assetFilename = (name, version) =>
  `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
export const releaseUrl = (producer, filename) =>
  `https://github.com/${repository}/releases/download/${producer.tag}/${filename}`;
export function validateProducer(value) {
  exactKeys(
    value,
    [
      'repository',
      'repositoryId',
      'workflow',
      'source',
      'runId',
      'runAttempt',
      'tag',
    ],
    'producer',
  );
  assert.equal(value.repository, repository);
  assert.equal(value.repositoryId, repositoryId);
  assert.equal(value.workflow, workflow);
  commit(value.source);
  for (const key of ['runId', 'runAttempt'])
    assert(Number.isSafeInteger(value[key]) && value[key] > 0, key);
  assert.equal(
    value.tag,
    `native-renderers-${value.source}-${value.runId}-${value.runAttempt}`,
  );
  return value;
}
export function validateUpstream(value, name, version) {
  exactKeys(
    value,
    [
      'request',
      'integrity',
      'repository',
      'commit',
      'sourceArchiveIntegrity',
      'licenseSha256',
    ],
    'upstream',
  );
  assert.equal(
    value.request,
    `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
  );
  digest(value.integrity);
  assert.match(value.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  commit(value.commit);
  digest(value.sourceArchiveIntegrity);
  hash(value.licenseSha256);
}
export function validatePackages(packages, producer) {
  exactKeys(packages, Object.keys(cohort), 'complete closed native cohort');
  for (const [name, version] of Object.entries(cohort)) {
    const item = packages[name];
    exactKeys(
      item,
      ['version', 'request', 'integrity', 'upstream', 'patchSha256'],
      name,
    );
    assert.equal(item.version, version, `${name}: version`);
    assert.equal(
      item.request,
      releaseUrl(producer, assetFilename(name, version)),
      `${name}: canonical request`,
    );
    digest(item.integrity);
    validateUpstream(item.upstream, name, version);
    hash(item.patchSha256);
  }
  return packages;
}
export function validateManifest(value) {
  exactKeys(value, ['protocol', 'producer', 'packages'], 'native manifest');
  assert.equal(value.protocol, protocol);
  validateProducer(value.producer);
  validatePackages(value.packages, value.producer);
  return value;
}
export function validateDescriptor(value) {
  exactKeys(
    value,
    ['protocol', 'producer', 'manifest', 'packages'],
    'native descriptor',
  );
  validateManifest({
    protocol: value.protocol,
    producer: value.producer,
    packages: value.packages,
  });
  exactKeys(value.manifest, ['request', 'integrity'], 'manifest pin');
  assert.equal(
    value.manifest.request,
    releaseUrl(value.producer, manifestFilename),
  );
  digest(value.manifest.integrity);
  return value;
}
export function manifestBytes(value) {
  validateManifest(value);
  // Stable object-key ordering, including nested recipe provenance.
  const canonical = item =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map(key => [key, canonical(item[key])]),
          )
        : item;
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
}
export function descriptorFor(value) {
  return {
    ...value,
    manifest: {
      request: releaseUrl(value.producer, manifestFilename),
      integrity: integrity(manifestBytes(value)),
    },
  };
}
