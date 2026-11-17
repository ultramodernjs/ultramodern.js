// Consumer: publish-bleedingdev.yml select-integration-evidence job.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  countIntegrationMatrixJobs,
  createGithubApi,
  integrationWorkflowPath,
  payloadInventoryDigest,
  renderOutputs,
  renderSummary,
  selectIntegrationEvidence,
} from '../integration-evidence.mjs';

const repository = 'ultramodernjs/ultramodern.js';
const publishSha = 'a'.repeat(40);
const mainParent = 'b'.repeat(40);
const prHead = 'c'.repeat(40);
const testedSha = 'd'.repeat(40);
const otherTested = 'e'.repeat(40);
const tree = '1'.repeat(40);
const otherTree = '2'.repeat(40);
const workflowId = 368482011;
const integrationNames = [
  ...['Windows', 'Linux'].flatMap(platform => [
    ...[1, 2, 3, 4, 5, 6].map(
      shard => `integration-${platform} (framework ${shard}/6)`,
    ),
    `integration-${platform} (framework-generator-workspace)`,
    `integration-${platform} (framework-generator-bff)`,
    `integration-${platform} (rstest-adapter)`,
  ]),
  'integration-Linux (utils)',
];
const context = {
  repository,
  runAttempt: '1',
  runId: '500',
  serverUrl: 'https://github.com',
  sha: publishSha,
};
const targets = {
  'linux-x64': {
    executable: 'linux-x64/tsrs',
    files: [{ path: 'linux-x64/tsrs', sha256: 'f'.repeat(64) }],
  },
};
const source = { distribution: 'pinned' };
const manifestFor = (runId, runAttempt, sourceCommit, overrides = {}) => ({
  schemaVersion: 1,
  source,
  producer: {
    repository,
    workflow: 'effect-compiler-payload.yml',
    runId,
    runAttempt,
    sourceCommit,
  },
  targets,
  ...overrides,
});
const candidate = (overrides = {}) => ({
  id: 400,
  path: integrationWorkflowPath,
  workflow_id: workflowId,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  run_started_at: '2026-11-17T17:00:00Z',
  head_sha: prHead,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  referenced_workflows: [
    {
      path: `${repository}/.github/workflows/effect-compiler-payload.yml@${testedSha}`,
      sha: testedSha,
      ref: 'refs/pull/326/merge',
    },
  ],
  ...overrides,
});
const greenJobs = () => [
  {
    name: 'effect-compiler-payload / Effect compiler (cached identity)',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
  },
  {
    name: 'effect-compiler-payload / aggregate',
    status: 'completed',
    conclusion: 'skipped',
    run_attempt: 1,
  },
  ...integrationNames.map(name => ({
    name,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
  })),
];

function fixture({
  runs = [candidate()],
  jobs = greenJobs(),
  commitTrees = { [testedSha]: tree, [otherTested]: otherTree },
  parents = [mainParent, prHead],
  publishCreated = '2026-11-17T18:00:00Z',
  cacheCount = 0,
  manifests = {},
  failing = null,
} = {}) {
  const calls = [];
  const api = async pathname => {
    calls.push(pathname);
    if (failing && pathname.includes(failing)) {
      throw new Error(`GET ${pathname} returned 502`);
    }
    if (pathname === `/repos/${repository}/git/commits/${publishSha}`) {
      return { tree: { sha: tree }, parents: parents.map(sha => ({ sha })) };
    }
    const commit = /\/git\/commits\/([0-9a-f]{40})$/u.exec(pathname);
    if (commit) return { tree: { sha: commitTrees[commit[1]] } };
    if (
      pathname === `/repos/${repository}/actions/workflows/integration-test.yml`
    ) {
      return { id: workflowId, path: integrationWorkflowPath };
    }
    if (
      pathname.startsWith(
        `/repos/${repository}/actions/workflows/${workflowId}/runs?head_sha=${prHead}`,
      )
    ) {
      return { total_count: runs.length, workflow_runs: runs };
    }
    if (pathname === `/repos/${repository}/actions/runs/500`) {
      return { created_at: publishCreated };
    }
    if (
      pathname.startsWith(
        `/repos/${repository}/actions/runs/400/attempts/1/jobs`,
      )
    ) {
      return { total_count: jobs.length, jobs };
    }
    if (pathname.startsWith(`/repos/${repository}/actions/caches?ref=`)) {
      assert.match(pathname, /ref=refs%2Fpull%2F326%2Fmerge/u);
      return { total_count: cacheCount, actions_caches: [] };
    }
    throw new Error(`unexpected ${pathname}`);
  };
  const readPayloadManifest = async ({ name, runId }) => {
    calls.push(`payload ${runId} ${name}`);
    if (failing === 'payload')
      throw new Error('artifact download returned 500');
    const key = `${runId} ${name}`;
    if (Object.hasOwn(manifests, key)) return manifests[key];
    if (key === `400 effect-compiler-payload-${testedSha}`) {
      return manifestFor('400', '1', testedSha);
    }
    if (key === `500 effect-compiler-payload-${publishSha}`) {
      return manifestFor('500', '1', publishSha);
    }
    throw new Error(`no artifact ${key}`);
  };
  return { api, calls, readPayloadManifest };
}

