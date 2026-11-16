import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Request and response contracts: https://depot.dev/openapi/depot-ci/v1.json
const api = 'https://api.depot.dev/depot.ci.v1.CIService/';
const orgId = '882f0kcw25';
const repositories = new Set([
  'BleedingDev/ultramodern.js',
  'ultramodernjs/ultramodern.js',
]);
const pending = new Set(['queued', 'waiting', 'running']);
const terminal = new Set(['finished', 'failed', 'cancelled', 'skipped']);
const requiredJobs = new Map([
  ['check-dependencies', { count: 2, keys: ['check', 'advisories'] }],
  ['ci-cache', { count: 1, keys: ['seed'] }],
  // JobStatus.jobDisplayName is the resolved YAML `name:`. Matrix jobKey
  // suffixes are unspecified, so use the explicit matrix job names.
  [
    'integration-test',
    {
      count: 10,
      keys: [],
      names: [
        ...Array.from(
          { length: 6 },
          (_, index) => `integration-Linux (framework ${index + 1}/6)`,
        ),
        'integration-Linux (framework-generator-workspace)',
        'integration-Linux (framework-generator-bff)',
        'integration-Linux (rstest-adapter)',
        'integration-Linux (utils)',
      ],
    },
  ],
  ['lint-Linux', { count: 1, keys: ['lint-linux'] }],
  ['native-compatibility', { count: 1, keys: ['native-compatibility'] }],
  ['test-builder-e2e', { count: 1, keys: ['e2e-test'] }],
  ['type-check', { count: 1, keys: ['type-check'] }],
  ['ut-Linux', { count: 1, keys: ['ut-linux'] }],
  ['workflow-security', { count: 1, keys: ['workflow-security'] }],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkIdentity(value, runId) {
  assert(value?.orgId === orgId, 'Depot organization does not match');
  assert(value.runId === runId, 'Depot run ID does not match');
}

function checkStatus(value, label) {
  assert(
    pending.has(value) || terminal.has(value),
    `Unknown Depot ${label} status`,
  );
  assert(
    !['failed', 'cancelled', 'skipped'].includes(value),
    `Depot ${label} ${value}`,
  );
  return value === 'finished';
}

function pendingArray(value, status, label) {
  if (value === undefined && pending.has(status)) return [];
  assert(Array.isArray(value), `Depot ${label} are missing or malformed`);
  return value;
}

function finishedJobs(snapshot, workflow, required) {
  checkStatus(snapshot.status, 'run');
  const workflows = pendingArray(
    snapshot.workflows,
    snapshot.status,
    'workflows',
  );
  if (!workflows.length) {
    assert(snapshot.status !== 'finished', 'Depot finished without a workflow');
    return false;
  }
  assert(workflows.length === 1, 'Unexpected Depot workflows');
  const selected = workflows[0];
  const workflowBasename = path.basename(workflow);
  assert(
    selected.workflowPath === workflow ||
      selected.workflowPath === workflowBasename,
    'Depot workflow path does not match',
  );
  const workflowFinished = checkStatus(selected.status, 'workflow');
  assert(!selected.errorMessage, 'Depot workflow reported an error');
  const jobs = pendingArray(selected.jobs, selected.status, 'jobs');
  if (!jobs.length) {
    assert(!workflowFinished, 'Depot workflow finished without jobs');
    return false;
  }
  const identifiers = new Set();
  const keys = new Set();
  const names = new Set();
  let allFinished = true;
  for (const job of jobs) {
    assert(
      typeof job.jobId === 'string' && job.jobId && !identifiers.has(job.jobId),
      'Depot job IDs are missing or duplicated',
    );
    identifiers.add(job.jobId);
    keys.add(job.jobKey);
    names.add(job.jobDisplayName);
    const jobFinished = checkStatus(job.status, 'job');
    const attempts = pendingArray(job.attempts, job.status, 'job attempts');
    if (!attempts.length) {
      assert(!jobFinished, 'Depot job finished without an attempt');
      allFinished = false;
      continue;
    }
    const attemptNumbers = new Set();
    let latest;
    for (const attempt of attempts) {
      assert(
        Number.isInteger(attempt.attempt) &&
          attempt.attempt > 0 &&
          !attemptNumbers.has(attempt.attempt),
        'Depot attempt numbers are invalid',
      );
      attemptNumbers.add(attempt.attempt);
      assert(
        pending.has(attempt.status) || terminal.has(attempt.status),
        'Unknown Depot attempt status',
      );
      if (!terminal.has(attempt.status)) allFinished = false;
      if (!latest || attempt.attempt > latest.attempt) latest = attempt;
    }
    if (jobFinished) checkStatus(latest.status, 'attempt');
    allFinished &&= jobFinished && latest.status === 'finished';
  }
  if (snapshot.status === 'finished' && workflowFinished && allFinished) {
    assert(jobs.length >= required.count, 'Required Depot jobs are missing');
    assert(
      required.keys.every(
        key => keys.has(key) || keys.has(`${workflowBasename}:${key}`),
      ),
      'Required Depot job keys are missing',
    );
    assert(
      !required.names || required.names.every(name => names.has(name)),
      'Required Depot job names are missing',
    );
    return true;
  }
  return false;
}

export async function runDepotWorkflow({
  token,
  repository,
  repositoryId,
  sha,
  workflow,
  ref,
  signal,
  timeoutMs = 90 * 60 * 1000,
  pollMs = 5000,
  fetchImpl = fetch,
  log = console.log,
}) {
  assert(typeof token === 'string' && token.trim(), 'DEPOT_TOKEN is required');
  assert(repositories.has(repository), 'Unsupported GitHub repository');
  assert(repositoryId === '1151231350', 'GitHub repository ID does not match');
  assert(
    typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha),
    'A full GitHub SHA is required',
  );
  assert(
    typeof workflow === 'string' &&
      /^\.depot\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/u.test(workflow),
    'A Depot workflow path is required',
  );
  const required = requiredJobs.get(
    path.basename(workflow).replace(/\.ya?ml$/u, ''),
  );
  assert(required, 'Unsupported Depot workflow');
  assert(
    ref === undefined ||
      (typeof ref === 'string' && /^refs\/[\w./-]+$/u.test(ref)),
    'Invalid GitHub ref',
  );
  assert(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 6 * 60 * 60 * 1000,
    'Invalid Depot timeout',
  );
  assert(
    Number.isSafeInteger(pollMs) && pollMs > 0,
    'Invalid Depot poll interval',
  );
  const deadline = AbortSignal.timeout(timeoutMs);
  const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let ownedRun;
  let linkedWorkflowId;
  let completed = false;

  async function request(method, body, requestSignal = lifetime) {
    requestSignal.throwIfAborted();
    const bounded = AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(30_000),
    ]);
    let response;
    try {
      response = await fetchImpl(`${api}${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'Connect-Timeout-Ms': '30000',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: bounded,
      });
      assert(
        response.ok,
        `Depot ${method} failed with HTTP ${response.status}`,
      );
      return await response.json();
    } catch {
      // Do not print server bodies or transport errors: they can contain credentials.
      throw new Error(`Depot ${method} request failed`);
    }
  }

  try {
    const created = await request('Run', {
      repo: repository,
      sha,
      workflow,
      forge: 'FORGE_GITHUB',
      ...(ref === undefined ? {} : { ref }),
    });
    assert(
      typeof created?.runId === 'string' &&
        /^[a-zA-Z0-9_-]+$/u.test(created.runId),
      'Invalid Depot run ID',
    );
    ownedRun = created.runId;
    assert(created.orgId === orgId, 'Depot organization does not match');
    log(`Depot run ${ownedRun}`);

    while (true) {
      const identity = await request('GetRun', { runId: ownedRun });
      checkIdentity(identity, ownedRun);
      assert(identity.repo === repository, 'Depot repository does not match');
      assert(identity.sha === sha, 'Depot commit SHA does not match');
      checkStatus(identity.status, 'run');
      const snapshot = await request('GetRunStatus', { runId: ownedRun });
      checkIdentity(snapshot, ownedRun);
      lifetime.throwIfAborted();
      const finished = finishedJobs(snapshot, workflow, required);
      const workflowId = snapshot.workflows?.[0]?.workflowId;
      if (workflowId !== undefined) {
        assert(
          typeof workflowId === 'string' &&
            /^[a-zA-Z0-9_-]+$/u.test(workflowId),
          'Invalid Depot workflow ID',
        );
        assert(
          !linkedWorkflowId || linkedWorkflowId === workflowId,
          'Depot workflow ID changed',
        );
        if (!linkedWorkflowId) {
          linkedWorkflowId = workflowId;
          log(
            `Depot workflow: https://depot.dev/orgs/${orgId}/workflows/${workflowId}`,
          );
        }
      }
      if (finished && identity.status === 'finished') {
        completed = true;
        log(`Depot run ${ownedRun} finished successfully`);
        return { runId: ownedRun, orgId };
      }
      await delay(pollMs, undefined, { signal: lifetime });
    }
  } catch (error) {
    if (lifetime.aborted)
      throw new Error('Depot wait was cancelled or timed out');
    throw error;
  } finally {
    if (ownedRun && !completed) {
      // Only cancel the run returned by our own Run request, never a discovered run.
      try {
        const cancelled = await request(
          'CancelRun',
          { runId: ownedRun },
          AbortSignal.timeout(10_000),
        );
        assert(
          cancelled.runId === ownedRun && cancelled.status === 'cancelled',
          'Depot cancellation was not confirmed',
        );
      } catch {
        log(`Could not confirm cancellation of Depot run ${ownedRun}`);
      }
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    assert(
      process.env.GITHUB_ACTIONS === 'true',
      'This bridge must run in GitHub Actions',
    );
    assert(
      process.argv.length === 3,
      'Usage: node scripts/ci/run-depot-workflow.mjs .depot/workflows/<workflow>.yml',
    );
    await runDepotWorkflow({
      token: process.env.DEPOT_TOKEN,
      repository: process.env.GITHUB_REPOSITORY,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      sha: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF,
      workflow: process.argv[2],
      signal: controller.signal,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
