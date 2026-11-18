const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  createOperationalAcceptanceReceiptFixture,
  fixtureClosureSha256,
} = require('./support/operational-acceptance-fixture');

const repoRoot = path.resolve(__dirname, '../../..');
const receiptCliPath = path.resolve(
  __dirname,
  '../published-create-proof/acceptance-receipt.mjs',
);

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function createReceiptFixture(root, mode = 'source') {
  const receiptApi = await import(pathToFileURL(receiptCliPath));
  const { bindSupplyChainEvidence, createAcceptanceReceipt } = receiptApi;
  const { createReleaseArtifacts } = await import(
    '../../ultramodern-publish/prepare-bleedingdev-packages.mjs'
  );
  const { readReleaseManifest } = await import(
    '../../ultramodern-publish/lib/source-create-proof/release-manifest.mjs'
  );
  const { createTemplateRequiredFiles } = await import(
    '../../ultramodern-publish/lib/prepare-bleedingdev-packages/constants.mjs'
  );
  const version = '3.4.0-ultramodern.2';
  const aliases = {
    '@modern-js/ultramodern-create':
      '@bleedingdev/modern-js-ultramodern-create',
    '@modern-js/i18n-utils': '@bleedingdev/modern-js-i18n-utils',
  };
  const packages = Object.entries(aliases).map(([sourceName, targetName]) => {
    const packageDir = path.join(root, 'staged', sourceName.split('/')[1]);
    const isCreate = sourceName === '@modern-js/ultramodern-create';
    const exports = {
      '.': './index.js',
      './ultramodern-workspace': './index.js',
      './ultramodern-workspace/codesmith': './index.js',
    };
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: targetName,
        version,
        exports,
        publishConfig: { access: 'public', exports },
        dependencies: isCreate
          ? {
              '@modern-js/i18n-utils': `npm:${aliases['@modern-js/i18n-utils']}@${version}`,
              '@module-federation/dts-plugin': '2.8.0',
              '@module-federation/modern-js-v3': '2.8.0',
              '@module-federation/runtime': '2.8.0',
            }
          : {},
        ...(isCreate ? { ultramodern: { frameworkVersion: version } } : {}),
      }),
    );
    for (const file of [
      'index.js',
      ...(isCreate ? createTemplateRequiredFiles : []),
    ]) {
      const target = path.join(packageDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'fixture\n');
    }
    return {
      sourceName,
      targetName,
      version,
      packageDir: path.relative(repoRoot, packageDir),
    };
  });
  const releaseDir = path.join(root, 'release');
  createReleaseArtifacts({
    aliases,
    outDir: releaseDir,
    packages,
    source: {
      commit: '1'.repeat(40),
      repository: 'BleedingDev/ultramodern.js',
    },
    tag: 'latest',
    tools: { node: process.version, npm: '11.0.0', pnpm: '11.17.0' },
    version,
  });
  const manifestPath = path.join(releaseDir, 'manifest.json');
  const release = readReleaseManifest({ manifestPath });
  const runIdentity = 'github:BleedingDev/ultramodern.js:run:123:attempt:1';
  const receipt = createAcceptanceReceipt({
    release,
    mode,
    profile: { id: 'erp-10', verticalCount: 10 },
    createPackage: {
      packageName: release.createPackage.targetName,
      version: release.createPackage.version,
      exactSpecifier: `${release.createPackage.targetName}@${release.createPackage.version}`,
    },
    runtime: {
      arch: 'x64',
      node: '24.0.0',
      npm: '11.0.0',
      platform: 'linux',
      playwright: '1.60.0',
      pnpm: '10.0.0',
      registry: { name: 'npm', version: '11.0.0', integrity: 'sha512-npm' },
      yaml: { name: 'yaml', version: '2.0.0', integrity: 'sha512-yaml' },
    },
    registry: {
      cohortPackages: 'verified',
      sourceCandidateTrustPolicyExclude:
        mode === 'source'
          ? release.packages
              .map(item => `${item.targetName}@${item.version}`)
              .sort()
          : [],
      externalDependencies: 'verified',
      resolution: 'verified',
      url: 'https://registry.npmjs.org/',
    },
    runIdentity,
  });
  bindSupplyChainEvidence(receipt, {
    closureSha256: fixtureClosureSha256,
    exceptionPolicySha256: digest('exceptions'),
    lockSha256: digest('lock'),
    registryMetadataSha256: digest('registry'),
    releaseManifestSha256: release.manifestSha256,
  });
  const receiptPath = path.join(root, 'acceptance-receipt.json');
  const operationalEvidence = await createOperationalAcceptanceReceiptFixture({
    evidencePath: path.join(
      root,
      'acceptance-receipt.operational-independence.json',
    ),
    overrides: {
      identity: {
        baselineRevision: '2'.repeat(40),
        changedRevision: '3'.repeat(40),
        releaseVersion: '0.1.0',
        runtimeReleaseVersion: '0.1.0',
        runtimeSourceRevision: '2'.repeat(40),
      },
    },
    receipt,
    receiptApi,
  });
  if (mode === 'source') {
    const runtimeModuleFederation =
      receipt.binding.artifacts.moduleFederation.filter(
        item => item.packageName === '@module-federation/runtime',
      );
    for (const platform of ['node', 'workerd']) {
      for (const app of receipt.binding.runtimeIdentity[platform]) {
        app.moduleFederation = structuredClone(runtimeModuleFederation);
        app.buildMarker = digest(`${platform}:${app.appId}`);
      }
      receipt.results.find(
        result => result.id === `${platform}-release-identity`,
      ).details.apps = structuredClone(
        receipt.binding.runtimeIdentity[platform],
      );
    }
  }
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    manifestPath,
    operationalEvidencePath: operationalEvidence.evidencePath,
    operationalEvidenceSource: operationalEvidence.evidenceSource,
    receiptPath,
    receiptSource: fs.readFileSync(receiptPath, 'utf8'),
    receiptApi,
    release,
    runIdentity,
  };
}

