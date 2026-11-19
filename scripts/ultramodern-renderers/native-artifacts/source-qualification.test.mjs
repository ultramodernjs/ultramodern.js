import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { octane20RuntimeInputs } from '../octane-corrections/qualify-runtime.mjs';
import { fixture } from './fixtures.test-support.mjs';
import { sha256 } from './protocol.mjs';
import {
  completedRecipes,
  composeRecipe,
  releaseRecipe,
  runtimeRecipes,
} from './recipes.mjs';
import {
  assertOwningLicense,
  assertRouterBuildLock,
  assertSameLayout,
  assertToolchain,
  buildEnvironment,
  builtPatch,
  ownedQualification,
  owningLicenses,
  qualificationToolchains,
  qualifyAdapterSource,
  qualifyRouterSource,
  qualifyRuntimePairSource,
  unpackNpm,
} from './source-qualification.mjs';

assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir');
function root(t) {
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'recipe-controls-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('completed recipes select actual reviewed router and adapter provenance and complete npm patches', () => {
  const { packages, provenance } = completedRecipes();
  assert.deepEqual(Object.keys(packages).sort(), [
    '@octanejs/tanstack-router',
    '@tanstack/router-core',
  ]);
  assert.equal(
    packages['@tanstack/router-core'].patchSha256,
    provenance.patchSha256,
  );
  assert.equal(
    packages['@octanejs/tanstack-router'].patchSha256,
    '91bcdd98a1f5c45bff8e495541570b646719bdef2d8b7861fc98d4f3a49643ea',
  );
  assert.equal(
    packages['@octanejs/tanstack-router'].upstream.commit,
    '1cdd9d2027bef63e6cec601952795e9ed84e1344',
  );
  assert.equal(Object.keys(releaseRecipe().packages).length, 4);
});
test('inventory imports do not load the owning runtime build implementation', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { registerHooks } from 'node:module';
       registerHooks({ resolve(specifier, context, next) {
         const resolved = next(specifier, context);
         assert.notEqual(resolved.url, ${JSON.stringify(new URL('../octane-corrections/qualify-runtime.mjs', import.meta.url).href)},
           'Inventory must not load the owning runtime implementation');
         return resolved;
       } });
       await import(${JSON.stringify(new URL('./recipes.mjs', import.meta.url).href)});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
test('completed recipes reject a changed canonical patch or provenance rather than measuring a new pin', t => {
  const directory = owningTree(t);
  const original = completedRecipes({ root: directory });
  const adapter = original.packages['@octanejs/tanstack-router'];
  assert.equal(
    adapter.patchPath,
    path.join(
      directory,
      candidateDirectory,
      '@octanejs__tanstack-router@0.3.6.shared-core-peer.patch',
    ),
  );
  fs.appendFileSync(adapter.patchPath, 'tamper');
  assert.throws(
    () => completedRecipes({ root: directory }),
    /differs from owning/u,
  );
  const provenance = path.join(
    directory,
    'scripts/ultramodern-renderers/router-corrections/provenance.json',
  );
  fs.writeFileSync(
    provenance,
    JSON.stringify({ ...original.provenance, patchSha256: 'f'.repeat(64) }),
  );
  assert.throws(
    () => completedRecipes({ root: directory }),
    /reviewed owning build/u,
  );
});
test('owning build toolchain is exact, independent of the root pnpm', () => {
  assertToolchain(qualificationToolchains.router);
  for (const bad of [
    { node: '26.13.0', pnpm: '11.21.0' },
    { node: '26.13.1', pnpm: '12.21.0' },
    { node: '26.13.1', pnpm: '11.21.1' },
  ])
    assert.throws(() => assertToolchain(bad));
});
test('build subprocesses get no workflow/npm token or inherited package-manager overrides', () => {
  const env = buildEnvironment({
    PATH: '/unit/tools',
    HOME: '/unit/home',
    GH_TOKEN: 'not-a-real-token',
    GITHUB_TOKEN: 'unit',
    NPM_TOKEN: 'unit',
    npm_config_registry: 'unit',
    PNPM_HOME: 'unit',
    NODE_OPTIONS: 'unit',
    OTHER_SECRET: 'unit',
    AWS_ACCESS_KEY_ID: 'unit',
  });
  assert.deepEqual(env, {
    PATH: '/unit/tools',
    HOME: '/unit/home',
  });
});
test('owning workspace is removed on toolchain mismatch and failed suite, without touching its parent', async t => {
  const directory = root(t);
  fs.writeFileSync(path.join(directory, 'caller'), 'preserve');
  await assert.rejects(
    ownedQualification(
      directory,
      'bad-toolchain',
      () => assert.fail('must not qualify'),
      { execute: () => '12.21.0\n' },
    ),
    /pnpm 11.21.0/u,
  );
  await assert.rejects(
    ownedQualification(
      directory,
      'failed-suite',
      () => {
        throw new Error('actual suite failed');
      },
      { execute: () => '11.21.0\n' },
    ),
    /actual suite failed/u,
  );
  assert.deepEqual(fs.readdirSync(directory), ['caller']);
});
test('layout proof detects missing output, byte and executable-mode drift', t => {
  const directory = root(t);
  const a = path.join(directory, 'a');
  const b = path.join(directory, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'file'), 'same', { mode: 0o644 });
  fs.writeFileSync(path.join(b, 'file'), 'same', { mode: 0o644 });
  assertSameLayout(a, b);
  fs.chmodSync(path.join(b, 'file'), 0o755);
  assert.throws(() => assertSameLayout(a, b), /mode differs/u);
  fs.chmodSync(path.join(b, 'file'), 0o644);
  fs.writeFileSync(path.join(b, 'file'), 'other');
  assert.throws(() => assertSameLayout(a, b), /bytes differ/u);
  fs.unlinkSync(path.join(b, 'file'));
  assert.throws(() => assertSameLayout(a, b), /layout differs/u);
});
test('actual build diff contains normalized npm paths, not temporary host identities', t => {
  const directory = root(t);
  const a = path.join(directory, 'before');
  const b = path.join(directory, 'after');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'index.js'), 'old\n');
  fs.writeFileSync(path.join(b, 'index.js'), 'new\n');
  const diff = builtPatch(a, b).toString();
  assert.match(diff, /--- a\/index.js\n\+\+\+ b\/index.js/u);
  assert(!diff.includes(directory));
});
test('built patch bytes are the reviewed histogram diff under any user git configuration', t => {
  const directory = root(t);
  const a = path.join(directory, 'before');
  const b = path.join(directory, 'after');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(
    path.join(a, 'index.js'),
    'x\nx\n{\n}\n{\ny\n}\n1\n2\n3\n4\n5\n6\n7\nold\n',
  );
  fs.writeFileSync(
    path.join(b, 'index.js'),
    'y\nz\nx\nz\ny\n1\n2\n3\n4\n5\n6\n7\nnew\n',
  );
  const clean = path.join(directory, 'clean-home');
  const adversarial = path.join(directory, 'adversarial-home');
  fs.mkdirSync(clean);
  fs.mkdirSync(adversarial);
  fs.writeFileSync(
    path.join(adversarial, '.gitconfig'),
    '[diff]\n\talgorithm = patience\n\tindentHeuristic = false\n\tcontext = 1\n\tinterHunkContext = 4\n\tnoprefix = true\n[core]\n\tabbrev = 16\n[color]\n\tdiff = always\n',
  );
  const home = process.env.HOME;
  t.after(() => {
    process.env.HOME = home;
  });
  const expected =
    'diff --git a/index.js b/index.js\nindex 410d0bfd9c..ea8dfbc8f5 100644\n--- a/index.js\n+++ b/index.js\n@@ -1,10 +1,8 @@\n-x\n-x\n-{\n-}\n-{\n y\n-}\n+z\n+x\n+z\n+y\n 1\n 2\n 3\n@@ -12,4 +10,4 @@ y\n 5\n 6\n 7\n-old\n+new\n';
  for (const candidate of [clean, adversarial]) {
    process.env.HOME = candidate;
    assert.equal(builtPatch(a, b).toString(), expected);
    const ambient = spawnSync('git', ['diff', '--no-index', a, b], {
      env: { PATH: process.env.PATH, HOME: candidate },
      encoding: 'utf8',
    }).stdout;
    assert.notEqual(
      ambient.slice(ambient.indexOf('@@')),
      expected.slice(expected.indexOf('@@')),
      'control: an unpinned diff of this fixture has other hunks',
    );
  }
});
test('unpacks the full npm layout without executing a package script', t => {
  const directory = root(t);
  const f = fixture();
  const target = path.join(directory, 'package');
  const inspected = unpackNpm(f.payloads.get('octane-0.20.0.tgz'), target);
  assert.equal(inspected.packageJson.name, 'octane');
  assert(fs.existsSync(path.join(target, 'LICENSE')));
});
test('composition couples source and packed owning suites to exact archives and provenance', async t => {
  const directory = root(t);
  const completed = completedRecipes();
  const calls = [];
  const runtime = {
    packages: runtimeRecipes().packages,
    async qualifySource(options) {
      calls.push(['runtime-source', options]);
      return {};
    },
    async qualifyPacked(options) {
      calls.push(['runtime-packed', options]);
    },
  };
  const stub = name => async options => {
    calls.push([name, options]);
    return {
      sourceArchiveBytes: Buffer.from('unit'),
      builtPatchBytes: Buffer.from('unit'),
      licenseBytes: Buffer.from('unit'),
    };
  };
  const recipe = composeRecipe({
    completed,
    runtime,
    qualifyRouter: stub('router'),
    qualifyAdapter: stub('adapter'),
  });
  const options = {
    directory: '/unit/exact-downloaded-archives',
    workDirectory: '/unit/owned',
  };
  await recipe.qualifyPacked(options);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['router', 'adapter', 'runtime-packed'],
  );
  for (const [, options] of calls.slice(0, 2))
    assert.equal(options.packedDirectory, '/unit/exact-downloaded-archives');
  calls.length = 0;
  await assert.rejects(
    recipe.qualifySource({ workDirectory: directory }),
    /qualification cohort/u,
  );
  assert.equal(calls[0][0], 'runtime-source');
  runtime.packages.octane.upstream.commit = 'f'.repeat(40);
  assert.throws(
    () =>
      composeRecipe({
        completed,
        runtime,
      }),
    /source differs/u,
  );
});

