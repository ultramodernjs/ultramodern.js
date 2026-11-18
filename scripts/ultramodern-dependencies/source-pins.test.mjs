import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ultramodernSandpackFiles } from '../../packages/toolkit/ultramodern-sandpack-profile/src/index.ts';
import { targets } from './snapshot.mjs';
import {
  auxiliarySourcePins,
  inspectSourcePins,
  repositorySourceFiles,
  reviewedSourcePaths,
  sourcePinCoverage,
  verdaccioIntegrity,
} from './source-pins.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = sourcePinCoverage(root);
const files = baseline.inventory.map(item => item.path);
const playwrightFile =
  'scripts/ultramodern-production-readiness/published-create-proof/constants.mjs';
const registryFile =
  'scripts/ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs';
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const inspect = (extra = {}, additionalFiles = []) =>
  inspectSourcePins({
    files: [...files, ...additionalFiles],
    read: file => extra[file] ?? read(file),
  });

test('tracked source selections are reviewed independently of consumer acceptance', () => {
  assert.deepEqual(baseline.errors, []);
  assert.ok(baseline.executableFiles > 1000);
  assert.ok(baseline.fixtureFiles > 1000);
  assert.deepEqual(
    baseline.inventory
      .filter(item => item.status === 'reviewed')
      .map(item => item.path),
    reviewedSourcePaths(read),
  );
  assert.equal(baseline.complete, true);
  assert.deepEqual(baseline.unresolved, []);
  assert(
    !baseline.unresolved.some(item => item.path.endsWith('skills-lock.json')),
  );
  assert.deepEqual(inspect().errors, []);
});

