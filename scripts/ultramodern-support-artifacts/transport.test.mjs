import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseBody } from '../ultramodern-artifacts/transport.mjs';
import { inputs, supportProtocol as p } from './protocol.mjs';
import { authenticateDescriptor } from './transport.mjs';

// Synthetic metadata only; no release uploads or live GitHub requests.
function fixture() {
  const source = 'a'.repeat(40);
  const producer = {
    repository: p.repository,
    repositoryId: p.repositoryId,
    workflow: p.workflow,
    source,
    runId: 1,
    runAttempt: 1,
    tag: `support-artifacts-${source}-1-1`,
  };
  const manifest = {
    protocol: p.protocol,
    producer,
    packages: Object.fromEntries(
      Object.entries(p.cohort).map(([name, version]) => [
        name,
        {
          version,
          request: p.releaseUrl(producer, p.assetFilename(name, version)),
          integrity: p.integrity(Buffer.from(name)),
          upstream: structuredClone(inputs[name].upstream),
          patchSha256: inputs[name].patchSha256,
        },
      ]),
    ),
  };
  const descriptor = p.descriptorFor(manifest);
  const bytes = p.manifestBytes(manifest);
  const repo = { id: p.repositoryId, full_name: p.repository };
  const run = {
    id: producer.runId,
    run_attempt: producer.runAttempt,
    repository: repo,
    head_repository: repo,
    head_sha: source,
    path: p.workflow,
    event: 'workflow_dispatch',
    head_branch: 'main-ultramodern',
    actor: { login: 'BleedingDev' },
    triggering_actor: { login: 'BleedingDev' },
    status: 'completed',
    conclusion: 'success',
  };
  const jobs = {
    total_count: 2,
    jobs: ['produce', 'qualify'].map(name => ({
      name,
      head_sha: source,
      status: 'completed',
      conclusion: 'success',
    })),
  };
  const release = {
    tag_name: producer.tag,
    target_commitish: source,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/${p.repository}/releases/tag/${producer.tag}`,
    body: releaseBody({ protocol: p, descriptor }),
    assets: [
      p.manifestFilename,
      ...Object.entries(p.cohort).map(([name, version]) =>
        p.assetFilename(name, version),
      ),
    ].map((name, index) => ({
      id: index + 1,
      name,
      state: 'uploaded',
      digest: `sha256:${p.sha256(name === p.manifestFilename ? bytes : Buffer.from(name))}`,
      browser_download_url: p.releaseUrl(producer, name),
    })),
  };
  const base = `/repos/${p.repository}`;
  const routes = new Map([
    [`/repositories/${p.repositoryId}`, repo],
    [`${base}/actions/runs/1/attempts/1`, run],
    [`${base}/actions/runs/1/attempts/1/jobs?per_page=100`, jobs],
    [
      `${base}/git/ref/tags/${producer.tag}`,
      {
        ref: `refs/tags/${producer.tag}`,
        object: { type: 'commit', sha: source },
      },
    ],
    [`${base}/releases/tags/${producer.tag}`, release],
  ]);
  const readGithub = async route => {
    assert(routes.has(route), 'Unexpected synthetic GitHub route');
    return routes.get(route);
  };
  const requests = [];
  const fetchArtifact = async (url, options) => {
    requests.push({ url, ...options });
    if (url.startsWith('https://api.github.com'))
      return Response.json(
        await readGithub(url.slice('https://api.github.com'.length)),
      );
    assert.equal(url, descriptor.manifest.request);
    return new Response(bytes);
  };
  return { descriptor, release, jobs, requests, readGithub, fetchArtifact };
}

function isolate(t, ghToken, githubToken) {
  const original = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  const set = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  t.after(() => {
    for (const [key, value] of Object.entries(original)) set(key, value);
  });
  set('GH_TOKEN', ghToken);
  set('GITHUB_TOKEN', githubToken);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected global fetch: injected transport was ignored');
  });
}

for (const [label, token, ghToken, githubToken, selected] of [
  [
    'explicit token wins',
    'test-option',
    'test-gh',
    'test-github',
    'test-option',
  ],
  ['GH_TOKEN wins', undefined, 'test-gh', 'test-github', 'test-gh'],
  ['GITHUB_TOKEN fallback', undefined, undefined, 'test-github', 'test-github'],
  ['null token falls back', null, 'test-gh', 'test-github', 'test-gh'],
  ['empty token suppresses bearer', '', 'test-gh', 'test-github', undefined],
  ['no token omits bearer', undefined, undefined, undefined, undefined],
]) {
  test(`default authentication: ${label}; injected fetch and signal reach every request`, async t => {
    isolate(t, ghToken, githubToken);
    const f = fixture();
    const signal = new AbortController().signal;
    assert.deepEqual(
      await authenticateDescriptor({
        descriptor: f.descriptor,
        token,
        fetchArtifact: f.fetchArtifact,
        signal,
      }),
      f.release,
    );
    assert.equal(f.requests.length, 6);
    for (const request of f.requests) assert.equal(request.signal, signal);
    for (const request of f.requests.slice(0, 5)) {
      assert(request.url.startsWith('https://api.github.com/'));
      assert.equal(
        request.headers.Authorization,
        selected ? `Bearer ${selected}` : undefined,
      );
    }
    assert.equal(f.requests[5].url, f.descriptor.manifest.request);
    assert.equal(f.requests[5].headers, undefined);
  });
}

test('explicit GitHub reader overrides the bound default', async t => {
  isolate(t, 'test-gh', 'test-github');
  const f = fixture();
  assert.deepEqual(
    await authenticateDescriptor({
      descriptor: f.descriptor,
      readGithub: f.readGithub,
      fetchArtifact: f.fetchArtifact,
    }),
    f.release,
  );
  assert.deepEqual(
    f.requests.map(request => request.url),
    [f.descriptor.manifest.request],
  );
});

test('bound default still rejects failed qualification', async t => {
  isolate(t, 'test-gh', undefined);
  const f = fixture();
  f.jobs.jobs[1].conclusion = 'failure';
  await assert.rejects(
    authenticateDescriptor({
      descriptor: f.descriptor,
      fetchArtifact: f.fetchArtifact,
    }),
    assert.AssertionError,
  );
  assert.equal(f.requests.length, 3);
});
