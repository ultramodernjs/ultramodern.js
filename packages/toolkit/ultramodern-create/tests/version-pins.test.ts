import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { yaml } from '@modern-js/utils';
import { ULTRAMODERN_WORKSPACE_MODERN_PACKAGES } from '../src/ultramodern-package-source';
import {
  assertReleaseCohortAliasRequest,
  assertReleaseCohortPackageSource,
  parseUltramodernReleaseCohort,
  releaseCohortSelectors,
} from '../src/ultramodern-release-cohort';
import { generateUltramodernWorkspace } from '../src/ultramodern-workspace';
import { ULTRAMODERN_WORKSPACE_POLICY } from '../src/ultramodern-workspace/policy';
import { assertWorkspaceDependencyOverrides } from '../src/ultramodern-workspace/validation/workspace';
import {
  BOOTSTRAP_RELEASE_AGE_EXCEPTIONS,
  BRACES_FORK_VERSION,
} from '../src/ultramodern-workspace/versions';

function cohort() {
  return parseUltramodernReleaseCohort({
    aliases: { '@modern-js/runtime': '@bleedingdev/modern-js-runtime' },
    packages: [
      {
        sourceName: '@modern-js/runtime',
        targetName: '@bleedingdev/modern-js-runtime',
        version: '3.9.0',
      },
    ],
    release: { tag: 'latest', version: '3.9.0' },
    schema: 'bleedingdev.ultramodern.release-cohort',
    schemaVersion: 2,
    sidecars: [],
    source: { commit: 'a'.repeat(40), repository: 'https://example.test/repo' },
  });
}

test('local source generation uses native workspace requests without copied release state', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-native-source-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  try {
    await generateUltramodernWorkspace({
      targetDir: workspaceDir,
      packageName: 'workspace',
      modernVersion: '3.2.1',
      enableTailwind: true,
      packageSource: { strategy: 'workspace' },
    });
    const policy = yaml.load(
      fs.readFileSync(path.join(workspaceDir, 'pnpm-workspace.yaml'), 'utf8'),
    ) as Record<string, any>;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'),
    );
    assert.equal(
      manifest.devDependencies['@modern-js/ultramodern-create'],
      'workspace:*',
    );
    assert.equal(
      (policy.minimumReleaseAgeExclude ?? []).some((selector: string) =>
        selector.startsWith('@bleedingdev/modern-js-'),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(workspaceDir, '.modernjs/ultramodern.json')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(workspaceDir, '.modernjs/release-cohort.json')),
      false,
    );
    assert.equal(fs.existsSync(path.join(workspaceDir, 'patches')), false);
    assert.deepEqual(policy.overrides, {
      'braces@>=3.0.0 <3.0.4': 'npm:@bleedingdev/braces@3.0.4',
      'sharp@>=0.35.0 <0.35.5': '0.35.5',
      'undici@>=7.0.0 <7.30.1': '7.30.1',
      'undici@>=8.0.0 <8.12.2': '8.12.2',
      'body-parser@>=2.0.0 <2.4.0': '2.4.0',
      'dompurify@>=3.0.0 <3.4.17': '3.4.17',
    });
    assert.deepEqual(
      policy.overrides,
      ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installed producer cohort rejects wrong release and alias identity', () => {
  const expected = cohort();
  assert.doesNotThrow(() =>
    assertReleaseCohortPackageSource(expected, {
      strategy: 'install',
      modernPackageVersion: '3.9.0',
      aliasScope: 'bleedingdev',
      aliasPackageNamePrefix: 'modern-js-',
    }),
  );
  assert.throws(
    () =>
      assertReleaseCohortPackageSource(expected, {
        strategy: 'install',
        modernPackageVersion: '3.8.9',
        aliasScope: 'bleedingdev',
        aliasPackageNamePrefix: 'modern-js-',
      }),
    /does not match authenticated release cohort/u,
  );
  assert.throws(
    () =>
      assertReleaseCohortPackageSource(expected, {
        strategy: 'install',
        modernPackageVersion: '3.9.0',
        aliasScope: 'untrusted',
        aliasPackageNamePrefix: 'modern-js-',
      }),
    /aliases rebind/u,
  );
});

