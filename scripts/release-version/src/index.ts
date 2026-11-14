import assembleReleasePlan from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import readChangesets from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';
import path from 'path';

async function run() {
  const cwd = process.cwd();
  const repoDir = path.join(cwd, '../../');
  const changesets = await readChangesets(repoDir, process.env.BASE_BRANCH);
  const packages = await getPackages(repoDir);
  const result = await readConfig(repoDir, packages);
  if (result.errors) {
    throw new Error(result.errors.join('\n'));
  }
  const config = result.config;
  const releasePlan = assembleReleasePlan(
    changesets,
    packages,
    config,
    undefined,
  );
  if (releasePlan.releases.length === 0) {
    return;
  }
  const releaseVersion = `v${
    releasePlan.releases.filter(
      release => !release.name.includes('generator'),
    )[0].newVersion
  }`;
  console.log(releaseVersion);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
