#!/usr/bin/env node
// Consumer: publish-bleedingdev.yml select-integration-evidence job.
//
// The publish runs integration-test.yml on the commit it releases. When the
// pull request that produced that commit already ran the same suites on a
// byte-identical tree, the tree pins the workflow file, every script it runs,
// the lockfile and the tests, so a second run repeats ~10 minutes of Windows
// and Linux shards on the same source. It does not pin everything a run
// depends on: the generator and fresh-consumer suites install third-party
// packages from the registry without a release-age wait, and runner images
// and the clock move. Reuse therefore accepts a result at most 24 hours old
// instead of one taken at publish time; the Linux acceptance legs still
// install against the registry at publish time. This selector finds that
// earlier run and lets the publish skip its own integration only when all of
// the following are proven, cheapest first. Anything unproven, and any API or
// download error, decides `run`, so the publish runs integration exactly as
// before.
//
//  - The publish commit is a merge commit; its second parent is the merged
//    pull request head. The run is looked up by that head, never by an input:
//    a dispatcher cannot point the publish at a run of their choice.
//  - The tested commit is GitHub's own record of what the run checked out:
//    the one `referenced_workflows` entry for the local payload workflow at
//    refs/pull/N/merge. Its tree must equal the publish commit's tree.
//  - Every Integration Test run of that pull request on this tree, under any
//    of its heads, is a same-repository pull_request run of
//    integration-test.yml, completed, green, and on its first attempt. A run
//    that went green by rerun, or a red or unfinished sample on the same tree,
//    is not evidence: the publish takes its own. An empty or amended retrigger
//    commit gives the same tree a new head, so the pull request's runs are
//    listed by its branch, not only by the merged head.
//  - The newest of them started at most 24 hours before this check runs, so a
//    re-run of an old publish cannot reuse old evidence.
//  - Every job ran and passed: the full integration matrix (counted from the
//    checked-out integration-test.yml, identical by tree), with only the
//    payload's cache-miss build jobs allowed to be skipped.
//  - The pull request ref holds no cache entry now. PR jobs only restore
//    caches (ci-cache.yml is the one writer, on main-ultramodern). This is a
//    listing at publish time: an entry written by an earlier head's modified
//    workflow and deleted again before the publish is not seen. Such an entry
//    could only make the reused run test other build output; the published
//    bytes are built from the tree by prepare-release, never from a cache the
//    integration run restored.
//  - The compiler payload the run tested and the payload of this publish run
//    carry byte-identical inventories ({source, targets}, every file digest),
//    each bound to its own producer run, attempt and commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const integrationWorkflowPath = '.github/workflows/integration-test.yml';
export const payloadWorkflowFile = 'effect-compiler-payload.yml';
export const maxEvidenceAgeMs = 24 * 60 * 60 * 1000;
// A pull request branch with more runs than this is not inspected: integration
// runs instead.
const maxRunPages = 10;

const shaPattern = /^[0-9a-f]{40}$/u;
const idPattern = /^[1-9][0-9]*$/u;
const repositoryPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const pullMergeRefPattern = /^refs\/pull\/([1-9][0-9]*)\/merge$/u;
const payloadJobPrefix = 'effect-compiler-payload / ';
const integrationJobPrefix = 'integration-';

class Unproven extends Error {}

const unproven = message => {
  throw new Unproven(message);
};

// The matrix entries of the checked-out integration-test.yml. The tree check
// makes this file byte-identical to the one the reused run executed, and the
// workflow validator pins every entry to one platform line.
export function countIntegrationMatrixJobs(workflowText) {
  return [...workflowText.matchAll(/^\s+- platform: (?:Linux|Windows)\s*$/gmu)]
    .length;
}

export function payloadInventoryDigest(manifest) {
  return createHash('sha256')
    .update(
      JSON.stringify({ source: manifest.source, targets: manifest.targets }),
    )
    .digest('hex');
}

function assertProducer(manifest, producer, label) {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.schemaVersion !== 1 ||
    !isDeepStrictEqual(manifest.producer, producer) ||
    manifest.targets === null ||
    typeof manifest.targets !== 'object' ||
    Array.isArray(manifest.targets) ||
    Object.keys(manifest.targets).length === 0
  ) {
    unproven(`${label} compiler payload is not bound to its own producer run`);
  }
}

function testedCommitOf(run, repository) {
  const references = Array.isArray(run.referenced_workflows)
    ? run.referenced_workflows
    : [];
  if (references.length !== 1) return null;
  const [reference] = references;
  if (
    !shaPattern.test(reference?.sha ?? '') ||
    reference.path !==
      `${repository}/.github/workflows/${payloadWorkflowFile}@${reference.sha}` ||
    !pullMergeRefPattern.test(reference.ref ?? '')
  ) {
    return null;
  }
  return { sha: reference.sha, ref: reference.ref };
}