test('local source generation rejects an explicit install request', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-install-source-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  try {
    await assert.rejects(
      async () =>
        await generateUltramodernWorkspace({
          targetDir: workspaceDir,
          packageName: 'workspace',
          modernVersion: '3.2.1',
          packageSource: { strategy: 'install', modernPackageVersion: '3.2.1' },
        }),
      /local @modern-js\/ultramodern-create source checkout cannot satisfy an explicit install/u,
    );
    assert.equal(fs.existsSync(workspaceDir), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// Replays a workspace created on the day its cohort is published: the create
// package runs from node_modules (no src/, shipped release-cohort.json), and
// pnpm's strict 24h gate would reject every cohort package unless the
// workspace exempts exactly those versions.
test('an installed create package immediately installs its exact cohort and transitive sidecars under native release-age policy', async () => {
  const packageRoot = path.resolve(__dirname, '..');
  // The installed copy lives under this package's node_modules so Node
  // resolves its dependencies by walking up, with no links to create.
  const installRoot = fs.mkdtempSync(
    path.join(packageRoot, 'node_modules', '.um-installed-cohort-'),
  );
  const installed = path.join(
    installRoot,
    '@bleedingdev/modern-js-ultramodern-create',
  );
  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'um-installed-cohort-')),
  );
  try {
    fs.mkdirSync(installed, { recursive: true });
    for (const entry of [
      'package.json',
      'dist',
      'template',
      'template-workspace',
      'templates',
    ]) {
      fs.cpSync(path.join(packageRoot, entry), path.join(installed, entry), {
        recursive: true,
      });
    }
    const version = '3.9.0-ultramodern.17';
    const recipes = JSON.parse(
      fs.readFileSync(
        new URL(
          '../../../../scripts/ultramodern-supply/sidecars.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const sidecars = recipes
      .map((recipe: { fork: { name: string; version: string } }) => recipe.fork)
      .sort((left: { name: string }, right: { name: string }) =>
        left.name.localeCompare(right.name),
      );
    // modern-js-utils is not a catalog entry: it arrives transitively at the
    // same cohort version and must be exempt too.
    const names = [
      ...ULTRAMODERN_WORKSPACE_MODERN_PACKAGES.map(name =>
        name.slice('@modern-js/'.length),
      ),
      'backend-federation-contracts',
      'renderer-core',
      'utils',
    ].sort();
    fs.writeFileSync(
      path.join(installed, 'release-cohort.json'),
      JSON.stringify({
        aliases: Object.fromEntries(
          names.map(name => [
            `@modern-js/${name}`,
            `@bleedingdev/modern-js-${name}`,
          ]),
        ),
        packages: names.map(name => ({
          sourceName: `@modern-js/${name}`,
          targetName: `@bleedingdev/modern-js-${name}`,
          version,
        })),
        release: { tag: 'latest', version },
        schema: 'bleedingdev.ultramodern.release-cohort',
        schemaVersion: 2,
        sidecars,
        source: {
          commit: 'a'.repeat(40),
          repository: 'https://example.test/repo',
        },
      }),
    );
    const generate = (workspace: string, modernPackageVersion: string) =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { generateUltramodernWorkspace } = await import(process.argv[1]);
generateUltramodernWorkspace(JSON.parse(process.argv[2]));`,
          pathToFileURL(
            path.join(
              installed,
              'dist/esm-node/ultramodern-workspace/public-api.js',
            ),
          ).href,
          JSON.stringify({
            targetDir: path.join(tempRoot, workspace),
            packageName: workspace,
            modernVersion: version,
            generateAgentFiles: false,
            packageSource: { strategy: 'install', modernPackageVersion },
          }),
        ],
        { cwd: tempRoot, encoding: 'utf8' },
      );

    const created = generate('fresh', version);
    assert.equal(created.status, 0, created.stderr);
    const policy = yaml.load(
      fs.readFileSync(path.join(tempRoot, 'fresh/pnpm-workspace.yaml'), 'utf8'),
    ) as Record<string, any>;
    assert.deepEqual(
      policy.minimumReleaseAgeExclude,
      [
        ...BOOTSTRAP_RELEASE_AGE_EXCEPTIONS,
        ...names.map(name => `@bleedingdev/modern-js-${name}@${version}`),
        ...sidecars.map(
          (item: { name: string; version: string }) =>
            `${item.name}@${item.version}`,
        ),
      ].sort(),
    );
    assert.deepEqual(
      policy.overrides,
      ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides,
    );
    assert.equal(policy.minimumReleaseAge, 1440);
    assert.equal(policy.minimumReleaseAgeStrict, true);
    assert.equal(policy.minimumReleaseAgeIgnoreMissingTime, false);
    assert.equal(policy.trustPolicy, 'no-downgrade');
    assert.equal(policy.trustPolicyIgnoreAfter, 1440);
    assert.equal(
      policy.minimumReleaseAgeExclude.some(
        (selector: string) =>
          selector.includes('*') || selector.startsWith('sharp@'),
      ),
      false,
    );
    assert.equal(
      policy.catalogs.ultramodern['@modern-js/runtime'],
      `npm:@bleedingdev/modern-js-runtime@${version}`,
    );

    // Only registry timestamps and native pnpm policy decide admission here.
    // These package fixtures isolate metadata age, not sidecar implementation.
    const sdk = sidecars.find(
      (item: { name: string }) => item.name === '@bleedingdev/mf-sdk',
    );
    const modern = sidecars.find(
      (item: { name: string }) => item.name === '@bleedingdev/mf-modern-js-v3',
    );
    assert(
      sdk && modern,
      'Canonical MF sidecars are required for the transitive age proof',
    );
    const definitions = [
      ...sidecars
        .filter((item: { name: string }) =>
          [
            '@bleedingdev/braces',
            '@bleedingdev/mf-modern-js-v3',
            '@bleedingdev/mf-sdk',
          ].includes(item.name),
        )
        .map((item: { name: string; version: string }) => ({
          ...item,
          ...(item === modern
            ? {
                dependencies: {
                  '@module-federation/sdk': `npm:${sdk.name}@${sdk.version}`,
                },
              }
            : {}),
        })),
      { name: '@bleedingdev/modern-js-utils', version },
      { name: 'sharp', version: '0.35.5' },
    ];
    const snapshots = definitions.map(definition => {
      const dir = path.join(
        tempRoot,
        'registry-fixtures',
        definition.name.replaceAll('/', '__'),
      );
      fs.mkdirSync(dir, { recursive: true });
      const packageJson = { ...definition, license: 'MIT' };
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify(packageJson),
      );
      const result = JSON.parse(
        execFileSync('npm', ['pack', '--ignore-scripts', '--json'], {
          cwd: dir,
          encoding: 'utf8',
        }),
      )[0];
      const bytes = fs.readFileSync(path.join(dir, result.filename));
      return {
        ...definition,
        packageJson,
        bytes,
        integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
        shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      };
    });
    const { startSidecarRegistry } = await import(
      '../../../../scripts/ultramodern-publish/qualify-sidecar-bundle.mjs'
    );
    const registry = await startSidecarRegistry(snapshots);
    try {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(?:npm_config_|pnpm_config_)/iu.test(key)) delete env[key];
      }
      const consumer = path.join(tempRoot, 'native-consumer');
      fs.mkdirSync(consumer);
      // Scoped registry configuration otherwise wins over --registry. This
      // routes fixtures only; the generated native age policy stays intact.
      fs.writeFileSync(
        path.join(consumer, '.npmrc'),
        `@bleedingdev:registry=${registry.registryUrl}\n`,
      );
      fs.copyFileSync(
        path.join(tempRoot, 'fresh/pnpm-workspace.yaml'),
        path.join(consumer, 'pnpm-workspace.yaml'),
      );
      fs.writeFileSync(
        path.join(consumer, 'package.json'),
        JSON.stringify({
          private: true,
          dependencies: {
            '@modern-js/utils': `npm:@bleedingdev/modern-js-utils@${version}`,
            '@module-federation/modern-js-v3': `npm:${modern.name}@${modern.version}`,
            braces: '3.0.3',
          },
        }),
      );
      const installArgs = [
        'install',
        '--registry',
        registry.registryUrl,
        '--store-dir',
        path.join(tempRoot, 'fresh-store'),
      ];
      await promisify(execFile)('pnpm', installArgs, {
        cwd: consumer,
        env,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(
        JSON.parse(
          fs.readFileSync(
            path.join(consumer, 'node_modules/braces/package.json'),
            'utf8',
          ),
        ).name,
        '@bleedingdev/braces',
      );
      assert(
        registry.servedTarballs.has(sdk.name),
        'A freshly dated transitive SDK must install under the producer policy',
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(
            path.join(consumer, 'node_modules/@modern-js/utils/package.json'),
            'utf8',
          ),
        ).version,
        version,
      );
      fs.writeFileSync(
        path.join(consumer, 'package.json'),
        JSON.stringify({ private: true, dependencies: { sharp: '0.35.5' } }),
      );
      const sharpMetadata = await (
        await fetch(`${registry.registryUrl}sharp`)
      ).json();
      assert.equal(sharpMetadata.versions['0.35.5'].name, 'sharp');
      assert(Date.now() - Date.parse(sharpMetadata.time['0.35.5']) < 60_000);
      await assert.rejects(
        // Resolve the changed manifest even when CI defaults to a frozen lock;
        // otherwise lock freshness rejects before the native age policy runs.
        promisify(execFile)('pnpm', [...installArgs, '--no-frozen-lockfile'], {
          cwd: consumer,
          env,
          maxBuffer: 1024 * 1024,
        }),
        error => {
          const output =
            String((error as { stdout?: string; stderr?: string }).stdout) +
            String((error as { stdout?: string; stderr?: string }).stderr);
          assert.match(
            output,
            /minimumReleaseAge|release age|too new|released/iu,
          );
          return true;
        },
      );
    } finally {
      await registry.stop();
    }

    // The installed producer cannot authenticate another release, so a failed
    // generation must not publish a workspace with that release's catalog.
    const other = generate('other', '3.9.0-ultramodern.16');
    assert.equal(other.status, 1, other.stderr);
    assert.match(
      other.stderr,
      /(?:catalog request|owned alias) disagrees with the installed release cohort/u,
    );
    assert.equal(fs.existsSync(path.join(tempRoot, 'other')), false);
    const cohortPath = path.join(installed, 'release-cohort.json');
    const validProjection = JSON.parse(fs.readFileSync(cohortPath, 'utf8'));
    for (const name of [
      '@bleedingdev/braces',
      '@bleedingdev/mf-modern-js-v3',
    ]) {
      for (const missing of [false, true]) {
        const sidecars = validProjection.sidecars.flatMap(
          (item: { name: string; version: string }) =>
            item.name !== name
              ? [item]
              : missing
                ? []
                : [{ ...item, version: '0.0.0' }],
        );
        fs.writeFileSync(
          cohortPath,
          JSON.stringify({ ...validProjection, sidecars }),
        );
        const target = `drift-${name.split('/')[1]}-${missing}`;
        const drift = generate(target, version);
        assert.equal(drift.status, 1, drift.stderr);
        assert.match(
          drift.stderr,
          /owned alias disagrees with the installed release cohort/u,
        );
        assert.equal(fs.existsSync(path.join(tempRoot, target)), false);
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
});

test('Braces producer policy matches the canonical reviewed sidecar', () => {
  const sidecars = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../../../scripts/ultramodern-supply/sidecars.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const braces = sidecars.find(
    (sidecar: { id: string }) => sidecar.id === 'braces',
  );
  assert.equal(braces.fork.version, BRACES_FORK_VERSION);
  assert.equal(
    ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides['braces@>=3.0.0 <3.0.4'],
    `npm:${braces.fork.name}@${braces.fork.version}`,
  );
});

test('workspace validation requires all reviewed dependency corrections', () => {
  const required = ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides;
  assert.throws(
    () => assertWorkspaceDependencyOverrides({}),
    /must be an object/u,
  );
  for (const selector of Object.keys(required)) {
    const overrides: Record<string, string> = { ...required };
    delete overrides[selector];
    assert.throws(
      () => assertWorkspaceDependencyOverrides({ overrides }),
      /must be/u,
    );
    overrides[selector] = '3.0.3';
    assert.throws(
      () => assertWorkspaceDependencyOverrides({ overrides }),
      /must be/u,
    );
  }
});

test('workspace validation rejects competing selectors but permits unrelated overrides', () => {
  const required = ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides;
  assert.doesNotThrow(() =>
    assertWorkspaceDependencyOverrides({
      overrides: {
        ...required,
        'axios@<1.20.0': '1.20.0',
        'braces@3>foo': '1.0.0',
        'sharp@>=0.35.0 > unrelated': '2.0.0',
      },
    }),
  );
  for (const selector of [
    'braces',
    'braces@3',
    'braces@>3.0.0',
    'braces@>v3.0.0',
    'foo > braces@>=3.0.0',
    'micromatch@4>braces',
    'micromatch@4>braces@3',
    'sharp',
    'minimizer-webpack-plugin>sharp@0.35.4',
    'undici',
    'undici@7',
    'jsdom>undici@8',
    'body-parser',
    'express>body-parser',
    'dompurify',
    'mermaid>dompurify',
  ]) {
    assert.throws(
      () =>
        assertWorkspaceDependencyOverrides({
          overrides: { ...required, [selector]: '3.0.3' },
        }),
      /conflicts with the producer policy/u,
    );
  }
});

test('authenticated sidecar selectors reject foreign names, ranges and duplicate identities', () => {
  const good = { name: '@bleedingdev/braces', version: BRACES_FORK_VERSION };
  const projected = parseUltramodernReleaseCohort({
    ...cohort(),
    sidecars: [good],
  });
  assert.deepEqual(releaseCohortSelectors(projected), [
    `@bleedingdev/braces@${BRACES_FORK_VERSION}`,
    '@bleedingdev/modern-js-runtime@3.9.0',
  ]);
  for (const sidecars of [
    [{ name: 'sharp', version: '0.35.5' }],
    [{ name: '@third-party/braces', version: '3.0.4' }],
    [{ ...good, version: '^3.0.4' }],
    [good, good],
    [{ name: '@bleedingdev/modern-js-runtime', version: '3.9.0' }],
    [{ name: '@bleedingdev/modern-js-injected', version: '3.9.0' }],
  ]) {
    assert.throws(() =>
      parseUltramodernReleaseCohort({ ...cohort(), sidecars }),
    );
  }
});

test('emitted owned aliases require exact authenticated cohort identities', () => {
  const producer = parseUltramodernReleaseCohort({
    ...cohort(),
    sidecars: [{ name: '@bleedingdev/braces', version: BRACES_FORK_VERSION }],
  });
  for (const request of [
    'workspace:*',
    'catalog:ultramodern',
    '0.35.5',
    'npm:@bleedingdev/modern-js-runtime@3.9.0',
    `npm:@bleedingdev/braces@${BRACES_FORK_VERSION}`,
  ])
    assert.doesNotThrow(() =>
      assertReleaseCohortAliasRequest(producer, request, 'dependency'),
    );
  for (const request of [
    'npm:@bleedingdev/braces@3.0.3',
    'npm:@bleedingdev/braces@^3.0.4',
    'npm:@bleedingdev/mf-sdk@2.6.0',
    'npm:@bleedingdev/modern-js-runtime@3.8.2',
  ])
    assert.throws(
      () => assertReleaseCohortAliasRequest(producer, request, 'dependency'),
      /owned alias disagrees/u,
    );
});
