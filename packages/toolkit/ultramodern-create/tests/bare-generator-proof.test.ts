import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveCreatePackage } from '../../../../scripts/ultramodern-production-readiness/published-create-proof/package-cohort.mjs';
import {
  assertBareWorkspacePolicyUnchanged,
  assertConformanceOutputRoot,
  assertConsumerRoot,
  createBareInstallSetup,
  createBareManifest,
} from './fixtures/installed-renderers/bare-generator-proof.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-generator-guards-'));
  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer);
  return {
    root,
    consumer,
    clean: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function bootstrapRelease() {
  const version = '3.8.3-ultramodern.candidate';
  const packages = ['ultramodern-create', 'utils', 'runtime'].map(name => ({
    sourceName: `@modern-js/${name}`,
    targetName: `@bleedingdev/modern-js-${name}`,
    version,
    packageJson:
      name === 'ultramodern-create'
        ? {
            ultramodern: { frameworkVersion: version },
            dependencies: {
              '@modern-js/utils': `npm:@bleedingdev/modern-js-utils@${version}`,
              '@module-federation/runtime': 'npm:@bleedingdev/mf-runtime@2.9.1',
            },
          }
        : {},
  }));
  return {
    aliases: Object.fromEntries(
      packages.map(item => [item.sourceName, item.targetName]),
    ),
    createPackage: packages[0],
    dependencyGraph: {
      [packages[0].targetName]: [packages[1].targetName],
      [packages[1].targetName]: [],
      [packages[2].targetName]: [],
    },
    packages,
    publishOrder: packages.map(item => item.targetName),
    release: { version },
    sidecars: {
      packages: [
        {
          name: '@bleedingdev/mf-runtime',
          version: '2.9.1',
          packageJson: { name: '@bleedingdev/mf-runtime', version: '2.9.1' },
        },
      ],
    },
  };
}

test('bare install removes inherited release-age gates without changing PM or trust settings', () => {
  const allowBuilds = { esbuild: true, workerd: true };
  const inherited = {
    PATH: '/qualified/bin',
    NPM_CONFIG_MINIMUM_RELEASE_AGE: '0',
    NPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: '["*"]',
    PNPM_CONFIG_MINIMUM_RELEASE_AGE_STRICT: 'false',
    npm_config_minimum_release_age_ignore_missing_time: 'true',
    'pnpm_config_minimum-release-age-exclude': '["@bleedingdev/*"]',
    pnpm_config_minimumReleaseAge: '1',
    pnpm_config_pm_on_fail: 'error',
    PNPM_CONFIG_TRUST_POLICY_EXCLUDE: '["@bleedingdev/mf-runtime@2.9.1"]',
    npm_config_registry: 'http://verified-registry.invalid',
  };
  const setup = createBareInstallSetup(allowBuilds, inherited);
  assert.equal(setup.env.pnpm_config_minimum_release_age, '0');
  for (const name of [
    'pnpm_config_minimum_release_age_exclude',
    'pnpm_config_minimum_release_age_strict',
    'pnpm_config_minimum_release_age_ignore_missing_time',
  ])
    assert.equal(Object.hasOwn(setup.env, name), false);
  for (const name of [
    'NPM_CONFIG_MINIMUM_RELEASE_AGE',
    'NPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE',
    'PNPM_CONFIG_MINIMUM_RELEASE_AGE_STRICT',
    'npm_config_minimum_release_age_ignore_missing_time',
    'pnpm_config_minimum-release-age-exclude',
    'pnpm_config_minimumReleaseAge',
  ])
    assert.equal(Object.hasOwn(setup.env, name), false);
  for (const name of [
    'PATH',
    'pnpm_config_pm_on_fail',
    'PNPM_CONFIG_TRUST_POLICY_EXCLUDE',
    'npm_config_registry',
  ] as const)
    assert.equal(setup.env[name], inherited[name]);
  assert.equal(inherited.NPM_CONFIG_MINIMUM_RELEASE_AGE, '0');
  const workspace = parseYaml(setup.workspaceBytes.toString());
  assert.deepEqual(workspace, {
    packages: ['.'],
    allowBuilds,
    minimumReleaseAge: 0,
  });
  assert.equal(Object.hasOwn(workspace, 'minimumReleaseAgeExclude'), false);
});

test('bare bootstrap setup rejects mismatched release versions and wildcard requests', () => {
  const wrongVersion = bootstrapRelease();
  wrongVersion.createPackage.version = '3.8.3-ultramodern.other';
  assert.throws(
    () => resolveCreatePackage(wrongVersion),
    /create package version does not match release.version/u,
  );
  const wildcard = bootstrapRelease();
  wildcard.createPackage.packageJson.dependencies!['@modern-js/utils'] =
    'npm:@bleedingdev/modern-js-utils@*';
  assert.throws(
    () => resolveCreatePackage(wildcard),
    /exact bootstrap dependency/u,
  );
});

test('bare workspace policy rejects every install mutation and unsafe replacement', () => {
  const f = fixture();
  try {
    const setup = createBareInstallSetup({ esbuild: true }, {});
    const file = path.join(f.consumer, 'pnpm-workspace.yaml');
    fs.writeFileSync(file, setup.workspaceBytes);
    const evidence = assertBareWorkspacePolicyUnchanged(
      file,
      setup.workspaceBytes,
    );
    assert.equal(evidence.authoredSha256, evidence.installedSha256);
    assert.equal(evidence.unchangedByInstall, true);
    for (const mutation of [
      `${setup.workspaceBytes.toString()}# auto-accepted by pnpm\n`,
      setup.workspaceBytes
        .toString()
        .replace('minimumReleaseAge: 0', 'minimumReleaseAge: 1440'),
      `${setup.workspaceBytes.toString()}minimumReleaseAgeExclude: []\n`,
    ]) {
      fs.writeFileSync(file, mutation);
      assert.throws(
        () => assertBareWorkspacePolicyUnchanged(file, setup.workspaceBytes),
        /Install changed the bare workspace policy/u,
      );
    }
    fs.unlinkSync(file);
    const target = path.join(f.root, 'other-workspace.yaml');
    fs.writeFileSync(target, setup.workspaceBytes);
    fs.symlinkSync(target, file);
    assert.throws(
      () => assertBareWorkspacePolicyUnchanged(file, setup.workspaceBytes),
      /must remain an ordinary file/u,
    );
  } finally {
    f.clean();
  }
});

test('bare consumer starts with only the exact released generator direct dependency', () => {
  const manifest = createBareManifest({
    tools: { pnpm: '11.27.1' },
    createPackage: {
      targetName: '@bleedingdev/modern-js-ultramodern-create',
      version: '3.8.3-ultramodern.candidate',
    },
  });
  assert.deepEqual(manifest.dependencies, {
    '@bleedingdev/modern-js-ultramodern-create': '3.8.3-ultramodern.candidate',
  });
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false);
  assert.equal(Object.hasOwn(manifest, 'optionalDependencies'), false);
  assert.equal(manifest.engines.node, '>=26.13.1');
});

