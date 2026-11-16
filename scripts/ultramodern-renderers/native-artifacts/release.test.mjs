import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures.test-support.mjs';
import { releaseUrl, sha256 } from './protocol.mjs';
import { publishRelease } from './release.mjs';

function service(
  f,
  {
    existing = false,
    draft = false,
    bareTag = false,
    partial = false,
    untaggedDraft = false,
  } = {},
) {
  const draftTag = 'untagged-9931cd253409dc75b459';
  const draftUrl = `https://github.com/${f.producer.repository}/releases/tag/${draftTag}`;
  const useDraftUrls = release => {
    if (!untaggedDraft || !release.draft) return;
    release.html_url = draftUrl;
    for (const asset of release.assets)
      asset.browser_download_url = asset.browser_download_url.replace(
        `/download/${f.producer.tag}/`,
        `/download/${draftTag}/`,
      );
  };
  f.evidence.run.status = 'in_progress';
  f.evidence.run.conclusion = null;
  let release = existing ? structuredClone(f.evidence.release) : null;
  if (release) {
    release.draft = draft;
    if (partial) release.assets = release.assets.slice(0, 2);
    useDraftUrls(release);
  }
  let ref = (existing && !draft) || bareTag ? f.evidence.ref : null;
  const calls = [];
  const api = async (method, route, body) => {
    calls.push({ method, route });
    if (method === 'GET') {
      if (route.includes('/git/ref/')) return ref;
      if (route.includes('/releases/assets/')) {
        const asset = release.assets.find(
          item => String(item.id) === route.split('/').at(-1),
        );
        return f.payloads.get(asset.name);
      }
      if (route.includes('/releases/')) return release;
      return f.readGithub(route);
    }
    if (method === 'POST') {
      assert.equal(release, null);
      release = { ...structuredClone(f.evidence.release), ...body, assets: [] };
      useDraftUrls(release);
      return release;
    }
    if (method === 'UPLOAD') {
      assert(release.draft, 'Never upload to published release');
      const name = new URL(`https://api.github.com${route}`).searchParams.get(
        'name',
      );
      assert(!release.assets.some(asset => asset.name === name));
      const asset = {
        id: release.assets.length + 1,
        name,
        state: 'uploaded',
        digest: `sha256:${sha256(body)}`,
        browser_download_url: releaseUrl(f.producer, name),
      };
      release.assets.push(asset);
      useDraftUrls(release);
      return asset;
    }
    if (method === 'PATCH') {
      assert.equal(
        release.assets.length,
        5,
        'All assets attached before publication',
      );
      release = { ...release, ...body };
      release.html_url = f.evidence.release.html_url;
      for (const asset of release.assets)
        asset.browser_download_url = releaseUrl(f.producer, asset.name);
      ref = f.evidence.ref;
      return release;
    }
    assert.fail(`${method} ${route}`);
  };
  return {
    api,
    calls,
    get release() {
      return release;
    },
  };
}
for (const [label, options] of Object.entries({
  fresh: {},
  partialDraft: { existing: true, draft: true, partial: true },
  completeDraft: { existing: true, draft: true },
  published: { existing: true },
  freshUntaggedDraft: { untaggedDraft: true },
  resumedUntaggedDraft: {
    existing: true,
    draft: true,
    partial: true,
    untaggedDraft: true,
  },
}))
  test(`release transport ${label}: draft → verify bytes → publish, never clobber`, async () => {
    const f = fixture();
    const remote = service(f, options);
    await publishRelease({ ...f, api: remote.api });
    assert.equal(remote.release.draft, false);
    assert.equal(remote.release.assets.length, 5);
    assert(!remote.calls.some(call => call.method === 'DELETE'));
    if (label === 'published')
      assert(remote.calls.every(call => call.method === 'GET'));
    else
      assert.equal(
        remote.calls.filter(call => call.method === 'PATCH').length,
        1,
      );
  });
test('published release cannot retain draft placeholder URLs', async () => {
  const f = fixture();
  const remote = service(f, { existing: true });
  remote.release.html_url = `https://github.com/${f.producer.repository}/releases/tag/untagged-9931cd253409dc75b459`;
  await assert.rejects(publishRelease({ ...f, api: remote.api }));
  assert(remote.calls.every(call => call.method === 'GET'));
});
test('draft placeholder URLs must remain in the exact repository', async () => {
  const f = fixture();
  const remote = service(f, {
    existing: true,
    draft: true,
    untaggedDraft: true,
  });
  remote.release.html_url = remote.release.html_url.replace(
    'github.com/',
    'github.com/foreign/',
  );
  await assert.rejects(publishRelease({ ...f, api: remote.api }));
  assert(remote.calls.every(call => call.method === 'GET'));
});
test('refuses a bare existing tag without writing', async () => {
  const f = fixture();
  const remote = service(f, { bareTag: true });
  await assert.rejects(
    publishRelease({ ...f, api: remote.api }),
    /unauthenticated tag/u,
  );
  assert(remote.calls.every(call => call.method === 'GET'));
});
for (const kind of ['body', 'bytes', 'source', 'qualification'])
  test(`refuses existing release with substituted ${kind}`, async () => {
    const f = fixture();
    const remote = service(f, { existing: true, draft: true, partial: true });
    if (kind === 'body') remote.release.body = 'unit forged';
    if (kind === 'source') remote.release.target_commitish = 'main';
    if (kind === 'qualification')
      f.evidence.jobs.jobs[1].conclusion = 'failure';
    const api =
      kind === 'bytes'
        ? (method, route, body, options) =>
            route.includes('/releases/assets/')
              ? Buffer.from('other bytes')
              : remote.api(method, route, body, options)
        : remote.api;
    await assert.rejects(publishRelease({ ...f, api }));
    assert(remote.calls.every(call => call.method === 'GET'));
  });