function verifyReceipt({ manifestPath, receiptPath, runIdentity }) {
  return spawnSync(
    process.execPath,
    [
      receiptCliPath,
      '--verify',
      '--manifest',
      manifestPath,
      '--receipt',
      receiptPath,
      '--run-identity',
      runIdentity,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

function replaceOperationalEvidence(fixture, evidence) {
  const evidenceSource = `${JSON.stringify(evidence, null, 2)}\n`;
  fs.writeFileSync(fixture.operationalEvidencePath, evidenceSource);
}

for (const mode of ['source', 'published']) {
  test(`${mode} ERP acceptance requires a high-severity audit without acknowledged advisories`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
    try {
      const fixture = await createReceiptFixture(root, mode);
      const { assertAcceptanceReceipt } = fixture.receiptApi;
      const valid = JSON.parse(fixture.receiptSource);
      assertAcceptanceReceipt(valid, { expectedMode: mode });

      for (const [name, advisories, message] of [
        ['missing audit', undefined, /advisories must be a JSON object/u],
        ['null audit', null, /advisories must be a JSON object/u],
        ['array audit', [], /advisories must be a JSON object/u],
        ['empty audit', {}, /advisories has unknown or missing fields/u],
        [
          'missing acknowledgements',
          { auditLevel: 'high' },
          /advisories has unknown or missing fields/u,
        ],
        [
          'malformed acknowledgements',
          { auditLevel: 'high', acknowledged: {} },
          /empty acknowledged advisory list/u,
        ],
        [
          'critical-only audit',
          { auditLevel: 'critical', acknowledged: [] },
          /must audit high and critical/u,
        ],
        [
          'acknowledged braces advisory',
          { auditLevel: 'high', acknowledged: ['GHSA-grv7-fg5c-xmjg'] },
          /empty acknowledged advisory list/u,
        ],
        [
          'unreviewed repository correction field',
          { auditLevel: 'high', acknowledged: [], repositoryCorrection: true },
          /advisories has unknown or missing fields/u,
        ],
      ]) {
        const receipt = JSON.parse(fixture.receiptSource);
        const details = receipt.results.find(
          result => result.id === 'dependency-closure-audit',
        ).details;
        if (advisories === undefined) delete details.advisories;
        else details.advisories = advisories;
        assert.throws(
          () => assertAcceptanceReceipt(receipt, { expectedMode: mode }),
          message,
          name,
        );
        if (mode === 'source') {
          fs.writeFileSync(fixture.receiptPath, `${JSON.stringify(receipt)}\n`);
          const result = verifyReceipt(fixture);
          assert.notEqual(result.status, 0, name);
          assert.match(result.stderr, message, name);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('producer receipt preserves runtime-only MF identity and distinct native target markers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
  try {
    const fixture = await createReceiptFixture(root);
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8'));
    assert.equal(receipt.binding.artifacts.moduleFederation.length, 3);
    for (let index = 0; index < receipt.profile.verticalCount; index++) {
      const node = receipt.binding.runtimeIdentity.node[index];
      const workerd = receipt.binding.runtimeIdentity.workerd[index];
      assert.notEqual(node.buildMarker, workerd.buildMarker);
      assert.deepEqual(node.moduleFederation, [
        { packageName: '@module-federation/runtime', version: '2.8.0' },
      ]);
      assert.deepEqual(node.moduleFederation, workerd.moduleFederation);
    }
    const valid = verifyReceipt(fixture);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Verified ERP-10 acceptance receipt/);

    for (const [name, mutate, message] of [
      [
        'stale schema version',
        receipt => {
          receipt.schemaVersion = 1;
        },
        /Unknown acceptance receipt schema/,
      ],
      [
        'unknown profile version',
        receipt => {
          receipt.profile.version = 999;
          receipt.binding.profile.version = 999;
        },
        /ERP-10 profile identity is invalid/,
      ],
      [
        'manifest identity drift',
        receipt => {
          receipt.binding.manifest.cohortDigest = 'f'.repeat(64);
        },
        /binding does not match the strict release manifest/,
      ],
      [
        'cross-platform MicroVertical delivery drift',
        receipt => {
          receipt.binding.runtimeIdentity.workerd[0].releaseVersion = '0.2.0';
        },
        /Node and workerd release identities differ/,
      ],
      [
        'cross-platform application source drift',
        receipt => {
          receipt.binding.runtimeIdentity.workerd[0].sourceRevision =
            '9'.repeat(40);
        },
        /Node and workerd release identities differ/,
      ],
      [
        'missing cross-platform application',
        receipt => {
          receipt.binding.runtimeIdentity.workerd[0].appId = 'foreign-app';
        },
        /same unique MicroVerticals/,
      ],
      [
        'wrong served runtime version',
        receipt => {
          receipt.binding.runtimeIdentity.workerd[0].moduleFederation[0].version =
            '2.9.0';
        },
        /MicroVertical identity is stale or mixed/,
      ],
      [
        'build tools claimed as served runtime',
        receipt => {
          receipt.binding.runtimeIdentity.node[0].moduleFederation =
            structuredClone(receipt.binding.artifacts.moduleFederation);
        },
        /MicroVertical identity is stale or mixed/,
      ],
      [
        'missing selected runtime',
        receipt => {
          receipt.binding.artifacts.runtimeModuleFederation = [];
        },
        /requires one exact Module Federation runtime/,
      ],
      [
        'duplicate selected runtime',
        receipt => {
          receipt.binding.artifacts.runtimeModuleFederation.push(
            receipt.binding.artifacts.runtimeModuleFederation[0],
          );
        },
        /requires one exact Module Federation runtime/,
      ],
      [
        'invalid selected runtime version',
        receipt => {
          receipt.binding.artifacts.runtimeModuleFederation[0].version =
            '^2.9.3';
        },
        /requires one exact Module Federation runtime/,
      ],
      [
        'missing authenticated runtime',
        receipt => {
          receipt.binding.artifacts.moduleFederation =
            receipt.binding.artifacts.moduleFederation.filter(
              item => item.packageName !== '@module-federation/runtime',
            );
        },
        /requires one exact Module Federation runtime/,
      ],
      [
        'duplicate authenticated runtime',
        receipt => {
          receipt.binding.artifacts.moduleFederation.push(
            structuredClone(
              receipt.binding.artifacts.moduleFederation.find(
                item => item.packageName === '@module-federation/runtime',
              ),
            ),
          );
        },
        /requires one exact Module Federation runtime/,
      ],
      [
        'blank target marker',
        receipt => {
          receipt.binding.runtimeIdentity.workerd[0].buildMarker = ' ';
        },
        /build markers must each be present/,
      ],
      [
        'other target marker substituted for its own result',
        receipt => {
          receipt.binding.runtimeIdentity.workerd[0].buildMarker =
            receipt.binding.runtimeIdentity.node[0].buildMarker;
        },
        /does not match independently recorded Node\/workerd results/,
      ],
      [
        'closure identities that do not hash to the bound closure',
        receipt => {
          receipt.results.find(
            result => result.id === 'dependency-closure-audit',
          ).details.closureIdentities[0].version = '9.9.9';
        },
        /closure identities do not match the bound closureSha256/,
      ],
      [
        'missing operational-independence result',
        receipt => {
          receipt.results = receipt.results.filter(
            result => result.id !== 'operational-independence',
          );
        },
        /every required result exactly once/,
      ],
      [
        'operational-independence artifact mode drift',
        receipt => {
          receipt.results.find(
            result => result.id === 'operational-independence',
          ).details.artifactMode = 'published';
        },
        /artifactMode must be source/,
      ],
      [
        'operational-independence mutation expectation drift',
        receipt => {
          const details = receipt.results.find(
            result => result.id === 'operational-independence',
          ).details;
          details.mutations.apiResponse.value = 'forged expected value';
        },
        /did not observe the exact C1 API and UI mutations/,
      ],
      [
        'operational-independence evidence path drift',
        receipt => {
          receipt.results.find(
            result => result.id === 'operational-independence',
          ).details.evidencePath = 'relative/evidence.json';
        },
        /evidence path is invalid/,
      ],
    ]) {
      const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8'));
      mutate(receipt);
      fs.writeFileSync(fixture.receiptPath, `${JSON.stringify(receipt)}\n`);
      const result = verifyReceipt(fixture);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, message, name);
      fs.writeFileSync(fixture.receiptPath, fixture.receiptSource);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt validates the recorded source trust exemptions and keeps published trust intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
  try {
    for (const mode of ['source', 'published']) {
      const fixture = await createReceiptFixture(root, mode);
      const receipt = JSON.parse(fixture.receiptSource);
      const { assertAcceptanceReceipt } = fixture.receiptApi;
      assertAcceptanceReceipt(receipt, { expectedMode: mode });
      const expected = receipt.registry.sourceCandidateTrustPolicyExclude;
      const invalid = [undefined, '*', ['*'], ['@bleedingdev/foreign@1.0.0']];
      if (mode === 'source')
        invalid.push(
          [],
          [...expected, ...expected],
          [expected[0].replace('@3.4.0-ultramodern.2', '@3.4.0-ultramodern.1')],
        );
      else
        invalid.push(
          receipt.binding.artifacts.packages.map(
            item => `${item.targetName}@${item.version}`,
          ),
        );
      for (const value of invalid) {
        const altered = structuredClone(receipt);
        altered.registry.sourceCandidateTrustPolicyExclude = value;
        assert.throws(
          () => assertAcceptanceReceipt(altered, { expectedMode: mode }),
          /registry|trust exclusions/u,
          `${mode}: ${JSON.stringify(value)}`,
        );
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime projection retains the complete authenticated artifact cohort', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
  try {
    const fixture = await createReceiptFixture(root);
    const { assertAcceptanceReceipt } = await import(
      pathToFileURL(receiptCliPath)
    );
    const receipt = JSON.parse(fixture.receiptSource);
    assert.equal(
      assertAcceptanceReceipt(receipt, {
        release: fixture.release,
        runIdentity: fixture.runIdentity,
      }),
      receipt,
    );
    for (const mutate of [
      receipt => {
        receipt.binding.artifacts.moduleFederation =
          receipt.binding.artifacts.moduleFederation.filter(
            item => item.packageName !== '@module-federation/dts-plugin',
          );
      },
      receipt => {
        receipt.binding.artifacts.moduleFederation.find(
          item => item.packageName === '@module-federation/modern-js-v3',
        ).version = '2.9.0';
      },
      receipt => {
        receipt.binding.artifacts.packages.find(
          item => item.targetName === receipt.binding.create.targetName,
        ).integrity = 'sha512-foreign';
        receipt.binding.create.integrity = 'sha512-foreign';
      },
    ]) {
      const forged = structuredClone(receipt);
      mutate(forged);
      assert.throws(
        () =>
          assertAcceptanceReceipt(forged, {
            release: fixture.release,
            runIdentity: fixture.runIdentity,
          }),
        /binding does not match the strict release manifest/u,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('producer receipt verification fails closed when operational evidence is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
  try {
    const fixture = await createReceiptFixture(root);

    fs.rmSync(fixture.operationalEvidencePath);
    const missing = verifyReceipt(fixture);
    assert.notEqual(missing.status, 0);
    assert.match(
      missing.stderr,
      /Operational-independence evidence is missing or is not a regular file/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('producer receipt verification fails closed when operational evidence is tampered', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
  try {
    const fixture = await createReceiptFixture(root);
    fs.writeFileSync(
      fixture.operationalEvidencePath,
      fixture.operationalEvidenceSource.replace(
        '"result": "pass"',
        '"result": "fail"',
      ),
    );
    const tampered = verifyReceipt(fixture);
    assert.notEqual(tampered.status, 0);
    assert.match(
      tampered.stderr,
      /Operational-independence node served behavior is missing, degraded, skipped, or non-passing/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('producer receipt verification does not treat the evidence digest as correctness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
  try {
    const fixture = await createReceiptFixture(root);
    const evidence = JSON.parse(fixture.operationalEvidenceSource);
    evidence.evidenceDigest = 'administrative-digest-is-not-proof';
    replaceOperationalEvidence(fixture, evidence);

    const result = verifyReceipt(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('producer receipt verification binds operational evidence to the receipt C0 and C1 revisions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
  try {
    const fixture = await createReceiptFixture(root);
    const evidence = JSON.parse(fixture.operationalEvidenceSource);
    evidence.commits.changed = '4'.repeat(40);
    replaceOperationalEvidence(fixture, evidence);

    const result = verifyReceipt(fixture);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Operational-independence commits are stale, mixed, or outside inventory ownership/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('producer receipt is bound to its accepted run and cannot be reused by a retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-receipt-'));
  try {
    const fixture = await createReceiptFixture(root);
    const retry = verifyReceipt({
      ...fixture,
      runIdentity: fixture.runIdentity.replace(/attempt:1$/u, 'attempt:2'),
    });
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /run identity/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