const select = setup =>
  selectIntegrationEvidence({
    api: setup.api,
    context,
    expectedIntegrationJobs: integrationNames.length,
    readPayloadManifest: setup.readPayloadManifest,
  });

const assertRun = async (setup, pattern) => {
  const selection = await select(setup);
  assert.equal(selection.decision, 'run');
  assert.equal(selection.evidence, null);
  assert.match(selection.reason, pattern);
  return selection;
};

test('the checked-out integration matrix has the 19 jobs the validator pins', () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  const text = fs.readFileSync(
    path.join(root, integrationWorkflowPath),
    'utf8',
  );
  assert.equal(countIntegrationMatrixJobs(text), 19);
  assert.equal(integrationNames.length, 19);
});

test('reuses a first-attempt green same-repo run on the identical tree', async () => {
  const setup = fixture();
  const selection = await select(setup);
  assert.deepEqual(selection, {
    decision: 'reuse',
    reason: 'pull request run 400 attempt 1 tested this exact tree',
    evidence: {
      runId: '400',
      runAttempt: '1',
      testedCommit: testedSha,
      tree,
      url: `https://github.com/${repository}/actions/runs/400`,
      payloadSha256: payloadInventoryDigest(manifestFor('400', '1', testedSha)),
    },
  });
  assert.equal(
    renderOutputs(selection),
    [
      'decision=reuse',
      'reason=pull request run 400 attempt 1 tested this exact tree',
      'run_id=400',
      'run_attempt=1',
      `tested_commit=${testedSha}`,
      `tree=${tree}`,
      `url=https://github.com/${repository}/actions/runs/400`,
      `payload_sha256=${selection.evidence.payloadSha256}`,
    ].join('\n'),
  );
  assert.match(
    renderSummary(selection),
    /Integration reused from \[run 400\]/u,
  );
});

test('a publish commit without a pull request parent runs integration', async () => {
  await assertRun(
    fixture({ parents: [mainParent] }),
    /not a pull request merge commit/u,
  );
});

test('no run on the identical tree runs integration', async () => {
  await assertRun(
    fixture({
      runs: [
        candidate({
          referenced_workflows: [
            {
              path: `${repository}/.github/workflows/effect-compiler-payload.yml@${otherTested}`,
              sha: otherTested,
              ref: 'refs/pull/326/merge',
            },
          ],
        }),
      ],
    }),
    /tested tree/u,
  );
  await assertRun(fixture({ runs: [] }), /tested tree/u);
});

test('a run that does not record its tested commit runs integration', async () => {
  for (const referenced_workflows of [
    [],
    [
      {
        path: `other/repo/.github/workflows/effect-compiler-payload.yml@${testedSha}`,
        sha: testedSha,
        ref: 'refs/pull/326/merge',
      },
    ],
    [
      {
        path: `${repository}/.github/workflows/effect-compiler-payload.yml@${testedSha}`,
        sha: testedSha,
        ref: 'refs/heads/feature',
      },
    ],
  ]) {
    await assertRun(
      fixture({ runs: [candidate({ referenced_workflows })] }),
      /does not record which commit it tested/u,
    );
  }
});

test('a fork, push, or other-workflow run is never evidence', async () => {
  for (const overrides of [
    { head_repository: { full_name: 'someone/ultramodern.js' } },
    { repository: { full_name: 'someone/ultramodern.js' } },
    { event: 'workflow_dispatch' },
    { path: '.github/workflows/other.yml' },
    { workflow_id: 1 },
  ]) {
    await assertRun(
      fixture({ runs: [candidate(overrides)] }),
      /is not a pull_request run of this repository/u,
    );
  }
});

test('a red, unfinished or rerun sample on the same tree runs integration', async () => {
  await assertRun(
    fixture({ runs: [candidate({ conclusion: 'failure' })] }),
    /completed\/failure/u,
  );
  await assertRun(
    fixture({ runs: [candidate({ status: 'in_progress', conclusion: null })] }),
    /in_progress\/none/u,
  );
  await assertRun(
    fixture({ runs: [candidate({ run_attempt: 3 })] }),
    /went green on attempt 3; a rerun is not evidence/u,
  );
  // A green newer run does not hide an older red one on the same tree.
  await assertRun(
    fixture({
      runs: [candidate({ id: 401 }), candidate({ conclusion: 'failure' })],
    }),
    /run 400 on this tree is completed\/failure/u,
  );
});

