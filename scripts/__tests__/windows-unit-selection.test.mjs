import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertWindowsCoverage,
  excludeUnselected,
  generatorFiles,
  selectWindowsUnitFiles,
  windowsFileSeconds,
  windowsGeneratorLanes,
  windowsLaneSeconds,
  windowsLanes,
  windowsOrdinaryLanes,
  windowsUnitConfig,
  windowsUnitTimings,
  windowsUnmeasuredFileSeconds,
} from '../ci/windows-unit-selection.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const firstLane = windowsOrdinaryLanes[0];

// These assertions run in the Windows unit lane, and git checks .yml out with
// CRLF there: no .gitattributes entry declares workflow YAML as LF text. The
// subject is the YAML these files declare, not how the checkout ended its
// lines, so read them with the line endings normalised.
const readRepoText = file =>
  fs.readFileSync(path.join(repoRoot, file), 'utf8').replaceAll('\r\n', '\n');

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

// A baseline of the committed measurement itself: one project per measured
// file, so the lanes this builds are the lanes CI builds.
function measuredBaseline(root) {
  return Object.keys(windowsUnitTimings).map(file => ({
    project: 'measured',
    testPath: path.join(root, file),
  }));
}

test('only the exact measured files leave the ordinary lanes', t => {
  const { root, baseline } = fixture(t);
  const similar = {
    project: 'other',
    testPath: path.join(root, `copies/${generatorFiles[0]}`),
  };
  const all = [...baseline, similar];
  assert.deepEqual(
    windowsGeneratorLanes.flatMap(lane =>
      selectWindowsUnitFiles(root, all, lane),
    ),
    baseline.slice(0, 2),
  );
  const ordinary = windowsOrdinaryLanes.flatMap(lane =>
    selectWindowsUnitFiles(root, all, lane),
  );
  assert.deepEqual(new Set(ordinary), new Set([...baseline.slice(2), similar]));
  assert.throws(
    () =>
      selectWindowsUnitFiles(root, baseline.slice(1), windowsGeneratorLanes[0]),
    /missing/u,
  );
  assert.throws(
    () => selectWindowsUnitFiles(root, all, `${windowsLanes.length}/6`),
    /Unknown/u,
  );
});

test('each generator has a dedicated lane', t => {
  const { root, baseline } = fixture(t);
  assert.equal(windowsGeneratorLanes.length, generatorFiles.length);
  for (const [index, lane] of windowsGeneratorLanes.entries()) {
    assert.deepEqual(selectWindowsUnitFiles(root, baseline, lane), [
      baseline[index],
    ]);
  }
});

test('the lanes together run every identity exactly once', t => {
  const { root, baseline } = fixture(t);
  assertWindowsCoverage(
    baseline,
    windowsLanes.map(lane => selectWindowsUnitFiles(root, baseline, lane)),
  );
  // One file is one unit of work: a lane excludes paths, so both projects
  // that discovered shared.test.ts must land in the same lane.
  const shared = windowsOrdinaryLanes.filter(
    lane => selectWindowsUnitFiles(root, baseline, lane).length > 0,
  );
  assert.equal(shared.length, 1);
  assert.equal(selectWindowsUnitFiles(root, baseline, shared[0]).length, 2);
});

test('lanes balance measured cost instead of file count', t => {
  const { root } = fixture(t);
  const baseline = measuredBaseline(root);
  const ordinary = windowsOrdinaryLanes.map(lane =>
    windowsLaneSeconds(root, baseline, lane),
  );
  const total = ordinary.reduce((sum, seconds) => sum + seconds, 0);
  const ideal = total / windowsOrdinaryLanes.length;
  assert.ok(Math.max(...ordinary) <= ideal * 1.05, JSON.stringify(ordinary));
  // Each lane computes its own share with no runner talking to another, so
  // the assignment must not depend on the order rstest discovered the files.
  const reversed = [...baseline].reverse();
  for (const lane of windowsLanes) {
    const forward = selectWindowsUnitFiles(root, baseline, lane);
    const backward = selectWindowsUnitFiles(root, reversed, lane);
    assert.deepEqual(
      new Set(backward.map(entry => entry.testPath)),
      new Set(forward.map(entry => entry.testPath)),
    );
  }
  // Counting files instead would put the measured long poles together.
  const counts = windowsOrdinaryLanes.map(
    lane => selectWindowsUnitFiles(root, baseline, lane).length,
  );
  assert.ok(Math.max(...counts) > Math.min(...counts));
});