// Every run a listing reports, across pages. A listing that changes while it
// is read, or has more pages than are inspected, is unproven.
async function listRuns(api, pathname, label) {
  const runs = new Map();
  for (let page = 1; page <= maxRunPages; page += 1) {
    const listing = await api(`${pathname}&per_page=100&page=${page}`);
    const pageRuns = Array.isArray(listing?.workflow_runs)
      ? listing.workflow_runs
      : [];
    if (!Number.isSafeInteger(listing?.total_count)) {
      unproven(`the Integration Test runs of ${label} could not be listed`);
    }
    for (const run of pageRuns) runs.set(run.id, run);
    if (pageRuns.length < 100 || runs.size >= listing.total_count) {
      if (runs.size !== listing.total_count) {
        unproven(
          `the Integration Test runs of ${label} changed while they were listed`,
        );
      }
      return [...runs.values()];
    }
  }
  unproven(
    `${label} has more than ${maxRunPages * 100} Integration Test runs to inspect`,
  );
}

/**
 * Decide whether this publish run may reuse a pull request's Integration Test
 * run. Never throws: any failure to prove reuse is a `run` decision.
 */
export async function selectIntegrationEvidence({
  api,
  context,
  expectedIntegrationJobs,
  readPayloadManifest,
  now = Date.now(),
}) {
  try {
    const { repository, runAttempt, runId, sha } = context;
    if (
      !repositoryPattern.test(repository ?? '') ||
      !shaPattern.test(sha ?? '') ||
      !idPattern.test(runId ?? '') ||
      !idPattern.test(runAttempt ?? '')
    ) {
      unproven('the publish run context is incomplete');
    }
    if (
      !Number.isSafeInteger(expectedIntegrationJobs) ||
      expectedIntegrationJobs < 1
    ) {
      unproven('the checked-out integration matrix could not be counted');
    }

    const publishCommit = await api(`/repos/${repository}/git/commits/${sha}`);
    const tree = publishCommit?.tree?.sha;
    const parents = (publishCommit?.parents ?? []).map(parent => parent.sha);
    if (!shaPattern.test(tree ?? '')) unproven('the publish tree is unknown');
    if (
      parents.length !== 2 ||
      !parents.every(parent => shaPattern.test(parent))
    ) {
      unproven(
        `publish commit ${sha} is not a pull request merge commit, so no pull request run can have tested its tree`,
      );
    }
    const head = parents[1];

    const workflow = await api(
      `/repos/${repository}/actions/workflows/integration-test.yml`,
    );
    if (
      workflow?.path !== integrationWorkflowPath ||
      !Number.isSafeInteger(workflow?.id)
    ) {
      unproven('the Integration Test workflow could not be identified');
    }
    const runsPath = `/repos/${repository}/actions/workflows/${workflow.id}/runs`;
    const headRuns = await listRuns(
      api,
      `${runsPath}?head_sha=${head}`,
      `pull request head ${head}`,
    );
    if (headRuns.length === 0) {
      unproven(`no Integration Test run tested pull request head ${head}`);
    }
    // The merged head's runs name its pull request and branch. The branch
    // listing then also covers the pull request's earlier heads.
    const pullRefs = new Set();
    const branches = new Set();
    for (const run of headRuns) {
      const tested = testedCommitOf(run, repository);
      if (!tested) {
        unproven(
          `Integration Test run ${run.id} of ${head} does not record which commit it tested`,
        );
      }
      pullRefs.add(tested.ref);
      branches.add(run.head_branch);
    }
    const [pullRef] = pullRefs;
    const [branch] = branches;
    if (
      pullRefs.size !== 1 ||
      branches.size !== 1 ||
      typeof branch !== 'string' ||
      branch === ''
    ) {
      unproven(
        `the Integration Test runs of ${head} do not name one pull request branch`,
      );
    }
    const runs = new Map(headRuns.map(run => [run.id, run]));
    for (const run of await listRuns(
      api,
      `${runsPath}?event=pull_request&branch=${encodeURIComponent(branch)}`,
      `branch ${branch}`,
    )) {
      runs.set(run.id, run);
    }

    const trees = new Map();
    const sameTree = [];
    for (const run of runs.values()) {
      const tested = testedCommitOf(run, repository);
      if (!tested) {
        unproven(
          `Integration Test run ${run.id} of branch ${branch} does not record which commit it tested`,
        );
      }
      // The same branch name may have served an earlier pull request.
      if (tested.ref !== pullRef) continue;
      if (!trees.has(tested.sha)) {
        const testedCommit = await api(
          `/repos/${repository}/git/commits/${tested.sha}`,
        );
        trees.set(tested.sha, testedCommit?.tree?.sha);
      }
      if (trees.get(tested.sha) === tree) sameTree.push({ run, tested });
    }
    if (sameTree.length === 0) {
      unproven(`no Integration Test run of ${pullRef} tested tree ${tree}`);
    }
    for (const { run } of sameTree) {
      if (
        run.repository?.full_name !== repository ||
        run.head_repository?.full_name !== repository ||
        run.event !== 'pull_request' ||
        run.path !== integrationWorkflowPath ||
        run.workflow_id !== workflow.id
      ) {
        unproven(
          `Integration Test run ${run.id} on this tree is not a pull_request run of this repository's integration-test.yml`,
        );
      }
      if (run.status !== 'completed' || run.conclusion !== 'success') {
        unproven(
          `Integration Test run ${run.id} on this tree is ${run.status}/${run.conclusion ?? 'none'}; the publish takes its own sample`,
        );
      }
      if (run.run_attempt !== 1) {
        unproven(
          `Integration Test run ${run.id} on this tree went green on attempt ${run.run_attempt}; a rerun is not evidence`,
        );
      }
    }
    const { run, tested } = sameTree.reduce((newest, item) =>
      item.run.id > newest.run.id ? item : newest,
    );

    // Measured at decision time: a re-run of this publish keeps its
    // created_at, so the run's own timestamps would let old evidence pass.
    const evidenceStarted = Date.parse(run.run_started_at ?? '');
    if (!Number.isFinite(now) || !Number.isFinite(evidenceStarted)) {
      unproven('run times are unknown');
    }
    const age = now - evidenceStarted;
    if (age < 0 || age > maxEvidenceAgeMs) {
      unproven(
        `Integration Test run ${run.id} started ${Math.round(age / 3_600_000)} h before this check; the limit is 24 h`,
      );
    }

    const jobs = await api(
      `/repos/${repository}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`,
    );
    const jobList = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
    if (jobs?.total_count !== jobList.length || jobList.length === 0) {
      unproven(
        `the jobs of Integration Test run ${run.id} could not be listed`,
      );
    }
    let integrationJobs = 0;
    let payloadJobs = 0;
    for (const job of jobList) {
      const name = String(job?.name ?? '');
      if (job?.status !== 'completed' || job?.run_attempt !== 1) {
        unproven(`job ${name} of run ${run.id} did not complete on attempt 1`);
      }
      if (name.startsWith(payloadJobPrefix)) {
        if (job.conclusion === 'success') payloadJobs += 1;
        else if (job.conclusion !== 'skipped') {
          unproven(`job ${name} of run ${run.id} is ${job.conclusion}`);
        }
      } else if (name.startsWith(integrationJobPrefix)) {
        if (job.conclusion !== 'success') {
          unproven(`job ${name} of run ${run.id} is ${job.conclusion}`);
        }
        integrationJobs += 1;
      } else {
        unproven(`run ${run.id} has an unexpected job ${name}`);
      }
    }
    if (payloadJobs === 0 || integrationJobs !== expectedIntegrationJobs) {
      unproven(
        `run ${run.id} ran ${integrationJobs} of ${expectedIntegrationJobs} integration jobs and ${payloadJobs} payload jobs`,
      );
    }

    const caches = await api(
      `/repos/${repository}/actions/caches?ref=${encodeURIComponent(tested.ref)}&per_page=1`,
    );
    if (caches?.total_count !== 0) {
      unproven(
        `${tested.ref} holds ${caches?.total_count ?? 'unknown'} cache entries; the reused run could have restored a pull-request-scoped build`,
      );
    }

    const testedPayload = await readPayloadManifest({
      runId: String(run.id),
      name: `effect-compiler-payload-${tested.sha}`,
    });
    assertProducer(
      testedPayload,
      {
        repository,
        workflow: payloadWorkflowFile,
        runId: String(run.id),
        runAttempt: '1',
        sourceCommit: tested.sha,
      },
      'the tested',
    );
    const ownPayload = await readPayloadManifest({
      runId,
      name: `effect-compiler-payload-${sha}`,
    });
    assertProducer(
      ownPayload,
      {
        repository,
        workflow: payloadWorkflowFile,
        runId,
        runAttempt,
        sourceCommit: sha,
      },
      "this run's",
    );
    const payloadSha256 = payloadInventoryDigest(testedPayload);
    if (payloadInventoryDigest(ownPayload) !== payloadSha256) {
      unproven(
        'the compiler payload of this run differs from the payload the reused run tested',
      );
    }

    return {
      decision: 'reuse',
      reason: `pull request run ${run.id} attempt 1 tested this exact tree, and no run of ${pullRef} on it failed or was rerun`,
      evidence: {
        runId: String(run.id),
        runAttempt: '1',
        testedCommit: tested.sha,
        tree,
        url: `${context.serverUrl}/${repository}/actions/runs/${run.id}`,
        payloadSha256,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: 'run',
      reason:
        error instanceof Unproven
          ? message
          : `the evidence check failed (${message})`,
      evidence: null,
    };
  }
}

export function createGithubApi({ apiUrl, token, fetchImpl = fetch }) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const api = async pathname => {
    const response = await fetchImpl(`${apiUrl}${pathname}`, { headers });
    if (!response.ok) {
      throw new Error(`GET ${pathname} returned ${response.status}`);
    }
    return response.json();
  };
  // Artifact zips redirect to signed blob storage; the token is sent to the
  // API only, never to the storage host.
  api.download = async (pathname, destination) => {
    const redirect = await fetchImpl(`${apiUrl}${pathname}`, {
      headers,
      redirect: 'manual',
    });
    const location = redirect.headers.get('location');
    if (redirect.status !== 302 || !location) {
      throw new Error(`GET ${pathname} returned ${redirect.status}`);
    }
    const response = await fetchImpl(location);
    if (!response.ok) {
      throw new Error(`artifact download returned ${response.status}`);
    }
    fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  };
  return api;
}

