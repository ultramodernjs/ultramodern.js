// Consumer: publish-bleedingdev.yml authenticated outcome handoff.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createOperationalAcceptanceReceiptFixture,
  fixtureClosureSha256,
} = require('../../ultramodern-production-readiness/__tests__/support/operational-acceptance-fixture.js');
const {
  nodeSsrEvidence,
  runTractorAcceptanceFixture,
} = require('../../ultramodern-production-readiness/__tests__/support/tractor-acceptance-run.js');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const repoRoot = path.resolve(__dirname, '../../..');
const source = {
  commit: '1'.repeat(40),
  repository: 'BleedingDev/ultramodern.js',
};
const release = { tag: 'latest', version: '3.4.0-ultramodern.2' };
const runId = '123';
const producerRunAttempt = 1;
const publicationRunAttempt = 2;
const outcomeRunAttempt = 3;
const producerArtifactIdentity = `run-${runId}-attempt-${producerRunAttempt}`;
const producerRunIdentity = `github:${source.repository}:run:${runId}:attempt:${producerRunAttempt}`;
const createSourceName = '@modern-js/ultramodern-create';
const createTargetName = '@bleedingdev/modern-js-ultramodern-create';
const i18nTarget = '@bleedingdev/modern-js-i18n-utils';

async function outcomeApi() {
  return import('../publish-outcome.mjs');
}

// Builds the exact on-disk evidence set the publish workflow hands to
// createPublishOutcome: release artifacts, a source-mode and a published-mode
// acceptance receipt, and the report a passing Tractor downstream acceptance
// run produces for that exact release.
async function createEvidenceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-outcome-'));
  const at = (...parts) => path.join(root, ...parts);
  const releaseDir = at('release');
  const manifestPath = path.join(releaseDir, 'manifest.json');
  const receiptPath = path.join(releaseDir, 'acceptance-receipt.json');
  const operationalEvidencePath = at(
    'acceptance-receipt.operational-independence.json',
  );
  const publishedReceiptPath = at('published-acceptance-receipt.json');
  const tractorReportPath = at('tractor-downstream-acceptance.json');
  const [releaseArtifactsApi, releaseManifestApi, receiptApi, constants] =
    await Promise.all([
      import('../prepare-bleedingdev-packages.mjs'),
      import('../lib/source-create-proof/release-manifest.mjs'),
      import(
        '../../ultramodern-production-readiness/published-create-proof/acceptance-receipt.mjs'
      ),
      import('../lib/prepare-bleedingdev-packages/constants.mjs'),
    ]);
  const aliases = {
    [createSourceName]: createTargetName,
    '@modern-js/i18n-utils': i18nTarget,
  };
  const exportsMap = {
    '.': './index.js',
    './ultramodern-workspace': './index.js',
    './ultramodern-workspace/codesmith': './index.js',
  };
  const definitions = [
    {
      dependencies: {
        '@modern-js/i18n-utils': `npm:${i18nTarget}@${release.version}`,
        '@module-federation/runtime': '2.8.0',
      },
      exports: exportsMap,
      sourceName: createSourceName,
      targetName: createTargetName,
      ultramodern: { frameworkVersion: release.version },
    },
    {
      dependencies: {},
      sourceName: '@modern-js/i18n-utils',
      targetName: i18nTarget,
    },
  ];
  const packages = definitions.map(definition => {
    const packageDir = at(
      'staged',
      definition.targetName.replaceAll('/', '__'),
    );
    fs.mkdirSync(packageDir, { recursive: true });
    const write = (relativePath, contents) => {
      const filePath = path.join(packageDir, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
    };
    write(
      'package.json',
      `${JSON.stringify({
        dependencies: definition.dependencies,
        exports: definition.exports,
        name: definition.targetName,
        publishConfig: { access: 'public', exports: definition.exports },
        ultramodern: definition.ultramodern,
        version: release.version,
      })}\n`,
    );
    write('index.js', 'module.exports = {};\n');
    if (definition.sourceName === createSourceName) {
      for (const relativePath of constants.createTemplateRequiredFiles) {
        write(relativePath, 'fixture\n');
      }
    }
    return {
      packageDir: path.relative(repoRoot, packageDir),
      sourceName: definition.sourceName,
      targetName: definition.targetName,
      version: release.version,
    };
  });
  releaseArtifactsApi.createReleaseArtifacts({
    aliases,
    command: execFileSync,
    outDir: releaseDir,
    packages,
    source,
    tag: release.tag,
    tools: { node: process.version, npm: 'fixture-npm', pnpm: '11.17.0' },
    version: release.version,
  });
  const acceptanceRelease = releaseManifestApi.readReleaseManifest({
    manifestPath,
  });
  const manifestSha256 = acceptanceRelease.manifestSha256;
  const createReceipt = async (mode, targetPath, evidencePath) => {
    const receipt = receiptApi.createAcceptanceReceipt({
      createPackage: {
        exactSpecifier: `${createTargetName}@${release.version}`,
        packageName: createTargetName,
        version: release.version,
      },
      mode,
      profile: { id: 'erp-10', verticalCount: 10 },
      registry: {
        cohortPackages: 'verified',
        sourceCandidateTrustPolicyExclude:
          mode === 'source'
            ? acceptanceRelease.packages
                .map(item => `${item.targetName}@${item.version}`)
                .sort()
            : [],
        externalDependencies: 'verified',
        resolution: 'verified',
        url: 'https://registry.npmjs.org/',
      },
      release: acceptanceRelease,
      runIdentity: producerRunIdentity,
      runtime: {
        arch: 'x64',
        node: '24.0.0',
        npm: '11.0.0',
        platform: 'linux',
        playwright: '1.60.0',
        pnpm: '11.17.0',
        registry: { integrity: 'sha512-bnBt', name: 'npm', version: '11.0.0' },
        yaml: { integrity: 'sha512-eWFtbA==', name: 'yaml', version: '2.0.0' },
      },
    });
    receiptApi.bindSupplyChainEvidence(receipt, {
      closureSha256: fixtureClosureSha256,
      exceptionPolicySha256: digest('exceptions'),
      lockSha256: digest('lock'),
      registryMetadataSha256: digest('registry'),
      releaseManifestSha256: manifestSha256,
    });
    await createOperationalAcceptanceReceiptFixture({
      evidencePath,
      legacyOperationalSummary: false,
      receipt,
      receiptApi,
    });
    fs.writeFileSync(targetPath, `${JSON.stringify(receipt)}\n`);
  };
  await createReceipt('source', receiptPath, operationalEvidencePath);
  await createReceipt('published', publishedReceiptPath, undefined);

  const { baselineRevision: tractorBaselineRevision } =
    await runTractorAcceptanceFixture({ manifestPath, root: at('published') });
  fs.renameSync(
    at('published', 'tractor-downstream-acceptance.json'),
    tractorReportPath,
  );
  return {
    cohortDigestPath: path.join(releaseDir, 'cohort.sha256'),
    manifestDigestPath: path.join(releaseDir, 'manifest.json.sha256'),
    manifestPath,
    operationalEvidencePath,
    outPath: at('publish-outcome.json'),
    publishedReceiptPath,
    receiptPath,
    root,
    tractorBaselineRevision,
    tractorReportPath,
    tractorReportSha256: digest(fs.readFileSync(tractorReportPath)),
  };
}

