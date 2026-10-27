const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProcessEnv, runCommand } = require('../../lib/process-kit');

const cohortInstallPromise = import('../tractor-downstream/cohort-install.mjs');
const runnerPromise = import('../tractor-downstream/main.mjs');
const producerEffectDependencies = {
  effect: '4.0.0',
  '@effect/opentelemetry': '4.0.0',
  '@effect/tsgo': '0.59.0',
};
const producerReactDependencies = {
  react: '19.3.0',
  'react-dom': '19.3.0',
  '@types/react': '19.3.0',
  '@types/react-dom': '19.3.0',
};
const releaseAgePromise = import(
  '../published-create-proof/release-age-audit.mjs'
);

function releaseAgeEntry(selector, overrides = {}) {
  const separator = selector.lastIndexOf('@');
  return {
    approvedBy: 'Tractor release reviewer',
    evidence: {
      sha256: 'a'.repeat(64),
      uri: `https://github.com/BleedingDev/ultramodern.js/commit/${'b'.repeat(40)}`,
    },
    expiresAt: '2026-08-27T02:46:55.656Z',
    integrity: 'sha512-QUFBQQ==',
    package: selector.slice(0, separator),
    reviewedAt: '2026-08-26T10:06:26.000Z',
    version: selector.slice(separator + 1),
    ...overrides,
  };
}

