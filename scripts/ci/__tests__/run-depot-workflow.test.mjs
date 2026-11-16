import assert from 'node:assert/strict';
import test from 'node:test';
import { runDepotWorkflow } from '../run-depot-workflow.mjs';

const orgId = '882f0kcw25';
const runId = 'owned-run';
const repository = 'ultramodernjs/ultramodern.js';
const sha = 'a'.repeat(40);
const workflow = '.depot/workflows/type-check.yml';
const options = {
  token: 'private-token',
  repository,
  repositoryId: '1151231350',
  sha,
  workflow,
  ref: 'refs/pull/123/merge',
  timeoutMs: 1000,
  pollMs: 1,
};

function fixture(overrides = {}) {
  const calls = [];
  const logs = [];
  const identity = { orgId, runId, repo: repository, sha, status: 'finished' };
  const snapshot = {
    orgId,
    runId,
    status: 'finished',
    workflows: [
      {
        workflowId: 'owned-workflow',
        workflowPath: 'type-check.yml',
        status: 'finished',
        jobs: [
          {
            jobId: 'job-1',
            jobKey: 'type-check.yml:type-check',
            jobDisplayName: 'type-check',
            status: 'finished',
            attempts: [{ attempt: 1, status: 'finished' }],
          },
        ],
      },
    ],
  };
  const handlers = {
    Run: () => ({ orgId, runId }),
    GetRun: () => identity,
    GetRunStatus: () => snapshot,
    CancelRun: () => ({ runId, status: 'cancelled' }),
    ...overrides,
  };
  const fetchImpl = async (url, request) => {
    assert.equal(
      url.startsWith('https://api.depot.dev/depot.ci.v1.CIService/'),
      true,
    );
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer private-token');
    assert.equal(request.headers['Connect-Protocol-Version'], '1');
    const method = url.split('/').at(-1);
    const body = JSON.parse(request.body);
    calls.push({ method, body });
    const value = await handlers[method](body, request);
    return { ok: true, json: async () => value };
  };
  return {
    calls,
    logs,
    identity,
    snapshot,
    run: extra =>
      runDepotWorkflow({
        ...options,
        fetchImpl,
        log: value => logs.push(value),
        ...extra,
      }),
  };
}

test('dispatches one committed workflow with the exact GitHub SHA and no overrides', async () => {
  const api = fixture();
  assert.deepEqual(await api.run(), { orgId, runId });
  assert.deepEqual(api.calls, [
    {
      method: 'Run',
      body: {
        repo: repository,
        sha,
        workflow,
        forge: 'FORGE_GITHUB',
        ref: options.ref,
      },
    },
    { method: 'GetRun', body: { runId } },
    { method: 'GetRunStatus', body: { runId } },
  ]);
  assert.equal(api.logs.join('\n').includes(options.token), false);
  assert.equal(api.logs[0], `Depot run ${runId}`);
  assert.equal(
    api.logs[1],
    `Depot workflow: https://depot.dev/orgs/${orgId}/workflows/owned-workflow`,
  );
  assert.equal(api.logs.join('\n').includes('/ci/runs/'), false);
});

test('accepts only the exact full workflow path or basename and exact job key forms', async () => {
  for (const workflowPath of [workflow, 'type-check.yml']) {
    for (const jobKey of ['type-check', 'type-check.yml:type-check']) {
      const api = fixture();
      api.snapshot.workflows[0].workflowPath = workflowPath;
      api.snapshot.workflows[0].jobs[0].jobKey = jobKey;
      await api.run();
      assert.equal(
        api.calls.some(call => call.method === 'CancelRun'),
        false,
      );
      assert.equal(api.calls[0].body.workflow, workflow);
    }
  }
});

test('does not invent a workflow URL before its validated ID is available', async () => {
  const api = fixture();
  delete api.snapshot.workflows[0].workflowId;
  await api.run();
  assert.equal(
    api.logs.some(value => value.includes('https://')),
    false,
  );
});