test('evidence older than 24 hours runs integration', async () => {
  await assertRun(
    fixture({ publishCreated: '2026-11-18T17:00:01Z' }),
    /the limit is 24 h/u,
  );
  const fresh = await select(
    fixture({ publishCreated: '2026-11-18T17:00:00Z' }),
  );
  assert.equal(fresh.decision, 'reuse');
});

test('a skipped, failed, missing or copied integration job runs integration', async () => {
  const jobs = greenJobs();
  await assertRun(
    fixture({
      jobs: jobs.map(job =>
        job.name === 'integration-Windows (framework 2/6)'
          ? { ...job, conclusion: 'skipped' }
          : job,
      ),
    }),
    /integration-Windows \(framework 2\/6\) of run 400 is skipped/u,
  );
  await assertRun(
    fixture({
      jobs: jobs.map(job =>
        job.name === 'integration-Linux (utils)'
          ? { ...job, conclusion: 'failure' }
          : job,
      ),
    }),
    /is failure/u,
  );
  await assertRun(
    fixture({
      jobs: jobs.filter(job => job.name !== 'integration-Linux (utils)'),
    }),
    /ran 18 of 19 integration jobs/u,
  );
  await assertRun(
    fixture({
      jobs: jobs.map(job =>
        job.name ===
        'effect-compiler-payload / Effect compiler (cached identity)'
          ? { ...job, conclusion: 'skipped' }
          : job,
      ),
    }),
    /and 0 payload jobs/u,
  );
  await assertRun(
    fixture({
      jobs: jobs.map((job, index) =>
        index === 3 ? { ...job, run_attempt: 2 } : job,
      ),
    }),
    /did not complete on attempt 1/u,
  );
  await assertRun(
    fixture({
      jobs: [
        ...jobs,
        {
          name: 'smuggled',
          status: 'completed',
          conclusion: 'success',
          run_attempt: 1,
        },
      ],
    }),
    /unexpected job smuggled/u,
  );
});

test('a pull-request-scoped cache entry runs integration', async () => {
  await assertRun(fixture({ cacheCount: 1 }), /holds 1 cache entries/u);
});

test('the payload of either run must be bound to its own producer and identical', async () => {
  await assertRun(
    fixture({
      manifests: {
        [`400 effect-compiler-payload-${testedSha}`]: manifestFor(
          '400',
          '2',
          testedSha,
        ),
      },
    }),
    /the tested compiler payload is not bound/u,
  );
  await assertRun(
    fixture({
      manifests: {
        [`500 effect-compiler-payload-${publishSha}`]: manifestFor(
          '999',
          '1',
          publishSha,
        ),
      },
    }),
    /this run's compiler payload is not bound/u,
  );
  await assertRun(
    fixture({
      manifests: {
        [`500 effect-compiler-payload-${publishSha}`]: manifestFor(
          '500',
          '1',
          publishSha,
          {
            targets: {
              'linux-x64': {
                executable: 'linux-x64/tsrs',
                files: [{ path: 'linux-x64/tsrs', sha256: '0'.repeat(64) }],
              },
            },
          },
        ),
      },
    }),
    /differs from the payload the reused run tested/u,
  );
});

test('an API or download error runs integration and never throws', async () => {
  for (const failing of [
    '/git/commits/',
    '/actions/workflows/',
    '/attempts/1/jobs',
    '/actions/caches',
    'payload',
  ]) {
    await assertRun(fixture({ failing }), /the evidence check failed/u);
  }
});

test('an incomplete run context runs integration before any API call', async () => {
  const setup = fixture();
  const selection = await selectIntegrationEvidence({
    api: setup.api,
    context: { ...context, sha: 'HEAD' },
    expectedIntegrationJobs: 19,
    readPayloadManifest: setup.readPayloadManifest,
  });
  assert.equal(selection.decision, 'run');
  assert.deepEqual(setup.calls, []);
});

test('the payload is downloaded only after every API check passed', async () => {
  const setup = fixture({ cacheCount: 2 });
  await select(setup);
  assert.ok(!setup.calls.some(call => call.startsWith('payload ')));
});

test('artifact downloads never send the token to the storage host', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, authorization: init.headers?.authorization });
    if (url.startsWith('https://api.github.com/')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://blob.example/zip' },
      });
    }
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const api = createGithubApi({
    apiUrl: 'https://api.github.com',
    token: 'secret',
    fetchImpl,
  });
  const destination = path.join(
    fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'evidence-')),
    'a.zip',
  );
  await api.download('/repos/x/y/actions/artifacts/1/zip', destination);
  assert.deepEqual(requests, [
    {
      url: 'https://api.github.com/repos/x/y/actions/artifacts/1/zip',
      authorization: 'Bearer secret',
    },
    { url: 'https://blob.example/zip', authorization: undefined },
  ]);
  assert.deepEqual([...fs.readFileSync(destination)], [1, 2, 3]);
  fs.rmSync(path.dirname(destination), { recursive: true, force: true });
});
