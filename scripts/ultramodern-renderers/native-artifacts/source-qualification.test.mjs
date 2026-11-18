import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
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
  runtimeHandoffFiles,
  runtimePairCandidates,
  unpackNpm,
  verifyRuntimeHandoff,
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
    'df6732ebcfc0af7cf274187c44596ac519abbc383ce30a796205b55c561bf688',
  );
  assert.equal(
    packages['@octanejs/tanstack-router'].upstream.commit,
    '4c35afcdca0f4889921612fc462e6aabe507d78d',
  );
  assert.equal(Object.keys(releaseRecipe().packages).length, 4);
});
test('completed recipes reject a changed canonical patch or provenance rather than measuring a new pin', t => {
  const directory = root(t);
  const original = completedRecipes();
  fs.mkdirSync(
    path.join(directory, 'scripts/ultramodern-renderers/router-corrections'),
    { recursive: true },
  );
  fs.mkdirSync(path.join(directory, 'patches'));
  const provenance = path.join(
    directory,
    'scripts/ultramodern-renderers/router-corrections/provenance.json',
  );
  fs.writeFileSync(provenance, JSON.stringify(original.provenance));
  for (const item of Object.values(original.packages))
    fs.copyFileSync(
      item.patchPath,
      path.join(directory, 'patches', path.basename(item.patchPath)),
    );
  completedRecipes({ root: directory });
  fs.appendFileSync(
    path.join(
      directory,
      'patches/@octanejs__tanstack-router@0.3.4.shared-core-peer.patch',
    ),
    'tamper',
  );
  assert.throws(
    () => completedRecipes({ root: directory }),
    /differs from owning/u,
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
  const inspected = unpackNpm(f.payloads.get('octane-0.18.0.tgz'), target);
  assert.equal(inspected.packageJson.name, 'octane');
  assert(fs.existsSync(path.join(target, 'LICENSE')));
});
test('composition couples source and packed owning suites to exact archives and provenance', async t => {
  // Fabricated runtime controls exercise orchestration only; they are not production pins.
  const directory = root(t);
  const completed = completedRecipes();
  const calls = [];
  const patch = path.join(directory, 'unit.patch');
  fs.writeFileSync(patch, 'unit-only');
  const common = completed.packages['@octanejs/tanstack-router'].upstream;
  const inputs = (await import('../octane-corrections/inputs.mjs')).packages;
  const runtime = {
    packages: Object.fromEntries(
      inputs
        .filter(item => item.name !== '@octanejs/tanstack-router')
        .map(item => [
          item.name,
          {
            upstream: {
              ...common,
              licenseSha256: owningLicenses[item.name],
              request: item.url,
              integrity: item.integrity,
            },
            patchPath: patch,
            patchSha256: sha256(Buffer.from('unit-only')),
          },
        ]),
    ),
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
  assert.throws(() => composeRecipe({ completed, runtime }), /source differs/u);
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
  const patches = {};
  const items = Object.fromEntries(
    Object.entries(runtimeRecipes().packages).map(([name, item]) => {
      const patch = Buffer.from(
        `fabricated ${name} protocol control, never a production patch`,
      );
      const patchPath = path.join(
        directory,
        `unit-${name.replace(/\W/gu, '_')}.patch`,
      );
      fs.writeFileSync(patchPath, patch);
      patches[name] = patch;
      return [
        name,
        { ...structuredClone(item), patchPath, patchSha256: sha256(patch) },
      ];
    }),
  );
  return { directory, items, patches, controls: fs.readdirSync(directory) };
}
const pairNames = ['octane', '@octanejs/rspack-plugin'];
const otherPair = name => pairNames.find(other => other !== name);

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
              'pnpm',
              'runner',
              'work',
              'writePatch',
            ]);
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
    'patch',
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
      if (kind === 'patch') item.patchSha256 = other.patchSha256;
      await assert.rejects(
        qualifyRuntimePairSource(
          { items: f.items, workDirectory: f.directory },
          {
            execute: () => assert.fail('must reject before toolchain'),
            qualifier: () => assert.fail('must reject before owning build'),
          },
        ),
        error =>
          error.message.includes(name) &&
          !error.message.includes('must reject'),
      );
      assert.deepEqual(fs.readdirSync(f.directory), f.controls);
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

const octane20 = 'octane-0.20.0';
const octane20Inputs = async () =>
  (
    await import('../octane-corrections/qualify-runtime.mjs')
  ).octane20RuntimeInputs();
// Recipe identities come only from the selected owning source. The patch files
// are fabricated protocol controls at the owning patch paths; no 0.20 handoff
// bytes or digests exist yet.
async function runtime20Control(t) {
  const directory = root(t);
  const inputs = await octane20Inputs();
  const patches = {};
  const items = Object.fromEntries(
    inputs.packages.map(input => {
      const patch = Buffer.from(
        `fabricated ${input.name} ${octane20} protocol control, never a production patch`,
      );
      const patchPath = path.join(
        directory,
        inputs.runtimePair[input.name].patchPath,
      );
      fs.mkdirSync(path.dirname(patchPath), { recursive: true });
      fs.writeFileSync(patchPath, patch);
      patches[input.name] = patch;
      return [
        input.name,
        {
          patchPath,
          patchSha256: sha256(patch),
          upstream: {
            request: input.url,
            integrity: input.integrity,
            repository: 'octanejs/octane',
            commit: inputs.source.commit,
            sourceArchiveIntegrity: inputs.sourceIntegrity,
            licenseSha256: input.licenseSha256,
          },
        },
      ];
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
const neverRuns = {
  execute: () => assert.fail('must reject before toolchain'),
  qualifier: () => assert.fail('must reject before owning build'),
};

test('runtime pair adapter selects only an exact Octane candidate literal', async t => {
  const f = runtimeControl(t);
  assert.deepEqual(runtimePairCandidates, ['octane-0.18.0', octane20]);
  for (const octaneCandidate of [
    'octane-0.19.0',
    'octane-0.20',
    'octane-0.20.0 ',
    'OCTANE-0.20.0',
    'octane@0.20.0',
    '',
    null,
    0.2,
  ])
    await assert.rejects(
      qualifyRuntimePairSource(
        { items: f.items, workDirectory: f.directory, octaneCandidate },
        neverRuns,
      ),
      /Unknown Octane runtime candidate/u,
      String(octaneCandidate),
    );
  assert.deepEqual(fs.readdirSync(f.directory), f.controls);
});

test('octane-0.20.0 pair passes its exact owning inputs to the one owning build', async t => {
  const f = await runtime20Control(t);
  const failure = new Error('HMR gate');
  let calls = 0;
  await assert.rejects(
    qualifyRuntimePairSource(
      { items: f.items, workDirectory: f.directory, octaneCandidate: octane20 },
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
          assert.equal(
            options.inputs.source.commit,
            f.items.octane.upstream.commit,
          );
          assert.equal(options.writePatch, false);
          assert.deepEqual(options.expectedPatches, f.patches);
          assert.equal(options.pnpm, '/unit/pnpm-12.21.0');
          throw failure;
        },
      },
    ),
    error => error === failure,
  );
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(f.directory), f.controls);
});

test('octane-0.18.0 stays the default and never receives other owning inputs', async t => {
  const f = runtimeControl(t);
  for (const selection of [{}, { octaneCandidate: 'octane-0.18.0' }]) {
    const failure = new Error('unit stop');
    await assert.rejects(
      qualifyRuntimePairSource(
        { items: f.items, workDirectory: f.directory, ...selection },
        {
          pnpmBinary: '/unit/pnpm-12.21.0',
          execute: () => '12.21.0\n',
          qualifier: async options => {
            assert.equal(Object.hasOwn(options, 'inputs'), false);
            throw failure;
          },
        },
      ),
      error => error === failure,
    );
  }
});

test('recipes cannot cross Octane candidates', async t => {
  const current = runtimeControl(t);
  const next = await runtime20Control(t);
  await assert.rejects(
    qualifyRuntimePairSource(
      {
        items: current.items,
        workDirectory: current.directory,
        octaneCandidate: octane20,
      },
      neverRuns,
    ),
    /octane: runtime recipe has another package identity/u,
  );
  await assert.rejects(
    qualifyRuntimePairSource(
      { items: next.items, workDirectory: next.directory },
      neverRuns,
    ),
    /octane: runtime recipe has another package identity/u,
  );
});

for (const name of pairNames)
  for (const kind of [
    'license',
    'request',
    'archive',
    'previous source',
    'previous source archive',
    'patch digest',
    'previous patch path',
    'swapped patch path',
  ])
    test(`octane-0.20.0 pair rejects ${name} with a ${kind} before toolchain or build execution`, async t => {
      const f = await runtime20Control(t);
      const item = f.items[name];
      const other = f.items[otherPair(name)];
      const previous = runtimeRecipes().packages[name];
      if (kind === 'license')
        item.upstream.licenseSha256 = other.upstream.licenseSha256;
      if (kind === 'request') item.upstream.request = previous.upstream.request;
      if (kind === 'archive')
        item.upstream.integrity = previous.upstream.integrity;
      if (kind === 'previous source')
        item.upstream.commit = previous.upstream.commit;
      if (kind === 'previous source archive')
        item.upstream.sourceArchiveIntegrity =
          previous.upstream.sourceArchiveIntegrity;
      if (kind === 'patch digest') item.patchSha256 = other.patchSha256;
      if (kind === 'previous patch path') {
        item.patchPath = path.join(
          f.directory,
          path.relative(
            path.dirname(path.dirname(previous.patchPath)),
            previous.patchPath,
          ),
        );
        fs.writeFileSync(item.patchPath, f.patches[name]);
      }
      if (kind === 'swapped patch path') item.patchPath = other.patchPath;
      const controls = fs.readdirSync(f.directory);
      await assert.rejects(
        qualifyRuntimePairSource(
          {
            items: f.items,
            workDirectory: f.directory,
            octaneCandidate: octane20,
          },
          neverRuns,
        ),
        error =>
          error.message.includes(name) &&
          !error.message.includes('must reject'),
      );
      assert.deepEqual(fs.readdirSync(f.directory), controls);
    });

test('octane-0.20.0 receipt checks each package’s own bytes against the selected recipe', async t => {
  const f = await runtime20Control(t);
  const receipt = name => ({
    sourceArchiveBytes: Buffer.from('fabricated source archive control'),
    builtPatchBytes: f.patches[name],
    licenseBytes: Buffer.from('fabricated license control'),
  });
  for (const [label, value, expected] of [
    [
      'foreign Rspack patch',
      () => ({
        octane: receipt('octane'),
        '@octanejs/rspack-plugin': {
          ...receipt('@octanejs/rspack-plugin'),
          builtPatchBytes: f.patches.octane,
        },
      }),
      /@octanejs\/rspack-plugin: runtime owning build differs from recipe patch/u,
    ],
    [
      'another license',
      () => Object.fromEntries(pairNames.map(name => [name, receipt(name)])),
      /octane: recipe differs from its owning package license/u,
    ],
  ])
    await assert.rejects(
      qualifyRuntimePairSource(
        {
          items: f.items,
          workDirectory: f.directory,
          octaneCandidate: octane20,
        },
        {
          pnpmBinary: '/unit/pnpm-12.21.0',
          execute: () => '12.21.0\n',
          qualifier: async () => value(),
        },
      ),
      expected,
      label,
    );
  assert.deepEqual(fs.readdirSync(f.directory), f.controls);
});

test('closed pair composition authenticates per-package licenses before any qualifier runs', async t => {
  const f = runtimeControl(t);
  const input = (
    await import('../octane-corrections/inputs.mjs')
  ).packages.find(item => item.name === '@octanejs/rspack-plugin');
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
      () => composeRecipe({ completed, runtime: altered }),
      /owning package license/u,
    );
    assert.equal(calls, 0);
  }
  const wrongAdapter = structuredClone(completed);
  wrongAdapter.packages['@octanejs/tanstack-router'].upstream.licenseSha256 =
    owningLicenses.octane;
  assert.throws(
    () => composeRecipe({ completed: wrongAdapter, runtime }),
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
    assert.throws(() => composeRecipe({ completed, runtime: altered }));
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
  for (const [octaneCandidate, upstream, expected] of [
    ['octane-0.20.0', current.upstream, /Adapter source commit/u],
    [
      'octane-0.18.0',
      { ...current.upstream, request: 'https://registry.npmjs.org/other.tgz' },
      /Adapter npm request/u,
    ],
    [
      'octane-0.18.0',
      { ...current.upstream, integrity: 'other' },
      /Adapter npm digest/u,
    ],
  ]) {
    await assert.rejects(
      qualifyAdapterSource({
        item: { ...current, upstream },
        octaneCandidate,
        workDirectory,
        fetchArtifact: () => assert.fail('mixed tuple reached transport'),
      }),
      expected,
    );
    assert.deepEqual(fs.readdirSync(workDirectory), []);
  }
});

function handedOffTree(t) {
  const directory = root(t);
  for (const relative of Object.keys(runtimeHandoffFiles)) {
    const original = new URL(`../../../${relative}`, import.meta.url);
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(original, target);
  }
  return directory;
}

test('the next cohort recipe consumes only the exact two handed-off patch bytes', async t => {
  const directory = root(t);
  const corrections = 'scripts/ultramodern-renderers/octane-corrections';
  const candidate = `${corrections}/octane-0.20.0`;
  const options = { root: directory, octaneCandidate: 'octane-0.20.0' };
  const write = (file, bytes) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  };
  const copy = (file, from = file) =>
    write(file, fs.readFileSync(new URL(`../../../${from}`, import.meta.url)));
  const inputs = [
    `${candidate}/runtime-source.patch`,
    `${candidate}/rspack-source.patch`,
    `${candidate}/rspack-tests.patch`,
    `${corrections}/runtime-tests.patch`,
    `${corrections}/typescript-compat/typescript-source.patch`,
    `${corrections}/typescript-compat/native-signals-source.patch`,
    `${corrections}/typescript-compat/volar-core-source.patch`,
    `${candidate}/provenance.json`,
    `${candidate}/runtime-build-package.json`,
    `${candidate}/runtime-build-pnpm-lock.yaml`,
  ].map(file => copy(file));
  assert.throws(() => releaseRecipe(options), /awaits the authenticated/u);
  const patches = [
    write('patches/octane@0.20.0.patch', Buffer.from('runtime test fixture')),
    write(
      'patches/@octanejs__rspack-plugin@0.2.12.patch',
      Buffer.from('Rspack test fixture'),
    ),
  ];
  write(
    `${candidate}/runtime-handoff.json`,
    Buffer.from(
      JSON.stringify({
        schema: 'runtime-patch-handoff/v1',
        candidate: options.octaneCandidate,
        sourceSha: '1'.repeat(40),
        run: { id: '123', attempt: '1' },
        toolchain: { node: '26.13.1', pnpm: '12.21.0', mise: '2026.11.8' },
        inputs,
        patches,
      }),
    ),
  );
  copy('scripts/ultramodern-renderers/router-corrections/provenance.json');
  copy('patches/@tanstack__router-core@1.171.39.patch');
  const adapterPatch =
    '@octanejs__tanstack-router@0.3.6.shared-core-peer.patch';
  copy(`${candidate}/${adapterPatch}`);
  const recipe = releaseRecipe(options);
  assert.equal(
    recipe.packages['@octanejs/tanstack-router'].patchPath,
    path.join(directory, candidate, adapterPatch),
  );
  assert.match(
    recipe.packages['@octanejs/tanstack-router'].upstream.request,
    /tanstack-router-0\.3\.6\.tgz$/u,
  );
  const runtime = runtimeRecipes(options, {
    pairQualifier: async args => args,
  });
  const selected = await runtime.qualifySource({ workDirectory: directory });
  assert.equal(selected.octaneCandidate, options.octaneCandidate);
  assert.equal(selected.items.octane.patchSha256, patches[0].sha256);
  const poisoned = path.join(directory, patches[0].path);
  fs.writeFileSync(poisoned, Buffer.alloc(patches[0].bytes));
  await assert.rejects(
    runtime.qualifyPacked({ workDirectory: directory }),
    /Handoff digest: patches\/octane/u,
  );
  assert.throws(() => releaseRecipe(options), /Handoff digest/u);
});