test('rejects malformed workflow IDs before logging a URL', async () => {
  for (const workflowId of ['', null, '../other', 'other/thing', 'x?job=y']) {
    const api = fixture();
    api.snapshot.workflows[0].workflowId = workflowId;
    await assert.rejects(api.run(), /Invalid Depot workflow ID/);
    assert.equal(
      api.logs.some(value => value.includes('https://')),
      false,
    );
    assert.equal(api.calls.at(-1).method, 'CancelRun');
  }
});

test('waits for both the run and every job, even if the run reports finished first', async () => {
  let polls = 0;
  const api = fixture({
    GetRunStatus: () => {
      const snapshot = structuredClone(api.snapshot);
      if (polls++ === 0) {
        snapshot.workflows[0].jobs[0].status = 'running';
        snapshot.workflows[0].jobs[0].attempts[0].status = 'running';
      }
      return snapshot;
    },
  });
  await api.run();
  assert.equal(polls, 2);
  assert.equal(
    api.calls.some(call => call.method === 'CancelRun'),
    false,
  );
});

test('rejects a workflow ID that changes while waiting for jobs', async () => {
  let polls = 0;
  const api = fixture({
    GetRunStatus: () => {
      const snapshot = structuredClone(api.snapshot);
      if (polls++ === 0) {
        snapshot.workflows[0].jobs[0].status = 'running';
        snapshot.workflows[0].jobs[0].attempts[0].status = 'running';
      } else {
        snapshot.workflows[0].workflowId = 'another-workflow';
      }
      return snapshot;
    },
  });
  await assert.rejects(api.run(), /workflow ID changed/);
  assert.equal(api.calls.at(-1).method, 'CancelRun');
  assert.equal(
    api.logs.some(value => value.includes('/another-workflow')),
    false,
  );
});

for (const [field, value, message] of [
  ['orgId', 'another-org', /organization/],
  ['runId', 'another-run', /run ID/],
  ['repo', 'attacker/repository', /repository/],
  ['sha', 'b'.repeat(40), /commit SHA/],
]) {
  test(`rejects a mismatched ${field} and only cancels its own returned run`, async () => {
    const api = fixture();
    api.identity[field] = value;
    await assert.rejects(api.run(), message);
    assert.deepEqual(api.calls.at(-1), {
      method: 'CancelRun',
      body: { runId },
    });
  });
}

test('cancels its own created run even if Run returns the wrong organization', async () => {
  const api = fixture({
    Run: () => ({ orgId: 'another-org', runId: 'foreign-run' }),
    CancelRun: body => ({ runId: body.runId, status: 'cancelled' }),
  });
  await assert.rejects(api.run(), /organization/);
  assert.deepEqual(
    api.calls.map(call => call.method),
    ['Run', 'CancelRun'],
  );
  assert.deepEqual(api.calls.at(-1).body, { runId: 'foreign-run' });
});

test('rejects nested status from a different run and a different workflow', async () => {
  for (const mutate of [
    value => {
      value.runId = 'foreign-run';
    },
    value => {
      value.orgId = 'another-org';
    },
    value => {
      value.workflows[0].workflowPath = '.depot/workflows/other.yml';
    },
    value => {
      value.workflows.push(structuredClone(value.workflows[0]));
    },
  ]) {
    const api = fixture();
    mutate(api.snapshot);
    await assert.rejects(api.run(), /does not match|Unexpected/);
    assert.deepEqual(api.calls.at(-1), {
      method: 'CancelRun',
      body: { runId },
    });
  }
});

test('rejects workflow path aliases, traversal and an alternate basename', async () => {
  for (const workflowPath of [
    'other.yml',
    'type-check.yaml',
    '../type-check.yml',
    './type-check.yml',
    '.github/workflows/type-check.yml',
    '.depot/workflows/nested/type-check.yml',
    '.depot/workflows/../workflows/type-check.yml',
  ]) {
    const api = fixture();
    api.snapshot.workflows[0].workflowPath = workflowPath;
    await assert.rejects(api.run(), /workflow path does not match/);
    assert.equal(api.calls.at(-1).method, 'CancelRun');
  }
});

