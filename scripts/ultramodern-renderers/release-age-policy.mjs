import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { releaseAgeExemptions } from '../ultramodern-production-readiness/published-create-proof/release-age-audit.mjs';
import { defaultReleaseAgePolicyPath } from '../ultramodern-publish/run-release-acceptance.mjs';

function workspaceFile(directory) {
  for (
    let current = path.resolve(directory);
    ;
    current = path.dirname(current)
  ) {
    const filename = path.join(current, 'pnpm-workspace.yaml');
    if (fs.existsSync(filename)) return filename;
    if (current === path.dirname(current))
      return path.join(path.resolve(directory), 'pnpm-workspace.yaml');
  }
}

function policySnapshot(filename) {
  const policy = fs.existsSync(filename)
    ? parseYaml(fs.readFileSync(filename, 'utf8'))
    : {};
  const values = policy?.minimumReleaseAgeExclude ?? [];
  assert(
    Array.isArray(values) && values.every(value => typeof value === 'string'),
    'Release-age exclusions must be a list',
  );
  assert.equal(
    policy.minimumReleaseAge,
    1440,
    'Consumer workspace must retain minimumReleaseAge 1440',
  );
  assert.equal(
    policy.minimumReleaseAgeStrict,
    true,
    'Consumer workspace must retain strict release age',
  );
  assert(
    policy.minimumReleaseAgeIgnoreMissingTime === undefined ||
      policy.minimumReleaseAgeIgnoreMissingTime === false,
    'Consumer workspace cannot ignore missing publication times',
  );
  return [...values].sort();
}

/** Record reviewed exclusions before pnpm can automatically add exemptions. */
export function captureReleaseAgeExclusions(
  directory,
  { release, policyPath = defaultReleaseAgePolicyPath } = {},
) {
  const filename = workspaceFile(directory);
  const baseline = policySnapshot(filename);
  const allowed = new Set(releaseAgeExemptions(release, { policyPath }));
  for (const selector of baseline)
    assert(
      allowed.has(selector),
      `Unreviewed release-age exclusion: ${selector}`,
    );
  return { filename, exclusions: baseline };
}

export function assertReleaseAgeExclusionsUnchanged(baseline) {
  assert.deepEqual(
    policySnapshot(baseline.filename),
    baseline.exclusions,
    'pnpm changed the reviewed release-age exclusions; newly added exemptions cannot qualify a consumer',
  );
}
