import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const policies = new WeakMap();
const bindings = new WeakMap();
export function artifactPolicy(protocol) {
  const bound =
    bindings.get(protocol) ?? bindings.get(protocol?.validateManifest);
  assert(bound, 'A trusted internally bound artifact protocol is required');
  // Native ESM namespace wrappers are allowed, but none of their controls may differ.
  for (const key of Object.keys(bound))
    assert.equal(
      protocol[key],
      bound[key],
      `Substituted bound protocol: ${key}`,
    );
  return policies.get(bound);
}
export function bindArtifactProtocol(input) {
  const policy = Object.freeze({
    ...input,
    cohort: Object.freeze({ ...input.cohort }),
  });
  const {
    protocol,
    repository,
    repositoryId,
    workflow,
    cohort,
    manifestFilename,
    validateUpstream,
  } = policy;
  assert.equal(typeof validateUpstream, 'function');
  for (const key of [
    'verifySourceQualification',
    'inspectNpmTarball',
    'validateNpmLicense',
  ])
    if (policy[key] !== undefined)
      assert.equal(typeof policy[key], 'function', key);
  for (const key of [
    'protocol',
    'repository',
    'workflow',
    'manifestFilename',
    'tagPrefix',
    'releaseTitle',
    'reconstructionPrefix',
  ])
    assert.equal(typeof policy[key], 'string', key);
  assert(Number.isSafeInteger(repositoryId) && repositoryId > 0);
  assert(Object.keys(cohort).length > 0);
  const releaseUrl = (producer, filename) =>
    `https://github.com/${repository}/releases/download/${producer.tag}/${filename}`;
  function validateProducer(value) {
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
      `${policy.tagPrefix}-${value.source}-${value.runId}-${value.runAttempt}`,
    );
    return value;
  }
  function validatePackages(packages, producer) {
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
  function validateManifest(value) {
    exactKeys(value, ['protocol', 'producer', 'packages'], 'native manifest');
    assert.equal(value.protocol, protocol);
    validateProducer(value.producer);
    validatePackages(value.packages, value.producer);
    return value;
  }
  function validateDescriptor(value) {
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
  function manifestBytes(value) {
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
  function descriptorFor(value) {
    return {
      ...value,
      manifest: {
        request: releaseUrl(value.producer, manifestFilename),
        integrity: integrity(manifestBytes(value)),
      },
    };
  }

  const bound = Object.freeze({
    protocol,
    repository,
    repositoryId,
    workflow,
    cohort,
    manifestFilename,
    sha256,
    integrity,
    exactKeys,
    digest,
    commit,
    hash,
    assetFilename,
    releaseUrl,
    validateProducer,
    validateUpstream,
    validatePackages,
    validateManifest,
    validateDescriptor,
    manifestBytes,
    descriptorFor,
  });
  policies.set(bound, policy);
  bindings.set(bound, bound);
  bindings.set(bound.validateManifest, bound);
  return bound;
}