function createOptions(fixture, artifactName, dryRun) {
  const options = {
    ...fixture,
    artifactName,
    dryRun,
    producerArtifactIdentity,
    producerRunAttempt,
    producerRunIdentity,
    publicationRunAttempt,
    repository: source.repository,
    runAttempt: outcomeRunAttempt,
    runId,
    sourceCommit: source.commit,
    tag: release.tag,
    version: release.version,
  };
  if (dryRun) {
    delete options.publishedReceiptPath;
    delete options.tractorBaselineRevision;
    delete options.tractorReportPath;
    delete options.tractorReportSha256;
  }
  return options;
}

const outcomeArtifactName = api =>
  api.publishOutcomeArtifactName({ runAttempt: outcomeRunAttempt, runId });

test('acceptance recovery preserves publication identity and binds only the new Tractor executor', async t => {
  const api = await outcomeApi();
  const fixture = await createEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const options = createOptions(fixture, outcomeArtifactName(api), false);
  const recovery = {
    runId: '456',
    runAttempt: 2,
    tractorRunAttempt: 1,
    sourceCommit: '2'.repeat(40),
  };
  const original = api.createPublishOutcome(options);
  const recovered = api.createPublishOutcome({
    ...options,
    acceptanceRecovery: recovery,
  });
  assert.equal(recovered.schemaVersion, 7);
  assert.equal(
    recovered.artifactName,
    'bleedingdev-recovered-publish-outcome-run-456-attempt-2',
  );
  for (const key of [
    'source',
    'release',
    'workflowRun',
    'publication',
    'producer',
    'evidence',
  ]) {
    assert.deepEqual(
      recovered[key],
      original[key],
      `Recovery cannot relabel ${key}`,
    );
  }
  assert.deepEqual(recovered.acceptanceRecovery, {
    result: 'tractor-downstream',
    sourceCommit: recovery.sourceCommit,
    tractorRunAttempt: 1,
    workflowRun: { id: '456', attempt: 2 },
  });
  for (const patch of [
    { runId },
    { runAttempt: 0 },
    { tractorRunAttempt: 3 },
    { sourceCommit: 'unqualified' },
  ]) {
    assert.throws(() =>
      api.createPublishOutcome({
        ...options,
        acceptanceRecovery: { ...recovery, ...patch },
      }),
    );
  }
  assert.throws(
    () =>
      api.createPublishOutcome({
        ...createOptions(fixture, outcomeArtifactName(api), true),
        acceptanceRecovery: recovery,
      }),
    /separate live acceptance run/,
  );
  // A recovery still needs a real passing Tractor report bound to these bytes.
  const report = JSON.parse(fs.readFileSync(fixture.tractorReportPath, 'utf8'));
  report.mode = 'source';
  fs.writeFileSync(fixture.tractorReportPath, JSON.stringify(report));
  assert.throws(() =>
    api.createPublishOutcome({
      ...options,
      tractorReportSha256: digest(fs.readFileSync(fixture.tractorReportPath)),
      acceptanceRecovery: recovery,
    }),
  );
});