test('worktree inventory follows deletions and includes new source without hiding required omissions', () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests through owned-temp-dir');
  const temp = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'pin-files-'),
  );
  try {
    execFileSync('git', ['init', '-q', temp]);
    fs.writeFileSync(path.join(temp, 'old.js'), 'original');
    execFileSync('git', ['-C', temp, 'add', 'old.js']);
    fs.renameSync(path.join(temp, 'old.js'), path.join(temp, 'new.mjs'));
    assert.deepEqual(repositorySourceFiles(temp), ['new.mjs']);
    const result = inspectSourcePins({
      files: repositorySourceFiles(temp),
      // Reviewed identities still come from the repository's owning manifests.
      read: file =>
        file.endsWith('package.json')
          ? read(file)
          : "run('npx', ['unreviewed-tool@1.0.0']);",
    });
    assert(
      result.errors.some(error => error.includes('unclassified source pins')),
    );
    assert(
      result.errors.some(error => error.includes('missing reviewed source')),
    );
    assert.throws(
      () =>
        inspectSourcePins({
          files: ['unreadable.mjs'],
          read: file => {
            if (file === 'unreadable.mjs') throw new Error('unreadable source');
            return read(file);
          },
        }),
      /unreadable source/u,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('authenticated bootstrap cannot silently revert to moving installer or lose a digest', () => {
  const file =
    'packages/toolkit/ultramodern-create/src/ultramodern-workspace/mise-bootstrap.ts';
  for (const source of [
    read(file).replace('v2026.11.8/', 'latest/'),
    read(file).replace(
      '32b6abe844efa43d37d7ac4ed21d2ec41e9479d66feb19b0db8d2c548cd6e36d',
      'wrong',
    ),
  ]) {
    assert(
      inspect({ [file]: source }).errors.some(error =>
        error.includes('missing reviewed source pin'),
      ),
    );
  }
});

test('auxiliary source selection rejects floating update tools and stale public skill commits', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const skillLock = JSON.parse(
    read(
      'packages/toolkit/ultramodern-create/template-workspace/.codex/skills-lock.json',
    ),
  );
  assert.deepEqual(auxiliarySourcePins(rootPackage, skillLock), []);
  rootPackage.scripts['update-rsbuild'] = 'npx taze major -w';
  assert(
    auxiliarySourcePins(rootPackage, skillLock).some(item =>
      item.reason.includes('Taze 21.3.0'),
    ),
  );
  skillLock.sources.find(source => source.id === 'rstack-agent-skills').commit =
    '61c948b42512e223bad44b83af4080eba48b2677';
  assert(
    auxiliarySourcePins(rootPackage, skillLock).some(item =>
      item.reason.includes('reviewed immutable commit'),
    ),
  );
});

test('the actually missed old Playwright default fails the guard', () => {
  const source = read(playwrightFile);
  const errors = inspect({
    [playwrightFile]: source.replace('playwright@1.65.1', 'playwright@1.60.0'),
  }).errors;
  assert.ok(
    errors.some(message => message.includes('missing reviewed source pin')),
  );
  assert.ok(
    errors.some(message =>
      message.includes('unreviewed source pin playwright@1.60.0'),
    ),
  );
});

test('evidence-reviewed native and toolchain pins reject stale and unnoticed versions', () => {
  const sharedCore =
    'scripts/ultramodern-renderers/octane-corrections/shared-core-peer.mjs';
  const stale = inspect({
    [sharedCore]: read(sharedCore).replace("'1.171.39'", "'1.171.38'"),
  }).errors;
  assert(stale.some(error => error.includes('missing reviewed source pin')));
  assert(stale.some(error => error.includes("sharedCoreVersion = '1.171.38")));
  const routerQualify =
    'scripts/ultramodern-renderers/router-corrections/qualify.mjs';
  assert(
    inspect({
      [routerQualify]: `${read(routerQualify)}\nconst next = 'pnpm@11.22.0';`,
    }).errors.some(error =>
      error.includes('unreviewed source pin pnpm@11.22.0'),
    ),
  );
  const manifest = 'packages/runtime/renderer-octane/src/manifest.ts';
  assert(
    inspect({
      [manifest]: read(manifest).replace(
        `OCTANE_RUNTIME_VERSION = '${targets.octane}'`,
        "OCTANE_RUNTIME_VERSION = '0.13.8'",
      ),
    }).errors.some(error => error.includes('OCTANE_RUNTIME_VERSION = ')),
  );
});

test('reviewed Solid policy pins the nested signals edge to its cohort', () => {
  const file =
    'packages/toolkit/ultramodern-create/src/ultramodern-workspace/policy.ts';
  const selector = `solid-js@${targets['solid-js']}>@solidjs/signals`;
  const exact = `'${selector}': '${targets['@solidjs/signals']}'`;
  const source = read(file);
  assert(source.includes(exact));
  const drift = source.replace(exact, `'${selector}': '^2.0.0'`);
  assert(
    inspect({ [file]: drift }).errors.some(error =>
      error.includes(`missing reviewed source pin ${exact}`),
    ),
  );
});

test('reviewed native URLs follow the activated descriptor, not a legacy one', () => {
  const owner = 'packages/runtime/renderer-octane/package.json';
  const manifest = JSON.parse(read(owner));
  manifest.ultramodern.nativeArtifacts.packages.octane.version = '0.13.8';
  assert(
    inspect({ [owner]: JSON.stringify(manifest) }).errors.some(error =>
      error.includes('activated native octane must be snapshot 0.18.0'),
    ),
  );
  const profile = 'packages/runtime/renderer-octane/src/plugin/profile.ts';
  const request =
    manifest.ultramodern.nativeArtifacts.packages['@tanstack/router-core']
      .request;
  assert(
    inspect({
      [profile]: read(profile).replace(
        request,
        'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz',
      ),
    }).errors.some(error => error.includes('unreviewed source pin https://')),
  );
});

test('new installer pins in existing and new files cannot silently pass', () => {
  assert.ok(
    inspect({
      [playwrightFile]: `${read(playwrightFile)}\nrun('npx', ['new-tool@1.0.0']);`,
    }).errors.some(message => message.includes('new-tool@1.0.0')),
  );
  const file = 'scripts/new-installer.mjs';
  assert.ok(
    inspect(
      {
        [file]: "spawn('pnpm', ['dlx', '@scope/new-tool@2.0.0']);",
      },
      [file],
    ).errors.some(message => message.includes('unclassified source pins')),
  );
});

test('generated-only pins retain their reviewed versions and nested runtime identity', () => {
  const file =
    'packages/toolkit/ultramodern-create/src/ultramodern-workspace/versions.ts';
  for (const [name, current, stale] of [
    ['NODE_FETCH_VERSION', '3.3.2', '2.7.0'],
    ['LEFTHOOK_VERSION', '2.2.2', '2.2.1'],
    ['BRACES_FORK_VERSION', '3.0.4', '3.0.3'],
    ['WORKERD_VERSION', '1.20261113.1', '1.20261115.1'],
  ]) {
    const source = read(file).replace(
      `const ${name} = '${current}'`,
      `const ${name} = '${stale}'`,
    );
    assert(
      inspect({ [file]: source }).errors.some(error =>
        error.includes(`missing reviewed source pin const ${name}`),
      ),
    );
  }
});

test('reviewed WebSocket peer restoration stays exact and keeps runtime protection', () => {
  const file =
    'packages/toolkit/ultramodern-create/src/ultramodern-workspace/policy.ts';
  const source = read(file);
  assert.equal(
    baseline.inventory.find(item => item.path === file)?.status,
    'reviewed',
  );
  for (const changed of [
    source.replace(
      "'isomorphic-ws@5.0.0>ws:peer': '*'",
      "'isomorphic-ws@5.0.0>ws:peer': '^8'",
    ),
    source.replace(
      "'ws@>=8.0.0 <8.23.0': '8.23.0'",
      "'ws@>=8.0.0 <8.21.3': '8.23.0'",
    ),
  ])
    assert(
      inspect({ [file]: changed }).errors.some(error =>
        error.includes('missing reviewed source pin'),
      ),
    );
});

test('new immutable download pins require a classified source owner', () => {
  const file = 'scripts/new-download.mjs';
  assert.ok(
    inspect(
      {
        [file]:
          "fetch('https://github.com/example/tool/releases/download/v1.2.3/tool.tgz');",
      },
      [file],
    ).errors.some(message => message.includes('unclassified source pins')),
  );
});

test('unpinned installer invocations stay visible and historical fixtures stay excluded', () => {
  const file = 'scripts/new-unpinned-installer.mjs';
  const fixture = 'scripts/example/__tests__/historical.test.mjs';
  const result = inspect(
    {
      [file]: "spawn('pnpm', ['dlx', 'some-tool']);",
      [fixture]: "run('npx', ['playwright@1.60.0']);",
    },
    [file, fixture],
  );
  assert.equal(
    result.inventory.find(item => item.path === file)?.status,
    'invocation-review',
  );
  assert.equal(result.fixtureFiles, 1);
  assert.ok(!result.inventory.some(item => item.path === fixture));
  assert.deepEqual(result.fixtureEvidence[0].pins, ['playwright@1.60.0']);
});

test('live renderer acceptance runners are not mistaken for historical fixtures', () => {
  const runner = 'tests/ultramodern-renderers/new-renderer/proof.mjs';
  const fixture = 'tests/ultramodern-renderers/new-renderer/fixture/old.mjs';
  const result = inspect(
    {
      [runner]: "run('npx', ['playwright@1.60.0']);",
      [fixture]: "run('npx', ['playwright@1.60.0']);",
    },
    [runner, fixture],
  );
  const live = result.inventory.find(item => item.path === runner);
  assert.equal(live?.status, 'owner-review');
  assert.deepEqual(live.pins, ['playwright@1.60.0']);
  assert(!result.fixtureEvidence.some(item => item.path === runner));
  assert(result.fixtureEvidence.some(item => item.path === fixture));
});

test('Verdaccio version and exact distribution integrity are coupled', () => {
  assert.ok(
    inspect({
      [registryFile]: read(registryFile).replace(
        verdaccioIntegrity,
        'sha512-wrong',
      ),
    }).errors.some(message =>
      message.includes('missing reviewed source pin sha512-'),
    ),
  );
});

test('rendered Sandpack package uses latest snapshot and exact compiler/toolchain cohort', () => {
  const manifest = JSON.parse(ultramodernSandpackFiles['/package.json']);
  assert.equal(manifest.packageManager, 'pnpm@12.21.0');
  assert.deepEqual(manifest.engines, { node: '>=26.13.1', pnpm: '>=12.21.0' });
  for (const [name, version] of Object.entries(manifest.dependencies))
    if (!version.startsWith('npm:'))
      assert.equal(version, targets[name] ?? version, name);
  assert.equal(manifest.dependencies.effect, targets.effect);
  assert.equal(manifest.dependencies.i18next, targets.i18next);
  assert.equal(manifest.devDependencies['@effect/tsgo'], '0.70.0');
  assert.equal(manifest.devDependencies.tsrs, '0.25.0-ts7.1.0-beta');
  assert.equal(
    manifest.devDependencies['@types/node'],
    `^${targets['@types/node']}`,
  );
  assert.equal(manifest.devDependencies.tailwindcss, targets.tailwindcss);
});

test('actual browser provisioner resolves latest exact default without installation', () => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), `source-pin-${process.pid}-`),
  );
  try {
    const env = {
      ...process.env,
      RUNNER_TEMP: temp,
      GITHUB_ENV: path.join(temp, 'env'),
      GITHUB_OUTPUT: path.join(temp, 'output'),
    };
    delete env.ULTRAMODERN_BROWSER_SMOKE_PLAYWRIGHT_PACKAGE;
    execFileSync(
      process.execPath,
      [
        'scripts/ultramodern-production-readiness/provision-acceptance-browsers.mjs',
        '--resolve',
      ],
      { cwd: root, env },
    );
    assert.match(
      fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'),
      /version=1\.65\.1/u,
    );
    assert.match(
      fs.readFileSync(env.GITHUB_ENV, 'utf8'),
      /PLAYWRIGHT_BROWSERS_PATH=/u,
    );
    assert.equal(fs.existsSync(path.join(temp, 'ms-playwright')), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('coverage is read-only and repeatable', () => {
  assert.deepEqual(sourcePinCoverage(root), baseline);
});