test('an unmeasured file costs the documented default', () => {
  const measured = Object.entries(windowsUnitTimings)[0];
  assert.equal(windowsFileSeconds(measured[0]), measured[1]);
  assert.equal(
    windowsFileSeconds('packages/example/tests/brand-new.test.ts'),
    windowsUnmeasuredFileSeconds,
  );
  assert.ok(windowsUnmeasuredFileSeconds > 0);
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

test('native nested project options and extension objects survive every lane', async t => {
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
  const shared = windowsOrdinaryLanes.find(
    lane => selectWindowsUnitFiles(root, baseline, lane).length > 0,
  );
  for (const lane of [shared, windowsGeneratorLanes[0]]) {
    const config = await windowsUnitConfig(
      root,
      base,
      loadConfig,
      lane,
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
      new Set(extras),
      new Set(
        baseline
          .filter(
            entry =>
              !selectWindowsUnitFiles(root, baseline, lane).includes(entry),
          )
          .map(file => file.testPath.split(path.sep).join('/')),
      ),
    );
  }
});

test('single-project configs retain their native name and source root', async t => {
  const { root, projectRoot, baseline, base } = fixture(t);
  const config = await windowsUnitConfig(
    root,
    base,
    async () => ({ content: { include: ['src/*.test.ts'], globals: true } }),
    firstLane,
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
      firstLane,
      baseline,
    ),
    /project config paths/u,
  );
  await assert.rejects(
    windowsUnitConfig(
      root,
      base,
      async () => ({ content: { projects: ['nested.config.mts'] } }),
      firstLane,
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

// Caching the resolved node_modules tree is the obvious lever against the
// 145 s `pnpm install --frozen-lockfile` every Windows job pays, and it does
// not work. pnpm links an isolated layout with NTFS junctions - 1293 inside
// node_modules, measured in run 43888513585 - and a restored reparse point is
// not a traversable junction, so the next frozen install dies on one:
//
//   ERR_PNPM_PACKAGE_MANAGER_INSPECT_OPTIONAL_DEPENDENCY
//     Failed to inspect optional dependency at
//     "...\node_modules\.pnpm\react-i18next@17.0.18_...\node_modules\typescript":
//     Access is denied. (os error 5)
//
// All 7 lanes of run 43891404231, deterministically. The archive itself was
// fine (2.1 GB of content, 480 MB compressed, 24 s to save), so the evidence
// a future attempt needs is not "is it too big" but "do junctions survive the
// transport" - and restoring 480 MB cost 69 s against the 31 s store restore
// it replaced, which caps the whole lever near 1.5 min even if they did.
test('no workflow caches a resolved node_modules tree', () => {
  const files = [
    '.github/actions/windows-dependencies/action.yml',
    '.github/workflows/ci-cache.yml',
    '.github/workflows/ut-Windows.yml',
    '.github/workflows/integration-test.yml',
  ];
  for (const file of files) {
    const content = readRepoText(file);
    const paths = [
      ...content.matchAll(/^\s*path: \|\n(?<list>(?:[^\S\n]*\S+\n)+)/gmu),
    ]
      .flatMap(match => match.groups.list.trim().split('\n'))
      .map(line => line.trim());
    const trees = paths.filter(line => line.endsWith('node_modules'));
    assert.deepEqual(
      trees,
      [],
      `${file} caches ${trees.join(', ')}; a restored NTFS junction graph is not traversable, so the next frozen install fails`,
    );
    assert.ok(
      !/windows-dependencies-v\d/u.test(content),
      `${file} still names the dependency-tree cache key`,
    );
  }
  // The store cache stays: it is what makes the install "reused 2218,
  // downloaded 0" rather than a download, and it round-trips as plain files.
  assert.match(
    readRepoText('.github/actions/windows-dependencies/action.yml'),
    /key: pnpm-store-\$\{\{ runner\.os \}\}/u,
  );
});

// A lane this module assigns but the matrix never dispatches would skip its
// files in silence, which is the one failure the coverage guard cannot see.
test('the Windows unit matrix dispatches exactly these lanes', () => {
  const workflow = readRepoText('.github/workflows/ut-Windows.yml');
  const matrix = /^\s*lane:\s*\[(?<lanes>[^\]]*)\]\s*$/mu.exec(workflow);
  assert.ok(matrix, 'ut-Windows.yml must declare a one-line lane matrix');
  const dispatched = matrix.groups.lanes.split(',');
  assert.deepEqual(
    dispatched.map(lane => lane.trim().replace(/^'|'$/gu, '')),
    windowsLanes,
    windowsGeneratorLanes,
  );
  assert.ok(
    workflow.includes(`if: matrix.lane == '${firstLane}'`),
    `the coverage verification must run on lane ${firstLane}`,
  );
});