test('a dry run never claims published acceptance evidence', async t => {
  const api = await outcomeApi();
  const name = outcomeArtifactName(api);
  const fixture = await createEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const dry = api.createPublishOutcome(createOptions(fixture, name, true));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.publication, null);
  assert.equal(dry.evidence.publishedAcceptance, null);

  const real = api.createPublishOutcome(createOptions(fixture, name, false));
  assert.equal(real.dryRun, false);
  assert.deepEqual(real.publication, { runAttempt: publicationRunAttempt });
  assert.equal(
    real.evidence.publishedAcceptance.receiptPath,
    'published-acceptance-receipt.json',
  );
  const { runWorkflowCommand } = await import('../workflow.mjs');
  const summaryPath = path.join(fixture.root, 'summary.md');
  fs.writeFileSync(fixture.outPath, JSON.stringify(real));
  await runWorkflowCommand(['summarize-delivery'], {
    BLEEDINGDEV_PUBLISH_OUTCOME: fixture.outPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: source.repository,
    GITHUB_RUN_ID: runId,
    TRACTOR_STORE_REPOSITORY: 'BleedingDev/tractor-store-vertical-demo',
  });
  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.ok(
    summary.includes(
      `Tractor baseline used for published acceptance: \`${fixture.tractorBaselineRevision}\``,
    ),
  );
  assert.match(summary, /published-mode acceptance.*exact bundle/u);
  assert.match(
    summary,
    /push the passing report's `applicationSourceRevision` to main/u,
  );
  assert.match(
    summary,
    /advance `scripts\/ultramodern-publish\/tractor-baseline-revision` to it/u,
  );
  assert.doesNotMatch(summary, /promotable Tractor revision|merge `/u);
});

test('non-dry outcome fails closed without passing published acceptance evidence', async t => {
  const api = await outcomeApi();
  const name = outcomeArtifactName(api);
  const fixture = await createEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const missing = createOptions(fixture, name, false);
  delete missing.publishedReceiptPath;
  assert.throws(
    () => api.createPublishOutcome(missing),
    /requires published and Tractor acceptance evidence/u,
  );

  const missingTractor = createOptions(fixture, name, false);
  delete missingTractor.tractorBaselineRevision;
  delete missingTractor.tractorReportPath;
  delete missingTractor.tractorReportSha256;
  assert.throws(
    () => api.createPublishOutcome(missingTractor),
    /requires published and Tractor acceptance evidence/u,
  );

  const publishedSource = fs.readFileSync(fixture.publishedReceiptPath, 'utf8');
  const rehearsal = JSON.parse(publishedSource);
  rehearsal.mode = 'source';
  fs.writeFileSync(
    fixture.publishedReceiptPath,
    `${JSON.stringify(rehearsal)}\n`,
  );
  assert.throws(
    () => api.createPublishOutcome(createOptions(fixture, name, false)),
    /Acceptance receipt mode must be published/u,
  );

  // ACC-1: a published receipt cannot smuggle the source-only
  // operational-independence result back into the contract.
  const smuggled = JSON.parse(publishedSource);
  const sourceReceipt = JSON.parse(
    fs.readFileSync(fixture.receiptPath, 'utf8'),
  );
  smuggled.results.push(
    sourceReceipt.results.find(
      result => result.id === 'operational-independence',
    ),
  );
  fs.writeFileSync(
    fixture.publishedReceiptPath,
    `${JSON.stringify(smuggled)}\n`,
  );
  assert.throws(
    () => api.createPublishOutcome(createOptions(fixture, name, false)),
    /every required result exactly once/u,
  );
});

// The published receipt builds nothing; it only proves npm resolves the
// closure the source receipt built and ran. A published receipt that is
// internally consistent but names another closure must not be promoted.
test('publish outcome refuses a published closure the source lane never accepted', async t => {
  const api = await outcomeApi();
  const fixture = await createEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const published = JSON.parse(
    fs.readFileSync(fixture.publishedReceiptPath, 'utf8'),
  );
  const closureIdentities = [
    { integrity: 'sha512-bWF0dXJlZA==', name: 'effect', version: '3.19.1' },
  ];
  const closureSha256 = digest(JSON.stringify(closureIdentities));
  published.binding.supplyChain.closureSha256 = closureSha256;
  const result = id => published.results.find(item => item.id === id);
  result('dependency-closure-audit').details.closureIdentities =
    closureIdentities;
  result('resolution-parity').details.closureSha256 = closureSha256;
  fs.writeFileSync(
    fixture.publishedReceiptPath,
    `${JSON.stringify(published)}\n`,
  );
  assert.throws(
    () =>
      api.createPublishOutcome(
        createOptions(fixture, outcomeArtifactName(api), false),
      ),
    /resolved a different dependency closure than the source acceptance built and ran/u,
  );
});

test('publish outcome rejects tampered receipt, operational evidence, and Tractor proof', async () => {
  const api = await outcomeApi();
  const name = outcomeArtifactName(api);
  const rewrite = (filePath, mutate) => {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    mutate(value);
    fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
  };
  const cases = [
    {
      label: 'forged tarball integrity in the receipt binding',
      mutate: fixture =>
        rewrite(fixture.receiptPath, receipt => {
          const forged = receipt.binding.artifacts.packages.find(
            item => item.targetName !== receipt.binding.create.targetName,
          );
          assert.ok(forged);
          forged.integrity = 'sha512-Zm9yZ2Vk';
        }),
      pattern: /binding does not match the strict release manifest/u,
    },
    {
      label: 'tampered operational evidence',
      mutate: fixture =>
        rewrite(fixture.operationalEvidencePath, evidence => {
          evidence.result = 'fail';
        }),
      pattern: /missing, skipped, or not passing/u,
    },
    {
      label: 'passing source-mode rehearsal report',
      mutate: async fixture => {
        const { reportPath } = await runTractorAcceptanceFixture({
          manifestPath: fixture.manifestPath,
          mode: 'source',
          root: path.join(fixture.root, 'rehearsal'),
        });
        fixture.tractorReportPath = reportPath;
        fixture.tractorReportSha256 = digest(fs.readFileSync(reportPath));
      },
      pattern: /not a passing report for the exact release and baseline/u,
    },
  ];
  for (const { label, mutate, pattern } of cases) {
    const fixture = await createEvidenceFixture();
    try {
      await mutate(fixture);
      assert.throws(
        () => api.createPublishOutcome(createOptions(fixture, name, false)),
        pattern,
        label,
      );
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  }
});

test('Tractor producer refuses to pass a report the recorder would reject', async t => {
  const fixture = await createEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const root = path.join(fixture.root, 'drifted');
  const nodeSsr = nodeSsrEvidence();
  for (const result of nodeSsr.results) {
    result.httpAssertions = result.httpAssertions.filter(
      assertion => assertion.type !== 'mf-manifest',
    );
    result.httpAssertionTypes = result.httpAssertionTypes.filter(
      type => type !== 'mf-manifest',
    );
  }
  await assert.rejects(
    runTractorAcceptanceFixture({
      manifestPath: fixture.manifestPath,
      nodeSsr,
      root,
    }),
    /missing executed Node server-rendered SSR evidence/u,
  );
  const report = JSON.parse(
    fs.readFileSync(path.join(root, 'tractor-downstream-acceptance.json')),
  );
  assert.equal(report.status, 'failed');
});

test('publish outcome refuses evidence bound to another release or digest', async t => {
  const api = await outcomeApi();
  const fixture = await createEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const options = createOptions(fixture, outcomeArtifactName(api), true);
  assert.throws(
    () =>
      api.createPublishOutcome({
        ...options,
        version: '3.8.2-ultramodern.999',
      }),
    /Release manifest does not match the expected source and version/u,
  );
  const foreignDigest = path.join(fixture.root, 'foreign-digest');
  fs.writeFileSync(foreignDigest, `${'0'.repeat(64)}\n`);
  assert.throws(
    () =>
      api.createPublishOutcome({
        ...options,
        manifestDigestPath: foreignDigest,
      }),
    /Detached release manifest digest is invalid/u,
  );
});

test('Tractor evidence binder refuses a rehearsal report and binds the published one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-evidence-'));
  try {
    const tractorRef = `${'0'.repeat(39)}1`;
    const reportPath = path.join(
      root,
      '.modern/production-readiness/tractor-downstream-acceptance.json',
    );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const write = mode =>
      fs.writeFileSync(
        reportPath,
        `${JSON.stringify({ mode, tractor: { baselineRevision: tractorRef } })}\n`,
      );
    const bind = outputPath =>
      spawnSync(
        process.execPath,
        [
          path.join(
            repoRoot,
            'scripts/ultramodern-publish/bind-tractor-acceptance-evidence.mjs',
          ),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            GITHUB_RUN_ATTEMPT: '3',
            TRACTOR_REF: tractorRef,
          },
        },
      );

    write('published');
    const publishedOutput = path.join(root, 'published-output');
    const published = bind(publishedOutput);
    assert.equal(published.status, 0, published.stderr || published.stdout);
    assert.equal(
      fs.readFileSync(publishedOutput, 'utf8'),
      [
        `artifact_name=ultramodern-tractor-downstream-acceptance-${tractorRef}-attempt-3`,
        `baseline_revision=${tractorRef}`,
        `report_sha256=${digest(fs.readFileSync(reportPath))}`,
        '',
      ].join('\n'),
    );

    write('source');
    const rehearsalOutput = path.join(root, 'rehearsal-output');
    const rehearsal = bind(rehearsalOutput);
    assert.notEqual(rehearsal.status, 0);
    assert.match(rehearsal.stderr, /found source/u);
    assert.equal(fs.existsSync(rehearsalOutput), false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('workflow identity commands bind immutable bytes and distinct producer/publication attempts', async () => {
  const { runWorkflowCommand } = await import('../workflow.mjs');
  const fixture = await createEvidenceFixture();
  const env = {
    BLEEDINGDEV_RELEASE_DIR: path.dirname(fixture.manifestPath),
    BLEEDINGDEV_RELEASE_MANIFEST: fixture.manifestPath,
    BLEEDINGDEV_RELEASE_ACCEPTANCE_RECEIPT: fixture.receiptPath,
    BLEEDINGDEV_RELEASE_IDENTITY: path.join(fixture.root, 'identity.json'),
    BLEEDINGDEV_PUBLISH_TAG: release.tag,
    PUBLISH_VERSION: release.version,
    SOURCE_COMMIT: source.commit,
    GITHUB_REPOSITORY: source.repository,
    GITHUB_RUN_ID: runId,
    GITHUB_OUTPUT: path.join(fixture.root, 'output'),
    PRODUCER_ARTIFACT_IDENTITY: producerArtifactIdentity,
    PRODUCER_RUN_ATTEMPT: String(producerRunAttempt),
    PRODUCER_RUN_IDENTITY: producerRunIdentity,
    PUBLICATION_RUN_ATTEMPT: String(publicationRunAttempt),
  };
  try {
    await runWorkflowCommand(['create-published-identity'], env);
    await runWorkflowCommand(['verify-published-identity'], env);
    const identity = JSON.parse(
      fs.readFileSync(env.BLEEDINGDEV_RELEASE_IDENTITY),
    );
    assert.equal(identity.producerRunAttempt, '1');
    assert.equal(identity.publicationRunAttempt, '2');
    for (const [key, value] of Object.entries({
      GITHUB_RUN_ID: 'foreign',
      PUBLICATION_RUN_ATTEMPT: '3',
      PRODUCER_RUN_IDENTITY: 'foreign',
    })) {
      await assert.rejects(
        runWorkflowCommand(['verify-published-identity'], {
          ...env,
          [key]: value,
        }),
        /does not bind/,
      );
    }
    fs.appendFileSync(fixture.receiptPath, ' ');
    await assert.rejects(
      runWorkflowCommand(['verify-published-identity'], env),
      /does not bind/,
    );
    fs.appendFileSync(fixture.manifestPath, ' ');
    await assert.rejects(
      runWorkflowCommand(['create-published-identity'], env),
      /SHA-256 mismatch|canonical JSON/,
    );
    await assert.rejects(
      runWorkflowCommand(['create-published-identity', 'extra'], env),
      /Expected one workflow command/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