function writeReleaseAgePolicy(root, entries) {
  const policyPath = path.join(root, 'release-age-policy.json');
  fs.writeFileSync(
    policyPath,
    `${JSON.stringify({
      schema: 'bleedingdev.ultramodern.release-age-exceptions',
      schemaVersion: 2,
      entries,
    })}\n`,
  );
  return policyPath;
}

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tractor-downstream-contract-'),
  );
  fs.mkdirSync(path.join(root, 'apps/shell-super-app/locales/en'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({
      packageManager: 'pnpm@11.24.0',
      dependencies: {
        '@modern-js/runtime': 'catalog:ultramodern',
      },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(root, '.mise.toml'),
    '[tools]\nnode = "26.7.0"\npnpm = "11.24.0"\n',
  );
  fs.writeFileSync(
    path.join(root, 'tsconfig.base.json'),
    JSON.stringify({
      extends: './authored-compiler.json',
      compilerOptions: {
        strict: true,
        paths: { '@tractor/*': ['./shared/*'] },
        plugins: [
          {
            name: '@effect/language-service',
            ignoreEffectSuggestionsInTscExitCode: false,
            diagnosticSeverity: { unstableApiUsage: 'error' },
          },
        ],
      },
      exclude: ['authored-fixtures'],
    }),
  );
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    "catalogs:\n  ultramodern:\n    '@modern-js/runtime': npm:@bleedingdev/modern-js-runtime@3.5.0-ultramodern.50\n",
  );
  fs.mkdirSync(path.join(root, 'node_modules/@modern-js/ultramodern-create'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, 'node_modules/@modern-js/runtime'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, 'node_modules/@modern-js/runtime/package.json'),
    JSON.stringify({
      name: '@bleedingdev/modern-js-runtime',
      version: '3.5.0-ultramodern.50',
    }),
  );
  fs.writeFileSync(
    path.join(root, 'apps/shell-super-app/locales/en/shell.json'),
    '{"heading":"Tractor Store"}\n',
  );
  return root;
}

const release = {
  aliases: {
    '@modern-js/runtime': '@bleedingdev/modern-js-runtime',
  },
  tools: { node: process.version, pnpm: '12.11.2' },
  release: {
    version: '3.5.0-ultramodern.50',
  },
};

function writeAuthenticatedCohort(root) {
  const projection = {
    aliases: release.aliases,
    packages: [
      {
        sourceName: '@modern-js/runtime',
        targetName: '@bleedingdev/modern-js-runtime',
        version: release.release.version,
      },
    ],
    release: release.release,
    schema: 'bleedingdev.ultramodern.release-cohort',
    schemaVersion: 2,
    sidecars: [],
  };
  release.cohortProjection = { value: projection };
  fs.writeFileSync(
    path.join(
      root,
      'node_modules/@modern-js/ultramodern-create/release-cohort.json',
    ),
    `${JSON.stringify(projection)}\n`,
  );
}

const bootstrapVersion = '3.5.0-ultramodern.77';
const bootstrapSpecifier = `@bleedingdev/modern-js-ultramodern-create@${bootstrapVersion}`;
const bootstrapExclude = [bootstrapSpecifier];
const exactPnpmExecutable = '/opt/pnpm-11.17.0/bin/pnpm';

function packageManagerOptions(overrides) {
  return {
    createPackage: {
      bootstrapReleaseAgePolicy: {
        minimumReleaseAge: 1440,
        minimumReleaseAgeExclude: bootstrapExclude,
        minimumReleaseAgeIgnoreMissingTime: false,
        minimumReleaseAgeStrict: true,
      },
      exactSpecifier: bootstrapSpecifier,
      version: bootstrapVersion,
    },
    expectedPnpmVersion: '11.17.0',
    minimumReleaseAgeExclude: bootstrapExclude,
    registryEnv: {
      npm_config_registry: 'https://registry.npmjs.org/',
      pnpm_config_registry: 'https://registry.npmjs.org/',
    },
    resolveExactPnpmExecutableImpl: () => exactPnpmExecutable,
    ...overrides,
  };
}

test('native catalog and installed framework bind to the exact release', async () => {
  const {
    assertAuthenticatedTractorCohort,
    assertExactModernDependencySpecifiers,
  } = await cohortInstallPromise;
  const root = fixture();
  try {
    writeAuthenticatedCohort(root);
    assert.equal(
      assertAuthenticatedTractorCohort(root, release).catalogCount,
      1,
    );
    assert.equal(
      assertExactModernDependencySpecifiers(root, release).length,
      1,
    );
    fs.mkdirSync(path.join(root, '.modernjs'));
    fs.writeFileSync(path.join(root, '.modernjs/release-cohort.json'), '{}');
    assert.throws(
      () => assertAuthenticatedTractorCohort(root, release),
      /still carries retired/u,
    );
    fs.rmSync(path.join(root, '.modernjs'), { recursive: true });
    const catalogPath = path.join(root, 'pnpm-workspace.yaml');
    const catalogText = fs.readFileSync(catalogPath, 'utf8');
    fs.writeFileSync(
      catalogPath,
      catalogText.replace('3.5.0-ultramodern.50', '3.5.0-ultramodern.49'),
    );
    assert.throws(
      () => assertAuthenticatedTractorCohort(root, release),
      /catalog.*exact release/u,
    );
    fs.writeFileSync(catalogPath, catalogText);
    const manifestPath = path.join(root, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['@modern-js/runtime'] =
      'npm:@bleedingdev/modern-js-runtime@3.5.0-ultramodern.50';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => assertExactModernDependencySpecifiers(root, release),
      /must use catalog:ultramodern/u,
    );
    manifest.dependencies['@modern-js/runtime'] = 'catalog:ultramodern';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(root, 'node_modules/@modern-js/runtime/package.json'),
      JSON.stringify({
        name: '@bleedingdev/modern-js-runtime',
        version: '3.5.0-ultramodern.49',
      }),
    );
    assert.throws(
      () => assertExactModernDependencySpecifiers(root, release),
      /installed identity\/version differs/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release-age exclusions are exact specifiers, sorted as specifiers, and reach pnpm dlx', async t => {
  const { createTractorPnpmDlxArgs } = await runnerPromise;
  const { releaseAgeExemptions } = await releaseAgePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-dlx-policy-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const releaseVersion = '3.8.2-ultramodern.15';
  // `-` sorts before `@`, so these two names sort differently as names than as
  // full `name@version` specifiers; pnpm only accepts the specifier order.
  const strictRelease = {
    packages: [
      { targetName: '@bleedingdev/modern-js-plugin', version: releaseVersion },
      {
        targetName: '@bleedingdev/modern-js-plugin-testing',
        version: releaseVersion,
      },
      {
        targetName: '@bleedingdev/modern-js-ultramodern-create',
        version: releaseVersion,
      },
    ],
    release: { version: releaseVersion },
  };
  const expected = [
    '@bleedingdev/modern-js-plugin-testing@3.8.2-ultramodern.15',
    '@bleedingdev/modern-js-plugin@3.8.2-ultramodern.15',
    '@bleedingdev/modern-js-ultramodern-create@3.8.2-ultramodern.15',
    '@rspack/core@2.2.0',
  ];

  // An empty policy must not resurrect retired third-party exceptions into a
  // release install.
  assert.deepEqual(
    releaseAgeExemptions(strictRelease, {
      policyPath: writeReleaseAgePolicy(root, []),
      now: new Date('2026-08-26T12:00:00.000Z'),
    }),
    expected.filter(selector => selector.startsWith('@bleedingdev/')),
  );

  const minimumReleaseAgeExclude = releaseAgeExemptions(strictRelease, {
    policyPath: writeReleaseAgePolicy(root, [
      releaseAgeEntry('@rspack/core@2.2.0'),
    ]),
    now: new Date('2026-08-26T12:00:00.000Z'),
  });
  assert.deepEqual(minimumReleaseAgeExclude, expected);

  const args = createTractorPnpmDlxArgs(
    {
      bootstrapReleaseAgePolicy: {
        minimumReleaseAge: 1440,
        minimumReleaseAgeExclude: [
          `@bleedingdev/modern-js-ultramodern-create@${releaseVersion}`,
        ],
        minimumReleaseAgeIgnoreMissingTime: false,
        minimumReleaseAgeStrict: true,
      },
      exactSpecifier: `@bleedingdev/modern-js-ultramodern-create@${releaseVersion}`,
      version: releaseVersion,
    },
    minimumReleaseAgeExclude,
    ['ultramodern', 'validate'],
  );
  assert.deepEqual(
    args.filter(argument =>
      argument.startsWith('--config.minimum-release-age-exclude='),
    ),
    expected.map(
      selector => `--config.minimum-release-age-exclude=${selector}`,
    ),
  );
  assert.deepEqual(args.slice(-2), ['ultramodern', 'validate']);
});

test('Tractor bootstrap rejects wildcard, future-dated and unbound release-age approvals', async t => {
  const { releaseAgeExemptions } = await releaseAgePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-dlx-invalid-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const now = new Date('2026-08-26T12:00:00.000Z');
  const strictRelease = {
    packages: [
      {
        targetName: '@bleedingdev/modern-js-ultramodern-create',
        version: '3.8.2-ultramodern.15',
      },
    ],
    release: { version: '3.8.2-ultramodern.15' },
  };

  assert.throws(
    () =>
      releaseAgeExemptions(strictRelease, {
        policyPath: writeReleaseAgePolicy(root, [
          releaseAgeEntry('@rspack/core@2.2.0', { package: '@rspack/*' }),
        ]),
        now,
      }),
    /must be one exact npm package name/u,
  );

  assert.throws(
    () =>
      releaseAgeExemptions(strictRelease, {
        policyPath: writeReleaseAgePolicy(root, [
          releaseAgeEntry('@rspack/core@2.2.0', {
            expiresAt: '2026-08-28T12:00:00.000Z',
            reviewedAt: '2026-08-27T12:00:00.000Z',
          }),
        ]),
        now,
      }),
    /reviewedAt must not be in the future/u,
  );

  assert.throws(
    () =>
      releaseAgeExemptions(
        {
          ...strictRelease,
          packages: [
            {
              targetName: '@bleedingdev/modern-js-ultramodern-create',
              version: '3.8.2-ultramodern.14',
            },
          ],
        },
        { policyPath: writeReleaseAgePolicy(root, []), now },
      ),
    /must bind targetName to release version/u,
  );
});

test('runner CLI has no bypass flag and builds a hermetic package-manager env', async () => {
  const { createTractorPackageManagerContext, parseArgs } = await runnerPromise;
  assert.throws(() => parseArgs([]), /--manifest is required/u);
  assert.throws(
    () =>
      parseArgs([
        '--manifest',
        '/tmp/release/manifest.json',
        '--workspace',
        '/tmp',
        '--skip-browser',
      ]),
    /Unknown argument: --skip-browser/u,
  );

  const packageManagerRoot = path.join(
    os.tmpdir(),
    'tractor-package-manager-context',
  );
  const packageManager = createTractorPackageManagerContext(
    packageManagerOptions({
      packageManagerRoot,
      runImpl: () => {
        throw new Error('resolver stub must own executable discovery');
      },
    }),
  );
  // Accepted Node and pnpm win over inherited PATH entries; the install stays
  // aged and strict, and no trust-policy escape hatch reaches the child.
  assert.equal(packageManager.pnpmExecutable, exactPnpmExecutable);
  assert.deepEqual(packageManager.env.PATH.split(path.delimiter).slice(0, 2), [
    path.dirname(process.execPath),
    path.dirname(exactPnpmExecutable),
  ]);
  assert.equal(
    packageManager.env.pnpm_config_minimum_release_age_exclude,
    undefined,
  );
  assert.equal(packageManager.env.pnpm_config_minimum_release_age, undefined);
  assert.equal(
    packageManager.env.pnpm_config_minimum_release_age_strict,
    undefined,
  );
  assert.equal(packageManager.env.pnpm_config_trust_policy_exclude, undefined);
});

test('Tractor children use the acceptance Node despite an older mise Node on PATH', async t => {
  const { createTractorPackageManagerContext } = await runnerPromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-node-path-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const staleBin = path.join(root, 'baseline-bin');
  fs.mkdirSync(staleBin);
  fs.writeFileSync(
    path.join(staleBin, 'node'),
    '#!/bin/sh\nprintf "v26.7.0\\n"\n',
    { mode: 0o755 },
  );
  const { env } = createTractorPackageManagerContext({
    createPackage: packageManagerOptions().createPackage,
    expectedPnpmVersion: '12.11.2',
    environment: {
      ...process.env,
      PATH: `${staleBin}${path.delimiter}${process.env.PATH}`,
    },
    minimumReleaseAgeExclude: bootstrapExclude,
    packageManagerRoot: root,
    registryEnv: { npm_config_registry: 'https://registry.npmjs.org/' },
    resolveExactPnpmExecutableImpl: () => path.join(staleBin, 'pnpm'),
  });
  const child = runCommand('node', ['--version'], {
    env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  assert.equal(child.exitCode, 0);
  assert.equal(child.stdout.trim(), process.version);
});

test('Tractor obtains native policy from the exact generator and cleans its temporary workspace', async t => {
  const { readTractorProducerOverrides } = await runnerPromise;
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tractor-producer-policy-'),
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const env = {
    PATH: '/accepted/node/bin',
    npm_config_registry: 'https://registry.npmjs.org/',
  };
  const options = {
    createPackage: packageManagerOptions().createPackage,
    minimumReleaseAgeExclude: bootstrapExclude,
    packageManager: { pnpmExecutable: exactPnpmExecutable, env },
    packageManagerRoot: root,
  };
  const producerPolicy = readTractorProducerOverrides({
    ...options,
    runImpl(command, args, childOptions) {
      assert.equal(command, exactPnpmExecutable);
      assert.equal(childOptions.env, env);
      assert.equal(args[args.indexOf('dlx') + 2], bootstrapSpecifier);
      const workspace = args[args.indexOf('dlx') + 3];
      assert.equal(path.isAbsolute(workspace), true);
      assert.equal(path.dirname(workspace), childOptions.cwd);
      assert.equal(path.dirname(childOptions.cwd), root);
      fs.mkdirSync(workspace);
      fs.writeFileSync(
        path.join(workspace, 'package.json'),
        JSON.stringify({
          devDependencies: {
            ...producerEffectDependencies,
            ...producerReactDependencies,
          },
        }),
      );
      fs.writeFileSync(
        path.join(workspace, 'pnpm-workspace.yaml'),
        `minimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\ntrustPolicy: no-downgrade\ntrustPolicyIgnoreAfter: 1440\nminimumReleaseAgeExclude:\n${bootstrapExclude.map(selector => `  - ${JSON.stringify(selector)}`).join('\n')}\noverrides:\n  'braces@>=3.0.0 <3.0.4': npm:@bleedingdev/braces@3.0.4\n  'sharp@>=0.35.0 <0.35.5': 0.35.5\n`,
      );
    },
  });
  assert.deepEqual(producerPolicy, {
    producerEffectDependencies,
    producerReactDependencies,
    pnpmOverrides: {
      'braces@>=3.0.0 <3.0.4': 'npm:@bleedingdev/braces@3.0.4',
      'sharp@>=0.35.0 <0.35.5': '0.35.5',
    },
    minimumReleaseAgeExclude: bootstrapExclude,
    trustPolicy: 'no-downgrade',
    trustPolicyIgnoreAfter: 1440,
  });
  assert.deepEqual(fs.readdirSync(root), []);
  const { stringify: stringifyYaml } = await import('yaml');
  for (const invalid of [
    { minimumReleaseAge: 0 },
    { minimumReleaseAgeStrict: false },
    { minimumReleaseAgeIgnoreMissingTime: true },
    { trustPolicy: 'none' },
    { trustPolicyIgnoreAfter: 0 },
    { minimumReleaseAgeExclude: ['@bleedingdev/*'] },
    { minimumReleaseAgeExclude: [] },
  ]) {
    assert.throws(
      () =>
        readTractorProducerOverrides({
          ...options,
          runImpl(_command, args) {
            const workspace = args[args.indexOf('dlx') + 3];
            fs.mkdirSync(workspace);
            fs.writeFileSync(
              path.join(workspace, 'pnpm-workspace.yaml'),
              stringifyYaml({
                overrides: producerPolicy.pnpmOverrides,
                minimumReleaseAge: 1440,
                minimumReleaseAgeStrict: true,
                minimumReleaseAgeIgnoreMissingTime: false,
                minimumReleaseAgeExclude: bootstrapExclude,
                trustPolicy: 'no-downgrade',
                trustPolicyIgnoreAfter: 1440,
                ...invalid,
              }),
            );
          },
        }),
      /producer workspace/iu,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  }
  assert.throws(
    () =>
      readTractorProducerOverrides({
        ...options,
        runImpl() {
          throw new Error('generator failed');
        },
      }),
    /generator failed/u,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test('Tractor CLI accepts an absolute shared store and rejects invalid paths', async () => {
  const { parseArgs } = await runnerPromise;
  const args = [
    '--manifest',
    path.join(os.tmpdir(), 'release/manifest.json'),
    '--workspace',
    os.tmpdir(),
  ];
  const storeDir = path.join(os.tmpdir(), 'shared pnpm store');
  assert.equal(parseArgs(args).storeDir, undefined);
  assert.equal(
    parseArgs([...args, '--store-dir', storeDir]).storeDir,
    storeDir,
  );
  for (const invalid of [
    './store',
    '../store',
    `${storeDir}\0invalid`,
    ` ${storeDir}`,
    `${storeDir} `,
  ]) {
    assert.throws(
      () => parseArgs([...args, '--store-dir', invalid]),
      /--store-dir must be an absolute path/u,
    );
  }
});

test('Tractor commands use the selected external store with clone-or-copy imports', async t => {
  const { createTractorPackageManagerContext, executeTractorCommands } =
    await runnerPromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-shared-store-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const packageManagerRoot = path.join(root, 'package-manager');
  const storeDir = path.join(root, 'shared store');
  const packageManager = createTractorPackageManagerContext(
    packageManagerOptions({
      packageManagerRoot,
      storeDir,
      registryEnv: {
        npm_config_registry: 'https://registry.npmjs.org/',
        pnpm_config_registry: 'https://registry.npmjs.org/',
        NPM_CONFIG_STORE_DIR: '/inherited/wrong-store',
        pnpm_config_store_dir: '/registry/wrong-store',
        PNPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy',
      },
    }),
  );
  const expectedStoreEnv = {
    npm_config_package_import_method: 'clone-or-copy',
    npm_config_store_dir: storeDir,
    pnpm_config_package_import_method: 'clone-or-copy',
    pnpm_config_store_dir: storeDir,
  };
  const observed = [];
  Array.from(
    executeTractorCommands({
      workspace: root,
      env: packageManager.env,
      report: { checks: [] },
      runImpl(_command, _args, options) {
        observed.push(options.env);
        assert.equal(options.cwd, root);
      },
    }),
  );
  assert.equal(observed.length, 7);
  for (const env of observed) {
    for (const [name, value] of Object.entries(expectedStoreEnv)) {
      assert.equal(env[name], value, name);
    }
    assert.equal(env.NPM_CONFIG_STORE_DIR, undefined);
    assert.equal(env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD, undefined);
    assert.equal(env.pnpm_config_minimum_release_age, undefined);
    assert.equal(env.pnpm_config_minimum_release_age_strict, undefined);
    assert.equal(env.pnpm_config_trust_policy_exclude, undefined);
  }
  const child = runCommand(
    process.execPath,
    [
      '-e',
      `process.stdout.write(JSON.stringify(Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          /^(?:npm|pnpm)_config_(?:store_dir|package_import_method)$/iu.test(name),
        ),
      )))`,
    ],
    {
      encoding: 'utf8',
      env: createProcessEnv(packageManager.env),
      stdio: 'pipe',
    },
  );
  assert.equal(child.exitCode, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), expectedStoreEnv);
  assert.throws(
    () =>
      createTractorPackageManagerContext(
        packageManagerOptions({
          packageManagerRoot,
          storeDir: path.join(packageManagerRoot, 'private-store'),
        }),
      ),
    /external store must be outside its work directory/u,
  );
});

test('runner strips inherited age and trust policies from ordinary workspace commands', async () => {
  const { createTractorPackageManagerContext } = await runnerPromise;
  // One representative per casing family: the child env is filtered
  // case-insensitively, so a poisoned parent cannot widen the install.
  const inheritedKeys = [
    'NPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE',
    'npm_config_trust_policy_exclude',
    'PnPm_Config_Minimum_Release_Age_Exclude',
    'pnpm_config_trust_policy_exclude',
    'NPM_CONFIG_MINIMUM_RELEASE_AGE',
    'PnPm_Config_Minimum_Release_Age_Strict',
    'pnpm_config_minimum_release_age_ignore_missing_time',
    'NPM_CONFIG_TRUST_POLICY',
  ];
  const inherited = Object.fromEntries(
    inheritedKeys.map(name => [name, process.env[name]]),
  );
  try {
    for (const name of inheritedKeys) {
      process.env[name] = '*';
    }
    for (const sourceSelectors of [
      undefined,
      JSON.stringify(bootstrapExclude),
    ]) {
      const packageManager = createTractorPackageManagerContext(
        packageManagerOptions({
          packageManagerRoot: path.join(
            os.tmpdir(),
            'tractor-poisoned-package-manager-context',
          ),
          registryEnv: {
            npm_config_registry: 'https://registry.npmjs.org/',
            pnpm_config_registry: 'https://registry.npmjs.org/',
            PNPM_CONFIG_TRUST_POLICY_EXCLUDE: sourceSelectors,
          },
        }),
      );
      const child = runCommand(
        process.execPath,
        [
          '-e',
          `process.stdout.write(JSON.stringify(Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(?:npm|pnpm)_config_(?:minimum_release_age|trust_policy)(?:_|$)/iu.test(name),
          ),
        )))`,
        ],
        {
          encoding: 'utf8',
          env: createProcessEnv(packageManager.env),
          stdio: 'pipe',
        },
      );
      assert.equal(child.exitCode, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), {});
    }
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

test('Node acceptance rejects hydrated CSR without authoritative no-JS distributed SSR evidence', async () => {
  const { proveNodeServerRenderedSsr } = await runnerPromise;
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tractor-node-ssr-contract-'),
  );
  const targets = [
    {
      app: {
        id: 'explore',
        kind: 'vertical',
        api: { prefix: '/explore-api', stem: 'explore' },
        styling: { federation: { rootSelector: '[data-app-id="explore"]' } },
      },
      baseUrl: 'http://localhost:3021',
      routes: { distributedSsr: '/en', ssr: '/en' },
    },
    {
      app: {
        id: 'shell-super-app',
        kind: 'shell',
        moduleFederation: { verticalRefs: ['explore'] },
        styling: {
          federation: { rootSelector: '[data-app-id="shell-super-app"]' },
        },
      },
      baseUrl: 'http://localhost:3020',
      routes: { distributedSsr: '/en/tractors/CL-08-GR', ssr: '/en' },
    },
  ];
  const pass = type => ({ status: 'pass', type });
  const validateHttpTargetImpl = async target => [
    pass('ssr-route'),
    pass('ui-marker-html'),
    pass('css-root-marker'),
    ...(target.app.api ? [pass('effect-readiness')] : []),
  ];
  const validNoJavaScriptSsr = async target =>
    target.app.kind === 'shell'
      ? [
          pass('no-js-distributed-ssr-route'),
          pass('no-js-shell-composition-boundary'),
          pass('no-js-ssr-css-root-marker'),
          pass('no-js-ssr-failed-responses'),
        ]
      : [
          pass('no-js-ssr-ui-marker'),
          pass('no-js-ssr-css-root-marker'),
          pass('no-js-ssr-failed-responses'),
        ];

  const prove = overrides =>
    proveNodeServerRenderedSsr({
      artifactDir: root,
      browser: {},
      targets,
      validateHttpTargetImpl,
      validateNoJavaScriptSsrTargetImpl: validNoJavaScriptSsr,
      ...overrides,
    });

  try {
    assert.equal((await prove({})).status, 'pass');

    // A shell that renders none of its verticals with JavaScript disabled.
    await assert.rejects(
      () =>
        prove({
          validateNoJavaScriptSsrTargetImpl: async target =>
            target.app.kind === 'shell'
              ? [
                  pass('no-js-distributed-ssr-route'),
                  pass('no-js-ssr-css-root-marker'),
                  pass('no-js-ssr-failed-responses'),
                ]
              : validNoJavaScriptSsr(target),
        }),
      /missing required no-js-shell-composition-boundary evidence/u,
    );

    // An empty server-rendered document that only hydrates client-side.
    await assert.rejects(
      () =>
        prove({
          validateHttpTargetImpl: async target => [
            pass('ssr-route'),
            pass('css-root-marker'),
            ...(target.app.api ? [pass('effect-readiness')] : []),
          ],
        }),
      /missing required ui-marker-html evidence/u,
    );

    // Proving SSR on the shell's own landing route instead of a federated one.
    const csrOnlyTargets = structuredClone(targets);
    csrOnlyTargets[1].routes.distributedSsr = csrOnlyTargets[1].routes.ssr;
    await assert.rejects(
      () => prove({ targets: csrOnlyTargets }),
      /requires a dedicated distributed-SSR route/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Node backend proof requires every API-bearing MicroVertical exactly once and passing', async () => {
  const { readPassingNodeBackendProof } = await runnerPromise;
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tractor-node-proof-contract-'),
  );
  const evidencePath = path.join(
    root,
    '.codex/reports/node-backend-federation-proof/proof.json',
  );
  const writeProof = proof =>
    fs.writeFileSync(evidencePath, `${JSON.stringify(proof)}\n`);
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.mkdirSync(path.join(root, 'topology'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'topology/reference-topology.json'),
      `${JSON.stringify({
        verticals: [
          { api: {}, id: 'explore', kind: 'vertical' },
          { api: {}, id: 'decide', kind: 'vertical' },
          { api: {}, id: 'checkout', kind: 'vertical' },
          { id: 'content', kind: 'vertical' },
        ],
      })}\n`,
    );

    // A skipped backend run must never read as proof.
    writeProof({ results: [], status: 'skipped' });
    assert.throws(
      () => readPassingNodeBackendProof(root),
      /was skipped or has no executed results/u,
    );

    // Silently dropping API-bearing verticals must not pass either.
    writeProof({
      results: [{ appId: 'explore', status: 'pass' }],
      status: 'pass',
    });
    assert.throws(
      () => readPassingNodeBackendProof(root),
      /app set must exactly match API-bearing MicroVerticals/u,
    );

    // A top-level `pass` must not outrank a failing per-app result.
    writeProof({
      results: [
        { appId: 'explore', status: 'pass' },
        { appId: 'decide', status: 'fail' },
        { appId: 'checkout', status: 'pass' },
      ],
      status: 'pass',
    });
    assert.throws(
      () => readPassingNodeBackendProof(root),
      /duplicate, malformed, or failing results/u,
    );

    writeProof({
      results: [
        { appId: 'explore', status: 'pass' },
        { appId: 'decide', status: 'pass' },
        { appId: 'checkout', status: 'pass' },
      ],
      status: 'pass',
    });
    assert.deepEqual(readPassingNodeBackendProof(root), {
      appIds: ['checkout', 'decide', 'explore'],
      evidencePath: '.codex/reports/node-backend-federation-proof/proof.json',
      resultCount: 3,
      status: 'pass',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Tractor stops on formatter failure without reporting format or running checks/builds', async () => {
  const { executeTractorCommands } = await runnerPromise;
  const report = { checks: [] };
  const calls = [];
  const failure = new Error('consumer formatter rejected a source file');
  const iterator = executeTractorCommands({
    workspace: '/tractor-format-failure-fixture',
    env: {},
    report,
    runImpl(command, args) {
      calls.push([command, ...args]);
      if (args[0] === 'format') throw failure;
    },
  });
  assert.throws(
    () => Array.from(iterator),
    error => error === failure,
  );
  assert.deepEqual(calls, [
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', 'exec', 'playwright', 'install', '--with-deps', 'chromium'],
    ['pnpm', 'format'],
  ]);
  assert.deepEqual(
    report.checks.map(check => check.id),
    ['install---frozen-lockfile'],
  );
});

test('Tractor synchronizes native delivery artifacts after installation and before validation', async () => {
  const { installTractorRelease } = await runnerPromise;
  const calls = [];
  const options = {
    workspace: '/tractor',
    createPackage: packageManagerOptions().createPackage,
    minimumReleaseAgeExclude: bootstrapExclude,
    packageManager: {
      pnpmExecutable: exactPnpmExecutable,
      env: { PATH: '/accepted/node' },
    },
  };
  installTractorRelease({
    ...options,
    runImpl(command, args, context) {
      assert.equal(command, exactPnpmExecutable);
      assert.equal(context.cwd, options.workspace);
      assert.equal(context.env, options.packageManager.env);
      if (args.includes('dlx'))
        assert.equal(args[args.indexOf('dlx') + 2], bootstrapSpecifier);
      calls.push(args.includes('dlx') ? args.at(-1) : args.join(' '));
    },
  });
  assert.deepEqual(calls, [
    'clean --lockfile',
    'install --no-frozen-lockfile',
    'sync-delivery-unit',
    'validate',
  ]);
  const stopped = [];
  assert.throws(
    () =>
      installTractorRelease({
        ...options,
        runImpl(_command, args) {
          stopped.push(args.at(-1));
          if (args.at(-1) === 'sync-delivery-unit')
            throw new Error('invalid authored renderer contract');
        },
      }),
    /invalid authored renderer contract/u,
  );
  assert.equal(stopped.includes('validate'), false);
});

test('Tractor command execution uses the exact pnpm executable after toolchain adoption', async () => {
  const { executeTractorCommands } = await runnerPromise;
  const commands = [];
  Array.from(
    executeTractorCommands({
      workspace: os.tmpdir(),
      env: {},
      report: { checks: [] },
      pnpmExecutable: exactPnpmExecutable,
      runImpl(command) {
        commands.push(command);
      },
    }),
  );
  assert.equal(commands.length > 0, true);
  assert.equal(
    commands.every(command => command === exactPnpmExecutable),
    true,
  );
});

test('workerd proof launches the accepted pnpm executable without consulting PATH', async t => {
  const { startWorkerdProof } = await import('../browser-smoke/bootstrap.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-workerd-pnpm-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const executable = path.join(root, 'accepted-pnpm');
  const receipt = path.join(root, 'args.json');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('WORKERD_URL=http://127.0.0.1:8787\\n');\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const runtime = await startWorkerdProof({
    artifactDir: path.join(root, 'reports'),
    pnpmExecutable: executable,
    processEnv: { PATH: '/unavailable-package-manager-path' },
    projectDir: root,
    timeoutMs: 5000,
  });
  try {
    assert.equal(runtime.baseUrl, 'http://127.0.0.1:8787');
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), [
      'run',
      'cloudflare:ssr-proof',
    ]);
  } finally {
    await runtime.stop();
  }
});

test('source-candidate rehearsal is bound to a loopback ephemeral registry', async () => {
  const {
    assertAcceptanceRegistry,
    parseArgs,
    runTractorDownstreamAcceptance,
  } = await runnerPromise;
  const manifestPath = path.join(os.tmpdir(), 'release', 'manifest.json');
  const argv = (...extra) => [
    '--manifest',
    manifestPath,
    '--workspace',
    os.tmpdir(),
    ...extra,
  ];

  // The published lane keeps its npmjs default.
  const published = parseArgs(argv());
  assert.equal(published.mode, 'published');
  assert.equal(published.registryUrl, 'https://registry.npmjs.org/');

  // A rehearsal names no registry: accepting a URL here is exactly how a
  // rehearsal could be pointed at real npm.
  const rehearsal = parseArgs(argv('--mode', 'source'));
  assert.equal(rehearsal.mode, 'source');
  assert.equal(rehearsal.registryUrl, undefined);
  assert.throws(
    () =>
      parseArgs(
        argv(
          '--mode',
          'source',
          '--registry-url',
          'https://registry.npmjs.org/',
        ),
      ),
    /--registry-url is decided by the ephemeral registry in source mode/u,
  );
  assert.throws(
    () => parseArgs(argv('--mode', 'rehearsal')),
    /--mode must be published or source/u,
  );

  // Both directions of the mode/registry pairing fail closed.
  assert.equal(
    assertAcceptanceRegistry('source', 'http://127.0.0.1:4873/'),
    'http://127.0.0.1:4873/',
  );
  assert.throws(
    () => assertAcceptanceRegistry('source', 'https://registry.npmjs.org/'),
    /must target the loopback ephemeral registry/u,
  );
  assert.throws(
    () => assertAcceptanceRegistry('published', 'http://127.0.0.1:4873/'),
    /never the ephemeral rehearsal registry/u,
  );

  // The acceptance settles mode and registry together, before it reads the
  // manifest or touches a workspace, so a rehearsal cannot reach real npm.
  await assert.rejects(
    runTractorDownstreamAcceptance({
      manifestPath: path.join(os.tmpdir(), 'absent', 'manifest.json'),
      mode: 'source',
      registryUrl: 'https://registry.npmjs.org/',
    }),
    /must target the loopback ephemeral registry/u,
  );
});

test('source-candidate rehearsal tears down its registry and refuses an escaped one', async t => {
  const { parseArgs, withSourceCandidateRegistry } = await runnerPromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-rehearsal-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const releaseVersion = '3.8.2-ultramodern.15';
  const rehearsalRelease = {
    packages: [
      {
        targetName: '@bleedingdev/modern-js-ultramodern-create',
        version: releaseVersion,
      },
    ],
    release: { version: releaseVersion },
    tools: { node: process.version, npm: '11.10.1', pnpm: '11.17.0' },
  };
  const storeDir = path.join(root, 'shared store');
  fs.mkdirSync(storeDir);
  const sharedStoreSentinel = path.join(storeDir, 'keep');
  fs.writeFileSync(sharedStoreSentinel, 'shared store belongs to the caller');
  const options = parseArgs([
    '--mode',
    'source',
    '--manifest',
    path.join(root, 'release', 'manifest.json'),
    '--workspace',
    root,
    '--store-dir',
    storeDir,
  ]);
  const seededEnv = {
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: path.join(root, '.npmrc'),
  };

  const starts = [];
  let stopped = 0;
  const observedRegistryEnvs = [];
  const returned = await withSourceCandidateRegistry(
    options,
    (registryUrl, registryEnv) => {
      assert.equal(registryUrl, 'http://127.0.0.1:4873/');
      observedRegistryEnvs.push(registryEnv);
      return 'accepted';
    },
    {
      readReleaseManifestImpl: () => rehearsalRelease,
      startEphemeralRegistryImpl: async started => {
        starts.push(started);
        assert.equal(fs.existsSync(started.rootDir), true);
        return {
          env: seededEnv,
          registryUrl: 'http://127.0.0.1:4873/',
          stop: () => {
            stopped += 1;
          },
        };
      },
    },
  );
  assert.equal(returned, 'accepted');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].storeDir, storeDir);
  assert.equal(stopped, 1);
  assert.equal(fs.existsSync(starts[0].rootDir), false);
  assert.equal(
    fs.readFileSync(sharedStoreSentinel, 'utf8'),
    'shared store belongs to the caller',
  );

  // The seeder's scoped user config reaches the acceptance verbatim, and
  // nothing in it names a registry globally, so unrelated dependencies are
  // still fetched from npmjs.
  assert.deepEqual(observedRegistryEnvs, [seededEnv]);
  for (const name of ['npm_config_registry', 'pnpm_config_registry']) {
    assert.equal(observedRegistryEnvs[0][name], undefined, name);
  }

  // A registry that came up anywhere but loopback is refused before any
  // downstream work runs, and is still torn down.
  let escapedRootDir;
  let escapedStops = 0;
  await assert.rejects(
    withSourceCandidateRegistry(options, () => 'must not run', {
      readReleaseManifestImpl: () => rehearsalRelease,
      startEphemeralRegistryImpl: async started => {
        escapedRootDir = started.rootDir;
        return {
          env: seededEnv,
          registryUrl: 'https://registry.npmjs.org/',
          stop: () => {
            escapedStops += 1;
          },
        };
      },
    }),
    /must target the loopback ephemeral registry/u,
  );
  assert.equal(escapedStops, 1);
  assert.equal(fs.existsSync(escapedRootDir), false);

  let retainedRootDir;
  const shutdownFailure = new Error('registry process did not retire');
  await assert.rejects(
    withSourceCandidateRegistry(options, () => 'accepted', {
      readReleaseManifestImpl: () => rehearsalRelease,
      startEphemeralRegistryImpl: async started => {
        retainedRootDir = started.rootDir;
        t.after(() =>
          fs.rmSync(retainedRootDir, { force: true, recursive: true }),
        );
        assert.equal(started.storeDir, storeDir);
        return {
          env: seededEnv,
          registryUrl: 'http://127.0.0.1:4873/',
          stop: async () => {
            throw shutdownFailure;
          },
        };
      },
    }),
    error => error === shutdownFailure,
  );
  assert.equal(fs.existsSync(retainedRootDir), true);
  assert.equal(
    fs.readFileSync(sharedStoreSentinel, 'utf8'),
    'shared store belongs to the caller',
  );

  // A registry seeded with a global override never reaches the acceptance.
  let overriddenStops = 0;
  await assert.rejects(
    withSourceCandidateRegistry(options, () => 'must not run', {
      readReleaseManifestImpl: () => rehearsalRelease,
      startEphemeralRegistryImpl: async () => ({
        env: { ...seededEnv, npm_config_registry: 'http://127.0.0.1:4873/' },
        registryUrl: 'http://127.0.0.1:4873/',
        stop: () => {
          overriddenStops += 1;
        },
      }),
    }),
    /must not name a global registry \(npm_config_registry\)/u,
  );
  assert.equal(overriddenStops, 1);

  // The rehearsal refuses to seed under any interpreter but the one the
  // accepted manifest recorded, before a registry is ever started.
  let driftedStarts = 0;
  await assert.rejects(
    withSourceCandidateRegistry(options, () => 'must not run', {
      nodeVersion: 'v20.0.0',
      readReleaseManifestImpl: () => rehearsalRelease,
      startEphemeralRegistryImpl: async () => {
        driftedStarts += 1;
        return { registryUrl: 'http://127.0.0.1:4873/', stop: () => {} };
      },
    }),
    new RegExp(
      `must seed under the accepted release Node\\.js ${process.version.replaceAll('.', '\\.')}`,
      'u',
    ),
  );
  assert.equal(driftedStarts, 0);
});

test('cohort installation adopts exact bundle and toolchain without changing authored Tractor UI', async () => {
  const { prepareTractorCohortInstallation } = await import(
    '../tractor-downstream/cohort-install.mjs'
  );
  const { compilerBootstrapSelectors } = await import(
    '../published-create-proof/package-cohort.mjs'
  );
  const root = fixture();
  try {
    writeAuthenticatedCohort(root);
    const next = structuredClone(release);
    next.aliases['@modern-js/backend-federation-contracts'] =
      '@bleedingdev/modern-js-backend-federation-contracts';
    next.cohortProjection.value.aliases = { ...next.aliases };
    next.release.version = '3.9.0-ultramodern.6';
    next.publishOrder = Object.values(next.aliases);
    next.cohortProjection.value.release.version = next.release.version;
    next.cohortProjection.value.packages[0].version = next.release.version;
    next.sidecars = {
      packages: [
        { name: '@bleedingdev/mf-modern-js-v3', version: '2.9.2' },
        { name: '@bleedingdev/mf-sdk', version: '0.18.0' },
        { name: '@bleedingdev/zod', version: '4.6.5' },
        { name: '@bleedingdev/ipx', version: '3.2.2' },
        { name: '@bleedingdev/braces', version: '3.0.4' },
      ],
    };
    next.cohortProjection.value.sidecars = [...next.sidecars.packages].sort(
      (left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    const { inspectNpmTarball } = await import(
      '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs'
    );
    const { createTemplateRequiredFiles } = await import(
      '../../ultramodern-publish/lib/prepare-bleedingdev-packages/constants.mjs'
    );
    const packageDir = path.join(root, 'candidate/package');
    fs.mkdirSync(packageDir, { recursive: true });
    for (const relativePath of createTemplateRequiredFiles) {
      const file = path.join(packageDir, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'candidate template content');
    }
    fs.writeFileSync(
      path.join(packageDir, 'release-cohort.json'),
      JSON.stringify(next.cohortProjection.value),
    );
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@bleedingdev/modern-js-ultramodern-create',
        version: next.release.version,
        publishConfig: { access: 'public' },
        dependencies: {
          '@effect/tsgo': '0.59.0',
          tsrs: '0.20.0-ts7.1.0-beta',
          'unrelated-compiler': '9.9.9',
        },
      }),
    );
    const artifactPath = path.join(root, 'candidate.tgz');
    const priorCopyfile = process.env.COPYFILE_DISABLE;
    process.env.COPYFILE_DISABLE = '1';
    try {
      runCommand('tar', [
        '-czf',
        artifactPath,
        '-C',
        path.dirname(packageDir),
        'package',
      ]);
    } finally {
      if (priorCopyfile === undefined) delete process.env.COPYFILE_DISABLE;
      else process.env.COPYFILE_DISABLE = priorCopyfile;
    }
    const bytes = fs.readFileSync(artifactPath);
    next.createPackage = {
      ...inspectNpmTarball(bytes),
      sourceName: '@modern-js/ultramodern-create',
      targetName: '@bleedingdev/modern-js-ultramodern-create',
      version: next.release.version,
      artifactPath,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    };
    const uiFile = path.join(
      root,
      'apps/shell-super-app/locales/en/shell.json',
    );
    const beforeUi = fs.readFileSync(uiFile, 'utf8');
    const rootManifestFile = path.join(root, 'package.json');
    const rootManifest = JSON.parse(fs.readFileSync(rootManifestFile, 'utf8'));
    rootManifest.devDependencies = {
      react: '19.2.8',
      'react-dom': '19.2.8',
      '@types/react': '^19.2.18',
      '@types/react-dom': '^19.2.7',
    };
    fs.writeFileSync(rootManifestFile, JSON.stringify(rootManifest));
    const beforeManifest = fs.readFileSync(
      path.join(root, 'package.json'),
      'utf8',
    );
    // The baseline selects the sidecars of the cohort it adopted last; the
    // bundle moved one of them.
    const shellManifestFile = path.join(
      root,
      'apps/shell-super-app/package.json',
    );
    fs.writeFileSync(
      path.join(path.dirname(shellManifestFile), 'modern.config.ts'),
      'export default {};',
    );
    const verticalManifests = ['catalog', 'cart', 'checkout'].map(name =>
      path.join(root, 'verticals', name, 'package.json'),
    );
    for (const file of verticalManifests) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          name: path.basename(path.dirname(file)),
          dependencies: {
            effect: '4.0.0-rc.117',
            react: '19.2.8',
            'react-dom': '19.2.8',
          },
          devDependencies: {
            '@types/react': '^19.2.18',
            '@types/react-dom': '^19.2.7',
          },
        }),
      );
      fs.writeFileSync(
        path.join(path.dirname(file), 'modern.config.ts'),
        'export default {};',
      );
    }
    fs.writeFileSync(
      shellManifestFile,
      `${JSON.stringify(
        {
          name: 'shell',
          dependencies: {
            '@module-federation/modern-js-v3':
              'npm:@bleedingdev/mf-modern-js-v3@2.9.1',
            react: '19.2.8',
            'react-dom': '19.2.8',
            effect: '4.0.0-rc.117',
            '@effect/opentelemetry': 'catalog:',
          },
          devDependencies: {
            '@effect/tsgo': '0.41.0',
            '@types/react': '^19.2.18',
            '@types/react-dom': '^19.2.7',
          },
        },
        null,
        2,
      )}\n`,
    );
    fs.appendFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      "catalog:\n  ipx: npm:@bleedingdev/ipx@3.2.1\noverrides:\n  zod: npm:@bleedingdev/zod@4.6.5\n  effect: npm:@bleedingdev/effect@4.0.0-rc.117\n  braces: 3.0.3\n  braces@^3: 3.0.3\n  fast-glob>braces@3: 3.0.3\n  sharp: 0.35.4\n  other>sharp: 0.35.4\n  parent > braces@>=3.0.0: 3.0.3\n  braces@3>foo: 1.2.3\n  sharp@>=0.35.0 > unrelated: 2.0.0\n  '@scope/other@^1': 1.2.3\n",
    );
    const { parse: parseYaml, stringify: stringifyYaml } = await import('yaml');
    const baselinePolicy = parseYaml(
      fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );
    Object.assign(baselinePolicy.catalog, {
      effect: '4.0.0-rc.117',
      '@effect/opentelemetry': '4.0.0-rc.117',
      '@effect/tsgo': '0.41.0',
      react: '19.2.8',
      'react-dom': '19.2.8',
      '@types/react': '^19.2.18',
      '@types/react-dom': '^19.2.7',
    });
    baselinePolicy.catalogs.renderer = { ...baselinePolicy.catalog };
    Object.assign(baselinePolicy.overrides, {
      'parent>effect': 'npm:@bleedingdev/effect@4.0.0-rc.117',
      '@effect/opentelemetry': '4.0.0-rc.117',
      '@effect/tsgo': '0.41.0',
    });
    fs.writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      stringifyYaml(baselinePolicy),
    );
    const pnpmOverrides = {
      'braces@>=3.0.0 <3.0.4': 'npm:@bleedingdev/braces@3.0.4',
      'sharp@>=0.35.0 <0.35.5': '0.35.5',
    };
    const producerOptions = {
      producerEffectDependencies,
      producerReactDependencies,
      pnpmOverrides,
      minimumReleaseAgeExclude: [
        ...Object.values(next.aliases).map(
          name => `${name}@${next.release.version}`,
        ),
        ...next.sidecars.packages.map(
          ({ name, version }) => `${name}@${version}`,
        ),
        ...compilerBootstrapSelectors(next.createPackage.packageJson),
      ].sort(),
      trustPolicy: 'no-downgrade',
      trustPolicyIgnoreAfter: 1440,
    };
    const result = prepareTractorCohortInstallation(
      root,
      next,
      producerOptions,
    );
    assert.equal(result.dependencyCount, 1);
    const compilerFile = path.join(root, 'tsconfig.base.json');
    const compilerConfig = JSON.parse(fs.readFileSync(compilerFile, 'utf8'));
    assert.deepEqual(compilerConfig, {
      extends: [
        './authored-compiler.json',
        '@modern-js/ultramodern-create/tsconfig',
      ],
      compilerOptions: {
        strict: true,
        paths: { '@tractor/*': ['./shared/*'] },
      },
      exclude: ['authored-fixtures'],
    });
    const policyText = fs.readFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'utf8',
    );
    assert.match(
      policyText,
      /npm:@bleedingdev\/modern-js-runtime@3\.9\.0-ultramodern\.6/u,
    );
    assert.match(
      policyText,
      /braces@>=3\.0\.0 <3\.0\.4.*npm:@bleedingdev\/braces@3\.0\.4/u,
    );
    assert.deepEqual(parseYaml(policyText).catalog, {
      ipx: 'npm:@bleedingdev/ipx@3.2.2',
      ...producerEffectDependencies,
      ...producerReactDependencies,
    });
    assert.deepEqual(
      parseYaml(policyText).catalogs.renderer,
      parseYaml(policyText).catalog,
    );
    assert.deepEqual(parseYaml(policyText).overrides, {
      zod: 'npm:@bleedingdev/zod@4.6.5',
      '@scope/other@^1': '1.2.3',
      'braces@3>foo': '1.2.3',
      'sharp@>=0.35.0 > unrelated': '2.0.0',
      ...pnpmOverrides,
    });
    assert.deepEqual(
      parseYaml(policyText).minimumReleaseAgeExclude,
      producerOptions.minimumReleaseAgeExclude,
    );
    const compilerExclusions = compilerBootstrapSelectors(
      next.createPackage.packageJson,
    );
    assert.equal(compilerExclusions.length, 16);
    assert(compilerExclusions.includes('tsrs@0.20.0-ts7.1.0-beta'));
    assert(compilerExclusions.includes('@effect/tsgo-win32-x64@0.59.0'));
    assert(
      !parseYaml(policyText).minimumReleaseAgeExclude.includes(
        'unrelated-compiler@9.9.9',
      ),
    );
    assert.equal(parseYaml(policyText).minimumReleaseAge, 1440);
    assert.equal(parseYaml(policyText).minimumReleaseAgeStrict, true);
    assert.equal(
      parseYaml(policyText).minimumReleaseAgeIgnoreMissingTime,
      false,
    );
    assert.equal(parseYaml(policyText).trustPolicy, 'no-downgrade');
    assert.equal(parseYaml(policyText).trustPolicyIgnoreAfter, 1440);
    assert.match(policyText, /sharp@>=0\.35\.0 <0\.35\.5.*0\.35\.5/u);
    assert.match(policyText, /zod: npm:@bleedingdev\/zod@4\.6\.5/u);
    assert.match(policyText, /ipx: npm:@bleedingdev\/ipx@3\.2\.2/u);
    assert.doesNotMatch(policyText, /@bleedingdev\/effect|4\.0\.0-rc\.117/u);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(shellManifestFile, 'utf8')).dependencies,
      {
        '@module-federation/modern-js-v3':
          'npm:@bleedingdev/mf-modern-js-v3@2.9.2',
        react: '19.3.0',
        'react-dom': '19.3.0',
        effect: '4.0.0',
        '@effect/opentelemetry': 'catalog:',
        '@modern-js/backend-federation-contracts': 'catalog:ultramodern',
      },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(shellManifestFile, 'utf8')).devDependencies,
      {
        '@effect/tsgo': '0.59.0',
        '@types/react': '19.3.0',
        '@types/react-dom': '19.3.0',
      },
    );
    for (const file of verticalManifests)
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dependencies, {
        effect: '4.0.0',
        react: '19.3.0',
        'react-dom': '19.3.0',
        '@modern-js/backend-federation-contracts': 'catalog:ultramodern',
      });
    for (const file of verticalManifests)
      assert.deepEqual(
        JSON.parse(fs.readFileSync(file, 'utf8')).devDependencies,
        { '@types/react': '19.3.0', '@types/react-dom': '19.3.0' },
      );
    fs.rmSync(shellManifestFile);
    assert.equal(fs.readFileSync(uiFile, 'utf8'), beforeUi);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
      {
        ...JSON.parse(beforeManifest),
        devDependencies: producerReactDependencies,
        packageManager: 'pnpm@12.11.2',
      },
    );
    assert.equal(
      fs.readFileSync(path.join(root, '.mise.toml'), 'utf8'),
      `[tools]\nnode = "${process.version.slice(1)}"\npnpm = "12.11.2"\n`,
    );
    assert.equal(
      fs.existsSync(path.join(root, '.modernjs/ultramodern.json')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(root, '.modernjs/release-cohort.json')),
      false,
    );
    const selectedPolicy = fs.readFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'utf8',
    );
    const foreignCompilerConfig = {
      ...compilerConfig,
      compilerOptions: {
        ...compilerConfig.compilerOptions,
        plugins: [{ name: 'authored-language-service' }],
      },
    };
    fs.writeFileSync(compilerFile, JSON.stringify(foreignCompilerConfig));
    assert.throws(
      () => prepareTractorCohortInstallation(root, next, producerOptions),
      /compiler plugins must contain only its copied Effect policy/u,
    );
    assert.equal(
      fs.readFileSync(compilerFile, 'utf8'),
      JSON.stringify(foreignCompilerConfig),
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
      selectedPolicy,
    );
    fs.writeFileSync(compilerFile, JSON.stringify(compilerConfig));
    for (const invalidReact of [
      undefined,
      {},
      { ...producerReactDependencies, react: '19.2.8' },
      { ...producerReactDependencies, '@types/react': '^19.3.0' },
    ]) {
      assert.throws(
        () =>
          prepareTractorCohortInstallation(root, next, {
            ...producerOptions,
            producerReactDependencies: invalidReact,
          }),
        /Exact producer React dependencies/u,
      );
      assert.equal(
        fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
        selectedPolicy,
      );
    }
    for (const invalidEffect of [
      undefined,
      {},
      { ...producerEffectDependencies, effect: '4.0.0-rc.117' },
      { ...producerEffectDependencies, '@effect/opentelemetry': '4.0.1' },
      {
        ...producerEffectDependencies,
        '@effect/tsgo': 'npm:@bleedingdev/tsgo@0.53.1',
      },
    ]) {
      assert.throws(
        () =>
          prepareTractorCohortInstallation(root, next, {
            ...producerOptions,
            producerEffectDependencies: invalidEffect,
          }),
        /native stable Effect/u,
      );
      assert.equal(
        fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
        selectedPolicy,
      );
    }
    assert.throws(
      () =>
        prepareTractorCohortInstallation(root, next, {
          ...producerOptions,
          pnpmOverrides: {
            'braces@>=3.0.0 <3.0.4': 'npm:@bleedingdev/braces@3.0.5',
          },
        }),
      /differs from the exact sidecar bundle/u,
    );
    const selectedMise = fs.readFileSync(path.join(root, '.mise.toml'), 'utf8');
    assert.throws(
      () =>
        prepareTractorCohortInstallation(
          root,
          {
            ...next,
            tools: { ...next.tools, node: '>=26' },
          },
          producerOptions,
        ),
      /exact release node version/u,
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
      selectedPolicy,
    );
    assert.equal(
      fs.readFileSync(path.join(root, '.mise.toml'), 'utf8'),
      selectedMise,
    );
    for (const minimumReleaseAgeExclude of [
      producerOptions.minimumReleaseAgeExclude.filter(
        selector => !selector.startsWith('@bleedingdev/braces@'),
      ),
      producerOptions.minimumReleaseAgeExclude.filter(
        selector => !selector.startsWith('@bleedingdev/mf-sdk@'),
      ),
      producerOptions.minimumReleaseAgeExclude.filter(
        selector => selector !== 'tsrs@0.20.0-ts7.1.0-beta',
      ),
      producerOptions.minimumReleaseAgeExclude.filter(
        selector => selector !== '@effect/tsgo-win32-x64@0.59.0',
      ),
      producerOptions.minimumReleaseAgeExclude.map(selector =>
        selector === 'tsrs@0.20.0-ts7.1.0-beta'
          ? 'tsrs@0.18.0-ts7.1.0-dev.20260929'
          : selector,
      ),
      [
        ...producerOptions.minimumReleaseAgeExclude,
        'unrelated-compiler@9.9.9',
      ].sort(),
      [...producerOptions.minimumReleaseAgeExclude, 'sharp@0.35.5'].sort(),
      ['@bleedingdev/*'],
    ]) {
      assert.throws(
        () =>
          prepareTractorCohortInstallation(root, next, {
            ...producerOptions,
            minimumReleaseAgeExclude,
          }),
        /minimumReleaseAgeExclude/u,
      );
      assert.equal(
        fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
        selectedPolicy,
      );
      assert.equal(fs.readFileSync(uiFile, 'utf8'), beforeUi);
    }
    for (const invalidTrust of [
      { trustPolicy: 'none' },
      { trustPolicyIgnoreAfter: 0 },
    ]) {
      assert.throws(
        () =>
          prepareTractorCohortInstallation(root, next, {
            ...producerOptions,
            ...invalidTrust,
          }),
        /trust policy/u,
      );
      assert.equal(
        fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
        selectedPolicy,
      );
    }
    fs.appendFileSync(artifactPath, 'tampered');
    assert.throws(
      () => prepareTractorCohortInstallation(root, next, producerOptions),
      /tarball size mismatch/u,
    );
    fs.writeFileSync(artifactPath, bytes);
    const manifest = JSON.parse(beforeManifest);
    manifest.dependencies['@modern-js/unknown'] = 'catalog:ultramodern';
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    const beforeRejectedPolicy = fs.readFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'utf8',
    );
    assert.throws(
      () => prepareTractorCohortInstallation(root, next, producerOptions),
      /absent from the release cohort/u,
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
      beforeRejectedPolicy,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
