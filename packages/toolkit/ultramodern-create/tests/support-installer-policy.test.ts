import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { yaml } from '@modern-js/utils';
import { readUltramodernWorkspaceInputs } from '../src/ultramodern-tooling/config';
import { generateUltramodernWorkspace } from '../src/ultramodern-workspace';
import {
  assertOverlayPreservedBaseline,
  captureOverlayBaselineSnapshot,
} from '../src/ultramodern-workspace/overlay-baseline-guard';
import * as packageSource from '../src/ultramodern-workspace/package-source';
import {
  ULTRAMODERN_WORKSPACE_POLICY,
  workspaceSupportPackageExtensions,
} from '../src/ultramodern-workspace/policy';
import {
  assertSupportDependencyPolicies,
  assertWorkspaceDependencyOverrides,
  validateWorkspace,
} from '../src/ultramodern-workspace/validation/workspace';
import { RSLIB_CORE_VERSION } from '../src/ultramodern-workspace/versions';
import { createWorkspaceValidationContract } from '../src/ultramodern-workspace/workspace-validation-contract';
import { proveSupportInstallerMechanism } from './helpers/support-installer-mechanism.mjs';

const source = packageSource.resolvePackageSource({
  targetDir: os.tmpdir(),
  packageName: 'support-installer',
  modernVersion: 'workspace:*',
  packageSource: { strategy: 'workspace' },
});
const support = source.supportArtifacts;
assert(
  support,
  'shipped producer must carry the validated seven-package descriptor',
);
const rootManifest = {
  devDependencies: {
    'rsbuild-plugin-dts': support.packages['rsbuild-plugin-dts'].request,
  },
  ultramodern: { supportArtifacts: support },
};
const security = ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides;
const packageExtensions = workspaceSupportPackageExtensions(support);
const policy = { overrides: security, packageExtensions };

test('descriptor policy declares only the exact compiler host peer and preserves security overrides', () => {
  assert.deepEqual(packageExtensions, {
    '@rslib/core@1.0.7': {
      peerDependencies: { 'rsbuild-plugin-dts': '1.0.7' },
    },
  });
  assertWorkspaceDependencyOverrides(policy, rootManifest);
  assertWorkspaceDependencyOverrides(
    {
      ...policy,
      overrides: {
        ...security,
        'rsbuild-plugin-dts@1.0.7>typescript': '7.0.2',
        '@effect/opentelemetry@4.1.4>typescript': '7.0.2',
      },
    },
    rootManifest,
  );
  assert.deepEqual(workspaceSupportPackageExtensions(undefined), {});
  assertWorkspaceDependencyOverrides({ overrides: security });
  // A source workspace keeps the same authority; workspace links do not turn
  // external runtime dependencies into workspace packages.
  assert.equal(source.strategy, 'workspace');
});

test('native host policy follows the compiler owner required by the shipped framework', () => {
  const createManifest = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../package.json'),
      'utf8',
    ),
  );
  assert.equal(
    createManifest.devDependencies['@rslib/core'],
    RSLIB_CORE_VERSION,
  );
  const require = createRequire(
    path.resolve(import.meta.dirname, '../package.json'),
  );
  const core = JSON.parse(
    fs.readFileSync(require.resolve('@rslib/core/package.json'), 'utf8'),
  );
  assert.equal(core.name, '@rslib/core');
  assert.equal(core.version, RSLIB_CORE_VERSION);
  assert.equal(
    core.dependencies['rsbuild-plugin-dts'],
    support.packages['rsbuild-plugin-dts'].version,
  );
  assert.equal(core.optionalDependencies?.['rsbuild-plugin-dts'], undefined);
});

test('compiler host policy rejects missing, broad, optional and conflicting peer declarations', () => {
  assert.throws(() =>
    assertWorkspaceDependencyOverrides(policy, {
      ...rootManifest,
      devDependencies: {},
    }),
  );
  for (const request of [
    '1.0.7',
    `${support.packages['rsbuild-plugin-dts'].request}?other-host=1`,
  ])
    assert.throws(() =>
      assertWorkspaceDependencyOverrides(policy, {
        ...rootManifest,
        devDependencies: { 'rsbuild-plugin-dts': request },
      }),
    );
  for (const extensions of [
    {},
    {
      '@rslib/core@*': packageExtensions['@rslib/core@1.0.7'],
    },
    {
      '@rslib/core@1.0.7': {
        peerDependencies: { 'rsbuild-plugin-dts': '*' },
      },
    },
    {
      '@rslib/core@1.0.7': {
        peerDependencies: { 'rsbuild-plugin-dts': '1.0.7' },
        peerDependenciesMeta: { 'rsbuild-plugin-dts': { optional: true } },
      },
    },
    {
      ...packageExtensions,
      'another-owner@1.0.0': {
        peerDependencies: { 'rsbuild-plugin-dts': '1.0.7' },
      },
    },
    {
      ...packageExtensions,
      'another-owner@1.0.0': {
        peerDependenciesMeta: { 'rsbuild-plugin-dts': { optional: true } },
      },
    },
  ])
    assert.throws(() =>
      assertWorkspaceDependencyOverrides(
        { ...policy, packageExtensions: extensions },
        rootManifest,
      ),
    );
});

