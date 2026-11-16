import assert from 'node:assert/strict';
import { artifactPolicy } from './protocol.mjs';

export async function readBytes(
  url,
  { fetchArtifact = fetch, signal, limit = 128 * 1024 * 1024, headers } = {},
) {
  const response = await fetchArtifact(url, { signal, headers });
  assert(response.ok, `Native transport HTTP ${response.status}: ${url}`);
  const chunks = [];
  let size = 0;
  // Enforce the limit while streaming, not after allocating the whole response.
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      assert(size <= limit, 'Native transport size limit exceeded');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await response.body?.cancel?.().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}
export function githubReader({
  protocol,
  token,
  fetchArtifact = fetch,
  signal,
}) {
  artifactPolicy(protocol);
  const { repository, repositoryId } = protocol;
  return async route => {
    assert(
      route.startsWith(`/repos/${repository}/`) ||
        route === `/repositories/${repositoryId}`,
      'Untrusted GitHub API route',
    );
    return JSON.parse(
      await readBytes(`https://api.github.com${route}`, {
        fetchArtifact,
        signal,
        limit: 4 * 1024 * 1024,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
    );
  };
}
export async function verifySource({
  protocol,
  producer,
  readGithub,
  publishing = false,
}) {
  artifactPolicy(protocol);
  const { repository, repositoryId } = protocol;
  const base = `/repos/${repository}`;
  const repo = await readGithub(`/repositories/${repositoryId}`);
  assert.equal(repo.id, repositoryId);
  assert.equal(repo.full_name, repository);
  const run = await readGithub(
    `${base}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}`,
  );
  assert.equal(run.id, producer.runId);
  assert.equal(run.run_attempt, producer.runAttempt);
  assert.equal(run.repository?.id, repositoryId);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.id, repositoryId);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_sha, producer.source);
  assert.equal(run.path, producer.workflow);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main-ultramodern');
  assert.equal(run.actor?.login, 'BleedingDev');
  assert.equal(run.triggering_actor?.login, 'BleedingDev');
  assert.equal(run.status, publishing ? 'in_progress' : 'completed');
  assert.equal(run.conclusion, publishing ? null : 'success');
  const jobs = await readGithub(
    `${base}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}/jobs?per_page=100`,
  );
  assert.equal(
    jobs.total_count,
    jobs.jobs.length,
    'Job inventory must not be truncated',
  );
  for (const name of ['produce', 'qualify']) {
    const matches = jobs.jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `Missing or ambiguous ${name} job`);
    assert.equal(matches[0].head_sha, producer.source);
    assert.equal(matches[0].status, 'completed');
    assert.equal(matches[0].conclusion, 'success');
  }
}
export const releaseBody = ({ protocol, descriptor }) =>
  `${artifactPolicy(protocol).releaseTitle}\nsource=${descriptor.producer.source}\nrun=${descriptor.producer.runId}\nattempt=${descriptor.producer.runAttempt}\nmanifest=${descriptor.manifest.integrity}\n`;
export function verifyRelease({
  protocol,
  release,
  descriptor,
  draft = false,
  partial = false,
}) {
  artifactPolicy(protocol);
  const { repository, manifestFilename, assetFilename, cohort } = protocol;
  protocol.validateDescriptor(descriptor);
  const { producer, packages } = descriptor;
  assert.equal(release.tag_name, producer.tag);
  assert.equal(release.target_commitish, producer.source);
  assert.equal(release.draft, draft);
  assert.equal(release.prerelease, false);
  const releasePrefix = `https://github.com/${repository}/releases/tag/`;
  let urlTag = producer.tag;
  if (draft && release.html_url !== `${releasePrefix}${producer.tag}`) {
    assert(Number.isSafeInteger(release.id) && release.id > 0);
    assert.equal(typeof release.html_url, 'string');
    assert(release.html_url.startsWith(releasePrefix));
    urlTag = release.html_url.slice(releasePrefix.length);
    // GitHub assigns this placeholder before publishing creates the real tag.
    // The reviewed tag/source/body and all archive identities still bind below.
    assert.match(urlTag, /^untagged-[a-f0-9]{20}$/u);
  }
  assert.equal(release.html_url, `${releasePrefix}${urlTag}`);
  assert.equal(release.body, releaseBody({ protocol, descriptor }));
  const expected = new Map([
    [manifestFilename, descriptor.manifest.integrity],
    ...Object.entries(packages).map(([name, item]) => [
      assetFilename(name, item.version),
      item.integrity,
    ]),
  ]);
  assert(Array.isArray(release.assets));
  const seen = new Set();
  for (const asset of release.assets) {
    assert(
      expected.has(asset.name) && !seen.has(asset.name),
      'Unexpected or duplicate release asset',
    );
    seen.add(asset.name);
    assert.equal(asset.state, 'uploaded');
    assert(
      [producer.tag, urlTag].some(
        tag =>
          asset.browser_download_url ===
          `https://github.com/${repository}/releases/download/${tag}/${asset.name}`,
      ),
      'Release asset URL must use the exact tag or its draft placeholder',
    );
    // GitHub's SHA256 is verified separately against downloaded bytes. It is not SHA512.
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/u);
    assert(Number.isSafeInteger(asset.id) && asset.id > 0);
  }
  if (!partial)
    assert.equal(
      seen.size,
      Object.keys(cohort).length + 1,
      'Incomplete native release assets',
    );
}
export async function authenticateDescriptor({
  protocol,
  descriptor,
  readGithub = githubReader({ protocol }),
  fetchArtifact = fetch,
  signal,
}) {
  artifactPolicy(protocol);
  const {
    validateDescriptor,
    repository,
    integrity,
    manifestBytes,
    manifestFilename,
    sha256,
  } = protocol;
  validateDescriptor(descriptor);
  await verifySource({ protocol, producer: descriptor.producer, readGithub });
  const base = `/repos/${repository}`;
  const ref = await readGithub(
    `${base}/git/ref/tags/${descriptor.producer.tag}`,
  );
  assert.equal(ref.ref, `refs/tags/${descriptor.producer.tag}`);
  assert.equal(ref.object?.type, 'commit');
  assert.equal(ref.object.sha, descriptor.producer.source);
  const release = await readGithub(
    `${base}/releases/tags/${descriptor.producer.tag}`,
  );
  verifyRelease({ protocol, release, descriptor });
  const bytes = await readBytes(descriptor.manifest.request, {
    fetchArtifact,
    signal,
    limit: 1024 * 1024,
  });
  assert.equal(
    integrity(bytes),
    descriptor.manifest.integrity,
    'Native manifest integrity mismatch',
  );
  assert.deepEqual(
    bytes,
    manifestBytes({
      protocol: descriptor.protocol,
      producer: descriptor.producer,
      packages: descriptor.packages,
    }),
    'Native manifest must have its canonical producer bytes',
  );
  const manifest = JSON.parse(bytes);
  assert.deepEqual(
    manifest,
    {
      protocol: descriptor.protocol,
      producer: descriptor.producer,
      packages: descriptor.packages,
    },
    'Native manifest differs from packed renderer',
  );
  assert.equal(
    release.assets.find(asset => asset.name === manifestFilename).digest,
    `sha256:${sha256(bytes)}`,
  );
  return release;
}
