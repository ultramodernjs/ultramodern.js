import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertReleaseAgeExclusionsUnchanged,
  captureReleaseAgeExclusions,
} from './release-age-policy.mjs';

const release = {
  release: { version: '3.9.3-ultramodern.42' },
  packages: [
    { targetName: '@bleedingdev/modern-test', version: '3.9.3-ultramodern.42' },
  ],
};
const reviewed = '@bleedingdev/modern-test@3.9.3-ultramodern.42';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-age-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'pnpm-workspace.yaml');
  const write = (exclusions = [reviewed], policy = {}) =>
    fs.writeFileSync(
      filename,
      JSON.stringify({
        packages: ['.'],
        minimumReleaseAge: 1440,
        minimumReleaseAgeStrict: true,
        minimumReleaseAgeIgnoreMissingTime: false,
        minimumReleaseAgeExclude: exclusions,
        ...policy,
      }),
    );
  write();
  return { root, filename, write };
}
test('preserves exactly reviewed initial exemptions', t => {
  const { root, filename } = fixture(t);
  const baseline = captureReleaseAgeExclusions(root, { release });
  const policy = JSON.parse(fs.readFileSync(filename));
  policy.packageImportMethod = 'clone-or-copy';
  fs.writeFileSync(filename, JSON.stringify(policy));
  assertReleaseAgeExclusionsUnchanged(baseline);
});
test('rejects automatically added exemptions after install', t => {
  const { root, write } = fixture(t);
  const baseline = captureReleaseAgeExclusions(root, { release });
  write([reviewed, 'newly-published@1.0.0']);
  assert.throws(
    () => assertReleaseAgeExclusionsUnchanged(baseline),
    /newly added exemptions cannot qualify/u,
  );
});
for (const selector of [
  'newly-published@1.0.0',
  '@bleedingdev/*',
  '@bleedingdev/modern-test@*',
])
  test(`rejects pre-existing unreviewed exemption ${selector}`, t => {
    const { root, write } = fixture(t);
    write([selector]);
    assert.throws(
      () => captureReleaseAgeExclusions(root, { release }),
      /Unreviewed release-age exclusion/u,
    );
  });
for (const policy of [
  { minimumReleaseAge: 0 },
  { minimumReleaseAgeStrict: false },
  { minimumReleaseAgeIgnoreMissingTime: true },
])
  test(`rejects weakened initial policy ${JSON.stringify(policy)}`, t => {
    const { root, write } = fixture(t);
    write([reviewed], policy);
    assert.throws(
      () => captureReleaseAgeExclusions(root, { release }),
      /retain|cannot ignore/u,
    );
  });
test('rejects missing workspace policy', t => {
  const { root, filename } = fixture(t);
  fs.rmSync(filename);
  assert.throws(
    () => captureReleaseAgeExclusions(root, { release }),
    /retain minimumReleaseAge/u,
  );
});
test('a generated nested consumer compares its owning workspace', t => {
  const { root, filename, write } = fixture(t);
  const nested = path.join(root, 'apps/shell');
  fs.mkdirSync(nested, { recursive: true });
  const baseline = captureReleaseAgeExclusions(nested, { release });
  assert.equal(baseline.filename, filename);
  write([]);
  assert.throws(
    () => assertReleaseAgeExclusionsUnchanged(baseline),
    /reviewed release-age exclusions/u,
  );
});