test('production pair pins exactly CI handoff 43988363275/1, not the prior runtime patch', () => {
  const pair = runtimeRecipes();
  assert.equal(
    pair.packages.octane.patchSha256,
    'c005016a3c6a15a76cbb52ecf0c80f409878f13d68894fa67c50daf490f8c9d8',
  );
  assert.equal(
    pair.packages['@octanejs/rspack-plugin'].patchSha256,
    '930795abefa05ae08954654b99b4f5a1442f50d89aa58900c164a0200cb7e3f0',
  );
  for (const [name, item] of Object.entries(pair.packages)) {
    assert.equal(
      item.upstream.commit,
      '4c35afcdca0f4889921612fc462e6aabe507d78d',
    );
    assertOwningLicense(name, item.upstream.licenseSha256);
    assert.equal(sha256(fs.readFileSync(item.patchPath)), item.patchSha256);
  }
  const recipe = releaseRecipe();
  assert.deepEqual(Object.keys(recipe.packages).sort(), [
    '@octanejs/rspack-plugin',
    '@octanejs/tanstack-router',
    '@tanstack/router-core',
    'octane',
  ]);
});

for (const relative of Object.keys(runtimeHandoffFiles))
  test(`production recipe rejects substituted handed-off ${relative}`, t => {
    const directory = handedOffTree(t);
    verifyRuntimeHandoff(directory);
    runtimeRecipes({ root: directory });
    fs.appendFileSync(
      path.join(directory, relative),
      'not part of authenticated handoff',
    );
    assert.throws(
      () => runtimeRecipes({ root: directory }),
      /Runtime handoff drift.*fresh authenticated handoff/u,
    );
  });

test('production pair runs one owning invocation for both packages with the exact archive directory', async t => {
  const directory = handedOffTree(t);
  const calls = [];
  // A fabricated receipt object exercises call routing only. It never qualifies production bytes.
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
  calls.length = 0;
  await pair.qualifyPacked({
    workDirectory: directory,
    directory: '/unit/exact-verified-archives',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items, pair.packages);
  assert.equal(calls[0].packedDirectory, '/unit/exact-verified-archives');
  fs.appendFileSync(
    path.join(directory, 'patches/octane@0.18.0.patch'),
    'post-recipe drift',
  );
  calls.length = 0;
  await assert.rejects(
    pair.qualifySource({ workDirectory: directory }),
    /Runtime handoff drift/u,
  );
  assert.equal(calls.length, 0);
});

test('production pair never turns an owning classification/load failure into a source receipt', async t => {
  const directory = handedOffTree(t);
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