test.each(Object.entries(support.packages))(
  '%s rejects URL overrides and alternate support authority',
  (name, pin) => {
    const selector = `${name}@${pin.version}`;
    for (const request of [
      pin.request,
      pin.version,
      '^1.0.0',
      'https://example.com/forged.tgz',
    ]) {
      assert.throws(() =>
        assertWorkspaceDependencyOverrides(
          {
            ...policy,
            overrides: { ...security, [selector]: request },
          },
          rootManifest,
        ),
      );
    }
    for (const competing of [
      name,
      `${name}@*`,
      `${name}:peer`,
      `${name}@${pin.version}:peer`,
      `owner>${selector}`,
      `${name}@>=1.0.0`,
      '*',
      '*:prod',
      '*@>1.0.0',
      'owner>*:optional',
      ...(name.startsWith('@') ? [`${name.split('/')[0]}/*`] : []),
    ]) {
      assert.throws(() =>
        assertWorkspaceDependencyOverrides(
          {
            ...policy,
            overrides: { ...security, [competing]: pin.request },
          },
          rootManifest,
        ),
      );
    }
    assertWorkspaceDependencyOverrides(
      {
        ...policy,
        catalogs: { support: { [name]: pin.request } },
      },
      rootManifest,
    );
    for (const alternate of [
      { catalog: { [name]: pin.version } },
      { catalogs: { alternate: { [name]: 'https://example.com/forged.tgz' } } },
      { pnpm: { overrides: { [name]: pin.request } } },
      { resolutions: { [selector]: pin.version } },
      { catalog: { renamed: `npm:${name}@${pin.version}` } },
    ]) {
      assert.throws(() =>
        assertWorkspaceDependencyOverrides(
          { ...policy, ...alternate },
          rootManifest,
        ),
      );
      assert.throws(() =>
        assertSupportDependencyPolicies(alternate, support, 'app manifest'),
      );
    }
  },
);

const nativeRequestModes = [
  'literal',
  'direct-reference',
  'catalog',
  'root-catalog',
  'root-catalog-direct-reference',
];

// pnpm12.21 resolves references to the request string, not an authorization:
// https://github.com/pnpm/pnpm/blob/v12.21.0/pnpm/crates/config/src/override_version_references.rs#L47-L60
// Its transitive guard has no exact-direct-request exemption:
// https://github.com/pnpm/pnpm/blob/v12.21.0/pnpm/crates/resolving-deps-resolver/src/resolve_dependency_tree/walk/edge_resolution.rs#L466-L486
test.each(nativeRequestModes)(
  'pnpm URL override using %s cannot reuse approved root authority',
  async requestMode => {
    const pin = support.packages['rsbuild-plugin-dts'];
    const selector = `rsbuild-plugin-dts@${pin.version}`;
    assert.equal(Object.hasOwn(policy.overrides, selector), false);
    await assert.rejects(
      () => proveSupportInstallerMechanism(selector, 'url', requestMode),
      error => {
        assert(
          error instanceof Error && 'stdout' in error && 'stderr' in error,
        );
        assert.deepEqual(Reflect.get(error, 'mechanism'), {
          selector,
          source: 'url',
          requestMode,
          corrected: true,
        });
        assert.match(
          String(error.stdout) + String(error.stderr),
          /ERR_PNPM_EXOTIC_SUBDEP/u,
        );
        return true;
      },
    );
  },
);

