import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { compareHydrationTrees } from './compare-hydration.mjs';
import {
  applyExact,
  assemblePackage,
  assertSameBytes,
  buildEnvironment,
  octane20RuntimeInputs,
  packagePatch,
  phaseTracker,
  qualifyRuntimeTree,
} from './qualify-runtime.mjs';
import {
  assertionInventory,
  historicalLoadSuites,
  recoveredHistoricalSuites,
  summarizeSelectiveHydration,
} from './qualify-selective-hydration.mjs';

test('selective summary cannot convert recovered scope into full historical acceptance', () => {
  const summary = summarizeSelectiveHydration({
    sourceCommit: 'control',
    inventory: [{ tree: 'baseline', suites: ['range-boundary.test.ts'] }],
    results: [],
  });
  assert.equal(summary.historicalEvidenceComplete, false);
  assert.equal(summary.unresolvedHistoricalFailureCountDifference, 29);
  assert.equal(recoveredHistoricalSuites.length, 11);
  assert.equal(summary.inventory[0].totalHydrationSuites, 1);
  assert.equal(
    summary.inventory[0].recoveredHistoricalScope.filter(entry => entry.present)
      .length,
    1,
  );
});

test('selective diagnostic preserves exact assertion names and suite-load evidence', () => {
  assert.equal(historicalLoadSuites.length, 3);
  assert.deepEqual(
    assertionInventory(
      {
        testResults: [
          {
            name: '/operation/packages/octane/tests/hydration/range-boundary.test.ts',
            message: 'Failed to resolve import "octane/behavior"',
            assertionResults: [],
          },
          {
            name: '/operation/packages/octane/tests/hydration/unclosed-range.test.ts',
            assertionResults: [
              {
                fullName: 'preserves range (nested: true, dev: true)',
                status: 'failed',
                failureMessages: ['actual ownership failure'],
              },
            ],
          },
        ],
      },
      '/operation',
    ),
    [
      {
        suite: 'packages/octane/tests/hydration/range-boundary.test.ts',
        loadError: 'Failed to resolve import "octane/behavior"',
        assertions: [],
      },
      {
        suite: 'packages/octane/tests/hydration/unclosed-range.test.ts',
        loadError: null,
        assertions: [
          {
            name: 'preserves range (nested: true, dev: true)',
            status: 'failed',
            errors: ['actual ownership failure'],
          },
        ],
      },
    ],
  );
});

