import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { assertAcceptanceReceipt } from '../ultramodern-production-readiness/published-create-proof/acceptance-receipt.mjs';
import { readReleaseManifest } from '../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import { verifyRendererFeatureReceipt } from './feature-gates.mjs';

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    receipt: { type: 'string' },
    'acceptance-receipt': { type: 'string' },
    'run-identity': { type: 'string' },
  },
});
for (const option of [
  'manifest',
  'receipt',
  'acceptance-receipt',
  'run-identity',
])
  if (!values[option]) throw new Error(`--${option} is required`);
const release = readReleaseManifest({ manifestPath: values.manifest });
assertAcceptanceReceipt(
  JSON.parse(fs.readFileSync(values['acceptance-receipt'], 'utf8')),
  { release, expectedMode: 'source', runIdentity: values['run-identity'] },
);
verifyRendererFeatureReceipt({
  receiptPath: values.receipt,
  acceptanceReceiptPath: values['acceptance-receipt'],
  runIdentity: values['run-identity'],
  mode: 'source',
  binding: {
    sourceRevision: release.source.commit,
    releaseVersion: release.release.version,
    manifestSha256: release.manifestSha256,
    frameworkCohortDigest: release.cohortDigest,
  },
});
