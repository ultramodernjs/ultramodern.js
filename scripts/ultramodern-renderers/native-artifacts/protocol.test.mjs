import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures.test-support.mjs';
import { validateDescriptor } from './protocol.mjs';
import { authenticateDescriptor, readBytes } from './transport.mjs';

test('authenticates the exact closed source/run/attempt manifest without claiming GitHub immutability', async () => {
  const f = fixture();
  await authenticateDescriptor(f.descriptor, f);
});
for (const [label, alter] of Object.entries({
  repository: d => {
    d.producer.repository = 'unit/other';
  },
  repositoryId: d => {
    d.producer.repositoryId++;
  },
  source: d => {
    d.producer.source = 'd'.repeat(40);
  },
  run: d => {
    d.producer.runId++;
  },
  attempt: d => {
    d.producer.runAttempt++;
  },
  workflow: d => {
    d.producer.workflow = '.github/workflows/other.yml';
  },
  tag: d => {
    d.producer.tag = 'latest';
  },
  cohort: d => {
    delete d.packages.octane;
  },
  extra: d => {
    d.packages.extra = d.packages.octane;
  },
  version: d => {
    d.packages.octane.version = '0.17.0';
  },
  url: d => {
    d.packages.octane.request += '?download=1';
  },
  patch: d => {
    d.packages.octane.patchSha256 = 'bad';
  },
  base: d => {
    d.packages.octane.upstream.commit = 'main';
  },
  hash: d => {
    d.manifest.integrity = 'sha512-AAAA';
  },
}))
  test(`descriptor rejects substituted ${label}`, () => {
    const { descriptor } = fixture();
    alter(descriptor);
    assert.throws(() => validateDescriptor(descriptor));
  });
for (const [label, alter] of Object.entries({
  repository: f => {
    f.evidence.repo.full_name = 'unit/other';
  },
  repositoryId: f => {
    f.evidence.repo.id++;
  },
  source: f => {
    f.evidence.run.head_sha = 'd'.repeat(40);
  },
  run: f => {
    f.evidence.run.id++;
  },
  attempt: f => {
    f.evidence.run.run_attempt++;
  },
  fork: f => {
    f.evidence.run.head_repository = { id: 1, full_name: 'unit/other' };
  },
  workflow: f => {
    f.evidence.run.path = '.github/workflows/other.yml';
  },
  event: f => {
    f.evidence.run.event = 'pull_request';
  },
  branch: f => {
    f.evidence.run.head_branch = 'main';
  },
  actor: f => {
    f.evidence.run.actor.login = 'another-actor';
  },
  triggeringActor: f => {
    f.evidence.run.triggering_actor.login = 'another-actor';
  },
  failedRun: f => {
    f.evidence.run.conclusion = 'failure';
  },
  failedQualification: f => {
    f.evidence.jobs.jobs[1].conclusion = 'failure';
  },
  truncatedJobs: f => {
    f.evidence.jobs.total_count++;
  },
  tag: f => {
    f.evidence.ref.object.sha = 'd'.repeat(40);
  },
  annotatedTag: f => {
    f.evidence.ref.object.type = 'tag';
  },
  releaseSource: f => {
    f.evidence.release.target_commitish = 'main';
  },
  draft: f => {
    f.evidence.release.draft = true;
  },
  asset: f => {
    f.evidence.release.assets.pop();
  },
  duplicateAsset: f => {
    f.evidence.release.assets.push(f.evidence.release.assets[0]);
  },
  assetHash: f => {
    f.evidence.release.assets.at(-1).digest = `sha256:${'0'.repeat(64)}`;
  },
  manifestHash: f => {
    f.payloads.set('native-artifacts.json', Buffer.from('{}'));
  },
  patchCoherency: f => {
    f.descriptor.packages.octane.patchSha256 = 'e'.repeat(64);
  },
  baseCoherency: f => {
    f.descriptor.packages.octane.upstream.commit = 'e'.repeat(40);
  },
}))
  test(`metadata authentication rejects substituted ${label}`, async () => {
    const f = fixture();
    alter(f);
    await assert.rejects(authenticateDescriptor(f.descriptor, f));
  });
test('streaming transport rejects oversize and HTTP failures', async () => {
  await assert.rejects(
    readBytes('https://unit.test', {
      limit: 2,
      fetchArtifact: async () => new Response('long'),
    }),
    /size limit/u,
  );
  await assert.rejects(
    readBytes('https://unit.test', {
      fetchArtifact: async () => new Response('', { status: 503 }),
    }),
    /HTTP 503/u,
  );
});
