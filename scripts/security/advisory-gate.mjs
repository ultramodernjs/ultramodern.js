#!/usr/bin/env node
// Consumers: check-dependencies.yml (the monorepo lockfile on every PR) and the
// ERP-10 acceptance profile (the lockfile generated from the release cohort).
//
// One general gate: `pnpm audit --prod` must report no high or critical
// advisory. It replaces per-package range floors in sidecars; a vulnerable
// version anywhere in the production closure fails here with the advisory and
// the fix, whichever package pulled it in.
//
// The repository picomatch correction is the only acknowledgement that is not
// an exception entry: it needs installed-byte proof from
// repository-correction.mjs, and only the repository CLI enables it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import processKit from '../lib/process-kit.js';
import {
  picomatchCorrection,
  prepareRepositoryCorrection,
} from './repository-correction.mjs';

const { runCommand } = processKit;

const auditArgs = Object.freeze([
  'audit',
  '--prod',
  '--audit-level=high',
  '--json',
]);
const gatedSeverities = new Set(['high', 'critical']);
const defaultExceptionsPath = fileURLToPath(
  new URL('./advisory-exceptions.json', import.meta.url),
);
const ghsaPattern = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function readAdvisoryExceptions(exceptionsPath = defaultExceptionsPath) {
  const entries = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
  if (!Array.isArray(entries)) {
    throw new Error(`${exceptionsPath} must contain an array of exceptions`);
  }
  const byId = new Map();
  for (const entry of entries) {
    // Only installed-byte proof may acknowledge a repository correction.
    if (entry?.id === picomatchCorrection.id) {
      throw new Error(
        `${exceptionsPath}: ${entry.id} is a repository correction and cannot be waived by an exception`,
      );
    }
    const keys = Object.keys(entry ?? {})
      .sort()
      .join(',');
    if (
      keys !== 'expires,id,package,parents,reason' ||
      !ghsaPattern.test(entry.id) ||
      typeof entry.package !== 'string' ||
      !Array.isArray(entry.parents) ||
      entry.parents.length === 0 ||
      !entry.parents.every(parent => typeof parent === 'string') ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length === 0 ||
      !datePattern.test(entry.expires)
    ) {
      throw new Error(
        `${exceptionsPath}: every exception needs exactly { id: GHSA-…, package, parents: [name, …], reason, expires: YYYY-MM-DD }; found ${JSON.stringify(entry)}`,
      );
    }
    if (byId.has(entry.id)) {
      throw new Error(`${exceptionsPath}: duplicate exception ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  return byId;
}

function parseAuditReport(result) {
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }
  if (
    !report ||
    typeof report.advisories !== 'object' ||
    report.advisories === null
  ) {
    const detail = [result.stderr, result.stdout, result.error?.message]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(
      `pnpm audit returned no advisory report (exit ${result.exitCode}); the gate cannot pass without one. Check registry reachability and rerun.\n${detail}`,
    );
  }
  return Object.values(report.advisories).filter(advisory =>
    gatedSeverities.has(advisory.severity),
  );
}

function findingPaths(advisory) {
  return (advisory.findings ?? []).flatMap(finding => finding.paths ?? []);
}

// An exception covers an advisory only in its package and only where one of
// its recorded parents pulls it in; any other path still blocks.
function uncoveredPaths(advisory, exception) {
  if (!exception || exception.package !== advisory.module_name) {
    return findingPaths(advisory);
  }
  return findingPaths(advisory).filter(
    dependencyPath =>
      !exception.parents.includes(dependencyPath.split('>').at(-2)),
  );
}

function formatAdvisory(advisory, via) {
  const versions = [
    ...new Set((advisory.findings ?? []).map(finding => finding.version)),
  ].join(', ');
  return [
    `${advisory.severity} ${advisory.github_advisory_id} ${advisory.module_name}@${versions}: ${advisory.title}`,
    `  vulnerable ${advisory.vulnerable_versions}, patched ${advisory.patched_versions}; ${advisory.url}`,
    ...(via ? [`  via ${via}`] : []),
    `  fix: pnpm update --recursive ${advisory.module_name}; if a parent pins it, upgrade the parent on the path above`,
  ].join('\n');
}

/**
 * Fails when the production closure of the lockfile in `cwd` has a high or
 * critical advisory that no unexpired exception acknowledges. Returns the
 * acknowledged advisories so receipts can record them.
 */
async function assertNoHighAdvisories({
  cwd,
  env,
  exceptionsPath = defaultExceptionsPath,
  now = new Date(),
  runCommandImpl = runCommand,
  allowRepositoryCorrections = false,
}) {
  const exceptions = readAdvisoryExceptions(exceptionsPath);
  const today = now.toISOString().slice(0, 10);
  const expired = [...exceptions.values()].filter(
    entry => entry.expires < today,
  );
  if (expired.length > 0) {
    throw new Error(
      `Advisory exceptions expired in ${path.relative(process.cwd(), exceptionsPath)}; fix the dependency and delete the entry, or renew it with a new reason:\n${expired
        .map(
          entry => `  ${entry.id} ${entry.package} (expired ${entry.expires})`,
        )
        .join('\n')}`,
    );
  }

  // Proven before the audit and rechecked after it, so the acknowledged
  // findings come from the same lockfile and installed bytes as the proof.
  const correction =
    allowRepositoryCorrections === true
      ? await prepareRepositoryCorrection({ cwd, now })
      : undefined;
  const policyBefore = fs.readFileSync(exceptionsPath);
  const advisories = parseAuditReport(
    runCommandImpl('pnpm', [...auditArgs], { cwd, env, stdio: 'pipe' }),
  );
  if (!fs.readFileSync(exceptionsPath).equals(policyBefore)) {
    throw new Error('Advisory policy changed during audit');
  }
  correction?.assertUnchanged();
  const acknowledged = [];
  const corrections = [];
  const blocking = [];
  for (const advisory of advisories) {
    const exception = exceptions.get(advisory.github_advisory_id);
    const uncovered = uncoveredPaths(advisory, exception);
    if (advisory.github_advisory_id === picomatchCorrection.id) {
      let refusal = 'repository correction is not enabled in this context';
      if (correction) {
        try {
          const { paths } = correction.acknowledges(advisory);
          acknowledged.push(advisory);
          corrections.push({ ...correction.proof, findingPaths: paths });
          continue;
        } catch (error) {
          refusal = error.message;
        }
      }
      blocking.push(
        `${formatAdvisory(advisory, findingPaths(advisory)[0])}\n  correction refused: ${refusal}`,
      );
    } else if (
      exception?.package === advisory.module_name &&
      findingPaths(advisory).length > 0 &&
      uncovered.length === 0
    ) {
      acknowledged.push(advisory);
    } else {
      blocking.push(formatAdvisory(advisory, uncovered[0]));
    }
  }
  if (blocking.length > 0) {
    throw new Error(
      `pnpm audit --prod found ${blocking.length} high or critical advisor${blocking.length === 1 ? 'y' : 'ies'}:\n${blocking.join('\n')}`,
    );
  }
  return {
    auditLevel: 'high',
    acknowledged: acknowledged.map(advisory => advisory.github_advisory_id),
    ...(corrections.length > 0 ? { corrections } : {}),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cwd = path.resolve(process.argv[2] ?? '.');
  try {
    const { acknowledged, corrections = [] } = await assertNoHighAdvisories({
      cwd,
      allowRepositoryCorrections: true,
    });
    for (const proof of corrections)
      console.log(
        JSON.stringify({
          id: proof.id,
          owner: proof.owner,
          reason: proof.reason,
          remediation: proof.remediation,
          expires: proof.expires,
          proofSha256: proof.proofSha256,
          versions: proof.versions,
          installedTargets: proof.targets.length,
          findingPaths: proof.findingPaths.length,
          sourceFiles: proof.sourceFiles.map(({ path, sha256 }) => ({
            path,
            sha256,
          })),
        }),
      );
    console.log(
      `No unacknowledged high or critical advisories in ${cwd}${
        acknowledged.length > 0
          ? ` (acknowledged: ${acknowledged.join(', ')})`
          : ''
      }`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { assertNoHighAdvisories, readAdvisoryExceptions };
