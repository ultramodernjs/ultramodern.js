import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertWindowsCoverage,
  excludeUnselected,
  generatorFiles,
  selectWindowsUnitFiles,
  windowsUnitConfig,
} from '../ci/windows-unit-selection.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'windows-selection-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'packages/example');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'rstest.config.mts'), 'fixture');
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: '@example/native' }),
  );
  const baseline = [
    ...generatorFiles.map(file => ({
      project: 'generator',
      testPath: path.join(root, file),
    })),
    { project: 'client', testPath: path.join(projectRoot, 'shared.test.ts') },
    { project: 'server', testPath: path.join(projectRoot, 'shared.test.ts') },
  ];
  return {
    root,
    projectRoot,
    baseline,
    base: { projects: ['packages/**/rstest.config.{ts,mts}'] },
  };
}

test('only the exact measured files leave the ordinary group', t => {
  const { root, baseline } = fixture(t);
  const similar = {
    project: 'other',
    testPath: path.join(root, `copies/${generatorFiles[0]}`),
  };
  const all = [...baseline, similar];
  assert.deepEqual(
    selectWindowsUnitFiles(root, all, 'generators'),
    baseline.slice(0, 2),
  );
  assert.deepEqual(selectWindowsUnitFiles(root, all, '1/4'), [
    ...baseline.slice(2),
    similar,
  ]);
  assert.throws(
    () => selectWindowsUnitFiles(root, baseline.slice(1), 'generators'),
    /missing/u,
  );
  assert.throws(() => selectWindowsUnitFiles(root, all, '5/4'), /Unknown/u);
});

test('coverage distinguishes projects for the same file and rejects missing, extra and duplicate work', t => {
  const { baseline } = fixture(t);
  assertWindowsCoverage(baseline, [
    [baseline[0]],
    [baseline[1]],
    [baseline[2]],
    [baseline[3]],
  ]);
  assert.throws(
    () => assertWindowsCoverage(baseline, [baseline.slice(0, 3)]),
    /Missing/u,
  );
  assert.throws(
    () => assertWindowsCoverage(baseline, [baseline, [baseline[0]]]),
    /more than once/u,
  );
  assert.throws(
    () =>
      assertWindowsCoverage(baseline, [
        [...baseline, { ...baseline[0], project: 'extra' }],
      ]),
    /Unexpected/u,
  );
  assert.throws(
    () => assertWindowsCoverage([...baseline, baseline[0]], [baseline]),
    /Duplicate baseline/u,
  );
});

test('selection retains native excludes and explicit default-override semantics without mutation', () => {
  for (const exclude of [
    undefined,
    ['browser.test.ts'],
    { patterns: ['dist/**'], override: true },
  ]) {
    const original = {
      exclude,
      include: ['tests/**/*.test.ts'],
      resolve: { conditionNames: ['browser'] },
    };
    const snapshot = structuredClone(original);
    const selected = excludeUnselected(original, ['/absolute/slow.test.ts']);
    assert.deepEqual(original, snapshot);
    assert.equal(selected.include, original.include);
    assert.equal(selected.resolve, original.resolve);
    assert.deepEqual(
      Array.isArray(selected.exclude)
        ? selected.exclude
        : selected.exclude.patterns,
      [
        ...(Array.isArray(exclude) ? exclude : (exclude?.patterns ?? [])),
        '/absolute/slow.test.ts',
      ],
    );
    if (exclude?.override) assert.equal(selected.exclude.override, true);
  }
});

test('native nested project options and extension objects survive both test groups', async t => {
  const { root, projectRoot, baseline, base } = fixture(t);
  const plugin = () => 'native compiler';
  const child = {
    name: 'client',
    root: projectRoot,
    include: ['shared.test.ts'],
    exclude: ['server-only.test.ts'],
    extends: { testEnvironment: 'happy-dom', testTimeout: 30000 },
    tools: { rspack: plugin },
  };
  const loadConfig = async () => ({
    content: {
      testTimeout: 1,
      extends: { testTimeout: 2 },
      projects: [child],
    },
  });
  for (const group of ['ordinary', 'generators']) {
    const config = await windowsUnitConfig(
      root,
      base,
      loadConfig,
      group,
      baseline,
    );
    const actual = config.projects[0];
    assert.equal(actual.name, child.name);
    assert.equal(actual.root, child.root);
    assert.equal(actual.include, child.include);
    assert.equal(actual.extends, child.extends);
    // Native Rstest also discards these containing-file defaults. Inheriting
    // them here would change the baseline's effective nested-project options.
    assert.equal(actual.testTimeout, undefined);
    assert.equal(actual.tools.rspack, plugin);
    assert.equal(actual.exclude[0], 'server-only.test.ts');
    assert.equal(child.exclude.length, 1);
    const extras = actual.exclude.slice(1);
    assert.deepEqual(
      extras,
      (group === 'ordinary'
        ? baseline.slice(0, 2).map(file => file.testPath)
        : [baseline[2].testPath]
      ).map(file => file.split(path.sep).join('/')),
    );
  }
});

test('single-project configs retain their native name and source root', async t => {
  const { root, projectRoot, baseline, base } = fixture(t);
  const config = await windowsUnitConfig(
    root,
    base,
    async () => ({ content: { include: ['src/*.test.ts'], globals: true } }),
    'ordinary',
    baseline,
  );
  assert.equal(config.projects[0].name, '@example/native');
  assert.equal(config.projects[0].root, projectRoot);
  assert.equal(config.projects[0].globals, true);
  assert.deepEqual(config.projects[0].include, ['src/*.test.ts']);
});

test('unsupported future project shapes fail instead of silently losing coverage', async t => {
  const { root, baseline, base } = fixture(t);
  await assert.rejects(
    windowsUnitConfig(
      root,
      { projects: [{}] },
      async () => ({}),
      'ordinary',
      baseline,
    ),
    /project config paths/u,
  );
  await assert.rejects(
    windowsUnitConfig(
      root,
      base,
      async () => ({ content: { projects: ['nested.config.mts'] } }),
      'ordinary',
      baseline,
    ),
    /Unsupported nested/u,
  );
  await assert.rejects(
    windowsUnitConfig(
      root,
      base,
      async () => ({ content: {} }),
      'typo',
      baseline,
    ),
    /Unknown Windows/u,
  );
});