test('selective qualifier rejects test-name filters instead of weakening whole suites', () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests inside owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'suite-boundary-'),
  );
  try {
    fs.mkdirSync(path.join(root, 'packages/octane'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages/octane/package.json'),
      '{"exports":{}}',
    );
    for (const suites of [
      [],
      ['**/*.test.ts'],
      ['range-boundary'],
      ['../outside.test.ts'],
    ])
      assert.throws(() =>
        qualifyRuntimeTree(
          root,
          root,
          undefined,
          () => {
            assert.fail('Invalid selection must not execute');
          },
          { suites },
        ),
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('build environment cannot inherit publication tokens or policy bypasses', () => {
  assert.deepEqual(
    buildEnvironment({
      PATH: '/bin',
      HOME: '/home/builder',
      CI: 'true',
      GITHUB_TOKEN: 'must-not-reach-build',
      NODE_OPTIONS: '--require injected.js',
      NPM_CONFIG_IGNORE_SCRIPTS: 'false',
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    }),
    { PATH: '/bin', HOME: '/home/builder', CI: 'true' },
  );
});

test('composed TS worker inputs preserve the consumed correction bytes', () => {
  for (const [file, expected] of [
    [
      'typescript-source.patch',
      '71898145840705e712954009bf5a94877302181ac2aef3ece3ec907cd17404cc',
    ],
    [
      'native-signals-source.patch',
      '057a5f475311f5c2c437773c15c658b024b583b13d94f1e6958f6453ccc9558f',
    ],
    [
      'volar-core-source.patch',
      'e2384c2a171989340e9ceb85bdbf0ac1d4e3a26a30154a0e920503b8cb9b254f',
    ],
  ]) {
    const bytes = fs.readFileSync(
      new URL(`typescript-compat/${file}`, import.meta.url),
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  }
});

test('differential receipt rejects a new failure and a missing baseline assertion', () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests inside owned-temp-dir');
  const work = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR),
      'differential-test-',
    ),
  );
  try {
    const baselineRoot = path.join(work, 'baseline'),
      composedRoot = path.join(work, 'composed');
    for (const root of [baselineRoot, composedRoot]) {
      fs.mkdirSync(path.join(root, 'packages/octane'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'packages/octane/package.json'),
        JSON.stringify({ exports: { '.': './src/index.ts' } }),
      );
    }
    function executeFor(status, name = 'retains server query') {
      return (_command, args, cwd) => {
        const failure = cwd === composedRoot && status === 'failed';
        fs.writeFileSync(
          args
            .find(arg => arg.startsWith('--outputFile='))
            .slice('--outputFile='.length),
          JSON.stringify({
            numPassedTests: failure ? 0 : 1,
            numFailedTests: failure ? 1 : 0,
            numTotalTestSuites: 1,
            testResults: [
              {
                name: `${cwd}/returned-jsx-query-resume.test.ts`,
                assertionResults: [
                  {
                    fullName:
                      cwd === composedRoot ? name : 'retains server query',
                    status: failure ? 'failed' : 'passed',
                  },
                ],
              },
            ],
          }),
        );
      };
    }
    const options = {
      baselineRoot,
      composedRoot,
      modules: path.join(work, 'node_modules'),
      qualifyTree: qualifyRuntimeTree,
      work: path.join(work, 'reports'),
    };
    assert.throws(
      () =>
        compareHydrationTrees({ ...options, execute: executeFor('failed') }),
      /regresses latest hydration/,
    );
    assert.throws(
      () =>
        compareHydrationTrees({
          ...options,
          execute: executeFor('passed', 'another assertion'),
        }),
      /identical assertions/,
    );
    assert.deepEqual(
      compareHydrationTrees({ ...options, execute: executeFor('passed') }),
      {
        baseline: { passed: 1, failed: 0, suites: 1 },
        composed: { passed: 1, failed: 0, suites: 1 },
        introducedFailures: [],
      },
    );
    assert.deepEqual(fs.readdirSync(options.work), []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('npm layout reconstruction preserves identity and actual compiler/map/license outputs', () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests inside owned-temp-dir');
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(process.env.OWNED_TEMP_DIR), 'recipe-test-'),
  );
  try {
    const upstream = path.join(work, 'original'),
      source = path.join(work, 'source');
    const built = path.join(work, 'built'),
      reconstructed = path.join(work, 'reconstructed');
    fs.mkdirSync(path.join(upstream, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(source, 'dist/compiler'), { recursive: true });
    fs.writeFileSync(
      path.join(upstream, 'package.json'),
      JSON.stringify({
        name: 'octane',
        version: '0.18.0',
        dependencies: { '@tsrx/core': '^0.5.5', esrap: '^2.3.2' },
        peerDependencies: { '@tsrx/oxc': '^0.8.0', typescript: '>=7.1.0-0' },
      }),
    );
    fs.writeFileSync(path.join(upstream, 'LICENSE'), 'upstream license');
    fs.writeFileSync(
      path.join(upstream, 'dist/index.js'),
      'old emitted runtime',
    );
    const emitted = {
      'index.js': 'export const runtime = "emitted";\n',
      'index.d.ts': 'export declare const runtime: "emitted";\n',
      'index.d.ts.map':
        '{"version":3,"sources":["../src/index.ts"],"mappings":""}\n',
      'compiler/volar.LICENSES.txt': '@tsrx/core@0.6.1\nlicense bytes\n',
    };
    for (const [file, bytes] of Object.entries(emitted))
      fs.writeFileSync(path.join(source, 'dist', file), bytes);
    assemblePackage(upstream, source, built, '0.18.0');
    const patch = packagePatch(upstream, built);
    assert(
      !patch.includes(Buffer.from(work)),
      'No operation path in canonical diff',
    );
    const patchPath = path.join(work, 'package.patch');
    fs.writeFileSync(patchPath, patch);
    fs.cpSync(upstream, reconstructed, { recursive: true });
    applyExact(reconstructed, patchPath);
    for (const [file, bytes] of Object.entries(emitted))
      assert.equal(
        fs.readFileSync(path.join(reconstructed, 'dist', file), 'utf8'),
        bytes,
      );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(reconstructed, 'package.json')),
    );
    assert.equal(manifest.name, 'octane');
    assert.equal(manifest.version, '0.18.0');
    assert.equal(manifest.dependencies['@tsrx/core'], '^0.6.1');
    assert.equal(manifest.dependencies.esrap, '^2.4.0');
    assert.equal(
      fs.readFileSync(path.join(reconstructed, 'LICENSE'), 'utf8'),
      'upstream license',
    );
    assert.deepEqual(packagePatch(upstream, reconstructed), patch);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('canonical package patch bytes do not depend on the user Git configuration', () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests inside owned-temp-dir');
  const work = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'patch-config-'),
  );
  try {
    const original = path.join(work, 'original');
    const built = path.join(work, 'built');
    fs.mkdirSync(original);
    fs.mkdirSync(built);
    fs.writeFileSync(
      path.join(original, 'index.js'),
      '3\n2\n3\n0\n2\n2\n1\n1\n3\n0\n2\n1\n0\n0\n1\n4\n1\n0\n1\n4\n',
    );
    fs.writeFileSync(
      path.join(built, 'index.js'),
      '1\n2\n3\n4\n3\n3\n4\n3\n3\n0\n4\n3\n1\n1\n3\n4\n0\n0\n1\n1\n',
    );
    const rawDiff = algorithm =>
      spawnSync(
        'git',
        [
          'diff',
          '--no-index',
          `--diff-algorithm=${algorithm}`,
          original,
          built,
        ],
        { encoding: 'utf8' },
      ).stdout;
    assert.notEqual(rawDiff('myers'), rawDiff('histogram'));
    const generate = (name, config) => {
      const home = path.join(work, name);
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, '.gitconfig'), config);
      return execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { packagePatch } from ${JSON.stringify(new URL('./qualify-runtime.mjs', import.meta.url).href)};
           process.stdout.write(packagePatch(${JSON.stringify(original)}, ${JSON.stringify(built)}));`,
        ],
        { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home } },
      );
    };
    const canonical = generate('clean', '');
    const workstation = generate(
      'workstation',
      '[diff]\nalgorithm = histogram\n',
    );
    const foreign = generate(
      'foreign',
      '[diff]\nalgorithm = myers\ncontext = 0\nnoprefix = true\nindentHeuristic = false\n',
    );
    assertSameBytes(canonical, workstation, 'clean vs workstation');
    assertSameBytes(canonical, foreign, 'clean vs foreign configuration');
    assert(canonical.toString().startsWith('diff --git a/index.js b/index.js'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('patch-size byte mismatch fails promptly with offset and digests, never a rendered diff', () => {
  const expected = Buffer.alloc(2 * 1024 ** 2, 'a');
  const actual = Buffer.from(expected);
  actual[1234567] = 0x62;
  assertSameBytes(Buffer.from(expected), expected, 'equal control');
  const started = Date.now();
  assert.throws(
    () => assertSameBytes(actual, expected, 'octane: expected patch'),
    error =>
      /^octane: expected patch: bytes differ from offset 1234567; actual 2097152 bytes sha256 [0-9a-f]{64}, expected 2097152 bytes sha256 [0-9a-f]{64}$/u.test(
        error.message,
      ),
  );
  assert.throws(
    () => assertSameBytes(expected.subarray(0, 10), expected, 'prefix'),
    /prefix: bytes differ from offset 10; actual 10 bytes/u,
  );
  assert(Date.now() - started < 5000, 'Mismatch report must stay bounded');
});

test('phase tracker reports the failed phase, last command and signal without replacing the error', () => {
  const lines = [];
  const phases = phaseTracker(line => lines.push(line));
  const calls = [];
  const execute = phases.trace((...args) => {
    calls.push(args);
    return 'ok';
  });
  phases.enter('install owning dependencies');
  assert.equal(
    execute('pnpm', ['install'], '/work/deps', { stdio: 'pipe' }),
    'ok',
  );
  assert.deepEqual(calls, [
    ['pnpm', ['install'], '/work/deps', { stdio: 'pipe' }],
  ]);
  phases.enter('packed hydration suites');
  execute(
    'node',
    ['vitest.mjs', 'run', '--config', 'packed.mjs'],
    '/work/source',
  );
  const failure = Object.assign(
    new Error('Command failed: node vitest.mjs\nmore'),
    {
      status: null,
      signal: 'SIGKILL',
    },
  );
  phases.fail(failure);
  assert.match(
    lines[0],
    /^\[octane-runtime\] install owning dependencies: started\n$/u,
  );
  assert.match(
    lines[1],
    /^\[octane-runtime\] install owning dependencies: passed in \d+\.\ds\n$/u,
  );
  assert.match(
    lines[2],
    /^\[octane-runtime\] packed hydration suites: started\n$/u,
  );
  assert.match(
    lines[3],
    /^\[octane-runtime\] packed hydration suites: FAILED after \d+\.\ds; last command: node vitest\.mjs run --config packed\.mjs \(cwd \/work\/source\); exit none; signal SIGKILL; Command failed: node vitest\.mjs\n$/u,
  );
  assert.equal(lines.length, 4);
});

test('the Octane 0.20 owning candidate selects its own runtime package, dependencies and output identity', t => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests inside owned-temp-dir');
  const inputs = octane20RuntimeInputs();
  assert.deepEqual(
    inputs.packages.map(({ name, version }) => [name, version]),
    [
      ['octane', '0.20.0'],
      ['@octanejs/rspack-plugin', '0.2.12'],
    ],
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(inputs.dependencyDirectory, 'runtime-build-package.json'),
      'utf8',
    ),
  );
  assert.equal(manifest.dependencies.octane, inputs.packages[0].version);
  assert.equal(
    inputs.runtimePair.octane.patchPath,
    'patches/octane@0.20.0.patch',
  );
  assert.equal(
    inputs.runtimePair['@octanejs/rspack-plugin'].patchPath,
    'patches/@octanejs__rspack-plugin@0.2.12.patch',
  );
  for (const patch of inputs.patches) assert.ok(fs.statSync(patch).isFile());
  const work = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'octane020-'),
  );
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const upstream = path.join(work, 'upstream');
  const source = path.join(work, 'source');
  const output = path.join(work, 'output');
  fs.mkdirSync(upstream);
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(upstream, 'package.json'),
    JSON.stringify({
      name: 'octane',
      version: '0.20.0',
      dependencies: {},
      peerDependencies: {},
    }),
  );
  fs.writeFileSync(
    path.join(source, 'dist/index.js'),
    'export const built = true;\n',
  );
  assemblePackage(upstream, source, output, inputs.packages[0].version);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8'))
      .version,
    '0.20.0',
  );
  assert.equal(
    fs.readFileSync(path.join(output, 'dist/index.js'), 'utf8'),
    'export const built = true;\n',
  );
});
