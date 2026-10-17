import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const requiredRendererFeatureRows = Object.freeze({
  'dev-refresh': [
    'noDocumentReload',
    'retainedHostState',
    'currentSameHostSsr',
  ],
  'prebuilt-worker': [
    'requestIsolation',
    'ssrBeforeHydration',
    'cancellation',
    'boundedRecovery',
  ],
  'generated-worker': [
    'generatedPublicWorkspace',
    'requestIsolation',
    'ssrBeforeHydration',
    'cancellation',
    'boundedRecovery',
  ],
});
export const digestFile = file =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const rendererFeatureBinding = cohort => ({
  sourceRevision: cohort.sourceRevision,
  releaseVersion: cohort.release.version,
  manifestSha256: cohort.manifestSha256,
  frameworkCohortDigest: cohort.cohortDigest,
});
export function normalizeRegistryUrl(value) {
  const url = new URL(value);
  assert(
    ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search,
    'Invalid acceptance registry URL',
  );
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url.href;
}
function assertRow(row, receipt, binding, { evidenceRoot, verifyFiles }) {
  assert(
    Object.hasOwn(requiredRendererFeatureRows, row),
    `Unknown renderer feature row ${row}`,
  );
  assert.equal(receipt?.status, 'passed', `${row} did not pass`);
  assert.deepEqual(
    receipt.binding,
    binding,
    `${row} ran against another cohort`,
  );
  assert(
    receipt.checks &&
      Object.values(receipt.checks).every(value => value === true),
    `${row} contains failed or skipped checks`,
  );
  for (const check of requiredRendererFeatureRows[row])
    assert.equal(
      receipt.checks[check],
      true,
      `${row} did not execute ${check}`,
    );
  assert(
    Array.isArray(receipt.evidence) && receipt.evidence.length > 0,
    `${row} has no runtime evidence`,
  );
  for (const evidence of receipt.evidence) {
    assert.equal(typeof evidence.path, 'string', `${row} has no evidence path`);
    assert.match(
      evidence.sha256,
      /^[a-f0-9]{64}$/u,
      `${row} has invalid evidence digest`,
    );
    assert(path.isAbsolute(evidence.path), `${row} evidence must be absolute`);
    if (evidenceRoot) {
      const relative = path.relative(path.resolve(evidenceRoot), evidence.path);
      assert(
        !path.isAbsolute(relative) &&
          !relative.startsWith('..') &&
          relative.startsWith(`feature-${row}.`),
        `${row} evidence must belong to its distinct feature-row logs`,
      );
    }
    if (verifyFiles) {
      assert.equal(
        fs.realpathSync(evidence.path),
        path.resolve(evidence.path),
        `${row} evidence cannot be a symlink`,
      );
      const stat = fs.statSync(evidence.path);
      assert(
        stat.isFile() && stat.size > 0,
        `${row} evidence must be a nonempty ordinary file`,
      );
      assert.equal(
        digestFile(evidence.path),
        evidence.sha256,
        `${row} evidence changed`,
      );
    }
  }
  return receipt;
}
export function assertRendererFeatureRow(
  row,
  receipt,
  binding,
  { evidenceRoot } = {},
) {
  return assertRow(row, receipt, binding, { evidenceRoot, verifyFiles: true });
}
function assertErpBinding(acceptance, binding, mode, runIdentity) {
  assert.equal(acceptance.passed, true, 'ERP acceptance did not pass');
  assert.equal(acceptance.mode, mode, 'ERP acceptance mode mismatch');
  assert.equal(
    acceptance.binding?.runIdentity,
    runIdentity,
    'ERP producer run mismatch',
  );
  assert.equal(
    acceptance.binding?.source?.commit,
    binding.sourceRevision,
    'ERP source mismatch',
  );
  assert.equal(
    acceptance.binding?.release?.version,
    binding.releaseVersion,
    'ERP version mismatch',
  );
  assert.equal(
    acceptance.binding?.manifest?.sha256,
    binding.manifestSha256,
    'ERP manifest mismatch',
  );
  assert.equal(
    acceptance.binding?.manifest?.cohortDigest,
    binding.frameworkCohortDigest,
    'ERP cohort mismatch',
  );
}
/** Verify downloaded immutable metadata without rerunning or inventing runtime observations. */
export function verifyRendererFeatureReceipt({
  receiptPath,
  acceptanceReceiptPath,
  binding,
  mode = 'source',
  runIdentity,
  registryUrl,
}) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(
    receipt.schema,
    'bleedingdev.ultramodern.renderer-feature-acceptance',
  );
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.mode, mode);
  assert.equal(receipt.runIdentity, runIdentity);
  assert.deepEqual(
    receipt.binding,
    binding,
    'Renderer features used another cohort',
  );
  assert.equal(
    receipt.acceptanceReceiptSha256,
    digestFile(acceptanceReceiptPath),
    'Renderer features must bind the actual ERP receipt bytes',
  );
  const acceptance = JSON.parse(fs.readFileSync(acceptanceReceiptPath, 'utf8'));
  assertErpBinding(acceptance, binding, mode, runIdentity);
  assert.equal(typeof receipt.evidenceRoot, 'string');
  assert(path.isAbsolute(receipt.evidenceRoot));
  assert.deepEqual(
    Object.keys(receipt.rows).sort(),
    Object.keys(requiredRendererFeatureRows).sort(),
    'Every renderer feature row must execute exactly once',
  );
  const paths = new Set();
  for (const [row, result] of Object.entries(receipt.rows)) {
    assertRow(row, result, binding, {
      evidenceRoot: receipt.evidenceRoot,
      verifyFiles: false,
    });
    for (const evidence of result.evidence) {
      assert(
        !paths.has(evidence.path),
        'Renderer feature rows cannot share evidence files',
      );
      paths.add(evidence.path);
    }
  }
  assert.equal(receipt.registryUrl, normalizeRegistryUrl(receipt.registryUrl));
  if (mode === 'published') {
    assert.equal(
      receipt.registryUrl,
      normalizeRegistryUrl(acceptance.registry?.url),
      'Renderer registry must equal the accepted ERP registry',
    );
    assert.equal(
      receipt.registryUrl,
      normalizeRegistryUrl(registryUrl),
      'Renderer registry must equal the actual install registry',
    );
  }
  return receipt;
}
export function writeRendererFeatureReceipt({
  receiptPath,
  rows,
  binding,
  mode,
  runIdentity,
  acceptanceReceiptPath,
  sourceFeatureReceiptPath,
  sourceAcceptanceReceiptPath,
  registryUrl,
  evidenceRoot,
}) {
  assert(
    ['source', 'published'].includes(mode),
    'Unknown feature acceptance mode',
  );
  assert(
    typeof runIdentity === 'string' && runIdentity.length > 0,
    'Producer run identity is required',
  );
  assert(
    typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot),
    'Feature evidence root must be absolute',
  );
  assert.deepEqual(
    Object.keys(rows).sort(),
    Object.keys(requiredRendererFeatureRows).sort(),
    'Every renderer feature row must execute exactly once',
  );
  const evidencePaths = new Set();
  for (const [row, result] of Object.entries(rows)) {
    assertRendererFeatureRow(row, result, binding, { evidenceRoot });
    for (const evidence of result.evidence) {
      assert(
        !evidencePaths.has(evidence.path),
        'Renderer feature rows cannot share evidence files',
      );
      evidencePaths.add(evidence.path);
    }
  }
  const acceptance = JSON.parse(fs.readFileSync(acceptanceReceiptPath, 'utf8'));
  assertErpBinding(acceptance, binding, mode, runIdentity);
  const actualRegistryUrl = normalizeRegistryUrl(registryUrl);
  if (mode === 'published')
    assert.equal(
      actualRegistryUrl,
      normalizeRegistryUrl(acceptance.registry?.url),
      'Renderer registry must equal the accepted ERP registry',
    );
  let sourceFeatureReceiptSha256 = null;
  if (mode === 'published') {
    assert(
      sourceFeatureReceiptPath && sourceAcceptanceReceiptPath,
      'Published features require accepted source features and ERP receipt',
    );
    verifyRendererFeatureReceipt({
      receiptPath: sourceFeatureReceiptPath,
      acceptanceReceiptPath: sourceAcceptanceReceiptPath,
      binding,
      runIdentity,
      mode: 'source',
    });
    sourceFeatureReceiptSha256 = digestFile(sourceFeatureReceiptPath);
  } else
    assert(
      !sourceFeatureReceiptPath && !sourceAcceptanceReceiptPath,
      'Source features cannot consume source receipts',
    );
  const receipt = {
    schema: 'bleedingdev.ultramodern.renderer-feature-acceptance',
    schemaVersion: 1,
    status: 'passed',
    mode,
    runIdentity,
    binding,
    registryUrl: actualRegistryUrl,
    evidenceRoot,
    acceptanceReceiptSha256: digestFile(acceptanceReceiptPath),
    sourceFeatureReceiptSha256,
    rows,
  };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return receipt;
}
