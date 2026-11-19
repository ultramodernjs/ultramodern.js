import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UltramodernReleaseCohort } from '../src/ultramodern-release-cohort';
import { readBundledFrameworkManifests } from '../src/ultramodern-workspace/tooling-support';

const create = '@modern-js/ultramodern-create';
const tools = '@modern-js/fixture-tools';
const leaf = '@modern-js/fixture-leaf';

function fixture(published: boolean) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-owners-'));
  const packages = [create, tools, leaf].map(sourceName => ({
    sourceName,
    targetName: `@bleedingdev/modern-js-${sourceName.split('/')[1]}`,
    version: '3.11.3-ultramodern.6',
  }));
  const cohort: UltramodernReleaseCohort = {
    aliases: Object.fromEntries(
      packages.map(pkg => [pkg.sourceName, pkg.targetName]),
    ),
    packages,
    release: { tag: 'latest', version: '3.11.3-ultramodern.6' },
    schema: 'bleedingdev.ultramodern.release-cohort',
    schemaVersion: 2,
    sidecars: [],
    source: {
      repository: 'ultramodernjs/ultramodern.js',
      commit: 'a'.repeat(40),
    },
  };
  const roots = new Map(
    packages.map((pkg, index) => [
      pkg.sourceName,
      path.join(
        directory,
        'store',
        String(index),
        'node_modules',
        published ? pkg.targetName : pkg.sourceName,
      ),
    ]),
  );
  const root = (name: string) => {
    const value = roots.get(name);
    assert(value);
    return value;
  };
  const write = (name: string, changes: Record<string, unknown> = {}) => {
    const pkg = packages.find(pkg => pkg.sourceName === name);
    assert(pkg);
    const dependency =
      name === create ? tools : name === tools ? leaf : undefined;
    const manifest = {
      name: published ? pkg.targetName : name,
      version: pkg.version,
      ultramodern: published ? { sourceName: name } : undefined,
      dependencies: dependency
        ? {
            [dependency]: published
              ? `npm:${cohort.aliases[dependency]}@${pkg.version}`
              : 'workspace:*',
          }
        : {},
      peerDependencies: name === leaf ? { 'solid-js': '2.0.0' } : {},
      ...changes,
    };
    fs.mkdirSync(root(name), { recursive: true });
    fs.writeFileSync(
      path.join(root(name), 'package.json'),
      JSON.stringify(manifest),
    );
  };
  for (const pkg of packages) write(pkg.sourceName);
  for (const [owner, dependency] of [
    [create, tools],
    [tools, leaf],
  ]) {
    const siblingModules = path.dirname(path.dirname(root(owner)));
    const link = path.join(siblingModules, dependency);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(root(dependency), link, 'junction');
  }
  return {
    root: root(create),
    cohort: published ? cohort : undefined,
    write,
    dispose: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test.each([false, true])(
  'physical framework owners resolve their own unhoisted dependencies (published=%s)',
  published => {
    const f = fixture(published);
    try {
      const manifests = readBundledFrameworkManifests(f.root, f.cohort);
      assert.deepEqual([...manifests.keys()], [create, tools, leaf]);
      assert.equal(manifests.get(leaf)?.peerDependencies['solid-js'], '2.0.0');
    } finally {
      f.dispose();
    }
  },
);

test('workspace evidence rejects a differently named physical owner', () => {
  const f = fixture(false);
  try {
    f.write(tools, { name: '@modern-js/wrong-tools' });
    assert.throws(
      () => readBundledFrameworkManifests(f.root),
      /wrong workspace package identity/u,
    );
  } finally {
    f.dispose();
  }
});

test('published evidence rejects mixed versions, names, provenance and alias edges', () => {
  const f = fixture(true);
  try {
    for (const changes of [
      { version: '3.8.3' },
      { name: '@bleedingdev/modern-js-wrong-tools' },
      { ultramodern: { sourceName: '@modern-js/wrong-tools' } },
      { ultramodern: undefined },
    ]) {
      f.write(tools, changes);
      assert.throws(
        () => readBundledFrameworkManifests(f.root, f.cohort),
        /does not match the create release cohort/u,
      );
    }
    f.write(tools);
    f.write(create, {
      dependencies: {
        [tools]: 'npm:@bleedingdev/modern-js-fixture-tools@3.8.3',
      },
    });
    assert.throws(
      () => readBundledFrameworkManifests(f.root, f.cohort),
      /Framework edge.*does not match/u,
    );
  } finally {
    f.dispose();
  }
});
