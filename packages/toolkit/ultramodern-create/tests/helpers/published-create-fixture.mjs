import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  collectModernPackages,
  rewritePackageJson,
} from '../../../../../scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/rewrite.mjs';

// Use the real publish projection, but materialize only create's runtime
// framework closure. Third-party bytes are reused; framework owners never link
// back to source manifests or resolve through the monorepo's node_modules.
export function createPublishedCreateFixture({
  installed,
  version,
  sidecars,
  requiredPackages,
}) {
  const options = {
    scope: 'bleedingdev',
    prefix: 'modern-js-',
    version,
    dependencyVersion: version,
    homepage: 'https://example.test/repo',
    bugsUrl: 'https://example.test/repo/issues',
    repositoryUrl: 'https://example.test/repo.git',
  };
  const { packages, sourceNames, aliases } = collectModernPackages(options);
  const byName = new Map(packages.map(item => [item.packageJson.name, item]));
  const rootName = '@modern-js/ultramodern-create';
  const owners = new Set([rootName]);
  for (const name of owners) {
    const owner = byName.get(name);
    assert(owner, `Missing framework fixture source ${name}`);
    for (const dependency of Object.keys({
      ...owner.packageJson.dependencies,
      ...owner.packageJson.optionalDependencies,
    })) {
      if (sourceNames.has(dependency)) owners.add(dependency);
    }
  }
  const cohortPackages = [...new Set([...requiredPackages, ...owners])]
    .sort()
    .map(sourceName => {
      assert(byName.has(sourceName), `Unknown fixture package ${sourceName}`);
      return { sourceName, targetName: aliases[sourceName], version };
    });
  const cohort = {
    aliases: Object.fromEntries(
      cohortPackages.map(item => [item.sourceName, item.targetName]),
    ),
    packages: cohortPackages,
    release: { tag: 'latest', version },
    schema: 'bleedingdev.ultramodern.release-cohort',
    schemaVersion: 2,
    sidecars,
    source: {
      commit: 'a'.repeat(40),
      repository: 'https://example.test/repo',
    },
  };
  for (const name of owners) {
    const owner = byName.get(name);
    const directory =
      name === rootName
        ? installed
        : path.join(installed, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    const manifest = structuredClone(owner.packageJson);
    rewritePackageJson(manifest, name, options, sourceNames);
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify(manifest),
    );
    for (const entry of ['dist', 'compiled', 'compiler', 'lib', 'bin']) {
      const source = path.join(owner.dir, entry);
      if (fs.existsSync(source))
        fs.cpSync(source, path.join(directory, entry), { recursive: true });
    }
    const require = createRequire(path.join(owner.dir, 'package.json'));
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      if (sourceNames.has(dependency)) continue;
      const source = require.resolve
        .paths(dependency)
        ?.map(directory => path.join(directory, dependency))
        .find(directory => fs.existsSync(path.join(directory, 'package.json')));
      if (!source) {
        assert(
          !Object.hasOwn(manifest.dependencies ?? {}, dependency),
          `Missing third-party fixture dependency ${name} -> ${dependency}`,
        );
        continue;
      }
      const link = path.join(directory, 'node_modules', dependency);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(fs.realpathSync(source), link, 'junction');
    }
  }
  fs.writeFileSync(
    path.join(installed, 'release-cohort.json'),
    JSON.stringify(cohort),
  );
  return cohort;
}