for (const status of ['failed', 'cancelled', 'skipped', 'unexpected']) {
  test(`a ${status} job never turns a required check green`, async () => {
    const api = fixture();
    api.snapshot.workflows[0].jobs[0].status = status;
    await assert.rejects(api.run(), /Depot job/);
    assert.equal(api.calls.at(-1).method, 'CancelRun');
  });
}

test('rejects an empty successful run, missing attempts, and unsuccessful latest attempts', async () => {
  for (const mutate of [
    value => {
      value.workflows = [];
    },
    value => {
      value.workflows[0].jobs = [];
    },
    value => {
      value.workflows[0].jobs[0].attempts = [];
    },
    value => {
      value.workflows[0].jobs[0].attempts[0].status = 'failed';
    },
    value => {
      value.workflows[0].errorMessage = 'secret server detail';
    },
  ]) {
    const api = fixture();
    mutate(api.snapshot);
    await assert.rejects(api.run());
    assert.equal(api.calls.at(-1).method, 'CancelRun');
    assert.equal(api.logs.join('\n').includes('secret server detail'), false);
  }
});

test('times out and cancels only the owned run with a fresh cancellation signal', async () => {
  const api = fixture({
    GetRun: () => ({ orgId, runId, repo: repository, sha, status: 'running' }),
    GetRunStatus: () => ({ orgId, runId, status: 'running', workflows: [] }),
    CancelRun: (_, request) => {
      assert.equal(request.signal.aborted, false);
      return { runId, status: 'cancelled' };
    },
  });
  await assert.rejects(api.run({ timeoutMs: 15 }), /timed out/);
  assert.deepEqual(api.calls.at(-1), { method: 'CancelRun', body: { runId } });
});

test('an abort during an API call cancels the run', async () => {
  const controller = new AbortController();
  const api = fixture({
    GetRun: (_, request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
        controller.abort();
      }),
  });
  await assert.rejects(api.run({ signal: controller.signal }), /cancelled/);
  assert.deepEqual(api.calls.at(-1), { method: 'CancelRun', body: { runId } });
});

test('API failures do not expose response or credential text', async () => {
  const api = fixture({
    GetRun: () => {
      throw new Error(`server echoed ${options.token}`);
    },
  });
  await assert.rejects(api.run(), error => {
    assert.equal(error.message, 'Depot GetRun request failed');
    return true;
  });
  assert.equal(api.logs.join('\n').includes(options.token), false);
  assert.equal(api.calls.at(-1).method, 'CancelRun');
});

test('rejects a successful workflow whose required job key is missing', async () => {
  const api = fixture();
  api.snapshot.workflows[0].jobs[0].jobKey = 'unrelated-job';
  await assert.rejects(api.run(), /Required Depot job keys/);
  assert.equal(api.calls.at(-1).method, 'CancelRun');
});

test('rejects required keys prefixed with another workflow or a path alias', async () => {
  for (const jobKey of [
    'other.yml:type-check',
    'type-check.yaml:type-check',
    '../type-check.yml:type-check',
    '.github/workflows/type-check.yml:type-check',
    '.depot/workflows/type-check.yml:type-check',
  ]) {
    const api = fixture();
    api.snapshot.workflows[0].jobs[0].jobKey = jobKey;
    await assert.rejects(api.run(), /Required Depot job keys/);
    assert.equal(api.calls.at(-1).method, 'CancelRun');
  }
});

test('dependency checks require both the dependency and advisory jobs', async () => {
  for (const keys of [
    ['check'],
    ['check', 'unrelated'],
    ['check', 'advisories'],
  ]) {
    const api = fixture();
    const selected = api.snapshot.workflows[0];
    selected.workflowPath = '.depot/workflows/check-dependencies.yml';
    selected.jobs = keys.map((jobKey, index) => ({
      jobId: `job-${index}`,
      jobKey: `check-dependencies.yml:${jobKey}`,
      status: 'finished',
      attempts: [{ attempt: 1, status: 'finished' }],
    }));
    const run = api.run({ workflow: selected.workflowPath });
    if (keys.includes('advisories')) await run;
    else
      await assert.rejects(run, /Required Depot jobs|Required Depot job keys/);
  }
});