test('router source build lock is coupled to its reviewed actual build, not regenerated at qualification', () => {
  const bytes = fs.readFileSync(
    new URL('../router-corrections/build-lock.yaml', import.meta.url),
  );
  assertRouterBuildLock(bytes);
  assert.throws(
    () => assertRouterBuildLock(Buffer.concat([bytes, Buffer.from('tamper')])),
    /build lock differs/u,
  );
});

test('mixed owning toolchains accept only each owner’s exact Node/pnpm pair', () => {
  for (const [owner, expected] of Object.entries(qualificationToolchains)) {
    assertToolchain(expected, owner);
    const other = expected.pnpm === '11.21.0' ? '12.21.0' : '11.21.0';
    assert.throws(
      () => assertToolchain({ ...expected, pnpm: other }, owner),
      /owning build needs pnpm/u,
    );
    assert.throws(
      () => assertToolchain({ ...expected, node: '26.13.0' }, owner),
      /Node toolchain/u,
    );
  }
  assert.throws(
    () => assertToolchain({ node: '26.13.1', pnpm: '12.21.0' }, 'unreviewed'),
    /Unknown native owning toolchain/u,
  );
});

test('mixed owner binary routing fails before an owning operation with the wrong pnpm', async t => {
  const directory = root(t);
  for (const owner of ['router', 'adapter', 'runtime']) {
    const expected = qualificationToolchains[owner];
    const binary = `/unit/pnpm-${expected.pnpm}`;
    const calls = [];
    let operations = 0;
    const execute = (command, args, options) => {
      calls.push({ command, args, options });
      return `${expected.pnpm}\n`;
    };
    await ownedQualification(
      directory,
      owner,
      ({ run, pnpmBinary }) => {
        operations++;
        assert.equal(pnpmBinary, binary);
        run('pnpm', ['exec', 'unit-owning-suite']);
      },
      { owner, execute, pnpmBinary: binary },
    );
    assert.equal(operations, 1);
    assert(calls.every(call => call.command === binary));
    assert.deepEqual(calls[0].args, ['--version']);
    await assert.rejects(
      ownedQualification(
        directory,
        owner,
        () => {
          operations++;
        },
        {
          owner,
          pnpmBinary: binary,
          execute: () =>
            `${expected.pnpm === '11.21.0' ? '12.21.0' : '11.21.0'}\n`,
        },
      ),
      /owning build needs pnpm/u,
    );
    assert.equal(operations, 1);
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('each package authenticates its own license rather than source-root equality', () => {
  for (const [name, digest] of Object.entries(owningLicenses))
    assertOwningLicense(name, digest);
  assert.notEqual(
    owningLicenses.octane,
    owningLicenses['@octanejs/rspack-plugin'],
  );
  assert.equal(
    owningLicenses['@octanejs/tanstack-router'],
    owningLicenses['@octanejs/rspack-plugin'],
  );
  assert.throws(
    () =>
      assertOwningLicense('octane', owningLicenses['@octanejs/rspack-plugin']),
    /octane: recipe differs/u,
  );
  assert.throws(
    () => assertOwningLicense('@octanejs/rspack-plugin', owningLicenses.octane),
    /rspack-plugin: recipe differs/u,
  );
  assert.throws(
    () => assertOwningLicense('@unit/unreviewed', owningLicenses.octane),
    /Unknown native package/u,
  );
});

function runtimeControl(t) {
  const directory = root(t);
  const inputs = octane20RuntimeInputs();
  const patches = {};
  const items = Object.fromEntries(
    Object.entries(runtimeRecipes().packages).map(([name, item]) => {
      const patch = fs.readFileSync(item.patchPath);
      const patchPath = path.join(
        directory,
        inputs.runtimePair[name].patchPath,
      );
      fs.mkdirSync(path.dirname(patchPath), { recursive: true });
      fs.writeFileSync(patchPath, patch);
      patches[name] = patch;
      return [name, { ...structuredClone(item), patchPath }];
    }),
  );
  return {
    directory,
    items,
    patches,
    inputs,
    controls: fs.readdirSync(directory),
  };
}
const pairNames = ['octane', '@octanejs/rspack-plugin'];
const otherPair = name => pairNames.find(other => other !== name);
const neverRuns = {
  execute: () => assert.fail('must reject before toolchain'),
  qualifier: () => assert.fail('must reject before owning build'),
};

test('runtime pair adapter checks pnpm 12 before calling the owning runtime qualifier', async t => {
  const f = runtimeControl(t);
  let calls = 0;
  await assert.rejects(
    qualifyRuntimePairSource(
      { items: f.items, workDirectory: f.directory },
      {
        execute: () => '11.21.0\n',
        qualifier: async () => {
          calls++;
          assert.fail('must not build');
        },
      },
    ),
    /runtime: Native owning build needs pnpm 12.21.0/u,
  );
  assert.equal(calls, 0);
});

for (const gate of ['real query regression', 'HMR 12 failures'])
  test(`runtime pair adapter runs one owning build for both packages and preserves its ${gate} failure`, async t => {
    const f = runtimeControl(t);
    const failure = new Error(gate);
    let calls = 0;
    await assert.rejects(
      qualifyRuntimePairSource(
        { items: f.items, workDirectory: f.directory },
        {
          pnpmBinary: '/unit/pnpm-12.21.0',
          execute: () => '12.21.0\n',
          qualifier: async options => {
            calls++;
            assert.deepEqual(Object.keys(options).sort(), [
              'expectedPatches',
              'inputs',
              'pnpm',
              'runner',
              'work',
              'writePatch',
            ]);
            assert.deepEqual(options.inputs, f.inputs);
            assert.equal(options.writePatch, false);
            assert.deepEqual(options.expectedPatches, f.patches);
            assert.equal(options.pnpm, '/unit/pnpm-12.21.0');
            assert.equal(typeof options.runner.run, 'function');
            assert.equal(typeof options.runner.disk, 'function');
            assert.equal(typeof options.runner.register, 'function');
            assert(options.work.startsWith(fs.realpathSync(f.directory)));
            throw failure;
          },
        },
      ),
      error => error === failure,
    );
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(f.directory), f.controls);
  });

for (const name of pairNames)
  for (const kind of [
    'license',
    'request',
    'archive',
    'source',
    'source archive',
    'repository',
    'patch',
    'patch bytes',
    'foreign patch path',
    'swapped patch path',
  ])
    test(`runtime pair adapter rejects ${name} with a swapped ${kind} before toolchain or build execution`, async t => {
      const f = runtimeControl(t);
      const item = f.items[name];
      const other = f.items[otherPair(name)];
      if (kind === 'license')
        item.upstream.licenseSha256 = other.upstream.licenseSha256;
      if (kind === 'request') item.upstream.request = other.upstream.request;
      if (kind === 'archive')
        item.upstream.integrity = other.upstream.integrity;
      if (kind === 'source') item.upstream.commit = 'f'.repeat(40);
      if (kind === 'source archive')
        item.upstream.sourceArchiveIntegrity =
          'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
      if (kind === 'repository') item.upstream.repository = 'unit/unreviewed';
      if (kind === 'patch') item.patchSha256 = other.patchSha256;
      if (kind === 'patch bytes') {
        const changed = Buffer.from(f.patches[name]);
        changed[0] ^= 1;
        fs.writeFileSync(item.patchPath, changed);
      }
      if (kind === 'foreign patch path') {
        item.patchPath = path.join(f.directory, 'foreign.patch');
        fs.writeFileSync(item.patchPath, f.patches[name]);
      }
      if (kind === 'swapped patch path') item.patchPath = other.patchPath;
      const controls = fs.readdirSync(f.directory);
      await assert.rejects(
        qualifyRuntimePairSource(
          { items: f.items, workDirectory: f.directory },
          neverRuns,
        ),
        error =>
          error.message.includes(name) &&
          !error.message.includes('must reject'),
      );
      assert.deepEqual(fs.readdirSync(f.directory), controls);
    });

test('runtime pair adapter accepts exactly the closed octane/Rspack pair recipe', async t => {
  const f = runtimeControl(t);
  const adapter = completedRecipes().packages['@octanejs/tanstack-router'];
  for (const items of [
    { octane: f.items.octane },
    { ...f.items, '@octanejs/tanstack-router': adapter },
  ])
    await assert.rejects(
      qualifyRuntimePairSource(
        { items, workDirectory: f.directory },
        {
          execute: () => assert.fail('must reject before toolchain'),
          qualifier: () => assert.fail('must reject before owning build'),
        },
      ),
      /runtime owning pair recipe/u,
    );
});

test('runtime pair receipt checks each package’s own bytes from the single owning invocation', async t => {
  const f = runtimeControl(t);
  // Fabricated bytes are protocol controls; none of them can satisfy the
  // authenticated source archive gate, so no case below can be accepted.
  const receipt = name => ({
    sourceArchiveBytes: Buffer.from('fabricated source archive control'),
    builtPatchBytes: f.patches[name],
    licenseBytes: Buffer.from('fabricated license control'),
  });
  const pair = () =>
    Object.fromEntries(pairNames.map(name => [name, receipt(name)]));
  const cases = [
    [
      'swapped patches',
      () => {
        const value = pair();
        value.octane.builtPatchBytes = f.patches['@octanejs/rspack-plugin'];
        value['@octanejs/rspack-plugin'].builtPatchBytes = f.patches.octane;
        return value;
      },
      /octane: runtime owning build differs from recipe patch/u,
    ],
    [
      'foreign Rspack patch',
      () => {
        const value = pair();
        value['@octanejs/rspack-plugin'].builtPatchBytes = f.patches.octane;
        return value;
      },
      /@octanejs\/rspack-plugin: runtime owning build differs from recipe patch/u,
    ],
    [
      'only one package',
      () => ({ octane: receipt('octane') }),
      /runtime owning pair receipt/u,
    ],
    [
      'an extra package',
      () => ({ ...pair(), '@octanejs/tanstack-router': receipt('octane') }),
      /runtime owning pair receipt/u,
    ],
    [
      'an extra receipt field',
      () => {
        const value = pair();
        value.octane.packedBytes = Buffer.from('unreviewed');
        return value;
      },
      /octane: runtime owning byte receipt/u,
    ],
    [
      'non-byte evidence',
      () => {
        const value = pair();
        value['@octanejs/rspack-plugin'].licenseBytes = 'license';
        return value;
      },
      /rspack-plugin: owning runtime must return actual bytes/u,
    ],
    [
      'another license',
      () => pair(),
      /octane: recipe differs from its owning package license/u,
    ],
  ];
  for (const [label, value, expected] of cases) {
    let calls = 0;
    await assert.rejects(
      qualifyRuntimePairSource(
        { items: f.items, workDirectory: f.directory },
        {
          pnpmBinary: '/unit/pnpm-12.21.0',
          execute: () => '12.21.0\n',
          qualifier: async () => {
            calls++;
            return value();
          },
        },
      ),
      expected,
      label,
    );
    assert.equal(calls, 1, label);
    assert.deepEqual(fs.readdirSync(f.directory), f.controls, label);
  }
});

test('closed pair composition authenticates per-package licenses before any qualifier runs', async t => {
  const f = runtimeControl(t);
  const input = f.inputs.packages.find(
    item => item.name === '@octanejs/rspack-plugin',
  );
  const completed = completedRecipes();
  let calls = 0;
  const runtime = {
    packages: f.items,
    async qualifySource() {
      calls++;
    },
    async qualifyPacked() {
      calls++;
    },
  };
  composeRecipe({ completed, runtime });
  assert.equal(calls, 0);
  for (const [name, other] of [
    ['octane', '@octanejs/rspack-plugin'],
    ['@octanejs/rspack-plugin', 'octane'],
  ]) {
    const altered = { ...runtime, packages: structuredClone(runtime.packages) };
    altered.packages[name].upstream.licenseSha256 = owningLicenses[other];
    assert.throws(
      () =>
        composeRecipe({
          completed,
          runtime: altered,
        }),
      /owning package license/u,
    );
    assert.equal(calls, 0);
  }
  const wrongAdapter = structuredClone(completed);
  wrongAdapter.packages['@octanejs/tanstack-router'].upstream.licenseSha256 =
    owningLicenses.octane;
  assert.throws(
    () =>
      composeRecipe({
        completed: wrongAdapter,
        runtime,
      }),
    /owning package license/u,
  );
  for (const kind of ['request', 'archive', 'cohort', 'source']) {
    const altered = { ...runtime, packages: structuredClone(runtime.packages) };
    if (kind === 'request')
      altered.packages.octane.upstream.request = input.url;
    if (kind === 'archive')
      altered.packages.octane.upstream.integrity = input.integrity;
    if (kind === 'cohort') delete altered.packages['@octanejs/rspack-plugin'];
    if (kind === 'source')
      altered.packages.octane.upstream.commit = 'f'.repeat(40);
    assert.throws(() =>
      composeRecipe({
        completed,
        runtime: altered,
      }),
    );
    assert.equal(calls, 0);
  }
});

test('router and adapter reject another package license before creating a build workspace', async t => {
  const directory = root(t);
  const completed = completedRecipes();
  for (const [name, qualifier] of [
    ['@tanstack/router-core', qualifyRouterSource],
    ['@octanejs/tanstack-router', qualifyAdapterSource],
  ]) {
    const item = structuredClone(completed.packages[name]);
    item.upstream.licenseSha256 = owningLicenses.octane;
    await assert.rejects(
      qualifier({ item, workDirectory: directory }),
      /owning package license/u,
    );
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test('adapter rejects a mixed release tuple before fetching or building', async t => {
  const workDirectory = root(t);
  const current = completedRecipes().packages['@octanejs/tanstack-router'];
  for (const [upstream, expected] of [
    [{ ...current.upstream, commit: 'f'.repeat(40) }, /Adapter source commit/u],
    [
      { ...current.upstream, request: 'https://registry.npmjs.org/other.tgz' },
      /Adapter npm request/u,
    ],
    [{ ...current.upstream, integrity: 'other' }, /Adapter npm digest/u],
  ]) {
    await assert.rejects(
      qualifyAdapterSource({
        item: { ...current, upstream },
        workDirectory,
        fetchArtifact: () => assert.fail('mixed tuple reached transport'),
      }),
      expected,
    );
    assert.deepEqual(fs.readdirSync(workDirectory), []);
  }
});

const corrections = 'scripts/ultramodern-renderers/octane-corrections';
const candidateDirectory = `${corrections}/octane-0.20.0`;
const handoffPath = `${candidateDirectory}/css-properties-runtime-handoff.json`;
const handoff = JSON.parse(
  fs.readFileSync(new URL(`../../../${handoffPath}`, import.meta.url)),
);
function owningTree(t) {
  const directory = root(t);
  const relatives = [
    handoffPath,
    ...handoff.inputs.map(entry => entry.path),
    ...handoff.patches.map(entry => entry.path),
    'scripts/ultramodern-renderers/router-corrections/provenance.json',
    'patches/@tanstack__router-core@1.171.39.patch',
    `${candidateDirectory}/@octanejs__tanstack-router@0.3.6.shared-core-peer.patch`,
  ];
  for (const relative of relatives) {
    const original = new URL(`../../../${relative}`, import.meta.url);
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(original, target);
  }
  return directory;
}

test('the production recipe requires its handoff and keeps the adapter patch in the candidate directory', async t => {
  const directory = owningTree(t);
  const options = { root: directory };
  const receipt = fs.readFileSync(path.join(directory, handoffPath));
  fs.unlinkSync(path.join(directory, handoffPath));
  assert.throws(() => releaseRecipe(options), /awaits the authenticated/u);
  fs.writeFileSync(path.join(directory, handoffPath), receipt);
  const recipe = releaseRecipe(options);
  assert.equal(
    recipe.packages['@octanejs/tanstack-router'].patchPath,
    path.join(
      directory,
      candidateDirectory,
      '@octanejs__tanstack-router@0.3.6.shared-core-peer.patch',
    ),
  );
  assert.match(
    recipe.packages['@octanejs/tanstack-router'].upstream.request,
    /tanstack-router-0\.3\.6\.tgz$/u,
  );
  const runtime = runtimeRecipes(options, {
    pairQualifier: async args => args,
  });
  const selected = await runtime.qualifySource({ workDirectory: directory });
  assert.deepEqual(Object.keys(selected).sort(), [
    'items',
    'packedDirectory',
    'workDirectory',
  ]);
  assert.equal(selected.items.octane.patchSha256, handoff.patches[0].sha256);
  const poisoned = path.join(directory, handoff.patches[0].path);
  fs.writeFileSync(poisoned, Buffer.alloc(handoff.patches[0].bytes));
  await assert.rejects(
    runtime.qualifyPacked({ workDirectory: directory }),
    /Handoff digest: patches\/octane/u,
  );
  assert.throws(() => releaseRecipe(options), /Handoff digest/u);
});

test('production pair pins exactly CSS properties runtime handoff 44543237408/1', () => {
  assert.deepEqual(handoff.run, { id: '44543237408', attempt: '1' });
  assert.equal(handoff.sourceSha, 'd1a84f76efdb3768928c0a2b2d717d6ba95fb399');
  assert.deepEqual(handoff.patches, [
    {
      path: 'patches/octane@0.20.0.css-properties.patch',
      bytes: 2149812,
      sha256:
        'b8130841d8fbda74f63395fce4b0f7a32d6b78bee600b4e8896f8f3152718512',
    },
    {
      path: 'patches/@octanejs__rspack-plugin@0.2.12.patch',
      bytes: 26393,
      sha256:
        'bd448e034c50f526e9a580e4595ab73417cf19273ddf9fc1254cdfe71b51fcfb',
    },
  ]);
  assert.deepEqual(
    handoff.inputs.map(entry => entry.path),
    [
      `${candidateDirectory}/runtime-source.patch`,
      `${candidateDirectory}/rspack-source.patch`,
      `${candidateDirectory}/rspack-tests.patch`,
      `${corrections}/runtime-tests.patch`,
      `${corrections}/typescript-compat/typescript-source.patch`,
      `${corrections}/typescript-compat/native-signals-source.patch`,
      `${corrections}/typescript-compat/volar-core-source.patch`,
      `${candidateDirectory}/provenance.json`,
      `${candidateDirectory}/runtime-build-package.json`,
      `${candidateDirectory}/runtime-build-pnpm-lock.yaml`,
      `${candidateDirectory}/css-properties-source.patch`,
    ],
  );
  const pair = runtimeRecipes();
  assert.equal(
    pair.packages.octane.patchSha256,
    'b8130841d8fbda74f63395fce4b0f7a32d6b78bee600b4e8896f8f3152718512',
  );
  assert.equal(
    pair.packages.octane.patchPath,
    path.resolve(
      import.meta.dirname,
      '../../../patches/octane@0.20.0.css-properties.patch',
    ),
  );
  assert.equal(
    pair.packages['@octanejs/rspack-plugin'].patchSha256,
    'bd448e034c50f526e9a580e4595ab73417cf19273ddf9fc1254cdfe71b51fcfb',
  );
  for (const [name, item] of Object.entries(pair.packages)) {
    assert.equal(
      item.upstream.commit,
      '1cdd9d2027bef63e6cec601952795e9ed84e1344',
    );
    assertOwningLicense(name, item.upstream.licenseSha256);
    assert.equal(sha256(fs.readFileSync(item.patchPath)), item.patchSha256);
  }
  assert.deepEqual(Object.keys(releaseRecipe().packages).sort(), [
    '@octanejs/rspack-plugin',
    '@octanejs/tanstack-router',
    '@tanstack/router-core',
    'octane',
  ]);
});

for (const { path: relative } of [...handoff.inputs, ...handoff.patches])
  test(`production recipe rejects substituted handed-off ${relative}`, t => {
    const directory = owningTree(t);
    runtimeRecipes({ root: directory });
    const filename = path.join(directory, relative);
    const changed = fs.readFileSync(filename);
    // Whitespace preserves valid JSON but still changes authenticated bytes.
    if (relative.endsWith('.json')) fs.appendFileSync(filename, ' ');
    else {
      changed[0] ^= 1;
      fs.writeFileSync(filename, changed);
    }
    assert.throws(
      () => runtimeRecipes({ root: directory }),
      /Handoff (digest|size)/u,
    );
  });

test('production pair runs one owning invocation for both packages with the exact archive directory', async t => {
  const directory = owningTree(t);
  const calls = [];
  // A fabricated receipt exercises routing only; it cannot qualify production bytes.
  const receipt = { unitOnly: 'pair' };
  const pair = runtimeRecipes(
    { root: directory },
    {
      pairQualifier: async options => {
        calls.push(options);
        return receipt;
      },
    },
  );
  assert.equal(await pair.qualifySource({ workDirectory: directory }), receipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items, pair.packages);
  assert.equal(calls[0].workDirectory, directory);
  assert.equal(calls[0].packedDirectory, undefined);
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    'items',
    'packedDirectory',
    'workDirectory',
  ]);
  calls.length = 0;
  await pair.qualifyPacked({
    workDirectory: directory,
    directory: '/unit/exact-verified-archives',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items, pair.packages);
  assert.equal(calls[0].packedDirectory, '/unit/exact-verified-archives');
  fs.appendFileSync(
    path.join(directory, 'patches/octane@0.20.0.css-properties.patch'),
    'post-recipe drift',
  );
  calls.length = 0;
  await assert.rejects(
    pair.qualifySource({ workDirectory: directory }),
    /Handoff (size|digest)/u,
  );
  assert.equal(calls.length, 0);
});

test('production pair never turns an owning classification/load failure into a source receipt', async t => {
  const directory = owningTree(t);
  const failure = new Error('Selected load failures remain unclassified');
  let calls = 0;
  const pair = runtimeRecipes(
    { root: directory },
    {
      pairQualifier: async () => {
        calls++;
        throw failure;
      },
    },
  );
  await assert.rejects(
    pair.qualifySource({ workDirectory: directory }),
    error => error === failure,
  );
  await assert.rejects(
    pair.qualifyPacked({
      workDirectory: directory,
      directory: '/unit/archives',
    }),
    error => error === failure,
  );
  assert.equal(calls, 2);
});

test('owning installs normalize clone-or-copy once and renew replaced dependency output identities', async t => {
  const directory = root(t);
  const calls = [];
  await ownedQualification(
    directory,
    'install-policy',
    ({ root: work, run, register }) => {
      const dependencies = path.join(work, 'dependencies');
      fs.mkdirSync(dependencies);
      register(path.join(dependencies, 'node_modules'), 'dependencies');
      run(
        'pnpm',
        [
          'install',
          '--store-dir',
          '/foreign/store',
          '--config.package-import-method=clone-or-copy',
        ],
        dependencies,
      );
    },
    {
      execute(command, args, options) {
        calls.push({ command, args });
        if (args[0] === '--version') return '11.21.0\n';
        if (args[0] === 'install') {
          assert.deepEqual(
            args.filter(arg =>
              arg.startsWith('--config.package-import-method='),
            ),
            ['--config.package-import-method=clone-or-copy'],
          );
          assert(!args.includes('/foreign/store'));
          const modules = path.join(options.cwd, 'node_modules');
          fs.rmSync(modules, { recursive: true });
          fs.mkdirSync(modules);
        }
        return '';
      },
    },
  );
  if (process.platform === 'darwin')
    assert.equal(calls.filter(call => call.args[0] === 'register').length, 2);
});