// Required peers shadow dependency edges; optional edges are retained:
// https://github.com/pnpm/pnpm/blob/v12.21.0/pnpm/crates/resolving-deps-resolver/src/resolve_dependency_tree/catalogs.rs#L76-L92
test('native required host peers reuse the root URL for exact/range dependencies through strict and frozen installs', async () => {
  const proof = await proveSupportInstallerMechanism(
    'rsbuild-plugin-dts@1.0.7',
    'url',
    'peer-host',
    packageExtensions,
  );
  assert.deepEqual(proof, {
    source: 'url',
    requestMode: 'peer-host',
    physicalSingleton: true,
    exactAndRangeDependencies: true,
    exactAndRangePeers: true,
    optionalDependenciesConverged: false,
    incompatiblePeerRejected: true,
    unapprovedExoticRejected: true,
    frozenLockfileUnchanged: true,
    productionArtifactQualification: false,
  });
});

test.each([true, false])(
  'actual source generation and validation retain descriptor=%s policy',
  async withDescriptor => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'support-installer-generation-'),
    );
    const workspaceRoot = path.join(root, 'workspace');
    if (!withDescriptor)
      rstest.spyOn(packageSource, 'resolvePackageSource').mockReturnValue({
        strategy: 'workspace',
        modernPackageVersion: 'workspace:*',
      });
    try {
      await generateUltramodernWorkspace({
        targetDir: workspaceRoot,
        packageName: 'support-installer',
        modernVersion: 'workspace:*',
        packageSource: { strategy: 'workspace' },
        generateAgentFiles: false,
      });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'),
      );
      const workspace = yaml.load(
        fs.readFileSync(
          path.join(workspaceRoot, 'pnpm-workspace.yaml'),
          'utf8',
        ),
      );
      assert.deepEqual(workspace.overrides, security);
      for (const key of [
        'blockExoticSubdeps',
        'trustPolicy',
        'minimumReleaseAge',
        'peerDependencyRules',
      ] as const)
        assert.deepEqual(
          workspace[key],
          ULTRAMODERN_WORKSPACE_POLICY.pnpm[key],
        );
      assert.deepEqual(
        workspace.packageExtensions,
        withDescriptor ? packageExtensions : undefined,
      );
      assert.deepEqual(
        packageSource.readSupportArtifacts(manifest),
        withDescriptor ? support : undefined,
      );
      const { config, raw, verticals, additionalShells, primaryShell } =
        readUltramodernWorkspaceInputs(workspaceRoot);
      const expected = createWorkspaceValidationContract(
        config.workspace.packageScope,
        config.features.tailwind,
        raw.topology.sharedPackages,
        verticals,
        additionalShells,
        primaryShell,
      );
      validateWorkspace(workspaceRoot, expected);
      const snapshot = captureOverlayBaselineSnapshot(workspaceRoot, [
        'apps/shell',
      ]);
      const check = () =>
        assertOverlayPreservedBaseline({
          workspaceRoot,
          snapshot,
          generator: 'support-policy-test',
        });
      assert.doesNotThrow(check);
      if (withDescriptor) {
        const writeWorkspace = value =>
          fs.writeFileSync(
            path.join(workspaceRoot, 'pnpm-workspace.yaml'),
            yaml.dump(value),
          );
        for (const mutation of [
          value => delete value.packageExtensions['@rslib/core@1.0.7'],
          value => {
            value.overrides['@tanstack/react-router'] =
              support.packages['@tanstack/react-router'].request;
          },
          value => {
            value.catalog = { '@tanstack/react-router': '1.170.46' };
          },
        ]) {
          const changed = structuredClone(workspace);
          mutation(changed);
          writeWorkspace(changed);
          assert.throws(check, /support|override/u);
          assert.throws(
            () => validateWorkspace(workspaceRoot, expected),
            /support|override/u,
          );
        }
        writeWorkspace(workspace);
        const compilerRequest = manifest.devDependencies['rsbuild-plugin-dts'];
        manifest.devDependencies['rsbuild-plugin-dts'] = '1.0.7';
        fs.writeFileSync(
          path.join(workspaceRoot, 'package.json'),
          JSON.stringify(manifest),
        );
        assert.throws(check, /support|compiler/u);
        assert.throws(
          () => validateWorkspace(workspaceRoot, expected),
          /support|compiler/u,
        );
        manifest.devDependencies['rsbuild-plugin-dts'] = compilerRequest;
        manifest.ultramodern.supportArtifacts.producer.runId++;
        fs.writeFileSync(
          path.join(workspaceRoot, 'package.json'),
          JSON.stringify(manifest),
        );
        assert.throws(check, /support|Support|descriptor/u);
      } else {
        assert.equal(manifest.devDependencies['rsbuild-plugin-dts'], '1.0.7');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