test('an empty owned consumer outside the worktree has no ambient dependency ancestor', () => {
  const f = fixture();
  try {
    assert.equal(
      assertConsumerRoot(f.consumer),
      fs.realpathSync.native(f.consumer),
    );
  } finally {
    f.clean();
  }
});

test('consumer preflight rejects a symlink before creating files', () => {
  const f = fixture();
  try {
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.consumer, alias);
    assert.throws(
      () => assertConsumerRoot(alias),
      /ordinary leased directory/u,
    );
    assert.deepEqual(fs.readdirSync(f.consumer), []);
  } finally {
    f.clean();
  }
});

test('consumer preflight rejects an ambient node_modules ancestor', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'node_modules'));
    assert.throws(
      () => assertConsumerRoot(f.consumer),
      /Ambient node_modules ancestor/u,
    );
    assert.deepEqual(fs.readdirSync(f.consumer), []);
  } finally {
    f.clean();
  }
});

test('consumer preflight preserves and rejects an occupied leased directory', () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.consumer, 'keep.txt'),
      'owned by another task',
    );
    assert.throws(() => assertConsumerRoot(f.consumer), /must be empty/u);
    assert.equal(
      fs.readFileSync(path.join(f.consumer, 'keep.txt'), 'utf8'),
      'owned by another task',
    );
  } finally {
    f.clean();
  }
});

test('conformance accepts an absent sibling outside the installed generator', () => {
  const f = fixture();
  try {
    const consumerRoot = fs.realpathSync.native(f.consumer);
    const bareRoot = path.join(consumerRoot, 'bare-generator');
    fs.mkdirSync(bareRoot);
    const outputRoot = path.join(consumerRoot, 'generated-solid');
    assertConformanceOutputRoot({ consumerRoot, bareRoot, outputRoot });
    assert.equal(fs.existsSync(outputRoot), false);
  } finally {
    f.clean();
  }
});

test('conformance rejects an output ancestor alias before writing outside its lease', () => {
  const f = fixture();
  try {
    const consumerRoot = fs.realpathSync.native(f.consumer);
    const bareRoot = path.join(consumerRoot, 'bare-generator');
    const externalRoot = path.join(f.root, 'outside-consumer');
    fs.mkdirSync(bareRoot);
    fs.mkdirSync(externalRoot);
    const alias = path.join(consumerRoot, 'alias');
    for (const target of [externalRoot, bareRoot]) {
      fs.symlinkSync(target, alias);
      assert.throws(
        () =>
          assertConformanceOutputRoot({
            consumerRoot,
            bareRoot,
            outputRoot: path.join(alias, 'generated-solid'),
          }),
        /direct sibling/u,
      );
      assert.deepEqual(fs.readdirSync(target), []);
      fs.unlinkSync(alias);
    }
  } finally {
    f.clean();
  }
});

test('conformance preserves and rejects a dangling output link', () => {
  const f = fixture();
  try {
    const consumerRoot = fs.realpathSync.native(f.consumer);
    const bareRoot = path.join(consumerRoot, 'bare-generator');
    fs.mkdirSync(bareRoot);
    const outputRoot = path.join(consumerRoot, 'generated-octane');
    const missingTarget = path.join(f.root, 'missing');
    fs.symlinkSync(missingTarget, outputRoot);
    assert.throws(
      () => assertConformanceOutputRoot({ consumerRoot, bareRoot, outputRoot }),
      /already exists/u,
    );
    assert.equal(fs.readlinkSync(outputRoot), missingTarget);
    assert.equal(fs.existsSync(missingTarget), false);
  } finally {
    f.clean();
  }
});
