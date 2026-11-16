import assert from 'node:assert/strict';
import { inspectNpmTarball } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { artifactPolicy } from './protocol.mjs';
import { releaseBody, verifyRelease, verifySource } from './transport.mjs';

export function verifyPayloads({ protocol, descriptor, payloads }) {
  const policy = artifactPolicy(protocol);
  const inspectArchive = policy.inspectNpmTarball ?? inspectNpmTarball;
  const {
    validateDescriptor,
    manifestFilename,
    assetFilename,
    integrity,
    manifestBytes,
  } = protocol;
  validateDescriptor(descriptor);
  const expected = new Map([
    [manifestFilename, descriptor.manifest.integrity],
    ...Object.entries(descriptor.packages).map(([name, item]) => [
      assetFilename(name, item.version),
      item.integrity,
    ]),
  ]);
  assert.deepEqual(
    [...payloads.keys()].sort(),
    [...expected.keys()].sort(),
    'Exact release payload set required',
  );
  for (const [filename, digest] of expected)
    assert.equal(
      integrity(payloads.get(filename)),
      digest,
      `${filename}: payload integrity`,
    );
  assert.deepEqual(
    payloads.get(manifestFilename),
    manifestBytes({
      protocol: descriptor.protocol,
      producer: descriptor.producer,
      packages: descriptor.packages,
    }),
  );
  for (const [name, item] of Object.entries(descriptor.packages)) {
    const pkg = inspectArchive(
      payloads.get(assetFilename(name, item.version)),
    ).packageJson;
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, item.version);
  }
}
/** The only writer. No asset replacement, release deletion, mutable latest, or npm credentials. */
export async function publishArtifactRelease({
  protocol,
  descriptor,
  payloads,
  api,
}) {
  artifactPolicy(protocol);
  const { repository, sha256 } = protocol;
  verifyPayloads({ protocol, descriptor, payloads });
  await verifySource({
    protocol,
    producer: descriptor.producer,
    readGithub: route => api('GET', route),
    publishing: true,
  });
  const { producer } = descriptor;
  const base = `/repos/${repository}`;
  let release = await api(
    'GET',
    `${base}/releases/tags/${producer.tag}`,
    undefined,
    { optional: true },
  );
  const ref = await api(
    'GET',
    `${base}/git/ref/tags/${producer.tag}`,
    undefined,
    { optional: true },
  );
  if (ref) {
    assert(release, 'Refuse a pre-existing unauthenticated tag');
    assert.equal(ref.ref, `refs/tags/${producer.tag}`);
    assert.equal(ref.object?.type, 'commit');
    assert.equal(ref.object.sha, producer.source);
  }
  if (!release) {
    release = await api('POST', `${base}/releases`, {
      tag_name: producer.tag,
      target_commitish: producer.source,
      name: producer.tag,
      body: releaseBody({ protocol, descriptor }),
      draft: true,
      prerelease: false,
    });
  }
  assert(Number.isSafeInteger(release.id) && release.id > 0);
  verifyRelease({
    protocol,
    release,
    descriptor,
    draft: release.draft,
    partial: release.draft,
  });
  // Authentication is both metadata and bytes; a body marker alone cannot resume.
  for (const asset of release.assets) {
    const bytes = await api(
      'GET',
      `${base}/releases/assets/${asset.id}`,
      undefined,
      { bytes: true },
    );
    assert.deepEqual(
      bytes,
      payloads.get(asset.name),
      'Existing release asset differs; never clobber',
    );
    assert.equal(asset.digest, `sha256:${sha256(bytes)}`);
  }
  if (!release.draft) {
    assert(ref, 'Published release must have its exact source tag');
    return release;
  }
  for (const [filename, bytes] of payloads) {
    if (release.assets.some(asset => asset.name === filename)) continue;
    const asset = await api(
      'UPLOAD',
      `${base}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`,
      bytes,
    );
    assert.equal(asset.name, filename);
    assert.equal(asset.digest, `sha256:${sha256(bytes)}`);
    const remote = await api(
      'GET',
      `${base}/releases/assets/${asset.id}`,
      undefined,
      { bytes: true },
    );
    assert.deepEqual(remote, bytes, 'Uploaded asset readback differs');
  }
  release = await api('GET', `${base}/releases/${release.id}`);
  verifyRelease({ protocol, release, descriptor, draft: true });
  // Refuse races or unexpected new assets before publishing.
  for (const asset of release.assets) {
    const bytes = await api(
      'GET',
      `${base}/releases/assets/${asset.id}`,
      undefined,
      { bytes: true },
    );
    assert.deepEqual(bytes, payloads.get(asset.name));
    assert.equal(asset.digest, `sha256:${sha256(bytes)}`);
  }
  release = await api('PATCH', `${base}/releases/${release.id}`, {
    draft: false,
  });
  verifyRelease({ protocol, release, descriptor });
  const publishedRef = await api('GET', `${base}/git/ref/tags/${producer.tag}`);
  assert.equal(publishedRef.ref, `refs/tags/${producer.tag}`);
  assert.equal(publishedRef.object?.type, 'commit');
  assert.equal(publishedRef.object.sha, producer.source);
  return release;
}