test('integration requires every Linux suite without assuming matrix key suffixes', async () => {
  const names = [
    'integration-Linux (framework 1/6)',
    'integration-Linux (framework 2/6)',
    'integration-Linux (framework 3/6)',
    'integration-Linux (framework 4/6)',
    'integration-Linux (framework 5/6)',
    'integration-Linux (framework 6/6)',
    'integration-Linux (framework-generator-workspace)',
    'integration-Linux (framework-generator-bff)',
    'integration-Linux (rstest-adapter)',
    'integration-Linux (utils)',
  ];
  for (const selectedNames of [
    names.slice(0, 8),
    names.slice(0, 9),
    names.map((_, index) => `unrelated-${index}`),
    [...names.slice(0, 9), names[0]],
    names,
  ]) {
    const api = fixture();
    const selected = api.snapshot.workflows[0];
    selected.workflowPath = '.depot/workflows/integration-test.yml';
    selected.jobs = selectedNames.map((jobDisplayName, index) => ({
      jobId: `job-${index}`,
      jobKey: `matrix-key-format-${index}`,
      jobDisplayName,
      status: 'finished',
      attempts: [{ attempt: 1, status: 'finished' }],
    }));
    const run = api.run({ workflow: selected.workflowPath });
    if (selectedNames === names) await run;
    else
      await assert.rejects(run, /Required Depot jobs|Required Depot job names/);
  }
});

test('queued protobuf snapshots may omit empty workflows, jobs and attempts', async () => {
  let polls = 0;
  const api = fixture({
    GetRunStatus: () => {
      const snapshot = { orgId, runId, status: 'queued' };
      if (polls === 0) {
        polls++;
        return snapshot;
      }
      snapshot.workflows = [{ workflowPath: workflow, status: 'queued' }];
      if (polls === 1) {
        polls++;
        return snapshot;
      }
      snapshot.workflows[0].jobs = [
        { jobId: 'job-1', jobKey: 'type-check', status: 'queued' },
      ];
      if (polls === 2) {
        polls++;
        return snapshot;
      }
      polls++;
      return api.snapshot;
    },
  });
  await api.run();
  assert.equal(polls, 4);
  assert.equal(
    api.calls.some(call => call.method === 'CancelRun'),
    false,
  );
});

test('finished snapshots cannot omit repeated fields, and pending fields must be arrays when present', async () => {
  for (const mutate of [
    value => {
      delete value.workflows;
    },
    value => {
      delete value.workflows[0].jobs;
    },
    value => {
      delete value.workflows[0].jobs[0].attempts;
    },
    value => {
      value.status = 'queued';
      value.workflows = null;
    },
    value => {
      value.workflows[0].status = 'queued';
      value.workflows[0].jobs = {};
    },
    value => {
      value.workflows[0].jobs[0].status = 'queued';
      value.workflows[0].jobs[0].attempts = 'bad';
    },
  ]) {
    const api = fixture();
    mutate(api.snapshot);
    await assert.rejects(api.run(), /missing or malformed/);
    assert.equal(api.calls.at(-1).method, 'CancelRun');
  }
});

test('rejects invalid inputs before creating any run', async () => {
  for (const extra of [
    { token: '' },
    { repository: 'web-infra-dev/modern.js' },
    { repositoryId: 'another-repository' },
    { sha: 'main' },
    { sha: 'a'.repeat(39) },
    { workflow: '.depot/workflows/../../release.yml' },
    { workflow: '.github/workflows/type-check.yml' },
    { workflow: '.depot/workflows/release.yml' },
    { timeoutMs: 0 },
  ]) {
    const api = fixture();
    await assert.rejects(api.run(extra));
    assert.equal(api.calls.length, 0);
  }
});
