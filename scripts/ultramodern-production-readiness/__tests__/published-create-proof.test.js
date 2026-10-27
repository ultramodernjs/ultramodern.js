const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire, syncBuiltinESMExports } = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeJsonFile } = require('../../lib/fs-kit');
const { createGitFixture } = require('../../lib/git-fixture');
const { createProcessEnv } = require('../../lib/process-kit');

function writeJson(root, relativePath, value) {
  writeJsonFile(path.join(root, relativePath), value, { atomic: false });
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function writeCanonicalJson(root, relativePath, value) {
  const bytes = Buffer.from(
    `${JSON.stringify(canonicalValue(value), null, 2)}\n`,
    'utf8',
  );
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeBootstrapRelease(version = '3.4.0-ultramodern.2') {
  const aliases = {
    '@modern-js/ultramodern-create':
      '@bleedingdev/modern-js-ultramodern-create',
    '@modern-js/i18n-utils': '@bleedingdev/modern-js-i18n-utils',
    '@modern-js/runtime': '@bleedingdev/modern-js-runtime',
    '@modern-js/utils': '@bleedingdev/modern-js-utils',
  };
  const packageJson = (sourceName, dependencies = {}) => ({
    dependencies,
    ...(sourceName === '@modern-js/ultramodern-create'
      ? { ultramodern: { frameworkVersion: version } }
      : {}),
  });
  const packages = [
    {
      packageJson: packageJson('@modern-js/ultramodern-create', {
        '@modern-js/i18n-utils': `npm:${aliases['@modern-js/i18n-utils']}@${version}`,
        chalk: '^5.6.2',
      }),
      sourceName: '@modern-js/ultramodern-create',
      targetName: aliases['@modern-js/ultramodern-create'],
      version,
    },
    {
      packageJson: packageJson('@modern-js/i18n-utils', {
        '@modern-js/utils': `npm:${aliases['@modern-js/utils']}@${version}`,
      }),
      sourceName: '@modern-js/i18n-utils',
      targetName: aliases['@modern-js/i18n-utils'],
      version,
    },
    {
      packageJson: packageJson('@modern-js/runtime'),
      sourceName: '@modern-js/runtime',
      targetName: aliases['@modern-js/runtime'],
      version,
    },
    {
      packageJson: packageJson('@modern-js/utils'),
      sourceName: '@modern-js/utils',
      targetName: aliases['@modern-js/utils'],
      version,
    },
  ];
  return {
    aliases,
    createPackage: packages[0],
    dependencyGraph: {
      [aliases['@modern-js/ultramodern-create']]: [
        aliases['@modern-js/i18n-utils'],
      ],
      [aliases['@modern-js/i18n-utils']]: [aliases['@modern-js/utils']],
      [aliases['@modern-js/runtime']]: [],
      [aliases['@modern-js/utils']]: [],
    },
    packages,
    publishOrder: packages.map(item => item.targetName),
    release: { version },
  };
}

function makeNormalAcceptanceRelease() {
  const release = makeBootstrapRelease();
  release.source = { commit: 'a'.repeat(40) };
  for (const item of release.packages) {
    item.integrity = `sha512-${crypto
      .createHash('sha512')
      .update(item.targetName)
      .digest('base64')}`;
  }
  Object.assign(release.createPackage.packageJson.dependencies, {
    '@module-federation/runtime': 'npm:@bleedingdev/mf-runtime@2.9.1',
    '@module-federation/dts-plugin': 'npm:@bleedingdev/mf-dts-plugin@2.9.1',
    '@module-federation/modern-js-v3': 'npm:@bleedingdev/mf-modern-js-v3@2.9.1',
  });
  return release;
}

function makeNormalAcceptanceReport(platform, moduleFederation) {
  const verticals = Array.from(
    { length: 10 },
    (_, index) => `vertical-${index + 1}`,
  );
  const applicationSourceRevision = 'c'.repeat(40);
  return {
    verticals,
    applicationSourceRevision,
    report: {
      artifactMode: 'source',
      platform,
      shellRuntime: platform,
      targetRuntimes: Object.fromEntries(
        verticals.map(appId => [appId, platform]),
      ),
      status: 'pass',
      skipped: [],
      evidence: {
        'release-identity': {
          artifactMode: 'source',
          platform,
          status: 'pass',
          verticalIds: verticals,
          assertions: verticals.map(appId => ({ appId, status: 'pass' })),
          apps: verticals.map(appId => {
            const identity = {
              buildMarker: crypto
                .createHash('sha256')
                .update(appId)
                .digest('hex'),
              sourceRevision: applicationSourceRevision,
              releaseVersion: '0.1.0',
              moduleFederation,
            };
            return {
              appId,
              surfaces: Object.fromEntries(
                ['frontend', 'ssr', 'api', 'backend'].map(surface => [
                  surface,
                  { ...identity },
                ]),
              ),
            };
          }),
        },
      },
    },
  };
}

test('normal acceptance validates served runtime identities without narrowing the SDK artifact audit', async () => {
  const { createRuntimeArtifactBinding } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const { assertRuntimeAcceptanceDimension, createReleaseArtifactBinding } =
    await import('../published-create-proof/acceptance-contract.mjs');
  const release = makeNormalAcceptanceRelease();
  const originalRelease = structuredClone(release);
  const fullBinding = createReleaseArtifactBinding(release);
  const originalFullBinding = structuredClone(fullBinding);
  const servedBinding = createRuntimeArtifactBinding(release);
  const runtimeCohort = [
    { packageName: '@module-federation/runtime', version: '2.9.1' },
  ];

  assert.deepEqual(servedBinding.moduleFederation, runtimeCohort);
  assert.equal(fullBinding.moduleFederation.length, 3);
  assert.deepEqual(servedBinding.packages, fullBinding.packages);
  assert.equal(servedBinding.sourceRevision, release.source.commit);
  for (const platform of ['node', 'workerd']) {
    const { report, verticals, applicationSourceRevision } =
      makeNormalAcceptanceReport(platform, runtimeCohort);
    const details = assertRuntimeAcceptanceDimension(report, {
      artifactBinding: servedBinding,
      applicationSourceRevision,
      dimension: 'release-identity',
      mode: 'source',
      platform,
      verticals,
    });
    assert.equal(details.apps.length, 10);
    for (const app of details.apps) {
      assert.deepEqual(app.moduleFederation, runtimeCohort);
    }
  }
  assert.deepEqual(fullBinding, originalFullBinding);
  assert.deepEqual(release, originalRelease);
});

test('normal acceptance rejects foreign runtimes and SDK tooling in served identities', async () => {
  const { createRuntimeArtifactBinding } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const { assertRuntimeAcceptanceDimension, createReleaseArtifactBinding } =
    await import('../published-create-proof/acceptance-contract.mjs');
  const release = makeNormalAcceptanceRelease();
  const servedBinding = createRuntimeArtifactBinding(release);
  const invalidCohorts = [
    [{ packageName: '@module-federation/runtime', version: '2.9.2' }],
    createReleaseArtifactBinding(release).moduleFederation,
  ];

  for (const platform of ['node', 'workerd']) {
    for (const moduleFederation of invalidCohorts) {
      const { report, verticals, applicationSourceRevision } =
        makeNormalAcceptanceReport(platform, moduleFederation);
      assert.throws(
        () =>
          assertRuntimeAcceptanceDimension(report, {
            artifactBinding: servedBinding,
            applicationSourceRevision,
            dimension: 'release-identity',
            mode: 'source',
            platform,
            verticals,
          }),
        /Module Federation cohort differs from the exact release cohort/u,
      );
    }
  }
});

test('runtime acceptance binds the verified sidecar instead of the SDK upstream version', async () => {
  const { createRuntimeArtifactBinding } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const { createRuntimeArtifactBinding: projectBinding } = await import(
    '../published-create-proof/acceptance-continuation.mjs'
  );
  const { createReleaseArtifactBinding, assertRuntimeAcceptanceDimension } =
    await import('../published-create-proof/acceptance-contract.mjs');
  const release = makeNormalAcceptanceRelease();
  release.createPackage.packageJson.dependencies['@module-federation/runtime'] =
    '2.9.2';
  const sidecar = {
    name: '@bleedingdev/mf-runtime',
    version: '2.9.3',
    integrity: release.createPackage.integrity,
    packageJson: { name: '@bleedingdev/mf-runtime', version: '2.9.3' },
  };
  release.sidecars = { packages: [sidecar] };
  const fullBinding = createReleaseArtifactBinding(release);
  const runtimeCohort = [
    { packageName: '@module-federation/runtime', version: '2.9.3' },
  ];
  assert.equal(
    fullBinding.moduleFederation.find(
      item => item.packageName === '@module-federation/runtime',
    ).version,
    '2.9.2',
  );
  assert.deepEqual(
    createRuntimeArtifactBinding(release).moduleFederation,
    runtimeCohort,
  );
  assert.deepEqual(projectBinding(fullBinding).moduleFederation, runtimeCohort);
  for (const platform of ['node', 'workerd']) {
    for (const version of ['2.9.2', '2.9.3', '2.9.4']) {
      const { report, verticals, applicationSourceRevision } =
        makeNormalAcceptanceReport(platform, [
          { packageName: '@module-federation/runtime', version },
        ]);
      const verify = () =>
        assertRuntimeAcceptanceDimension(report, {
          artifactBinding: createRuntimeArtifactBinding(release),
          applicationSourceRevision,
          dimension: 'release-identity',
          mode: 'source',
          platform,
          verticals,
        });
      if (version === '2.9.3') verify();
      else assert.throws(verify, /Module Federation cohort differs/u);
    }
  }
  for (const packages of [
    [sidecar, sidecar],
    [{ ...sidecar, version: '2.9.4' }],
    [{ ...sidecar, version: '^2.9.3' }],
  ]) {
    release.sidecars.packages = packages;
    assert.throws(
      () => createRuntimeArtifactBinding(release),
      /runtime sidecar/u,
    );
  }
});

test('normal acceptance rejects missing or invalid packed runtime declarations', async () => {
  const { createRuntimeArtifactBinding } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const cases = [
    [
      release => {
        delete release.createPackage.packageJson.dependencies[
          '@module-federation/runtime'
        ];
      },
      /requires one exact Module Federation runtime/u,
    ],
    [
      release => {
        release.createPackage.packageJson.dependencies[
          '@module-federation/runtime'
        ] = 'npm:@bleedingdev/mf-runtime@2.9';
      },
      /must use one exact Module Federation version/u,
    ],
    [
      release => {
        release.createPackage.packageJson.dependencies[
          '@module-federation/runtime'
        ] = 'npm:@bleedingdev/mf-runtime@^2.9.1';
      },
      /must use one exact Module Federation version/u,
    ],
    [
      release => {
        release.packages[1].packageJson.optionalDependencies = {
          '@module-federation/runtime': 'npm:@bleedingdev/mf-runtime@2.9.2',
        };
      },
      /mixes Module Federation.*versions/u,
    ],
  ];
  for (const [mutate, expectedError] of cases) {
    const release = makeNormalAcceptanceRelease();
    mutate(release);
    assert.throws(() => createRuntimeArtifactBinding(release), expectedError);
  }
});

test('builds the supported pnpm dlx package command contract from the authenticated create closure', async () => {
  const { createPnpmDlxArgs, resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const createPackage = resolveCreatePackage(makeBootstrapRelease());
  assert.deepEqual(
    createPnpmDlxArgs(createPackage, ['my-super-app', '--lang', 'en']),
    [
      '--pm-on-fail=ignore',
      '--config.minimum-release-age=1440',
      '--config.minimum-release-age-strict=true',
      '--config.minimum-release-age-ignore-missing-time=false',
      '--config.minimum-release-age-exclude=@bleedingdev/modern-js-i18n-utils@3.4.0-ultramodern.2',
      '--config.minimum-release-age-exclude=@bleedingdev/modern-js-ultramodern-create@3.4.0-ultramodern.2',
      '--config.minimum-release-age-exclude=@bleedingdev/modern-js-utils@3.4.0-ultramodern.2',
      'dlx',
      '--allow-build=esbuild',
      '@bleedingdev/modern-js-ultramodern-create@3.4.0-ultramodern.2',
      'my-super-app',
      '--lang',
      'en',
    ],
  );
  // A create package the release-age policy cannot exclude makes the
  // documented bootstrap command fail against a freshly published cohort.
  assert.throws(
    () =>
      createPnpmDlxArgs(
        {
          exactSpecifier: 'modern-js-ultramodern-create@3.5.0-ultramodern.77',
        },
        [],
      ),
    /exact authenticated bootstrap release-age policy/u,
  );
});

test('orders exact bootstrap specifiers when a reachable package name prefixes another', async () => {
  const { createPnpmDlxArgs, resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const release = makeBootstrapRelease('3.9.0-ultramodern.5');
  const { version } = release.release;
  const pluginTarget = '@bleedingdev/modern-js-plugin';
  const dataLoaderTarget = '@bleedingdev/modern-js-plugin-data-loader';
  Object.assign(release.aliases, {
    '@modern-js/plugin': pluginTarget,
    '@modern-js/plugin-data-loader': dataLoaderTarget,
  });
  release.createPackage.packageJson.dependencies[
    '@modern-js/plugin-data-loader'
  ] = `npm:${dataLoaderTarget}@${version}`;
  release.dependencyGraph[release.createPackage.targetName].push(
    dataLoaderTarget,
  );
  release.dependencyGraph[dataLoaderTarget] = [pluginTarget];
  release.dependencyGraph[pluginTarget] = [];
  release.packages.push(
    {
      sourceName: '@modern-js/plugin-data-loader',
      targetName: dataLoaderTarget,
      version,
      packageJson: {
        dependencies: {
          '@modern-js/plugin': `npm:${pluginTarget}@${version}`,
        },
      },
    },
    {
      sourceName: '@modern-js/plugin',
      targetName: pluginTarget,
      version,
      packageJson: {},
    },
  );
  release.publishOrder.push(pluginTarget, dataLoaderTarget);

  // pnpm rejects the whole bootstrap command when the exclusions are not
  // ordered on the full `name@version` specifier, which only shows up when one
  // package name is a prefix of another.
  const args = createPnpmDlxArgs(resolveCreatePackage(release), ['my-app']);
  assert.deepEqual(
    args.filter(argument =>
      argument.startsWith('--config.minimum-release-age-exclude='),
    ),
    [
      `--config.minimum-release-age-exclude=@bleedingdev/modern-js-i18n-utils@${version}`,
      `--config.minimum-release-age-exclude=${dataLoaderTarget}@${version}`,
      `--config.minimum-release-age-exclude=${pluginTarget}@${version}`,
      `--config.minimum-release-age-exclude=@bleedingdev/modern-js-ultramodern-create@${version}`,
      `--config.minimum-release-age-exclude=@bleedingdev/modern-js-utils@${version}`,
    ],
  );
});

test('fails closed when the authenticated create closure is omitted or version-skewed', async () => {
  const { resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );

  const omitted = makeBootstrapRelease();
  omitted.dependencyGraph[omitted.createPackage.targetName] = [];
  assert.throws(
    () => resolveCreatePackage(omitted),
    /differs from authenticated packed runtime dependencies/u,
  );

  const wrongVersion = makeBootstrapRelease();
  wrongVersion.packages.find(
    item => item.sourceName === '@modern-js/i18n-utils',
  ).version = '3.4.0-ultramodern.1';
  assert.throws(
    () => resolveCreatePackage(wrongVersion),
    /must use release version 3\.4\.0-ultramodern\.2/u,
  );
});

function makeBootstrapSidecar(name, version, packageJson = {}) {
  return { name, version, packageJson: { name, version, ...packageJson } };
}

test('bootstrap admits only the exact reachable sidecar runtime and optional closure', async () => {
  const { createPnpmDlxArgs, resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const release = makeBootstrapRelease();
  const jiti = makeBootstrapSidecar('@bleedingdev/jiti', '2.7.0');
  const runtime = makeBootstrapSidecar('@bleedingdev/mf-runtime', '2.9.1');
  const node = makeBootstrapSidecar('@bleedingdev/mf-node', '2.7.51');
  const image = makeBootstrapSidecar('@bleedingdev/optional-native', '0.1.4');
  const modern = makeBootstrapSidecar('@bleedingdev/mf-modern-js-v3', '2.9.1', {
    dependencies: {
      '@module-federation/runtime': `npm:${runtime.name}@${runtime.version}`,
    },
    optionalDependencies: { [node.name]: node.version },
    devDependencies: { '@bleedingdev/dev-only': '1.0.0' },
  });
  const unused = makeBootstrapSidecar('@bleedingdev/unused', '1.0.0');
  const devOnly = makeBootstrapSidecar('@bleedingdev/dev-only', '1.0.0');
  const unreachable = makeBootstrapSidecar('@bleedingdev/unreachable', '1.0.0');
  Object.assign(release.createPackage.packageJson.dependencies, {
    jiti: `npm:${jiti.name}@${jiti.version}`,
    '@module-federation/modern-js-v3': `npm:${modern.name}@${modern.version}`,
  });
  const utils = release.packages.find(
    item => item.sourceName === '@modern-js/utils',
  );
  utils.packageJson.optionalDependencies = { [image.name]: image.version };
  utils.packageJson.devDependencies = { [unused.name]: unused.version };
  release.packages.find(
    item => item.sourceName === '@modern-js/runtime',
  ).packageJson.dependencies = { [unreachable.name]: unreachable.version };
  release.sidecars = {
    packages: [
      jiti,
      modern,
      runtime,
      node,
      image,
      unused,
      devOnly,
      unreachable,
    ],
  };
  const createPackage = resolveCreatePackage(release);
  const expected = [
    ...resolveCreatePackage(makeBootstrapRelease()).bootstrapReleaseAgePolicy
      .minimumReleaseAgeExclude,
    ...[jiti, modern, runtime, node, image].map(
      item => `${item.name}@${item.version}`,
    ),
  ].sort((left, right) => left.localeCompare(right));
  assert.deepEqual(
    createPackage.bootstrapReleaseAgePolicy.minimumReleaseAgeExclude,
    expected,
  );
  const args = createPnpmDlxArgs(createPackage, ['my-app']);
  assert.deepEqual(
    args.filter(value =>
      value.startsWith('--config.minimum-release-age-exclude='),
    ),
    expected.map(value => `--config.minimum-release-age-exclude=${value}`),
  );
  for (const flag of [
    '--config.minimum-release-age=1440',
    '--config.minimum-release-age-strict=true',
    '--config.minimum-release-age-ignore-missing-time=false',
  ])
    assert(args.includes(flag));
  assert(args.includes('dlx'));
  assert(args.includes(createPackage.exactSpecifier));
});

test('bootstrap rejects mismatched or inexact sidecar dependency identities', async () => {
  const { resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  for (const specifier of [
    'npm:@bleedingdev/jiti@2.6.0',
    'npm:@bleedingdev/jiti@^2.7.0',
    'npm:@bleedingdev/jiti@*',
  ]) {
    const release = makeBootstrapRelease();
    release.createPackage.packageJson.dependencies.jiti = specifier;
    release.sidecars = {
      packages: [makeBootstrapSidecar('@bleedingdev/jiti', '2.7.0')],
    };
    assert.throws(
      () => resolveCreatePackage(release),
      /must resolve to exact bootstrap sidecar/u,
    );
  }
  const release = makeBootstrapRelease();
  const parent = makeBootstrapSidecar('@bleedingdev/parent', '1.0.0', {
    dependencies: { '@bleedingdev/jiti': '^2.7.0' },
  });
  release.createPackage.packageJson.dependencies[parent.name] = parent.version;
  release.sidecars = {
    packages: [parent, makeBootstrapSidecar('@bleedingdev/jiti', '2.7.0')],
  };
  assert.throws(
    () => resolveCreatePackage(release),
    /must resolve to exact bootstrap sidecar/u,
  );
});

test('bootstrap rejects invalid sidecar observations and cannot forge sidecar exemptions', async () => {
  const { createPnpmDlxArgs, resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const sidecar = makeBootstrapSidecar('@bleedingdev/jiti', '2.7.0');
  for (const packages of [
    [makeBootstrapSidecar('@foreign/jiti', '2.7.0')],
    [makeBootstrapSidecar('@bleedingdev/*', '2.7.0')],
    [makeBootstrapSidecar('@bleedingdev/modern-js-forged', '2.7.0')],
    [makeBootstrapSidecar(sidecar.name, '^2.7.0')],
    [{ ...sidecar, packageJson: { name: '@foreign/jiti', version: '2.7.0' } }],
    [{ ...sidecar, packageJson: { name: sidecar.name, version: '2.6.0' } }],
    [{ name: sidecar.name, version: sidecar.version }],
    [sidecar, sidecar],
  ]) {
    const release = makeBootstrapRelease();
    release.sidecars = { packages };
    assert.throws(
      () => resolveCreatePackage(release),
      /invalid packed sidecar observation|must be stable semver/u,
    );
  }
  const release = makeBootstrapRelease();
  release.createPackage.packageJson.dependencies.jiti =
    'npm:@bleedingdev/jiti@2.7.0';
  // An unobserved published dependency gets no candidate-sidecar exemption.
  assert.deepEqual(
    resolveCreatePackage(release).bootstrapReleaseAgePolicy
      .minimumReleaseAgeExclude,
    resolveCreatePackage(makeBootstrapRelease()).bootstrapReleaseAgePolicy
      .minimumReleaseAgeExclude,
  );
  release.sidecars = {
    packages: [makeBootstrapSidecar('@bleedingdev/unrelated', '1.0.0')],
  };
  assert.throws(
    () => resolveCreatePackage(release),
    /targets omitted bootstrap sidecar @bleedingdev\/jiti/u,
  );
  release.sidecars = { packages: [sidecar] };
  const actual = resolveCreatePackage(release);
  assert.doesNotThrow(() => createPnpmDlxArgs(actual, []));
  assert.throws(
    () =>
      createPnpmDlxArgs(
        {
          ...actual,
          bootstrapReleaseAgePolicy: { ...actual.bootstrapReleaseAgePolicy },
        },
        [],
      ),
    /exact authenticated bootstrap release-age policy/u,
  );
});

test('bootstrap admits exact compiler and native pins from the authenticated packed generator', async () => {
  const { createPnpmDlxArgs, resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const release = makeBootstrapRelease();
  const baseline =
    resolveCreatePackage(release).bootstrapReleaseAgePolicy
      .minimumReleaseAgeExclude;
  Object.assign(release.createPackage.packageJson.dependencies, {
    '@effect/tsgo': '0.59.0',
    tsrs: '0.20.0-ts7.1.0-beta',
    'unrelated-compiler': '9.9.9',
    '@tsrs/unreviewed-host': '0.20.0-ts7.1.0-beta',
  });
  const compilerSelectors = [
    '@effect/tsgo@0.59.0',
    '@effect/tsgo-darwin-arm64@0.59.0',
    '@effect/tsgo-darwin-x64@0.59.0',
    '@effect/tsgo-linux-arm@0.59.0',
    '@effect/tsgo-linux-arm64@0.59.0',
    '@effect/tsgo-linux-x64@0.59.0',
    '@effect/tsgo-win32-arm64@0.59.0',
    '@effect/tsgo-win32-x64@0.59.0',
    'tsrs@0.20.0-ts7.1.0-beta',
    '@tsrs/darwin-arm64@0.20.0-ts7.1.0-beta',
    '@tsrs/darwin-x64@0.20.0-ts7.1.0-beta',
    '@tsrs/linux-arm64-gnu@0.20.0-ts7.1.0-beta',
    '@tsrs/linux-arm64-musl@0.20.0-ts7.1.0-beta',
    '@tsrs/linux-x64-gnu@0.20.0-ts7.1.0-beta',
    '@tsrs/linux-x64-musl@0.20.0-ts7.1.0-beta',
    '@tsrs/win32-x64@0.20.0-ts7.1.0-beta',
  ];
  const createPackage = resolveCreatePackage(release);
  const policy = createPackage.bootstrapReleaseAgePolicy;
  const expected = [...baseline, ...compilerSelectors].sort((left, right) =>
    left.localeCompare(right),
  );
  assert.deepEqual(policy.minimumReleaseAgeExclude, expected);
  assert.equal(policy.minimumReleaseAge, 1440);
  assert.equal(policy.minimumReleaseAgeStrict, true);
  assert.equal(policy.minimumReleaseAgeIgnoreMissingTime, false);
  assert.equal(Object.isFrozen(policy.minimumReleaseAgeExclude), true);
  const args = createPnpmDlxArgs(createPackage, ['my-app']);
  assert.deepEqual(
    args.filter(value =>
      value.startsWith('--config.minimum-release-age-exclude='),
    ),
    expected.map(value => `--config.minimum-release-age-exclude=${value}`),
  );
  // Later edits to a manifest cannot expand the already-authenticated policy.
  release.createPackage.packageJson.dependencies.tsrs = 'latest';
  assert.deepEqual(
    createPackage.bootstrapReleaseAgePolicy.minimumReleaseAgeExclude,
    expected,
  );
});

test('bootstrap compiler exceptions ignore development, other packages and unauthenticated create metadata', async () => {
  const { resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const release = makeBootstrapRelease();
  const baseline =
    resolveCreatePackage(release).bootstrapReleaseAgePolicy
      .minimumReleaseAgeExclude;
  release.createPackage.packageJson.devDependencies = {
    '@effect/tsgo': '0.59.0',
    tsrs: '0.20.0-ts7.1.0-beta',
  };
  release.packages.find(
    item => item.sourceName === '@modern-js/utils',
  ).packageJson.dependencies = { tsrs: '0.20.0-ts7.1.0-beta' };
  release.createPackage = {
    ...release.createPackage,
    packageJson: {
      ...release.createPackage.packageJson,
      dependencies: {
        ...release.createPackage.packageJson.dependencies,
        tsrs: '0.20.0-ts7.1.0-beta',
      },
    },
  };
  assert.deepEqual(
    resolveCreatePackage(release).bootstrapReleaseAgePolicy
      .minimumReleaseAgeExclude,
    baseline,
  );
});

test('bootstrap rejects inexact or conflicting authenticated compiler pins', async () => {
  const { resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  for (const compiler of ['tsrs', '@effect/tsgo']) {
    for (const version of [
      'latest',
      '*',
      '^0.59.0',
      '0.59.x',
      '0.59.0 || 9.0.0',
      '0.59.0-..',
      'npm:unreviewed@0.59.0',
      'https://example.test/compiler.tgz',
      '0.59.0\n',
    ]) {
      const release = makeBootstrapRelease();
      release.createPackage.packageJson.dependencies[compiler] = version;
      assert.throws(
        () => resolveCreatePackage(release),
        /must use one exact bootstrap version/u,
      );
    }
    const release = makeBootstrapRelease();
    release.createPackage.packageJson.dependencies[compiler] = '0.59.0';
    release.createPackage.packageJson.optionalDependencies = {
      [compiler]: '0.58.0',
    };
    assert.throws(
      () => resolveCreatePackage(release),
      /must use one exact bootstrap version/u,
    );
  }
});

test('bootstrap compiler exemptions cannot be forged or broadened by cloning policy', async () => {
  const { createPnpmDlxArgs, resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const release = makeBootstrapRelease();
  Object.assign(release.createPackage.packageJson.dependencies, {
    '@effect/tsgo': '0.59.0',
    tsrs: '0.20.0-ts7.1.0-beta',
  });
  const actual = resolveCreatePackage(release);
  assert.doesNotThrow(() => createPnpmDlxArgs(actual, []));
  for (const extra of [
    undefined,
    'tsrs@*',
    'tsrs@0.19.0-ts7.1.0-beta',
    '@tsrs/unreviewed-host@0.20.0-ts7.1.0-beta',
    '@effect/other@0.59.0',
    'unrelated@0.59.0',
  ]) {
    const exclusions = [
      ...actual.bootstrapReleaseAgePolicy.minimumReleaseAgeExclude,
      ...(extra ? [extra] : []),
    ].sort((left, right) => left.localeCompare(right));
    assert.throws(
      () =>
        createPnpmDlxArgs(
          {
            ...actual,
            bootstrapReleaseAgePolicy: {
              ...actual.bootstrapReleaseAgePolicy,
              minimumReleaseAgeExclude: exclusions,
            },
          },
          [],
        ),
      /exact authenticated bootstrap release-age policy/u,
    );
  }
});

test('bootstrap release policy binds one exact cohort and sidecar selector set', async t => {
  const { releaseAgeExemptions } = await import(
    '../published-create-proof/release-age-audit.mjs'
  );
  const { createAcceptanceReleaseAgeEnv } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const { resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-age-set-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policyPath = path.join(root, 'release-age-policy.json');
  writeJson(root, 'release-age-policy.json', {
    schema: 'bleedingdev.ultramodern.release-age-exceptions',
    schemaVersion: 2,
    entries: [],
  });
  const release = makeBootstrapRelease();
  release.sidecars = {
    packages: [makeBootstrapSidecar('@bleedingdev/mf-bridge-react', '1.0.0')],
  };
  const exemptions = releaseAgeExemptions(release, { policyPath });
  assert.equal(exemptions.length, release.packages.length + 1);
  assert.ok(exemptions.includes('@bleedingdev/mf-bridge-react@1.0.0'));
  // No lane may derive a set without the reviewed policy.
  assert.throws(
    () => releaseAgeExemptions(release, {}),
    /require the reviewed exception policy path/u,
  );
  const env = createAcceptanceReleaseAgeEnv(
    { PATH: '/exact/pnpm' },
    resolveCreatePackage(release),
    exemptions,
  );
  assert.equal(
    env.pnpm_config_minimum_release_age_exclude,
    JSON.stringify(exemptions),
  );
  assert.equal(env.pnpm_config_minimum_release_age, '1440');
  assert.equal(env.pnpm_config_minimum_release_age_strict, 'true');
  assert.equal(env.PATH, '/exact/pnpm');
  release.sidecars.packages[0].version = '1.*';
  assert.throws(
    () => releaseAgeExemptions(release, { policyPath }),
    /Acceptance command release-age exclusions/u,
  );
});

test('release acceptance shares authenticated compiler selectors across bootstrap, Tractor and workspace audit', async t => {
  const { auditReleaseAgePolicy, releaseAgeExemptions } = await import(
    '../published-create-proof/release-age-audit.mjs'
  );
  const { createAcceptanceReleaseAgeEnv } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const { resolveCreatePackage } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const { createTractorPnpmDlxArgs } = await import(
    '../tractor-downstream/main.mjs'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-age-set-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policyPath = path.join(root, 'release-age-policy.json');
  writeJson(root, 'release-age-policy.json', {
    schema: 'bleedingdev.ultramodern.release-age-exceptions',
    schemaVersion: 2,
    entries: [],
  });
  const release = makeBootstrapRelease();
  Object.assign(release.createPackage.packageJson.dependencies, {
    '@effect/tsgo': '0.59.0',
    tsrs: '0.20.0-ts7.1.0-beta',
    'unrelated-compiler': '9.9.9',
  });
  const createPackage = resolveCreatePackage(release);
  const exclusions = releaseAgeExemptions(release, { policyPath });
  assert.equal(exclusions.length, release.packages.length + 16);
  assert(exclusions.includes('tsrs@0.20.0-ts7.1.0-beta'));
  assert(exclusions.includes('@effect/tsgo-win32-x64@0.59.0'));
  assert(!exclusions.includes('unrelated-compiler@9.9.9'));
  assert(
    createPackage.bootstrapReleaseAgePolicy.minimumReleaseAgeExclude.every(
      selector => exclusions.includes(selector),
    ),
  );
  const env = createAcceptanceReleaseAgeEnv({}, createPackage, exclusions);
  assert.deepEqual(
    JSON.parse(env.pnpm_config_minimum_release_age_exclude),
    exclusions,
  );
  assert.equal(env.pnpm_config_trust_policy_exclude, undefined);
  assert.equal(env.pnpm_config_minimum_release_age, '1440');
  assert.equal(env.pnpm_config_minimum_release_age_strict, 'true');
  assert.equal(
    env.pnpm_config_minimum_release_age_ignore_missing_time,
    'false',
  );
  const args = createTractorPnpmDlxArgs(createPackage, exclusions, [
    'ultramodern',
    'validate',
  ]);
  assert.deepEqual(
    args.filter(value =>
      value.startsWith('--config.minimum-release-age-exclude='),
    ),
    exclusions.map(value => `--config.minimum-release-age-exclude=${value}`),
  );
  const workspace = {
    minimumReleaseAge: 1440,
    minimumReleaseAgeExclude: exclusions,
    minimumReleaseAgeIgnoreMissingTime: false,
    minimumReleaseAgeStrict: true,
    trustPolicy: 'no-downgrade',
    trustPolicyIgnoreAfter: 1440,
  };
  writeJson(root, 'pnpm-workspace.yaml', workspace);
  // This tests exclusion-policy agreement, not an install or compiler run.
  writeJson(root, 'pnpm-lock.yaml', {
    lockfileVersion: '9.0',
    importers: { '.': {} },
    packages: {},
    snapshots: {},
  });
  const auditOptions = {
    projectDir: root,
    release,
    commandExclusions: exclusions,
    registryUrl: 'https://registry.npmjs.org/',
    policyPath,
    parseYamlImpl: JSON.parse,
    verifyYamlTool: false,
    fetchImpl: () => {
      throw new Error('Empty dependency closure must not fetch metadata');
    },
  };
  const audit = await auditReleaseAgePolicy(auditOptions);
  assert.deepEqual(audit.exactExclusions, exclusions);
  for (const badExclusions of [
    exclusions.filter(value => value !== 'tsrs@0.20.0-ts7.1.0-beta'),
    [...exclusions, 'unrelated-compiler@9.9.9'].sort(),
  ]) {
    writeJson(root, 'pnpm-workspace.yaml', {
      ...workspace,
      minimumReleaseAgeExclude: badExclusions,
    });
    await assert.rejects(
      auditReleaseAgePolicy(auditOptions),
      /must list exactly the release cohort/u,
    );
  }
  release.createPackage.packageJson.dependencies.tsrs = '^0.20.0';
  assert.throws(
    () => releaseAgeExemptions(release, { policyPath }),
    /must use one exact bootstrap version/u,
  );
});

test('release-age audit honors only authenticated compiler pins with verified registry metadata', async t => {
  const { auditReleaseAgePolicy, releaseAgeExemptions } = await import(
    '../published-create-proof/release-age-audit.mjs'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-age-audit-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policyPath = path.join(root, 'release-age-policy.json');
  writeJson(root, 'release-age-policy.json', {
    schema: 'bleedingdev.ultramodern.release-age-exceptions',
    schemaVersion: 2,
    entries: [],
  });
  const release = makeNormalAcceptanceRelease();
  Object.assign(release.createPackage.packageJson.dependencies, {
    '@effect/tsgo': '0.59.0',
    tsrs: '0.20.0-ts7.1.0-beta',
    'unrelated-compiler': '9.9.9',
  });
  release.createPackage.packageJson.devDependencies = {
    '@effect/tsgo-dev-only': '0.59.0',
  };
  release.packages[1].packageJson.dependencies.tsrs = '0.19.0-ts7.1.0-beta';
  const exclusions = releaseAgeExemptions(release, { policyPath });
  const cohort = new Set(
    release.packages.map(item => `${item.targetName}@${item.version}`),
  );
  const compilerSelectors = exclusions.filter(value => !cohort.has(value));
  assert.equal(compilerSelectors.length, 16);
  const identities = compilerSelectors.map(selector => {
    const separator = selector.lastIndexOf('@');
    return {
      name: selector.slice(0, separator),
      version: selector.slice(separator + 1),
      integrity: `sha512-${Buffer.from(selector).toString('base64')}`,
    };
  });
  writeJson(root, 'pnpm-workspace.yaml', {
    minimumReleaseAge: 1440,
    minimumReleaseAgeExclude: exclusions,
    minimumReleaseAgeIgnoreMissingTime: false,
    minimumReleaseAgeStrict: true,
    trustPolicy: 'no-downgrade',
    trustPolicyIgnoreAfter: 1440,
  });
  const writeLock = entries =>
    writeJson(root, 'pnpm-lock.yaml', {
      lockfileVersion: '9.0',
      importers: {
        '.': {
          dependencies: Object.fromEntries(
            entries.map(item => [
              item.name,
              { specifier: item.version, version: item.version },
            ]),
          ),
        },
      },
      packages: Object.fromEntries(
        entries.map(item => [
          `${item.name}@${item.version}`,
          { resolution: { integrity: item.integrity } },
        ]),
      ),
      snapshots: Object.fromEntries(
        entries.map(item => [`${item.name}@${item.version}`, {}]),
      ),
    });
  writeLock(identities);
  let registryIntegrity;
  let publishedAt = '2026-10-27T12:00:00.000Z';
  const options = {
    projectDir: root,
    release,
    commandExclusions: exclusions,
    registryUrl: 'https://registry.npmjs.org/',
    policyPath,
    now: new Date('2026-10-27T12:15:00.000Z'),
    parseYamlImpl: JSON.parse,
    verifyYamlTool: false,
    fetchImpl: async url => {
      assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      const item = identities.find(identity => identity.name === name);
      assert(item, `Unexpected registry package ${name}`);
      return new Response(
        JSON.stringify({
          time: { [item.version]: publishedAt },
          versions: {
            [item.version]: {
              dist: { integrity: registryIntegrity ?? item.integrity },
            },
          },
        }),
        { status: 200 },
      );
    },
  };
  const audit = await auditReleaseAgePolicy(options);
  assert.equal(audit.approvals.length, 16);
  assert(
    audit.approvals.every(
      item => item.authority === 'authenticated-generator-compiler',
    ),
  );
  assert.deepEqual(
    audit.approvals.map(item => `${item.package}@${item.version}`).sort(),
    compilerSelectors,
  );
  assert(audit.approvals.every(item => item.integrity));
  registryIntegrity = 'sha512-ZGlmZmVyZW50';
  await assert.rejects(
    auditReleaseAgePolicy(options),
    /Registry metadata integrity mismatch/u,
  );
  registryIntegrity = undefined;
  for (publishedAt of [undefined, '2026-10-28T00:00:00.000Z']) {
    await assert.rejects(
      auditReleaseAgePolicy(options),
      /Registry publication time is (?:missing or invalid|in the future)/u,
    );
  }
  publishedAt = '2026-10-27T12:00:00.000Z';
  for (const [name, version] of [
    ['unrelated-compiler', '9.9.9'],
    ['@effect/tsgo-dev-only', '0.59.0'],
    ['@tsrs/unreviewed-host', '0.20.0-ts7.1.0-beta'],
    ['tsrs', '0.19.0-ts7.1.0-beta'],
    ['@effect/tsgo', '0.58.0'],
  ]) {
    const item = {
      name,
      version,
      integrity: 'sha512-dW5hcHByb3ZlZA==',
    };
    identities.unshift(item);
    writeLock([item]);
    await assert.rejects(
      auditReleaseAgePolicy(options),
      /immature package\(s\) without an exact, unexpired approval/u,
    );
    identities.shift();
  }
});

test('generated workspace commands cannot inherit release-age or trust policy overrides', async t => {
  const { createAcceptanceWorkspaceEnv } = await import(
    '../published-create-proof/process.mjs'
  );
  const overrides = {
    npm_config_minimum_release_age: '0',
    npm_config_minimumReleaseAge: '0',
    'pnpm_config_trust-policy-exclude': '["*"]',
    PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: '["*"]',
    PnPm_Config_Minimum_Release_Age_Strict: 'false',
    npm_config_minimum_release_age_ignore_missing_time: 'true',
    pnpm_config_trust_policy: 'off',
    NPM_CONFIG_TRUST_POLICY_EXCLUDE: '["*"]',
  };
  t.mock.property(process, 'env', { ...process.env, ...overrides });
  const runtimeEnv = {
    PATH: '/qualified/pnpm',
    npm_config_registry: 'https://registry.example.test/',
    pnpm_config_store_dir: '/owned/store',
    pnpm_config_trust_policy_exclude: '["foreign@1.0.0"]',
  };
  const original = { ...runtimeEnv };
  const env = createAcceptanceWorkspaceEnv(runtimeEnv);
  const childEnv = createProcessEnv(env);
  for (const name of [
    ...Object.keys(overrides),
    'pnpm_config_trust_policy_exclude',
  ]) {
    assert.equal(env[name], undefined);
    assert.equal(childEnv[name], undefined);
  }
  assert.deepEqual(runtimeEnv, original);
  for (const [name, value] of Object.entries(overrides)) {
    assert.equal(process.env[name], value);
  }
  assert.equal(childEnv.PATH, runtimeEnv.PATH);
  assert.equal(childEnv.npm_config_registry, runtimeEnv.npm_config_registry);
  assert.equal(
    childEnv.pnpm_config_store_dir,
    runtimeEnv.pnpm_config_store_dir,
  );
  assert.equal(childEnv.pnpm_config_pm_on_fail, 'ignore');
});

test('source candidate trust exempts only the verified Modern cohort and never release age', async () => {
  const { createAcceptanceWorkspaceEnv } = await import(
    '../published-create-proof/process.mjs'
  );
  const { createRegistryEnv } = await import(
    '../../ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs'
  );
  const version = '3.9.3-ultramodern.1';
  const release = {
    release: { version },
    packages: ['app-tools', 'runtime', 'runtime-extensions'].map(name => ({
      targetName: `@bleedingdev/modern-js-${name}`,
      version,
    })),
    sidecars: { packages: [{ name: '@bleedingdev/braces', version: '3.0.4' }] },
  };
  const selectors = release.packages
    .map(item => `${item.targetName}@${item.version}`)
    .sort();
  const registryEnv = createRegistryEnv({
    userConfigPath: '/source/registry.npmrc',
    cacheDir: '/source/npm-cache',
    verifiedPackages: release.packages,
  });
  // Full selectors order runtime-extensions before runtime, unlike target names.
  assert.deepEqual(
    JSON.parse(registryEnv.PNPM_CONFIG_TRUST_POLICY_EXCLUDE),
    selectors,
  );
  const runtimeEnv = {
    PATH: '/qualified/node/bin',
    ...registryEnv,
    pnpm_config_minimum_release_age: '0',
    npm_config_minimum_release_age_exclude: '["*"]',
    npm_config_trust_policy_exclude: '["*"]',
  };
  const original = { ...runtimeEnv };
  const env = createAcceptanceWorkspaceEnv(runtimeEnv, {
    mode: 'source',
    release,
    registryEnv,
  });
  assert.deepEqual(JSON.parse(env.pnpm_config_trust_policy_exclude), selectors);
  assert.equal(env.PNPM_CONFIG_TRUST_POLICY_EXCLUDE, undefined);
  assert.equal(env.npm_config_trust_policy_exclude, undefined);
  assert.equal(env.pnpm_config_minimum_release_age, undefined);
  assert.equal(env.npm_config_minimum_release_age_exclude, undefined);
  assert.equal(env.PATH, runtimeEnv.PATH);
  assert.deepEqual(runtimeEnv, original);
  for (const mode of [undefined, 'published']) {
    const ordinary = createAcceptanceWorkspaceEnv(runtimeEnv, {
      mode,
      release,
      registryEnv,
    });
    assert.equal(ordinary.pnpm_config_trust_policy_exclude, undefined);
    assert.equal(ordinary.PNPM_CONFIG_TRUST_POLICY_EXCLUDE, undefined);
  }
  for (const provided of [
    ['*'],
    [...selectors, 'foreign@1.0.0'],
    [...selectors, '@bleedingdev/braces@3.0.4'],
    selectors.slice(1),
    [...selectors].reverse(),
    [...selectors, selectors[0]],
    'not-an-array',
  ]) {
    assert.throws(
      () =>
        createAcceptanceWorkspaceEnv(runtimeEnv, {
          mode: 'source',
          release,
          registryEnv: {
            PNPM_CONFIG_TRUST_POLICY_EXCLUDE: JSON.stringify(provided),
          },
        }),
      /must equal the exact authenticated release cohort/u,
    );
  }
  assert.throws(
    () => createAcceptanceWorkspaceEnv(runtimeEnv, { mode: 'source', release }),
    /requires exact registry-provided cohort selectors/u,
  );
  assert.throws(
    () =>
      createAcceptanceWorkspaceEnv(runtimeEnv, {
        mode: 'source',
        registryEnv,
        release: {
          ...release,
          packages: [{ targetName: '@bleedingdev/*', version }],
        },
      }),
    /requires exact authenticated target names and versions/u,
  );
  assert.throws(
    () =>
      createAcceptanceWorkspaceEnv(runtimeEnv, { mode: 'source', registryEnv }),
    /requires the authenticated release cohort/u,
  );
});

test('acceptance production builds and runtime proofs use the same explicit local deployment addresses', async () => {
  const { createAcceptanceBuildEnv, createAcceptanceDeploymentEnv } =
    await import('../published-create-proof/acceptance-profile.mjs');
  const { createSmokeTargets } = await import('../browser-smoke/targets.mjs');
  const contract = {
    apps: [
      {
        id: 'shell-super-app',
        kind: 'shell',
        config: {
          source: {
            siteUrl: {
              defaultLocalhostPort: 3020,
              envFallbackOrder: ['SHELL_SUPER_APP_PORT'],
            },
          },
        },
        deploy: {
          cloudflare: {
            publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
          },
        },
      },
      {
        id: 'analytics',
        kind: 'vertical',
        config: {
          source: {
            siteUrl: {
              defaultLocalhostPort: 3030,
              envFallbackOrder: ['ANALYTICS_PORT'],
            },
          },
        },
        deploy: {
          cloudflare: { publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_ANALYTICS' },
        },
      },
    ],
  };
  const packageManagerEnv = {
    NODE_ENV: 'production',
    ANALYTICS_PORT: '4030',
    ULTRAMODERN_PUBLIC_URL_ANALYTICS: 'https://unrelated.example',
    npm_config_registry: 'http://localhost:4873',
  };
  const deploymentEnv = createAcceptanceDeploymentEnv(
    contract,
    packageManagerEnv,
  );
  const buildEnv = createAcceptanceBuildEnv(deploymentEnv, {});
  const { targets } = createSmokeTargets(contract, { env: deploymentEnv });
  for (const target of targets) {
    assert.equal(buildEnv[target.publicUrlEnv], target.baseUrl);
    assert.equal(buildEnv[target.portEnv], String(target.port));
  }
  assert.equal(
    buildEnv.ULTRAMODERN_PUBLIC_URL_ANALYTICS,
    'http://localhost:4030',
  );
  assert.equal(buildEnv.NODE_ENV, 'production');
  assert.equal(
    buildEnv.npm_config_registry,
    packageManagerEnv.npm_config_registry,
  );
  assert.equal(
    packageManagerEnv.ULTRAMODERN_PUBLIC_URL_ANALYTICS,
    'https://unrelated.example',
  );
});

test('acceptance smoke ports stay reserved through build and release for runtime startup', async () => {
  const { createAcceptanceDeploymentEnv, reserveAcceptanceSmokePorts } =
    await import('../published-create-proof/acceptance-profile.mjs');
  const contract = {
    apps: [
      {
        id: 'shell-super-app',
        kind: 'shell',
        config: {
          source: {
            siteUrl: {
              defaultLocalhostPort: 3020,
              envFallbackOrder: ['SHELL_SUPER_APP_PORT'],
            },
          },
        },
        deploy: {
          cloudflare: {
            publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
          },
        },
      },
    ],
  };
  const first = await reserveAcceptanceSmokePorts(contract);
  const second = await reserveAcceptanceSmokePorts(contract);
  try {
    const firstPort = Number(first.portEnv.SHELL_SUPER_APP_PORT);
    const secondPort = Number(second.portEnv.SHELL_SUPER_APP_PORT);
    assert.ok(firstPort > 0);
    assert.ok(secondPort > 0);
    assert.notEqual(firstPort, secondPort);
    const deploymentEnv = createAcceptanceDeploymentEnv(
      contract,
      first.portEnv,
    );
    assert.equal(
      deploymentEnv.ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP,
      `http://localhost:${firstPort}`,
    );
    await first.release();
    await first.release();
    const rebound = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        rebound.once('error', reject);
        rebound.listen(firstPort, '127.0.0.1', resolve);
      });
    } finally {
      await new Promise((resolve, reject) =>
        rebound.close(error => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    await first.release();
    await second.release();
  }
});

test('acceptance children never inherit a source create bin or framework override', async () => {
  const { createAcceptancePackageManagerEnv } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const inherited = {
    MODERN_CREATE_ULTRAMODERN_FRAMEWORK_VERSION:
      process.env.MODERN_CREATE_ULTRAMODERN_FRAMEWORK_VERSION,
    ULTRAMODERN_CREATE_BIN: process.env.ULTRAMODERN_CREATE_BIN,
    ZE_CI_TOKEN: process.env.ZE_CI_TOKEN,
  };
  try {
    process.env.MODERN_CREATE_ULTRAMODERN_FRAMEWORK_VERSION =
      'inherited-framework-override';
    process.env.ULTRAMODERN_CREATE_BIN = '/inherited/source-create-bin.js';
    process.env.ZE_CI_TOKEN = 'inherited-zephyr-token';
    const effectiveEnv = createProcessEnv(
      createAcceptancePackageManagerEnv('/tmp/acceptance'),
    );
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(JSON.stringify({
          frameworkOverride: process.env.MODERN_CREATE_ULTRAMODERN_FRAMEWORK_VERSION,
          sourceCreateBin: process.env.ULTRAMODERN_CREATE_BIN,
          zephyrToken: process.env.ZE_CI_TOKEN,
        }))`,
      ],
      { encoding: 'utf8', env: effectiveEnv },
    );
    assert.equal(child.status, 0, child.stderr);
    // A leaked source create bin makes the published-package proof silently
    // run the local checkout instead of the published tarball.
    assert.deepEqual(
      JSON.parse(child.stdout),
      {},
      'the effective acceptance child environment must scrub inherited source/runtime and deploy overrides',
    );
  } finally {
    for (const [name, value] of Object.entries(inherited)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('acceptance defaults retain their existing private package-manager cache and store', async () => {
  const { createAcceptancePackageManagerEnv } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const workDir = path.resolve(os.tmpdir(), 'acceptance-default-env');
  const env = createAcceptancePackageManagerEnv(workDir);
  assert.equal(
    env.npm_config_store_dir,
    path.join(workDir, 'package-manager', 'store'),
  );
  assert.equal(env.pnpm_config_store_dir, env.npm_config_store_dir);
  assert.equal(
    env.npm_config_cache,
    path.join(workDir, 'package-manager', 'npm-cache'),
  );
  assert.equal(env.pnpm_config_package_import_method, undefined);
  assert.equal(env.npm_config_package_import_method, undefined);
  assert.equal(env.npm_config_ignore_scripts, undefined);
  assert.equal(env.pnpm_config_ignore_scripts, undefined);
});

test('runtime context carries the explicit external store and clone-or-copy through child environments', async () => {
  const { createAcceptanceRuntimeContext } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const workDir = path.resolve(os.tmpdir(), 'acceptance-store-env', 'work');
  const storeDir = path.resolve(workDir, '..', 'external-store');
  const environment = {
    PATH: '/injected/bin',
    PLAYWRIGHT_BROWSERS_PATH: path.resolve(workDir, '..', 'browsers'),
  };
  const pnpmExecutable = path.resolve(workDir, '..', 'tools', 'pnpm');
  const runImpl = () => {
    throw new Error('no package-manager command is needed');
  };
  const { env, pnpmExecutable: actualExecutable } =
    createAcceptanceRuntimeContext({
      workDir,
      environment,
      expectedPnpmVersion: '11.27.1',
      registryEnv: {
        npm_config_userconfig: path.join(workDir, 'registry.npmrc'),
        PNPM_CONFIG_STORE_DIR: '/registry/store-must-not-win',
        npm_config_store_dir: '/registry/store-must-not-win',
        PNPM_CONFIG_PACKAGE_IMPORT_METHOD: 'hardlink',
      },
      storeDir,
      runImpl,
      resolveExactPnpmExecutableImpl: (...args) => {
        assert.deepEqual(args, [runImpl, '11.27.1', environment, workDir]);
        return pnpmExecutable;
      },
    });
  assert.equal(actualExecutable, pnpmExecutable);
  assert.equal(
    env.PATH,
    [path.dirname(pnpmExecutable), environment.PATH].join(path.delimiter),
  );
  assert.equal(
    env.PLAYWRIGHT_BROWSERS_PATH,
    environment.PLAYWRIGHT_BROWSERS_PATH,
  );
  assert.equal(env.npm_config_userconfig, path.join(workDir, 'registry.npmrc'));
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:npm|pnpm)_config_(?:store_dir|package_import_method)$/i.test(key)))))',
    ],
    {
      encoding: 'utf8',
      env: createProcessEnv(env),
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    npm_config_store_dir: storeDir,
    pnpm_config_store_dir: storeDir,
    npm_config_package_import_method: 'clone-or-copy',
    pnpm_config_package_import_method: 'clone-or-copy',
  });
  assert.equal(env.npm_config_ignore_scripts, undefined);
  assert.equal(env.pnpm_config_ignore_scripts, undefined);
});

test('explicit acceptance stores reject relative paths and disposable workspace descendants', async () => {
  const { createAcceptancePackageManagerEnv } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const workDir = path.resolve(os.tmpdir(), 'acceptance-store-validation');
  for (const storeDir of ['store', '', ' ', `${workDir}\0bad`]) {
    assert.throws(
      () =>
        createAcceptancePackageManagerEnv(
          workDir,
          {},
          undefined,
          {},
          { storeDir },
        ),
      /must be an absolute path/u,
    );
  }
  for (const storeDir of [
    workDir,
    path.join(workDir, 'store'),
    path.join(workDir, 'nested', '..', 'store'),
  ]) {
    assert.throws(
      () =>
        createAcceptancePackageManagerEnv(
          workDir,
          {},
          undefined,
          {},
          { storeDir },
        ),
      /must be outside/u,
    );
  }
});

test('the provisioned pnpm wins over a stale shim and a version mismatch fails closed', async t => {
  const { resolveExactPnpmExecutable } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const exactPnpmDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultramodern-exact-pnpm-'),
  );
  t.after(() => fs.rmSync(exactPnpmDir, { force: true, recursive: true }));
  const pnpmBinaryName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const exactPnpmExecutable = path.join(exactPnpmDir, pnpmBinaryName);
  fs.writeFileSync(exactPnpmExecutable, 'acceptance test executable');
  fs.chmodSync(exactPnpmExecutable, 0o755);
  const stalePnpmDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultramodern-stale-pnpm-shim-'),
  );
  t.after(() => fs.rmSync(stalePnpmDir, { force: true, recursive: true }));
  const stalePnpmExecutable = path.join(stalePnpmDir, pnpmBinaryName);
  fs.writeFileSync(stalePnpmExecutable, 'stale acceptance test executable');
  fs.chmodSync(stalePnpmExecutable, 0o755);

  assert.equal(
    resolveExactPnpmExecutable(
      command => {
        if (command === exactPnpmExecutable) {
          return '11.17.0';
        }
        if (command === stalePnpmExecutable || command === 'pnpm') {
          return '11.11.0';
        }
        throw new Error(`Unexpected command ${command}`);
      },
      '11.17.0',
      {
        PATH: stalePnpmDir,
        ULTRAMODERN_PNPM_EXECUTABLE: exactPnpmExecutable,
      },
      exactPnpmDir,
    ),
    exactPnpmExecutable,
    'an explicitly provisioned manifest pnpm must win over a stale project shim',
  );
  // Installing the acceptance workspace with a pnpm the manifest did not pin
  // produces a lockfile the release never validated.
  assert.throws(
    () =>
      resolveExactPnpmExecutable(
        command => {
          if (command === 'pnpm') {
            throw new Error('nested discovery unavailable');
          }
          assert.equal(command, exactPnpmExecutable);
          return '11.14.0';
        },
        '11.17.0',
        { PATH: exactPnpmDir },
        exactPnpmDir,
      ),
    /resolved 11\.14\.0, expected 11\.17\.0/u,
  );
});

test('default-off clean-room install excludes and cannot resolve RSC runtimes', async t => {
  const { assertDefaultOffRscInstall } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultramodern-default-off-rsc-'),
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const appRoot = path.join(root, 'apps', 'shell');
  const runtimeRoot = path.join(root, 'node_modules', '@modern-js', 'runtime');
  const renderRoot = path.join(
    runtimeRoot,
    'node_modules',
    '@modern-js',
    'render',
  );
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(renderRoot, { recursive: true });
  writeJson(root, 'apps/shell/package.json', {
    name: '@acceptance/shell',
    dependencies: { '@modern-js/runtime': '3.5.0-ultramodern.103' },
  });
  writeJson(root, 'node_modules/@modern-js/runtime/package.json', {
    name: '@modern-js/runtime',
    exports: { '.': './index.js' },
  });
  fs.writeFileSync(path.join(runtimeRoot, 'index.js'), 'module.exports = {}\n');
  writeJson(
    root,
    'node_modules/@modern-js/runtime/node_modules/@modern-js/render/package.json',
    {
      name: '@modern-js/render',
      exports: { './client': './client.js' },
    },
  );
  fs.writeFileSync(path.join(renderRoot, 'client.js'), 'module.exports = {}\n');

  const cleanClosure = [{ name: 'clean-dependency', version: '1.0.0' }];
  assert.deepEqual(assertDefaultOffRscInstall(root, cleanClosure), {
    appPackage: '@acceptance/shell',
    forbiddenDependencyCount: 0,
    renderClient: fs.realpathSync(path.join(renderRoot, 'client.js')),
  });

  assert.throws(
    () =>
      assertDefaultOffRscInstall(
        root,
        cleanClosure.concat({
          name: 'rsbuild-plugin-rsc',
          version: '0.1.1',
        }),
      ),
    /contains forbidden RSC dependencies: rsbuild-plugin-rsc/u,
  );

  // A default-off app that can still resolve the RSC client ships a second
  // React runtime into the user's bundle.
  const poisonRoot = path.join(
    renderRoot,
    'node_modules',
    'react-server-dom-rspack',
  );
  fs.mkdirSync(poisonRoot, { recursive: true });
  writeJson(
    root,
    'node_modules/@modern-js/runtime/node_modules/@modern-js/render/node_modules/react-server-dom-rspack/package.json',
    {
      name: 'react-server-dom-rspack',
      exports: { './client.browser': './client.browser.js' },
    },
  );
  fs.writeFileSync(
    path.join(poisonRoot, 'client.browser.js'),
    'module.exports = {}\n',
  );
  assert.throws(
    () => assertDefaultOffRscInstall(root, cleanClosure),
    /must not resolve react-server-dom-rspack\/client\.browser/u,
  );
});

test('acceptance Git setup refuses to commit into an enclosing repository', async () => {
  const { configureAcceptanceWorkspaceGit } = await import(
    '../published-create-proof/acceptance-profile.mjs'
  );
  const fixture = createGitFixture({ prefix: 'acceptance-git-root-' });
  const parent = fixture.repoDir;
  const nested = path.join(parent, 'generated');
  const calls = [];
  const runImpl = (command, args, options = {}) => {
    calls.push(args);
    const result = spawnSync(command, args, {
      cwd: options.cwd ?? parent,
      encoding: 'utf8',
      env: options.env ?? fixture.env,
      stdio: 'pipe',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(nested, { recursive: true });
    runImpl('git', ['init', '--quiet']);
    fs.writeFileSync(path.join(parent, 'tracked.txt'), 'initial\n');
    runImpl('git', ['add', 'tracked.txt']);
    runImpl('git', ['commit', '--quiet', '-m', 'initial']);
    fs.writeFileSync(path.join(parent, 'tracked.txt'), 'staged\n');
    runImpl('git', ['add', 'tracked.txt']);
    fs.writeFileSync(path.join(parent, 'tracked.txt'), 'unstaged\n');
    fs.writeFileSync(path.join(nested, 'package.json'), '{"private":true}\n');
    const originalHead = runImpl('git', ['rev-parse', 'HEAD']);
    const originalFiles = new Map(
      ['HEAD', 'index', 'config'].map(name => [
        name,
        fs.readFileSync(path.join(parent, '.git', name)),
      ]),
    );

    // Running the proof inside somebody's checkout must not stage, commit, or
    // rewrite their working tree.
    calls.length = 0;
    assert.throws(
      () => configureAcceptanceWorkspaceGit(nested, fixture.env, runImpl),
      /workspace must be its own Git root:.*Use a work directory outside an existing repository/u,
    );
    assert.deepEqual(calls, [['rev-parse', '--show-toplevel']]);
    for (const [name, original] of originalFiles) {
      assert.deepEqual(
        fs.readFileSync(path.join(parent, '.git', name)),
        original,
        `parent ${name} changed`,
      );
    }
    assert.equal(runImpl('git', ['rev-parse', 'HEAD']), originalHead);
  } finally {
    fixture.cleanup();
  }
});

test('browser smoke diagnostics redact structured and embedded JSON secrets', async () => {
  const { createBrowserSmokeFailureDetails } = await import(
    '../published-create-proof/browser-smoke.mjs'
  );
  for (const body of [
    {
      AUTH_TOKEN: 'object-secret',
      nested: { password: 'nested-secret' },
    },
    '<pre>{"AUTH_TOKEN":"string-secret","password":"embedded-secret"}</pre>',
  ]) {
    const details = createBrowserSmokeFailureDetails({
      apiResponse: { body, status: 500 },
    });
    const serialized = JSON.stringify(details);
    assert.doesNotMatch(serialized, /object-secret|nested-secret/u);
    assert.doesNotMatch(serialized, /string-secret|embedded-secret/u);
    assert.match(serialized, /\[REDACTED\]/u);
    assert.ok(details.apiResponse.body.length <= 2_048);
  }
});

test('asserts generated cohorts only from strict manifest expectations', async t => {
  const { assertGeneratedCohort } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const { YAML_SPECIFIER, YAML_VERSION } = await import(
    '../published-create-proof/release-age-audit.mjs'
  );
  const yamlRequire = createRequire(
    path.join(__dirname, '../../prebundle/package.json'),
  );
  const yamlManifest = yamlRequire('js-yaml/package.json');
  assert.equal(yamlManifest.version, YAML_VERSION);
  const yamlCli = path.join(
    path.dirname(yamlRequire.resolve('js-yaml/package.json')),
    yamlManifest.bin['js-yaml'],
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'published-create-cohort-'),
  );
  const catalogPath = path.join(root, 'pnpm-workspace.yaml');
  // Exercise the installed pinned CLI without downloading it for each check.
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(command, 'pnpm');
    assert.deepEqual(args, ['dlx', YAML_SPECIFIER, catalogPath]);
    return spawnSync(process.execPath, [yamlCli, catalogPath], options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const version = '3.2.0-framework.1';
  const release = {
    aliases: {
      '@modern-js/ultramodern-create':
        '@bleedingdev/modern-js-ultramodern-create',
      '@modern-js/runtime': '@bleedingdev/modern-js-runtime',
    },
    createPackage: {
      sourceName: '@modern-js/ultramodern-create',
      targetName: '@bleedingdev/modern-js-ultramodern-create',
      version,
    },
    packages: [
      {
        sourceName: '@modern-js/ultramodern-create',
        targetName: '@bleedingdev/modern-js-ultramodern-create',
      },
      {
        sourceName: '@modern-js/runtime',
        targetName: '@bleedingdev/modern-js-runtime',
      },
    ],
    publishOrder: [
      '@bleedingdev/modern-js-runtime',
      '@bleedingdev/modern-js-ultramodern-create',
    ],
    release: { version },
  };
  const cohortProjection = {
    aliases: release.aliases,
    packages: release.packages.map(item => ({ ...item, version })),
    release: { tag: 'latest', version },
    schema: 'bleedingdev.ultramodern.release-cohort',
    schemaVersion: 2,
    sidecars: [],
    source: {
      commit: 'a'.repeat(40),
      repository: 'BleedingDev/ultramodern.js',
    },
  };

  try {
    fs.writeFileSync(
      catalogPath,
      `catalogs:\n  ultramodern:\n    '@modern-js/ultramodern-create': npm:@bleedingdev/modern-js-ultramodern-create@${version}\n    '@modern-js/runtime': npm:@bleedingdev/modern-js-runtime@${version}\n`,
    );
    writeJson(root, 'package.json', {
      devDependencies: {
        '@modern-js/ultramodern-create': 'catalog:ultramodern',
      },
      dependencies: {
        '@modern-js/runtime': 'catalog:ultramodern',
      },
    });
    const producer = 'node_modules/@modern-js/ultramodern-create';
    writeJson(root, `${producer}/package.json`, {
      name: '@bleedingdev/modern-js-ultramodern-create',
      version,
    });
    release.cohortProjection = {
      sha256: writeCanonicalJson(
        root,
        `${producer}/release-cohort.json`,
        cohortProjection,
      ),
      value: cohortProjection,
    };

    assert.equal(assertGeneratedCohort(root, release).observedPackageCount, 2);

    const catalog = fs.readFileSync(catalogPath, 'utf8');
    fs.writeFileSync(
      catalogPath,
      `catalog:\n  '@modern-js/ultramodern-create': npm:@bleedingdev/modern-js-ultramodern-create@${version}\n  '@modern-js/runtime': npm:@bleedingdev/modern-js-runtime@${version}\n`,
    );
    writeJson(root, 'package.json', {
      devDependencies: { '@modern-js/ultramodern-create': 'catalog:' },
      dependencies: { '@modern-js/runtime': 'catalog:' },
    });
    assert.equal(assertGeneratedCohort(root, release).observedPackageCount, 2);

    for (const source of ['', 'null\n', 'inventory\n', '- inventory\n']) {
      fs.writeFileSync(catalogPath, source);
      assert.throws(
        () => assertGeneratedCohort(root, release),
        /must be a mapping|Expected one YAML document/u,
      );
    }
    fs.writeFileSync(
      catalogPath,
      `lockfileVersion: '9.0'\n${catalog}---\nlockfileVersion: '9.0'\n${catalog}`,
    );
    assert.throws(
      () => assertGeneratedCohort(root, release),
      /Expected one YAML document/u,
    );
    fs.writeFileSync(catalogPath, 'catalogs: [\n');
    assert.throws(
      () => assertGeneratedCohort(root, release),
      /Pinned YAML parser exited 1/u,
    );
    fs.writeFileSync(catalogPath, catalog);

    release.sidecars = {
      packages: [{ name: '@bleedingdev/mf-bridge-react', version: '1.0.0' }],
    };
    writeJson(root, 'package.json', {
      devDependencies: {
        '@modern-js/ultramodern-create': 'catalog:ultramodern',
      },
      dependencies: {
        '@modern-js/runtime': 'catalog:ultramodern',
        '@module-federation/bridge-react':
          'npm:@bleedingdev/mf-bridge-react@1.0.0',
      },
    });
    assert.equal(assertGeneratedCohort(root, release).observedPackageCount, 2);
    writeJson(root, 'package.json', {
      dependencies: {
        '@modern-js/runtime': 'catalog:ultramodern',
        '@module-federation/bridge-react':
          'npm:@bleedingdev/mf-bridge-react@1.0.1',
      },
    });
    assert.throws(
      () => assertGeneratedCohort(root, release),
      /must target exact verified sidecar/u,
    );
    writeJson(root, 'package.json', {
      dependencies: {
        '@modern-js/runtime': 'catalog:ultramodern',
        '@module-federation/bridge-react':
          'npm:@bleedingdev/unknown-sidecar@1.0.0',
      },
    });
    assert.throws(
      () => assertGeneratedCohort(root, release),
      /unknown BleedingDev cohort target/u,
    );
    writeJson(root, 'package.json', {
      devDependencies: {
        '@modern-js/ultramodern-create': 'catalog:ultramodern',
      },
      dependencies: {
        '@modern-js/runtime': 'catalog:ultramodern',
      },
    });

    fs.writeFileSync(
      catalogPath,
      catalog.replace(/^ {4}'@modern-js\/runtime'.*\n/mu, ''),
    );
    assert.throws(
      () => assertGeneratedCohort(root, release),
      /pnpm catalog ultramodern omits @modern-js\/runtime/u,
    );
    fs.writeFileSync(catalogPath, catalog);

    // A generated manifest carrying a range instead of the exact cohort
    // version silently installs a different framework build for the user.
    writeJson(root, 'package.json', {
      devDependencies: {
        '@modern-js/ultramodern-create': 'catalog:ultramodern',
      },
      dependencies: {
        '@modern-js/runtime': 'catalog:ultramodern',
        'runtime-compat':
          'npm:@bleedingdev/modern-js-runtime@^3.2.0-framework.1',
      },
    });
    assert.throws(
      () => assertGeneratedCohort(root, release),
      /runtime-compat must target exact cohort package @bleedingdev\/modern-js-runtime@3\.2\.0-framework\.1/u,
    );

    // The installed producer must carry the authenticated projection.
    fs.rmSync(path.join(root, producer, 'release-cohort.json'));
    assert.throws(
      () => assertGeneratedCohort(root, release),
      /authenticated release cohort is missing or unsafe/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