export function createPayloadManifestReader({ api, repository, workDir }) {
  return async ({ name, runId }) => {
    const listing = await api(
      `/repos/${repository}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
    );
    const artifacts = (listing?.artifacts ?? []).filter(
      artifact => artifact?.name === name,
    );
    if (artifacts.length !== 1 || artifacts[0].expired !== false) {
      unproven(`run ${runId} has ${artifacts.length} usable ${name} artifacts`);
    }
    const zip = path.join(workDir, `${runId}-${name}.zip`);
    await api.download(
      `/repos/${repository}/actions/artifacts/${artifacts[0].id}/zip`,
      zip,
    );
    const manifest = execFileSync('unzip', ['-p', zip, 'manifest.json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    fs.rmSync(zip, { force: true });
    return JSON.parse(manifest);
  };
}

export function renderOutputs(selection) {
  const evidence = selection.evidence ?? {};
  const oneLine = value => String(value ?? '').replace(/[\r\n]+/gu, ' ');
  return [
    `decision=${selection.decision}`,
    `reason=${oneLine(selection.reason)}`,
    `run_id=${evidence.runId ?? ''}`,
    `run_attempt=${evidence.runAttempt ?? ''}`,
    `tested_commit=${evidence.testedCommit ?? ''}`,
    `tree=${evidence.tree ?? ''}`,
    `url=${evidence.url ?? ''}`,
    `payload_sha256=${evidence.payloadSha256 ?? ''}`,
  ].join('\n');
}

export function renderSummary(selection) {
  const evidence = selection.evidence;
  if (selection.decision === 'reuse') {
    return [
      '## Integration reused',
      '',
      `Integration reused from [run ${evidence.runId}](${evidence.url}) attempt ${evidence.runAttempt}, tested commit \`${evidence.testedCommit}\`, tree \`${evidence.tree}\` = this commit's tree, compiler payload sha256 \`${evidence.payloadSha256}\`. This publish does not run the integration suites again.`,
      '',
    ].join('\n');
  }
  return [
    '## Integration runs in this publish',
    '',
    `No reusable Integration Test run: ${selection.reason}.`,
    '',
  ].join('\n');
}

async function main(argv, env) {
  if (argv[0] !== 'select' || argv.length !== 1) {
    throw new Error('usage: integration-evidence.mjs select');
  }
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required');
  const repository = env.GITHUB_REPOSITORY;
  const workDir = fs.mkdtempSync(
    path.join(env.RUNNER_TEMP || os.tmpdir(), 'integration-evidence-'),
  );
  try {
    const api = createGithubApi({
      apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
      token,
    });
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../..',
    );
    const selection = await selectIntegrationEvidence({
      api,
      context: {
        repository,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
        runId: env.GITHUB_RUN_ID,
        serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
        sha: env.GITHUB_SHA,
      },
      expectedIntegrationJobs: countIntegrationMatrixJobs(
        fs.readFileSync(path.join(repoRoot, integrationWorkflowPath), 'utf8'),
      ),
      readPayloadManifest: createPayloadManifestReader({
        api,
        repository,
        workDir,
      }),
    });
    const outputs = renderOutputs(selection);
    console.log(outputs);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${outputs}\n`);
    if (env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(selection));
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2), process.env).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
