// Consumer: publish-security in publish-bleedingdev.yml, through
// `workflow.mjs assert-previous-release-settled`. A live cohort reaches npm in
// its own run; its published checks run in accept-bleedingdev-release.yml,
// whose last job writes the GitHub release `ultramodern-v<version>` and only
// after every check passed. So the cohort npm serves at `latest` is accepted
// exactly when that release exists. Until then a new live cohort would move
// `latest` under its checks, which can then never pass again, so it may not
// start. The only other way out is the runbook's rollback: deprecating the
// broken cohort declares it withdrawn.
// No dependency install precedes publish-security: node built-ins only.
import { execFileSync } from 'node:child_process';

// The cohort member reject-published-source also anchors on.
export const anchorPackage = '@bleedingdev/modern-js-ultramodern-create';
export const acceptanceWorkflowPath =
  '.github/workflows/accept-bleedingdev-release.yml';
export const releaseTag = version => `ultramodern-v${version}`;

const isAcceptanceRun = run =>
  run.path === acceptanceWorkflowPath &&
  run.head_branch === 'main-ultramodern' &&
  run.event === 'workflow_dispatch';

// Returns { status: 'clear' | 'withdrawn' | 'blocked', message }. `withdrawn`
// lets the cohort start and must be reported as an error; `blocked` refuses it.
export function assessPreviousReleaseAcceptance({
  acceptanceRuns,
  packument,
  releaseFor,
  repository,
  serverUrl = 'https://github.com',
}) {
  const version = packument?.['dist-tags']?.latest;
  if (typeof version !== 'string') {
    return {
      status: 'clear',
      message: `${anchorPackage} has no live cohort at latest.`,
    };
  }
  const tag = releaseTag(version);
  if (releaseFor(tag)) {
    return {
      status: 'clear',
      message: `Live cohort ${version} was accepted: ${serverUrl}/${repository}/releases/tag/${tag}.`,
    };
  }
  const deprecated = packument.versions?.[version]?.deprecated;
  if (typeof deprecated === 'string' && deprecated !== '') {
    return {
      status: 'withdrawn',
      message: `Live cohort ${version} was never accepted (no release ${tag}) and was withdrawn by deprecation: "${deprecated}". This cohort replaces it.`,
    };
  }
  const runUrl = run => `${serverUrl}/${repository}/actions/runs/${run.id}`;
  const runs = acceptanceRuns()
    .filter(isAcceptanceRun)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const running = runs.find(run => run.status !== 'completed');
  const remedy = running
    ? `Its published acceptance ${runUrl(running)} is still ${running.status}; dispatch this cohort again once it is green.`
    : `${
        runs[0]
          ? `The newest published acceptance ${runUrl(runs[0])} concluded ${runs[0].conclusion}. `
          : ''
      }Re-run or re-dispatch the acceptance of the publish run that published ${version} (ROLLBACK-RUNBOOK.md section 5). If that cohort is broken, deprecate it (section 3) instead.`;
  return {
    status: 'blocked',
    message: `Live cohort ${version} has no release ${tag}, so nothing has accepted it yet. ${remedy}`,
  };
}

function ghApi(endpoint) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', endpoint], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    if (/HTTP 404/u.test(String(error?.stderr ?? ''))) return null;
    process.stderr.write(String(error?.stderr ?? ''));
    throw error;
  }
}

// The origin copy (`?write=true`): the CDN copy can trail a fresh `latest` or
// a fresh deprecation by minutes.
async function readAnchorPackument(fetchImpl) {
  const response = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(anchorPackage)}?write=true`,
    { cache: 'no-store', headers: { accept: 'application/json' } },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `${anchorPackage} registry metadata returned HTTP ${response.status}`,
    );
  }
  return response.json();
}

export async function readPreviousReleaseAcceptance(
  env,
  { api = ghApi, fetchImpl = globalThis.fetch } = {},
) {
  const repository = env.GITHUB_REPOSITORY;
  return assessPreviousReleaseAcceptance({
    acceptanceRuns: () =>
      api(
        `repos/${repository}/actions/workflows/accept-bleedingdev-release.yml/runs?branch=main-ultramodern&event=workflow_dispatch&per_page=100`,
      )?.workflow_runs ?? [],
    packument: await readAnchorPackument(fetchImpl),
    releaseFor: tag => api(`repos/${repository}/releases/tags/${tag}`),
    repository,
    serverUrl: env.GITHUB_SERVER_URL,
  });
}
